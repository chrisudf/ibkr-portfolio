"""IBKR Portfolio Dashboard — Flask app.

Run:
    pip install -r requirements.txt
    python app.py
Then open http://127.0.0.1:5050/
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from threading import Lock

from flask import Flask, jsonify, render_template, request

from parser import parse_ibkr_auto, parse_ibkr_pdf
from parser.flex_fetch import FlexFetchError, fetch_one, parse_accounts_env

BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
# Per-account state files: uploads/U17456181.json etc.
# Legacy single-file (last_portfolio.json) is still read for backward compat.
LEGACY_STATE_FILE = UPLOAD_DIR / "last_portfolio.json"

app = Flask(__name__, template_folder=str(BASE_DIR / "templates"), static_folder=str(BASE_DIR / "static"))
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB

# Minimum gap between /api/refresh attempts (gating is on attempt-start,
# regardless of success or failure). Prevents button-spam from chewing
# through IBKR's per-query throttle quota — IBKR locks a query for ~30 min
# if hit too often, success or not, so we cool down on every attempt.
REFRESH_MIN_INTERVAL_SEC = 5 * 60
_refresh_state = {"last_started": 0.0, "in_progress": False}
_refresh_lock = Lock()


@app.get("/")
def index():
    return render_template("dashboard.html")


def _load_all_accounts() -> dict:
    """Read every uploads/U*.json into a single multi-account payload."""
    accounts: dict[str, dict] = {}
    for path in sorted(UPLOAD_DIR.glob("U*.json")):
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

    saved = []
    for acct_id, data in payload.get("accounts", {}).items():
        out_path = UPLOAD_DIR / f"{acct_id}.json"
        with open(out_path, "w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=False, indent=2)
        saved.append(acct_id)

    return jsonify({"ok": True, "accounts": saved})


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
            entry = {"query_id": spec.query_id, "tag": spec.tag}
            try:
                csv_body = fetch_one(spec)
                payload = parse_ibkr_auto(csv_body)
                saved = []
                for acct_id, data in payload.get("accounts", {}).items():
                    out_path = UPLOAD_DIR / f"{acct_id}.json"
                    with open(out_path, "w", encoding="utf-8") as out:
                        json.dump(data, out, ensure_ascii=False, indent=2)
                    saved.append(acct_id)
                entry.update({"ok": True, "accounts": saved})
            except FlexFetchError as exc:
                entry.update({"ok": False, "error": str(exc), "code": exc.code,
                              "permanent": exc.permanent})
            except Exception as exc:  # pragma: no cover - surface parse errors
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
