# -*- coding: utf-8 -*-
"""Snapshot store + auto-sync scheduling tests."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

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
# Flex fetch budgets. The 2026-08-28/29 outage was the cooldown being measured
# from the attempt's START while set to exactly the poll budget: a fetch that
# used its whole budget was re-runnable the instant it gave up, so the next
# request reached IBKR while it was still generating the one we had just
# abandoned, and was answered 1001. Gating on the END is the fix, and that is
# what gets pinned — a constant picked to outlast the budget would also work,
# but only until someone moved the budget.
# ---------------------------------------------------------------------------

def test_cooldown_is_measured_from_attempt_end(tmp_path, monkeypatch):
    # However long a fetch runs, the gap owed afterwards is the same.
    import app as app_mod

    spec = SimpleNamespace(tag="test", token="tok", query_id="123")
    monkeypatch.setattr(app_mod, "parse_accounts_env", lambda _: [spec])
    monkeypatch.setenv("ACCOUNTS", "tok:123")
    # A completed pass now records its outcome; keep that off the real
    # uploads/ so the suite stays side-effect free.
    monkeypatch.setattr(app_mod, "SYNC_STATE_FILE", tmp_path / ".auto_sync_state.json")
    clock = {"t": 10_000.0}
    monkeypatch.setattr(app_mod.time, "time", lambda: clock["t"])

    def slow_failing_fetch(_spec):
        # Burns far more than one cooldown before failing.
        clock["t"] += 10 * app_mod.REFRESH_MIN_INTERVAL_SEC
        raise RuntimeError("boom")

    monkeypatch.setattr(app_mod, "fetch_one", slow_failing_fetch)
    app_mod._refresh_state.update({"last_finished": 0.0, "in_progress": False})

    _, status = app_mod._run_refresh("test")
    assert status == 200          # ran; the per-account failure is inside

    # Start-gating would wave this through: the attempt STARTED many cooldowns
    # ago. Only end-gating still owes the gap.
    _, status = app_mod._run_refresh("test")
    assert status == 429, "a long attempt must still owe the full gap after it ends"

    clock["t"] += app_mod.REFRESH_MIN_INTERVAL_SEC + 1
    _, status = app_mod._run_refresh("test")
    assert status == 200, "once the gap has passed, the next attempt runs"


def test_failed_fetch_still_stamps_the_cooldown():
    # A timeout leaves IBKR generating, so it owes the gap at least as much as
    # a success does — the stamp has to be in finally, not on the happy path.
    import inspect

    import app as app_mod

    finally_block = inspect.getsource(app_mod._run_refresh).split("finally:")[-1]
    assert "_release_refresh()" in finally_block, (
        "the release must live in finally, or a raising fetch skips the cooldown"
    )
    # And the release is what actually moves the clock — asserting on the
    # finally alone would pass for a release that forgot to stamp.
    assert "last_finished" in inspect.getsource(app_mod._release_refresh), (
        "_release_refresh is what the finally relies on to stamp the cooldown"
    )


def test_poll_budget_is_bounded_on_both_sides():
    from parser.flex_fetch import BUDGET_CEILING_SEC, FLEX_BUDGET_SEC

    # Floor: one real generation of this query was measured at 696s on
    # 2026-09-05. (The 2026-09-01..04 attempts were cut off by us at 600s, so
    # how much longer they needed is unknown — the floor rests on the measured
    # run alone.) A budget at or under that watermark is known to be too small
    # for at least one real statement.
    assert FLEX_BUDGET_SEC > 696
    # Ceiling: the old 900s cap existed because the fetch blocked a request
    # thread. /api/refresh hands the pass to a background thread now, so the
    # only reason left to cap is that a mistyped env must not wedge a refresh
    # for hours.
    assert FLEX_BUDGET_SEC <= BUDGET_CEILING_SEC


def test_fetch_one_defaults_track_the_module_constants():
    # The defaults are what app.py actually gets — a literal left behind in the
    # signature would silently keep the old budget while the constants moved.
    import inspect
    from parser import flex_fetch

    defaults = inspect.signature(flex_fetch.fetch_one).parameters
    assert defaults["max_polls"].default == flex_fetch.FLEX_MAX_POLLS
    assert defaults["poll_interval"].default == flex_fetch.FLEX_POLL_INTERVAL


# ---------------------------------------------------------------------------
# Async refresh. The button used to hold the HTTP request open for the whole
# poll budget — 10 minutes of spinner for a response nobody was still waiting
# for. These lock the split: config errors and the throttle stay synchronous,
# the fetch does not.
# ---------------------------------------------------------------------------

def test_refresh_returns_immediately_and_reports_progress(tmp_path, monkeypatch):
    import threading
    import time as time_mod

    import app as app_mod

    spec = SimpleNamespace(tag="test", token="tok", query_id="123")
    monkeypatch.setattr(app_mod, "parse_accounts_env", lambda _: [spec])
    monkeypatch.setenv("ACCOUNTS", "tok:123")
    monkeypatch.setattr(app_mod, "SYNC_STATE_FILE", tmp_path / ".auto_sync_state.json")
    app_mod._refresh_state.update({"last_finished": 0.0, "in_progress": False,
                                   "last_result": None})

    started, release = threading.Event(), threading.Event()

    def blocking_fetch(_spec):
        started.set()
        release.wait(5)
        raise RuntimeError("boom")   # the outcome is not what is under test

    monkeypatch.setattr(app_mod, "fetch_one", blocking_fetch)
    client = app_mod.app.test_client()

    res = client.post("/api/refresh")
    assert res.status_code == 202, "the button must not wait out the poll budget"
    run_id = res.get_json()["run_id"]
    assert started.wait(5), "the pass should be running in the background"

    st = client.get("/api/refresh/status").get_json()
    assert st["in_progress"] is True
    assert st["run_id"] == run_id
    assert st["trigger"] == "button"

    # A second press while one is in flight is refused, never queued — two
    # concurrent passes would defeat the point of the single slot.
    assert client.post("/api/refresh").status_code == 429

    release.set()
    for _ in range(100):
        st = client.get("/api/refresh/status").get_json()
        if not st["in_progress"]:
            break
        time_mod.sleep(0.05)
    assert st["in_progress"] is False
    # The finished result carries the id the button started with, so a reload
    # cannot mistake an older pass's outcome for its own.
    assert st["last"]["run_id"] == run_id
    assert st["last"]["ok"] is False


def test_refresh_config_errors_stay_synchronous(monkeypatch):
    import app as app_mod

    monkeypatch.setenv("ACCOUNTS", "")
    app_mod._refresh_state.update({"last_finished": 0.0, "in_progress": False})
    res = app_mod.app.test_client().post("/api/refresh")
    # Nothing was started, so this must not come back as an accepted 202 the
    # UI would then poll forever.
    assert res.status_code == 500
    assert "ACCOUNTS" in res.get_json()["error"]


def test_failed_thread_start_does_not_strand_the_slot(monkeypatch):
    import app as app_mod

    spec = SimpleNamespace(tag="test", token="tok", query_id="123")
    monkeypatch.setattr(app_mod, "parse_accounts_env", lambda _: [spec])
    monkeypatch.setenv("ACCOUNTS", "tok:123")
    app_mod._refresh_state.update({"last_finished": 0.0, "in_progress": False})

    class DeadThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            raise RuntimeError("can't start new thread")

    monkeypatch.setattr(app_mod.threading, "Thread", DeadThread)
    res = app_mod.app.test_client().post("/api/refresh")
    assert res.status_code == 500
    # The slot must come back: the claim..start gap has no worker finally, so
    # without an explicit release here every later press (and the scheduler)
    # would be told "already in progress" until the container restarts.
    assert app_mod._refresh_state["in_progress"] is False
    # And no cool-down owed — nothing reached IBKR, so the next press must
    # not be made to wait out REFRESH_MIN_INTERVAL_SEC for a pass that never
    # existed.
    assert app_mod._refresh_state["last_finished"] == 0.0


def test_button_outcome_does_not_consume_the_scheduler_slot(tmp_path, monkeypatch):
    import app as app_mod

    path = tmp_path / ".auto_sync_state.json"
    monkeypatch.setattr(app_mod, "SYNC_STATE_FILE", path)
    path.write_text(json.dumps({
        "mode": "daily",
        "last_attempt_date": "2026-09-04",
        "last_attempt": "2026-09-04T06:00:00+00:00",
    }), encoding="utf-8")

    app_mod._record_sync_outcome(
        {"ok": True, "results": [{"tag": "154914", "ok": True}]}, "button")
    state = json.loads(path.read_text(encoding="utf-8"))
    # The day's single automatic attempt is the scheduler's to spend; a button
    # press at 08:57 must not skip a whole daily slot.
    assert state["last_attempt_date"] == "2026-09-04"
    assert state["last_attempt"] == "2026-09-04T06:00:00+00:00"
    # But "when did data last actually arrive" is trigger-agnostic.
    assert state["ok"] is True
    assert state["last_run_trigger"] == "button"
    first_success = state["last_success"]
    assert first_success

    app_mod._record_sync_outcome(
        {"ok": False, "results": [{"tag": "154914", "ok": False, "error": "1019"}]},
        "auto")
    state = json.loads(path.read_text(encoding="utf-8"))
    assert state["ok"] is False
    # A later failure must not erase the last known-good time — it is the only
    # thing the staleness banner can count from.
    assert state["last_success"] == first_success


def test_poll_budget_env_override_is_clamped(monkeypatch):
    import importlib

    from parser import flex_fetch

    monkeypatch.setenv("FLEX_MAX_POLLS", "180")
    monkeypatch.setenv("FLEX_POLL_INTERVAL", "15")
    mod = importlib.reload(flex_fetch)
    assert mod.FLEX_BUDGET_SEC == 2700, "a night of diagnosis needs a movable budget"

    # A mistyped env must degrade to something bounded, not wedge a refresh
    # for hours or crash the import on a droplet nobody is watching.
    monkeypatch.setenv("FLEX_MAX_POLLS", "99999")
    monkeypatch.setenv("FLEX_POLL_INTERVAL", "nonsense")
    mod = importlib.reload(flex_fetch)
    assert mod.FLEX_POLL_INTERVAL == 15.0
    assert mod.FLEX_BUDGET_SEC <= mod.BUDGET_CEILING_SEC
    assert mod.FLEX_CONFIG_NOTES, "a corrected value has to be visible in the log"

    monkeypatch.delenv("FLEX_MAX_POLLS")
    monkeypatch.delenv("FLEX_POLL_INTERVAL")
    mod = importlib.reload(flex_fetch)
    assert mod.FLEX_BUDGET_SEC == 1800, "the shipped default must not move by accident"
    assert mod.FLEX_CONFIG_NOTES == []


def test_poll_budget_env_survives_nan_and_quotes(monkeypatch):
    import importlib

    from parser import flex_fetch

    # float("nan") passes the cast AND slips through a min/max clamp (every
    # comparison against NaN is False), so before the explicit check it
    # reached int(POLLS * nan) and crashed the IMPORT — under
    # restart:unless-stopped, a boot loop with no dashboard at all. The
    # repo's own bar (_parse_sync_hour): a typo'd env degrades, never crashes.
    monkeypatch.setenv("FLEX_POLL_INTERVAL", "nan")
    mod = importlib.reload(flex_fetch)
    assert mod.FLEX_POLL_INTERVAL == 15.0
    assert mod.FLEX_BUDGET_SEC == 1800
    assert mod.FLEX_CONFIG_NOTES, "a corrected value has to be visible in the log"

    # sync.env.example writes every value quoted; if the quotes reach the
    # process, the override must still take rather than silently falling
    # back to the default it was set to replace.
    monkeypatch.setenv("FLEX_MAX_POLLS", '"180"')
    monkeypatch.setenv("FLEX_POLL_INTERVAL", "'15'")
    mod = importlib.reload(flex_fetch)
    assert mod.FLEX_BUDGET_SEC == 2700

    monkeypatch.delenv("FLEX_MAX_POLLS")
    monkeypatch.delenv("FLEX_POLL_INTERVAL")
    mod = importlib.reload(flex_fetch)
    assert mod.FLEX_BUDGET_SEC == 1800
    assert mod.FLEX_CONFIG_NOTES == []


# ---------------------------------------------------------------------------
# Second review round. The sync state file is what the header verdict and the
# staleness banner both read, so every one of these is a way for a broken pipe
# to keep looking healthy.
# ---------------------------------------------------------------------------

def test_partial_success_is_not_persisted_as_healthy(tmp_path, monkeypatch):
    import app as app_mod

    path = tmp_path / ".auto_sync_state.json"
    monkeypatch.setattr(app_mod, "SYNC_STATE_FILE", path)

    # payload["ok"] is any-success — right for the partial toast, wrong to
    # persist. One account failing forever behind another's success would keep
    # a green ✓ in the header and suppress the banner indefinitely.
    app_mod._record_sync_outcome({"ok": True, "results": [
        {"tag": "aaa", "ok": True},
        {"tag": "bbb", "ok": False, "error": "1019"},
    ]}, "auto")
    state = json.loads(path.read_text(encoding="utf-8"))
    assert state["ok"] is False, "a half-broken pipe is not a healthy one"
    assert "last_success" not in state, "a partial pass must not advance last_success"
    assert "bbb" in state["detail"]

    # All-success still counts.
    app_mod._record_sync_outcome({"ok": True, "results": [
        {"tag": "aaa", "ok": True},
        {"tag": "bbb", "ok": True},
    ]}, "auto")
    state = json.loads(path.read_text(encoding="utf-8"))
    assert state["ok"] is True
    assert state["last_success"]


def test_legacy_state_keeps_its_success_time_across_the_upgrade(tmp_path, monkeypatch):
    import app as app_mod

    path = tmp_path / ".auto_sync_state.json"
    monkeypatch.setattr(app_mod, "SYNC_STATE_FILE", path)
    # What a pre-upgrade droplet actually has on disk: a verdict and an attempt
    # time, no last_success (the field did not exist yet).
    path.write_text(json.dumps({
        "mode": "daily",
        "last_attempt_date": "2026-08-31",
        "last_attempt": "2026-08-31T06:00:24+00:00",
        "ok": True,
        "detail": "154914: ok",
    }), encoding="utf-8")

    app_mod._record_sync_outcome(
        {"ok": False, "results": [{"tag": "154914", "ok": False, "error": "1019"}]},
        "auto")
    state = json.loads(path.read_text(encoding="utf-8"))
    assert state["ok"] is False
    # Without the backfill the banner would announce "尚无成功记录" about a box
    # that synced fine the day before the deploy.
    assert state["last_success"] == "2026-08-31T06:00:24+00:00"


def test_refused_scheduler_attempt_keeps_a_concurrent_outcome(tmp_path, monkeypatch):
    import app as app_mod

    path = tmp_path / ".auto_sync_state.json"
    monkeypatch.setattr(app_mod, "SYNC_STATE_FILE", path)
    path.write_text(json.dumps({
        "mode": "daily",
        "last_attempt_date": "2026-09-03",
        "last_attempt": "2026-09-03T06:00:00+00:00",
    }), encoding="utf-8")

    now = datetime(2026, 9, 4, 6, 0, tzinfo=timezone.utc)
    prev = app_mod._stamp_sync_attempt(now)
    assert json.loads(path.read_text(encoding="utf-8"))["last_attempt_date"] == "2026-09-04"

    # The refusal almost always comes FROM a button pass still in flight, and
    # that pass lands its own outcome while we are being turned away.
    app_mod._record_sync_outcome(
        {"ok": True, "results": [{"tag": "154914", "ok": True}]}, "button")

    app_mod._restore_sync_attempt(prev)
    state = json.loads(path.read_text(encoding="utf-8"))
    # The slot is given back — the day's automatic attempt was never spent.
    assert state["last_attempt_date"] == "2026-09-03"
    assert state["last_attempt"] == "2026-09-03T06:00:00+00:00"
    # ...but a verbatim restore of the pre-stamp snapshot would have erased the
    # button's result, including the only timestamp the banner counts from.
    assert state["ok"] is True
    assert state["last_run_trigger"] == "button"
    assert state["last_success"]


def test_restore_removes_the_marker_when_there_was_none(tmp_path, monkeypatch):
    import app as app_mod

    path = tmp_path / ".auto_sync_state.json"
    monkeypatch.setattr(app_mod, "SYNC_STATE_FILE", path)
    path.write_text(json.dumps({"mode": "daily"}), encoding="utf-8")

    prev = app_mod._stamp_sync_attempt(datetime(2026, 9, 4, 6, 0, tzinfo=timezone.utc))
    app_mod._restore_sync_attempt(prev)
    state = json.loads(path.read_text(encoding="utf-8"))
    # Restoring "" would read as an attempt that happened at the epoch and let
    # _auto_sync_due compare against a date that never existed.
    assert "last_attempt_date" not in state
    assert "last_attempt" not in state


def test_advertised_budget_covers_the_whole_pass(monkeypatch):
    import app as app_mod
    from parser.flex_fetch import FLEX_BUDGET_SEC

    one = SimpleNamespace(tag="a", token="t", query_id="1")
    two = SimpleNamespace(tag="b", token="t", query_id="2")
    # Specs are fetched serially and each gets the FULL per-query budget, so
    # the button's "最长 N" has to multiply — advertising 45 minutes for a pass
    # that can legitimately run 90 is how a healthy sync looks hung.
    assert app_mod._pass_budget_sec([one, two]) == FLEX_BUDGET_SEC * 2
    assert app_mod._pass_budget_sec([one]) == FLEX_BUDGET_SEC
    # No accounts configured: report one budget rather than zero.
    assert app_mod._pass_budget_sec([]) == FLEX_BUDGET_SEC

    monkeypatch.setattr(app_mod, "parse_accounts_env", lambda _: [one, two])
    monkeypatch.setenv("ACCOUNTS", "t:1 t:2")
    app_mod._refresh_state.update({"last_finished": 0.0, "in_progress": False})
    st = app_mod.app.test_client().get("/api/refresh/status").get_json()
    assert st["budget_sec"] == FLEX_BUDGET_SEC * 2
