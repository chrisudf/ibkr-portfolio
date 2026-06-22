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
    if {"PositionValue", "MarkPrice", "Quantity", "CostBasisMoney"} <= cols:
        return "OpenPositions"
    if {"TradeDate", "TradePrice"} <= cols or "OrigTradePrice" in cols:
        return "Trades"
    if {"ActivityCode", "Amount", "Balance"} <= cols:
        return "StatementOfFunds"
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
        "_cash_flows": [],  # raw (date, amount) for IRR; stripped before serialising
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
    nav = account["nav"]
    nav["cash"] = _to_float(row.get("Cash"))
    nav["stock"] = _to_float(row.get("Stock"))
    nav["options"] = _to_float(row.get("Options"))
    nav["dividend_accruals"] = _to_float(row.get("DividendAccruals"))
    nav["total"] = _to_float(row.get("Total"))
    # Keep the most recent report date around as a fallback period.
    rd = row.get("ReportDate", "")
    if rd:
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


def _ingest_statement_of_funds(account: dict[str, Any], row: dict[str, str]) -> None:
    code = row.get("ActivityCode", "")
    if code not in _EXTERNAL_CF_CODES:
        return
    d = _parse_date(row.get("Date", ""))
    if d is None:
        return
    amount = _to_float(row.get("Amount"))
    if amount == 0:
        return
    # IBKR's sign on Amount: deposit positive, withdrawal negative.
    # Keep that convention here; compute_account_returns flips for IRR.
    account["_cash_flows"].append((d, amount))


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
            elif kind == "StatementOfFunds":
                _ingest_statement_of_funds(acct, row)

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
        # Strip internal scratch state before serialising.
        for k in ("_cash_flows", "_starting_cash", "_from_date", "_to_date"):
            acct.pop(k, None)

    return {"accounts": dict(accounts)}
