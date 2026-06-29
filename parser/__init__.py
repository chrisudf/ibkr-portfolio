from .ibkr_csv import parse_ibkr_csv
from .ibkr_pdf import parse_ibkr_pdf
from .ibkr_flex_csv import parse_ibkr_flex_csv


def parse_ibkr_auto(content: str) -> dict:
    """Detect which IBKR CSV format we're looking at and dispatch."""
    head = content.lstrip("﻿").lstrip()
    if head.startswith("Statement,Header") or head.startswith("Statement,Data"):
        # Activity Statement format → wrap into the multi-account shape so
        # callers can treat both inputs uniformly.
        single = parse_ibkr_csv(content)
        acct_id = (single.get("account") or {}).get("Account") or "default"
        return {"accounts": {acct_id: single}}
    if head.startswith('"ClientAccountID"'):
        return parse_ibkr_flex_csv(content)
    raise ValueError("Unrecognised IBKR CSV format")
