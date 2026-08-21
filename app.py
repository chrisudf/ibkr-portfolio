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
import time
from pathlib import Path
from threading import Lock

from flask import Flask, jsonify, render_template, request

from parser import parse_ibkr_auto, parse_ibkr_pdf
from parser.flex_fetch import FlexFetchError, fetch_one, parse_accounts_env
from parser.ibkr_flex_csv import describe_sections

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

# Minimum gap between /api/refresh attempts (gating is on attempt-start,
# regardless of success or failure). Prevents button-spam from chewing
# through IBKR's per-query throttle quota — IBKR locks a query for ~30 min
# if hit too often, success or not, so we cool down on every attempt.
REFRESH_MIN_INTERVAL_SEC = 5 * 60
# In-process state: only authoritative because the Dockerfile runs a single
# Gunicorn worker (threads share this dict). Adding workers would need a
# cross-process lock (file lock / redis) instead.
_refresh_state = {"last_started": 0.0, "in_progress": False}
_refresh_lock = Lock()

# Account ids become filenames (uploads/{id}.json) and come from parsed
# user uploads, so anything outside this alphabet is rejected — blocks
# path traversal via a crafted ClientAccountID. Real IBKR ids (U1234567,
# DU1234567) and our "default" fallback all pass.
_ACCT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def _save_accounts(payload: dict) -> tuple[list[str], list[str]]:
    """Write per-account JSON files; returns (saved, skipped) account ids.

    Writes to a temp file then os.replace so a concurrent reader never sees
    a half-written JSON. The temp file must be unique per writer, not a
    fixed "<acct>.json.tmp": upload and refresh run on different threads
    (and the weekly cron delivers through /api/upload), so two writers of
    the same account can overlap — sharing one temp path would interleave
    their json.dump output and publish a corrupt file. With mkstemp each
    writer replaces from its own file and the outcome is a clean
    last-writer-wins.
    """
    saved: list[str] = []
    skipped: list[str] = []
    for acct_id, data in (payload.get("accounts") or {}).items():
        if not _ACCT_ID_RE.match(acct_id or ""):
            app.logger.warning("refusing to save account with unsafe id %r", acct_id)
            skipped.append(str(acct_id))
            continue
        out_path = UPLOAD_DIR / f"{acct_id}.json"
        fd, tmp_name = tempfile.mkstemp(
            dir=str(UPLOAD_DIR), prefix=out_path.name + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                json.dump(data, out, ensure_ascii=False, indent=2)
            os.replace(tmp_name, out_path)
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
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
    return jsonify({"accounts": accounts})


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


@app.post("/api/refresh")
def refresh():
    """On-demand IBKR sync triggered by the dashboard button.

    Reads accounts config from the ACCOUNTS env var (same shape the bash
    script reads from sync.env), fetches every account serially, parses
    each CSV through parse_ibkr_auto and writes per-account JSON. Returns
    a per-account result map so the UI can report partial success.
    """
    accounts_env = os.environ.get("ACCOUNTS", "").strip()
    if not accounts_env:
        return jsonify({"error": "ACCOUNTS env var not configured on server"}), 500

    specs = parse_accounts_env(accounts_env)
    if not specs:
        return jsonify({"error": "ACCOUNTS env var malformed"}), 500

    # Throttle: refuse if another refresh is in flight or one *started* too
    # recently (we don't care whether it succeeded — IBKR throttles by
    # request, not by outcome). Both cases get a "wait N seconds" hint so
    # the UI can format a friendly message rather than guessing.
    now = time.time()
    with _refresh_lock:
        if _refresh_state["in_progress"]:
            return jsonify({"error": "refresh already in progress"}), 429
        elapsed = now - _refresh_state["last_started"]
        if elapsed < REFRESH_MIN_INTERVAL_SEC:
            wait = int(REFRESH_MIN_INTERVAL_SEC - elapsed)
            return jsonify({
                "error": f"too soon — wait {wait}s before refreshing again",
                "retry_after_sec": wait,
            }), 429
        _refresh_state["in_progress"] = True
        _refresh_state["last_started"] = now

    results: list[dict] = []
    try:
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
    finally:
        with _refresh_lock:
            _refresh_state["in_progress"] = False

    any_ok = any(r.get("ok") for r in results)
    return jsonify({"ok": any_ok, "results": results})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="127.0.0.1", port=port, debug=True)
