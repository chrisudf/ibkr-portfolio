# -*- coding: utf-8 -*-
"""Snapshot store + auto-sync scheduling tests."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parser.snapshots import (  # noqa: E402
    MAX_KEEP, build_snapshot, load_snapshots, record_snapshot,
)


def _acct(nav_date="2026-08-19", qty=100.0):
    return {
        "nav": {"total": 50000.0},
        "nav_history": [
            {"date": "2026-08-01", "total": 49000.0},
            {"date": nav_date, "total": 50000.0},
        ],
        "stocks": [{
            "symbol": "MSFT", "quantity": qty, "close_price": 500.0,
            "value": qty * 500.0, "unrealized_pl": 1000.0,
        }],
        "performance": {"by_symbol": {
            "MSFT": {"realized_total": 10.0, "unrealized_total": 1000.0,
                     "asset_category": "Stocks"},
            "MSFT 18SEP26 480 P": {"realized_total": 5.0, "unrealized_total": -50.0,
                                   "asset_category": "Equity and Index Options"},
        }},
    }


def test_snapshot_shape_and_roundtrip(tmp_path):
    record_snapshot(tmp_path, "U1", _acct())
    snaps = load_snapshots(tmp_path, "U1")
    assert len(snaps) == 1
    s = snaps[0]
    assert s["date"] == "2026-08-19"          # statement date, not today
    assert s["nav"] == 50000.0
    assert s["stocks"]["MSFT"] == [100.0, 500.0, 50000.0, 1000.0]
    assert s["perf"]["MSFT"] == [10.0, 1000.0, "S"]
    assert s["perf"]["MSFT 18SEP26 480 P"] == [5.0, -50.0, "O"]


def test_same_date_snapshot_replaces(tmp_path):
    record_snapshot(tmp_path, "U1", _acct(qty=100.0))
    record_snapshot(tmp_path, "U1", _acct(qty=120.0))   # same statement date
    snaps = load_snapshots(tmp_path, "U1")
    assert len(snaps) == 1
    assert snaps[0]["stocks"]["MSFT"][0] == 120.0        # last wins


def test_snapshot_file_pruned_and_garbage_tolerated(tmp_path):
    path = tmp_path / "U1.snapshots.jsonl"
    lines = ["not json at all", '{"no_date": true}']
    for i in range(MAX_KEEP + 20):
        d = f"2025-{(i // 28) + 1:02d}-{(i % 28) + 1:02d}"
        lines.append(json.dumps({"date": d, "nav": i, "stocks": {}, "perf": {}}))
    path.write_text("\n".join(lines), encoding="utf-8")
    record_snapshot(tmp_path, "U1", _acct())             # triggers the rewrite
    raw = path.read_text(encoding="utf-8").strip().splitlines()
    assert len(raw) == MAX_KEEP                          # pruned, garbage gone
    snaps = load_snapshots(tmp_path, "U1", limit=MAX_KEEP)
    assert snaps[-1]["date"] == "2026-08-19"             # newest survived
    assert all(s.get("date") for s in snaps)


def test_load_limit_returns_newest(tmp_path):
    for day in range(1, 11):
        record_snapshot(tmp_path, "U1", _acct(nav_date=f"2026-08-{day:02d}"))
    snaps = load_snapshots(tmp_path, "U1", limit=3)
    assert [s["date"] for s in snaps] == ["2026-08-08", "2026-08-09", "2026-08-10"]


def test_auto_sync_due_logic():
    from app import _auto_sync_due
    dt = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc)  # noqa: E731
    sat = dt("2026-08-22T09:01:00")
    assert sat.weekday() == 5                            # fixture sanity: a Saturday

    assert not _auto_sync_due(dt("2026-08-21T08:59:00"), "daily", 9, "sat", "")
    assert _auto_sync_due(dt("2026-08-21T09:00:00"), "daily", 9, "sat", "")
    # At most one attempt per due-day — a failure waits for tomorrow.
    assert not _auto_sync_due(dt("2026-08-21T10:00:00"), "daily", 9, "sat", "2026-08-21")
    assert _auto_sync_due(dt("2026-08-22T09:00:00"), "daily", 9, "sat", "2026-08-21")

    assert _auto_sync_due(sat, "weekly", 9, "sat", "2026-08-21")
    assert not _auto_sync_due(dt("2026-08-21T09:01:00"), "weekly", 9, "sat", "")  # Friday
    assert not _auto_sync_due(sat, "weekly", 9, "sat", "2026-08-22")

    assert not _auto_sync_due(dt("2026-08-21T12:00:00"), "off", 9, "sat", "")
