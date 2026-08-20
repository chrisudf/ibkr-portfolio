"""Parse IBKR Flex Web Service CSV output (multi-section, multi-account).

Different format from the manually-downloaded Activity Statement CSV
(see ibkr_csv.py). Here every section is a flat quoted-CSV table; the
section's identity is inferred from the column signature, and rows
group naturally by ClientAccountID.

Public entry point: parse_ibkr_flex_csv(content) -> dict
"""
from __future__ import annotations

import csv
import io
import re
from collections import defaultdict
from datetime import date
from typing import Any

from .returns import compute_account_returns


def _to_float(v: str) -> float:
    if v is None or v == "":
        return 0.0
    try:
        return float(v)
    except ValueError:
        return 0.0


def _fmt_iso_date(yyyymmdd: str) -> str:
    """`20260619` → `2026-06-19`. Passes anything else through unchanged."""
    if yyyymmdd and len(yyyymmdd) == 8 and yyyymmdd.isdigit():
        return f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:]}"
    return yyyymmdd or ""


def _fmt_expiry(yyyymmdd: str) -> str:
    """Convert IBKR's `20270115` to dashboard-friendly `15JAN27`."""
    if not yyyymmdd or len(yyyymmdd) != 8:
        return yyyymmdd or ""
    months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
    try:
        y, m, d = yyyymmdd[:4], int(yyyymmdd[4:6]), yyyymmdd[6:]
        return f"{int(d)}{months[m - 1]}{y[2:]}"
    except (ValueError, IndexError):
        return yyyymmdd


def _classify_section(header: list[str]) -> str:
    cols = set(header)
    n = len(header)
    if n == 1 and "ClientAccountID" in cols:
        return "AccountList"
    if {"Cash", "Stock", "Options", "Total", "ReportDate"} <= cols:
        return "NAV"
    if {"RealizedShortTermProfit", "UnrealizedProfit", "Symbol", "AssetClass"} <= cols:
        return "MTMPerformance"
    if "StartingCash" in cols and "EndingCash" in cols:
        return "ChangeInNAV"
    # The "MTM Performance Summary in Base" / "Profit & Loss" section that
    # ships TWR alongside FromDate/ToDate, StartingValue and EndingValue.
    if {"TWR", "StartingValue", "EndingValue", "FromDate", "ToDate"} <= cols:
        return "PnLSummary"
    if {"PositionValue", "MarkPrice", "Quantity", "CostBasisMoney"} <= cols:
        return "OpenPositions"
    if {"TradeDate", "TradePrice"} <= cols or "OrigTradePrice" in cols:
        return "Trades"
    if {"ActivityCode", "Amount", "Balance"} <= cols:
        return "StatementOfFunds"
    # Cash Transactions carries the same Amount column but no running Balance;
    # what identifies it is Type ("Dividends", "Withholding Tax", ...) next to
    # a date. Either date column will do — the section is configurable and a
    # query that ships DateTime but not SettleDate is still perfectly usable,
    # so don't make one optional column decide whether we recognise it at all.
    if {"Type", "Amount"} <= cols and cols & {"SettleDate", "Date/Time", "DateTime"}:
        return "CashTransactions"
    return "Unknown"


def _empty_account() -> dict[str, Any]:
    return {
        "account": {},
        "statement": {},
        "nav": {"cash": 0.0, "stock": 0.0, "options": 0.0, "dividend_accruals": 0.0, "total": 0.0, "twr": 0.0},
        "stocks": [],
        "options": [],
        "options_by_underlying": {},
        "performance": {"realized_total": 0.0, "unrealized_total": 0.0, "by_symbol": {}},
        "cash_flows": [],   # persisted ledger: one id-keyed entry per external flow
        "dividends": {},    # aggregated payout summary, built in finalize
        # Per-symbol buy/sell tallies rebuilt from Statement of Funds trade
        # rows, so a position closed during the period still has a cost to
        # divide a dividend by. Open Positions only describes what you still
        # hold; this covers what you held and sold.
        "cost_history": {},
        "_cash_flows": [],  # raw (date, amount) for IRR; stripped before serialising
        "_cf_ids": set(),   # flow ids already ingested this parse; stripped
        "_cf_synth_seq": {},  # composite-key occurrence counter; stripped
        # Dividend rows land in one bucket per source section; finalize picks a
        # single winner so a query carrying both doesn't double-count.
        "_div_cash": [],    # from Cash Transactions
        "_div_sof": [],     # from Statement of Funds
        "_div_ids": set(),
        "_div_synth_seq": {},  # synth-key occurrence counter, like _cf_synth_seq
        "_sof_seen": False,  # any Statement of Funds row ingested; stripped
        "_nav_date": "",   # latest ReportDate seen in the NAV series; stripped
        "_starting_cash": 0.0,
        "_from_date": "",
        "_to_date": "",
    }


def _parse_date(yyyymmdd: str) -> date | None:
    if not yyyymmdd or len(yyyymmdd) != 8 or not yyyymmdd.isdigit():
        return None
    try:
        return date(int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:]))
    except ValueError:
        return None


def _section_rows(content: str) -> list[tuple[list[str], list[list[str]]]]:
    """Split the CSV into (header, data_rows) sections.

    Each time the first column of a row is the literal "ClientAccountID"
    we treat that row as a new section header. The lines that follow,
    until the next such header, belong to that section.
    """
    sections: list[tuple[list[str], list[list[str]]]] = []
    current: tuple[list[str], list[list[str]]] | None = None
    reader = csv.reader(io.StringIO(content))
    for row in reader:
        if not row:
            continue
        if row[0] == "ClientAccountID":
            if current is not None:
                sections.append(current)
            current = (row, [])
        elif current is not None:
            # Pad/truncate rows so dict-zipping is safe even on malformed lines
            header, rows = current
            if len(row) < len(header):
                row = row + [""] * (len(header) - len(row))
            rows.append(row)
    if current is not None:
        sections.append(current)
    return sections


def _ingest_nav(account: dict[str, Any], row: dict[str, str]) -> None:
    """Take the NAV snapshot for the latest ReportDate we've seen.

    This section is a *daily series* — a 365-day query ships ~262 rows per
    account, one per trading day. Last-row-wins would work only while IBKR
    keeps emitting them in ascending date order; if that ever flipped, the
    dashboard would quietly render a year-old NAV and every percentage on the
    page would be wrong with nothing to show for it. Compare dates instead.
    """
    nav = account["nav"]
    rd = row.get("ReportDate", "")
    seen = account.get("_nav_date", "")
    if rd and seen and rd < seen:
        return
    nav["cash"] = _to_float(row.get("Cash"))
    nav["stock"] = _to_float(row.get("Stock"))
    nav["options"] = _to_float(row.get("Options"))
    nav["dividend_accruals"] = _to_float(row.get("DividendAccruals"))
    nav["total"] = _to_float(row.get("Total"))
    if rd:
        account["_nav_date"] = rd
        # Keep the most recent report date around as a fallback period.
        account["statement"]["_report_date"] = _fmt_iso_date(rd)


def _ingest_position(account: dict[str, Any], row: dict[str, str]) -> None:
    asset = row.get("AssetClass", "")
    qty = _to_float(row.get("Quantity"))
    if asset == "STK":
        account["stocks"].append({
            "symbol": row.get("Symbol", ""),
            "quantity": qty,
            "cost_price": _to_float(row.get("CostBasisPrice")),
            "close_price": _to_float(row.get("MarkPrice")),
            "cost_basis": _to_float(row.get("CostBasisMoney")),
            "value": _to_float(row.get("PositionValue")),
            "unrealized_pl": _to_float(row.get("FifoPnlUnrealized")),
        })
    elif asset == "OPT":
        underlying = row.get("UnderlyingSymbol") or row.get("Symbol", "")
        # Prefer the human description ("COIN 15JAN27 240 C") if IBKR gave it,
        # otherwise synthesise one from the structured columns.
        desc = (row.get("Description") or "").strip()
        if not desc:
            desc = " ".join(filter(None, [
                underlying,
                _fmt_expiry(row.get("Expiry", "")),
                (row.get("Strike", "") or "").rstrip("0").rstrip("."),
                row.get("Put/Call", ""),
            ]))
        account["options"].append({
            "symbol": desc,
            "underlying": underlying,
            "expiry": _fmt_expiry(row.get("Expiry", "")),
            "strike": _to_float(row.get("Strike")),
            "right": row.get("Put/Call", ""),
            # Deliverable per contract. 100 for standard US equity options,
            # something else after corporate-action adjustments — the margin
            # math scales by it, so don't let the frontend hard-code 100.
            "multiplier": _to_float(row.get("Multiplier")) or 100.0,
            "quantity": qty,
            "cost_price": _to_float(row.get("CostBasisPrice")),
            "close_price": _to_float(row.get("MarkPrice")),
            "cost_basis": _to_float(row.get("CostBasisMoney")),
            "value": _to_float(row.get("PositionValue")),
            "unrealized_pl": _to_float(row.get("FifoPnlUnrealized")),
        })


def _ingest_performance(account: dict[str, Any], row: dict[str, str]) -> None:
    sym = row.get("Symbol", "")
    if not sym:
        return
    asset = row.get("AssetClass", "")
    realized = _to_float(row.get("TotalRealizedPnl"))
    unrealized = _to_float(row.get("TotalUnrealizedPnl"))
    # Map IBKR's compact asset codes back to the labels the dashboard expects.
    cat_map = {"STK": "Stocks", "OPT": "Equity and Index Options"}
    category = cat_map.get(asset, asset)
    # Options performance rows are per-contract; key by the full description
    # so multiple contracts on the same underlying don't collide.
    if asset == "OPT":
        sym = (row.get("Description") or sym).strip()
    bucket = account["performance"]["by_symbol"].setdefault(sym, {
        "realized_total": 0.0,
        "unrealized_total": 0.0,
        "total": 0.0,
        "asset_category": category,
    })
    bucket["realized_total"] += realized
    bucket["unrealized_total"] += unrealized
    bucket["total"] = bucket["realized_total"] + bucket["unrealized_total"]
    account["performance"]["realized_total"] += realized
    account["performance"]["unrealized_total"] += unrealized


def _ingest_pnl_summary(account: dict[str, Any], row: dict[str, str]) -> None:
    """The PnL summary section is the goldmine: it carries IBKR's official
    TWR plus the canonical period bookends. Always prefer this over the
    ChangeInNAV-derived fallback values."""
    twr = row.get("TWR", "")
    if twr:
        try:
            account["nav"]["twr"] = float(twr) / 100.0
        except ValueError:
            pass
    from_d, to_d = row.get("FromDate"), row.get("ToDate")
    if from_d and to_d:
        account["statement"]["Period"] = f"{_fmt_iso_date(from_d)} → {_fmt_iso_date(to_d)}"
        account["_from_date"] = from_d
        account["_to_date"] = to_d
    starting = _to_float(row.get("StartingValue"))
    if starting:
        account["_starting_cash"] = starting


def _ingest_change_in_nav(account: dict[str, Any], row: dict[str, str]) -> None:
    twr = row.get("TWR") or row.get("TimeWeightedReturn")
    if twr:
        try:
            account["nav"]["twr"] = float(twr) / 100.0
        except ValueError:
            pass
    from_d, to_d = row.get("FromDate"), row.get("ToDate")
    if from_d and to_d:
        account["statement"]["Period"] = f"{_fmt_iso_date(from_d)} → {_fmt_iso_date(to_d)}"
        account["_from_date"] = from_d
        account["_to_date"] = to_d
    starting_cash = _to_float(row.get("StartingCash"))
    if starting_cash:
        account["_starting_cash"] = starting_cash


# IBKR Activity codes that represent external investor cash flows.
# Anything else (BUY/SELL/FOREX/DIV/CINT/FRTAX/...) is internal to the
# account and must NOT enter the IRR series.
_EXTERNAL_CF_CODES = {"DEP", "WITH", "BWT", "DPI", "WTI"}


# IBKR's own per-row unique key for Statement of Funds. The exact spelling
# has drifted between Flex versions, so try the known ones in order rather
# than betting on a single string.
_TXN_ID_COLUMNS = ("TransactionID", "TransactionId", "TransactionID(Trade)")


def _cash_flow_id(account: dict[str, Any], row: dict[str, str], d: date,
                  code: str, amount: float) -> str:
    """Stable identity for one cash-flow row, so overlapping statements can
    be deduped instead of double-counted.

    Prefers IBKR's TransactionID (prefixed `txn:`). If the Flex query wasn't
    configured to include that column we synthesise a composite key
    (prefixed `synth:`) from date+code+amount, plus an occurrence ordinal —
    two identical deposits on the same day are otherwise indistinguishable,
    and silently collapsing them would understate deposits and overstate IRR.

    The prefix is deliberately visible in the saved JSON: if you ever see
    `synth:` in uploads/*.json, add "Transaction ID" to the Flex query's
    Statement of Funds column list and the ids become reliable. The ordinal
    is only stable when both statements cover that whole day, so a merge
    across a mid-day boundary can still mis-key `synth:` rows.
    """
    for col in _TXN_ID_COLUMNS:
        txn = (row.get(col) or "").strip()
        if txn:
            return f"txn:{txn}"
    base = f"{d.isoformat()}|{code}|{amount:.2f}"
    seq = account["_cf_synth_seq"].get(base, 0) + 1
    account["_cf_synth_seq"][base] = seq
    return f"synth:{base}|{seq}"


# --- Dividends -------------------------------------------------------------
#
# Two Flex sections can carry payouts and a query may enable either or both:
#
#   Cash Transactions  → Type = "Dividends" / "Payment In Lieu Of Dividends"
#                        / "Withholding Tax"
#   Statement of Funds → ActivityCode = DIV / PIL / FRTAX
#
# They describe the same money, so ingesting both would double every payout.
# Each source fills its own bucket during the row scan and `_finalize_dividends`
# picks exactly one. Cash Transactions wins when present: it is the section
# purpose-built for this and always carries a Symbol, whereas Statement of
# Funds rows occasionally settle a payout against a blank symbol.

_DIV_GROSS_CODES = {"DIV", "PIL"}
_DIV_TAX_CODES = {"FRTAX"}

_DIV_CASH_TYPES = {
    "dividends": "gross",
    "payment in lieu of dividends": "gross",
    "withholding tax": "tax",
}

# "MSFT(US5949181045) Cash Dividend USD 0.83 per Share" → MSFT. Used only when
# the row itself has no Symbol column filled in. Class shares are spelled with
# a space ("BRK B(US0846707026) ..."), so allow one trailing class letter —
# without it the match fails outright and the withholding row behind it gets
# discarded by the unattributed-tax guard.
_DIV_SYMBOL_RE = re.compile(r"^([A-Z][A-Z0-9\.]{0,9}(?: [A-Z])?)\s*\(")

# ...and the rate out of the same string: "USD 0.346643 PER SHARE" → 0.346643.
# Case-insensitive because live Flex output shouts it while the docs don't.
# This is what makes a yield-on-cost possible at all: the payment amount alone
# can't be divided by anything meaningful once the position size has changed.
_DIV_RATE_RE = re.compile(r"[A-Z]{3}\s+([\d.]+)\s+PER\s+SHARE", re.I)


def _dividend_rate(row: dict[str, str]) -> float:
    desc = (row.get("Description") or row.get("ActivityDescription") or "")
    m = _DIV_RATE_RE.search(desc)
    if not m:
        return 0.0
    try:
        return float(m.group(1))
    except ValueError:
        return 0.0


def _income_class(div_type: str) -> str:
    """Sort a payout into income vs. something that only looks like income.

    IBKR tags every distribution with a DividendType. Funds routinely pay out
    realized capital gains and return-of-capital through the same cash channel
    as dividends, and a leveraged ETF does it at a scale that swamps the real
    dividend — but neither is yield. Capital gains are the fund handing back
    trading profits; return of capital is your own money coming back, which
    reduces cost basis rather than adding income.

    Unknown or blank types fall through to "ordinary": ordinary dividends are
    the overwhelming majority, and mislabelling a rare exotic as income is a
    smaller error than dropping a real dividend on a spelling we didn't expect.
    """
    t = (div_type or "").lower()
    if "capital gain" in t:
        return "capital_gain"
    if "return of capital" in t:
        return "return_of_capital"
    return "ordinary"


def _dividend_symbol(row: dict[str, str]) -> str:
    """Ticker for a payout row, or "" when the row names no security at all."""
    sym = (row.get("Symbol") or "").strip()
    if sym:
        return sym
    desc = (row.get("Description") or row.get("ActivityDescription") or "").strip()
    m = _DIV_SYMBOL_RE.match(desc)
    return m.group(1) if m else ""


def _skip_unattributed_tax(kind: str, sym: str) -> bool:
    """Withholding that names no security is not dividend withholding.

    IBKR files tax on credit interest under the same "Withholding Tax" type
    (and the same FRTAX activity code) as tax on dividends — e.g. a row reading
    "WITHHOLDING @ 10% ON CREDIT INT FOR NOV-2025" with a blank Symbol. Real
    dividend withholding is always attached to the security that paid it, so a
    tax row with no identifiable ticker belongs to something else and would
    otherwise overstate the dividend tax drag.
    """
    return kind == "tax" and not sym


def _dividend_id(account: dict[str, Any], prefix: str, d: date, sym: str,
                 kind: str, amount: float, row: dict[str, str]) -> str | None:
    """Dedupe key for one payout row; None means "already seen, skip".

    The synthetic fallback mirrors _cash_flow_id: the raw Type/ActivityCode
    goes into the composite so a Dividend and a Payment-In-Lieu of the same
    amount on the same day never collide, and an occurrence ordinal keeps two
    genuinely identical rows apart — without it, a cancel + re-book at the
    identical amount silently drops the re-booked payout and the symbol nets
    to zero for the month.
    """
    for col in _TXN_ID_COLUMNS:
        txn = (row.get(col) or "").strip()
        if txn:
            key = f"{prefix}:txn:{txn}"
            break
    else:
        src = (row.get("Type") or row.get("ActivityCode") or "").strip().lower()
        base = f"{prefix}:{d.isoformat()}|{sym}|{kind}|{src}|{amount:.4f}"
        seq = account["_div_synth_seq"].get(base, 0) + 1
        account["_div_synth_seq"][base] = seq
        key = f"{base}|{seq}"
    if key in account["_div_ids"]:
        return None
    account["_div_ids"].add(key)
    return key


def _ingest_dividend_row(account: dict[str, Any], bucket: str, d: date, sym: str,
                         kind: str, amount: float, row: dict[str, str]) -> None:
    if _dividend_id(account, bucket, d, sym, kind, amount, row) is None:
        return
    # A correction arrives as a negative-amount row whose description still
    # reads "USD 0.25 PER SHARE" — the rate text never flips sign. Sign it by
    # the cash direction so a cancel + re-book nets the per-share sum out to
    # the corrected rate instead of adding every rate it ever printed.
    rate = _dividend_rate(row) if kind == "gross" else 0.0
    desc = (row.get("Description") or row.get("ActivityDescription") or "").strip()
    # DividendType is a Cash Transactions column; Statement of Funds rows
    # never carry it, and classifying every SoF payout as "ordinary" would
    # resurrect the leveraged-ETF bug on any query that enables SoF without
    # Cash Transactions. The description tail states the same fact
    # ("... (Short Term Capital Gain)"), and _income_class only does
    # substring matching — so fall back to the description text.
    account[bucket].append({
        "date": d.isoformat(),
        "symbol": sym,
        "kind": kind,  # "gross" (dividend / payment in lieu) or "tax" (withheld)
        "amount": amount,
        "per_share": rate if amount >= 0 else -rate,
        "income_class": _income_class(row.get("DividendType") or desc) if kind == "gross" else "",
        "currency": (row.get("CurrencyPrimary") or row.get("Currency") or "").strip().upper(),
        "description": desc,
    })


def _ingest_cash_transaction(account: dict[str, Any], row: dict[str, str]) -> None:
    kind = _DIV_CASH_TYPES.get((row.get("Type") or "").strip().lower())
    if kind is None:
        return
    # SettleDate is when the cash actually lands; the ex/pay stamp is the
    # date-time column, which real Flex output spells "Date/Time" and carries a
    # ";HHmmss" suffix. Prefer SettleDate, fall back through both spellings.
    raw = (row.get("SettleDate") or row.get("Date/Time") or row.get("DateTime") or "")[:8]
    d = _parse_date(raw)
    if d is None:
        return
    amount = _to_float(row.get("Amount"))
    if amount == 0:
        return
    sym = _dividend_symbol(row)
    if _skip_unattributed_tax(kind, sym):
        return
    _ingest_dividend_row(account, "_div_cash", d, sym or "—", kind, amount, row)


def _finalize_dividends(account: dict[str, Any]) -> None:
    """Collapse the raw payout rows into the summary the dashboard renders."""
    rows = account["_div_cash"] or account["_div_sof"]
    source = "cash_transactions" if account["_div_cash"] else (
        "statement_of_funds" if account["_div_sof"] else "")
    if not rows:
        account["dividends"] = {}
        return

    # Payouts arrive in the payment currency and nothing here converts FX —
    # a HKD 780 row summed into USD totals at 1:1 would inflate everything
    # ~8x. Rows outside the dominant currency are reported separately rather
    # than silently added; empty currency (query without the column) is
    # treated as base so old exports keep behaving exactly as before.
    # Dominance is by NUMBER of payments, amount only breaks ties: nominal
    # amounts aren't comparable across currencies, and one large foreign
    # payout must not flip which currency the whole panel is denominated in.
    ccy_weight: dict[str, list[float]] = {}
    for r in rows:
        # NET payment count: a reversal cancels one earlier payment, so it
        # votes -1 rather than +1 (or 0). Counting rows would let one
        # corrected foreign payout (original + reversal + re-book = 3 rows,
        # 2 of them positive) tie or out-vote the real base currency and
        # flip the whole panel's denomination on correction churn.
        if r["kind"] == "gross" and r.get("currency"):
            w = ccy_weight.setdefault(r["currency"], [0.0, 0.0])
            w[0] += 1 if r["amount"] > 0 else -1
            if r["amount"] > 0:
                w[1] += r["amount"]  # deterministic tie-break only
    base_ccy = max(ccy_weight, key=lambda c: tuple(ccy_weight[c])) if ccy_weight else ""
    foreign: dict[str, dict[str, float]] = {}
    main_rows: list[dict[str, Any]] = []
    for r in rows:
        c = r.get("currency", "")
        if c and base_ccy and c != base_ccy:
            f = foreign.setdefault(c, {"gross": 0.0, "tax": 0.0, "net": 0.0, "count": 0})
            f[r["kind"]] += r["amount"]
            f["net"] = f["gross"] + f["tax"]
            if r["kind"] == "gross" and r["amount"] > 0:
                f["count"] += 1
        else:
            main_rows.append(r)

    by_symbol: dict[str, dict[str, Any]] = {}
    by_month: dict[str, dict[str, Any]] = {}
    gross = tax = non_dividend_total = 0.0
    for r in main_rows:
        # Withholding arrives as a negative amount; keep IBKR's sign so
        # gross + tax = net falls out without special-casing.
        if r["kind"] == "gross":
            gross += r["amount"]
        else:
            tax += r["amount"]
        s = by_symbol.setdefault(r["symbol"], {
            "symbol": r["symbol"], "gross": 0.0, "tax": 0.0, "net": 0.0,
            "count": 0, "per_share": 0.0, "per_share_ordinary": 0.0,
            "non_dividend": 0.0, "rate_missing": 0, "last_date": "",
        })
        s[r["kind"]] += r["amount"]
        s["net"] = s["gross"] + s["tax"]
        if r["kind"] == "gross":
            # Reversal rows (negative cash) still flow through the per-share
            # and non-dividend sums so a cancel + re-book nets out, but they
            # are not payments: they don't bump the count, and a rate-less
            # reversal isn't a missing PIL rate.
            if r["amount"] > 0:
                s["count"] += 1
            # Per-share rates add up across payments regardless of how the
            # position was sized between them — that's the whole point.
            s["per_share"] += r["per_share"]
            if r.get("income_class", "ordinary") == "ordinary":
                s["per_share_ordinary"] += r["per_share"]
            else:
                # Kept in gross (the cash did arrive) but excluded from yield.
                s["non_dividend"] += r["amount"]
                non_dividend_total += r["amount"]
            if not r["per_share"] and r["amount"] > 0:
                s["rate_missing"] += 1
        s["last_date"] = max(s["last_date"], r["date"])
        m = by_month.setdefault(r["date"][:7], {"month": r["date"][:7], "gross": 0.0, "tax": 0.0, "net": 0.0})
        m[r["kind"]] += r["amount"]
        m["net"] = m["gross"] + m["tax"]

    account["dividends"] = {
        "source": source,
        "gross": gross,
        "tax": tax,
        "net": gross + tax,
        # Portion of gross that is a capital-gain / return-of-capital payout
        # rather than dividend income.
        "non_dividend": non_dividend_total,
        # Which currency the totals are in, and what was left out of them.
        "base_currency": base_ccy,
        "foreign": foreign,
        "by_symbol": sorted(by_symbol.values(), key=lambda x: x["net"], reverse=True),
        "by_month": sorted(by_month.values(), key=lambda x: x["month"]),
        # All rows, foreign included — each carries its currency.
        "events": sorted(rows, key=lambda r: (r["date"], r["symbol"]), reverse=True),
    }


def _ingest_trade_cost(account: dict[str, Any], row: dict[str, str]) -> None:
    """Tally stock buys and sells so closed positions keep a cost per share.

    Only meaningful for a position that ended flat: every share bought was
    also sold, so the average of the buys is the average cost of everything
    that ever passed through. For a position still open this average is wrong
    — round trips leave shares in the tally that are no longer held, which is
    why the dashboard prefers IBKR's own CostBasisPrice whenever it exists and
    falls back here only once the position is gone.

    Verified against IBKR's realized P&L on 14 fully-closed positions: buy
    cost + commissions reproduces `proceeds - TotalRealizedPnl` exactly.
    """
    if row.get("AssetClass") != "STK":
        return
    qty = _to_float(row.get("TradeQuantity"))
    if qty == 0:
        return
    sym = (row.get("Symbol") or "").strip()
    if not sym:
        return
    hist = account["cost_history"].setdefault(sym, {
        "bought_qty": 0.0, "bought_cost": 0.0, "sold_qty": 0.0, "moves": [],
    })
    d = _parse_date(row.get("Date", ""))
    if d is not None:
        # Dated deltas, so finalize can integrate the position over time.
        hist["moves"].append((d, qty))
    if qty > 0:
        hist["bought_qty"] += qty
        hist["bought_cost"] += qty * _to_float(row.get("TradePrice"))
        # Commission belongs in the cost of the shares it bought.
        hist["bought_cost"] += abs(_to_float(row.get("TradeCommission")))
    else:
        hist["sold_qty"] += -qty


def _finalize_cost_history(account: dict[str, Any]) -> None:
    """Reduce the tallies to an average cost, a deployed window and an
    average position size.

    `days` is how long capital was actually in the name *within this
    statement*, which is what an annualized yield has to divide by — a
    position held four months can't have its four-month payouts compared
    against a full-year quote without saying so.

    `avg_shares` integrates the position over that window. It's what makes a
    "did I actually own this on the ex-dates" check possible: multiply it by
    the summed per-share rates and you get what a steady holder of the same
    average size would have collected.
    """
    from_d = _parse_date(account.get("_from_date", ""))
    to_d = _parse_date(account.get("_to_date", ""))
    open_qty = {s["symbol"]: s["quantity"] for s in account["stocks"]}
    cost_basis_now = {s["symbol"]: s.get("cost_basis", 0.0) for s in account["stocks"]}
    out: dict[str, Any] = {}
    for sym, h in account["cost_history"].items():
        bq = h["bought_qty"]
        if bq <= 0:
            continue
        # Buys must cover the sells, otherwise the position was opened before
        # this statement began and the average would be built from a fragment.
        covered = bq >= h["sold_qty"] - 1e-6
        held_now = open_qty.get(sym, 0.0)
        # Shares we end up holding that we never saw bought must predate the
        # statement, so the deployed window starts at the statement instead.
        pre_existing = bq < h["sold_qty"] + held_now - 1e-6
        moves = sorted(h["moves"])
        start = from_d if (pre_existing or not moves) else moves[0][0]
        if held_now > 1e-9 or not moves:
            end = to_d
        else:
            end = moves[-1][0]  # fully closed: capital came out on the last sell
        # pre_existing infers "shares predate the window" from counts alone,
        # but a forward split mid-window mints shares without a trade row and
        # trips the same test — the integration then seeds phantom shares from
        # the window start and stretches days to the full window. IBKR's own
        # cost basis arbitrates: if the whole open position's CostBasisMoney
        # matches what the window's buys cost, nothing predates the window —
        # the extra shares came from a split, and share counts before/after
        # the event are in different units. Suppress the time stats (days=0
        # hides the annualized yield and disarms the ex-date gap check)
        # rather than integrate across a unit change. Only attempted when
        # nothing was sold — FIFO makes the comparison ambiguous otherwise.
        split_suspect = False
        if pre_existing and held_now > 1e-9 and h["sold_qty"] <= 1e-9:
            cb = cost_basis_now.get(sym, 0.0)
            if cb > 0 and abs(cb - h["bought_cost"]) <= max(1.0, 0.01 * cb):
                split_suspect = True
        entry = {
            "avg_price": h["bought_cost"] / bq,
            "bought_qty": bq,
            "sold_qty": h["sold_qty"],
            "covered": covered,
            "pre_existing": pre_existing,
            "start": start.isoformat() if start else "",
            "end": end.isoformat() if end else "",
            "days": (end - start).days if (start and end and end > start) else 0,
            "avg_shares": 0.0,
        }
        if split_suspect:
            entry["days"] = 0
            entry["split_suspect"] = True
        if start and end and end > start and not split_suspect:
            # Shares already held when the statement opens never appear as a
            # trade, so the integration has to be seeded with them or it starts
            # from zero on a position that was there all along. Back it out of
            # the ending position: opening = final - (everything traded since).
            opening = held_now - (bq - h["sold_qty"])
            pos = opening + sum(q for d, q in moves if d <= start)
            area = 0.0
            prev = start
            for d, q in moves:
                if d <= start or d > end:
                    continue
                # Only long exposure earns dividends. A name that went short
                # mid-period (sell 10, buy back months later) otherwise drags
                # the average negative, and a negative "average shares" is a
                # nonsense basis for "what should I have collected".
                area += max(pos, 0.0) * (d - prev).days
                prev = d
                pos += q
            area += max(pos, 0.0) * (end - prev).days
            entry["avg_shares"] = area / entry["days"]
        out[sym] = entry

    # A position opened before the window and untouched since never shows up
    # above — it has no trade rows — so it would get no entry at all, days=0
    # downstream, and the annualized yield goes missing for exactly the
    # steadiest dividend holdings. For an open position with zero period
    # trades both facts are certain: capital was deployed the whole statement
    # window and the average size is the held quantity. Seed those.
    # avg_price stays 0 — the dashboard prefers IBKR's own CostBasisPrice for
    # anything still open, and the covered=False guard keeps the zero from
    # ever being used as a rebuilt cost.
    #
    # Only when Statement of Funds was actually ingested: "no trade rows for
    # this symbol" is evidence of buy-and-hold only if trade rows were being
    # collected at all. On a query without SoF every symbol has no rows, and
    # seeding would stamp a mid-window purchase as deployed the whole year.
    if from_d and to_d and to_d > from_d and account.get("_sof_seen"):
        window_days = (to_d - from_d).days
        for sym, qty in open_qty.items():
            if qty <= 1e-9 or sym in account["cost_history"]:
                continue
            out[sym] = {
                "avg_price": 0.0,
                "bought_qty": 0.0,
                "sold_qty": 0.0,
                "covered": False,
                "pre_existing": True,
                "start": from_d.isoformat(),
                "end": to_d.isoformat(),
                "days": window_days,
                "avg_shares": qty,
            }
    account["cost_history"] = out


def _ingest_statement_of_funds(account: dict[str, Any], row: dict[str, str]) -> None:
    account["_sof_seen"] = True
    _ingest_trade_cost(account, row)
    code = row.get("ActivityCode", "")
    if code in _DIV_GROSS_CODES or code in _DIV_TAX_CODES:
        d = _parse_date(row.get("Date", "") or row.get("SettleDate", ""))
        amount = _to_float(row.get("Amount"))
        if d is not None and amount != 0:
            kind = "gross" if code in _DIV_GROSS_CODES else "tax"
            sym = _dividend_symbol(row)
            if not _skip_unattributed_tax(kind, sym):
                _ingest_dividend_row(account, "_div_sof", d, sym or "—",
                                     kind, amount, row)
        return
    if code not in _EXTERNAL_CF_CODES:
        return
    d = _parse_date(row.get("Date", ""))
    if d is None:
        return
    amount = _to_float(row.get("Amount"))
    if amount == 0:
        return
    flow_id = _cash_flow_id(account, row, d, code, amount)
    # A repeated id within one statement means IBKR handed us the same row
    # twice; drop it rather than double-count the deposit.
    if flow_id in account["_cf_ids"]:
        return
    account["_cf_ids"].add(flow_id)
    account["cash_flows"].append({
        "id": flow_id,
        "date": d.isoformat(),
        "code": code,
        "amount": amount,
        "description": (row.get("ActivityDescription") or "").strip(),
    })
    # IBKR's sign on Amount: deposit positive, withdrawal negative.
    # Keep that convention here; compute_account_returns flips for IRR.
    account["_cash_flows"].append((d, amount))


def describe_sections(content: str) -> list[str]:
    """Which sections a Flex CSV actually contains, as classified names.

    Diagnostic only. A refresh that succeeds but shows no dividends is almost
    always a query-configuration problem rather than a parsing one, and the
    fastest way to tell them apart is to see whether CashTransactions /
    StatementOfFunds came back at all. Unknown sections are reported with
    their first few column names so an unrecognised section is identifiable
    without re-downloading the statement.
    """
    seen: list[str] = []
    for header, rows in _section_rows(content):
        kind = _classify_section(header)
        if kind == "Unknown":
            kind = "Unknown(" + ",".join(header[1:4]) + ")"
        seen.append(f"{kind}[{len(rows)}]")
    return seen


def parse_ibkr_flex_csv(content: str) -> dict[str, Any]:
    accounts: dict[str, dict[str, Any]] = defaultdict(_empty_account)

    for header, rows in _section_rows(content):
        kind = _classify_section(header)
        if kind in ("AccountList", "Unknown"):
            continue
        for raw in rows:
            row = {header[i]: raw[i] for i in range(min(len(header), len(raw)))}
            acct_id = row.get("ClientAccountID", "")
            if not acct_id:
                continue
            acct = accounts[acct_id]
            acct["account"]["Account"] = acct_id
            if kind == "NAV":
                _ingest_nav(acct, row)
            elif kind == "OpenPositions":
                _ingest_position(acct, row)
            elif kind == "MTMPerformance":
                _ingest_performance(acct, row)
            elif kind == "ChangeInNAV":
                _ingest_change_in_nav(acct, row)
            elif kind == "PnLSummary":
                _ingest_pnl_summary(acct, row)
            elif kind == "StatementOfFunds":
                _ingest_statement_of_funds(acct, row)
            elif kind == "CashTransactions":
                _ingest_cash_transaction(acct, row)

    # Sort + finalize each account
    for acct in accounts.values():
        # If we never got a proper period from ChangeInNAV, fall back to the
        # NAV ReportDate so the dashboard still has something readable.
        if not acct["statement"].get("Period"):
            fallback = acct["statement"].pop("_report_date", None)
            if fallback:
                acct["statement"]["Period"] = f"截至 {fallback}"
        else:
            acct["statement"].pop("_report_date", None)
        acct["stocks"].sort(key=lambda x: x["value"], reverse=True)
        acct["options"].sort(key=lambda x: abs(x["value"]), reverse=True)
        # Group options by underlying for any view that wants it
        grouped: dict[str, dict[str, Any]] = defaultdict(
            lambda: {"contracts": [], "net_quantity": 0, "net_value": 0.0, "unrealized_pl": 0.0}
        )
        for opt in acct["options"]:
            u = opt["underlying"]
            bucket = grouped[u]
            bucket["contracts"].append(opt)
            bucket["net_quantity"] += opt["quantity"]
            bucket["net_value"] += opt["value"]
            bucket["unrealized_pl"] += opt["unrealized_pl"]
        acct["options_by_underlying"] = {k: v for k, v in grouped.items()}

        # Money-weighted return — drives the dashboard's annualized-return
        # subtitle when TWR is absent (which is always, for Flex Web Service).
        start_d = _parse_date(acct.get("_from_date", ""))
        end_d = _parse_date(acct.get("_to_date", ""))
        statement_days = (end_d - start_d).days if (start_d and end_d) else None
        returns = compute_account_returns(
            deposits_withdrawals=acct["_cash_flows"],
            starting_nav=acct.get("_starting_cash", 0.0),
            starting_date=start_d,
            ending_nav=acct["nav"].get("total", 0.0),
            ending_date=end_d,
            statement_days=statement_days,
        )
        acct["nav"]["irr_annualized"] = returns["irr_annualized"]
        acct["nav"]["money_multiplier"] = returns["money_multiplier"]
        acct["nav"]["return_method"] = returns["method"]
        acct["cash_flows"].sort(key=lambda f: (f["date"], f["id"]))
        _finalize_dividends(acct)
        _finalize_cost_history(acct)
        # Strip internal scratch state before serialising. _cf_ids is a set
        # and would blow up json.dump if it ever survived to the writer.
        for k in ("_cash_flows", "_cf_ids", "_cf_synth_seq",
                  "_div_cash", "_div_sof", "_div_ids", "_div_synth_seq",
                  "_sof_seen", "_nav_date", "_starting_cash",
                  "_from_date", "_to_date"):
            acct.pop(k, None)

    return {"accounts": dict(accounts)}
