# -*- coding: utf-8 -*-
"""Risk gate backend: settings validation and storage.

Account ids are fake — the repo is public.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

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


def test_two_breaker_steps():
    from app import _normalize_risk_settings as norm

    got = norm({"thresholds": {"drawdown_stop": 0.08, "drawdown_halt": 0.25}})
    assert got["thresholds"] == {"drawdown_stop": 0.08, "drawdown_halt": 0.25}
    # Equal is allowed: one step that is both "停卖 put" and "只减不加".
    assert norm({"thresholds": {"drawdown_stop": 0.15, "drawdown_halt": 0.15}})["thresholds"]
    # Only one typed: the other is a client-side default, so nothing to compare.
    assert norm({"thresholds": {"drawdown_halt": 0.05}})["thresholds"] == {"drawdown_halt": 0.05}
    with pytest.raises(ValueError, match="drawdown_halt"):
        norm({"thresholds": {"drawdown_stop": 0.20, "drawdown_halt": 0.10}})


@pytest.mark.parametrize("body", [
    {"thresholds": {"bogus": 1}},                      # unknown line
    {"thresholds": {"pm_warn": 10}},                   # percent typed as a fraction
    {"thresholds": {"drawdown_stop": 1.5}},
    {"thresholds": {"drawdown_halt": 20}},             # percent typed as a fraction
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


def test_risk_settings_file_is_not_mistaken_for_an_account(tmp_path, monkeypatch):
    """The leading dot is load-bearing: uploads/*.json is the account sweep."""
    import app as app_mod

    monkeypatch.setattr(app_mod, "UPLOAD_DIR", tmp_path)
    (tmp_path / ".risk_settings.json").write_text('{"version": 1}', encoding="utf-8")
    (tmp_path / "U1111111.json").write_text('{"nav": {"total": 1}}', encoding="utf-8")
    assert list(app_mod._load_all_accounts()) == ["U1111111"]
    assert app_mod.RISK_SETTINGS_FILE.name.startswith(".")
