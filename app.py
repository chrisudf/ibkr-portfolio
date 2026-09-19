"""IBKR Portfolio Dashboard — Flask app.

Run:
    pip install -r requirements.txt
    python app.py
Then open http://127.0.0.1:5050/
"""
from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from threading import Lock

from flask import Flask, jsonify, render_template, request

from parser import parse_ibkr_auto, parse_ibkr_pdf
from parser.flex_fetch import (FLEX_BUDGET_SEC, FLEX_CONFIG_NOTES,
                               FLEX_MAX_POLLS, FLEX_POLL_INTERVAL,
                               FlexFetchError, fetch_one, parse_accounts_env)
from parser.dataroma import fetch_all as fetch_all_13f
from parser.ibkr_flex_csv import describe_sections
from parser.snapshots import load_snapshots, record_snapshot

BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
# Per-account state files: uploads/U17456181.json etc.
# Legacy single-file (last_portfolio.json) is still read for backward compat.
LEGACY_STATE_FILE = UPLOAD_DIR / "last_portfolio.json"

app = Flask(__name__, template_folder=str(BASE_DIR / "templates"), static_folder=str(BASE_DIR / "static"))
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB

# Under gunicorn, Flask's logger sits at NOTSET and inherits the root's
# WARNING, which would swallow the refresh diagnostics at exactly the moment
# they matter (a *successful* fetch logs the section list at INFO). Opt in
# explicitly, and borrow gunicorn's handlers when it is the one serving so the
# lines land in the same stream as the access log.
_gunicorn_logger = logging.getLogger("gunicorn.error")
if _gunicorn_logger.handlers:
    app.logger.handlers = _gunicorn_logger.handlers
app.logger.setLevel(logging.INFO)

# The budget is env-tunable now, so the number that will actually govern
# tonight's syncs has to be readable without guessing which env reached the
# container. Clamp notes first — a corrected value is worth a WARNING.
for _note in FLEX_CONFIG_NOTES:
    app.logger.warning("[flex-config] %s", _note)
app.logger.info("[flex-config] poll budget %ss (%s polls x %ss)",
                FLEX_BUDGET_SEC, FLEX_MAX_POLLS, FLEX_POLL_INTERVAL)

# Minimum gap between /api/refresh attempts (gating is on attempt-start,
# regardless of success or failure). Prevents button-spam from chewing
# through IBKR's per-query throttle quota — IBKR locks a query for ~30 min
# if hit too often, success or not, so we cool down on every attempt.
#
# Measured from when an attempt ENDS, not when it starts. Starting the clock at
# the start conflates two different things and gets both wrong: the constant
# then has to cover the longest possible fetch, which punishes the common fast
# case (a 2-minute success would owe the rest of the window before you could
# ask again), and if it is ever set to exactly the poll budget the gap
# collapses to zero — which is the bug that took syncing down on 2026-08-28/29.
# A fetch that gave up after its full budget left IBKR still generating, the
# cooldown expired in the same instant, and the next request was answered 1001
# ("could not be generated at this time"); every timeout planted the refusal
# that greeted the next attempt.
#
# Gating on the end makes the guarantee independent of how long a fetch runs:
# a slow attempt provides its own spacing and still owes this gap afterwards,
# so a timed-out generation always gets room to finish before anything asks
# again, and a fast success is only held for this long.
REFRESH_MIN_INTERVAL_SEC = 5 * 60
# In-process state: only authoritative because the Dockerfile runs a single
# Gunicorn worker (threads share this dict). Adding workers would need a
# cross-process lock (file lock / redis) instead.
# last_finished starts at 0.0 so the first refresh after a boot is never held.
_refresh_state = {
    "last_finished": 0.0,
    "in_progress": False,
    "started_at": 0.0,
    "trigger": "",
    # Monotonic id per claimed pass. The button keeps the id it started, so a
    # completed result can be told apart from one left over by an earlier run
    # (or by the scheduler) — otherwise a page reload replays a stale toast.
    "run_id": 0,
    "last_result": None,
    "last_result_at": "",
    "last_result_run_id": 0,
}
_refresh_lock = Lock()

# Account ids become filenames (uploads/{id}.json) and come from parsed
# user uploads, so anything outside this alphabet is rejected — blocks
# path traversal via a crafted ClientAccountID. Real IBKR ids (U1234567,
# DU1234567) and our "default" fallback all pass.
_ACCT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def _atomic_write_json(path: Path, data, indent: int | None = None) -> None:
    """Write JSON through a unique temp file + os.replace.

    The temp name must be unique per writer, not a fixed "<name>.tmp":
    upload, refresh and the auto-sync thread all write into UPLOAD_DIR
    concurrently, and two writers sharing one temp path would interleave
    their json.dump output and publish a corrupt file. With mkstemp each
    writer replaces from its own file and the outcome is last-writer-wins.
    """
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=False, indent=indent)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _save_accounts(payload: dict) -> tuple[list[str], list[str]]:
    """Write per-account JSON files; returns (saved, skipped) account ids.

    Writes go through _atomic_write_json so a concurrent reader never sees
    a half-written JSON (upload, refresh and the auto-sync thread all write
    into UPLOAD_DIR from different threads).
    """
    saved: list[str] = []
    skipped: list[str] = []
    for acct_id, data in (payload.get("accounts") or {}).items():
        if not _ACCT_ID_RE.match(acct_id or ""):
            app.logger.warning("refusing to save account with unsafe id %r", acct_id)
            skipped.append(str(acct_id))
            continue
        _atomic_write_json(UPLOAD_DIR / f"{acct_id}.json", data, indent=2)
        # Weekly-recap raw material. A snapshot failure must never fail the
        # upload that produced perfectly good account data.
        try:
            record_snapshot(UPLOAD_DIR, acct_id, data)
        except Exception:
            app.logger.exception("snapshot record failed for %s", acct_id)
        saved.append(acct_id)
    return saved, skipped


@app.get("/")
def index():
    return render_template("dashboard.html")


def _load_all_accounts() -> dict:
    """Read every per-account uploads/*.json into a multi-account payload.

    Matches all JSON files (not just U*.json) so accounts saved under the
    "default" fallback id still show up; only the legacy single-portfolio
    file is excluded.
    """
    accounts: dict[str, dict] = {}
    for path in sorted(UPLOAD_DIR.glob("*.json")):
        if path.name == LEGACY_STATE_FILE.name or path.name.startswith("."):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                accounts[path.stem] = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        # Attach the snapshot series (weekly recap baseline candidates).
        # Read-time attach keeps the account JSON itself snapshot-free.
        accounts[path.stem]["snapshots"] = load_snapshots(UPLOAD_DIR, path.stem)
    # Backward compat: migrate the legacy single-portfolio file if present
    # and no per-account files exist yet.
    if not accounts and LEGACY_STATE_FILE.exists():
        with open(LEGACY_STATE_FILE, "r", encoding="utf-8") as f:
            legacy = json.load(f)
        acct_id = (legacy.get("account") or {}).get("Account") or "default"
        accounts[acct_id] = legacy
    return accounts


@app.get("/api/portfolio")
def get_portfolio():
    accounts = _load_all_accounts()
    if not accounts:
        return jsonify({"empty": True})
    payload: dict = {"accounts": accounts}
    # Auto-sync visibility: mode + last attempt/result, so "is the unattended
    # sync alive" is answerable from the dashboard instead of ssh + logs
    # (the failure mode that killed the cron era).
    state = _read_sync_state()
    if AUTO_SYNC in ("daily", "weekly") or state:
        # The LIVE env decides the mode shown — a stale state file from a
        # since-disabled schedule must not keep advertising "每日".
        payload["sync"] = {**state, "mode": AUTO_SYNC}
    return jsonify(payload)


@app.post("/api/upload")
def upload():
    if "file" not in request.files:
        return jsonify({"error": "no file provided"}), 400
    f = request.files["file"]
    name = (f.filename or "").lower()
    if not name:
        return jsonify({"error": "empty filename"}), 400

    try:
        if name.endswith(".csv"):
            raw = f.read().decode("utf-8-sig", errors="replace")
            payload = parse_ibkr_auto(raw)
        elif name.endswith(".pdf"):
            single = parse_ibkr_pdf(f.read())
            acct_id = (single.get("account") or {}).get("Account") or "default"
            payload = {"accounts": {acct_id: single}}
        else:
            return jsonify({"error": "unsupported file type, please upload .csv or .pdf"}), 400
    except Exception as exc:  # pragma: no cover - surface parsing errors to UI
        return jsonify({"error": f"parse failed: {exc}"}), 400

    saved, skipped = _save_accounts(payload)
    # Nothing saved is a failure regardless of *why* — the old guard
    # (`skipped and not saved`) let a statement that parsed to zero accounts
    # (every section unrecognized, or blank ClientAccountIDs) return
    # ok:true, and the UI printed 已更新 ✓ while uploads/ was never touched.
    if not saved:
        msg = ("statement contains no valid account ids" if skipped
               else "statement parsed but contained no account data "
                    "(no recognizable sections or account ids)")
        return jsonify({"error": msg}), 400

    resp = {"ok": True, "accounts": saved}
    if skipped:
        resp["skipped"] = skipped
    return jsonify(resp)


# --- Position settings: core holdings + per-symbol weight caps -------------
#
# Which underlyings are "core" (a position you intend to keep) and the target
# band each one should sit in, as a share of total NAV. Both ends are free
# numbers and both are optional — see _position_bound.
# Stored server-side rather than in localStorage: the dashboard is reached
# from more than one browser/device against the same droplet, and a config
# that silently differs per browser would make the treemap badges say
# different things depending on where you opened it.
#
# The leading dot keeps the file out of _load_all_accounts' uploads/*.json
# sweep — without it the config would show up as a phantom account in the
# switcher. .gitignore's `uploads/*.json` still matches it (gitignore globs,
# unlike the shell, do match a leading dot).
POSITION_SETTINGS_FILE = UPLOAD_DIR / ".position_settings.json"

# Symbols are underlyings (equity tickers), uppercased before matching.
# Deliberately narrow: these strings are echoed back into the dashboard.
_SYMBOL_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,15}$")


def _position_bound(key: str, field: str, raw) -> float | None:
    """One end of a target band, as a fraction of NAV; None when left blank.

    None is not the same as a number and is worth keeping distinct all the
    way to storage: it is what makes "configured" separable from "never
    touched". The dashboard resolves a blank 'min' to 0 and a blank 'max' to
    1 — bounds no position can breach — so an unfilled box means that side
    simply never fires, and a fresh install warns about nothing.
    """
    if raw is None or raw == "":
        return None
    try:
        val = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{key}: '{field}' must be a number or null") from None
    if val != val or val in (float("inf"), float("-inf")):   # NaN / ±inf
        raise ValueError(f"{key}: '{field}' must be a finite number")
    # 6dp keeps 0.075 (7.5%) and finer exact without storing float noise
    # like 0.07500000000000001 back into the file.
    val = round(val, 6)
    if not 0.0 <= val <= 1.0:
        # 10 instead of 0.10 is the mistake worth naming — the UI speaks in
        # percent and the wire format is a fraction.
        raise ValueError(
            f"{key}: '{field}' must be between 0 and 1 (a fraction of NAV, "
            f"not a percentage); got {raw!r}")
    return val


def _normalize_position_settings(raw: dict) -> dict[str, dict]:
    """Validate a {symbol: {core, min, max}} map; raise ValueError on bad input.

    Entries that carry no information (not core, neither bound filled in) are
    dropped so the stored file only holds real decisions — a symbol absent
    from the map and a symbol with everything left at its default behave
    identically, so there is nothing to lose by not writing it.
    """
    symbols = raw.get("symbols")
    if not isinstance(symbols, dict):
        raise ValueError("body must be an object with a 'symbols' map")
    if len(symbols) > 500:
        raise ValueError("too many symbols")
    out: dict[str, dict] = {}
    for sym, cfg in symbols.items():
        key = str(sym or "").strip().upper()
        if not _SYMBOL_RE.match(key):
            raise ValueError(f"invalid symbol {sym!r}")
        if not isinstance(cfg, dict):
            raise ValueError(f"{key}: entry must be an object")
        core = cfg.get("core", False)
        if not isinstance(core, bool):
            raise ValueError(f"{key}: 'core' must be a boolean")
        lo = _position_bound(key, "min", cfg.get("min"))
        hi = _position_bound(key, "max", cfg.get("max"))
        if lo is not None and hi is not None and lo > hi:
            raise ValueError(
                f"{key}: 'min' ({lo}) must not exceed 'max' ({hi})")
        if not core and lo is None and hi is None:
            continue
        out[key] = {"core": core, "min": lo, "max": hi}
    return out


# Every response carries the same keys — an absent updated_at on the empty
# path and a present one on the success path would push a shape check into
# the client for no reason.
def _blank_position_settings() -> dict:
    return {"version": 1, "symbols": {}, "updated_at": ""}


def _read_position_settings() -> dict:
    try:
        with open(POSITION_SETTINGS_FILE, "r", encoding="utf-8") as f:
            stored = json.load(f)
    except (OSError, json.JSONDecodeError):
        return _blank_position_settings()
    if not isinstance(stored, dict):
        return _blank_position_settings()
    try:
        symbols = _normalize_position_settings(stored)
    except ValueError:
        # A hand-edited file that no longer validates must not take the
        # dashboard down — fall back to "nothing configured" and say so.
        app.logger.warning("position settings file is invalid; ignoring it")
        return _blank_position_settings()
    return {"version": 1, "symbols": symbols,
            "updated_at": stored.get("updated_at") or ""}


@app.get("/api/settings/positions")
def get_position_settings():
    return jsonify(_read_position_settings())


@app.put("/api/settings/positions")
def put_position_settings():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "expected a JSON object"}), 400
    try:
        symbols = _normalize_position_settings(body)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    payload = {
        "version": 1,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "symbols": symbols,
    }
    _atomic_write_json(POSITION_SETTINGS_FILE, payload, indent=2)
    return jsonify(payload)


# ---------------------------------------------------------------------------
# 13F superinvestor overlay
#
# Separate from the IBKR sync in every way that matters: a different source, a
# different cadence (quarterly, not daily), and no quota to burn — Dataroma is
# a public page with no throttle, so the "don't press refresh" rule that
# governs /api/refresh does not apply here. The cache is still a file rather
# than a per-request fetch because a full pass is ~83 managers plus
# continuation pages, i.e. 90-150 seconds, which no page load should wear.
# ---------------------------------------------------------------------------

DATAROMA_CACHE = UPLOAD_DIR / ".dataroma_cache.json"

_dataroma_lock = Lock()
_dataroma_state: dict = {"in_progress": False, "done": 0, "total": 0,
                         "started_at": None, "error": None, "finished_at": None}


def _read_dataroma() -> dict | None:
    try:
        with DATAROMA_CACHE.open(encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _dataroma_work() -> None:
    """One full scrape, then publish atomically. Runs off the request thread."""
    def progress(done: int, total: int, _code: str) -> None:
        with _dataroma_lock:
            _dataroma_state["done"] = done
            _dataroma_state["total"] = total

    try:
        data = fetch_all_13f(progress=progress)
        _atomic_write_json(DATAROMA_CACHE, data)
        with _dataroma_lock:
            _dataroma_state["error"] = None
        app.logger.info("[13f] %s: %d rows across %d managers",
                        data.get("quarter"), data.get("row_count", 0),
                        len(data.get("managers", [])))
    except Exception as exc:  # noqa: BLE001 - surfaced to the UI verbatim
        app.logger.exception("[13f] scrape failed")
        with _dataroma_lock:
            _dataroma_state["error"] = str(exc)
    finally:
        with _dataroma_lock:
            _dataroma_state["in_progress"] = False
            _dataroma_state["finished_at"] = time.time()


@app.get("/api/superinvestors")
def superinvestors():
    """Cached 13F flows, or an empty envelope telling the UI to offer a fetch.

    `stale` is quarter-based, not age-based: a cache fetched five months ago
    is perfectly current right up until the next filing deadline passes, and
    nagging about its age in the meantime would train the user to ignore the
    banner that matters.
    """
    # Sent whole, all ~690KB of it. Trimming each ticker's actor list to the
    # few the panel renders was tried and reverted: Caddy already gzips
    # (`encode gzip`), which takes the body to ~104KB, and the trim only moved
    # that to ~99KB — 5KB is not worth a projection layer that can silently
    # drop the wrong side of a ticker.
    data = _read_dataroma()
    if data is None:
        return jsonify({"empty": True})
    due = data.get("next_due")
    data["stale"] = bool(due and date.today().isoformat() >= due)
    return jsonify(data)


@app.post("/api/superinvestors/refresh")
def superinvestors_refresh():
    with _dataroma_lock:
        if _dataroma_state["in_progress"]:
            return jsonify({"error": "already in progress"}), 409
        _dataroma_state.update({"in_progress": True, "done": 0, "total": 0,
                                "started_at": time.time(), "error": None,
                                "finished_at": None})
    try:
        threading.Thread(target=_dataroma_work, daemon=True, name="13f-scrape").start()
    except Exception:
        # Same claim..start gap the IBKR refresh guards: without this the slot
        # would stay held for the life of the process and every later press
        # would 409 with nothing actually running.
        app.logger.exception("[13f] worker thread failed to start")
        with _dataroma_lock:
            _dataroma_state["in_progress"] = False
        return jsonify({"error": "could not start 13F worker"}), 500
    return jsonify({"started": True}), 202


@app.get("/api/superinvestors/status")
def superinvestors_status():
    with _dataroma_lock:
        st = dict(_dataroma_state)
    out = {"in_progress": st["in_progress"], "done": st["done"],
           "total": st["total"], "error": st["error"]}
    if st["in_progress"] and st["started_at"]:
        out["elapsed_sec"] = int(time.time() - st["started_at"])
    return jsonify(out)


def _pass_budget_sec(specs: list) -> int:
    """Wall-clock ceiling for a whole pass, not for one query.

    _refresh_work fetches specs serially and each fetch_one gets the FULL
    per-query budget, so two accounts can burn twice FLEX_BUDGET_SEC. The
    button prints this number as "最长 N"; advertising the per-query figure
    would promise 45 minutes for a pass that may legitimately run 90.
    """
    return FLEX_BUDGET_SEC * max(1, len(specs))


# IBKR's per-query throttle is undocumented. Ten observed requests against
# this deployment's query split cleanly by the gap since the previous REQUEST
# — not since the previous success:
#
#     gap >= 23h22m   accepted (reference code issued) — 6 of 6
#     gap <= 18h39m   refused with 1001                — 4 of 4
#
# The real boundary is somewhere inside that bracket, so this constant is the
# conservative end of it and the result is a HINT, never a veto: the number is
# inferred from behaviour, and a rule that hard-blocks on an inference would
# be wrong exactly when the user most needs to override it.
#
# Why it is worth surfacing at all: under a daily schedule the scheduler has
# already claimed the day's single generation. A manual refresh inside the
# window does not merely fail on its own — the 1001 it earns is spent quota,
# and the next SCHEDULED run is the one that starves. 2026-09-05 11:21 (a
# manual press) is what took out 2026-09-06 06:00.
IBKR_QUERY_WINDOW_SEC = 23 * 3600

# Who owns the day's generation, decided by configuration rather than guessed.
#
# The advice above is a hint, and a hint is the right shape for "you are about
# to spend tomorrow's quota" — the user can see the whole picture and the code
# cannot. It is the wrong shape for a second copy of this app. A checkout run
# on a laptop is the same code with the same secrets pointed at the same Flex
# query (scripts/sync.env is shared with the container on purpose), so its
# button is not a second button — it is the same one, wired to the same single
# daily generation, minus every signal that would tell the person pressing it
# that the droplet already pulled three hours ago. 2026-09-19 08:59 UTC is what
# that costs: a press on a dev instance, 2h58m after the scheduled pull, spent
# the day on a 1001.
#
# Nothing in the process can tell the two apart, because there is nothing to
# tell apart — so ownership is declared, not detected, and it fails closed. The
# instance that holds the quota says so in its env; a copy inherits the
# credentials and not the claim.
def _env_flag(name: str) -> bool:
    """True for 1/true/yes/on, quotes tolerated.

    env_file values arrive quoted ("1") — the same reason flex_fetch strips
    them before use — and an instance that meant to turn a flag on must not be
    left off by its own quoting.
    """
    raw = os.environ.get(name, "").strip().strip('"').strip("'").lower()
    return raw in ("1", "true", "yes", "on")


ALLOW_MANUAL_REFRESH = _env_flag("ALLOW_MANUAL_REFRESH")


def _parse_iso(value: str | None) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value or "")
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _next_scheduled_run(now: datetime) -> datetime | None:
    """When the scheduler will next try, or None when it is switched off."""
    if AUTO_SYNC not in ("daily", "weekly"):
        return None
    at_hour = now.replace(hour=AUTO_SYNC_UTC_HOUR, minute=0, second=0, microsecond=0)
    if AUTO_SYNC == "daily":
        return at_hour if at_hour > now else at_hour + timedelta(days=1)
    target = _WEEKDAY_NUM.get(AUTO_SYNC_UTC_DAY, 5)
    for ahead in range(1, 9):
        candidate = at_hour + timedelta(days=ahead - 1)
        if candidate > now and candidate.weekday() == target:
            return candidate
    return None


def _manual_refresh_advice(state: dict) -> dict:
    """Would pressing the button now spend quota the scheduler is about to need?

    Advisory only — see IBKR_QUERY_WINDOW_SEC. "last request" is read from the
    sync state rather than the in-process clock so a container restart does not
    silently reset the warning.
    """
    last = _parse_iso(state.get("last_run_at"))
    if last is None:
        return {"risky": False}
    since = int((datetime.now(timezone.utc) - last).total_seconds())
    if since >= IBKR_QUERY_WINDOW_SEC:
        return {"risky": False, "since_sec": since}
    nxt = _next_scheduled_run(datetime.now(timezone.utc))
    return {
        "risky": True,
        "since_sec": since,
        "window_sec": IBKR_QUERY_WINDOW_SEC,
        "next_scheduled": nxt.isoformat(timespec="seconds") if nxt else "",
    }


def _refresh_specs() -> tuple[list, tuple[dict, int] | None]:
    """Resolve ACCOUNTS into specs, or the (payload, status) to return instead."""
    accounts_env = os.environ.get("ACCOUNTS", "").strip()
    if not accounts_env:
        return [], ({"error": "ACCOUNTS env var not configured on server"}, 500)
    specs = parse_accounts_env(accounts_env)
    if not specs:
        return [], ({"error": "ACCOUNTS env var malformed"}, 500)
    return specs, None


def _try_claim_refresh(trigger: str) -> tuple[tuple[dict, int] | None, int]:
    """Take the single refresh slot, or explain why not.

    Returns (refusal, run_id). When refusal is None the slot is ours and the
    caller owes exactly one _release_refresh(). Refuse if another pass is in
    flight or one *finished* too recently — we don't care whether it
    succeeded, since IBKR throttles by request, not by outcome. Both refusals
    carry a "wait N seconds" hint so the UI can format a friendly message
    rather than guessing.
    """
    now = time.time()
    with _refresh_lock:
        if _refresh_state["in_progress"]:
            return ({"error": "refresh already in progress",
                     "run_id": _refresh_state["run_id"]}, 429), 0
        elapsed = now - _refresh_state["last_finished"]
        if elapsed < REFRESH_MIN_INTERVAL_SEC:
            wait = int(REFRESH_MIN_INTERVAL_SEC - elapsed)
            return ({"error": f"too soon — wait {wait}s before refreshing again",
                     "retry_after_sec": wait}, 429), 0
        _refresh_state["in_progress"] = True
        _refresh_state["started_at"] = now
        _refresh_state["trigger"] = trigger
        _refresh_state["run_id"] += 1
        return None, _refresh_state["run_id"]


def _release_refresh(stamp: bool = True) -> None:
    """Free the slot and (normally) stamp the cool-down.

    Stamping here rather than at each call site is what makes the guarantee
    hold for the async path too: whatever happened inside the pass, the gap
    is owed from the moment it ended. stamp=False is for the one caller that
    claimed but never reached IBKR (a worker thread that failed to start):
    no request was made, so no gap is owed.
    """
    with _refresh_lock:
        _refresh_state["in_progress"] = False
        if stamp:
            _refresh_state["last_finished"] = time.time()


def _record_refresh_result(payload: dict, trigger: str) -> None:
    """Remember a completed pass — for /api/refresh/status and the banner."""
    with _refresh_lock:
        _refresh_state["last_result"] = payload
        _refresh_state["last_result_at"] = datetime.now(timezone.utc).isoformat(
            timespec="seconds")
        _refresh_state["last_result_run_id"] = _refresh_state["run_id"]
    _record_sync_outcome(payload, trigger)


def _refresh_work(specs: list, trigger: str) -> tuple[dict, int]:
    """One full IBKR sync pass over already-claimed specs.

    Fetches every account serially, parses each CSV through parse_ibkr_auto
    and writes per-account JSON. Returns (payload, http_status); the payload
    carries a per-account result map so callers can report partial success.
    Does no claiming of its own — the caller holds the slot — which is what
    lets the synchronous scheduler and the async button share one body.
    """
    results: list[dict] = []
    for spec in specs:
        # tag only — the UI doesn't need query ids and there's no point
        # echoing config back out of the API.
        entry = {"tag": spec.tag}
        try:
            csv_body = fetch_one(spec)
            # A refresh you had to wait out a throttle for is worth one log
            # line: the section list says whether the *query* carries what
            # a panel needs (Cash Transactions for dividends, say), which
            # no amount of re-reading the parser can tell you.
            sections = describe_sections(csv_body)
            app.logger.info("[%s] fetched %d bytes, sections: %s",
                            spec.tag, len(csv_body), ", ".join(sections) or "none")
            payload = parse_ibkr_auto(csv_body)
            saved, skipped = _save_accounts(payload)
            if saved:
                entry.update({"ok": True, "accounts": saved, "sections": sections})
                if skipped:
                    entry["skipped"] = skipped
            else:
                entry.update({"ok": False, "error": "statement contains no valid account ids",
                              "sections": sections})
        except FlexFetchError as exc:
            # exc.raw is IBKR's own envelope, token-redacted — the parsed
            # code/message drop everything IBKR said around them, and that
            # remainder is the whole point when the code list comes up short.
            app.logger.warning("[%s] refresh failed: %s | code=%s permanent=%s | raw: %s",
                               spec.tag, exc, exc.code or "-", exc.permanent,
                               exc.raw or "<empty>")
            entry.update({"ok": False, "error": str(exc), "code": exc.code,
                          "permanent": exc.permanent, "raw": exc.raw})
        except Exception as exc:  # pragma: no cover - surface parse errors
            app.logger.exception("[%s] parse failed", spec.tag)
            entry.update({"ok": False, "error": f"parse failed: {exc}"})
        results.append(entry)

    any_ok = any(r.get("ok") for r in results)
    out = {"ok": any_ok, "results": results}
    app.logger.info("[refresh:%s] %s", trigger,
                    "ok" if any_ok else "all accounts failed")
    _record_refresh_result(out, trigger)
    return out, 200


def _run_refresh(trigger: str) -> tuple[dict, int]:
    """One full IBKR sync pass, synchronously — the scheduler's entry point.

    The dashboard button takes the async route (/api/refresh) instead; both
    go through the same slot, so they can never hit IBKR concurrently or in
    quick succession.
    """
    specs, err = _refresh_specs()
    if err:
        return err
    refusal, _run_id = _try_claim_refresh(trigger)
    if refusal:
        return refusal
    try:
        return _refresh_work(specs, trigger)
    finally:
        # Even a fetch that raised reached IBKR and still owes the gap —
        # arguably more so, since a timeout leaves a generation running on
        # their side.
        _release_refresh()


@app.post("/api/refresh")
def refresh():
    """Start an IBKR sync in the background and return immediately.

    A pass can now outlast any browser's patience (see FLEX_BUDGET_SEC), so
    blocking the request bought nothing but a spinner that spun for the whole
    poll budget and a response nobody was still waiting for. Config errors
    and the throttle are still settled synchronously — those answers are
    instant and the button should hear them at once — and only the slow part
    moves to a thread. Progress is read back from /api/refresh/status.

    The thread is deliberately not one of gunicorn's: a pass no longer
    occupies a request thread at all, so the UI keeps its full pool while a
    45-minute fetch runs.
    """
    # Ahead of the config check on purpose: an instance that does not own the
    # quota should say so even when its ACCOUNTS is fine, because a working
    # config is exactly what makes a dev copy dangerous.
    if not ALLOW_MANUAL_REFRESH:
        return jsonify({
            "error": "manual refresh is not enabled on this instance",
            "detail": "这个实例没有被授予 IBKR 配额。同一个 Flex query 每天大约"
                      "只放行一次生成，而开发副本与生产共用同一套凭据 —— 在这里"
                      "点一次，花掉的是计划同步的额度。要在某个实例上开启，"
                      "在它的环境里设 ALLOW_MANUAL_REFRESH=1。",
        }), 409
    specs, err = _refresh_specs()
    if err:
        return jsonify(err[0]), err[1]
    refusal, run_id = _try_claim_refresh("button")
    if refusal:
        return jsonify(refusal[0]), refusal[1]

    def worker() -> None:
        try:
            _refresh_work(specs, "button")
        except Exception as exc:  # pragma: no cover - must not strand the slot
            app.logger.exception("[refresh:button] pass crashed")
            _record_refresh_result(
                {"ok": False,
                 "results": [{"tag": "-", "ok": False,
                              "error": f"internal error: {exc}"}]},
                "button")
        finally:
            _release_refresh()

    try:
        threading.Thread(target=worker, daemon=True, name=f"refresh-{run_id}").start()
    except Exception:
        # The claim..start gap has no worker finally to lean on: if the thread
        # never starts (fd/memory pressure), nothing would ever release the
        # slot, and every later press — and the scheduler — would be refused
        # "already in progress" until a restart. The synchronous path guards
        # the same gap with try/finally; this is its async twin. No cool-down
        # stamped: nothing reached IBKR.
        app.logger.exception("[refresh:button] worker thread failed to start")
        _release_refresh(stamp=False)
        return jsonify({"error": "could not start refresh worker"}), 500
    return jsonify({"started": True, "run_id": run_id,
                    "budget_sec": _pass_budget_sec(specs)}), 202


@app.get("/api/refresh/status")
def refresh_status():
    """Progress of the current (or most recent) sync pass.

    Polled by the button while a pass runs, and read once on page load — so a
    refresh started before a reload, or one the scheduler began with nobody
    watching, shows a live spinner instead of a button that looks idle.
    """
    with _refresh_lock:
        st = dict(_refresh_state)
    # Recomputed rather than remembered: the answer depends only on how many
    # accounts are configured, and a stale copy would outlive an ACCOUNTS edit.
    specs, _err = _refresh_specs()
    out: dict = {"in_progress": st["in_progress"],
                 "budget_sec": _pass_budget_sec(specs)}
    if st["in_progress"]:
        out["run_id"] = st.get("run_id", 0)
        out["trigger"] = st.get("trigger", "")
        out["elapsed_sec"] = int(time.time() - (st.get("started_at") or time.time()))
    if st.get("last_result"):
        out["last"] = {"run_id": st.get("last_result_run_id", 0),
                       "at": st.get("last_result_at", ""),
                       **st["last_result"]}
    # Read by the button as a pre-flight: IBKR hands out about one generation
    # of this query a day and the scheduler already has a claim on it.
    sync_state = _read_sync_state()
    out["last_run_at"] = sync_state.get("last_run_at", "")
    out["manual"] = _manual_refresh_advice(sync_state)
    # So the button can be dead on arrival rather than dead on press: a dev
    # copy should look inert, not look ready and then 409.
    out["manual_allowed"] = ALLOW_MANUAL_REFRESH
    return jsonify(out)

# --- Auto-sync: the in-app replacement for the retired bash+cron path -------
#
# The old crontab ran scripts/ibkr_sync.sh on the host: a separate code path
# with its own retry ladder that could walk itself into IBKR's 1025 lockout
# (lesson 11), invisible from the dashboard. This thread reuses _run_refresh
# verbatim — same fetcher, same token redaction, same PERMANENT_CODES (now
# including 1025), same throttle as the button — and records every attempt
# where the UI can show it.
#
#   AUTO_SYNC          off (default) | daily | weekly
#   AUTO_SYNC_UTC_HOUR first attempt at/after this UTC hour (default 9 —
#                      ≈ after the US close's statement is available)
#   AUTO_SYNC_UTC_DAY  weekly only: mon..sun (default sat)
#
# One attempt per due-day, deliberately with NO automatic retry: a failed
# pull waits for the next due day (or the manual button) rather than
# hammering a throttled endpoint into a lockout.

AUTO_SYNC = os.environ.get("AUTO_SYNC", "off").strip().lower()
SYNC_STATE_FILE = UPLOAD_DIR / ".auto_sync_state.json"

_WEEKDAY_NUM = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


def _parse_sync_hour(raw: str) -> int:
    """0-23, defaulting to 9 — a typo in an env file must degrade the
    schedule, never crash the whole app at import (gunicorn + restart:
    unless-stopped would turn that into a boot loop taking the dashboard
    down with it)."""
    try:
        hour = int((raw or "").strip().strip('"').strip("'") or 9)
    except ValueError:
        app.logger.warning("AUTO_SYNC_UTC_HOUR=%r is not an integer; using 9", raw)
        return 9
    if not 0 <= hour <= 23:
        app.logger.warning("AUTO_SYNC_UTC_HOUR=%r out of 0-23; using 9", raw)
        return 9
    return hour


def _parse_sync_day(raw: str) -> str:
    day = ((raw or "").strip().strip('"').strip("'").lower() or "sat")[:3]
    if day not in _WEEKDAY_NUM:
        app.logger.warning("AUTO_SYNC_UTC_DAY=%r not mon..sun; using sat", raw)
        return "sat"
    return day


AUTO_SYNC_UTC_HOUR = _parse_sync_hour(os.environ.get("AUTO_SYNC_UTC_HOUR", "9"))
AUTO_SYNC_UTC_DAY = _parse_sync_day(os.environ.get("AUTO_SYNC_UTC_DAY", "sat"))


def _auto_sync_due(now_utc: datetime, mode: str, hour: int, day: str,
                   last_attempt_date: str) -> bool:
    """True when a scheduled attempt should fire — at most once per due-day."""
    if mode not in ("daily", "weekly"):
        return False
    if now_utc.hour < hour:
        return False
    if mode == "weekly" and now_utc.weekday() != _WEEKDAY_NUM.get(day, 5):
        return False
    return last_attempt_date != now_utc.date().isoformat()


def _read_sync_state() -> dict:
    try:
        with open(SYNC_STATE_FILE, "r", encoding="utf-8") as f:
            state = json.load(f)
        return state if isinstance(state, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


# Every read-modify-write of the sync state goes through this. Two writers
# exist — the scheduler stamping/rolling back its attempt marker, and a button
# worker recording an outcome — and they are NOT mutually exclusive: the
# scheduler can be refused (429) by a button pass that is still running and
# about to write its own result. Without this, either side can read, be
# overtaken, and write back a whole dict that erases the other's fields.
_sync_state_lock = Lock()


def _write_sync_state(state: dict) -> None:
    _atomic_write_json(SYNC_STATE_FILE, state)


def _stamp_sync_attempt(now: datetime) -> dict:
    """Claim the scheduler's slot for today. Returns the pre-stamp snapshot."""
    with _sync_state_lock:
        prev = _read_sync_state()
        _write_sync_state({**prev, "last_attempt_date": now.date().isoformat(),
                           "last_attempt": now.isoformat(timespec="seconds")})
    return prev


def _restore_sync_attempt(prev: dict) -> None:
    """Undo the attempt stamp, keeping any outcome written meanwhile.

    Restoring the whole snapshot would be simpler and wrong: a button worker
    that finished during our refused attempt has already written ok/detail/
    last_success, and a verbatim restore would throw that away — including the
    one field the staleness banner counts from.
    """
    with _sync_state_lock:
        state = _read_sync_state()
        for key in ("last_attempt_date", "last_attempt"):
            if key in prev:
                state[key] = prev[key]
            else:
                state.pop(key, None)
        _write_sync_state(state)


def _record_sync_outcome(payload: dict, trigger: str) -> None:
    """Fold a completed pass into the sync state file.

    Writes the OUTCOME fields only, never last_attempt_date — that one is the
    scheduler's once-a-day slot marker, and a button press must not eat the
    day's automatic attempt. It should still move "when did data last actually
    arrive", though, which is what the staleness banner reads: last_success is
    the only honest source for "how long have we been flying blind", since the
    statement's own period end lags the fetch by a couple of days.
    """
    results = payload.get("results", [])
    # payload["ok"] means "at least one spec succeeded" — the right rule for
    # the partial-success toast, the wrong one to persist as health. One
    # account failing forever would hide behind another's success: green ✓ in
    # the header, no banner, and last_success creeping forward the whole time.
    ok = bool(results) and all(r.get("ok") for r in results)
    detail = "; ".join(
        f"{r.get('tag', '?')}: {'ok' if r.get('ok') else (r.get('error') or '?')}"
        for r in results
    ) or (payload.get("error") or "")
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _sync_state_lock:
        state = _read_sync_state()
        # Pre-upgrade state files carry ok/last_attempt but no last_success.
        # Without this, the first failure after a deploy makes the banner
        # announce "尚无成功记录" about a box that synced fine yesterday.
        if "last_success" not in state and state.get("ok"):
            legacy = state.get("last_run_at") or state.get("last_attempt")
            if legacy:
                state["last_success"] = legacy
        state.update({
            "mode": AUTO_SYNC,
            "ok": ok,
            "detail": detail[:500],
            "last_run_at": now_iso,
            "last_run_trigger": trigger,
        })
        if ok:
            state["last_success"] = now_iso
        _write_sync_state(state)


def _auto_sync_loop() -> None:
    app.logger.info("[auto-sync] scheduler on: %s at %02d:00 UTC%s",
                    AUTO_SYNC, AUTO_SYNC_UTC_HOUR,
                    f" ({AUTO_SYNC_UTC_DAY})" if AUTO_SYNC == "weekly" else "")
    while True:
        time.sleep(60)
        try:
            now = datetime.now(timezone.utc)
            state = _read_sync_state()
            if not _auto_sync_due(now, AUTO_SYNC, AUTO_SYNC_UTC_HOUR,
                                  AUTO_SYNC_UTC_DAY, state.get("last_attempt_date", "")):
                continue
            # Stamp the attempt BEFORE running: a crash mid-pull must not
            # turn into a retry loop against a throttled endpoint.
            prev = _stamp_sync_attempt(now)
            payload, status = _run_refresh("auto")
            if status == 429:
                # Our OWN throttle/lock refused — zero requests reached IBKR,
                # so this must not consume the day's single attempt (a button
                # press at 08:57 would otherwise skip a whole daily/weekly
                # slot). Roll the attempt marker back; the next 60s tick
                # retries once the cool-down passes. The one-attempt-per-day
                # rule guards IBKR quota, and this branch never spent any.
                #
                # Writing a fresh last_attempt here would be a lie in the
                # header: ok/detail still describe the PREVIOUS run, so the
                # top bar would pair a just-now timestamp with an older ✓ and
                # claim a sync that never reached IBKR. Only the two attempt
                # fields are rolled back — whoever refused us is very likely a
                # button pass still in flight, and its outcome must survive.
                _restore_sync_attempt(prev)
                continue
            if status != 200:
                # A pass that never reached _refresh_work (bad ACCOUNTS, say)
                # recorded nothing, so the header would pair this run's fresh
                # timestamp with the PREVIOUS run's verdict. Record it here.
                _record_sync_outcome(payload, "auto")
            # Otherwise the outcome fields are already in — _refresh_work wrote
            # them through the same helper the button uses. Re-writing them
            # here would only give the two copies room to drift; the
            # attempt-slot fields stamped above stay exactly as they are.
            state = _read_sync_state()
            ok = bool(state.get("ok"))
            detail = state.get("detail", "")
            app.logger.info("[auto-sync] %s: %s", "ok" if ok else "FAILED", detail)
        except Exception:
            app.logger.exception("[auto-sync] loop error")


if AUTO_SYNC in ("daily", "weekly"):
    # Started at import so an unattended droplet syncs without anyone
    # opening the page. Under the flask dev reloader the module imports in
    # TWO processes, and _refresh_lock is per-process memory — the parent's
    # scheduler could fetch concurrently with a button press served by the
    # child. Only the serving process (WERKZEUG_RUN_MAIN=true) may start
    # the thread; under gunicorn (module imported, __name__ != "__main__",
    # single worker per Dockerfile) production gets exactly one.
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or __name__ != "__main__":
        threading.Thread(target=_auto_sync_loop, daemon=True, name="auto-sync").start()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="127.0.0.1", port=port, debug=True)
