"""Benchmark prices for the share snapshot — QQQ / SPY over the NAV window.

The snapshot puts the account's time-weighted return next to an index over
the same dates, so a "+30%" can be read against what simply holding the index
would have done. Two choices make that comparison fair rather than flattering:

  - **Adjusted close, not close.** The account's TWR includes the dividends it
    received; an index line built from raw closes would leave out the index's
    own yield (about half a percent a year for QQQ, more for SPY) and quietly
    tilt the comparison toward the account. Yahoo's `adjclose` reinvests
    distributions, which is the total return the TWR is measured against.

  - **Dated by the exchange, not by UTC.** Yahoo stamps each daily bar at the
    session open (09:30 New York); shifting by the exchange's `gmtoffset`
    before taking the date keeps every bar on its own trading day whichever
    side of daylight saving the window crosses.

Yahoo's chart endpoint answers a bare `Python-urllib` user agent with 429 (it
did from the droplet on 2026-10-23, while a browser string got 200 from both
the droplet and a home connection), so the request carries a browser UA.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, time as dtime, timedelta, timezone

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")


class BenchmarkError(RuntimeError):
    """Fetch or parse failed; the snapshot renders without that benchmark."""


def parse_chart(payload: dict) -> list[list]:
    """`[[YYYY-MM-DD, adjclose], ...]` in date order from a chart response.

    Bars with no adjusted close (Yahoo pads the live session with nulls) are
    dropped rather than forward-filled — the caller aligns onto NAV dates and
    does its own carrying, so a fabricated price here would only hide a gap.
    """
    chart = (payload or {}).get("chart") or {}
    if chart.get("error"):
        err = chart["error"]
        raise BenchmarkError(f"{err.get('code')}: {err.get('description')}")
    results = chart.get("result") or []
    if not results:
        raise BenchmarkError("empty chart result")
    res = results[0]
    offset = int((res.get("meta") or {}).get("gmtoffset") or 0)
    stamps = res.get("timestamp") or []
    adj = (((res.get("indicators") or {}).get("adjclose") or [{}])[0]
           .get("adjclose") or [])
    rows: dict[str, float] = {}
    for ts, px in zip(stamps, adj):
        if px is None or px <= 0:
            continue
        day = datetime.fromtimestamp(ts + offset, timezone.utc).date().isoformat()
        rows[day] = float(px)            # a repeated day keeps the later bar
    if not rows:
        raise BenchmarkError("no adjusted closes in chart result")
    return [[d, rows[d]] for d in sorted(rows)]


def fetch_adjusted_closes(symbol: str, start: date, end: date,
                          timeout: int = 15) -> list[list]:
    """Daily adjusted closes for `symbol` from `start` through `end`."""
    # period2 is exclusive at the second; reaching into the next day makes
    # sure `end`'s own bar is included whatever hour Yahoo stamped it with.
    p1 = int(datetime.combine(start, dtime(), timezone.utc).timestamp())
    p2 = int(datetime.combine(end + timedelta(days=1), dtime(), timezone.utc).timestamp())
    query = urllib.parse.urlencode({
        "period1": p1, "period2": p2, "interval": "1d",
        "events": "div,split", "includeAdjustedClose": "true",
    })
    url = CHART_URL.format(symbol=urllib.parse.quote(symbol)) + "?" + query
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        # Yahoo also answers unknown symbols with a 404 whose body is a normal
        # chart error envelope — surface its description when there is one.
        try:
            parse_chart(json.loads(exc.read().decode("utf-8", "replace")))
        except BenchmarkError as inner:
            raise BenchmarkError(f"{symbol}: HTTP {exc.code} ({inner})") from exc
        except (ValueError, OSError):
            pass
        raise BenchmarkError(f"{symbol}: HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise BenchmarkError(f"{symbol}: {exc}") from exc
    return parse_chart(payload)
