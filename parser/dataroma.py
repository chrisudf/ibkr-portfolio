"""Dataroma 13F activity scraper — what the superinvestors did last quarter.

The dashboard's own numbers say what *you* hold. This module fetches the other
half of the comparison: the quarterly 13F activity of the ~83 managers Dataroma
tracks, so a holding can be read against what large institutions did with the
same name in the most recent reported quarter.

Source of truth is Form 13F-HR, filed with the SEC 45 days after each quarter
end. That has three consequences the UI has to keep saying out loud:

  * It is a *quarter-end snapshot*, not a trade log. A position opened and
    closed inside the quarter never appears.
  * It is stale by up to 45 days on the day it lands, and by up to 135 days
    the day before the next one.
  * It covers long US equity positions only — no shorts, no options
    obligations, no bonds, no foreign listings. Half of this account's risk
    (26 short option contracts) is invisible to it by construction.

Two traps in Dataroma's HTML, both of which silently produce *plausible but
wrong* output rather than an error:

  1. **The activity table is capped at 100 rows per page** and is sorted by
     action type (Add → Buy → Reduce → Sell). Big books (First Eagle, Maverick,
     Polen, Dodge & Cox…) therefore lose their entire sell side if you only
     read page one. Measured on 2026-09-17: 3,178 rows unpaged vs 4,265 paged
     — the missing 1,087 were almost all Reduce/Sell, which biases every
     conclusion in one direction. Pagination is `&L=<n>&o=a`; the highest page
     number is in the pager links on page one.

  2. **Data rows have no opening `<tr>`.** A quarter block emits one `<tr>`
     for its header and then separates each data row with a bare `</tr>`.
     Pairing `<tr>...</tr>` matches only the quarter headers and yields zero
     data rows — a silent empty parse, not an exception. Split on `</tr>`.

Deliberately stdlib-only (urllib, re): the app ships Flask + pdfplumber and
this is not worth a third runtime dependency.
"""
from __future__ import annotations

import html as _html
import re
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Iterable

BASE = "https://www.dataroma.com/m"
MANAGERS_URL = f"{BASE}/managers.php"

# Dataroma 406s on a bare urllib UA. A normal browser string plus the referer
# it would have sent is enough; there is no bot wall beyond that.
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
_HEADERS = {"User-Agent": _UA, "Referer": MANAGERS_URL}

# Page one plus at most this many continuations. Dataroma's pager tops out at
# 10; the loop also stops as soon as a page rolls into an older quarter, so
# this is only a guard against a pager that grows.
MAX_PAGES = 12
# Rows Dataroma puts on one activity page. The whole reason this module pages
# at all: a manager with exactly this many rows is not "done", they are "cut".
PAGE_CAP = 100

_QUARTER_RE = re.compile(r"Q[1-4]\s+\d{4}")
_ACTIONS = ("Buy", "Add", "Reduce", "Sell")


class DataromaError(RuntimeError):
    """Fetch or parse failed in a way that should abort the whole pass."""


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def _get(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers=_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        raise DataromaError(f"GET {url} failed: {exc}") from exc


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------

def parse_managers(page: str) -> list[dict]:
    """Manager codes and names from the index page.

    The code is what every other URL keys on (`?m=psc`), and it is case
    sensitive — `psc` and `PSC` are not the same manager.
    """
    seen: dict[str, str] = {}
    for m in re.finditer(r'holdings\.php\?m=([^"&]+)"[^>]*>([^<]+)', page):
        code, name = m.group(1), _clean(m.group(2))
        if code and name:
            seen.setdefault(code, name)
    return [{"code": c, "name": n} for c, n in sorted(seen.items())]


def _clean(raw: str) -> str:
    return re.sub(r"\s+", " ", _html.unescape(raw).replace(" ", " ")).strip()


def _grid(page: str) -> str | None:
    m = re.search(r'<table[^>]*id="grid".*?</table>', page, re.S)
    return m.group(0) if m else None


def _cells(segment: str) -> list[str]:
    """Cell texts of one row segment.

    Lookahead rather than a closing tag: `</td>` is optional in this markup
    too, so a cell ends at the next `<td`, its own `</td>`, the row end, or
    the end of the segment.
    """
    out = []
    for cell in re.findall(r"<td[^>]*>(.*?)(?=<td\b|</td\s*>|</tr|$)", segment, re.S):
        out.append(_clean(re.sub(r"<[^>]+>", " ", cell)))
    return out


def parse_activity_page(page: str) -> tuple[str | None, list[dict]]:
    """First quarter block of one activity page.

    Returns (quarter label, rows). Rows after a *second* quarter header are
    dropped — each page repeats the header of whichever quarter it continues,
    so "the first block" is the right unit whether this is page 1 or page 4.
    """
    grid = _grid(page)
    if not grid:
        return None, []
    quarter: str | None = None
    started = False
    rows: list[dict] = []
    for seg in re.split(r"</tr\s*>", grid):
        seg = re.sub(r"^\s*<tr\b[^>]*>", "", seg)
        cells = _cells(seg)
        if not cells:
            continue
        hit = _QUARTER_RE.search(cells[0] or "") if len(cells) <= 2 else None
        if hit:
            if started:
                break            # rolled into an older quarter
            quarter = re.sub(r"\s+", " ", hit.group(0))
            started = True
            continue
        if not started or len(cells) < 5:
            continue
        symbol = cells[1]
        ticker = symbol.split(" - ")[0].strip()
        company = " - ".join(symbol.split(" - ")[1:]).strip()
        action = cells[2]
        kind = action.split()[0] if action else ""
        if kind not in _ACTIONS:
            continue
        pct_move = None
        mv = re.search(r"([\d.]+)\s*%", action)
        if mv:
            pct_move = float(mv.group(1))
        rows.append({
            "ticker": ticker,
            "company": company,
            "action": kind,
            "pct_move": pct_move,
            "shares": _int(cells[3]),
            "pct_port": _float(cells[4]),
        })
    return quarter, rows


def _int(raw: str) -> int:
    digits = re.sub(r"[^\d]", "", raw or "")
    return int(digits) if digits else 0


def _float(raw: str) -> float:
    try:
        return float(re.sub(r"[^\d.\-]", "", raw or "") or 0)
    except ValueError:
        return 0.0


def max_page(page: str) -> int:
    """Highest `&L=` in the pager links, or 1 when the table fits one page."""
    nums = [int(n) for n in re.findall(r"m_activity\.php\?m=[^\"&]+&typ=a&L=(\d+)", page)]
    return max(nums) if nums else 1


# --------------------------------------------------------------------------
# Fetch
# --------------------------------------------------------------------------

def fetch_manager(code: str, *, sleep: float = 0.3,
                  getter: Callable[[str], str] = _get) -> tuple[str | None, list[dict]]:
    """Every row of one manager's most recently reported quarter.

    Walks continuation pages until one no longer starts with the same quarter
    — that is the only reliable stop signal, because a manager with exactly
    100 rows in the quarter and a manager whose quarter spills onto page 2 are
    indistinguishable from page 1 alone.
    """
    first = getter(f"{BASE}/m_activity.php?m={code}&typ=a")
    quarter, rows = parse_activity_page(first)
    if quarter is None:
        return None, []
    # Only page 1 tells us how many pages exist at all.
    last = min(max_page(first), MAX_PAGES)
    seen = {(r["ticker"], r["action"], r["shares"]) for r in rows}
    page_len = len(rows)
    for page_no in range(2, last + 1):
        if page_len < PAGE_CAP:
            # The previous page came back short of the cap, so the quarter is
            # already complete — no continuation exists, and asking for one is
            # a wasted round trip against a stranger's server. Measured on the
            # page itself rather than on the running total: dedupe could drop
            # a row and make a cumulative count lie about whether page N was
            # full.
            break
        if sleep:
            time.sleep(sleep)
        more = getter(f"{BASE}/m_activity.php?m={code}&typ=a&L={page_no}&o=a")
        q2, rows2 = parse_activity_page(more)
        if q2 != quarter or not rows2:
            break
        page_len = len(rows2)
        for row in rows2:
            key = (row["ticker"], row["action"], row["shares"])
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
    return quarter, rows


def fetch_all(*, sleep: float = 0.3,
              progress: Callable[[int, int, str], None] | None = None,
              getter: Callable[[str], str] = _get) -> dict:
    """Scrape every manager and return the cache document.

    Takes roughly 90–150s for ~83 managers at the default delay, so callers
    should run it off the request thread.
    """
    managers = parse_managers(getter(MANAGERS_URL))
    if not managers:
        raise DataromaError("manager index returned no managers")
    rows: list[dict] = []
    meta: list[dict] = []
    total = len(managers)
    for i, mgr in enumerate(managers, 1):
        if sleep:
            time.sleep(sleep)
        try:
            quarter, mrows = fetch_manager(mgr["code"], sleep=sleep, getter=getter)
        except DataromaError:
            # One manager's page failing should not throw away the other 82.
            meta.append({**mgr, "quarter": None, "count": 0, "error": True})
            continue
        for row in mrows:
            rows.append({**row, "code": mgr["code"]})
        meta.append({**mgr, "quarter": quarter, "count": len(mrows)})
        if progress:
            progress(i, total, mgr["code"])
    return build_dataset(meta, rows)


# --------------------------------------------------------------------------
# Aggregation
# --------------------------------------------------------------------------

def modal_quarter(meta: Iterable[dict]) -> str | None:
    """The quarter most managers reported.

    Not `max()`: a handful of managers are always behind (a delinquent filer
    still shows Q3 of last year), and one stale outlier must not relabel the
    whole dataset. Not `min()` either, for the same reason in reverse.
    """
    counts: dict[str, int] = {}
    for m in meta:
        q = m.get("quarter")
        if q:
            counts[q] = counts.get(q, 0) + 1
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]


def build_dataset(meta: list[dict], rows: list[dict]) -> dict:
    """Cache document: per-ticker flows plus the metadata the UI narrates."""
    quarter = modal_quarter(meta)
    by_code = {m["code"]: m.get("quarter") for m in meta}
    flows: dict[str, dict] = {}
    for row in rows:
        # Managers who have not filed the current quarter yet would otherwise
        # contribute last quarter's trades to this quarter's totals.
        if by_code.get(row["code"]) != quarter:
            continue
        tk = row["ticker"]
        f = flows.get(tk)
        if f is None:
            f = flows[tk] = {"company": row["company"], "buy": 0, "add": 0,
                             "reduce": 0, "sell": 0, "shares_in": 0,
                             "shares_out": 0, "actors": []}
        f[row["action"].lower()] += 1
        if row["action"] in ("Buy", "Add"):
            f["shares_in"] += row["shares"]
        else:
            f["shares_out"] += row["shares"]
        f["actors"].append({
            "code": row["code"], "action": row["action"],
            "pct_move": row["pct_move"], "shares": row["shares"],
            "pct_port": row["pct_port"],
        })
    for f in flows.values():
        f["net_shares"] = f["shares_in"] - f["shares_out"]
        # Head count, signed: a new position or an exit is a stronger
        # statement than a trim, so both count double. Reported separately
        # from net_shares on purpose — the two disagree exactly when a few
        # large holders move against a crowd of small ones, which is the most
        # interesting case on the page and must not be averaged away.
        f["net_heads"] = 2 * f["buy"] + f["add"] - f["reduce"] - 2 * f["sell"]
        f["actors"].sort(key=lambda a: (_ACTIONS.index(a["action"]), -a["pct_port"]))
    end = quarter_end(quarter) if quarter else None
    return {
        "source": "dataroma.com",
        "form": "13F-HR",
        "fetched_at": _utc_now_iso(),
        "quarter": quarter,
        "as_of": end.isoformat() if end else None,
        "next_due": next_13f_deadline(end).isoformat() if end else None,
        "managers": meta,
        "flows": flows,
        "row_count": len(rows),
    }


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------
# 13F calendar
# --------------------------------------------------------------------------

def quarter_end(label: str) -> date | None:
    """`"Q2 2026"` → 2026-06-30."""
    m = re.match(r"Q([1-4])\s+(\d{4})", label or "")
    if not m:
        return None
    q, year = int(m.group(1)), int(m.group(2))
    month, day = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}[q]
    return date(year, month, day)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    d = date(year, month, 1)
    d += timedelta(days=(weekday - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def _federal_holidays(year: int) -> set[date]:
    """The US federal holidays that can fall on or next to a 13F deadline.

    Deadlines land around Feb 14, May 15, Aug 14 and Nov 14, so in practice
    only Presidents' Day and Veterans Day matter — but a holiday set that is
    "the ones we think matter" rots the moment a date shifts, so this is the
    full list, cheap to compute and impossible to get subtly wrong.
    """
    days = {
        date(year, 1, 1),                       # New Year's Day
        _nth_weekday(year, 1, 0, 3),            # MLK Day
        _nth_weekday(year, 2, 0, 3),            # Presidents' Day
        date(year, 6, 19),                      # Juneteenth
        date(year, 7, 4),                       # Independence Day
        _nth_weekday(year, 9, 0, 1),            # Labor Day
        date(year, 11, 11),                     # Veterans Day
        _nth_weekday(year, 11, 3, 4),           # Thanksgiving
        date(year, 12, 25),                     # Christmas
    }
    # Memorial Day = last Monday in May.
    d = date(year, 5, 31)
    days.add(d - timedelta(days=(d.weekday() - 0) % 7))
    # A holiday on a weekend is observed on the adjacent weekday.
    observed = set()
    for h in days:
        if h.weekday() == 5:
            observed.add(h - timedelta(days=1))
        elif h.weekday() == 6:
            observed.add(h + timedelta(days=1))
    return days | observed


def next_13f_deadline(quarter_end_date: date | None) -> date | None:
    """Filing deadline for the quarter *after* the one given.

    13F-HR is due 45 calendar days after quarter end, rolled forward to the
    next business day when that lands on a weekend or federal holiday.
    Verified against EDGAR: Q2 2026 was due Fri 2026-08-14 and Berkshire,
    Lone Pine, Southeastern and Bridgewater all filed on exactly that day;
    Q4 2025 fell on Sat 2026-02-14 and filings clustered on Fri 02-13 and
    Tue 02-17 (Mon 02-16 was Presidents' Day). Managers file *on* the
    deadline, not spread across the window — so this date, not some range,
    is when Dataroma's numbers change.
    """
    if quarter_end_date is None:
        return None
    nxt = _next_quarter_end(quarter_end_date)
    due = nxt + timedelta(days=45)
    holidays = _federal_holidays(due.year) | _federal_holidays(due.year + 1)
    while due.weekday() >= 5 or due in holidays:
        due += timedelta(days=1)
    return due


def _next_quarter_end(d: date) -> date:
    ends = [date(d.year, 3, 31), date(d.year, 6, 30),
            date(d.year, 9, 30), date(d.year, 12, 31)]
    for e in ends:
        if e > d:
            return e
    return date(d.year + 1, 3, 31)
