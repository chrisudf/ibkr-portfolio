# -*- coding: utf-8 -*-
"""Benchmark fetch + /api/benchmarks cache tests (no network)."""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parser.benchmarks import BenchmarkError, parse_chart  # noqa: E402


def _ts(day: str, hour_utc: int) -> int:
    return int(datetime.fromisoformat(f"{day}T{hour_utc:02d}:30:00+00:00").timestamp())


def _chart(stamps, adj, gmtoffset=-14400):
    return {"chart": {"error": None, "result": [{
        "meta": {"symbol": "QQQ", "gmtoffset": gmtoffset},
        "timestamp": stamps,
        "indicators": {"quote": [{"close": adj}], "adjclose": [{"adjclose": adj}]},
    }]}}


def test_parse_chart_dates_by_exchange_and_drops_null_bars():
    # 13:30 UTC is 09:30 New York in summer; 14:30 UTC the same in winter.
    # Either way the bar belongs to that calendar day, not the UTC one shifted.
    payload = _chart(
        [_ts("2026-03-06", 14), _ts("2026-03-09", 13), _ts("2026-03-10", 13)],
        [500.0, None, 505.5])
    assert parse_chart(payload) == [["2026-03-06", 500.0], ["2026-03-10", 505.5]]


def test_parse_chart_error_envelope_and_empty_result():
    with pytest.raises(BenchmarkError, match="Not Found"):
        parse_chart({"chart": {"result": None,
                               "error": {"code": "Not Found", "description": "No data found"}}})
    with pytest.raises(BenchmarkError):
        parse_chart({"chart": {"result": [], "error": None}})
    with pytest.raises(BenchmarkError):
        parse_chart(_chart([_ts("2026-03-06", 14)], [None]))


ROWS = [["2026-07-30", 100.0], ["2026-07-31", 101.0], ["2026-08-03", 102.0],
        ["2026-08-04", 103.0], ["2026-08-05", 104.0]]


@pytest.fixture()
def bench(tmp_path, monkeypatch):
    import app as app_mod

    calls = []
    clock = {"t": 1_000_000.0}

    def fake_fetch(symbol, start, end, timeout=15):
        calls.append((symbol, start, end))
        if symbol in fail:
            raise BenchmarkError(f"{symbol}: HTTP 429")
        return [list(r) for r in ROWS]

    fail: set[str] = set()
    monkeypatch.setattr(app_mod, "BENCHMARK_CACHE", tmp_path / ".benchmarks.json")
    monkeypatch.setattr(app_mod, "fetch_adjusted_closes", fake_fetch)
    monkeypatch.setattr(app_mod.time, "time", lambda: clock["t"])
    return app_mod, app_mod.app.test_client(), calls, clock, fail


def test_window_keeps_the_bar_in_force_at_start(bench):
    app_mod, client, calls, _, _ = bench
    # 08-01 is a Saturday: the price in force that morning is 07-31's close.
    res = client.get("/api/benchmarks?start=2026-08-01&end=2026-08-04")
    assert res.status_code == 200
    body = res.get_json()
    assert body["errors"] == {}
    assert body["series"]["QQQ"] == [["2026-07-31", 101.0], ["2026-08-03", 102.0],
                                     ["2026-08-04", 103.0]]
    assert sorted(c[0] for c in calls) == ["QQQ", "SPY"]
    # fetched from before the window so that bar is there to keep
    assert all(c[1] < date(2026, 8, 1) for c in calls)
    cached = json.loads(app_mod.BENCHMARK_CACHE.read_text(encoding="utf-8"))
    assert set(cached) == {"QQQ", "SPY"}


def test_cache_serves_repeat_opens_and_expires(bench):
    app_mod, client, calls, clock, _ = bench
    client.get("/api/benchmarks?start=2026-07-31&end=2026-08-05")
    assert len(calls) == 2
    clock["t"] += 60
    client.get("/api/benchmarks?start=2026-07-31&end=2026-08-05")
    assert len(calls) == 2                       # served from disk
    clock["t"] += app_mod.BENCHMARK_TTL_SEC + 1
    client.get("/api/benchmarks?start=2026-07-31&end=2026-08-05")
    assert len(calls) == 4                       # TTL lapsed: both refetched


def test_window_reaching_past_the_cache_refetches(bench):
    app_mod, client, calls, clock, _ = bench
    client.get("/api/benchmarks?start=2026-07-31&end=2026-08-05")
    assert len(calls) == 2
    # Starts before the cached first bar: refetch at once.
    client.get("/api/benchmarks?start=2026-07-01&end=2026-08-05")
    assert len(calls) == 4
    # Ends after the cached last bar: one more try only after the retry gap.
    clock["t"] += 60
    client.get("/api/benchmarks?start=2026-07-31&end=2026-08-06")
    assert len(calls) == 4
    clock["t"] += app_mod.BENCHMARK_RETRY_SEC
    client.get("/api/benchmarks?start=2026-07-31&end=2026-08-06")
    assert len(calls) == 6


def test_failed_fetch_serves_stale_rows_and_says_so(bench):
    app_mod, client, _, clock, fail = bench
    client.get("/api/benchmarks?start=2026-07-31&end=2026-08-05")
    clock["t"] += app_mod.BENCHMARK_TTL_SEC + 1
    fail.add("SPY")
    body = client.get("/api/benchmarks?start=2026-07-31&end=2026-08-05").get_json()
    assert body["series"]["SPY"][-1] == ["2026-08-05", 104.0]      # stale, but there
    assert "429" in body["errors"]["SPY"]
    assert "QQQ" not in body["errors"]


def test_failed_fetch_without_cache_omits_the_symbol(bench):
    _, client, _, _, fail = bench
    fail.add("QQQ")
    body = client.get("/api/benchmarks?start=2026-07-31&end=2026-08-05").get_json()
    assert "QQQ" not in body["series"]
    assert "QQQ" in body["errors"]
    assert body["series"]["SPY"]


@pytest.mark.parametrize("query", [
    "", "start=2026-08-01", "start=nope&end=2026-08-05",
    "start=2026-08-05&end=2026-08-01", "start=2010-01-01&end=2026-08-05",
])
def test_bad_window_is_rejected_without_fetching(bench, query):
    _, client, calls, _, _ = bench
    assert client.get(f"/api/benchmarks?{query}").status_code == 400
    assert calls == []


def test_benchmark_cache_is_not_mistaken_for_an_account(tmp_path, monkeypatch):
    import app as app_mod

    (tmp_path / ".benchmarks.json").write_text('{"QQQ": {"rows": []}}', encoding="utf-8")
    monkeypatch.setattr(app_mod, "UPLOAD_DIR", tmp_path)
    assert app_mod._load_all_accounts() == {}
