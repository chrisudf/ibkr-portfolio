# -*- coding: utf-8 -*-
"""Snapshot store + auto-sync scheduling tests."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parser.snapshots import (  # noqa: E402
    MAX_KEEP, build_snapshot, load_snapshots, record_snapshot,
)


def _acct(nav_date="2026-08-19", qty=100.0):
    return {
        "nav": {"total": 50000.0},
        "nav_history": [
            {"date": "2026-08-01", "total": 49000.0},
            {"date": nav_date, "total": 50000.0},
        ],
        "stocks": [{
            "symbol": "MSFT", "quantity": qty, "close_price": 500.0,
            "value": qty * 500.0, "unrealized_pl": 1000.0,
        }],
        "performance": {"by_symbol": {
            "MSFT": {"realized_total": 10.0, "unrealized_total": 1000.0,
                     "asset_category": "Stocks"},
            "MSFT 18SEP26 480 P": {"realized_total": 5.0, "unrealized_total": -50.0,
                                   "asset_category": "Equity and Index Options"},
        }},
    }


def test_snapshot_shape_and_roundtrip(tmp_path):
    record_snapshot(tmp_path, "U1", _acct())
    snaps = load_snapshots(tmp_path, "U1")
    assert len(snaps) == 1
    s = snaps[0]
    assert s["date"] == "2026-08-19"          # statement date, not today
    assert s["nav"] == 50000.0
    assert s["stocks"]["MSFT"] == [100.0, 500.0, 50000.0, 1000.0]
    assert s["perf"]["MSFT"] == [10.0, 1000.0, "S"]
    assert s["perf"]["MSFT 18SEP26 480 P"] == [5.0, -50.0, "O"]


def test_same_date_snapshot_replaces(tmp_path):
    record_snapshot(tmp_path, "U1", _acct(qty=100.0))
    record_snapshot(tmp_path, "U1", _acct(qty=120.0))   # same statement date
    snaps = load_snapshots(tmp_path, "U1")
    assert len(snaps) == 1
    assert snaps[0]["stocks"]["MSFT"][0] == 120.0        # last wins


def test_snapshot_file_pruned_and_garbage_tolerated(tmp_path):
    path = tmp_path / "U1.snapshots.jsonl"
    lines = ["not json at all", '{"no_date": true}']
    for i in range(MAX_KEEP + 20):
        d = f"2025-{(i // 28) + 1:02d}-{(i % 28) + 1:02d}"
        lines.append(json.dumps({"date": d, "nav": i, "stocks": {}, "perf": {}}))
    path.write_text("\n".join(lines), encoding="utf-8")
    record_snapshot(tmp_path, "U1", _acct())             # triggers the rewrite
    raw = path.read_text(encoding="utf-8").strip().splitlines()
    assert len(raw) == MAX_KEEP                          # pruned, garbage gone
    snaps = load_snapshots(tmp_path, "U1", limit=MAX_KEEP)
    assert snaps[-1]["date"] == "2026-08-19"             # newest survived
    assert all(s.get("date") for s in snaps)


def test_load_limit_returns_newest(tmp_path):
    for day in range(1, 11):
        record_snapshot(tmp_path, "U1", _acct(nav_date=f"2026-08-{day:02d}"))
    snaps = load_snapshots(tmp_path, "U1", limit=3)
    assert [s["date"] for s in snaps] == ["2026-08-08", "2026-08-09", "2026-08-10"]


def test_as_of_date_from_activity_statement_period():
    acct = _acct()
    del acct["nav_history"]
    acct["statement"] = {"Period": "January 1, 2026 - June 30, 2026"}
    record_snapshot_dir = None  # noqa: F841
    from parser.snapshots import _as_of_date
    assert _as_of_date(acct) == "2026-06-30"      # statement end, never "today"
    acct["statement"] = {"Period": "截至 2026-08-19"}
    assert _as_of_date(acct) == "2026-08-19"
    acct["statement"] = {"Period": "gibberish"}
    assert _as_of_date(acct) == ""


def test_undateable_payload_not_recorded(tmp_path):
    acct = _acct()
    del acct["nav_history"]
    acct["statement"] = {}
    record_snapshot(tmp_path, "U1", acct)          # must be a silent no-op
    assert load_snapshots(tmp_path, "U1") == []


def test_sync_env_parsing_never_crashes():
    from app import _parse_sync_day, _parse_sync_hour
    assert _parse_sync_hour("9am") == 9            # typo degrades, not crashes
    assert _parse_sync_hour("24") == 9             # out of range
    assert _parse_sync_hour('"14"') == 14          # quoted env survives
    assert _parse_sync_hour("") == 9
    assert _parse_sync_day("monday") == "mon"
    assert _parse_sync_day("noday") == "sat"


def test_auto_sync_due_logic():
    from app import _auto_sync_due
    dt = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc)  # noqa: E731
    sat = dt("2026-08-22T09:01:00")
    assert sat.weekday() == 5                            # fixture sanity: a Saturday

    assert not _auto_sync_due(dt("2026-08-21T08:59:00"), "daily", 9, "sat", "")
    assert _auto_sync_due(dt("2026-08-21T09:00:00"), "daily", 9, "sat", "")
    # At most one attempt per due-day — a failure waits for tomorrow.
    assert not _auto_sync_due(dt("2026-08-21T10:00:00"), "daily", 9, "sat", "2026-08-21")
    assert _auto_sync_due(dt("2026-08-22T09:00:00"), "daily", 9, "sat", "2026-08-21")

    assert _auto_sync_due(sat, "weekly", 9, "sat", "2026-08-21")
    assert not _auto_sync_due(dt("2026-08-21T09:01:00"), "weekly", 9, "sat", "")  # Friday
    assert not _auto_sync_due(sat, "weekly", 9, "sat", "2026-08-22")

    assert not _auto_sync_due(dt("2026-08-21T12:00:00"), "off", 9, "sat", "")


# --- Position settings: core holdings + per-symbol caps --------------------


def test_position_settings_normalization():
    from app import _normalize_position_settings as norm

    got = norm({"symbols": {
        "nvda": {"core": True, "min": 0.05, "max": 0.2},   # lowercased input
        "BRK.B": {"core": False, "max": 0.075},            # dotted, upper only
        "AAPL": {"core": False, "min": 0.03},              # lower only
        "GOOG": {"core": True},                            # core, band open
        "TSLA": {"core": False, "min": None, "max": None},  # says nothing
        "MSFT": {},                                        # says nothing
    }})
    assert got == {
        "NVDA": {"core": True, "min": 0.05, "max": 0.2},
        "BRK.B": {"core": False, "min": None, "max": 0.075},
        "AAPL": {"core": False, "min": 0.03, "max": None},
        "GOOG": {"core": True, "min": None, "max": None},
    }
    # A blank box arrives as "" from the form, not as null.
    assert norm({"symbols": {"NVDA": {"core": True, "min": "", "max": ""}}}) == {
        "NVDA": {"core": True, "min": None, "max": None}}


def test_position_settings_rejects_bad_input():
    import pytest

    from app import _normalize_position_settings as norm

    with pytest.raises(ValueError):
        norm({})                                          # no symbols map
    with pytest.raises(ValueError):
        norm({"symbols": {"../etc": {"core": True}}})     # not a ticker
    with pytest.raises(ValueError):
        norm({"symbols": {"NVDA": {"core": "yes"}}})      # core not a bool
    with pytest.raises(ValueError):
        norm({"symbols": {"NVDA": {"min": "abc"}}})       # not a number
    with pytest.raises(ValueError):
        norm({"symbols": {"NVDA": {"max": -0.1}}})        # out of range
    # The mistake worth catching: percent where a fraction is expected. 10
    # would otherwise mean "1000% of NAV" and silently never fire.
    with pytest.raises(ValueError):
        norm({"symbols": {"NVDA": {"max": 10}}})
    # An inverted band would make every position both over and under.
    with pytest.raises(ValueError):
        norm({"symbols": {"NVDA": {"min": 0.2, "max": 0.1}}})
    # Touching ends are fine — a band of exactly one point is a real choice.
    assert norm({"symbols": {"NVDA": {"min": 0.1, "max": 0.1}}})["NVDA"]["min"] == 0.1


def test_position_settings_roundtrip(tmp_path, monkeypatch):
    import app as app_mod

    monkeypatch.setattr(app_mod, "POSITION_SETTINGS_FILE",
                        tmp_path / ".position_settings.json")
    client = app_mod.app.test_client()

    assert client.get("/api/settings/positions").get_json()["symbols"] == {}

    res = client.put("/api/settings/positions", json={"symbols": {
        "NVDA": {"core": True, "min": 0.05, "max": 0.10},
        "SOFI": {"core": False, "min": None, "max": None},   # dropped on write
    }})
    assert res.status_code == 200
    assert res.get_json()["symbols"] == {
        "NVDA": {"core": True, "min": 0.05, "max": 0.10}}

    stored = client.get("/api/settings/positions").get_json()
    assert stored["symbols"] == {"NVDA": {"core": True, "min": 0.05, "max": 0.10}}
    assert stored["updated_at"]

    assert client.put("/api/settings/positions",
                      json={"symbols": {"NVDA": {"max": 33}}}).status_code == 400
    # A rejected write must leave the previous config intact.
    assert client.get("/api/settings/positions").get_json()["symbols"] == {
        "NVDA": {"core": True, "min": 0.05, "max": 0.10}}


def test_corrupt_position_settings_degrade_to_empty(tmp_path, monkeypatch):
    import app as app_mod

    path = tmp_path / ".position_settings.json"
    monkeypatch.setattr(app_mod, "POSITION_SETTINGS_FILE", path)
    path.write_text('{"symbols": {"NVDA": {"max": 999}}}', encoding="utf-8")
    # A hand-edited file that no longer validates must not 500 the dashboard.
    res = app_mod.app.test_client().get("/api/settings/positions")
    assert res.status_code == 200
    assert res.get_json()["symbols"] == {}


def test_settings_file_is_not_mistaken_for_an_account(tmp_path, monkeypatch):
    """The leading dot is load-bearing: uploads/*.json is the account sweep."""
    import app as app_mod

    monkeypatch.setattr(app_mod, "UPLOAD_DIR", tmp_path)
    (tmp_path / ".position_settings.json").write_text(
        '{"version": 1, "symbols": {}}', encoding="utf-8")
    (tmp_path / "U17456181.json").write_text('{"nav": {"total": 1}}', encoding="utf-8")
    assert list(app_mod._load_all_accounts()) == ["U17456181"]


def test_position_settings_response_shape_is_stable(tmp_path, monkeypatch):
    """Empty, corrupt and populated all answer with the same keys."""
    import app as app_mod

    path = tmp_path / ".position_settings.json"
    monkeypatch.setattr(app_mod, "POSITION_SETTINGS_FILE", path)
    client = app_mod.app.test_client()
    keys = {"version", "symbols", "updated_at"}

    assert set(client.get("/api/settings/positions").get_json()) == keys   # missing
    path.write_text("not json", encoding="utf-8")
    assert set(client.get("/api/settings/positions").get_json()) == keys   # corrupt
    path.write_text('{"symbols": {"NVDA": {"max": 999}}}', encoding="utf-8")
    assert set(client.get("/api/settings/positions").get_json()) == keys   # invalid

    client.put("/api/settings/positions",
               json={"symbols": {"NVDA": {"core": True, "max": 0.1}}})
    body = client.get("/api/settings/positions").get_json()
    assert set(body) == keys and body["updated_at"]


# ---------------------------------------------------------------------------
# Flex fetch budgets. The 2026-08-28/29 outage was these two constants being
# EQUAL: a fetch that used its whole poll budget was immediately re-runnable,
# so the next request reached IBKR while it was still generating the one we
# had just abandoned, and got 1001 for it. The relationship is the fix, so
# the relationship is what gets pinned — not the literals.
# ---------------------------------------------------------------------------

def test_cooldown_outlasts_a_full_length_fetch():
    import app as app_mod
    from parser.flex_fetch import FLEX_MAX_POLLS, FLEX_POLL_INTERVAL

    budget = FLEX_MAX_POLLS * FLEX_POLL_INTERVAL
    assert app_mod.REFRESH_MIN_INTERVAL_SEC > budget, (
        "cooldown is measured from attempt START: if it does not outlast the "
        "poll budget, a timed-out fetch can be retried while IBKR is still "
        "generating the abandoned one"
    )


def test_poll_budget_covers_observed_generation_time():
    from parser.flex_fetch import FLEX_MAX_POLLS, FLEX_POLL_INTERVAL

    # Real statements came back 1019 ("still generating") at 300s twice.
    # Whatever else changes, the budget must stay clear of that watermark.
    assert FLEX_MAX_POLLS * FLEX_POLL_INTERVAL > 300


def test_fetch_one_defaults_track_the_module_constants():
    # The defaults are what app.py actually gets — a literal left behind in the
    # signature would silently keep the old budget while the constants moved.
    import inspect
    from parser import flex_fetch

    defaults = inspect.signature(flex_fetch.fetch_one).parameters
    assert defaults["max_polls"].default == flex_fetch.FLEX_MAX_POLLS
    assert defaults["poll_interval"].default == flex_fetch.FLEX_POLL_INTERVAL
