"""Unit tests for the FAA NAS status parser (offline, fixture-driven)."""
from conftest import fixture

from fetch_and_score import parse_faa_status


def test_ground_stop_is_detected():
    faa = parse_faa_status(fixture("faa_ground_stop.xml"), "ATL")
    assert faa["ground_stop"] is True
    assert faa["reason"] and "thunderstorm" in faa["reason"].lower()
    # The departure-delay section is also parsed alongside the stop.
    assert faa["delay"] == "45-60 min (Increasing)"
    assert any("Ground stop" in e for e in faa["events"])


def test_delay_only_is_not_a_ground_stop():
    faa = parse_faa_status(fixture("faa_delay_only.xml"), "ATL")
    assert faa["ground_stop"] is False
    assert faa["gdp"] is False
    assert faa["closure"] is False
    assert faa["delay"] == "15-30 min (Steady)"


def test_other_airports_are_ignored():
    # Fixture has events for SFO and EWR but nothing for ATL.
    faa = parse_faa_status(fixture("faa_no_events.xml"), "ATL")
    assert faa["ground_stop"] is False
    assert faa["gdp"] is False
    assert faa["closure"] is False
    assert faa["delay"] is None
    assert faa["events"] == []


def test_match_is_case_insensitive():
    faa = parse_faa_status(fixture("faa_ground_stop.xml"), "atl")
    assert faa["ground_stop"] is True
