# -*- coding: utf-8 -*-
"""Risk gate backend: settings validation/storage, Nasdaq earnings parse + cache.

Never touches the network: the cache tests hand lookup() a fake fetch, and the
endpoint tests stub lookup_earnings out of app. Account ids are fake — the
repo is public.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from parser import earnings  # noqa: E402

# --- settings ----------------------------------------------------------------


def test_risk_settings_normalization():
    from app import _normalize_risk_settings as norm

    got = norm({
        "thresholds": {
            "put_nav_max": 1.5, "single_put_nav_max": "0.3",   # form strings are fine
            "pm_warn": 0.1, "drawdown_days": 20.0,             # whole float → int
            "drawdown_stop": None, "cluster_nav_max": "",      # blank = keep default
        },
        "cluster": ["soxl", "NVDA", "SOXL", " ", "brk.b"],     # upper, dedupe, skip blanks
        "watch": [],                                           # deliberate "none"
        "accounts": {
            "U1111111": {"kind": "pm", "label": "  个人\t户 "},
            "U2222222": {"kind": "cash", "label": ""},
            "U3333333": {"kind": None, "label": ""},           # nothing to keep
        },
    })
    assert got["thresholds"] == {"put_nav_max": 1.5, "single_put_nav_max": 0.3,
                                 "pm_warn": 0.1, "drawdown_days": 20}
    assert isinstance(got["thresholds"]["drawdown_days"], int)
    assert got["cluster"] == ["SOXL", "NVDA", "BRK.B"]
    assert got["watch"] == []
    assert got["accounts"] == {
        "U1111111": {"kind": "pm", "label": "个人 户"},
        "U2222222": {"kind": "cash", "label": ""},
    }
    # Lists left out mean "use the default list", which is not the same as [].
    assert norm({})["cluster"] is None and norm({})["watch"] is None


@pytest.mark.parametrize("body", [
    {"thresholds": {"bogus": 1}},                      # unknown line
    {"thresholds": {"pm_warn": 10}},                   # percent typed as a fraction
    {"thresholds": {"drawdown_stop": 1.5}},
    {"thresholds": {"put_nav_max": -0.1}},
    {"thresholds": {"drawdown_days": 2.5}},            # not a whole number
    {"thresholds": {"drawdown_days": 1}},              # too short to mean anything
    {"thresholds": {"put_nav_max": True}},             # bool is not a number here
    {"thresholds": {"put_nav_max": "abc"}},
    {"thresholds": {"put_nav_max": float("nan")}},
    {"thresholds": []},
    {"cluster": "SOXL, NVDA"},                         # must be a list
    {"cluster": ["../etc"]},
    {"watch": [f"S{i}" for i in range(21)]},            # more than 20
    {"accounts": {"../x": {"kind": "pm"}}},
    {"accounts": {"U1111111": {"kind": "isa"}}},
    {"accounts": {"U1111111": {"kind": "pm", "label": "x" * 25}}},
    {"accounts": {"U1111111": {"label": 5}}},
    {"accounts": {"U1111111": "pm"}},
    {"accounts": []},
])
def test_risk_settings_rejects_bad_input(body):
    from app import _normalize_risk_settings as norm

    with pytest.raises(ValueError):
        norm(body)


def test_risk_settings_roundtrip(tmp_path, monkeypatch):
    import app as app_mod

    monkeypatch.setattr(app_mod, "RISK_SETTINGS_FILE", tmp_path / ".risk_settings.json")
    client = app_mod.app.test_client()
    keys = {"version", "thresholds", "cluster", "watch", "accounts", "updated_at"}

    blank = client.get("/api/settings/risk").get_json()
    assert set(blank) == keys
    assert blank["thresholds"] == {} and blank["accounts"] == {}

    res = client.put("/api/settings/risk", json={
        "thresholds": {"put_nav_max": 1.2, "drawdown_stop": 0.08},
        "watch": ["SOXL", "TQQQ"],
        "accounts": {"U1111111": {"kind": "pm", "label": "个人"}},
    })
    assert res.status_code == 200
    stored = client.get("/api/settings/risk").get_json()
    assert set(stored) == keys and stored["updated_at"]
    assert stored["thresholds"] == {"put_nav_max": 1.2, "drawdown_stop": 0.08}
    assert stored["watch"] == ["SOXL", "TQQQ"] and stored["cluster"] is None
    assert stored["accounts"] == {"U1111111": {"kind": "pm", "label": "个人"}}

    # A rejected write leaves the previous config exactly as it was.
    bad = client.put("/api/settings/risk", json={"thresholds": {"pm_warn": 10}})
    assert bad.status_code == 400 and "pm_warn" in bad.get_json()["error"]
    assert client.get("/api/settings/risk").get_json()["thresholds"] == stored["thresholds"]
    assert client.put("/api/settings/risk", data="nope",
                      content_type="application/json").status_code == 400


def test_corrupt_risk_settings_degrade_to_defaults(tmp_path, monkeypatch):
    import app as app_mod

    path = tmp_path / ".risk_settings.json"
    monkeypatch.setattr(app_mod, "RISK_SETTINGS_FILE", path)
    client = app_mod.app.test_client()
    for content in ("not json", '{"thresholds": {"pm_warn": 99}}', "[1, 2]"):
        path.write_text(content, encoding="utf-8")
        res = client.get("/api/settings/risk")
        assert res.status_code == 200                 # never 500 the dashboard
        assert res.get_json()["thresholds"] == {}


def test_risk_files_are_not_mistaken_for_accounts(tmp_path, monkeypatch):
    """The leading dots are load-bearing: uploads/*.json is the account sweep."""
    import app as app_mod

    monkeypatch.setattr(app_mod, "UPLOAD_DIR", tmp_path)
    (tmp_path / ".risk_settings.json").write_text('{"version": 1}', encoding="utf-8")
    (tmp_path / ".earnings_cache.json").write_text('{"symbols": {}}', encoding="utf-8")
    (tmp_path / "U1111111.json").write_text('{"nav": {"total": 1}}', encoding="utf-8")
    assert list(app_mod._load_all_accounts()) == ["U1111111"]
    assert app_mod.RISK_SETTINGS_FILE.name.startswith(".")
    assert app_mod.EARNINGS_CACHE.name.startswith(".")


# --- Nasdaq earnings: parse ---------------------------------------------------

# Trimmed from real responses (2026-10-25).
COHR = {"data": {
    "reportText": "Coherent Corp. Common Stock is expected* to report earnings on  "
                  "11/04/2026 after market close.  The report will be for the fiscal "
                  "Quarter ending Sep 2026.",
    "announcement": "Earnings announcement* for COHR: Nov 04, 2026"},
    "message": None, "status": {"rCode": 200}}
NVDA = {"data": {
    "reportText": "NVIDIA Corporation Common Stock is estimated to report earnings on  "
                  "11/18/2026. The upcoming earnings date is derived from an algorithm "
                  "based on a company's historical reporting dates.",
    "announcement": "Earnings announcement* for NVDA: Nov 18, 2026"},
    "message": None, "status": {"rCode": 200}}
VRT = {"data": {
    "reportText": "Vertiv Holdings, LLC Class A Common Stock is expected* to report "
                  "earnings on  10/28/2026 before market open.",
    "announcement": "Earnings announcement* for VRT: Oct 28, 2026"},
    "message": None, "status": {"rCode": 200}}
SOXL = {"data": None, "message": None, "status": {
    "rCode": 400, "bCodeMessage": [{"code": 1001, "errorMessage": "Symbol not exists."}]}}


def test_parse_company_with_announced_session():
    assert earnings.parse_response(COHR) == {
        "status": "ok", "date": "2026-11-04", "timing": "amc", "estimated": False}
    assert earnings.parse_response(VRT)["timing"] == "bmo"


def test_parse_algorithmic_estimate_is_flagged():
    got = earnings.parse_response(NVDA)
    assert got["date"] == "2026-11-18"
    assert got["estimated"] is True
    assert got["timing"] == ""


def test_parse_unknown_symbol_is_an_answer_not_a_failure():
    got = earnings.parse_response(SOXL)
    assert got["status"] == "none" and got["date"] is None


def test_parse_falls_back_to_the_announcement_line():
    reworded = {"data": {"reportText": "Something else entirely.",
                         "announcement": "Earnings announcement for X: Jan 7, 2027"}}
    assert earnings.parse_response(reworded)["date"] == "2027-01-07"
    no_date = {"data": {"reportText": "No upcoming date.", "announcement": ""}}
    assert earnings.parse_response(no_date)["status"] == "none"


@pytest.mark.parametrize("payload", [
    [1, 2], "html", None,
    {"data": None, "status": {"rCode": 500}},          # outage, not "no such symbol"
    {"data": "oops"},
    {"data": {"reportText": "on 13/45/2026"}},         # impossible date
])
def test_parse_rejects_what_is_not_an_answer(payload):
    with pytest.raises(ValueError):
        earnings.parse_response(payload)


# --- Nasdaq earnings: cache ----------------------------------------------------

T0 = datetime(2026, 10, 25, 6, 0, tzinfo=timezone.utc)


class FakeFetch:
    def __init__(self, answers):
        self.answers = answers          # sym -> dict | Exception
        self.calls: list[str] = []

    def __call__(self, sym):
        self.calls.append(sym)
        ans = self.answers[sym]
        if isinstance(ans, Exception):
            raise ans
        return ans


def _ok(date):
    return {"status": "ok", "date": date, "timing": "amc", "estimated": False}


def test_answers_are_reused_for_a_day(tmp_path):
    cache = tmp_path / ".earnings_cache.json"
    fetch = FakeFetch({"COHR": _ok("2026-11-04"), "SOXL": {"status": "none", "date": None,
                                                           "timing": "", "estimated": False}})
    got = earnings.lookup(["COHR", "SOXL"], cache, now=T0, fetch=fetch)
    assert got["COHR"]["date"] == "2026-11-04" and got["COHR"]["as_of"]
    assert got["SOXL"]["status"] == "none"
    assert sorted(fetch.calls) == ["COHR", "SOXL"]

    earnings.lookup(["COHR", "SOXL"], cache, now=T0 + timedelta(hours=23), fetch=fetch)
    assert len(fetch.calls) == 2                      # both cached, "none" included

    earnings.lookup(["COHR"], cache, now=T0 + timedelta(hours=25), fetch=fetch)
    assert fetch.calls[-1] == "COHR" and len(fetch.calls) == 3
    assert json.loads(cache.read_text(encoding="utf-8"))["symbols"]["COHR"]["answer"]


def test_failures_back_off_for_an_hour_and_stay_unknown(tmp_path):
    cache = tmp_path / ".earnings_cache.json"
    fetch = FakeFetch({"ORCL": TimeoutError("timed out"), "COHR": _ok("2026-11-04")})
    got = earnings.lookup(["ORCL", "COHR"], cache, now=T0, fetch=fetch)
    assert got["ORCL"]["status"] == "error" and got["ORCL"]["date"] is None
    assert "timed out" in got["ORCL"]["error"]
    assert got["COHR"]["status"] == "ok"              # one failure sinks nothing else

    earnings.lookup(["ORCL"], cache, now=T0 + timedelta(minutes=59), fetch=fetch)
    assert fetch.calls.count("ORCL") == 1             # still backing off
    earnings.lookup(["ORCL"], cache, now=T0 + timedelta(minutes=61), fetch=fetch)
    assert fetch.calls.count("ORCL") == 2


def test_a_failed_refresh_serves_the_last_date_marked_stale(tmp_path):
    cache = tmp_path / ".earnings_cache.json"
    earnings.lookup(["COHR"], cache, now=T0, fetch=FakeFetch({"COHR": _ok("2026-11-04")}))
    broken = FakeFetch({"COHR": OSError("connection reset")})

    got = earnings.lookup(["COHR"], cache, now=T0 + timedelta(hours=26), fetch=broken)
    assert got["COHR"]["status"] == "ok" and got["COHR"]["stale"] is True
    assert got["COHR"]["date"] == "2026-11-04"

    # ...but never once the date is behind us, or the answer is too old to trust.
    got = earnings.lookup(["COHR"], cache, now=datetime(2026, 11, 5, 12, tzinfo=timezone.utc),
                          fetch=broken)
    assert got["COHR"]["status"] == "error"


def test_garbage_cache_file_is_rebuilt(tmp_path):
    cache = tmp_path / ".earnings_cache.json"
    cache.write_text("{not json", encoding="utf-8")
    got = earnings.lookup(["COHR"], cache, now=T0, fetch=FakeFetch({"COHR": _ok("2026-11-04")}))
    assert got["COHR"]["date"] == "2026-11-04"
    assert json.loads(cache.read_text(encoding="utf-8"))["version"] == 1


def test_fetch_sends_a_browser_user_agent(monkeypatch):
    seen = {}

    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps(COHR).encode()

    def fake_urlopen(req, timeout):
        seen["ua"] = req.get_header("User-agent")
        seen["url"] = req.full_url
        return Resp()

    monkeypatch.setattr(earnings.urllib.request, "urlopen", fake_urlopen)
    assert earnings.fetch_one("BRK.B")["date"] == "2026-11-04"
    assert seen["ua"].startswith("Mozilla/5.0")
    assert seen["url"].endswith("/api/analyst/BRK.B/earnings-date")


# --- /api/earnings -------------------------------------------------------------


def test_earnings_endpoint_validates_and_dedupes(monkeypatch):
    import app as app_mod

    asked = []

    def fake_lookup(syms, _path):
        asked.append(list(syms))
        return {s: {"status": "ok", "date": "2026-11-04"} for s in syms}

    monkeypatch.setattr(app_mod, "lookup_earnings", fake_lookup)
    client = app_mod.app.test_client()

    res = client.get("/api/earnings?symbols=cohr,LITE,COHR,%20")
    assert res.status_code == 200
    assert asked[-1] == ["COHR", "LITE"]
    assert set(res.get_json()["symbols"]) == {"COHR", "LITE"}

    assert client.get("/api/earnings").get_json()["symbols"] == {}
    assert client.get("/api/earnings?symbols=../etc").status_code == 400
    many = ",".join(f"S{i}" for i in range(61))
    assert client.get(f"/api/earnings?symbols={many}").status_code == 400
    assert len(asked) == 1                             # rejected requests never fetch
