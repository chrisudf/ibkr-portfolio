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


_OPTION_RE = re.compile(
    r"^(?P<underlying>[A-Z\.]+)\s+(?P<expiry>\d{1,2}[A-Z]{3}\d{2})\s+(?P<strike>[\d\.]+)\s+(?P<right>[CP])$"
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
        "performance": {
            "realized_total": realized_total,
            "unrealized_total": unrealized_total,
            "by_symbol": perf_by_symbol,
        },
    }
