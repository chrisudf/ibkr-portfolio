# -*- coding: utf-8 -*-
"""Underlying closes for the delta panel: parsing, date matching, cache, endpoint.

No network: every fetch is a fake. Account ids are fake too (the repo is public).
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parser import quotes  # noqa: E402
from parser.quotes import (  # noqa: E402
    MAX_BAR_GAP_DAYS, MISS_RETRY_SEC, PROVISIONAL_TTL_SEC, QuoteError,
    close_on_or_before, needed_closes, parse_daily_closes, refresh_after, resolve_closes,
    yahoo_symbol,
)

NY_WINTER = -5 * 3600     # gmtoffset Yahoo reports for New York after DST ends


def _ts(day: str, hour_utc: int) -> int:
    y, m, d = map(int, day.split("-"))
    return int(datetime(y, m, d, hour_utc, tzinfo=timezone.utc).timestamp())


def _chart(rows, offset=NY_WINTER):
    """A chart payload: rows of (timestamp, close)."""
    return {"chart": {"error": None, "result": [{
        "meta": {"gmtoffset": offset},
        "timestamp": [ts for ts, _ in rows],
        "indicators": {"quote": [{"close": [px for _, px in rows]}]},
    }]}}


def _acct(day, stocks=(), options=()):
    return {
        "nav": {"total": 1.0},
        "nav_history": [{"date": day, "total": 1.0}] if day else [],
        "statement": {},
        "stocks": [{"symbol": s, "quantity": 1, "close_price": px, "value": px}
                   for s, px in stocks],
        "options": [{"underlying": u, "symbol": f"{u} 18DEC26 50 P", "strike": 50,
                     "right": "P", "expiry": "18DEC26", "quantity": -1}
                    for u in options],
    }


# --- symbols and parsing -----------------------------------------------------

def test_share_classes_map_to_yahoo_spelling():
    assert yahoo_symbol("BRK B") == "BRK-B"
    assert yahoo_symbol("BRK.B") == "BRK-B"
    assert yahoo_symbol(" soxl ") == "SOXL"


def test_bars_are_dated_by_the_exchange_clock_not_utc():
    # 09:30 New York is 14:30 UTC — same date either way. A bar stamped
    # 03:00 UTC on the 6th is still the 5th in New York, and must say so.
    rows = parse_daily_closes(_chart([
        (_ts("2026-11-04", 14), 66.68),
        (_ts("2026-11-06", 3), 40.87),
    ]))
    assert rows == [("2026-11-04", 66.68), ("2026-11-05", 40.87)]


def test_null_and_nonpositive_closes_are_dropped():
    rows = parse_daily_closes(_chart([
        (_ts("2026-11-04", 14), None),
        (_ts("2026-11-05", 14), 0),
        (_ts("2026-11-06", 14), 45.97),
    ]))
    assert rows == [("2026-11-06", 45.97)]


def test_chart_errors_raise():
    with pytest.raises(QuoteError, match="Not Found"):
        parse_daily_closes({"chart": {"error": {"code": "Not Found",
                                                "description": "No data found"}}})
    with pytest.raises(QuoteError):
        parse_daily_closes({"chart": {"result": []}})


# --- same day as the statement ------------------------------------------------

ROWS = [("2026-11-03", 73.12), ("2026-11-04", 66.68), ("2026-11-05", 40.87),
        ("2026-11-06", 45.97)]


def test_close_is_the_statement_days_own_never_a_later_one():
    assert close_on_or_before(ROWS, "2026-11-05") == ("2026-11-05", 40.87)


def test_holiday_statement_date_takes_the_previous_session():
    # IBKR books a NAV row on a US market holiday; the marks are the day before's.
    assert close_on_or_before(ROWS[:3], "2026-11-07") == ("2026-11-05", 40.87)


def test_nothing_on_or_before_and_too_old_both_give_none():
    assert close_on_or_before(ROWS, "2026-11-02") is None
    stale_day = date.fromordinal(date(2026, 11, 6).toordinal() + MAX_BAR_GAP_DAYS + 1)
    assert close_on_or_before(ROWS, stale_day.isoformat()) is None


# --- what to fetch --------------------------------------------------------------

def test_only_names_no_same_day_account_holds_as_stock_are_needed():
    accounts = {
        "U1111111": _acct("2026-11-05", stocks=[("VRT", 176.73)], options=["SOXL", "VRT"]),
        "U2222222": _acct("2026-11-05", stocks=[("COHR", 170.0)], options=["COHR", "RKLB"]),
        # a day behind: its NVDA mark is the wrong day's price for 11-05
        "U3333333": _acct("2026-11-04", stocks=[("NVDA", 200.13)], options=["NVDA"]),
        "U4444444": _acct("2026-11-05", options=["NVDA"]),
        "U5555555": _acct("", options=["ORCL"]),          # undatable: skipped
    }
    dates, need = needed_closes(accounts)
    assert dates == {"U1111111": "2026-11-05", "U2222222": "2026-11-05",
                     "U3333333": "2026-11-04", "U4444444": "2026-11-05"}
    assert need == {"2026-11-05": ["NVDA", "RKLB", "SOXL"]}


def test_a_held_stock_without_a_mark_does_not_count_as_priced():
    accounts = {"U1111111": _acct("2026-11-05", stocks=[("SOXL", 0)], options=["SOXL"])}
    assert needed_closes(accounts)[1] == {"2026-11-05": ["SOXL"]}


# --- cache ------------------------------------------------------------------------

class FakeFetch:
    def __init__(self, table=None, fail=None):
        self.table = table or {}
        self.fail = fail or {}
        self.calls = []

    def __call__(self, symbol, day):
        self.calls.append((symbol, day.isoformat()))
        if symbol in self.fail:
            raise self.fail[symbol]
        return self.table.get(symbol, [])


NEED = {"2026-11-05": ["COHR", "SOXL"]}
TABLE = {"SOXL": ROWS, "COHR": [("2026-11-05", 169.76)]}


def test_fetched_once_then_served_from_cache():
    fetch = FakeFetch(TABLE)
    closes, misses, cache = resolve_closes(NEED, {}, fetch=fetch, now=1000.0, today="2026-11-09")
    assert sorted(fetch.calls) == [("COHR", "2026-11-05"), ("SOXL", "2026-11-05")]
    assert closes["2026-11-05"]["SOXL"]["close"] == 40.87
    assert closes["2026-11-05"]["SOXL"]["final"] is True
    assert misses == {}
    fetch2 = FakeFetch(TABLE)
    closes2, _, cache2 = resolve_closes(NEED, cache, fetch=fetch2, now=10**9, today="2026-11-20")
    assert fetch2.calls == []                     # a past session's close never changes
    assert closes2 == closes
    assert cache2 == cache                        # nothing to write back


def test_a_bar_fetched_on_the_day_itself_is_provisional():
    fetch = FakeFetch(TABLE)
    _, _, cache = resolve_closes(NEED, {}, fetch=fetch, now=1000.0, today="2026-11-05")
    assert cache["closes"]["2026-11-05"]["SOXL"]["final"] is False
    fetch2 = FakeFetch(TABLE)
    resolve_closes(NEED, cache, fetch=fetch2, now=1000.0 + PROVISIONAL_TTL_SEC - 1, today="2026-11-05")
    assert fetch2.calls == []
    resolve_closes(NEED, cache, fetch=fetch2, now=1000.0 + PROVISIONAL_TTL_SEC + 1, today="2026-11-06")
    assert len(fetch2.calls) == 2


def test_failures_are_reported_per_name_and_not_retried_every_load():
    fetch = FakeFetch({"COHR": [("2026-11-05", 169.76)], "SOXL": []},
                      fail={"SOXL": QuoteError("HTTP 404")})
    closes, misses, cache = resolve_closes(NEED, {}, fetch=fetch, now=1000.0, today="2026-11-09")
    assert closes["2026-11-05"]["COHR"]["close"] == 169.76     # one bad name sinks nothing
    assert misses["2026-11-05"]["SOXL"]["error"] == "HTTP 404"
    fetch2 = FakeFetch(TABLE)
    _, misses2, _ = resolve_closes(NEED, cache, fetch=fetch2, now=1000.0 + MISS_RETRY_SEC - 1,
                                   today="2026-11-09")
    assert fetch2.calls == [] and "SOXL" in misses2["2026-11-05"]
    closes3, misses3, _ = resolve_closes(NEED, cache, fetch=fetch2, now=1000.0 + MISS_RETRY_SEC + 1,
                                         today="2026-11-09")
    assert fetch2.calls == [("SOXL", "2026-11-05")]
    assert closes3["2026-11-05"]["SOXL"]["close"] == 40.87 and misses3 == {}


def test_unexpected_errors_and_missing_bars_become_misses():
    fetch = FakeFetch({"COHR": [("2026-10-01", 150.0)]}, fail={"SOXL": ValueError("bad json")})
    _, misses, _ = resolve_closes(NEED, {}, fetch=fetch, now=1.0, today="2026-11-09")
    assert misses["2026-11-05"]["SOXL"]["error"] == "ValueError: bad json"
    assert "2026-11-05" in misses["2026-11-05"]["COHR"]["error"]


def test_cache_keeps_only_what_is_still_asked_for():
    old = {"version": 1, "closes": {"2026-10-01": {"SOXL": {"close": 60.0, "bar": "2026-10-01",
                                                             "final": True, "at": 1.0}}},
           "misses": {}}
    _, _, cache = resolve_closes(NEED, old, fetch=FakeFetch(TABLE), now=2.0, today="2026-11-09")
    assert list(cache["closes"]) == ["2026-11-05"]


def test_a_corrupt_cache_is_treated_as_empty():
    for junk in (None, [], {"closes": "x", "misses": 3}, {"closes": {"2026-11-05": "x"}},
                 {"closes": {"2026-11-05": {"SOXL": "x"}}, "misses": {"2026-11-05": ["x"]}},
                 {"closes": {"2026-11-05": {"SOXL": {"close": "40", "final": True}}}}):
        closes, _, _ = resolve_closes(NEED, junk, fetch=FakeFetch(TABLE), now=1.0, today="2026-11-09")
        assert closes["2026-11-05"]["SOXL"]["close"] == 40.87


# --- when the page should ask again ------------------------------------------------

def test_refresh_after_says_when_a_miss_or_provisional_bar_could_change():
    final = {"2026-11-05": {"SOXL": {"close": 40.87, "final": True, "at": 1000.0}}}
    assert refresh_after(final, {}, now=5000.0) is None           # nothing will change
    miss = {"2026-11-05": {"COHR": {"error": "HTTP 404", "at": 1000.0}}}
    assert refresh_after(final, miss, now=1000.0) == MISS_RETRY_SEC
    provisional = {"2026-11-09": {"SOXL": {"close": 45.0, "final": False, "at": 1000.0}}}
    assert refresh_after(provisional, {}, now=1100.0) == PROVISIONAL_TTL_SEC - 100
    # the earlier of the two, and never negative
    assert refresh_after(provisional, miss, now=1000.0) == min(MISS_RETRY_SEC, PROVISIONAL_TTL_SEC)
    assert refresh_after(provisional, miss, now=10**9) == 0


# --- endpoint -------------------------------------------------------------------

def test_endpoint_serves_closes_for_option_only_names(tmp_path, monkeypatch):
    import app as app_mod

    monkeypatch.setattr(app_mod, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(app_mod, "QUOTES_CACHE", tmp_path / ".quotes_cache.json")
    for acct_id, data in {
        "U1111111": _acct("2026-11-05", stocks=[("VRT", 176.73)], options=["SOXL", "VRT"]),
        "U2222222": _acct("2026-11-05", options=["COHR"]),
    }.items():
        (tmp_path / f"{acct_id}.json").write_text(json.dumps(data), encoding="utf-8")
    fetch = FakeFetch(TABLE)
    real = quotes.resolve_closes
    monkeypatch.setattr(app_mod, "resolve_closes",
                        lambda need, cache: real(need, cache, fetch=fetch, today="2026-11-09"))

    body = app_mod.app.test_client().get("/api/underlying-closes").get_json()
    assert sorted(fetch.calls) == [("COHR", "2026-11-05"), ("SOXL", "2026-11-05")]
    assert body["dates"] == {"U1111111": "2026-11-05", "U2222222": "2026-11-05"}
    assert body["closes"] == {"2026-11-05": {"COHR": {"close": 169.76, "bar": "2026-11-05"},
                                             "SOXL": {"close": 40.87, "bar": "2026-11-05"}}}
    assert body["missing"] == {}
    assert body["retry_after"] is None            # every close final: nothing to ask again for
    # The cache is a dot-file: never mistaken for an account by the uploads/*.json sweep.
    assert (tmp_path / ".quotes_cache.json").exists()
    assert sorted(app_mod._load_all_accounts()) == ["U1111111", "U2222222"]

    app_mod.app.test_client().get("/api/underlying-closes")
    assert len(fetch.calls) == 2                  # second load: all from the cache


def test_endpoint_tells_the_page_when_a_miss_is_worth_asking_again(tmp_path, monkeypatch):
    # A partial answer is still a 200; retry_after is what keeps the page from
    # holding a miss for as long as the tab is open.
    import app as app_mod

    monkeypatch.setattr(app_mod, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(app_mod, "QUOTES_CACHE", tmp_path / ".quotes_cache.json")
    (tmp_path / "U1111111.json").write_text(
        json.dumps(_acct("2026-11-05", options=["SOXL", "ZZZZ"])), encoding="utf-8")
    fetch = FakeFetch(TABLE, fail={"ZZZZ": QuoteError("HTTP 404")})
    real = quotes.resolve_closes
    monkeypatch.setattr(app_mod, "resolve_closes",
                        lambda need, cache: real(need, cache, fetch=fetch, today="2026-11-09"))

    body = app_mod.app.test_client().get("/api/underlying-closes").get_json()
    assert body["missing"] == {"2026-11-05": {"ZZZZ": "HTTP 404"}}
    assert 0 < body["retry_after"] <= MISS_RETRY_SEC


def test_loading_accounts_without_snapshots(tmp_path, monkeypatch):
    import app as app_mod

    monkeypatch.setattr(app_mod, "UPLOAD_DIR", tmp_path)
    (tmp_path / "U1111111.json").write_text(json.dumps(_acct("2026-11-05")), encoding="utf-8")
    assert "snapshots" in app_mod._load_all_accounts()["U1111111"]
    assert "snapshots" not in app_mod._load_all_accounts(with_snapshots=False)["U1111111"]
