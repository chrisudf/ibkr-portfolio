"""IBKR Portfolio Dashboard — Flask app.

Run:
    pip install -r requirements.txt
    python app.py
Then open http://127.0.0.1:5050/
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from parser import parse_ibkr_auto, parse_ibkr_pdf

BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
# Per-account state files: uploads/U17456181.json etc.
# Legacy single-file (last_portfolio.json) is still read for backward compat.
LEGACY_STATE_FILE = UPLOAD_DIR / "last_portfolio.json"

app = Flask(__name__, template_folder=str(BASE_DIR / "templates"), static_folder=str(BASE_DIR / "static"))
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB


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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="127.0.0.1", port=port, debug=True)
