"""Dataroma scraper — the traps, not the happy path.

Every test here corresponds to a failure mode that produces *plausible output*
rather than an exception, which is the only reason this file exists: a broken
scrape here does not crash the dashboard, it quietly reports the wrong side of
the market.
"""
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parser.dataroma import (build_dataset, fetch_manager, max_page,
                             modal_quarter, next_13f_deadline,
                             parse_activity_page, parse_managers, quarter_end)


def _row(ticker, company, action, shares, pct):
    """One activity row exactly as Dataroma emits it — note: no opening <tr>."""
    return (f'<td class="hist"><a href="/m/hist/hist.php?s={ticker}">&#8801</a></td>\n'
            f'<td class="stock"><a href="/m/stock.php?sym={ticker}">{ticker}'
            f'<span> - {company}</span></a></td>\n'
            f'<td class="buy">{action}</td>\n'
            f'<td class="buy">{shares}</td>\n'
            f'<td>{pct}</td>\n</tr>')


def _page(blocks, pager_max=0):
    """blocks = [(quarter_label, [row html, ...]), ...]"""
    out = ['<table id="grid"><tbody>',
           '<tr><td>History</td><td>Stock</td><td>Activity</td>'
           '<td>Share change</td><td>% change to portfolio</td></tr>']
    for label, rows in blocks:
        q, y = label.split()
        out.append(f'<tr><td colspan="5"><b>{q}</b> &nbsp<b>{y}</b></td></tr>')
        out.extend(rows)
    out.append('</tbody></table>')
    pager = "".join(
        f'<a href="m_activity.php?m=XX&typ=a&L={i}&o=a">{i}</a>'
        for i in range(1, pager_max + 1))
    return "".join(out) + pager


# ---------------------------------------------------------------------------
# Trap 1: data rows have no opening <tr>
# ---------------------------------------------------------------------------

def test_rows_without_opening_tr_are_parsed():
    """The whole quarter block lives inside ONE <tr>.

    Pairing <tr>...</tr> matches only the quarter header and returns zero data
    rows — a silent empty parse. Guard the row count explicitly.
    """
    page = _page([("Q2 2026", [
        _row("HHH", "Howard Hughes Holdings Inc.", "Add 47.74%", "9,000,000", "3.31"),
        _row("V", "Visa Inc.", "Buy", "3,270,470", "5.76"),
        _row("GOOG", "Alphabet Inc. CL C", "Sell 100.00%", "311,726", "0.65"),
    ])])
    quarter, rows = parse_activity_page(page)
    assert quarter == "Q2 2026"
    assert [r["ticker"] for r in rows] == ["HHH", "V", "GOOG"]
    assert rows[0]["action"] == "Add" and rows[0]["pct_move"] == 47.74
    assert rows[0]["shares"] == 9_000_000
    assert rows[1]["action"] == "Buy" and rows[1]["pct_move"] is None
    assert rows[2]["action"] == "Sell" and rows[2]["pct_port"] == 0.65
    assert rows[0]["company"] == "Howard Hughes Holdings Inc."


def test_only_the_first_quarter_block_is_returned():
    page = _page([
        ("Q2 2026", [_row("AAA", "A Co", "Buy", "1", "0.10")]),
        ("Q1 2026", [_row("BBB", "B Co", "Buy", "2", "0.20")]),
    ])
    quarter, rows = parse_activity_page(page)
    assert quarter == "Q2 2026"
    assert [r["ticker"] for r in rows] == ["AAA"]


# ---------------------------------------------------------------------------
# Trap 2: 100-row page cap hides the sell side
# ---------------------------------------------------------------------------

def test_full_page_triggers_continuation():
    """A manager with exactly 100 rows on page 1 is cut, not complete.

    Dataroma sorts by action type (Add → Buy → Reduce → Sell), so stopping at
    the cap drops the sell side specifically. This is the bug that made an
    unpaged scrape report 3,178 rows instead of 4,265.
    """
    page1 = _page([("Q2 2026",
                    [_row(f"T{i:03d}", "Co", "Add 1.00%", "10", "0.01")
                     for i in range(100)])], pager_max=10)
    page2 = _page([("Q2 2026", [
        _row("ZZZ", "Exited Co", "Sell 100.00%", "999", "1.50"),
    ])], pager_max=10)

    seen = []

    def getter(url):
        seen.append(url)
        return page2 if "L=2" in url else page1

    quarter, rows = fetch_manager("XX", sleep=0, getter=getter)
    assert quarter == "Q2 2026"
    assert len(rows) == 101, "continuation page was not fetched"
    assert rows[-1]["ticker"] == "ZZZ" and rows[-1]["action"] == "Sell"
    assert any("L=2" in u for u in seen)


def test_short_page_does_not_fetch_a_continuation():
    """Don't hit a stranger's server for a page we know cannot exist."""
    page1 = _page([("Q2 2026", [_row("AAA", "A Co", "Buy", "1", "0.10")])],
                  pager_max=10)
    seen = []

    def getter(url):
        seen.append(url)
        return page1

    _, rows = fetch_manager("XX", sleep=0, getter=getter)
    assert len(rows) == 1
    assert len(seen) == 1, f"expected one request, made {len(seen)}"


def test_continuation_stops_at_an_older_quarter():
    page1 = _page([("Q2 2026",
                    [_row(f"T{i:03d}", "Co", "Add 1.00%", "10", "0.01")
                     for i in range(100)])], pager_max=10)
    page2 = _page([("Q1 2026", [_row("OLD", "Old Co", "Buy", "5", "0.50")])],
                  pager_max=10)

    def getter(url):
        return page2 if "L=" in url else page1

    _, rows = fetch_manager("XX", sleep=0, getter=getter)
    assert len(rows) == 100
    assert not any(r["ticker"] == "OLD" for r in rows)


def test_max_page_reads_the_pager():
    assert max_page(_page([("Q2 2026", [])], pager_max=7)) == 7
    assert max_page(_page([("Q2 2026", [])], pager_max=0)) == 1


# ---------------------------------------------------------------------------
# Index page
# ---------------------------------------------------------------------------

def test_parse_managers_keeps_case_sensitive_codes():
    page = ('<a href="holdings.php?m=psc">Bill Ackman - Pershing Square</a>'
            '<a href="holdings.php?m=BRK">Warren Buffett - Berkshire Hathaway</a>'
            '<a href="holdings.php?m=psc">Bill Ackman - Pershing Square</a>')
    mgrs = parse_managers(page)
    assert {m["code"] for m in mgrs} == {"psc", "BRK"}
    assert len(mgrs) == 2, "duplicate links must collapse"


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def test_modal_quarter_ignores_delinquent_filers():
    """One manager stuck on an old quarter must not relabel the dataset."""
    meta = [{"quarter": "Q2 2026"}] * 80 + [
        {"quarter": "Q1 2026"}, {"quarter": "Q3 2025"}, {"quarter": "Q4 2025"}]
    assert modal_quarter(meta) == "Q2 2026"


def test_stale_managers_do_not_contribute_rows():
    meta = [{"code": "AA", "quarter": "Q2 2026"},
            {"code": "BB", "quarter": "Q2 2026"},
            {"code": "OLD", "quarter": "Q4 2025"}]
    rows = [
        {"code": "AA", "ticker": "X", "company": "X Co", "action": "Buy",
         "pct_move": None, "shares": 100, "pct_port": 1.0},
        {"code": "BB", "ticker": "X", "company": "X Co", "action": "Reduce",
         "pct_move": 5.0, "shares": 40, "pct_port": 0.5},
        {"code": "OLD", "ticker": "X", "company": "X Co", "action": "Sell",
         "pct_move": 100.0, "shares": 9_999, "pct_port": 2.0},
    ]
    ds = build_dataset(meta, rows)
    flow = ds["flows"]["X"]
    assert flow["sell"] == 0, "a Q4 2025 exit leaked into the Q2 2026 totals"
    assert flow["net_shares"] == 60
    assert flow["net_heads"] == 2 * 1 + 0 - 1 - 0


def test_heads_and_shares_can_disagree():
    """The Alphabet case: a crowd trims, one giant accumulates.

    If these two ever get collapsed into a single sentiment score, this is the
    row that would be reported backwards.
    """
    meta = [{"code": f"S{i}", "quarter": "Q2 2026"} for i in range(5)]
    meta.append({"code": "BIG", "quarter": "Q2 2026"})
    rows = [{"code": f"S{i}", "ticker": "GOOGL", "company": "Alphabet Inc.",
             "action": "Reduce", "pct_move": 10.0, "shares": 1_000,
             "pct_port": 0.5} for i in range(5)]
    rows.append({"code": "BIG", "ticker": "GOOGL", "company": "Alphabet Inc.",
                 "action": "Add", "pct_move": 658.0, "shares": 50_000,
                 "pct_port": 3.0})
    flow = build_dataset(meta, rows)["flows"]["GOOGL"]
    assert flow["net_heads"] == -4        # crowd wins on head count
    assert flow["net_shares"] == 45_000   # giant wins on shares
    assert flow["net_heads"] < 0 < flow["net_shares"]


def test_actors_are_ordered_buy_add_reduce_sell():
    meta = [{"code": c, "quarter": "Q2 2026"} for c in ("A", "B", "C", "D")]
    rows = [{"code": c, "ticker": "T", "company": "T Co", "action": act,
             "pct_move": None, "shares": 1, "pct_port": 1.0}
            for c, act in zip("ABCD", ("Sell", "Reduce", "Add", "Buy"))]
    actors = build_dataset(meta, rows)["flows"]["T"]["actors"]
    assert [a["action"] for a in actors] == ["Buy", "Add", "Reduce", "Sell"]


# ---------------------------------------------------------------------------
# 13F calendar
# ---------------------------------------------------------------------------

def test_quarter_end_labels():
    assert quarter_end("Q2 2026") == date(2026, 6, 30)
    assert quarter_end("Q4 2025") == date(2025, 12, 31)
    assert quarter_end("nonsense") is None


@pytest.mark.parametrize("reported, expected", [
    # Reported Q2 2026 → next filing is Q3 2026, due Sat 2026-11-14 → Mon 16.
    (date(2026, 6, 30), date(2026, 11, 16)),
    # Q3 2026 → Q4 2026, due Sun 2027-02-14; Mon 02-15 is Presidents' Day
    # (3rd Monday), so it rolls to Tuesday.
    (date(2026, 9, 30), date(2027, 2, 16)),
    # Q4 2026 → Q1 2027, due Sat 2027-05-15 → Mon 17.
    (date(2026, 12, 31), date(2027, 5, 17)),
])
def test_next_deadline_rolls_off_weekends_and_holidays(reported, expected):
    got = next_13f_deadline(reported)
    assert got == expected
    assert got.weekday() < 5


def test_next_deadline_is_none_without_a_quarter():
    assert next_13f_deadline(None) is None


def test_deadline_matches_edgar_for_a_weekday_case():
    """Q1 2026 → Q2 2026 was due Fri 2026-08-14 and that is exactly the day
    Berkshire, Lone Pine, Southeastern and Bridgewater all filed."""
    assert next_13f_deadline(date(2026, 3, 31)) == date(2026, 8, 14)
