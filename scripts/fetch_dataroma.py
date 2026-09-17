#!/usr/bin/env python3
"""Refresh the 13F cache from the command line.

Same code path as the panel's 重抓 button, minus the running app — useful for
seeding a fresh checkout or a fresh deploy, and for re-scraping after a filing
deadline without opening the dashboard.

    .venv/Scripts/python.exe scripts/fetch_dataroma.py        # Windows
    python3 scripts/fetch_dataroma.py                         # droplet

Unlike the IBKR sync this costs no quota: Dataroma is a public page with no
per-day generation limit, so running it twice is merely impolite, not harmful.
Takes 90-150s for ~83 managers plus continuation pages.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from parser.dataroma import fetch_all  # noqa: E402

OUT = ROOT / "uploads" / ".dataroma_cache.json"


def main() -> int:
    def progress(done: int, total: int, code: str) -> None:
        print(f"\r  {done:>3}/{total}  {code:<10}", end="", flush=True)

    print(f"scraping dataroma -> {OUT}")
    data = fetch_all(progress=progress)
    print()

    OUT.parent.mkdir(exist_ok=True)
    # Written whole rather than merged: a quarter is a complete restatement,
    # and keeping rows from a previous pass would silently mix two quarters
    # for any manager who filed late.
    OUT.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    behind = [m for m in data["managers"] if m.get("quarter") != data["quarter"]]
    print(f"  quarter   {data['quarter']}  (portfolio date {data['as_of']})")
    print(f"  rows      {data['row_count']:,} across {len(data['managers'])} managers")
    print(f"  next due  {data['next_due']}")
    if behind:
        print(f"  behind    {len(behind)} not yet filed: "
              + ", ".join(m["code"] for m in behind))
    print(f"  wrote     {OUT.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
