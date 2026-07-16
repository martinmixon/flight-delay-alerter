"""Unit tests for TAF forecast extraction and risk flags (offline)."""
import json

from conftest import fixture

from fetch_and_score import (
    extract_forecast_values,
    flight_category,
    taf_risk_flags,
    select_forecast_period,
)


def _first_period(fixture_name):
    data = json.loads(fixture(fixture_name))
    return data[0]["fcsts"][0]


def test_thunderstorm_period_flags_high_risk():
    values = extract_forecast_values(_first_period("taf_ts.json"))
    flags = taf_risk_flags(values)
    assert flags["ts"] is True
    assert flags["low_ceiling"] is True          # BKN008 -> 800 ft
    assert flags["ceiling_ft"] == 800
    assert flags["low_vis"] is True              # 2 SM
    assert flags["gusty"] is True                # gust 28 kt
    assert flags["flight_category"] == "IFR"     # 800 ft ceiling


def test_vfr_period_has_no_flags():
    values = extract_forecast_values(_first_period("taf_vfr.json"))
    flags = taf_risk_flags(values)
    assert flags["ts"] is False
    assert flags["low_ceiling"] is False
    assert flags["low_vis"] is False
    assert flags["gusty"] is False
    assert flags["flight_category"] == "VFR"


def test_mvfr_period():
    values = extract_forecast_values(_first_period("taf_mvfr.json"))
    flags = taf_risk_flags(values)
    assert flags["flight_category"] == "MVFR"    # 1500 ft ceiling, 4 SM
    assert flags["ceiling_ft"] == 1500
    assert flags["ts"] is False
    assert flags["gusty"] is False


def test_flight_category_thresholds():
    assert flight_category(400, 10) == "LIFR"
    assert flight_category(800, 10) == "IFR"
    assert flight_category(10, 0.5) == "LIFR"
    assert flight_category(2000, 10) == "MVFR"
    assert flight_category(2000, 4) == "MVFR"
    assert flight_category(5000, 10) == "VFR"


def test_visibility_parsing_handles_plus_and_p6sm():
    # "6+" and missing ceiling should still classify as VFR.
    values = extract_forecast_values({"visib": "6+", "clouds": [{"cover": "FEW", "base": 25000}]})
    assert values["vis_mi"] == 6.0
    assert values["ceiling_ft"] is None
    assert taf_risk_flags(values)["flight_category"] == "VFR"


def test_select_forecast_period_falls_back_to_first():
    from datetime import datetime, timezone
    data = json.loads(fixture("taf_vfr.json"))
    fc = select_forecast_period(data, datetime(1970, 1, 1, tzinfo=timezone.utc))
    assert fc is not None
