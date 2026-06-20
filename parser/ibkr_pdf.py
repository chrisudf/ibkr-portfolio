"""Parse IBKR statement PDF.

Strategy: extract all tables with pdfplumber, identify the Open Positions table
(stocks + options) and the Net Asset Value table, then feed reconstructed CSV
rows through the CSV parser so the schema stays in one place.
"""
from __future__ import annotations

import io
from typing import Any

try:
    import pdfplumber
except ImportError:  # pragma: no cover
    pdfplumber = None

from .ibkr_csv import parse_ibkr_csv


def parse_ibkr_pdf(content: bytes) -> dict[str, Any]:
    if pdfplumber is None:
        raise RuntimeError("pdfplumber is not installed; run `pip install pdfplumber`. ")

    csv_rows: list[str] = []
    current_section: str | None = None

    def emit(section: str, kind: str, cols: list[str]) -> None:
        safe = [c.replace(",", " ") if c else "" for c in cols]
        csv_rows.append(",".join([section, kind, *safe]))

    with pdfplumber.open(io.BytesIO(content)) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            for tbl in page.extract_tables() or []:
                if not tbl or not tbl[0]:
                    continue
                first_row = [c or "" for c in tbl[0]]
                joined = " ".join(first_row).lower()

                # Heuristic: detect known sections by header keywords
                if "asset class" in joined and "current total" in joined:
                    current_section = "Net Asset Value"
                    emit(current_section, "Header", first_row)
                    for r in tbl[1:]:
                        emit(current_section, "Data", [c or "" for c in r])
                elif "symbol" in joined and "cost basis" in joined and "unrealized" in joined:
                    current_section = "Open Positions"
                    emit(current_section, "Header", first_row)
                    for r in tbl[1:]:
                        emit(current_section, "Data", [c or "" for c in r])
                elif "realized total" in joined or "unrealized total" in joined:
                    current_section = "Realized & Unrealized Performance Summary"
                    emit(current_section, "Header", first_row)
                    for r in tbl[1:]:
                        emit(current_section, "Data", [c or "" for c in r])

    reconstructed = "\n".join(csv_rows)
    return parse_ibkr_csv(reconstructed)
