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

from parser import parse_ibkr_csv, parse_ibkr_pdf

BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
STATE_FILE = UPLOAD_DIR / "last_portfolio.json"

app = Flask(__name__, template_folder=str(BASE_DIR / "templates"), static_folder=str(BASE_DIR / "static"))
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB


@app.get("/")
def index():
    return render_template("dashboard.html")


@app.get("/api/portfolio")
def get_portfolio():
    if not STATE_FILE.exists():
        return jsonify({"empty": True})
    with open(STATE_FILE, "r", encoding="utf-8") as f:
        return jsonify(json.load(f))


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
            data = parse_ibkr_csv(raw)
        elif name.endswith(".pdf"):
            data = parse_ibkr_pdf(f.read())
        else:
            return jsonify({"error": "unsupported file type, please upload .csv or .pdf"}), 400
    except Exception as exc:  # pragma: no cover - surface parsing errors to UI
        return jsonify({"error": f"parse failed: {exc}"}), 400

    with open(STATE_FILE, "w", encoding="utf-8") as out:
        json.dump(data, out, ensure_ascii=False, indent=2)

    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="127.0.0.1", port=port, debug=True)
