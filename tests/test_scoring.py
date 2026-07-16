"""Unit tests for the source-combining scorer (offline, pure)."""
from fetch_and_score import score


def test_ground_stop_is_high():
    verdict, reasons = score({"ground_stop": True}, None)
    assert verdict == "HIGH"
    assert any("ground stop" in r.lower() for r in reasons)


def test_gdp_is_high():
    verdict, _ = score({"gdp": True}, None)
    assert verdict == "HIGH"


def test_thunderstorm_weather_is_high():
    verdict, reasons = score(None, {"flight_category": "IFR", "ts": True})
    assert verdict == "HIGH"
    assert any("thunderstorm" in r.lower() for r in reasons)


def test_ifr_without_ts_is_high():
    verdict, _ = score(None, {"flight_category": "IFR", "ts": False})
    assert verdict == "HIGH"


def test_faa_delay_without_stop_is_moderate():
    verdict, reasons = score({"ground_stop": False, "delay": "15-30 min"}, None)
    assert verdict == "MODERATE"
    assert any("15-30" in r for r in reasons)


def test_mvfr_is_moderate():
    verdict, _ = score(None, {"flight_category": "MVFR", "ts": False})
    assert verdict == "MODERATE"


def test_gusty_is_moderate():
    verdict, reasons = score(None, {"flight_category": "VFR", "gusty": True, "gust_kt": 30})
    assert verdict == "MODERATE"
    assert any("gust" in r.lower() for r in reasons)


def test_clear_is_low():
    verdict, reasons = score(
        {"ground_stop": False, "gdp": False, "closure": False, "delay": None},
        {"flight_category": "VFR", "ts": False, "gusty": False},
    )
    assert verdict == "LOW"
    assert reasons  # always at least one explanatory reason


def test_highest_source_wins():
    # FAA moderate + weather high -> HIGH overall.
    verdict, _ = score({"delay": "20 min"}, {"flight_category": "LIFR"})
    assert verdict == "HIGH"
