# -*- coding: utf-8 -*-
"""Snapshot store + auto-sync scheduling tests."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parser.snapshots import (  # noqa: E402
    MAX_KEEP, build_snapshot, load_snapshots, record_snapshot,
)


@pytest.fixture(autouse=True)
def _scratch_pending_file(tmp_path, monkeypatch):
    """Every test gets its own kept-reference-code file. Every refresh pass and
    /api/refresh/status read it, and an expired entry is pruned by REWRITING
    it — the suite must never touch the real uploads/."""
    import app as app_mod

    monkeypatch.setattr(app_mod, "PENDING_FILE", tmp_path / ".flex_pending.json")


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


def test_position_settings_flag_a_broken_file_but_not_a_missing_one(tmp_path, monkeypatch):
    # The risk gate's non-core line treats read_error as "core list unknown".
    # Without it a broken file would read as "nothing is core" and turn every
    # name red; a fresh install with no file is a real, empty configuration.
    import app as app_mod

    path = tmp_path / ".position_settings.json"
    monkeypatch.setattr(app_mod, "POSITION_SETTINGS_FILE", path)
    client = app_mod.app.test_client()
    read_error = lambda: client.get("/api/settings/positions").get_json()["read_error"]

    assert read_error() is False                                     # missing
    for broken in ("not json", "[]", '{"symbols": {"NVDA": {"max": 999}}}'):
        path.write_text(broken, encoding="utf-8")
        assert read_error() is True, broken
    res = client.put("/api/settings/positions", json={"symbols": {"NVDA": {"core": True}}})
    assert res.get_json()["read_error"] is False
    assert "read_error" not in json.loads(path.read_text(encoding="utf-8"))
    assert read_error() is False                                     # repaired by the save


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
    keys = {"version", "symbols", "updated_at", "read_error"}

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

    def slow_failing_fetch(_spec, **_kw):
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

    # poll_statement too: app.py calls it directly for a kept reference code.
    for fn in (flex_fetch.fetch_one, flex_fetch.poll_statement):
        defaults = inspect.signature(fn).parameters
        assert defaults["max_polls"].default == flex_fetch.FLEX_MAX_POLLS, fn.__name__
        assert defaults["poll_interval"].default == flex_fetch.FLEX_POLL_INTERVAL, fn.__name__
        assert defaults["max_poll_retries"].default == flex_fetch.FLEX_MAX_POLL_RETRIES, fn.__name__


# ---------------------------------------------------------------------------
# Transport errors on the GetStatement poll. 2026-09-22 06:12:09 UTC: one
# "[Errno 104] Connection reset by peer" on poll ~45 of 240 ended a run that
# was holding a live reference code with 2900s of budget left — and because
# IBKR's ~24h allowance is anchored on the SendRequest that had already
# succeeded, there was no second attempt that day. The reset said nothing
# about the statement; the code treated it as a verdict on it.


def _flex_stub(monkeypatch, get_responses):
    """Drive fetch_one through a scripted GetStatement sequence.

    Each entry is either a string body or an exception instance to raise.
    Returns the list of URLs actually requested, so a test can prove that a
    retry re-polled rather than re-requested.
    """
    from parser import flex_fetch

    calls = []
    pending = list(get_responses)

    def fake_get(url, timeout=30.0):
        calls.append(url)
        if "SendRequest" in url:
            return "<Status>Success</Status><ReferenceCode>987654</ReferenceCode>"
        nxt = pending.pop(0)
        if isinstance(nxt, BaseException):
            raise nxt
        return nxt

    monkeypatch.setattr(flex_fetch, "_http_get", fake_get)
    monkeypatch.setattr(flex_fetch.time, "sleep", lambda *_: None)
    return calls


IN_PROGRESS = "<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress</ErrorMessage></FlexStatementResponse>"
CSV_BODY = ("Statement,Header,Field Name,Field Value" + chr(10)
            + "Statement,Data,Period,2026-09-21")


def test_transient_reset_mid_poll_does_not_kill_the_run(monkeypatch):
    from parser import flex_fetch

    spec = flex_fetch.AccountSpec(token="SECRET123", query_id="154914")
    calls = _flex_stub(monkeypatch, [
        IN_PROGRESS,
        OSError("[Errno 104] Connection reset by peer"),
        IN_PROGRESS,
        CSV_BODY,
    ])
    seen = []

    body = flex_fetch.fetch_one(spec, max_polls=10, poll_interval=0,
                                max_poll_retries=5, on_retry=seen.append)

    assert body == CSV_BODY, "a reset is not a verdict on the statement"
    # The quota is spent on SendRequest, so the one thing a retry must never
    # do is issue a second one. Exactly one, no matter how many resets.
    assert sum("SendRequest" in u for u in calls) == 1
    assert seen, "a ridden-out reset must still reach the log"
    assert "SECRET123" not in " ".join(seen), "the token rides in every URL"


def test_sustained_network_failure_still_gives_up_and_is_labelled(monkeypatch):
    import pytest

    from parser import flex_fetch

    spec = flex_fetch.AccountSpec(token="SECRET123", query_id="154914")
    _flex_stub(monkeypatch, [OSError("connection reset by peer")] * 20)

    with pytest.raises(flex_fetch.FlexFetchError) as excinfo:
        flex_fetch.fetch_one(spec, max_polls=10, poll_interval=0, max_poll_retries=3)

    # code="" is what made this failure mode unreadable in the logs the first
    # time: it printed as `code=-`, identical to a parse bug. A transport
    # failure is now its own named category, distinct from 1019 and 1001.
    assert excinfo.value.code == "network"
    assert not excinfo.value.permanent
    assert "SECRET123" not in str(excinfo.value)


def test_retry_budget_is_consecutive_not_cumulative(monkeypatch):
    import pytest

    from parser import flex_fetch

    spec = flex_fetch.AccountSpec(token="SECRET123", query_id="154914")
    # Nine blips scattered across the run, never two in a row, with only 2
    # retries allowed. Cumulative counting would call this dead on the third
    # one; the network was fine all along, just lossy — which is the expected
    # weather across 240 independent HTTPS polls.
    scattered = []
    for _ in range(9):
        scattered += [OSError("reset"), IN_PROGRESS]
    _flex_stub(monkeypatch, scattered + [CSV_BODY])

    body = flex_fetch.fetch_one(spec, max_polls=40, poll_interval=0, max_poll_retries=2)
    assert body == CSV_BODY


def test_send_request_is_never_retried(monkeypatch):
    import pytest

    from parser import flex_fetch

    spec = flex_fetch.AccountSpec(token="SECRET123", query_id="154914")
    calls = []

    def fake_get(url, timeout=30.0):
        calls.append(url)
        raise OSError("[Errno 104] Connection reset by peer")

    monkeypatch.setattr(flex_fetch, "_http_get", fake_get)
    monkeypatch.setattr(flex_fetch.time, "sleep", lambda *_: None)

    with pytest.raises(flex_fetch.FlexFetchError) as excinfo:
        flex_fetch.fetch_one(spec, max_polls=10, poll_interval=0, max_poll_retries=5)

    # The asymmetry that makes the poll retry safe is exactly what makes this
    # one unsafe: a request that reaches IBKR counts against the ~24h
    # allowance even when the reply never reaches us, so a blind retry here
    # can spend two days of quota on one sync.
    assert len(calls) == 1
    assert "SendRequest" in calls[0]
    assert "SendRequest" in str(excinfo.value)


def test_zero_retries_restores_fail_fast(monkeypatch):
    import pytest

    from parser import flex_fetch

    spec = flex_fetch.AccountSpec(token="SECRET123", query_id="154914")
    calls = _flex_stub(monkeypatch, [OSError("reset"), CSV_BODY])

    with pytest.raises(flex_fetch.FlexFetchError):
        flex_fetch.fetch_one(spec, max_polls=10, poll_interval=0, max_poll_retries=0)

    # The escape hatch has to actually escape: one SendRequest, one poll, out.
    assert len(calls) == 2


def test_ibkr_error_codes_are_not_retried(monkeypatch):
    import pytest

    from parser import flex_fetch

    spec = flex_fetch.AccountSpec(token="SECRET123", query_id="154914")
    refused = ("<FlexStatementResponse><Status>Fail</Status><ErrorCode>1001</ErrorCode>"
               "<ErrorMessage>Statement could not be generated at this time."
               "</ErrorMessage></FlexStatementResponse>")
    calls = _flex_stub(monkeypatch, [refused, CSV_BODY])

    with pytest.raises(flex_fetch.FlexFetchError) as excinfo:
        flex_fetch.fetch_one(spec, max_polls=10, poll_interval=0, max_poll_retries=5)

    # An envelope with a code is IBKR answering, not the wire dropping. The
    # retry must not blur the two: 1001 means the generation was never queued,
    # and re-polling a reference code that has nothing behind it just spends
    # the budget to arrive at the same answer.
    assert excinfo.value.code == "1001"
    assert len(calls) == 2


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
    monkeypatch.setattr(app_mod, "ALLOW_MANUAL_REFRESH", True)
    app_mod._refresh_state.update({"last_finished": 0.0, "in_progress": False,
                                   "last_result": None})

    started, release = threading.Event(), threading.Event()

    def blocking_fetch(_spec, **_kw):
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
    monkeypatch.setattr(app_mod, "ALLOW_MANUAL_REFRESH", True)
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
    monkeypatch.setattr(app_mod, "ALLOW_MANUAL_REFRESH", True)
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

    import pytest

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

    import pytest

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


# ---------------------------------------------------------------------------
# Manual-refresh quota warning. IBKR allows roughly one generation of the
# query per day and the scheduler already claims it, so a manual press inside
# the window spends what tomorrow's scheduled run needs.
# ---------------------------------------------------------------------------

def test_manual_refresh_advice_flags_a_recent_request(monkeypatch):
    import app as app_mod

    now = datetime.now(timezone.utc)
    recent = (now - timedelta(hours=5)).isoformat(timespec="seconds")
    advice = app_mod._manual_refresh_advice({"last_run_at": recent})
    assert advice["risky"] is True
    assert 4 * 3600 < advice["since_sec"] < 6 * 3600
    assert advice["window_sec"] == app_mod.IBKR_QUERY_WINDOW_SEC

    # Past the window the button is free again.
    old = (now - timedelta(hours=25)).isoformat(timespec="seconds")
    assert app_mod._manual_refresh_advice({"last_run_at": old})["risky"] is False

    # Nothing recorded yet (fresh install): no basis to warn about.
    assert app_mod._manual_refresh_advice({})["risky"] is False
    # A hand-mangled timestamp must not 500 the status endpoint.
    assert app_mod._manual_refresh_advice({"last_run_at": "not a date"})["risky"] is False


def test_next_scheduled_run(monkeypatch):
    import app as app_mod

    monkeypatch.setattr(app_mod, "AUTO_SYNC", "daily")
    monkeypatch.setattr(app_mod, "AUTO_SYNC_UTC_HOUR", 6)
    before = datetime(2026, 9, 6, 3, 0, tzinfo=timezone.utc)
    assert app_mod._next_scheduled_run(before) == datetime(2026, 9, 6, 6, 0, tzinfo=timezone.utc)
    # Past today's hour, the next one is tomorrow — the case that matters,
    # since the button is usually pressed after a morning failure.
    after = datetime(2026, 9, 6, 7, 0, tzinfo=timezone.utc)
    assert app_mod._next_scheduled_run(after) == datetime(2026, 9, 7, 6, 0, tzinfo=timezone.utc)

    monkeypatch.setattr(app_mod, "AUTO_SYNC", "weekly")
    monkeypatch.setattr(app_mod, "AUTO_SYNC_UTC_DAY", "sat")
    nxt = app_mod._next_scheduled_run(datetime(2026, 9, 6, 7, 0, tzinfo=timezone.utc))
    assert nxt.weekday() == 5 and nxt.hour == 6

    monkeypatch.setattr(app_mod, "AUTO_SYNC", "off")
    assert app_mod._next_scheduled_run(before) is None


def test_status_endpoint_carries_the_advice(tmp_path, monkeypatch):
    import app as app_mod

    path = tmp_path / ".auto_sync_state.json"
    monkeypatch.setattr(app_mod, "SYNC_STATE_FILE", path)
    path.write_text(json.dumps({
        "last_run_at": (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(
            timespec="seconds"),
    }), encoding="utf-8")
    app_mod._refresh_state.update({"last_finished": 0.0, "in_progress": False})

    st = app_mod.app.test_client().get("/api/refresh/status").get_json()
    # The button pre-flights on this; without it there is nothing to warn from.
    assert st["manual"]["risky"] is True
    assert st["last_run_at"]


# ---------------------------------------------------------------------------
# Quota ownership. The advice above is a hint, which is the right shape for a
# person who can see the whole picture. A second copy of the app sees none of
# it — same code, same sync.env, same Flex query — so its button is not a
# second button, it is the same one. Ownership is declared in the environment
# and fails closed.
# ---------------------------------------------------------------------------

def test_refresh_is_refused_when_the_instance_does_not_own_the_quota(monkeypatch):
    import app as app_mod

    spec = SimpleNamespace(tag="test", token="tok", query_id="123")
    monkeypatch.setattr(app_mod, "parse_accounts_env", lambda _: [spec])
    monkeypatch.setenv("ACCOUNTS", "tok:123")
    monkeypatch.setattr(app_mod, "ALLOW_MANUAL_REFRESH", False)
    app_mod._refresh_state.update({"last_finished": 0.0, "in_progress": False})

    def must_not_run(_spec, **_kw):   # pragma: no cover - the point is that it is not
        raise AssertionError("a locked instance reached IBKR")

    monkeypatch.setattr(app_mod, "fetch_one", must_not_run)

    res = app_mod.app.test_client().post("/api/refresh")
    assert res.status_code == 409
    # The message has to name the way out, or the next person hunts for it.
    assert "ALLOW_MANUAL_REFRESH" in res.get_json()["detail"]
    # Refusing must not take the slot. The scheduler claims through the same
    # lock, so a refusal that held it would trade this problem for a worse one.
    assert app_mod._refresh_state["in_progress"] is False
    assert app_mod._refresh_state["last_finished"] == 0.0


def test_the_lock_answers_before_config_errors(monkeypatch):
    import app as app_mod

    # A *working* config is exactly what makes a second copy dangerous, so the
    # lock goes first. A 500 here would tell a dev instance that its ACCOUNTS
    # is the only thing between it and the button.
    monkeypatch.setenv("ACCOUNTS", "")
    monkeypatch.setattr(app_mod, "ALLOW_MANUAL_REFRESH", False)
    app_mod._refresh_state.update({"last_finished": 0.0, "in_progress": False})
    assert app_mod.app.test_client().post("/api/refresh").status_code == 409


def test_status_tells_the_button_whether_it_may_press(tmp_path, monkeypatch):
    import app as app_mod

    # Without this the button looks ready and only finds out on press — which
    # is the same click the user already made, just with a nicer error.
    monkeypatch.setattr(app_mod, "SYNC_STATE_FILE", tmp_path / "state.json")
    app_mod._refresh_state.update({"last_finished": 0.0, "in_progress": False})
    client = app_mod.app.test_client()

    monkeypatch.setattr(app_mod, "ALLOW_MANUAL_REFRESH", False)
    assert client.get("/api/refresh/status").get_json()["manual_allowed"] is False
    monkeypatch.setattr(app_mod, "ALLOW_MANUAL_REFRESH", True)
    assert client.get("/api/refresh/status").get_json()["manual_allowed"] is True


def test_env_flag_tolerates_the_quotes_env_files_ship(monkeypatch):
    import app as app_mod

    for raw in ['"1"', "1", "true", "TRUE", "on", "'yes'", " 1 "]:
        monkeypatch.setenv("SOME_FLAG", raw)
        assert app_mod._env_flag("SOME_FLAG") is True, raw
    for raw in ["", "0", "no", "off", '""', "maybe"]:
        monkeypatch.setenv("SOME_FLAG", raw)
        assert app_mod._env_flag("SOME_FLAG") is False, raw
    monkeypatch.delenv("SOME_FLAG", raising=False)
    assert app_mod._env_flag("SOME_FLAG") is False


# ---------------------------------------------------------------------------
# Reference codes kept across a timeout (lesson #26). 2026-11-03 and 2026-11-10
# each ran out of poll budget while IBKR was still generating, and threw the
# reference code away with the exception — a statement already paid for with
# the day's single generation, which GetStatement would have fetched for free
# once it was ready. Every test here talks to a fake IBKR; nothing leaves the
# process.
# ---------------------------------------------------------------------------

SEND_OK = "<Status>Success</Status><ReferenceCode>987654</ReferenceCode>"
ERROR_1001 = ("<FlexStatementResponse><Status>Fail</Status><ErrorCode>1001</ErrorCode>"
              "<ErrorMessage>Statement could not be generated at this time. "
              "Please try again shortly.</ErrorMessage></FlexStatementResponse>")


def _ibkr(monkeypatch, script, *, then=IN_PROGRESS):
    """A fake IBKR for whole passes. SendRequest issues code 987654; each
    GetStatement plays the next entry of `script`, then `then` for good — so a
    default-budget poll runs out exactly the way 11-03 and 11-10 did, only
    instantly. Returns every URL requested."""
    from parser import flex_fetch

    calls = []
    queue = list(script)

    def fake_get(url, timeout=30.0):
        calls.append(url)
        if "SendRequest" in url:
            return SEND_OK
        nxt = queue.pop(0) if queue else then
        if isinstance(nxt, BaseException):
            raise nxt
        return nxt

    monkeypatch.setattr(flex_fetch, "_http_get", fake_get)
    monkeypatch.setattr(flex_fetch.time, "sleep", lambda *_: None)
    return calls


def _resume_rig(tmp_path, monkeypatch, tags=("test",)):
    """app.py wired to the fake IBKR, a scratch state file and a fake account
    store. Returns (app module, list of account ids saved)."""
    import app as app_mod
    from parser import flex_fetch

    # The budget tests above importlib.reload(flex_fetch), which mints a new
    # FlexFetchError class while app.py still holds the one it imported — its
    # `except FlexFetchError` would miss what the reloaded fetcher raises.
    for name in ("FlexFetchError", "fetch_one", "poll_statement"):
        monkeypatch.setattr(app_mod, name, getattr(flex_fetch, name))
    specs = [SimpleNamespace(tag=t, token="tok", query_id="123") for t in tags]
    monkeypatch.setattr(app_mod, "parse_accounts_env", lambda _: specs)
    monkeypatch.setenv("ACCOUNTS", "tok:123")
    monkeypatch.setattr(app_mod, "SYNC_STATE_FILE", tmp_path / ".auto_sync_state.json")
    monkeypatch.setattr(app_mod, "parse_ibkr_auto",
                        lambda body: {"accounts": {"U0000001": {"csv": body}}})
    saved: list[str] = []

    def save(payload):
        saved.extend(payload["accounts"])
        return list(payload["accounts"]), []

    monkeypatch.setattr(app_mod, "_save_accounts", save)
    app_mod._refresh_state.update({"last_finished": 0.0, "in_progress": False,
                                   "last_result": None})
    return app_mod, saved


def _hold(app_mod, tag, *, requested, last_try=None, ref="555111", looks=1):
    """Put a kept code on disk the way a timed-out pass leaves it."""
    path = app_mod.PENDING_FILE
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    data[tag] = {"ref": ref, "requested_at": requested.isoformat(timespec="seconds"),
                 "trigger": "auto", "looks": looks,
                 "last_try_at": (last_try or requested).isoformat(timespec="seconds"),
                 "last_error": "IBKR still generating after 1800s — try again later"}
    path.write_text(json.dumps(data), encoding="utf-8")


def _state(tmp_path):
    return json.loads((tmp_path / ".auto_sync_state.json").read_text(encoding="utf-8"))


def test_a_timeout_hands_back_the_reference_code(monkeypatch):
    from parser import flex_fetch

    spec = flex_fetch.AccountSpec(token="SECRET123", query_id="100001")
    _ibkr(monkeypatch, [])                       # in progress, all the way
    with pytest.raises(flex_fetch.FlexFetchError) as excinfo:
        flex_fetch.fetch_one(spec, max_polls=3, poll_interval=0)
    # Out of OUR budget while IBKR still said "in progress": the generation is
    # alive and already paid for, so the code is the one thing worth keeping.
    assert excinfo.value.code == "timeout"
    assert excinfo.value.reference == "987654"

    # A network that stayed down never got an answer at all — nothing was
    # decided about the statement, so the code survives that too.
    _ibkr(monkeypatch, [OSError("[Errno 104] Connection reset by peer")] * 4)
    with pytest.raises(flex_fetch.FlexFetchError) as excinfo:
        flex_fetch.fetch_one(spec, max_polls=10, poll_interval=0, max_poll_retries=2)
    assert excinfo.value.code == "network"
    assert excinfo.value.reference == "987654"


def test_a_coded_ibkr_answer_ends_the_code(monkeypatch):
    from parser import flex_fetch

    spec = flex_fetch.AccountSpec(token="SECRET123", query_id="100001")
    # 1001's own text says "try again shortly", and nine of them in a row once
    # escalated into a 1025 lockout (lesson #11). A coded answer is IBKR's
    # verdict on this generation; asking again every half hour is not free.
    _ibkr(monkeypatch, [ERROR_1001])
    with pytest.raises(flex_fetch.FlexFetchError) as excinfo:
        flex_fetch.fetch_one(spec, max_polls=10, poll_interval=0)
    assert excinfo.value.code == "1001"
    assert excinfo.value.reference == ""

    # Refused at SendRequest: no generation was started, so there is no code.
    monkeypatch.setattr(flex_fetch, "_http_get", lambda url, timeout=30.0: ERROR_1001)
    with pytest.raises(flex_fetch.FlexFetchError) as excinfo:
        flex_fetch.fetch_one(spec, max_polls=10, poll_interval=0)
    assert "refused request" in str(excinfo.value)
    assert excinfo.value.reference == ""


def test_polling_a_kept_code_never_spends_a_generation(monkeypatch):
    from parser import flex_fetch

    spec = flex_fetch.AccountSpec(token="SECRET123", query_id="100001")
    calls = _ibkr(monkeypatch, [IN_PROGRESS, CSV_BODY])
    assert flex_fetch.poll_statement(spec, "555111", max_polls=5, poll_interval=0) == CSV_BODY
    # SendRequest is the day's quota; GetStatement against the code is free.
    assert len(calls) == 2
    assert all("GetStatement" in u and "q=555111" in u for u in calls)


def test_a_timed_out_statement_is_fetched_later_without_a_new_request(tmp_path, monkeypatch):
    # 2026-11-10 replayed, with the ending it should have had.
    app_mod, saved = _resume_rig(tmp_path, monkeypatch)
    monkeypatch.setattr(app_mod, "AUTO_SYNC", "daily")

    # 10:00 — the scheduled pass runs out of budget, IBKR still generating.
    calls = _ibkr(monkeypatch, [])
    payload, status = app_mod._run_refresh("auto")
    assert status == 200
    (entry,) = payload["results"]
    assert entry["ok"] is False and entry["pending"] is True
    assert "已保留 reference code" in entry["error"]
    assert "Z 接着取" in entry["error"], "the scheduler is on, so name the time"
    kept = json.loads(app_mod.PENDING_FILE.read_text(encoding="utf-8"))
    assert kept["test"]["ref"] == "987654"
    assert kept["test"]["looks"] == 1 and kept["test"]["trigger"] == "auto"
    state = _state(tmp_path)
    assert state["ok"] is False and state["waiting"] is True
    first_run_at = state["last_run_at"]

    # A rebuild: nothing in memory survives, only the file on the volume.
    app_mod._refresh_state.update({"last_finished": 0.0, "in_progress": False,
                                   "last_result": None})

    # 10:30 — the scheduler looks again; IBKR has finished.
    calls += _ibkr(monkeypatch, [IN_PROGRESS, CSV_BODY])
    payload, status = app_mod._run_refresh("resume")
    assert status == 200
    (entry,) = payload["results"]
    assert entry["ok"] is True and entry["resumed"] is True
    assert saved == ["U0000001"]
    # One generation paid for, one statement delivered.
    assert sum("SendRequest" in u for u in calls) == 1
    assert json.loads(app_mod.PENDING_FILE.read_text(encoding="utf-8")) == {}

    state = _state(tmp_path)
    assert state["ok"] is True and state["waiting"] is False
    assert state["last_success"] and state["last_resume_at"]
    # last_run_at is what the quota warning reads as "IBKR last saw a
    # request". A resume sent none, so it must not move.
    assert state["last_run_at"] == first_run_at
    assert state["last_run_trigger"] == "auto"


def test_a_button_press_while_a_code_is_kept_fetches_that_code(tmp_path, monkeypatch):
    app_mod, saved = _resume_rig(tmp_path, monkeypatch)
    now = datetime.now(timezone.utc)
    _hold(app_mod, "test", requested=now - timedelta(hours=2),
          last_try=now - timedelta(minutes=5))
    calls = _ibkr(monkeypatch, [CSV_BODY])

    payload, _status = app_mod._run_refresh("button")
    # A fresh SendRequest two hours after the last one is a 1001 that also
    # spends tomorrow's generation. The paid-for statement is right there.
    assert not any("SendRequest" in u for u in calls)
    assert payload["results"][0]["ok"] is True
    assert saved == ["U0000001"]
    assert json.loads(app_mod.PENDING_FILE.read_text(encoding="utf-8")) == {}
    assert _state(tmp_path)["last_run_trigger"] == "button"


def test_a_look_that_times_out_again_keeps_the_original_request_time(tmp_path, monkeypatch):
    app_mod, _ = _resume_rig(tmp_path, monkeypatch)
    now = datetime.now(timezone.utc)
    requested = now - timedelta(hours=1)
    _hold(app_mod, "test", requested=requested, last_try=now - timedelta(minutes=31),
          looks=2)
    calls = _ibkr(monkeypatch, [])

    payload, _status = app_mod._run_refresh("resume")
    assert payload["results"][0]["pending"] is True
    # A resume look is short (PENDING_RESUME_POLLS), not a whole budget.
    assert len(calls) == app_mod.PENDING_RESUME_POLLS
    kept = json.loads(app_mod.PENDING_FILE.read_text(encoding="utf-8"))["test"]
    assert kept["looks"] == 3
    # The age limit runs from the SendRequest that paid for the generation,
    # not from the latest look — or a stuck code would never age out.
    assert kept["requested_at"] == requested.isoformat(timespec="seconds")


def test_an_ibkr_error_on_a_kept_code_drops_it_and_says_why(tmp_path, monkeypatch):
    app_mod, _ = _resume_rig(tmp_path, monkeypatch)
    now = datetime.now(timezone.utc)
    _hold(app_mod, "test", requested=now - timedelta(hours=3),
          last_try=now - timedelta(minutes=31))
    calls = _ibkr(monkeypatch, [ERROR_1001])

    payload, _status = app_mod._run_refresh("resume")
    (entry,) = payload["results"]
    assert entry["ok"] is False and not entry.get("pending")
    assert "code=1001" in entry["error"] and "已失效" in entry["error"]
    assert not any("SendRequest" in u for u in calls)
    assert json.loads(app_mod.PENDING_FILE.read_text(encoding="utf-8")) == {}
    # A plain failure again: the page goes back to red, not "waiting".
    assert _state(tmp_path)["waiting"] is False


def test_a_code_past_its_age_limit_is_forgotten(tmp_path, monkeypatch):
    app_mod, _ = _resume_rig(tmp_path, monkeypatch)
    now = datetime.now(timezone.utc)
    _hold(app_mod, "test",
          requested=now - timedelta(seconds=app_mod.PENDING_MAX_AGE_SEC + 60),
          last_try=now - timedelta(hours=1))

    # Not due, and gone from the file rather than merely skipped: the next
    # day's run must ask IBKR for fresh data, not wait on yesterday's.
    assert app_mod._pending_due(now) is False
    assert json.loads(app_mod.PENDING_FILE.read_text(encoding="utf-8")) == {}

    # A resume with nothing left to look at touches neither IBKR nor the
    # verdict on disk.
    calls = _ibkr(monkeypatch, [CSV_BODY])
    payload, status = app_mod._run_refresh("resume")
    assert (payload["results"], status) == ([], 200)
    assert calls == []
    assert not (tmp_path / ".auto_sync_state.json").exists()


def test_a_kept_code_is_looked_at_every_half_hour(tmp_path, monkeypatch):
    app_mod, _ = _resume_rig(tmp_path, monkeypatch)
    last = datetime(2026, 11, 10, 10, 30, 5, tzinfo=timezone.utc)
    _hold(app_mod, "test", requested=last - timedelta(minutes=30), last_try=last)
    gap = timedelta(seconds=app_mod.PENDING_RESUME_EVERY_SEC)
    assert app_mod._pending_due(last + gap - timedelta(seconds=1)) is False
    assert app_mod._pending_due(last + gap) is True


def test_the_scheduler_looks_again_between_daily_runs(tmp_path, monkeypatch):
    app_mod, _ = _resume_rig(tmp_path, monkeypatch)
    monkeypatch.setattr(app_mod, "AUTO_SYNC", "daily")
    monkeypatch.setattr(app_mod, "AUTO_SYNC_UTC_HOUR", 10)
    state_path = tmp_path / ".auto_sync_state.json"
    state_path.write_text(json.dumps({"last_attempt_date": "2026-11-10",
                                      "last_run_at": "2026-11-10T10:00:05+00:00"}),
                          encoding="utf-8")
    last = datetime(2026, 11, 10, 10, 30, 5, tzinfo=timezone.utc)
    _hold(app_mod, "test", requested=last - timedelta(minutes=30), last_try=last)
    runs = []
    monkeypatch.setattr(app_mod, "_run_refresh",
                        lambda trigger: (runs.append(trigger), ({"ok": False}, 200))[1])

    assert app_mod._auto_sync_tick(last + timedelta(minutes=10)) == ""
    assert app_mod._auto_sync_tick(last + timedelta(minutes=30)) == "resume"
    assert runs == ["resume"]
    # A look is not the day's attempt: that slot belongs to tomorrow's run.
    assert json.loads(state_path.read_text(encoding="utf-8"))["last_attempt_date"] == "2026-11-10"

    # The slot is busy (a button pass, the cool-down): just wait a tick.
    monkeypatch.setattr(app_mod, "_run_refresh",
                        lambda trigger: ({"error": "refresh already in progress"}, 429))
    assert app_mod._auto_sync_tick(last + timedelta(minutes=31)) == "refused"

    # Tomorrow's scheduled run still comes first while a code is held.
    monkeypatch.setattr(app_mod, "_run_refresh",
                        lambda trigger: (runs.append(trigger), ({"ok": False}, 200))[1])
    assert app_mod._auto_sync_tick(datetime(2026, 11, 11, 10, 0, 30, tzinfo=timezone.utc)) == "run"
    assert runs[-1] == "auto"


def test_a_resume_keeps_the_other_accounts_verdict(tmp_path, monkeypatch):
    app_mod, _ = _resume_rig(tmp_path, monkeypatch)
    app_mod._record_sync_outcome({"ok": False, "results": [
        {"tag": "aaa", "ok": False, "error": "IBKR refused request: code=1015"},
        {"tag": "bbb", "ok": False, "pending": True,
         "error": "IBKR still generating · 已保留 reference code"},
    ]}, "auto")
    state = _state(tmp_path)
    # aaa failed for good, so this is a failure, not a wait.
    assert state["ok"] is False and state["waiting"] is False

    # bbb's code delivers. A resume only looked at bbb; judged on its own it
    # would print a green ✓ over aaa's broken token.
    app_mod._record_sync_outcome(
        {"ok": True, "results": [{"tag": "bbb", "ok": True, "resumed": True}]}, "resume")
    state = _state(tmp_path)
    assert state["ok"] is False
    assert "aaa: IBKR refused request" in state["detail"] and "bbb: ok" in state["detail"]
    assert "last_success" not in state


def test_status_reports_kept_codes_but_never_the_code(tmp_path, monkeypatch):
    app_mod, _ = _resume_rig(tmp_path, monkeypatch, tags=("test", "other"))
    now = datetime.now(timezone.utc)
    (tmp_path / ".auto_sync_state.json").write_text(json.dumps({
        "last_run_at": (now - timedelta(hours=2)).isoformat(timespec="seconds"),
    }), encoding="utf-8")
    _hold(app_mod, "test", requested=now - timedelta(hours=2),
          last_try=now - timedelta(minutes=10))
    client = app_mod.app.test_client()

    # The scheduler is off: nobody will look at a set time, so none is shown.
    monkeypatch.setattr(app_mod, "AUTO_SYNC", "off")
    st = client.get("/api/refresh/status").get_json()
    (held,) = st["pending"]
    assert held["tag"] == "test" and held["looks"] == 1
    assert held["next_try_at"] == "" and held["gives_up_at"]
    # The code is a capability for this account's statement; the page needs
    # only to know one exists.
    assert "555111" not in json.dumps(st)
    # "other" holds nothing, so a press still sends its SendRequest.
    assert st["manual"]["risky"] is True

    monkeypatch.setattr(app_mod, "AUTO_SYNC", "daily")
    _hold(app_mod, "other", requested=now - timedelta(hours=2),
          last_try=now - timedelta(minutes=10))
    st = client.get("/api/refresh/status").get_json()
    assert all(p["next_try_at"] for p in st["pending"])
    # Every query holds a code: a press only fetches those, nothing to spend.
    assert st["manual"] == {"risky": False, "held": True}


def test_portfolio_carries_the_kept_codes_for_the_banner(tmp_path, monkeypatch):
    app_mod, _ = _resume_rig(tmp_path, monkeypatch)
    monkeypatch.setattr(app_mod, "_load_all_accounts", lambda *a, **k: {"U0000001": {}})
    monkeypatch.setattr(app_mod, "PROFIT_TARGETS_FILE", tmp_path / ".profit_targets.json")
    monkeypatch.setattr(app_mod, "AUTO_SYNC", "daily")
    now = datetime.now(timezone.utc)
    _hold(app_mod, "test", requested=now - timedelta(hours=1),
          last_try=now - timedelta(minutes=10))

    body = app_mod.app.test_client().get("/api/portfolio").get_json()
    assert [p["tag"] for p in body["sync"]["pending"]] == ["test"]
    assert "555111" not in json.dumps(body["sync"])


def test_a_hand_edited_pending_file_never_breaks_the_page(tmp_path, monkeypatch):
    app_mod, _ = _resume_rig(tmp_path, monkeypatch)
    client = app_mod.app.test_client()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for broken in ("not json", "[]", json.dumps({"test": "x"}),
                   json.dumps({"test": {"ref": "1", "requested_at": "yesterday"}}),
                   json.dumps({"test": {"ref": "1", "requested_at": now, "looks": "many"}})):
        app_mod.PENDING_FILE.write_text(broken, encoding="utf-8")
        res = client.get("/api/refresh/status")
        assert res.status_code == 200, broken
        assert all(p["looks"] == 0 for p in res.get_json()["pending"]), broken
