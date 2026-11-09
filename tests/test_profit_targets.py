# -*- coding: utf-8 -*-
"""Take-profit targets: reading a plan against the snapshots, and its storage.

Account ids are fake — the repo is public.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parser.targets import evaluate_targets  # noqa: E402

A, B = "U1111111", "U2222222"


def snap(date: str, **stocks) -> dict:
    """A snapshot line; each stock is (quantity, close[, realized[, cost]])."""
    out = {"date": date, "nav": 1.0, "stocks": {}, "perf": {}}
    for sym, row in stocks.items():
        value = row[0] * row[1]
        cost = row[3] if len(row) > 3 else value
        out["stocks"][sym] = [row[0], row[1], value, value - cost]
        if len(row) > 2:
            out["perf"][sym] = [row[2], 0.0, "S"]
    return out


def acct(as_of: str = "2026-10-30", **stocks) -> dict:
    """A current statement; each stock is (quantity, close)."""
    return {
        "nav_history": [{"date": as_of}],
        "stocks": [{"symbol": sym, "quantity": q, "close_price": c}
                   for sym, (q, c) in stocks.items()],
    }


def plan(set_on: str, *prices: float) -> dict:
    return {"tiers": [{"price": p, "set_on": set_on} for p in prices]}


# --- reaching a tier ------------------------------------------------------------


def test_a_reached_tier_stays_reached_after_the_price_falls_back():
    # The case the feature exists for: over the target, then back under it. A
    # check against the latest close alone would say nothing here at all.
    series = [snap("2026-09-21", METU=(100, 28.0)), snap("2026-09-22", METU=(100, 31.84)),
              snap("2026-09-24", METU=(100, 35.39)), snap("2026-10-15", METU=(100, 31.34)),
              snap("2026-10-30", METU=(100, 20.80))]
    got = evaluate_targets({"METU": plan("2026-09-01", 30, 35, 40)},
                           {A: acct(METU=(100, 20.80))}, {A: series})["METU"]
    assert got["state"] == "active"
    first, second, third = got["accounts"][A]
    assert first["reached"] and first["hit_on"] == "2026-09-22" and first["hit_close"] == 31.84
    assert first["peak_close"] == 35.39 and first["peak_on"] == "2026-09-24"
    assert second["reached"] and second["hit_on"] == "2026-09-24"
    assert not third["reached"] and third["hit_on"] is None
    assert not first["reduced"] and not second["reduced"]


def test_only_the_last_close_before_the_target_was_set_counts_from_before_it():
    # 9/24 is history; 9/30 is the price the target was typed against.
    series = [snap("2026-09-24", METU=(100, 35.39)), snap("2026-09-30", METU=(100, 28.0)),
              snap("2026-10-30", METU=(100, 20.80))]
    got = evaluate_targets({"METU": plan("2026-10-01", 30)},
                           {A: acct(METU=(100, 20.80))}, {A: series})
    tier = got["METU"]["accounts"][A][0]
    assert not tier["reached"] and tier["price"] == 30


def test_a_target_saved_under_the_market_stays_reached_when_the_price_drops():
    # Saved on 10/30 against the 10/29 close of $40; the next close is $25 and
    # not a share was sold. Reached on save is reached for good.
    series = [snap("2026-10-29", METU=(100, 40.0)), snap("2026-10-30", METU=(100, 25.0))]
    got = evaluate_targets({"METU": plan("2026-10-30", 30)},
                           {A: acct(as_of="2026-10-30", METU=(100, 25.0))}, {A: series})
    tier = got["METU"]["accounts"][A][0]
    assert tier["reached"] and tier["hit_on"] == "2026-10-29" and tier["qty_at_hit"] == 100
    assert not tier["reduced"]


def test_a_close_exactly_on_the_target_reaches_it():
    series = [snap("2026-10-30", METU=(100, 30.0))]
    got = evaluate_targets({"METU": plan("2026-10-01", 30)},
                           {A: acct(METU=(100, 30.0))}, {A: series})
    assert got["METU"]["accounts"][A][0]["reached"]


def test_a_target_typed_under_the_market_is_reached_before_any_snapshot_sees_it():
    # Saved today; the newest statement is yesterday's and already above it.
    series = [snap("2026-10-29", METU=(100, 40.0))]
    got = evaluate_targets({"METU": plan("2026-10-30", 30)},
                           {A: acct(as_of="2026-10-29", METU=(100, 40.0))}, {A: series})
    tier = got["METU"]["accounts"][A][0]
    assert tier["reached"] and tier["hit_on"] == "2026-10-29" and tier["qty_at_hit"] == 100
    assert not tier["reduced"]


# --- selling into it ------------------------------------------------------------


def test_selling_after_the_tier_is_reached_closes_it():
    series = [snap("2026-09-22", METU=(100, 31.0)), snap("2026-09-23", METU=(40, 32.0))]
    got = evaluate_targets({"METU": plan("2026-09-01", 30)},
                           {A: acct(METU=(40, 32.0))}, {A: series})
    assert got["METU"]["accounts"][A][0]["reduced"]


def test_selling_before_the_tier_was_reached_does_not_close_it():
    # Trimmed on the way up: the count at the moment it was reached is the bar.
    series = [snap("2026-09-20", METU=(100, 25.0)), snap("2026-09-21", METU=(40, 26.0)),
              snap("2026-09-22", METU=(40, 31.0))]
    got = evaluate_targets({"METU": plan("2026-09-01", 30)},
                           {A: acct(METU=(40, 31.0))}, {A: series})
    assert not got["METU"]["accounts"][A][0]["reduced"]


def test_buying_back_after_selling_into_a_tier_keeps_it_handled():
    # 100 when it was reached, 40 after the sale, 100 again later: the sale was
    # the decision, and the old reminder must not come back with the shares.
    series = [snap("2026-09-22", METU=(100, 31.0)), snap("2026-09-23", METU=(40, 32.0)),
              snap("2026-10-01", METU=(100, 33.0))]
    got = evaluate_targets({"METU": plan("2026-09-01", 30)},
                           {A: acct(METU=(100, 33.0))}, {A: series})
    assert got["METU"]["accounts"][A][0]["reduced"]


def test_reinvested_dividends_never_read_as_a_sale_and_each_account_answers_for_itself():
    series = {A: [snap("2026-09-22", METU=(12.3456, 31.0))],
              B: [snap("2026-09-22", METU=(100, 31.0))]}
    got = evaluate_targets({"METU": plan("2026-09-01", 30)},
                           {A: acct(METU=(12.4012, 31.0)), B: acct(METU=(30, 31.0))}, series)
    assert not got["METU"]["accounts"][A][0]["reduced"]
    assert got["METU"]["accounts"][B][0]["reduced"]


# --- whose holding ---------------------------------------------------------------


def test_a_close_while_this_account_held_nothing_is_not_its_hit():
    # A held through the peak; B bought afterwards, well under the target.
    series = {A: [snap("2026-09-24", METU=(100, 35.0)), snap("2026-10-30", METU=(100, 21.0))],
              B: [snap("2026-09-24"), snap("2026-10-30", METU=(10, 21.0))]}
    got = evaluate_targets({"METU": plan("2026-09-01", 30)},
                           {A: acct(METU=(100, 21.0)), B: acct(METU=(10, 21.0))}, series)
    assert got["METU"]["accounts"][A][0]["reached"]
    assert not got["METU"]["accounts"][B][0]["reached"]


def test_closing_and_reopening_starts_the_account_over_while_the_plan_lives_on():
    # B never stopped holding, so the plan is alive. A's new position is not the
    # one that reached the target.
    series = {A: [snap("2026-09-24", METU=(100, 35.0)), snap("2026-10-01"),
                  snap("2026-10-30", METU=(90, 21.0))],
              B: [snap("2026-09-24", METU=(5, 35.0)), snap("2026-10-01", METU=(5, 25.0)),
                  snap("2026-10-30", METU=(5, 21.0))]}
    got = evaluate_targets({"METU": plan("2026-09-01", 30)},
                           {A: acct(METU=(90, 21.0)), B: acct(METU=(5, 21.0))}, series)["METU"]
    assert got["state"] == "active"
    assert not got["accounts"][A][0]["reached"]
    assert got["accounts"][B][0]["reached"]


# --- the plan's life --------------------------------------------------------------


def test_a_plan_is_pending_until_the_name_is_held():
    got = evaluate_targets({"SOXL": plan("2026-10-01", 100)},
                           {A: acct(METU=(100, 21.0))},
                           {A: [snap("2026-10-02", METU=(100, 21.0))]})
    assert got["SOXL"] == {"state": "pending", "split_on": None, "accounts": {}}


def test_a_plan_written_before_the_position_was_opened_is_judged_from_then_on():
    series = [snap("2026-10-01"), snap("2026-10-02", SOXL=(10, 90.0)),
              snap("2026-10-03", SOXL=(10, 105.0))]
    got = evaluate_targets({"SOXL": plan("2026-10-01", 100)},
                           {A: acct(SOXL=(10, 105.0))}, {A: series})["SOXL"]
    assert got["state"] == "active" and got["accounts"][A][0]["hit_on"] == "2026-10-03"


def test_selling_out_ends_the_plan_and_buying_back_does_not_revive_it():
    series = [snap("2026-10-01", METU=(100, 21.0)), snap("2026-10-02")]
    sold = evaluate_targets({"METU": plan("2026-09-01", 30)}, {A: acct()}, {A: series})
    assert sold["METU"]["state"] == "expired" and sold["METU"]["accounts"] == {}
    rebought = evaluate_targets({"METU": plan("2026-09-01", 30)},
                                {A: acct(METU=(10, 40.0))},
                                {A: [*series, snap("2026-10-30", METU=(10, 40.0))]})
    assert rebought["METU"]["state"] == "expired" and rebought["METU"]["accounts"] == {}


def test_one_account_selling_out_leaves_the_plan_alive_for_the_other():
    series = {A: [snap("2026-10-01", METU=(100, 21.0)), snap("2026-10-02")],
              B: [snap("2026-10-01", METU=(5, 21.0)), snap("2026-10-02", METU=(5, 21.0))]}
    got = evaluate_targets({"METU": plan("2026-09-01", 30)},
                           {A: acct(), B: acct(METU=(5, 21.0))}, series)["METU"]
    assert got["state"] == "active" and list(got["accounts"]) == [B]


def test_a_failed_sync_for_one_account_is_not_a_sale():
    # B has no snapshot on 10-02. Its last known state carries across, so the
    # day does not read as nobody holding the name.
    series = {A: [snap("2026-10-01"), snap("2026-10-02")],
              B: [snap("2026-10-01", METU=(5, 21.0)), snap("2026-10-03", METU=(5, 21.0))]}
    got = evaluate_targets({"METU": plan("2026-09-01", 30)},
                           {A: acct(), B: acct(METU=(5, 21.0))}, series)
    assert got["METU"]["state"] == "active"


def test_selling_out_right_after_the_plan_is_saved_still_ends_it():
    # Saved on 10/02 while the 10/01 statement shows the shares; the first
    # snapshot after it shows them gone. Buying back must not revive it.
    series = [snap("2026-10-01", METU=(100, 21.0)), snap("2026-10-02")]
    sold = evaluate_targets({"METU": plan("2026-10-02", 30)}, {A: acct()}, {A: series})
    assert sold["METU"]["state"] == "expired"
    rebought = evaluate_targets({"METU": plan("2026-10-02", 30)}, {A: acct(METU=(10, 25.0))},
                                {A: [*series, snap("2026-10-20", METU=(10, 25.0))]})
    assert rebought["METU"]["state"] == "expired"


def test_a_plan_older_than_the_kept_snapshots_is_stale_not_misread(monkeypatch):
    # The file keeps MAX_KEEP entries. Once it is full, what decided an older
    # plan (here: the sale, then the buy-back) may have been cut, and the rest
    # would read as a plan that is still alive.
    import parser.targets as targets

    monkeypatch.setattr(targets, "MAX_KEEP", 3)
    kept = [snap("2026-10-20", METU=(10, 25.0)), snap("2026-10-21", METU=(10, 26.0)),
            snap("2026-10-22", METU=(10, 27.0))]
    got = targets.evaluate_targets({"METU": plan("2026-09-01", 30)},
                                   {A: acct(METU=(10, 27.0))}, {A: kept})
    assert got["METU"] == {"state": "stale", "split_on": None, "accounts": {}}
    # A plan set inside what is kept is read as usual.
    fresh = targets.evaluate_targets({"METU": plan("2026-10-21", 26)},
                                     {A: acct(METU=(10, 27.0))}, {A: kept})
    assert fresh["METU"]["state"] == "active"
    # A file that has never filled up has not been cut: its start is all there is.
    short = targets.evaluate_targets({"METU": plan("2026-09-01", 30)},
                                     {A: acct(METU=(10, 27.0))}, {A: kept[:2]})
    assert short["METU"]["state"] == "active"


# --- splits ---------------------------------------------------------------------


def test_a_reverse_split_voids_the_plan_instead_of_reaching_every_tier():
    # 1:10: the price jumps over every target and the count looks like a sale.
    series = [snap("2026-10-01", CONL=(400, 2.87, 5.0)), snap("2026-10-02", CONL=(40, 28.9, 5.0))]
    got = evaluate_targets({"CONL": plan("2026-09-01", 5, 8)},
                           {A: acct(CONL=(40, 28.9))}, {A: series})["CONL"]
    assert got["state"] == "split" and got["split_on"] == "2026-10-02"
    assert got["accounts"] == {}


def test_a_split_from_before_the_plan_does_not_touch_it():
    series = [snap("2026-10-01", CONL=(400, 2.87, 5.0)), snap("2026-10-02", CONL=(40, 28.9, 5.0)),
              snap("2026-10-03", CONL=(40, 29.0, 5.0))]
    got = evaluate_targets({"CONL": plan("2026-10-02", 40)},
                           {A: acct(CONL=(40, 29.0))}, {A: series})["CONL"]
    assert got["state"] == "active"


def test_a_split_on_the_first_close_after_the_plan_is_caught():
    # Set on Sunday. Friday's snapshot is the baseline for Monday's, so a
    # reverse split at Monday's open still voids the plan instead of reaching it.
    series = [snap("2026-10-02", CONL=(400, 2.87, 5.0)), snap("2026-10-05", CONL=(40, 28.9, 5.0))]
    got = evaluate_targets({"CONL": plan("2026-10-04", 5, 8)},
                           {A: acct(CONL=(40, 28.9))}, {A: series})["CONL"]
    assert got["state"] == "split" and got["split_on"] == "2026-10-05"


def test_a_trim_that_happens_to_look_reciprocal_is_a_trade_not_a_split():
    # The real one the weekly recap ran into: 610 → 510 shares against 5.32 → 6.27.
    # Realized P&L moved, and a split cannot do that.
    series = [snap("2026-09-17", CONL=(610, 5.32, 0.0)), snap("2026-09-18", CONL=(510, 6.27, 102.03))]
    got = evaluate_targets({"CONL": plan("2026-09-01", 6)},
                           {A: acct(CONL=(510, 6.27))}, {A: series})["CONL"]
    assert got["state"] == "active"
    assert got["accounts"][A][0]["reached"]


def test_buying_the_dip_is_not_a_split_even_when_the_ratios_line_up():
    # Add 10% on a day it falls 9%. Reciprocal, and a buy realizes nothing, so
    # only the cost tells them apart: it jumps by what the shares cost.
    series = [snap("2026-10-01", METU=(100, 20.0, 0.0, 2000.0)),
              snap("2026-10-02", METU=(110, 18.2, 0.0, 2182.0))]
    got = evaluate_targets({"METU": plan("2026-09-01", 30)},
                           {A: acct(METU=(110, 18.2))}, {A: series})["METU"]
    assert got["state"] == "active" and got["split_on"] is None


def test_a_split_with_the_cost_unchanged_still_reads_as_one():
    # The same day-to-day shape as a dip buy, except that nothing was paid.
    series = [snap("2026-10-01", METU=(100, 40.0, 0.0, 2000.0)),
              snap("2026-10-02", METU=(200, 20.2, 0.0, 2000.0))]
    got = evaluate_targets({"METU": plan("2026-09-01", 30)},
                           {A: acct(METU=(200, 20.2))}, {A: series})["METU"]
    assert got["state"] == "split" and got["split_on"] == "2026-10-02"


def test_garbage_in_a_snapshot_row_is_skipped():
    series = [{"date": "2026-10-01", "stocks": {"METU": "bad"}},
              {"date": "2026-10-02", "stocks": {"METU": [None, None]}},
              snap("2026-10-03", METU=(100, 31.0))]
    got = evaluate_targets({"METU": plan("2026-09-01", 30)},
                           {A: acct(METU=(100, 31.0))}, {A: series})
    assert got["METU"]["accounts"][A][0]["hit_on"] == "2026-10-03"


# --- settings -------------------------------------------------------------------


def test_normalization():
    from app import _normalize_profit_targets as norm

    got = norm({
        "symbols": {
            "metu": {"tiers": [{"price": "30"}, {"price": 35.5}]},   # form strings are fine
            "CONL": {"tiers": []},                                   # cleared: nothing to keep
        },
        "levered": ["conl", "METU", "CONL", " "],
    })
    assert got == {"symbols": {"METU": {"tiers": [{"price": 30.0}, {"price": 35.5}]}},
                   "levered": ["CONL", "METU"]}
    # A set_on sent by a client is not taken: the server owns that date.
    sent = norm({"symbols": {"METU": {"tiers": [{"price": 30, "set_on": "2020-01-01"}]}}})
    assert sent["symbols"]["METU"]["tiers"] == [{"price": 30.0}]
    # A list left out means the default, which is not the same as [].
    assert norm({"symbols": {}})["levered"] is None
    assert norm({"symbols": {}, "levered": []})["levered"] == []


@pytest.mark.parametrize("body", [
    {},                                                            # no symbols map
    {"symbols": []},
    {"symbols": {"../etc": {"tiers": [{"price": 1}]}}},
    {"symbols": {"METU": "30"}},
    {"symbols": {"METU": {}}},                                     # no tiers list
    {"symbols": {"METU": {"tiers": [30]}}},                        # a tier is an object
    {"symbols": {"METU": {"tiers": [{"price": 0}]}}},
    {"symbols": {"METU": {"tiers": [{"price": -5}]}}},
    {"symbols": {"METU": {"tiers": [{"price": True}]}}},           # bool is not a number here
    {"symbols": {"METU": {"tiers": [{"price": "abc"}]}}},
    {"symbols": {"METU": {"tiers": [{"price": None}]}}},
    {"symbols": {"METU": {"tiers": [{"price": float("nan")}]}}},
    {"symbols": {"METU": {"tiers": [{"price": float("inf")}]}}},
    {"symbols": {"METU": {"tiers": [{"price": 2_000_000}]}}},
    {"symbols": {"METU": {"tiers": [{"price": 35}, {"price": 30}]}}},   # must rise
    {"symbols": {"METU": {"tiers": [{"price": 30}, {"price": 30}]}}},
    {"symbols": {"METU": {"tiers": [{"price": p} for p in (1, 2, 3, 4)]}}},   # more than 3
    {"symbols": {}, "levered": "CONL"},
    {"symbols": {}, "levered": ["../etc"]},
])
def test_bad_input_is_rejected(body):
    from app import _normalize_profit_targets as norm

    with pytest.raises(ValueError):
        norm(body)


@pytest.fixture
def client(tmp_path, monkeypatch):
    import app as app_mod

    monkeypatch.setattr(app_mod, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(app_mod, "PROFIT_TARGETS_FILE", tmp_path / ".profit_targets.json")
    return app_mod.app.test_client()


def store(tmp_path: Path, symbols: dict) -> None:
    (tmp_path / ".profit_targets.json").write_text(
        json.dumps({"version": 1, "updated_at": "x", "symbols": symbols, "levered": None}),
        encoding="utf-8")


def account_files(tmp_path: Path, acct_id: str, statement: dict, series: list[dict]) -> None:
    (tmp_path / f"{acct_id}.json").write_text(json.dumps(statement), encoding="utf-8")
    (tmp_path / f"{acct_id}.snapshots.jsonl").write_text(
        "".join(json.dumps(s) + "\n" for s in series), encoding="utf-8")


def today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def test_roundtrip_and_a_stable_shape(client, tmp_path):
    keys = {"version", "symbols", "levered", "updated_at", "read_error"}
    blank = client.get("/api/settings/targets").get_json()
    assert set(blank) == keys and blank["symbols"] == {} and blank["read_error"] is False

    res = client.put("/api/settings/targets", json={
        "symbols": {"METU": {"tiers": [{"price": 30}, {"price": 35}]}}, "levered": ["METU"]})
    assert res.status_code == 200
    body = res.get_json()
    assert body["symbols"]["METU"]["tiers"][0] == {"price": 30.0, "set_on": today()}
    assert body["read_error"] is False and "progress" in body

    stored = client.get("/api/settings/targets").get_json()
    assert set(stored) == keys and stored["updated_at"]
    assert stored["symbols"] == body["symbols"] and stored["levered"] == ["METU"]
    # What is derived or merely reported does not reach the file.
    on_disk = json.loads((tmp_path / ".profit_targets.json").read_text(encoding="utf-8"))
    assert "progress" not in on_disk and "read_error" not in on_disk

    # A rejected write leaves the previous plans exactly as they were.
    bad = client.put("/api/settings/targets",
                     json={"symbols": {"METU": {"tiers": [{"price": 35}, {"price": 30}]}}})
    assert bad.status_code == 400 and "METU" in bad.get_json()["error"]
    assert client.get("/api/settings/targets").get_json()["symbols"] == stored["symbols"]
    assert client.put("/api/settings/targets", data="nope",
                      content_type="application/json").status_code == 400


def test_a_kept_price_keeps_its_date_and_a_changed_one_starts_again(client, tmp_path):
    # Raising a reached target is how you say "not yet": it must not read as
    # reached again from the closes it has already seen.
    store(tmp_path, {"METU": plan("2026-09-01", 30, 35)})
    got = client.put("/api/settings/targets", json={"symbols": {"METU": {"tiers": [
        {"price": 35}, {"price": 42}]}}}).get_json()["symbols"]["METU"]["tiers"]
    assert got == [{"price": 35.0, "set_on": "2026-09-01"}, {"price": 42.0, "set_on": today()}]


def test_clearing_every_box_removes_the_symbol(client, tmp_path):
    store(tmp_path, {"METU": plan("2026-09-01", 30)})
    client.put("/api/settings/targets", json={"symbols": {"METU": {"tiers": []}}})
    assert client.get("/api/settings/targets").get_json()["symbols"] == {}


def test_a_plan_that_ended_does_not_lend_its_date_to_the_next_one(client, tmp_path):
    # Sold out, bought back, the same price typed again. Its old date would
    # bring the old plan's "sold out" straight back with it.
    store(tmp_path, {"METU": plan("2026-09-01", 30)})
    account_files(tmp_path, A, acct(METU=(10, 25.0)), [
        snap("2026-10-01", METU=(100, 21.0)), snap("2026-10-02"), snap("2026-10-30", METU=(10, 25.0))])
    body = client.put("/api/settings/targets",
                      json={"symbols": {"METU": {"tiers": [{"price": 30}]}}}).get_json()
    assert body["symbols"]["METU"]["tiers"][0]["set_on"] == today()
    assert body["progress"]["METU"]["state"] == "active"


def test_a_broken_file_is_flagged_and_a_missing_one_is_not(client, tmp_path):
    path = tmp_path / ".profit_targets.json"
    read = lambda: client.get("/api/settings/targets").get_json()
    assert read()["read_error"] is False
    for broken in ("not json", "[]", '{"symbols": {"METU": {"tiers": [{"price": 30}]}}}'):
        path.write_text(broken, encoding="utf-8")                # the last has no set_on
        res = client.get("/api/settings/targets")
        assert res.status_code == 200, broken                    # never 500 the dashboard
        assert res.get_json()["read_error"] is True, broken
        assert res.get_json()["symbols"] == {}, broken
    assert client.put("/api/settings/targets", json={"symbols": {}}).status_code == 200
    assert read()["read_error"] is False                         # repaired by the save


def test_portfolio_carries_the_plans_and_their_progress_with_the_statements(client, tmp_path):
    store(tmp_path, {"METU": plan("2026-09-01", 30)})
    # The target was reached 31 snapshots ago: outside the 30 the browser gets.
    series = [snap("2026-09-01", METU=(100, 31.0))]
    series += [snap(f"2026-10-{d:02d}", METU=(100, 21.0)) for d in range(1, 31)]
    account_files(tmp_path, A, acct(METU=(100, 21.0)), series)
    payload = client.get("/api/portfolio").get_json()
    assert len(payload["accounts"][A]["snapshots"]) == 30
    assert payload["target_progress"]["METU"]["accounts"][A][0]["hit_on"] == "2026-09-01"
    # The plans the progress was read for come in the same response, so a page
    # can never pair it with plans another device has changed since.
    assert payload["target_settings"] == client.get("/api/settings/targets").get_json()
    assert payload["target_settings"]["symbols"]["METU"]["tiers"][0]["price"] == 30


def test_an_unreadable_snapshot_file_is_not_judged_rather_than_read_as_empty(client, tmp_path):
    # Empty history would turn a reached tier back into an unreached one. A
    # directory where the file should be cannot be opened, like a locked file.
    store(tmp_path, {"METU": plan("2026-09-01", 30)})
    (tmp_path / f"{A}.json").write_text(json.dumps(acct(METU=(100, 21.0))), encoding="utf-8")
    (tmp_path / f"{A}.snapshots.jsonl").mkdir()
    res = client.get("/api/portfolio")
    assert res.status_code == 200
    payload = res.get_json()
    assert payload["accounts"][A]["snapshots"] == []          # the weekly recap shrugs
    assert payload["target_progress"] is None                  # the targets say "not judged"


def test_with_no_plans_the_progress_is_empty_rather_than_unknown(client, tmp_path):
    account_files(tmp_path, A, acct(METU=(100, 21.0)), [])
    assert client.get("/api/portfolio").get_json()["target_progress"] == {}


def test_a_failure_in_the_reading_cannot_take_the_dashboard_down(client, tmp_path, monkeypatch):
    import app as app_mod

    def boom(*_args):
        raise RuntimeError("boom")

    monkeypatch.setattr(app_mod, "evaluate_targets", boom)
    store(tmp_path, {"METU": plan("2026-09-01", 30)})
    account_files(tmp_path, A, acct(METU=(100, 21.0)), [])
    res = client.get("/api/portfolio")
    assert res.status_code == 200 and res.get_json()["target_progress"] is None
    # Saving still works, and says the same thing.
    saved = client.put("/api/settings/targets",
                       json={"symbols": {"METU": {"tiers": [{"price": 30}]}}})
    assert saved.status_code == 200 and saved.get_json()["progress"] is None
    assert saved.get_json()["symbols"]["METU"]["tiers"][0]["set_on"] == "2026-09-01"


def test_the_file_is_not_mistaken_for_an_account(client, tmp_path):
    """The leading dot is load-bearing: uploads/*.json is the account sweep."""
    import app as app_mod

    store(tmp_path, {})
    account_files(tmp_path, A, acct(), [])
    assert list(app_mod._load_all_accounts()) == [A]
    assert app_mod.PROFIT_TARGETS_FILE.name.startswith(".")
