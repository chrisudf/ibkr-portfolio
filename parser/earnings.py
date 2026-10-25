"""Next earnings date per symbol, for the risk gate's "does this expiry cross
a report?" column.

Source is Nasdaq's public analyst endpoint (the one behind the earnings-date
box on nasdaq.com):

    https://api.nasdaq.com/api/analyst/{SYM}/earnings-date

It wants a browser User-Agent, and the way it says so is worth knowing: with
curl's or urllib's default UA the request is not refused, it simply hangs
until the client gives up (checked 2026-10-25: 20s and 15s, no answer). So
the short TIMEOUT_SEC below matters as much as the header — without it a
reshaped bot check would park a server thread per symbol.

Three answer shapes seen on 2026-10-25 (the first and the third also from
the droplet, so a datacenter IP is served):

  * a company:  data.reportText "... is expected* to report earnings on
    11/04/2026 after market close ..." — the date, plus the session when the
    company has announced one;
  * a company Nasdaq has no announced date for: "... is estimated to report
    earnings on 11/18/2026. The upcoming earnings date is derived from an
    algorithm based on a company's historical reporting dates ..." — kept, and
    flagged as estimated;
  * an ETF / unknown ticker: data null, status.rCode 400, bCodeMessage code
    1001 "Symbol not exists." — an answer ("Nasdaq has no such symbol"), not
    a failure.

What this module promises the UI is narrow on purpose: a date when Nasdaq gave
one, and otherwise a status that the dashboard renders as 未知. Nothing here
ever says "no earnings before expiry" — that is a conclusion the caller draws
from a date, and only from a date. A timeout, a 403, a reshaped page all come
back as status "error", never as an empty-but-successful answer, because the
one wrong reading this column must not produce is "this put is clear of
earnings" when the truth is "we could not find out".

Cached in uploads/.earnings_cache.json: an answer is good for a day (dates move
rarely and only ever by announcement), a failure is retried after an hour
rather than on every page load. When a retry fails, a previous answer whose
date is still ahead is served marked stale — yesterday's 11/04 is a better
answer than 未知, and the UI says how old it is.

Deliberately stdlib-only, like parser/dataroma.py.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

URL = "https://api.nasdaq.com/api/analyst/{sym}/earnings-date"

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
_HEADERS = {
    "User-Agent": _UA,
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.nasdaq.com",
    "Referer": "https://www.nasdaq.com/",
}

TIMEOUT_SEC = 10
MAX_WORKERS = 4
# "结果缓存一天": an answer is reused for this long, then asked again.
ANSWER_TTL = timedelta(hours=24)
# A failed symbol is not retried before this — a reload storm against a
# blocked endpoint would otherwise be one request per symbol per page view.
RETRY_AFTER = timedelta(hours=1)
# How old an answer may be and still stand in for a failed refetch.
STALE_MAX = timedelta(days=7)

# MM/DD/YYYY inside reportText; the announcement line ("Nov 04, 2026") is the
# fallback when the sentence is reworded.
_TEXT_DATE_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b")
_ANNOUNCE_RE = re.compile(r"\b([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})\b")
_MON = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)}

_cache_lock = threading.Lock()


def parse_response(payload) -> dict:
    """Nasdaq's envelope → {"status", "date", "timing", "estimated"}.

    status "ok" always carries an ISO date. "none" is Nasdaq answering that it
    has nothing — no such symbol, or a page without a date — and is cached
    like any answer. Anything else is not an answer at all and raises
    ValueError, so the caller records a failure instead of a blank.
    """
    if not isinstance(payload, dict):
        raise ValueError("response is not a JSON object")
    data = payload.get("data")
    status = payload.get("status") or {}
    if not data:
        codes = [m.get("code") for m in (status.get("bCodeMessage") or [])
                 if isinstance(m, dict)]
        if 1001 in codes:   # "Symbol not exists."
            return {"status": "none", "date": None, "timing": "", "estimated": False,
                    "note": "no such symbol"}
        raise ValueError(f"no data in response (rCode {status.get('rCode')!r})")
    if not isinstance(data, dict):
        raise ValueError("data is not an object")
    text = str(data.get("reportText") or "")
    iso = None
    m = _TEXT_DATE_RE.search(text)
    if m:
        iso = date(int(m.group(3)), int(m.group(1)), int(m.group(2))).isoformat()
    else:
        m = _ANNOUNCE_RE.search(str(data.get("announcement") or ""))
        if m and m.group(1) in _MON:
            iso = date(int(m.group(3)), _MON[m.group(1)], int(m.group(2))).isoformat()
    if not iso:
        return {"status": "none", "date": None, "timing": "", "estimated": False,
                "note": "no date on the page"}
    low = text.lower()
    timing = ("bmo" if "before market open" in low
              else "amc" if "after market close" in low else "")
    # "expected*" is a date the company put out; "estimated ... derived from
    # an algorithm" is Zacks guessing from the reporting history.
    estimated = "estimated" in low or "derived from an algorithm" in low
    return {"status": "ok", "date": iso, "timing": timing, "estimated": estimated}


def fetch_one(sym: str, timeout: float = TIMEOUT_SEC) -> dict:
    url = URL.format(sym=urllib.parse.quote(sym, safe=""))
    req = urllib.request.Request(url, headers=_HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    return parse_response(json.loads(body.decode("utf-8")))


def _ts(value) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value or "")
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _read_cache(path: Path) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_cache(path: Path, data: dict) -> None:
    # Same unique-temp + replace as app._atomic_write_json; duplicated rather
    # than imported so this module stays importable without Flask.
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=False)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _needs_fetch(entry: dict | None, now: datetime) -> bool:
    if not entry:
        return True
    answered = _ts(entry.get("answered_at"))
    if answered and now - answered < ANSWER_TTL:
        return False
    tried = _ts(entry.get("tried_at"))
    if entry.get("error") and tried and now - tried < RETRY_AFTER:
        return False
    return True


def _view(entry: dict | None, now: datetime) -> dict:
    """What the dashboard gets for one symbol."""
    unknown = {"status": "error", "date": None, "timing": "", "estimated": False}
    if not entry:
        return {**unknown, "error": "not fetched"}
    answer = entry.get("answer")
    answered = _ts(entry.get("answered_at"))
    if answer and answered and now - answered < ANSWER_TTL:
        return {**answer, "as_of": entry["answered_at"]}
    # The latest attempt failed. An earlier date that is still ahead of us
    # beats 未知 — but only a real date, and only while it is recent.
    if (answer and answer.get("status") == "ok" and answered
            and now - answered < STALE_MAX
            and (answer.get("date") or "") >= now.date().isoformat()):
        return {**answer, "as_of": entry["answered_at"], "stale": True}
    return {**unknown, "error": entry.get("error") or "unavailable"}


def _attempt(sym: str, fetch: Callable[[str], dict]) -> tuple[dict | None, str | None]:
    try:
        return fetch(sym), None
    except Exception as exc:  # noqa: BLE001 - one symbol must not sink the rest
        return None, f"{type(exc).__name__}: {exc}"[:200]


def lookup(symbols: list[str], cache_path: Path | str, now: datetime | None = None,
           fetch: Callable[[str], dict] = fetch_one) -> dict[str, dict]:
    """Cached earnings info for each symbol; fetches only what is due.

    The lock spans the fetch on purpose: two page loads arriving together
    should cost Nasdaq one round of requests, not two.
    """
    now = now or datetime.now(timezone.utc)
    path = Path(cache_path)
    with _cache_lock:
        cache = _read_cache(path)
        entries = cache.get("symbols")
        if not isinstance(entries, dict):
            entries = {}
        due = [s for s in symbols if _needs_fetch(entries.get(s), now)]
        if due:
            with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(due))) as pool:
                results = list(pool.map(lambda s: _attempt(s, fetch), due))
            stamp = now.isoformat(timespec="seconds")
            for sym, (answer, err) in zip(due, results):
                entry = entries.get(sym)
                if not isinstance(entry, dict):
                    entry = {}
                entry["tried_at"] = stamp
                if err is None:
                    entry["answer"] = answer
                    entry["answered_at"] = stamp
                    entry.pop("error", None)
                else:
                    entry["error"] = err
                entries[sym] = entry
            _write_cache(path, {"version": 1, "source": "nasdaq", "symbols": entries})
        return {s: _view(entries.get(s), now) for s in symbols}
