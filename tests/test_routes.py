"""The two backend routes: key presence only on /status, typed refusals on /session, no key leaks."""

from __future__ import annotations

import importlib.util
import json
import logging
import sys
import types
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
FAKE_KEY = "AIzaFAKE-route-key-not-real-1111111111"


def _load_api():
    spec = importlib.util.spec_from_file_location("glc_plugin_api", ROOT / "dashboard" / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def secret(monkeypatch):
    """A stand-in for agent.secret_scope: the plugin must read the key only through it."""
    state = {"value": FAKE_KEY, "unscoped": False, "reads": []}

    class UnscopedSecretError(RuntimeError):
        pass

    def get_secret(name, default=None):
        state["reads"].append(name)
        if state["unscoped"]:
            raise UnscopedSecretError("no scope")
        return state["value"] if name == "GEMINI_API_KEY" else default

    agent = types.ModuleType("agent")
    scope = types.ModuleType("agent.secret_scope")
    scope.get_secret = get_secret
    scope.UnscopedSecretError = UnscopedSecretError
    agent.secret_scope = scope
    monkeypatch.setitem(sys.modules, "agent", agent)
    monkeypatch.setitem(sys.modules, "agent.secret_scope", scope)
    return state


@pytest.fixture
def client(secret, monkeypatch):
    api = _load_api()
    calls = []

    def poster(url, headers, payload, timeout):
        calls.append({"url": url, "headers": headers, "payload": payload})
        return 200, {"name": "auth_tokens/route-token"}

    real = api.live.mint_session
    monkeypatch.setattr(api.live, "mint_session",
                        lambda key, cfg, resume_handle=None: real(key, cfg, resume_handle=resume_handle, poster=poster))
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/gemini-live-chat")
    c = TestClient(app)
    c.calls = calls
    return c


def test_status_reports_presence_only(client, secret):
    r = client.get("/api/plugins/gemini-live-chat/status")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is True and body["reason"] is None
    assert body["settings"]["model"] == "gemini-3.8-live"
    assert FAKE_KEY not in r.text
    assert secret["reads"] == ["GEMINI_API_KEY"]


@pytest.mark.parametrize("mode", ["missing", "unscoped"])
def test_missing_or_unscoped_key_gives_clear_message(client, secret, mode):
    if mode == "missing":
        secret["value"] = None
    else:
        secret["unscoped"] = True
    s = client.get("/api/plugins/gemini-live-chat/status").json()
    assert s["available"] is False and s["reason"] == "no_key"
    assert "GEMINI_API_KEY" in s["message"]
    r = client.post("/api/plugins/gemini-live-chat/session", json={})
    assert r.status_code == 503
    assert r.json()["detail"]["reason"] == "no_key"
    assert "GEMINI_API_KEY" in r.json()["detail"]["message"]
    assert client.calls == []  # nothing sent to Google


def test_session_mints_and_does_not_leak_the_key(client, caplog):
    caplog.set_level(logging.DEBUG)
    r = client.post("/api/plugins/gemini-live-chat/session", json={"resume_handle": "h-1"})
    assert r.status_code == 200
    body = r.json()
    assert body["url"].endswith("BidiGenerateContentConstrained?access_token=auth_tokens/route-token")
    assert body["setup"]["setup"]["sessionResumption"] == {"handle": "h-1"}
    assert FAKE_KEY not in r.text
    assert FAKE_KEY not in caplog.text
    assert client.calls[0]["headers"]["x-goog-api-key"] == FAKE_KEY


def test_session_accepts_no_body(client):
    assert client.post("/api/plugins/gemini-live-chat/session").status_code == 200


def test_the_plugin_never_reads_env_files_or_os_environ():
    """Catalog rule 11: credentials only through agent.secret_scope."""
    for path in [ROOT / "__init__.py", ROOT / "dashboard" / "plugin_api.py", *(ROOT / "gemini_live_chat").glob("*.py")]:
        src = path.read_text(encoding="utf-8")
        assert "os.environ" not in src and "getenv" not in src, path
        assert ".env" not in src.replace("this Hermes profile's .env", ""), path
        assert "dotenv" not in src, path


def test_register_logs_but_never_raises_without_a_key(secret, caplog):
    secret["value"] = None
    spec = importlib.util.spec_from_file_location("glc_root", ROOT / "__init__.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    caplog.set_level(logging.INFO)
    mod.register(object())
    assert "GEMINI_API_KEY is not set" in caplog.text


@pytest.fixture
def profile(monkeypatch, tmp_path):
    """A profile home with SOUL.md and plugin settings, the way the gateway scopes a request."""
    consts = types.ModuleType("hermes_constants")
    consts.get_hermes_home = lambda: tmp_path
    cli = types.ModuleType("hermes_cli")
    config = types.ModuleType("hermes_cli.config")
    state = {"settings": {}}
    config.load_config_readonly = lambda: {"plugins": {"entries": {"gemini-live-chat": {"settings": state["settings"]}}}}
    cli.config = config
    monkeypatch.setitem(sys.modules, "hermes_constants", consts)
    monkeypatch.setitem(sys.modules, "hermes_cli", cli)
    monkeypatch.setitem(sys.modules, "hermes_cli.config", config)
    (tmp_path / "SOUL.md").write_text(
        "# Ray — Dawn 2.0\n\nYou are Ray (in Hebrew exactly ריי), the orchestrator. SECRET-SOUL-LINE\n",
        encoding="utf-8")
    return state


def test_status_and_session_speak_as_the_profile_agent(client, profile):
    s = client.get("/api/plugins/gemini-live-chat/status").json()["settings"]
    assert (s["persona_name"], s["persona_gender"], s["identity_source"], s["voice"]) == ("Ray", "male", "soul", "Charon")
    r = client.post("/api/plugins/gemini-live-chat/session", json={})
    assert r.status_code == 200
    out = r.json()
    assert out["persona_name"] == "Ray" and out["voice"] == "Charon"
    assert "You are Ray" in out["setup"]["setup"]["systemInstruction"]["parts"][0]["text"]
    # only the name crosses the wire: the SOUL text itself never goes to Google
    assert "SECRET-SOUL-LINE" not in r.text and "SECRET-SOUL-LINE" not in json.dumps(client.calls)


def test_profile_settings_override_the_soul(client, profile):
    profile["settings"] = {"persona_name": "Noa", "persona_gender": "female", "voice": "Kore", "language": "en"}
    s = client.get("/api/plugins/gemini-live-chat/status").json()["settings"]
    assert (s["persona_name"], s["persona_gender"], s["identity_source"], s["voice"]) == ("Noa", "female", "setting", "Kore")
    assert s["transcription_languages"] == ["en", "he"]


def test_no_soul_falls_back_to_hermes(client, profile, tmp_path):
    (tmp_path / "SOUL.md").unlink()
    s = client.get("/api/plugins/gemini-live-chat/status").json()["settings"]
    assert (s["persona_name"], s["identity_source"], s["voice"]) == ("Hermes", "default", "Charon")
