"""v0.4 routes: the chain behind POST /session, the Codex route through Hermes core's signer, and
what is logged (which provider served; never a secret)."""

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
FREE = "AIzaFREE-route-test-000000000000000000"
PAID = "AIzaPAID-route-test-111111111111111111"
EK = "ek_route_test_secret_42"


def _load_api():
    spec = importlib.util.spec_from_file_location("d2v_plugin_api_chain", ROOT / "dashboard" / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeResponse:
    def __init__(self, status, payload):
        self.status = status
        self.body = json.dumps(payload).encode()

    @property
    def text(self):
        return self.body.decode()

    def json(self):
        return json.loads(self.body)


@pytest.fixture
def env(monkeypatch):
    """secret_scope with both Gemini keys, a fake core signer, a fake Google token service."""
    state = {"keys": {"GEMINI_API_KEY": FREE, "GEMINI_API_KEY_PAID": PAID}, "signed": [], "google": [],
             "codex": (200, {"value": EK, "expires_at": 1_800_000_000}), "signed_in": True,
             "google_status": {}}

    scope = types.ModuleType("agent.secret_scope")
    scope.UnscopedSecretError = type("UnscopedSecretError", (RuntimeError,), {})
    scope.get_secret = lambda name, default=None: state["keys"].get(name) or default
    agent = types.ModuleType("agent")
    agent.secret_scope = scope

    ppr = types.ModuleType("hermes_cli.plugin_provider_requests")
    ppr.ProviderNotSignedIn = type("ProviderNotSignedIn", (RuntimeError,), {})

    def credentialed_provider_request(provider, method, url, *, json=None, headers=None, timeout=30.0):
        if not state["signed_in"]:
            raise ppr.ProviderNotSignedIn("Not signed in to Codex in Hermes.")
        state["signed"].append({"provider": provider, "method": method, "url": url, "json": json})
        return FakeResponse(*state["codex"])

    ppr.credentialed_provider_request = credentialed_provider_request
    cli = types.ModuleType("hermes_cli")
    cli.plugin_provider_requests = ppr
    for name, mod in (("agent", agent), ("agent.secret_scope", scope), ("hermes_cli", cli),
                      ("hermes_cli.plugin_provider_requests", ppr)):
        monkeypatch.setitem(sys.modules, name, mod)

    api = _load_api()

    def poster(url, headers, payload, timeout):
        key = headers["x-goog-api-key"]
        state["google"].append(key)
        return state["google_status"].get(key, (200, {"name": f"auth_tokens/{'paid' if key == PAID else 'free'}"}))

    real = api.live.mint_session
    monkeypatch.setattr(api.live, "mint_session", lambda key, cfg, **kw: real(key, cfg, **{**kw, "poster": poster}))
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/dawn2-voice")
    state["client"] = TestClient(app)
    return state


URL = "/api/plugins/dawn2-voice"


def test_status_lists_the_chain_with_presence_only(env):
    body = env["client"].get(f"{URL}/status").json()
    assert [(p["id"], p["ready"]) for p in body["providers"]] == [
        ("gemini-free", True), ("openai-codex", True), ("gemini-paid", True)]
    text = json.dumps(body)
    assert FREE not in text and PAID not in text
    assert env["signed"] == []  # /status never calls OpenAI


def test_free_quota_falls_back_to_codex_signed_by_core(env, caplog):
    caplog.set_level(logging.DEBUG)
    env["google_status"][FREE] = (429, {"error": {"status": "RESOURCE_EXHAUSTED"}})
    r = env["client"].post(f"{URL}/session", json={})
    assert r.status_code == 200
    out = r.json()
    assert out["provider"] == "openai-codex" and out["transport"] == "openai-realtime"
    assert out["client_secret"] == EK
    assert out["offer_url"] == "https://api.openai.com/v1/realtime/calls"
    assert out["attempts"] == [{"provider": "gemini-free", "reason": "quota"}]
    signed = env["signed"][0]
    assert (signed["provider"], signed["method"], signed["url"]) == (
        "openai-codex", "POST", "https://api.openai.com/v1/realtime/client_secrets")
    # default brain: hermes: no tools, and the server never creates a response by itself
    assert "tools" not in signed["json"]["session"]
    assert signed["json"]["session"]["audio"]["input"]["turn_detection"]["create_response"] is False
    assert out["brain"] == "hermes"
    assert "voice provider openai-codex serving (connect; model=gpt-realtime-2.1; skipped gemini-free:quota)" in caplog.text
    assert EK not in caplog.text and FREE not in caplog.text


def _settings(monkeypatch, **settings):
    cli = sys.modules["hermes_cli"]
    config = types.ModuleType("hermes_cli.config")
    config.load_config_readonly = lambda: {"plugins": {"entries": {"dawn2-voice": {"settings": settings}}}}
    cli.config = config
    monkeypatch.setitem(sys.modules, "hermes_cli.config", config)


def test_mid_call_switch_skips_codex_by_default_and_never_asks_the_failed_provider(env, caplog):
    caplog.set_level(logging.INFO)
    r = env["client"].post(f"{URL}/session", json={
        "exclude": ["gemini-free"], "switch_from": "gemini-free", "reason": "network",
        "carry": "User: book a table\nVoice: I'm checking."})
    out = r.json()
    # 1.0: fallback_mid_call defaults to the Gemini keys only; Codex is never started mid-call
    assert out["provider"] == "gemini-paid"
    assert {"provider": "openai-codex", "reason": "mid_call_off"} in out["attempts"]
    assert env["signed"] == []
    assert env["google"] == [PAID]  # the failed provider is not asked again
    assert "switched from gemini-free after network" in caplog.text


def test_mid_call_switch_to_codex_when_fallback_mid_call_allows_it(env, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    _settings(monkeypatch, fallback_mid_call="all")
    out = env["client"].post(f"{URL}/session", json={
        "exclude": ["gemini-free"], "switch_from": "gemini-free", "reason": "network",
        "carry": "User: book a table\nVoice: I'm checking."}).json()
    assert out["provider"] == "openai-codex"
    # brain: hermes needs no carry-over (the renderer keeps the conversation; the voice only reads)
    assert "User: book a table" not in env["signed"][0]["json"]["session"]["instructions"]
    assert env["google"] == []


def test_mid_call_with_no_allowed_provider_is_a_503_naming_the_setting(env, monkeypatch):
    _settings(monkeypatch, providers="gemini-free,openai-codex")
    r = env["client"].post(f"{URL}/session", json={
        "exclude": ["gemini-free"], "switch_from": "gemini-free", "reason": "quota"})
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert detail["attempts"] == [{"provider": "gemini-free", "reason": "excluded"},
                                  {"provider": "openai-codex", "reason": "mid_call_off"}]
    assert env["signed"] == []


def test_a_new_call_may_still_start_on_codex(env):
    env["google_status"][FREE] = (429, {"error": "quota"})
    out = env["client"].post(f"{URL}/session", json={}).json()
    assert out["provider"] == "openai-codex"  # fallback_mid_call only limits running calls


def test_same_provider_reconnect_is_pinned_and_ignores_resume_handles(env, caplog):
    caplog.set_level(logging.INFO)
    out = env["client"].post(f"{URL}/session", json={
        "provider": "openai-codex", "reconnect": True, "reason": "network", "resume_handle": "h-1"}).json()
    assert out["provider"] == "openai-codex"
    assert env["google"] == []
    assert "serving (reconnect;" in caplog.text and "after network" in caplog.text


def test_not_signed_in_skips_codex_to_paid_gemini(env):
    env["google_status"][FREE] = (403, {"error": "PERMISSION_DENIED"})
    env["signed_in"] = False
    out = env["client"].post(f"{URL}/session", json={}).json()
    assert out["provider"] == "gemini-paid"
    assert out["attempts"] == [{"provider": "gemini-free", "reason": "auth"},
                               {"provider": "openai-codex", "reason": "not_signed_in"}]
    assert env["google"] == [FREE, PAID]


def test_everything_refused_is_one_clear_error_with_every_reason(env):
    env["google_status"][FREE] = (429, {"error": "quota"})
    env["google_status"][PAID] = (503, {"error": "overloaded"})
    env["codex"] = (429, {"error": {"code": "insufficient_quota", "message": "quota"}})
    r = env["client"].post(f"{URL}/session", json={})
    assert r.status_code == 502
    detail = r.json()["detail"]
    assert detail["reason"] == "exhausted"
    assert [a["reason"] for a in detail["attempts"]] == ["quota", "quota", "unavailable"]
    assert "ChatGPT (Codex subscription): quota or rate limit" in detail["message"]


def test_custom_order_and_resume_pinning(env, monkeypatch):
    cli = sys.modules["hermes_cli"]
    config = types.ModuleType("hermes_cli.config")
    config.load_config_readonly = lambda: {"plugins": {"entries": {"dawn2-voice": {
        "settings": {"providers": "gemini-paid,gemini-free"}}}}}
    cli.config = config
    monkeypatch.setitem(sys.modules, "hermes_cli.config", config)
    out = env["client"].post(f"{URL}/session", json={}).json()
    assert out["provider"] == "gemini-paid"
    out = env["client"].post(f"{URL}/session", json={"provider": "gemini-free", "resume_handle": "h-7"}).json()
    assert out["provider"] == "gemini-free"
    assert out["setup"]["setup"]["sessionResumption"] == {"handle": "h-7"}


def test_a_codex_error_body_is_never_returned_or_logged(env, caplog):
    caplog.set_level(logging.DEBUG)
    env["keys"] = {}
    env["codex"] = (401, {"error": {"message": "Incorrect API key provided: sk-proj-LEAKY"}})
    r = env["client"].post(f"{URL}/session", json={})
    assert r.status_code == 502
    assert "LEAKY" not in r.text and "LEAKY" not in caplog.text
    assert {"provider": "openai-codex", "reason": "auth"} in r.json()["detail"]["attempts"]
