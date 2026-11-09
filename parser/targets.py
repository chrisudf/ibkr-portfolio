"""Take-profit targets, judged against the dated snapshots.

A plan is up to three prices per symbol. What makes it more than a comparison
with today's close is that a target stays reached. A leveraged ETF that closes
over its target and slides back is the very case the plan exists for, and a
check against the latest close alone goes quiet exactly then: METU closed above
$35 on a single day in 2026-09, then lost 40% from there in six weeks.

So each tier is read against every close since it was set, plus the last close
before it, which is the price the plan was written against: a target saved at
or under the market is reached from the start and stays reached. It stays open
until the account has held fewer shares than it did on the day it was reached.

All of this is derived, never stored. The settings file holds the prices and
the day each one was set; a changed price simply re-reads the history, with no
"reached" flag left behind to go stale. The browser only ever gets the newest
30 snapshots, which is why this runs here: a target reached seven weeks ago
must not fall out of a window and stop being reached. The snapshot file itself
keeps MAX_KEEP entries; a plan older than that is reported as stale rather
than read from a history with its start cut off.

Tiers are judged per account on that account's own snapshots, because the
question is about a holding. A close over the target while this account held
nothing is not a target it reached, whatever the other account was doing.
Whether a plan is still alive is judged across accounts: the prices are shared,
so the plan ends only when no account is left holding the name.
"""
from __future__ import annotations

from itertools import groupby
from typing import Any

from .snapshots import MAX_KEEP, _as_of_date

# Exactly on a target counts as reaching it, whatever float noise says.
_PRICE_EPS = 1e-9
# A sale leaves the count visibly lower. Dividend reinvestment only ever adds
# fractions of a share, so it can never read as one.
_QTY_EPS = 1e-6

# A split re-denominates a position; nothing is bought or sold. So the share
# count and the price move in reciprocal proportion and nothing is realized,
# the weekly recap's test (dashboard.js weeklyDiff), and the total cost stands
# still, which that one leaves out. The recap only hides a label when it is
# wrong; here a wrong answer voids a plan, and adding 10% on a day a leveraged
# ETF falls 9% passes the first two tests while the cost jumps by the purchase.
_SPLIT_MIN_MOVE = 0.05
_SPLIT_TOLERANCE = 0.02
_SPLIT_COST_TOLERANCE = 0.01
_REALIZED_EPS = 0.005

_NOT_REACHED = {"reached": False, "hit_on": None, "hit_close": None,
                "peak_close": None, "peak_on": None, "qty_at_hit": None,
                "reduced": False}


def _held(entry: dict[str, Any], symbol: str) -> tuple[float, float] | None:
    """(quantity, close) when this snapshot holds the symbol long, else None."""
    row = (entry.get("stocks") or {}).get(symbol)
    try:
        qty, close = float(row[0]), float(row[1])
    except (TypeError, ValueError, IndexError):
        return None
    return (qty, close) if qty > 0 else None


def _live(account: dict[str, Any], symbol: str) -> tuple[float, float] | None:
    """(quantity, close) from the account's current statement, long only."""
    for stock in account.get("stocks") or []:
        if stock.get("symbol") == symbol and (stock.get("quantity") or 0) > 0:
            return float(stock["quantity"]), float(stock.get("close_price") or 0)
    return None


def _current_run(entries: list[dict[str, Any]], symbol: str) -> list[tuple[str, float, float]]:
    """(date, quantity, close) for the unbroken stretch up to the newest snapshot.

    Closing and reopening starts a new stretch, so a target this account
    reached on a position it has since sold is not reached on the new one.
    """
    run: list[tuple[str, float, float]] = []
    for entry in entries:
        row = _held(entry, symbol)
        if row:
            run.append((entry["date"], *row))
        else:
            run = []
    return run


def _plan_state(symbol: str, since: str, accounts: dict[str, dict[str, Any]],
                snapshots: dict[str, list[dict[str, Any]]]) -> str:
    """active: held now. pending: not held since it was set. expired: sold out.

    An expired plan stays expired when the name is bought back: a price written
    for one position says nothing about the next, and reviving it would judge
    the new position by a plan nobody looked at.

    Each account's last known state carries across a date it has no snapshot
    for, so one account's failed sync does not read as that account selling.
    The state carried into the day the plan was set counts as seen: a plan
    written while the name is held, then sold out before the next snapshot, has
    ended rather than gone back to waiting. The snapshots cannot tell that from
    a plan written after a same-day sale, which ends too; that one is visible
    in the dialog and costs a retype, where reviving the other would be silent.
    """
    events = sorted(
        (entry["date"], acct_id, _held(entry, symbol) is not None)
        for acct_id, entries in snapshots.items() for entry in entries)
    held: dict[str, bool] = {}
    seen = started = False
    for day, group in groupby(events, key=lambda event: event[0]):
        if day >= since and not started:
            started = True
            seen = any(held.values())
        for _, acct_id, is_held in group:
            held[acct_id] = is_held
        if day < since:
            continue
        if any(held.values()):
            seen = True
        elif seen:
            return "expired"
    if not started:
        seen = any(held.values())
    if any(_live(account, symbol) for account in accounts.values()):
        return "active"
    return "expired" if seen else "pending"


def _split_on(symbol: str, since: str, entries: list[dict[str, Any]]) -> str | None:
    """The date of the first split-shaped move after the plan was set, if any.

    After a split the plan's prices are in the old unit: a reverse split would
    read as every target reached at once and as the shares being sold, a
    forward split as targets that can never be reached. The last snapshot from
    before the plan is the baseline for the first one after it; a split already
    in the price on the day the plan was set is the unit it was written in.
    """
    def realized(entry: dict[str, Any]) -> float:
        row = (entry.get("perf") or {}).get(symbol) or [0.0]
        return float(row[0] or 0.0)

    def cost(entry: dict[str, Any]) -> float:
        """The position's total cost: market value less unrealized P/L."""
        try:
            row = entry["stocks"][symbol]
            return float(row[2]) - float(row[3])
        except (KeyError, TypeError, ValueError, IndexError):
            return 0.0

    prev_entry, prev_row = None, None
    for entry in entries:
        row = _held(entry, symbol)
        if entry["date"] > since and row and prev_row and row[1] > 0 and prev_row[1] > 0:
            qty_ratio = row[0] / prev_row[0]
            price_ratio = prev_row[1] / row[1]
            cost_now, cost_before = cost(entry), cost(prev_entry)
            if (abs(qty_ratio - 1) > _SPLIT_MIN_MOVE
                    and abs(qty_ratio / price_ratio - 1) < _SPLIT_TOLERANCE
                    and abs(realized(entry) - realized(prev_entry)) < _REALIZED_EPS
                    and cost_before > 0
                    and abs(cost_now / cost_before - 1) < _SPLIT_COST_TOLERANCE):
                return entry["date"]
        prev_entry, prev_row = entry, row
    return None


def _read_tier(tier: dict[str, Any], run: list[tuple[str, float, float]],
               live: tuple[float, float], as_of: str) -> dict[str, Any]:
    """One tier against one account's stretch of closes.

    The closes it is read against start with the last one before it was set:
    the price on screen when it was typed, so a target saved at or under the
    market is reached on that close, with that day's share count, for good.
    """
    price, set_on = tier["price"], tier["set_on"]
    qty_now, close_now = live
    first = next((i for i, (day, _, _) in enumerate(run) if day >= set_on), len(run))
    closes = run[max(first - 1, 0):]
    since_hit: list[tuple[str, float, float]] = []
    for i, (_, _, close) in enumerate(closes):
        if close >= price - _PRICE_EPS:
            since_hit = closes[i:]
            break
    if since_hit:
        hit_on, qty_at_hit, hit_close = since_hit[0]
    elif close_now >= price - _PRICE_EPS:
        # No dated close has got there, but the newest one is there: a
        # statement that could not be snapshotted. It is reached now.
        hit_on, qty_at_hit, hit_close = as_of or None, qty_now, close_now
    else:
        return {"price": price, **_NOT_REACHED}
    peak_on, peak_close = hit_on, hit_close
    for day, _, close in since_hit:
        if close > peak_close:
            peak_on, peak_close = day, close
    if close_now > peak_close:
        peak_on, peak_close = as_of or None, close_now
    # Sold into it once, handled for good: buying the shares back later is a
    # new decision, not the old reminder coming back.
    lowest = min([qty for _, qty, _ in since_hit] + [qty_now])
    return {"price": price, "reached": True, "hit_on": hit_on, "hit_close": hit_close,
            "peak_close": peak_close, "peak_on": peak_on, "qty_at_hit": qty_at_hit,
            "reduced": lowest < qty_at_hit - _QTY_EPS}


def evaluate_targets(symbols: dict[str, dict[str, Any]],
                     accounts: dict[str, dict[str, Any]],
                     snapshots: dict[str, list[dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    """Read every plan against the current statements and the snapshot history.

    `symbols` is the settings file's map, {SYM: {"tiers": [{"price", "set_on"}]}};
    `accounts` the current statement per account; `snapshots` each account's
    series, oldest first. Returns, per symbol, the plan's state and, for each
    account holding it, one reading per tier in the plan's order, each carrying
    the price it was read for.

    stale: the plan is older than what the snapshot files still hold. They keep
    MAX_KEEP entries, and once one has been cut, the closes, the sale or the
    split that decided this plan may be gone with it; reading what is left
    could drop a reached tier or revive an ended plan. A file that has not
    reached MAX_KEEP has not been cut, and whatever it starts with is all
    there is.
    """
    cut_from = max((entries[0]["date"] for entries in snapshots.values()
                    if len(entries) >= MAX_KEEP), default=None)
    out: dict[str, dict[str, Any]] = {}
    for symbol, plan in symbols.items():
        tiers = plan.get("tiers") or []
        if not tiers:
            continue
        since = min(tier["set_on"] for tier in tiers)
        if cut_from is not None and since <= cut_from:
            out[symbol] = {"state": "stale", "split_on": None, "accounts": {}}
            continue
        state = _plan_state(symbol, since, accounts, snapshots)
        split_on = None
        if state == "active":
            found = [day for day in (_split_on(symbol, since, entries)
                                     for entries in snapshots.values()) if day]
            if found:
                state, split_on = "split", min(found)
        per_account: dict[str, list[dict[str, Any]]] = {}
        if state == "active":
            for acct_id, account in accounts.items():
                live = _live(account, symbol)
                if live is None:
                    continue
                run = _current_run(snapshots.get(acct_id) or [], symbol)
                as_of = _as_of_date(account)
                per_account[acct_id] = [_read_tier(tier, run, live, as_of) for tier in tiers]
        out[symbol] = {"state": state, "split_on": split_on, "accounts": per_account}
    return out
