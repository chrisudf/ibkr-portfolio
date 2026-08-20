# -*- coding: utf-8 -*-
"""Parser regression tests.

Each test pins one bug that was found by review (see lesson.md for the ones
found earlier by hand) — the fixtures are synthetic Flex / Activity CSVs
shaped like real IBKR output. Run with:

    pip install -r requirements-dev.txt
    python -m pytest tests/ -q
"""
from __future__ import annotations

import csv
import io
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parser.ibkr_csv import _parse_option_symbol  # noqa: E402
from parser.ibkr_flex_csv import parse_ibkr_flex_csv  # noqa: E402


# ---------------------------------------------------------------------------
# Flex CSV fixture builder: every section is a header row starting with
# ClientAccountID followed by data rows, exactly like Flex Web Service output.
# ---------------------------------------------------------------------------

ACCT = "U1234567"

PNL_HDR = ["ClientAccountID", "TWR", "StartingValue", "EndingValue", "FromDate", "ToDate"]
NAV_HDR = ["ClientAccountID", "Cash", "Stock", "Options", "Total", "ReportDate", "DividendAccruals"]
POS_HDR = ["ClientAccountID", "PositionValue", "MarkPrice", "Quantity", "CostBasisMoney",
           "AssetClass", "Symbol", "CostBasisPrice", "FifoPnlUnrealized", "Multiplier",
           "UnderlyingSymbol", "Expiry", "Strike", "Put/Call", "Description"]
CASH_HDR = ["ClientAccountID", "Type", "Amount", "SettleDate", "Symbol", "Description",
            "CurrencyPrimary", "DividendType"]
CASH_HDR_TXN = CASH_HDR + ["TransactionID"]
SOF_HDR = ["ClientAccountID", "ActivityCode", "ActivityDescription", "Amount", "Balance",
           "Date", "Symbol", "CurrencyPrimary", "AssetClass", "TradeQuantity",
           "TradePrice", "TradeCommission"]


def _csv(sections: list[tuple[list[str], list[list[str]]]]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    for header, rows in sections:
        w.writerow(header)
        for r in rows:
            w.writerow(r)
    return buf.getvalue()


def _pnl(from_d="20250820", to_d="20260819"):
    return (PNL_HDR, [[ACCT, "", "100000", "120000", from_d, to_d]])


def _nav(cash=10000, stock=50000):
    total = cash + stock
    return (NAV_HDR, [[ACCT, str(cash), str(stock), "0", str(total), "20260819", "0"]])


def _stock_pos(symbol, qty, cost_basis, mark=100.0):
    return [ACCT, str(qty * mark), str(mark), str(qty), str(cost_basis),
            "STK", symbol, str(cost_basis / qty if qty else 0), "0", "",
            "", "", "", "", ""]


def _cash_div(amount, desc, sym="", ccy="USD", div_type="Ordinary Dividend",
              typ="Dividends", date="20260310", txn=None):
    row = [ACCT, typ, str(amount), date, sym, desc, ccy,
           div_type if typ != "Withholding Tax" else ""]
    if txn is not None:
        row.append(txn)
    return row


def _sof_trade(symbol, qty, price, commission, date):
    return [ACCT, "BUY" if qty > 0 else "SELL", f"{symbol} trade", "0", "0",
            date, symbol, "USD", "STK", str(qty), str(price), str(commission)]


def _sof_div(amount, desc, sym, date="20260310", code="DIV"):
    return [ACCT, code, desc, str(amount), "0", date, sym, "USD", "", "", "", ""]


def parse(sections):
    return parse_ibkr_flex_csv(_csv(sections))["accounts"][ACCT]


def div_row(acct, symbol):
    return next(s for s in acct["dividends"]["by_symbol"] if s["symbol"] == symbol)


# ---------------------------------------------------------------------------
# Dividend reversals: negative-amount corrections must net the per-share sum
# out, not add the printed rate a second time.
# ---------------------------------------------------------------------------

def test_reversal_nets_per_share_out():
    desc25 = "SGOV(US46436E7186) Cash Dividend USD 0.25 per Share (Ordinary Dividend)"
    desc26 = "SGOV(US46436E7186) Cash Dividend USD 0.26 per Share (Ordinary Dividend)"
    acct = parse([
        _pnl(), _nav(),
        (CASH_HDR_TXN, [
            _cash_div(25.00, desc25, sym="SGOV", txn="t1"),
            _cash_div(-25.00, desc25, sym="SGOV", date="20260311", txn="t2"),
            _cash_div(26.00, desc26, sym="SGOV", date="20260311", txn="t3"),
        ]),
    ])
    s = div_row(acct, "SGOV")
    assert abs(acct["dividends"]["gross"] - 26.00) < 1e-9
    assert abs(s["per_share"] - 0.26) < 1e-9  # was 0.76 before the fix
    assert s["rate_missing"] == 0


# ---------------------------------------------------------------------------
# Synthetic dedupe keys (query without TransactionID): identical legitimate
# rows must both survive, and DIV / PIL of the same amount must not collide.
# ---------------------------------------------------------------------------

def test_synth_key_keeps_rebooked_payout():
    desc = "SGOV(US46436E7186) Cash Dividend USD 0.25 per Share (Ordinary Dividend)"
    acct = parse([
        _pnl(), _nav(),
        (CASH_HDR, [
            _cash_div(25.00, desc, sym="SGOV"),
            _cash_div(-25.00, desc, sym="SGOV"),
            _cash_div(25.00, desc, sym="SGOV"),  # re-booked at the same amount
        ]),
    ])
    assert abs(acct["dividends"]["gross"] - 25.00) < 1e-9  # was 0.00 before


def test_synth_key_separates_div_and_pil():
    desc = "ETHU(US00000000) Cash Dividend USD 0.10 per Share (Ordinary Dividend)"
    acct = parse([
        _pnl(), _nav(),
        (CASH_HDR, [
            _cash_div(10.00, desc, sym="ETHU"),
            _cash_div(10.00, "PAYMENT IN LIEU OF DIVIDEND", sym="ETHU",
                      typ="Payment In Lieu Of Dividends"),
        ]),
    ])
    assert abs(acct["dividends"]["gross"] - 20.00) < 1e-9


# ---------------------------------------------------------------------------
# Buy-and-hold with zero period trades: the steadiest dividend position must
# still get a deployed window and an average size.
# ---------------------------------------------------------------------------

def test_untraded_open_position_gets_seeded():
    acct = parse([
        _pnl(), _nav(),
        (POS_HDR, [_stock_pos("MSFT", 100, 30000)]),
        (CASH_HDR, [_cash_div(83.00, "MSFT(US5949181045) Cash Dividend USD 0.83"
                              " per Share (Ordinary Dividend)", sym="MSFT")]),
        # SoF present (an unrelated trade) — "MSFT has no trade rows" is only
        # meaningful evidence of buy-and-hold when trade rows were collected.
        (SOF_HDR, [_sof_trade("NVDA", 1, 100.0, -1.0, "20260301")]),
    ])
    h = acct["cost_history"]["MSFT"]
    assert h["days"] == 364
    assert abs(h["avg_shares"] - 100) < 1e-9
    assert h["covered"] is False        # avg_price 0 must never be used as cost
    assert h["pre_existing"] is True


def test_no_sof_section_means_no_seeding():
    # Without Statement of Funds the parser can't tell buy-and-hold from a
    # mid-window purchase — seeding would stamp the latter as deployed all
    # year and understate its annualized yield ~6x.
    acct = parse([
        _pnl(), _nav(),
        (POS_HDR, [_stock_pos("MSFT", 100, 30000)]),
        (CASH_HDR, [_cash_div(83.00, "MSFT(US5949181045) Cash Dividend USD 0.83"
                              " per Share (Ordinary Dividend)", sym="MSFT")]),
    ])
    assert acct["cost_history"] == {}


# ---------------------------------------------------------------------------
# Forward split mid-window: IBKR's own cost basis proves nothing predates the
# window, so the phantom "pre-existing shares" must not be integrated.
# ---------------------------------------------------------------------------

def test_split_suppresses_time_stats():
    acct = parse([
        _pnl(), _nav(),
        # Bought 10 @ 100 (+1 commission) mid-window; a 4:1 split later means
        # Open Positions shows 40 shares whose CostBasisMoney is still 1001.
        (POS_HDR, [_stock_pos("NVDL", 40, 1001, mark=27.0)]),
        (SOF_HDR, [_sof_trade("NVDL", 10, 100.0, -1.0, "20260301")]),
    ])
    h = acct["cost_history"]["NVDL"]
    assert h.get("split_suspect") is True
    assert h["days"] == 0               # was 364 (true deployment: 171 days)
    assert h["avg_shares"] == 0.0       # was ~34.7 phantom shares


def test_genuine_pre_existing_not_flagged():
    acct = parse([
        _pnl(), _nav(),
        # Held 15, bought 5 of them in-window: cost basis (2000) far exceeds
        # the window buys (501), so this really did predate the statement.
        (POS_HDR, [_stock_pos("MSFT", 15, 2000, mark=140.0)]),
        (SOF_HDR, [_sof_trade("MSFT", 5, 100.0, -1.0, "20260301")]),
    ])
    h = acct["cost_history"]["MSFT"]
    assert h.get("split_suspect") is None
    assert h["pre_existing"] is True
    assert h["days"] == 364
    assert h["avg_shares"] > 10


# ---------------------------------------------------------------------------
# Statement-of-Funds-only queries: income class must come from the
# description when the DividendType column doesn't exist.
# ---------------------------------------------------------------------------

def test_sof_income_class_from_description():
    acct = parse([
        _pnl(), _nav(),
        (SOF_HDR, [
            _sof_div(50.00, "METU(US25461A1088) Cash Dividend USD 0.50 per Share"
                     " (Short Term Capital Gain)", "METU"),
            _sof_div(10.00, "METU(US25461A1088) Cash Dividend USD 0.10 per Share"
                     " (Ordinary Dividend)", "METU", date="20260610"),
        ]),
    ])
    s = div_row(acct, "METU")
    assert abs(s["non_dividend"] - 50.00) < 1e-9     # was 0 before the fix
    assert abs(s["per_share_ordinary"] - 0.10) < 1e-9
    assert abs(acct["dividends"]["non_dividend"] - 50.00) < 1e-9


# ---------------------------------------------------------------------------
# Class-share tickers: "BRK B(...)" must parse, and its withholding must not
# be discarded by the unattributed-tax guard.
# ---------------------------------------------------------------------------

def test_class_share_ticker_and_withholding():
    acct = parse([
        _pnl(), _nav(),
        (CASH_HDR, [
            _cash_div(200.00, "BRK B(US0846707026) Cash Dividend USD 2.00 per"
                      " Share (Ordinary Dividend)"),
            _cash_div(-30.00, "BRK B(US0846707026) Cash Dividend USD 2.00 per"
                      " Share - US Tax", typ="Withholding Tax"),
        ]),
    ])
    s = div_row(acct, "BRK B")
    assert abs(s["gross"] - 200.00) < 1e-9
    assert abs(s["tax"] - (-30.00)) < 1e-9           # was dropped before
    assert all(x["symbol"] != "—" for x in acct["dividends"]["by_symbol"])


def test_interest_withholding_still_skipped():
    acct = parse([
        _pnl(), _nav(),
        (CASH_HDR, [
            _cash_div(100.00, "MSFT(US5949181045) Cash Dividend USD 1.00 per"
                      " Share (Ordinary Dividend)", sym="MSFT"),
            _cash_div(-9.15, "WITHHOLDING @ 10% ON CREDIT INT FOR NOV-2025",
                      typ="Withholding Tax"),
        ]),
    ])
    assert abs(acct["dividends"]["tax"] - 0.0) < 1e-9


# ---------------------------------------------------------------------------
# Multi-currency payouts: never summed at 1:1 into the base totals.
# ---------------------------------------------------------------------------

def test_foreign_currency_segregated():
    acct = parse([
        _pnl(), _nav(),
        (CASH_HDR, [
            _cash_div(100.00, "MSFT(US5949181045) Cash Dividend USD 1.00 per"
                      " Share (Ordinary Dividend)", sym="MSFT"),
            _cash_div(50.00, "SGOV(US46436E7186) Cash Dividend USD 0.25 per"
                      " Share (Ordinary Dividend)", sym="SGOV", date="20260501"),
            # Nominally larger than every USD payment — the base pick goes by
            # payment count, so one big foreign payout must not flip it.
            _cash_div(780.00, "0005(HK0005000000) Cash Dividend HKD 2.00 per"
                      " Share (Ordinary Dividend)", sym="0005", ccy="HKD",
                      date="20260401"),
        ]),
    ])
    d = acct["dividends"]
    assert d["base_currency"] == "USD"
    assert abs(d["gross"] - 150.00) < 1e-9           # was 930 before the fix
    assert abs(d["foreign"]["HKD"]["gross"] - 780.00) < 1e-9
    assert all(s["symbol"] != "0005" for s in d["by_symbol"])


def test_reversal_churn_does_not_flip_base_currency():
    hk = "0005(HK0005000000) Cash Dividend HKD 2.00 per Share (Ordinary Dividend)"
    acct = parse([
        _pnl(), _nav(),
        (CASH_HDR, [
            _cash_div(100.00, "MSFT(US5949181045) Cash Dividend USD 1.00 per"
                      " Share (Ordinary Dividend)", sym="MSFT"),
            _cash_div(50.00, "SGOV(US46436E7186) Cash Dividend USD 0.25 per"
                      " Share (Ordinary Dividend)", sym="SGOV", date="20260501"),
            # One HKD payout corrected in-period = 3 rows, but only 2 are
            # payments — must not out-vote the 2 clean USD payments.
            _cash_div(780.00, hk, sym="0005", ccy="HKD", date="20260401"),
            _cash_div(-780.00, hk, sym="0005", ccy="HKD", date="20260402"),
            _cash_div(780.00, hk, sym="0005", ccy="HKD", date="20260402"),
        ]),
    ])
    d = acct["dividends"]
    assert d["base_currency"] == "USD"
    assert abs(d["gross"] - 150.00) < 1e-9
    assert abs(d["foreign"]["HKD"]["gross"] - 780.00) < 1e-9


# ---------------------------------------------------------------------------
# Option positions carry their own multiplier.
# ---------------------------------------------------------------------------

def test_option_multiplier_ingested():
    pos = [ACCT, "-500", "5", "-1", "-450", "OPT", "XSP 19DEC25 500 P", "4.5",
           "-50", "10", "XSP", "20251219", "500", "P", "XSP 19DEC25 500 P"]
    acct = parse([_pnl(), _nav(), (POS_HDR, [pos])])
    assert acct["options"][0]["multiplier"] == 10.0

    pos_std = pos.copy()
    pos_std[9] = ""  # Multiplier column blank → default 100
    acct = parse([_pnl(), _nav(), (POS_HDR, [pos_std])])
    assert acct["options"][0]["multiplier"] == 100.0


# ---------------------------------------------------------------------------
# Activity-Statement option symbols: adjusted contracts and class shares.
# ---------------------------------------------------------------------------

def test_adjusted_option_symbols_parse():
    assert _parse_option_symbol("COHR1 17OCT25 85 P") == {
        "underlying": "COHR1", "expiry": "17OCT25", "strike": 85.0, "right": "P"}
    assert _parse_option_symbol("BRK B 17OCT25 85 P")["underlying"] == "BRK B"
    assert _parse_option_symbol("NVDA 17JUL26 155 P")["underlying"] == "NVDA"
    assert _parse_option_symbol("not an option") is None


# ---------------------------------------------------------------------------
# Row-order invariance (lesson 2's method): shuffling data rows within every
# section must not change any aggregate.
# ---------------------------------------------------------------------------

def _full_statement_sections():
    nav_rows = [[ACCT, str(10000 + i), "50000", "0", str(60000 + i),
                 f"202608{10 + i:02d}", "0"] for i in range(5)]
    return [
        _pnl(),
        (NAV_HDR, nav_rows),
        (POS_HDR, [_stock_pos("MSFT", 100, 30000)]),
        (CASH_HDR, [
            _cash_div(83.00, "MSFT(US5949181045) Cash Dividend USD 0.83 per"
                      " Share (Ordinary Dividend)", sym="MSFT"),
            _cash_div(-12.45, "MSFT(US5949181045) Cash Dividend USD 0.83 per"
                      " Share - US Tax", sym="MSFT", typ="Withholding Tax"),
            _cash_div(25.00, "SGOV(US46436E7186) Cash Dividend USD 0.25 per"
                      " Share (Ordinary Dividend)", sym="SGOV", date="20260501"),
        ]),
        (SOF_HDR, [
            _sof_trade("NVDA", 10, 100.0, -1.0, "20260301"),
            _sof_trade("NVDA", -10, 120.0, -1.0, "20260601"),
        ]),
    ]


def test_row_order_invariance():
    base = parse(_full_statement_sections())
    shuffled = _full_statement_sections()
    rng = random.Random(42)
    shuffled = [(hdr, rng.sample(rows, len(rows))) for hdr, rows in shuffled]
    other = parse(shuffled)

    assert base["nav"] == other["nav"]
    for k in ("gross", "tax", "net", "non_dividend", "base_currency"):
        assert base["dividends"][k] == other["dividends"][k]
    assert base["dividends"]["by_symbol"] == other["dividends"]["by_symbol"]
    assert base["cost_history"] == other["cost_history"]


# ---------------------------------------------------------------------------
# Upload route: a statement that parses to zero accounts must fail loudly.
# ---------------------------------------------------------------------------

def test_upload_zero_accounts_rejected():
    from app import app as flask_app
    client = flask_app.test_client()
    body = '"ClientAccountID","SomeCol","Other"\n"","x","y"\n'
    resp = client.post("/api/upload", data={
        "file": (io.BytesIO(body.encode()), "statement.csv"),
    })
    assert resp.status_code == 400
    assert "error" in resp.get_json()
