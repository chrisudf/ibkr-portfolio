"""Underlying closes for option deltas — Yahoo daily bars, cached per statement date.

Why a second price source at all
--------------------------------
A delta needs the underlying's price. The Flex statement carries a mark only
for what an account holds, so a name traded purely through options has no
price anywhere in it — on the 2026-11-05 book that was SOXL, COHR, ORCL and
RKLB, which between them carry most of the short-put notional. The other
panels get by without one (margin assumes at-the-money, the expiry calendar
guesses ITM from the option's own mark); a delta cannot, because how far in
or out of the money the strike sits is the whole of what it measures.

Same day as the statement, never "latest"
-----------------------------------------
The option marks in the statement are that day's closes, and the implied vol
is solved from the mark against the spot. Pair the mark with a spot from
another day and the move between the two days is priced into the vol: SOXL
closed 40.87 on 2026-11-05 and 45.97 the next day, and the 58-strike put's
11-05 mark (20.74) reads 154% vol and a −0.65 delta against its own day's
close but 203% and −0.49 against the next — a quarter of the position's
delta gone, with nothing on screen to say so. So every statement date gets
its own close: the last daily bar ON OR BEFORE that date (IBKR also books a
NAV row on US market holidays, when the marks are the previous session's).

What is asked, and what is kept
-------------------------------
Only names that no account holds as stock on that date are fetched: the
statement's own stock marks price the rest, and sending Yahoo every ticker in
the book would tell it more than the panel needs. Only the ticker leaves the
server — no quantity, no account.

A completed session's close never changes, so it is fetched once and kept for
as long as some account still reports that date; the cache holds nothing else.
A bar fetched while the date is still today (UTC) may be the live session, so
it is kept as provisional and asked for again after PROVISIONAL_TTL_SEC.

Yahoo's chart endpoint answers a bare `Python-urllib` user agent with 429 (seen
from the droplet on 2026-10-23, while a browser string got 200 from both the
droplet and a home connection), so the request carries a browser UA.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Any, Callable

from .snapshots import _as_of_date

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")

# How far a bar may sit behind the statement date and still be "that day's
# close": a holiday Friday plus the weekend is 3 days, Thanksgiving + weekend
# 4. Anything older means the name stopped trading or Yahoo has a hole, and
# pricing the statement's option marks against it would be the stale-spot
# mistake the module docstring describes.
MAX_BAR_GAP_DAYS = 5

# A failed lookup is retried after this long rather than on every page load —
# a ticker Yahoo does not know, or a Yahoo outage, would otherwise be asked
# for again on each render of the panel.
MISS_RETRY_SEC = 15 * 60

# A bar fetched while the statement date is still today (UTC) may be the live
# session. It is used, and asked for again after this long until the date has
# passed and the close is final.
PROVISIONAL_TTL_SEC = 30 * 60

# Parallel requests per pass. The usual pass is a handful of names, once per
# statement date.
_MAX_WORKERS = 4


class QuoteError(RuntimeError):
    """One symbol could not be priced; the panel names it and leaves it out."""


def yahoo_symbol(symbol: str) -> str:
    """IBKR's spelling of a ticker → Yahoo's.

    Share classes are the only difference that reaches a US option underlying:
    IBKR writes "BRK B" (and some layouts "BRK.B"), Yahoo wants "BRK-B".
    """
    return "-".join(symbol.strip().upper().replace(".", " ").split())


def parse_daily_closes(payload: dict) -> list[tuple[str, float]]:
    """`[(YYYY-MM-DD, close), ...]` in date order from a chart response.

    Raw closes, not `adjclose`: a strike is struck against the price that
    traded, and the dividend adjustment rewrites history below every
    ex-date. Bars are dated by the exchange's own clock (`gmtoffset`) —
    Yahoo stamps a daily bar at the session open, which in UTC can fall on
    either side of midnight depending on the venue. Bars without a close
    (Yahoo pads the live session with nulls) are dropped.
    """
    chart = (payload or {}).get("chart") or {}
    if chart.get("error"):
        err = chart["error"]
        raise QuoteError(f"{err.get('code')}: {err.get('description')}")
    results = chart.get("result") or []
    if not results:
        raise QuoteError("empty chart result")
    res = results[0] or {}
    offset = int((res.get("meta") or {}).get("gmtoffset") or 0)
    stamps = res.get("timestamp") or []
    quote = (((res.get("indicators") or {}).get("quote") or [{}])[0]) or {}
    rows: dict[str, float] = {}
    for ts, px in zip(stamps, quote.get("close") or []):
        if px is None or not px > 0:
            continue
        day = datetime.fromtimestamp(ts + offset, timezone.utc).date().isoformat()
        rows[day] = float(px)            # a repeated day keeps the later bar
    return sorted(rows.items())


def fetch_daily_closes(symbol: str, day: date, timeout: float = 10) -> list[tuple[str, float]]:
    """Daily closes for `symbol` over the few sessions up to and including `day`."""
    start = day - timedelta(days=MAX_BAR_GAP_DAYS + 3)
    # period2 is exclusive: midnight UTC after `day` keeps that day's bar
    # (stamped at its session open) and nothing later.
    query = urllib.parse.urlencode({
        "period1": int(datetime.combine(start, dtime(), timezone.utc).timestamp()),
        "period2": int(datetime.combine(day + timedelta(days=1), dtime(),
                                        timezone.utc).timestamp()),
        "interval": "1d",
    })
    url = (CHART_URL.format(symbol=urllib.parse.quote(yahoo_symbol(symbol)))
           + "?" + query)
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        # An unknown ticker comes back as a 404 whose body is a normal chart
        # error envelope — its description is the useful part.
        try:
            parse_daily_closes(json.loads(exc.read().decode("utf-8", "replace")))
        except QuoteError as inner:
            raise QuoteError(f"HTTP {exc.code}（{inner}）") from exc
        except (ValueError, OSError):
            pass
        raise QuoteError(f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        raise QuoteError(str(getattr(exc, "reason", None) or exc)) from exc
    return parse_daily_closes(payload)


def close_on_or_before(rows: list[tuple[str, float]], day: str) -> tuple[str, float] | None:
    """The last bar dated `day` or earlier, if it is recent enough to be that day's price."""
    best = None
    for bar_day, px in rows:
        if bar_day <= day:
            best = (bar_day, px)
    if best is None:
        return None
    gap = (date.fromisoformat(day) - date.fromisoformat(best[0])).days
    return best if gap <= MAX_BAR_GAP_DAYS else None


def needed_closes(accounts: dict[str, dict]) -> tuple[dict[str, str], dict[str, list[str]]]:
    """Which closes the delta panel needs: `({acct: as_of}, {as_of: [symbols]})`.

    An option underlying needs one unless some account dated the same day
    holds it as stock, whose statement mark prices it. Pooled only within a
    date: a stock mark from an account whose statement is a day behind is
    the wrong day's price for the other account's option marks.
    """
    dates: dict[str, str] = {}
    held: dict[str, set[str]] = {}
    for acct_id, acct in accounts.items():
        day = _as_of_date(acct)
        if not day:
            continue
        dates[acct_id] = day
        held.setdefault(day, set()).update(
            s.get("symbol") for s in acct.get("stocks") or []
            if (s.get("close_price") or 0) > 0)
    need: dict[str, set[str]] = {}
    for acct_id, day in dates.items():
        for opt in accounts[acct_id].get("options") or []:
            sym = (opt.get("underlying") or "").strip()
            if sym and sym not in held[day]:
                need.setdefault(day, set()).add(sym)
    return dates, {day: sorted(syms) for day, syms in sorted(need.items())}


def resolve_closes(need: dict[str, list[str]], cache: dict[str, Any] | None, *,
                   fetch: Callable[[str, date], list[tuple[str, float]]] = fetch_daily_closes,
                   now: float | None = None,
                   today: str | None = None) -> tuple[dict, dict, dict]:
    """Serve `need` from the cache, fetching only what is missing or provisional.

    Returns `(closes, misses, new_cache)`:
      closes  {day: {sym: {"close", "bar", "final", "at"}}}
      misses  {day: {sym: {"error", "at"}}}
    `new_cache` holds exactly the requested pairs, so dates no account reports
    any more fall out of the file on the next pass.
    """
    now = time.time() if now is None else now
    today = today or datetime.now(timezone.utc).date().isoformat()
    cache = cache if isinstance(cache, dict) else {}
    old_closes = cache.get("closes") if isinstance(cache.get("closes"), dict) else {}
    old_misses = cache.get("misses") if isinstance(cache.get("misses"), dict) else {}

    def cached(table: dict, day: str, sym: str) -> dict | None:
        entry = (table.get(day) if isinstance(table.get(day), dict) else {}).get(sym)
        return entry if isinstance(entry, dict) else None

    closes: dict[str, dict] = {}
    misses: dict[str, dict] = {}
    todo: list[tuple[str, str]] = []
    for day, syms in need.items():
        for sym in syms:
            hit = cached(old_closes, day, sym)
            if (hit and isinstance(hit.get("close"), (int, float)) and hit["close"] > 0
                    and (hit.get("final") or now - (hit.get("at") or 0) < PROVISIONAL_TTL_SEC)):
                closes.setdefault(day, {})[sym] = hit
                continue
            miss = cached(old_misses, day, sym)
            if miss and now - (miss.get("at") or 0) < MISS_RETRY_SEC:
                misses.setdefault(day, {})[sym] = miss
                continue
            todo.append((day, sym))

    def work(item: tuple[str, str]):
        day, sym = item
        try:
            got = close_on_or_before(fetch(sym, date.fromisoformat(day)), day)
        except QuoteError as exc:
            return item, None, str(exc)
        except Exception as exc:  # noqa: BLE001 - one bad name must not sink the pass
            return item, None, f"{type(exc).__name__}: {exc}"
        if got is None:
            return item, None, f"Yahoo 没有 {day} 或之前几天的收盘价"
        return item, got, None

    if todo:
        with ThreadPoolExecutor(max_workers=min(_MAX_WORKERS, len(todo))) as pool:
            results = list(pool.map(work, todo))
        for (day, sym), got, err in results:
            if got is not None:
                bar_day, px = got
                closes.setdefault(day, {})[sym] = {
                    "close": px, "bar": bar_day, "final": day < today, "at": now}
            else:
                misses.setdefault(day, {})[sym] = {"error": err, "at": now}

    new_cache = {"version": 1, "closes": closes, "misses": misses}
    return closes, misses, new_cache
