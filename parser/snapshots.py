"""Dated per-account snapshots, for week-over-week position diffs.

Every refresh/upload overwrites uploads/{acct}.json wholesale, so the
dashboard has never known what last week's book looked like. This module
keeps one compact line per statement date in uploads/{acct}.snapshots.jsonl:

    {"date": "2026-08-19", "nav": 236000.0,
     "stocks": {"RKLB": [qty, close_price, value, unrealized_pl], ...},
     "perf":   {"RKLB": [realized_total, unrealized_total, "S"], ...}}

The weekly recap panel diffs the newest snapshot against the one closest to
seven days earlier. Same-date refreshes replace (last wins), the file is
rewritten atomically on every record (it stays a few hundred KB even after
years of weekly syncs), and a failed snapshot write must never break the
upload that triggered it — the caller guards for that.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import date
from pathlib import Path
from typing import Any

# ~7.5 years of weekly syncs; a runaway daily cron still stays bounded.
MAX_KEEP = 400


def _snap_path(upload_dir: Path | str, acct_id: str) -> Path:
    return Path(upload_dir) / f"{acct_id}.snapshots.jsonl"


def build_snapshot(data: dict[str, Any]) -> dict[str, Any]:
    """Reduce one parsed account payload to the diffable essentials."""
    hist = data.get("nav_history") or []
    # The statement's own as-of date when we have it (Flex), else today
    # (Activity Statement / PDF uploads carry no daily NAV series).
    snap_date = hist[-1]["date"] if hist else date.today().isoformat()
    stocks = {
        s.get("symbol", ""): [
            s.get("quantity", 0.0), s.get("close_price", 0.0),
            s.get("value", 0.0), s.get("unrealized_pl", 0.0),
        ]
        for s in data.get("stocks", []) if s.get("symbol")
    }
    perf = {}
    for sym, p in (data.get("performance", {}).get("by_symbol") or {}).items():
        kind = "S" if p.get("asset_category") == "Stocks" else "O"
        perf[sym] = [p.get("realized_total", 0.0), p.get("unrealized_total", 0.0), kind]
    return {
        "date": snap_date,
        "nav": (data.get("nav") or {}).get("total", 0.0),
        "stocks": stocks,
        "perf": perf,
    }


def _read_entries(path: Path) -> dict[str, dict[str, Any]]:
    """date → entry, last line wins for a repeated date; bad lines skipped."""
    entries: dict[str, dict[str, Any]] = {}
    if not path.exists():
        return entries
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(e, dict) and e.get("date"):
                    entries[e["date"]] = e
    except OSError:
        return {}
    return entries


def record_snapshot(upload_dir: Path | str, acct_id: str, data: dict[str, Any]) -> None:
    """Add (or replace, same date) today's snapshot and rewrite atomically."""
    path = _snap_path(upload_dir, acct_id)
    entries = _read_entries(path)
    snap = build_snapshot(data)
    entries[snap["date"]] = snap
    kept = sorted(entries.values(), key=lambda e: e["date"])[-MAX_KEEP:]
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            for e in kept:
                out.write(json.dumps(e, ensure_ascii=False,
                                     separators=(",", ":")) + "\n")
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def load_snapshots(upload_dir: Path | str, acct_id: str,
                   limit: int = 30) -> list[dict[str, Any]]:
    """Newest `limit` snapshots, date-ascending."""
    entries = _read_entries(_snap_path(upload_dir, acct_id))
    return sorted(entries.values(), key=lambda e: e["date"])[-limit:]
