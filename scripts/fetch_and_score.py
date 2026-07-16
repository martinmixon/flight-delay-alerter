#!/usr/bin/env python3
"""Flight Delay Risk Alerter — backend job.

Runs inside GitHub Actions (server-side, no CORS). For every trip in
``trips.json`` dated today through ``WINDOW_DAYS`` days out it:

  1. Pulls FAA NAS status (ground stops, GDPs, closures, delays).
  2. Pulls NWS aviation weather (TAF) for the departure airport.

then combines the sources into a per-trip verdict (HIGH / MODERATE / LOW) and
writes everything to ``docs/data.json``.

Sources: FAA NAS status + NWS aviation weather (TAF). Both are public feeds
that block browser CORS, which is why scoring runs here (server-side) rather
than in the PWA.

Design rule: **never crash on a failed source.** Each fetch records
``"ok"`` / ``"error"`` and scoring proceeds on whatever is available. The pure
functions near the top (``parse_faa_status``, ``extract_forecast_values``,
``taf_risk_flags``, ``flight_category``, ``score``) take no network and are
unit-tested against fixtures in ``tests/``.
"""
from __future__ import annotations

import json
import os
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    import requests
except ImportError:  # allow tests (which never hit the network) to import us
    requests = None  # type: ignore

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
WINDOW_DAYS = 2  # score trips dated today through today + WINDOW_DAYS

# Weather risk thresholds
CEILING_LOW_FT = 1000  # ceiling below this is a risk flag (IFR/LIFR territory)
VIS_LOW_MI = 3.0       # visibility below this (statute miles) is a risk flag
GUST_STRONG_KT = 25    # gusts at/above this are a risk flag

# Source endpoints
FAA_URL = "https://nasstatus.faa.gov/api/airport-status-information"
TAF_URL = "https://aviationweather.gov/api/data/taf"
METAR_URL = "https://aviationweather.gov/api/data/metar"

REPO_ROOT = Path(__file__).resolve().parent.parent
TRIPS_PATH = REPO_ROOT / "trips.json"
OUTPUT_PATH = REPO_ROOT / "docs" / "data.json"

HTTP_TIMEOUT = 25
USER_AGENT = "flight-delay-alerter/1.0 (+https://github.com)"


# ===========================================================================
# FAA NAS status parsing (pure)
# ===========================================================================
def parse_faa_status(xml_text: str, iata: str) -> dict:
    """Extract active FAA events for one airport from the NAS status XML.

    The NAS status feed groups events under ``<Delay_type>`` sections, each
    with a ``<Name>`` (e.g. "Ground Stop Programs", "Ground Delay Programs",
    "Airport Closures", "General Arrival/Departure Delay Info") and a list of
    entries that each carry an ``<ARPT>`` airport code. This parser is
    deliberately tolerant: it walks every section, matches entries by airport
    code, and classifies them by section name — so minor schema drift (extra
    wrappers, reordered fields) does not break it.
    """
    result = {
        "ground_stop": False,
        "gdp": False,
        "closure": False,
        "delay": None,
        "reason": None,
        "events": [],
    }
    iata = iata.strip().upper()
    root = ET.fromstring(xml_text)

    for dtype in root.iter("Delay_type"):
        name = (dtype.findtext("Name") or "").strip()
        lname = name.lower()
        # Entry containers are the non-<Name> children of the section.
        for container in list(dtype):
            if container.tag == "Name":
                continue
            for entry in list(container):
                arpt = (entry.findtext("ARPT") or entry.findtext("Arpt") or "").strip().upper()
                if arpt != iata:
                    continue
                reason = (entry.findtext("Reason") or "").strip() or None

                if "ground stop" in lname:
                    result["ground_stop"] = True
                    end = (entry.findtext("End_Time") or entry.findtext("EndTime") or "").strip()
                    detail = f"Ground stop ({reason})" if reason else "Ground stop"
                    if end:
                        detail += f", until {end}"
                    result["events"].append(detail)
                    result["reason"] = result["reason"] or reason

                elif "ground delay" in lname:
                    result["gdp"] = True
                    avg = (entry.findtext("Avg") or "").strip()
                    detail = "Ground delay program"
                    if avg:
                        detail += f" (avg {avg})"
                    if reason:
                        detail += f" — {reason}"
                    result["events"].append(detail)
                    result["reason"] = result["reason"] or reason

                elif "closure" in lname:
                    result["closure"] = True
                    reopen = (entry.findtext("Reopen") or "").strip()
                    detail = "Airport closure"
                    if reason:
                        detail += f" — {reason}"
                    if reopen:
                        detail += f", reopens {reopen}"
                    result["events"].append(detail)
                    result["reason"] = result["reason"] or reason

                else:  # general arrival/departure delay info
                    dep = _find_departure_delay(entry)
                    if dep:
                        result["delay"] = dep
                        detail = f"Departure delay {dep}"
                        if reason:
                            detail += f" — {reason}"
                        result["events"].append(detail)
                        result["reason"] = result["reason"] or reason
    return result


def _find_departure_delay(entry: ET.Element) -> str | None:
    """Pull a human-readable departure-delay range out of a delay entry."""
    # Preferred shape: <Arrival_Departure Type="Departure" Min="15" Max="30"/>
    for ad in entry.iter():
        if ad.tag.lower().startswith("arrival_departure") or ad.tag.lower() == "departure":
            if ad.get("Type", ad.tag).lower().startswith("depart") or ad.tag.lower() == "departure":
                lo, hi = ad.get("Min"), ad.get("Max")
                trend = ad.get("Trend")
                if lo or hi:
                    span = f"{lo or '?'}-{hi or '?'} min"
                    return f"{span} ({trend})" if trend else span
    # Fallback: flat Min/Max/Avg fields on the entry.
    lo = (entry.findtext("Min") or "").strip()
    hi = (entry.findtext("Max") or "").strip()
    avg = (entry.findtext("Avg") or "").strip()
    if lo or hi:
        return f"{lo or '?'}-{hi or '?'} min"
    if avg:
        return f"avg {avg}"
    return None


# ===========================================================================
# Weather / TAF parsing (pure)
# ===========================================================================
def flight_category(ceiling_ft, vis_mi) -> str:
    """Classic VFR/MVFR/IFR/LIFR bucketing from ceiling (ft) and vis (sm)."""
    c = ceiling_ft if ceiling_ft is not None else 99999
    v = vis_mi if vis_mi is not None else 99.0
    if c < 500 or v < 1:
        return "LIFR"
    if c < 1000 or v < 3:
        return "IFR"
    if c <= 3000 or v <= 5:
        return "MVFR"
    return "VFR"


def extract_forecast_values(fcst: dict) -> dict:
    """Normalize one aviationweather TAF forecast period into scalar values.

    Returns ceiling_ft (lowest broken/overcast layer), vis_mi, ts (bool),
    gust_kt, wind_kt. Missing fields degrade to ``None``.
    """
    # Ceiling = base of the lowest BKN/OVC layer, in feet AGL.
    ceiling_ft = None
    for layer in fcst.get("clouds") or []:
        cover = (layer.get("cover") or "").upper()
        base = layer.get("base")
        if cover in ("BKN", "OVC", "OVX") and base is not None:
            base_ft = int(base)
            ceiling_ft = base_ft if ceiling_ft is None else min(ceiling_ft, base_ft)

    # Visibility can arrive as a number or a string like "6+" or "P6SM".
    vis_mi = _parse_visibility(fcst.get("visib"))

    wx = (fcst.get("wxString") or "").upper()
    ts = "TS" in wx

    gust_kt = _to_int(fcst.get("wgst"))
    wind_kt = _to_int(fcst.get("wspd"))

    return {
        "ceiling_ft": ceiling_ft,
        "vis_mi": vis_mi,
        "ts": ts,
        "gust_kt": gust_kt,
        "wind_kt": wind_kt,
    }


def taf_risk_flags(values: dict) -> dict:
    """Turn normalized forecast values into risk flags + a flight category."""
    ceiling_ft = values.get("ceiling_ft")
    vis_mi = values.get("vis_mi")
    gust_kt = values.get("gust_kt")
    cat = flight_category(ceiling_ft, vis_mi)
    return {
        "flight_category": cat,
        "ceiling_ft": ceiling_ft,
        "vis_mi": vis_mi,
        "ts": bool(values.get("ts")),
        "gust_kt": gust_kt,
        "low_ceiling": ceiling_ft is not None and ceiling_ft < CEILING_LOW_FT,
        "low_vis": vis_mi is not None and vis_mi < VIS_LOW_MI,
        "gusty": gust_kt is not None and gust_kt >= GUST_STRONG_KT,
        "ifr": cat in ("IFR", "LIFR"),
    }


def select_forecast_period(taf_json, depart_dt_utc: datetime) -> dict | None:
    """From an aviationweather TAF JSON response, return the fcst period that
    covers ``depart_dt_utc`` (falls back to the first period)."""
    tafs = taf_json if isinstance(taf_json, list) else [taf_json]
    if not tafs:
        return None
    fcsts = tafs[0].get("fcsts") or []
    if not fcsts:
        return None
    target = int(depart_dt_utc.timestamp())
    for fc in fcsts:
        start = fc.get("timeFrom")
        end = fc.get("timeTo")
        if start is not None and end is not None and int(start) <= target < int(end):
            return fc
    return fcsts[0]


def _parse_visibility(raw):
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    s = str(raw).upper().strip().replace("SM", "")
    s = s.lstrip("P").rstrip("+")
    try:
        return float(s)
    except ValueError:
        return None


def _to_int(raw):
    if raw is None:
        return None
    try:
        return int(round(float(raw)))
    except (ValueError, TypeError):
        return None


# ===========================================================================
# Scoring (pure)
# ===========================================================================
_LEVELS = {0: "LOW", 1: "MODERATE", 2: "HIGH"}


def score(faa: dict | None, weather: dict | None) -> tuple[str, list]:
    """Combine the sources into a verdict + list of human reasons.

    HIGH     : FAA ground stop/GDP/closure, OR thunderstorms/IFR at departure.
    MODERATE : FAA delay (no stop), OR MVFR/gusty weather.
    LOW      : nothing notable.
    """
    level = 0
    reasons: list[str] = []

    if faa:
        if faa.get("ground_stop"):
            level = max(level, 2)
            reasons.append("FAA ground stop active at departure airport")
        if faa.get("gdp"):
            level = max(level, 2)
            reasons.append("FAA ground delay program active")
        if faa.get("closure"):
            level = max(level, 2)
            reasons.append("FAA airport closure in effect")
        if faa.get("delay") and not (faa.get("ground_stop") or faa.get("gdp") or faa.get("closure")):
            level = max(level, 1)
            reasons.append(f"FAA departure delay {faa['delay']}")

    if weather:
        cat = weather.get("flight_category")
        if weather.get("ts"):
            level = max(level, 2)
            reasons.append("Thunderstorms forecast near departure time")
        if cat in ("IFR", "LIFR"):
            level = max(level, 2)
            reasons.append(f"{cat} conditions forecast (low ceiling/visibility)")
        elif cat == "MVFR":
            level = max(level, 1)
            reasons.append("MVFR (marginal) conditions forecast")
        if weather.get("gusty"):
            level = max(level, 1)
            reasons.append(f"Gusty winds forecast ({weather.get('gust_kt')} kt)")

    if not reasons:
        reasons.append("No active FAA events and a favorable forecast")
    return _LEVELS[level], reasons


# ===========================================================================
# Network fetchers (side-effecting; wrapped so they never raise)
# ===========================================================================
def fetch_faa(iata: str) -> tuple[str, dict | None]:
    try:
        resp = requests.get(FAA_URL, timeout=HTTP_TIMEOUT, headers={"User-Agent": USER_AGENT})
        resp.raise_for_status()
        return "ok", parse_faa_status(resp.text, iata)
    except Exception as exc:  # noqa: BLE001 — resilience rule
        _warn(f"FAA fetch/parse failed for {iata}: {exc}")
        return "error", None


def fetch_weather(icao: str, depart_dt_utc: datetime) -> tuple[str, dict | None]:
    try:
        resp = requests.get(
            TAF_URL,
            params={"ids": icao, "format": "json"},
            timeout=HTTP_TIMEOUT,
            headers={"User-Agent": USER_AGENT},
        )
        resp.raise_for_status()
        data = resp.json()
        fcst = select_forecast_period(data, depart_dt_utc)
        if not fcst:
            return "error", None
        flags = taf_risk_flags(extract_forecast_values(fcst))
        raw = ""
        tafs = data if isinstance(data, list) else [data]
        if tafs:
            raw = tafs[0].get("rawTAF") or tafs[0].get("raw_text") or ""
        flags["taf_raw"] = raw
        return "ok", flags
    except Exception as exc:  # noqa: BLE001
        _warn(f"Weather fetch/parse failed for {icao}: {exc}")
        return "error", None


# ===========================================================================
# Orchestration
# ===========================================================================
def load_trips(path: Path = TRIPS_PATH) -> list:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def trips_in_window(trips: list, today: datetime, window_days: int = WINDOW_DAYS) -> list:
    """Trips dated today through today + window_days (inclusive)."""
    start = today.date()
    end = (today + timedelta(days=window_days)).date()
    out = []
    for trip in trips:
        try:
            d = datetime.strptime(trip["date"], "%Y-%m-%d").date()
        except (KeyError, ValueError):
            continue
        if start <= d <= end:
            out.append(trip)
    return out


def _depart_utc(trip: dict) -> datetime:
    """Best-effort UTC departure datetime. Local times are interpreted in the
    airport's zone when known; otherwise treated as UTC (only affects which
    TAF period is chosen, which is a coarse selection)."""
    dt_local = datetime.strptime(f"{trip['date']} {trip['depart_local']}", "%Y-%m-%d %H:%M")
    tz = _AIRPORT_TZ.get(trip.get("iata", "").upper())
    if tz:
        return dt_local.replace(tzinfo=ZoneInfo(tz)).astimezone(timezone.utc)
    return dt_local.replace(tzinfo=timezone.utc)


# Minimal airport -> IANA tz map for common US hubs; extend as needed.
_AIRPORT_TZ = {
    "ATL": "America/New_York", "LGA": "America/New_York", "JFK": "America/New_York",
    "EWR": "America/New_York", "BOS": "America/New_York", "DCA": "America/New_York",
    "IAD": "America/New_York", "MIA": "America/New_York", "MCO": "America/New_York",
    "ORD": "America/Chicago", "DFW": "America/Chicago", "IAH": "America/Chicago",
    "MSP": "America/Chicago", "DEN": "America/Denver", "PHX": "America/Phoenix",
    "LAX": "America/Los_Angeles", "SFO": "America/Los_Angeles", "SEA": "America/Los_Angeles",
    "SAN": "America/Los_Angeles", "LAS": "America/Los_Angeles",
}


def build_report(now_utc: datetime | None = None) -> dict:
    now_utc = now_utc or datetime.now(timezone.utc)
    trips = load_trips()
    active = trips_in_window(trips, now_utc)

    report_trips = []
    for trip in active:
        depart_utc = _depart_utc(trip)

        faa_status, faa = fetch_faa(trip["iata"])
        wx_status, weather = fetch_weather(trip["icao"], depart_utc)

        verdict, reasons = score(faa, weather)
        report_trips.append({
            "iata": trip["iata"],
            "icao": trip["icao"],
            "date": trip["date"],
            "depart_local": trip["depart_local"],
            "airline": trip.get("airline"),
            "flight": trip.get("flight"),
            "arrival_iata": trip.get("arrival_iata"),
            "verdict": verdict,
            "reasons": reasons,
            "faa": faa or {},
            "weather": weather or {},
            "sources": {"faa": faa_status, "weather": wx_status},
        })

    local_tz = ZoneInfo(os.environ.get("LOCAL_TZ", "America/New_York"))
    return {
        "generated_utc": now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generated_local": now_utc.astimezone(local_tz).strftime("%Y-%m-%d %H:%M %Z"),
        "window_days": WINDOW_DAYS,
        "trips": report_trips,
    }


def _warn(msg: str) -> None:
    print(f"[warn] {msg}", file=sys.stderr)


def main() -> int:
    if requests is None:
        _warn("the 'requests' package is required to run the job (pip install -r requirements.txt)")
        return 1
    report = build_report()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
        fh.write("\n")
    print(f"Wrote {OUTPUT_PATH} — {len(report['trips'])} trip(s) in window.")
    for t in report["trips"]:
        print(f"  {t['iata']} {t['date']} {t['depart_local']}: {t['verdict']} "
              f"(sources: {t['sources']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
