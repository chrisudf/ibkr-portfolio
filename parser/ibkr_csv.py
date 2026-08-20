"""Parse Interactive Brokers Activity / Realized Summary CSV into a portfolio dict."""
from __future__ import annotations

import csv
import io
import re
from collections import defaultdict
from typing import Any


def _to_float(value: str) -> float:
    if value is None or value == "":
        return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


# Underlying accepts digits and one internal space: corporate-action-adjusted
# contracts are spelled "COHR1 17OCT25 85 P" and class shares "BRK B ...".
# Non-greedy so the expiry token, not the regex, decides where the ticker ends.
_OPTION_RE = re.compile(
    r"^(?P<underlying>[A-Z][A-Z0-9\. ]*?)\s+(?P<expiry>\d{1,2}[A-Z]{3}\d{2})\s+(?P<strike>[\d\.]+)\s+(?P<right>[CP])$"
)


def _parse_option_symbol(symbol: str) -> dict[str, Any] | None:
    m = _OPTION_RE.match(symbol.strip())
    if not m:
        return None
    return {
        "underlying": m.group("underlying"),
        "expiry": m.group("expiry"),
        "strike": float(m.group("strike")),
        "right": m.group("right"),  # C / P
    }


# "MSFT(US5949181045) Cash Dividend USD 0.83 per Share" → MSFT. The Activity
# Statement's Dividends / Withholding Tax sections have no Symbol column, so
# the ticker has to come out of the description. Class shares are spelled with
# a space ("BRK B(US0846707026) ..."), hence the optional trailing letter.
_DIV_SYMBOL_RE = re.compile(r"^([A-Z][A-Z0-9\.]{0,9}(?: [A-Z])?)\s*\(")

# The Activity Statement carries the rate and the income class in the same
# description string the Flex export splits into columns:
#   "MSFT(US5949181045) Cash Dividend USD 0.83 per Share (Ordinary Dividend)"
_DIV_RATE_RE = re.compile(r"[A-Z]{3}\s+([\d.]+)\s+PER\s+SHARE", re.I)


def _dividend_rate(desc: str) -> float:
    m = _DIV_RATE_RE.search(desc or "")
    if not m:
        return 0.0
    try:
        return float(m.group(1))
    except ValueError:
        return 0.0


def _income_class_from_desc(desc: str) -> str:
    """Capital gains / return of capital arrive through the dividend sections
    but are not dividend income — see `_income_class` in ibkr_flex_csv.py."""
    t = (desc or "").lower()
    if "capital gain" in t:
        return "capital_gain"
    if "return of capital" in t:
        return "return_of_capital"
    return "ordinary"


def _parse_dividends(sections: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Build the payout summary from the Dividends / Withholding Tax sections.

    Both are plain Currency/Date/Description/Amount tables. Withholding rows
    are already negative in IBKR's output, so gross + tax = net directly.
    Only "Data" rows are read — the sections end with a Total row that would
    otherwise double every figure.
    """
    rows: list[dict[str, Any]] = []
    for section, kind in (("Dividends", "gross"),
                          ("Payment In Lieu Of Dividends", "gross"),
                          ("Withholding Tax", "tax")):
        for r in sections.get(section, {}).get("rows", []):
            if r.get("_kind") != "Data":
                continue
            amount = _to_float(r.get("Amount", "0"))
            date = (r.get("Date") or "").strip()
            if amount == 0 or not date:
                continue
            desc = (r.get("Description") or "").strip()
            m = _DIV_SYMBOL_RE.match(desc)
            sym = m.group(1) if m else ""
            # Same rule as the Flex path: withholding that names no security
            # is tax on interest, not on a dividend, and folding it in would
            # overstate the tax drag. See parser/ibkr_flex_csv.py.
            if kind == "tax" and not sym:
                continue
            # Sign the description-parsed rate by the cash direction — a
            # reversal row still prints the positive rate text. See the same
            # handling in ibkr_flex_csv._ingest_dividend_row.
            rate = _dividend_rate(desc) if kind == "gross" else 0.0
            rows.append({
                "date": date,
                "symbol": sym or "—",
                "kind": kind,
                "amount": amount,
                # This statement has no DividendType column, but the same
                # facts are in the description tail: the per-share rate and a
                # "(Ordinary Dividend)" / "(Short Term Capital Gain)" suffix.
                "per_share": rate if amount >= 0 else -rate,
                "income_class": _income_class_from_desc(desc) if kind == "gross" else "",
                "description": desc,
            })
    if not rows:
        return {}

    by_symbol: dict[str, dict[str, Any]] = {}
    by_month: dict[str, dict[str, Any]] = {}
    gross = tax = non_dividend_total = 0.0
    for r in rows:
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
            # Reversals (negative cash) net the sums out but aren't payments.
            if r["amount"] > 0:
                s["count"] += 1
            s["per_share"] += r["per_share"]
            if r["income_class"] == "ordinary":
                s["per_share_ordinary"] += r["per_share"]
            else:
                s["non_dividend"] += r["amount"]
                non_dividend_total += r["amount"]
            if not r["per_share"] and r["amount"] > 0:
                s["rate_missing"] += 1
        s["last_date"] = max(s["last_date"], r["date"])
        m = by_month.setdefault(r["date"][:7], {"month": r["date"][:7], "gross": 0.0, "tax": 0.0, "net": 0.0})
        m[r["kind"]] += r["amount"]
        m["net"] = m["gross"] + m["tax"]

    return {
        "source": "activity_statement",
        "gross": gross,
        "tax": tax,
        "net": gross + tax,
        "non_dividend": non_dividend_total,
        "by_symbol": sorted(by_symbol.values(), key=lambda x: x["net"], reverse=True),
        "by_month": sorted(by_month.values(), key=lambda x: x["month"]),
        "events": sorted(rows, key=lambda r: (r["date"], r["symbol"]), reverse=True),
    }


def parse_ibkr_csv(content: str) -> dict[str, Any]:
    """Parse IBKR CSV content.

    The CSV is a multi-section format where each row begins with a section name
    followed by a row type (Header / Data / SubTotal / Total). We collect rows
    per section keyed by their section header.
    """
    reader = csv.reader(io.StringIO(content))
    sections: dict[str, dict[str, Any]] = {}
    current_header: dict[str, list[str]] = {}

    for row in reader:
        if not row or len(row) < 2:
            continue
        section, kind = row[0], row[1]
        cols = row[2:]
        if kind == "Header":
            current_header[section] = cols
            sections.setdefault(section, {"headers": [], "rows": []})
            sections[section]["headers"].append(cols)
        elif kind in ("Data", "SubTotal", "Total"):
            hdr = current_header.get(section, [])
            row_dict = {hdr[i]: cols[i] for i in range(min(len(hdr), len(cols)))}
            row_dict["_kind"] = kind
            sections.setdefault(section, {"headers": [], "rows": []})
            sections[section]["rows"].append(row_dict)

    # --- Account info ---
    account: dict[str, str] = {}
    for r in sections.get("Account Information", {}).get("rows", []):
        if r.get("_kind") == "Data":
            account[r.get("Field Name", "")] = r.get("Field Value", "")

    statement: dict[str, str] = {}
    for r in sections.get("Statement", {}).get("rows", []):
        if r.get("_kind") == "Data":
            statement[r.get("Field Name", "")] = r.get("Field Value", "")

    # --- Net Asset Value ---
    nav_rows = sections.get("Net Asset Value", {}).get("rows", [])
    nav: dict[str, float] = {}
    for r in nav_rows:
        cls = (r.get("Asset Class") or "").strip()
        if not cls:
            continue
        nav[cls] = _to_float(r.get("Current Total", "0"))

    twr = 0.0
    for r in nav_rows:
        for v in r.values():
            if isinstance(v, str) and v.endswith("%"):
                try:
                    twr = float(v.replace("%", "")) / 100
                    break
                except ValueError:
                    pass

    # --- Open Positions (stocks + options) ---
    stocks: list[dict[str, Any]] = []
    options: list[dict[str, Any]] = []
    for r in sections.get("Open Positions", {}).get("rows", []):
        if r.get("_kind") != "Data":
            continue
        cat = r.get("Asset Category", "")
        qty = _to_float(r.get("Quantity", "0"))
        cost_basis = _to_float(r.get("Cost Basis", "0"))
        value = _to_float(r.get("Value", "0"))
        cost_price = _to_float(r.get("Cost Price", "0"))
        close_price = _to_float(r.get("Close Price", "0"))
        upl = _to_float(r.get("Unrealized P/L", "0"))
        symbol = r.get("Symbol", "")

        if cat == "Stocks":
            stocks.append({
                "symbol": symbol,
                "quantity": qty,
                "cost_price": cost_price,
                "close_price": close_price,
                "cost_basis": cost_basis,
                "value": value,
                "unrealized_pl": upl,
            })
        elif "Options" in cat:
            parsed = _parse_option_symbol(symbol) or {}
            options.append({
                "symbol": symbol,
                "underlying": parsed.get("underlying", symbol.split()[0] if symbol else ""),
                "expiry": parsed.get("expiry", ""),
                "strike": parsed.get("strike", 0.0),
                "right": parsed.get("right", ""),
                # Activity Statement spells the contract multiplier "Mult".
                "multiplier": _to_float(r.get("Mult", "")) or 100.0,
                "quantity": qty,
                "cost_price": cost_price,
                "close_price": close_price,
                "cost_basis": cost_basis,
                "value": value,
                "unrealized_pl": upl,
            })

    # --- Realized & Unrealized Performance Summary ---
    perf_by_symbol: dict[str, dict[str, float]] = {}
    for r in sections.get("Realized & Unrealized Performance Summary", {}).get("rows", []):
        if r.get("_kind") != "Data":
            continue
        sym = r.get("Symbol", "")
        if not sym:
            continue
        perf_by_symbol[sym] = {
            "realized_total": _to_float(r.get("Realized Total", "0")),
            "unrealized_total": _to_float(r.get("Unrealized Total", "0")),
            "total": _to_float(r.get("Total", "0")),
            "asset_category": r.get("Asset Category", ""),
        }

    # --- Aggregate totals ---
    cash = nav.get("Cash", 0.0)
    stock_value = nav.get("Stock", 0.0)
    options_value = nav.get("Options", 0.0)
    dividend_accruals = nav.get("Dividend Accruals", 0.0)
    total_nav = nav.get("Total", cash + stock_value + options_value + dividend_accruals)

    realized_total = sum(p["realized_total"] for p in perf_by_symbol.values())
    unrealized_total = sum(p["unrealized_total"] for p in perf_by_symbol.values())

    # Group options by underlying for risk view
    options_by_underlying: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"contracts": [], "net_quantity": 0, "net_value": 0.0, "unrealized_pl": 0.0}
    )
    for opt in options:
        u = opt["underlying"]
        bucket = options_by_underlying[u]
        bucket["contracts"].append(opt)
        bucket["net_quantity"] += opt["quantity"]
        bucket["net_value"] += opt["value"]
        bucket["unrealized_pl"] += opt["unrealized_pl"]

    # Sort holdings by value desc
    stocks.sort(key=lambda x: x["value"], reverse=True)
    options.sort(key=lambda x: abs(x["value"]), reverse=True)

    return {
        "account": account,
        "statement": statement,
        "nav": {
            "cash": cash,
            "stock": stock_value,
            "options": options_value,
            "dividend_accruals": dividend_accruals,
            "total": total_nav,
            "twr": twr,
        },
        "stocks": stocks,
        "options": options,
        "options_by_underlying": {k: v for k, v in options_by_underlying.items()},
        "dividends": _parse_dividends(sections),
        "performance": {
            "realized_total": realized_total,
            "unrealized_total": unrealized_total,
            "by_symbol": perf_by_symbol,
        },
    }
