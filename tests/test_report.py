"""Tests for report helpers that don't hit the network."""
from datetime import timezone

from fetch_and_score import _local_zone


def test_local_zone_valid(monkeypatch):
    monkeypatch.setenv("LOCAL_TZ", "America/Chicago")
    assert str(_local_zone()) == "America/Chicago"


def test_local_zone_empty_falls_back(monkeypatch):
    # GitHub passes an unset repo variable as "" — must not crash.
    monkeypatch.setenv("LOCAL_TZ", "")
    assert str(_local_zone()) == "America/New_York"


def test_local_zone_unset_falls_back(monkeypatch):
    monkeypatch.delenv("LOCAL_TZ", raising=False)
    assert str(_local_zone()) == "America/New_York"


def test_local_zone_invalid_falls_back_to_utc(monkeypatch):
    monkeypatch.setenv("LOCAL_TZ", "Not/AZone")
    assert _local_zone() is timezone.utc
