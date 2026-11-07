"""v0.5: the provider picker (choice stored in the plugin's data dir, never config.yaml), pinned
providers without fallback, and the paid-Gemini billing refusal (HTTP 402 / billing bodies)."""

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

from gemini_live_chat import live, prefs, providers

ROOT = Path(__file__).resolve().parents[1]
FREE = "AIzaFR...0000"
PAID = "AIzaPA...1111"
EK = "ek_picker_test_secret_42"
URL = "/api/plugins/gemini-live-chat"

# Google's Prepay refusal at a $0 credit balance (checked ai.google.dev/gemini-api/docs/billing,
# 2026-11-07: every key of that billing account gets HTTP 402 until credit is added).
PREPAY_402 = (402, {"error": {"code": 402, "status": "PAYMENT_REQUIRED",
                              "message": "Your prepayment credit balance is $0. Add credits to continue."}})
BILLING_429 = (429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED",
                               "message": "Billing account has no remaining prepaid credit."}})
BILLING_403 = (403, {"error": {"code": 403, "status": "PERMISSION_DENIED",
                               "message": "This API method requires billing to be enabled."}})


# ── classification ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("status,body", [PREPAY_402, BILLING_429, BILLING_403,
                                         (402, {}), (400, {"error": "BILLING_DISABLED"})])
def test_billing_refusals_are_typed_billing_not_quota_or_auth(status, body):
    with pytest.raises(live.VoiceError) as err:
        live.mint_session(PAID, None, key_name="GEMINI_API_KEY_PAID", poster=lambda *a: (status, body))
    assert err.value.reason == "billing"
    assert "no credit or no billing" in err.value.message
    assert PAID not in err.value.message


@pytest.mark.parametrize("status,body,reason", [
    (429, {"error": {"status": "RESOURCE_EXHAUSTED", "message": "Quota exceeded for requests per minute"}}, "quota"),
    (403, {"error": {"status": "PERMISSION_DENIED"}}, "auth"),
])
def test_plain_quota_and_auth_are_not_mistaken_for_billing(status, body, reason):
    assert live.classify(status, body) == reason


def test_unavailable_text_is_the_ui_wording():
    assert providers.unavailable_text("gemini-paid", "billing") == "gemini-paid unavailable: no credit / billing"


# ── prefs (store injected) ──────────────────────────────────────────────────────────────────────

class DictStore:
    def __init__(self):
        self.data = {}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        json.dumps(value)  # what PluginState requires
        self.data[key] = value


class BrokenStore:
    def get(self, key, default=None):
        raise RuntimeError("Cannot parse plugin state")

    def set(self, key, value):
        raise OSError("read-only")


def test_prefs_default_to_auto_and_validate_the_choice():
    p = prefs.Prefs(DictStore())
    assert p.choice() == "auto"
    assert p.set_choice("gemini-paid") and p.choice() == "gemini-paid"
    with pytest.raises(ValueError):
        p.set_choice("gpt-4o")
    p.store.data[prefs.CHOICE_KEY] = "garbage"
    assert p.choice() == "auto"


def test_prefs_remember_refusals_and_clear_them_when_the_provider_serves():
    p = prefs.Prefs(DictStore(), now=lambda: 1000.0)
    p.record([{"provider": "gemini-free", "reason": "quota"}, {"provider": "openai-codex", "reason": "excluded"},
              {"provider": "gemini-paid", "reason": "no_key"}])
    assert p.health() == {"gemini-free": {"reason": "quota", "at": 1000.0}}  # skips say nothing
    p.record([], served="gemini-free")
    assert p.health()["gemini-free"]["reason"] is None
    assert p.report("gemini-paid", "billing") is True
    assert p.report("gemini-paid", "<script>") is False and p.report("nope", "quota") is False
    assert p.health()["gemini-paid"]["reason"] == "billing"


def test_a_broken_store_never_breaks_the_voice_button(caplog):
    p = prefs.Prefs(BrokenStore())
    assert p.choice() == "auto" and p.health() == {}
    assert p.set_choice("gemini-free") is False
    p.record([{"provider": "gemini-free", "reason": "quota"}])  # no raise


def test_picker_options_show_presence_refusals_and_greyed_out_missing():
    src = providers.Sources(secret=lambda n: {"GEMINI_API_KEY": FREE}.get(n, ""), codex_post=lambda *a: (200, {}, ""))
    opts = {o["id"]: o for o in providers.picker(
        list(providers.DEFAULT_ORDER), src, {"openai-codex": {"reason": "quota", "at": 1.0}}, "auto")}
    assert list(opts) == ["auto", "gemini-free", "openai-codex", "gemini-paid"]
    assert opts["auto"]["selected"] and opts["auto"]["state"] == "ready"
    assert opts["auto"]["detail"] == "Gemini (free key) -> ChatGPT (Codex subscription)"
    assert opts["gemini-free"]["state"] == "ready" and opts["gemini-free"]["detail"] == "GEMINI_API_KEY is set"
    assert opts["openai-codex"]["state"] == "refused"
    assert opts["openai-codex"]["detail"] == "openai-codex unavailable: quota or rate limit"
    assert opts["gemini-paid"]["state"] == "missing" and opts["gemini-paid"]["reason"] == "no_key"
    assert opts["gemini-paid"]["detail"].startswith("gemini-paid unavailable: no key (add GEMINI_API_KEY_PAID")
    assert FREE not in json.dumps(opts)


# ── routes ──────────────────────────────────────────────────────────────────────────────────────

def _load_api():
    spec = importlib.util.spec_from_file_location("glc_plugin_api_picker", ROOT / "dashboard" / "plugin_api.py")
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
def env(monkeypatch, tmp_path):
    """secret_scope with both keys, a fake core signer, a fake Google, and a file-backed stand-in for
    hermes_cli.plugins_state.PluginState rooted at a per-test HERMES_HOME (``plugin-data/<id>/state.json``)."""
    state = {"keys": {"GEMINI_API_KEY": FREE, "GEMINI_API_KEY_PAID": PAID}, "signed": [], "google": [],
             "codex": (200, {"value": EK, "expires_at": 1_800_000_000}), "signed_in": True,
             "google_status": {}, "home": tmp_path, "settings": {}}

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
        state["signed"].append(url)
        return FakeResponse(*state["codex"])

    ppr.credentialed_provider_request = credentialed_provider_request

    class PluginState:
        """Same contract as hermes_cli.plugins_state.PluginState (get/set, JSON, one file)."""

        def __init__(self, plugin_id, data_namespace=""):
            self.path = state["home"] / "plugin-data" / plugin_id / "state.json"

        def _read(self):
            return json.loads(self.path.read_text("utf-8")) if self.path.exists() else {}

        def get(self, key, default=None):
            return self._read().get(key, default)

        def set(self, key, value):
            data = self._read()
            data[key] = value
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(data), "utf-8")

    plugins_state = types.ModuleType("hermes_cli.plugins_state")
    plugins_state.PluginState = PluginState
    config = types.ModuleType("hermes_cli.config")
    config.load_config_readonly = lambda: {"plugins": {"entries": {"gemini-live-chat": {"settings": state["settings"]}}}}
    cli = types.ModuleType("hermes_cli")
    cli.plugin_provider_requests, cli.plugins_state, cli.config = ppr, plugins_state, config
    for name, mod in (("agent", agent), ("agent.secret_scope", scope), ("hermes_cli", cli),
                      ("hermes_cli.plugin_provider_requests", ppr), ("hermes_cli.plugins_state", plugins_state),
                      ("hermes_cli.config", config)):
        monkeypatch.setitem(sys.modules, name, mod)

    def poster(url, headers, payload, timeout):
        key = headers["x-goog-api-key"]
        state["google"].append(key)
        return state["google_status"].get(key, (200, {"name": f"auth_tokens/{'paid' if key == PAID else 'free'}"}))

    def start():  # a fresh plugin load (gateway restart): nothing survives but the state file
        api = _load_api()
        real = api.live.mint_session
        monkeypatch.setattr(api.live, "mint_session", lambda key, cfg, **kw: real(key, cfg, **{**kw, "poster": poster}))
        app = FastAPI()
        app.include_router(api.router, prefix=URL)
        state["client"] = TestClient(app)
        return state["client"]

    state["start"] = start
    start()
    return state


def _options(body):
    return {o["id"]: o for o in body["picker"]["options"]}


def test_status_carries_the_picker_with_auto_by_default(env):
    body = env["client"].get(f"{URL}/status").json()
    assert body["picker"]["choice"] == "auto" and body["picker"]["persistent"] is True
    opts = _options(body)
    assert [o for o in opts] == ["auto", "gemini-free", "openai-codex", "gemini-paid"]
    assert all(o["state"] == "ready" for o in opts.values())
    assert FREE not in json.dumps(body) and PAID not in json.dumps(body)
    assert env["signed"] == [] and env["google"] == []  # /status calls nobody


def test_choice_persists_in_the_plugin_data_dir_across_restarts_never_config(env):
    r = env["client"].post(f"{URL}/choice", json={"choice": "openai-codex"})
    assert r.status_code == 200 and r.json()["choice"] == "openai-codex"
    stored = json.loads((env["home"] / "plugin-data" / "gemini-live-chat" / "state.json").read_text("utf-8"))
    assert stored["provider_choice"] == "openai-codex"
    assert not (env["home"] / "config.yaml").exists()
    client = env["start"]()  # gateway restart
    assert client.get(f"{URL}/status").json()["picker"]["choice"] == "openai-codex"
    assert client.post(f"{URL}/session", json={}).json()["provider"] == "openai-codex"


def test_invalid_choice_is_refused(env):
    r = env["client"].post(f"{URL}/choice", json={"choice": "../../config"})
    assert r.status_code == 400 and r.json()["detail"]["reason"] == "invalid"
    assert env["client"].get(f"{URL}/status").json()["picker"]["choice"] == "auto"


def test_a_pinned_provider_is_used_alone_and_its_failure_offers_auto(env):
    env["client"].post(f"{URL}/choice", json={"choice": "gemini-paid"})
    env["google_status"][PAID] = PREPAY_402
    r = env["client"].post(f"{URL}/session", json={"exclude": ["gemini-paid"]})  # a cooldown never skips a pin
    assert r.status_code == 502
    detail = r.json()["detail"]
    assert detail["reason"] == "pinned_unavailable" and detail["choice"] == "gemini-paid"
    assert detail["attempts"] == [{"provider": "gemini-paid", "reason": "billing"}]
    assert detail["message"] == ("gemini-paid unavailable: no credit / billing. "
                                 "Switch the voice provider to Auto to use the fallback chain.")
    assert env["google"] == [PAID] and env["signed"] == []  # no fallback to free or Codex


def test_mocked_402_on_the_paid_key_moves_the_chain_on_and_the_tooltip_says_billing(env, caplog):
    caplog.set_level(logging.INFO)
    env["settings"] = {"providers": "gemini-paid,gemini-free,openai-codex"}
    env["google_status"][PAID] = PREPAY_402
    r = env["client"].post(f"{URL}/session", json={})
    assert r.status_code == 200
    out = r.json()
    assert out["provider"] == "gemini-free"  # the chain moved on
    assert out["attempts"] == [{"provider": "gemini-paid", "reason": "billing"}]
    assert "skipped gemini-paid:billing" in caplog.text
    paid = _options(env["client"].get(f"{URL}/status").json())["gemini-paid"]
    assert paid["state"] == "refused" and paid["reason"] == "billing"
    assert paid["detail"].startswith("gemini-paid unavailable: no credit / billing")
    assert PAID not in caplog.text and PAID not in r.text


def test_billing_in_auto_at_the_end_of_the_chain_is_named_not_generic(env):
    env["google_status"][FREE] = (429, {"error": {"status": "RESOURCE_EXHAUSTED", "message": "quota"}})
    env["codex"] = (429, {"error": {"code": "insufficient_quota"}})
    env["google_status"][PAID] = BILLING_429
    detail = env["client"].post(f"{URL}/session", json={}).json()["detail"]
    assert [a["reason"] for a in detail["attempts"]] == ["quota", "quota", "billing"]
    assert "Gemini (paid key): no credit / billing" in detail["message"]
    assert "Add credit or billing" in detail["message"]


def test_a_refusal_is_cleared_once_the_provider_serves_again(env):
    env["client"].post(f"{URL}/choice", json={"choice": "gemini-paid"})
    env["google_status"][PAID] = PREPAY_402
    env["client"].post(f"{URL}/session", json={})
    assert _options(env["client"].get(f"{URL}/status").json())["gemini-paid"]["state"] == "refused"
    del env["google_status"][PAID]  # credit added
    assert env["client"].post(f"{URL}/session", json={}).json()["provider"] == "gemini-paid"
    assert _options(env["client"].get(f"{URL}/status").json())["gemini-paid"]["state"] == "ready"


def test_report_route_records_mid_call_refusals_ids_and_enums_only(env):
    assert env["client"].post(f"{URL}/report", json={"provider": "gemini-paid", "reason": "billing"}).json() == {"recorded": True}
    assert env["client"].post(f"{URL}/report", json={"provider": "gemini-paid", "reason": "x" * 50}).json() == {"recorded": False}
    paid = _options(env["client"].get(f"{URL}/status").json())["gemini-paid"]
    assert paid["detail"].startswith("gemini-paid unavailable: no credit / billing")


def test_a_missing_key_greys_the_option_out_and_a_pin_on_it_says_so(env):
    env["keys"].pop("GEMINI_API_KEY_PAID")
    env["client"].post(f"{URL}/choice", json={"choice": "gemini-paid"})
    body = env["client"].get(f"{URL}/status").json()
    paid = _options(body)["gemini-paid"]
    assert paid["state"] == "missing" and paid["selected"] is True
    assert body["available"] is False
    assert body["message"].startswith("gemini-paid unavailable: no key.")


def test_without_the_plugin_state_api_the_choice_still_works_but_is_not_persistent(env, monkeypatch):
    monkeypatch.delitem(sys.modules, "hermes_cli.plugins_state")
    monkeypatch.setattr(sys.modules["hermes_cli"], "plugins_state", None, raising=False)
    client = env["start"]()
    client.post(f"{URL}/choice", json={"choice": "gemini-free"})
    body = client.get(f"{URL}/status").json()
    assert body["picker"]["choice"] == "gemini-free" and body["picker"]["persistent"] is False
