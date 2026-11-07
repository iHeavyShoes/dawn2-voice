"""v0.4: provider chain selection, typed fallback, the Codex (OpenAI Realtime) mint, and that the
persona / delegation contract is the same on every provider."""

from __future__ import annotations

import json
import logging

import pytest

from gemini_live_chat import live, openai_rt, persona, providers

FREE_KEY = "AIzaFREE-not-a-real-key-000000000000000"
PAID_KEY = "AIzaPAID-not-a-real-key-111111111111111"
EK = "ek_test_client_secret_0123456789"


class Gemini:
    """Fake Google token service, per key."""

    def __init__(self, answers=None):
        self.answers = answers or {}
        self.calls = []

    def __call__(self, url, headers, payload, timeout):
        key = headers["x-goog-api-key"]
        self.calls.append({"key": key, "payload": payload})
        status, answer = self.answers.get(key, (200, {"name": f"auth_tokens/{'paid' if key == PAID_KEY else 'free'}"}))
        return status, answer


class Codex:
    """Fake core signer for openai-codex."""

    def __init__(self, status=200, payload=None, exc=None):
        self.status, self.exc = status, exc
        self.payload = payload if payload is not None else {"value": EK, "expires_at": 1_800_000_000}
        self.calls = []

    def __call__(self, url, body, timeout):
        self.calls.append({"url": url, "body": body})
        if self.exc:
            raise self.exc
        return self.status, self.payload, "" if self.status < 400 else json.dumps(self.payload)


def cfg(**settings):
    return live.resolve_persona(live.settings(settings or None))


def src(free=FREE_KEY, paid=PAID_KEY, gemini=None, codex=None):
    keys = {"GEMINI_API_KEY": free or "", "GEMINI_API_KEY_PAID": paid or ""}
    return providers.Sources(secret=lambda n: keys.get(n, ""), codex_post=codex, gemini_post=gemini or Gemini())


# ── settings ─────────────────────────────────────────────────────────────────────────────────────

def test_default_chain_order_is_free_then_codex_then_paid():
    assert live.settings(None)["providers"] == ["gemini-free", "openai-codex", "gemini-paid"]


@pytest.mark.parametrize("raw,expected,problems", [
    ("openai-codex, gemini-free", ["openai-codex", "gemini-free"], 0),
    (["gemini-paid", "gemini-paid", "gemini-free"], ["gemini-paid", "gemini-free"], 0),
    ("gemini-free,nope", ["gemini-free"], 1),
    ("nope", list(providers.DEFAULT_ORDER), 2),
    (42, list(providers.DEFAULT_ORDER), 1),
])
def test_chain_order_is_configurable_and_validated(raw, expected, problems):
    out = live.settings({"providers": raw})
    assert out["providers"] == expected
    assert len(out["problems"]) == problems


def test_openai_settings_are_validated():
    out = live.settings({"openai_model": "gpt-4o; rm", "openai_voice": "Charon"})
    assert out["openai_model"] == openai_rt.DEFAULT_MODEL and out["openai_voice"] == "auto"
    assert len(out["problems"]) == 2
    assert live.settings({"openai_model": "gpt-realtime-mini"})["openai_model"] == "gpt-realtime-mini"


# ── chain selection at connect time ──────────────────────────────────────────────────────────────

def test_first_ready_provider_serves():
    minted, attempts = providers.connect(cfg()["providers"], cfg(), src(codex=Codex()))
    assert minted["provider"] == "gemini-free" and minted["transport"] == "gemini-live"
    assert minted["url"].endswith("access_token=auth_tokens/free")
    assert attempts == []


def test_free_quota_falls_back_to_codex_and_says_why():
    gem = Gemini({FREE_KEY: (429, {"error": {"status": "RESOURCE_EXHAUSTED"}})})
    codex = Codex()
    minted, attempts = providers.connect(cfg()["providers"], cfg(), src(gemini=gem, codex=codex))
    assert minted["provider"] == "openai-codex" and minted["transport"] == "openai-realtime"
    assert minted["client_secret"] == EK and minted["offer_url"] == openai_rt.CALLS_URL
    assert attempts == [{"provider": "gemini-free", "reason": "quota"}]
    assert len(codex.calls) == 1 and codex.calls[0]["url"] == openai_rt.CLIENT_SECRETS_URL


def test_codex_quota_falls_through_to_paid_gemini():
    gem = Gemini({FREE_KEY: (429, {"error": "quota"})})
    minted, attempts = providers.connect(cfg()["providers"], cfg(),
                                         src(gemini=gem, codex=Codex(429, {"error": {"code": "insufficient_quota"}})))
    assert minted["provider"] == "gemini-paid"
    assert minted["url"].endswith("access_token=auth_tokens/paid")
    assert [a["reason"] for a in attempts] == ["quota", "quota"]
    assert gem.calls[-1]["key"] == PAID_KEY


def test_missing_paid_key_is_skipped_without_a_request():
    gem = Gemini({FREE_KEY: (401, {"error": "API key not valid"})})
    minted, attempts = providers.connect(cfg()["providers"], cfg(), src(paid="", gemini=gem, codex=None))
    assert minted is None
    assert attempts == [{"provider": "gemini-free", "reason": "auth"},
                        {"provider": "openai-codex", "reason": "unsupported"},
                        {"provider": "gemini-paid", "reason": "no_key"}]
    assert [c["key"] for c in gem.calls] == [FREE_KEY]  # nothing sent without a key
    msg = providers.failure_message(attempts)
    assert "Gemini (free key): credential refused" in msg and "Gemini (paid key): no key" in msg


def test_codex_not_signed_in_is_typed_and_skipped():
    minted, attempts = providers.connect(["openai-codex", "gemini-paid"], cfg(),
                                         src(codex=Codex(exc=openai_rt.NotSignedIn())))
    assert minted["provider"] == "gemini-paid"
    assert attempts == [{"provider": "openai-codex", "reason": "not_signed_in"}]


def test_excluded_providers_are_skipped_and_never_retried():
    gem = Gemini()
    minted, attempts = providers.connect(cfg()["providers"], cfg(), src(gemini=gem, codex=Codex()),
                                         exclude=["gemini-free"])
    assert minted["provider"] == "openai-codex"
    assert attempts == [{"provider": "gemini-free", "reason": "excluded"}]
    assert gem.calls == []


def test_resume_is_pinned_to_the_issuing_provider_without_fallback():
    gem = Gemini({PAID_KEY: (503, {"error": "overloaded"})})
    minted, attempts = providers.connect(cfg()["providers"], cfg(), src(gemini=gem, codex=Codex()),
                                         only="gemini-paid", resume_handle="h-9")
    assert minted is None and attempts == [{"provider": "gemini-paid", "reason": "unavailable"}]
    minted, _ = providers.connect(cfg()["providers"], cfg(), src(codex=Codex()), only="gemini-paid", resume_handle="h-9")
    assert minted["setup"]["setup"]["sessionResumption"] == {"handle": "h-9"}
    # a fresh (non-resume) connect never sends a handle, even if one is passed
    minted, _ = providers.connect(cfg()["providers"], cfg(), src(), resume_handle="h-9")
    assert minted["setup"]["setup"]["sessionResumption"] == {}


@pytest.mark.parametrize("status,detail,reason", [
    (429, "", "quota"), (400, "RESOURCE_EXHAUSTED", "quota"), (403, "", "auth"), (401, "", "auth"),
    (400, "API key not valid. Please pass a valid API key.", "auth"), (500, "", "unavailable"),
    (400, "bad field", "rejected"),
])
def test_gemini_refusals_are_classified(status, detail, reason):
    with pytest.raises(live.VoiceError) as err:
        live.mint_session(FREE_KEY, None, poster=lambda *a: (status, {"error": detail}))
    assert err.value.reason == reason
    assert FREE_KEY not in err.value.message


@pytest.mark.parametrize("status,detail,reason", [
    (429, "", "quota"), (400, "insufficient_quota", "quota"), (403, "usage limit reached", "quota"),
    (401, "", "auth"), (403, "", "auth"), (503, "", "unavailable"), (400, "bad", "rejected"),
])
def test_codex_refusals_are_classified(status, detail, reason):
    assert openai_rt.classify(status, detail) == reason


# ── the Codex mint ───────────────────────────────────────────────────────────────────────────────

def test_codex_session_carries_persona_tools_and_voice():
    codex = Codex()
    out = openai_rt.mint_session(codex, cfg(persona_name="Ray", persona_gender="male"))
    session = codex.calls[0]["body"]["session"]
    assert session["type"] == "realtime" and session["model"] == openai_rt.DEFAULT_MODEL
    assert session["audio"]["output"]["voice"] == "cedar" and out["voice"] == "cedar"
    vad = session["audio"]["input"]["turn_detection"]
    assert vad["type"] == "server_vad" and vad["interrupt_response"] is True  # barge-in
    assert vad["silence_duration_ms"] == 1000
    assert [t["name"] for t in session["tools"]] == ["hermes_task", "end_call"]
    assert session["tools"][0]["parameters"]["type"] == "object"  # JSON schema, lower-case
    assert "You are Ray" in session["instructions"] and "OpenAI's Realtime speech model" in session["instructions"]
    assert "Gemini" not in session["instructions"]
    assert set(out) >= {"transport", "client_secret", "offer_url", "model", "voice"}


def test_codex_female_persona_and_explicit_voice():
    assert openai_rt.build_session(cfg(persona_gender="female"))["audio"]["output"]["voice"] == "marin"
    assert openai_rt.build_session(cfg(openai_voice="sage"))["audio"]["output"]["voice"] == "sage"


def test_codex_nested_secret_shape_is_accepted():
    out = openai_rt.mint_session(Codex(payload={"client_secret": {"value": EK, "expires_at": 5}}), cfg())
    assert out["client_secret"] == EK and out["expires_at"] == 5


@pytest.mark.parametrize("payload", [{}, {"value": ""}, {"value": "has space and {json}"}, ["x"]])
def test_codex_unexpected_answer_is_rejected(payload):
    with pytest.raises(live.VoiceError) as err:
        openai_rt.mint_session(Codex(payload=payload), cfg())
    assert err.value.reason == "rejected"


def test_codex_errors_never_echo_exception_text():
    with pytest.raises(live.VoiceError) as err:
        openai_rt.mint_session(Codex(exc=OSError("Authorization: Bearer sk-leaky")), cfg())
    assert err.value.reason == "unreachable" and "leaky" not in err.value.message
    with pytest.raises(live.VoiceError) as err:
        openai_rt.mint_session(Codex(exc=PermissionError("must declare requires_auth")), cfg())
    assert err.value.reason == "auth"
    with pytest.raises(live.VoiceError) as err:
        openai_rt.mint_session(None, cfg())
    assert err.value.reason == "unsupported"


# ── same contract on every provider ──────────────────────────────────────────────────────────────

def _instructions(minted):
    if minted["transport"] == "gemini-live":
        return minted["setup"]["setup"]["systemInstruction"]["parts"][0]["text"]
    return CODEX_LAST["body"]["session"]["instructions"]


CODEX_LAST = {}


@pytest.mark.parametrize("pid", list(providers.PROVIDERS))
def test_delegation_contract_is_identical_on_every_provider(pid):
    codex = Codex()
    minted, _ = providers.connect([pid], cfg(persona_name="Ray"), src(codex=codex))
    CODEX_LAST.clear()
    if codex.calls:
        CODEX_LAST.update(codex.calls[0])
    text = _instructions(minted)
    # every v0.3 behaviour lives in the shared persona: delegation, ack-only, full readout, end_call
    for needle in ("hermes_task", persona.RESULT_TAG, "end_call", "You are Ray", "Start the conversation in Hebrew"):
        assert needle in text, (pid, needle)
    ref = persona.instructions("he", name="Ray", gender="male", voice="X", engine="gemini")
    strip = lambda t: t.replace("Gemini", "").replace("Google", "").replace("ChatGPT", "").replace("OpenAI", "")
    # only the engine sentence and the voice name differ between providers
    assert len(set(strip(text).split(". ")) ^ set(strip(ref).split(". "))) <= 6
    tools = (minted["setup"]["setup"]["tools"][0]["functionDeclarations"] if minted["transport"] == "gemini-live"
             else CODEX_LAST["body"]["session"]["tools"])
    assert [t["name"] for t in tools] == ["hermes_task", "end_call"]


def test_carry_is_put_into_the_next_providers_instructions_safely():
    carry = "User: what's on my calendar?\nRay: I passed it on.\x00\x07" + "x" * 5000
    codex = Codex()
    providers.connect(["openai-codex"], cfg(), src(codex=codex), carry=carry)
    text = codex.calls[0]["body"]["session"]["instructions"]
    assert "voice provider changed in the middle of this call" in text
    assert "\x00" not in text and "\x07" not in text
    assert len(text) - len(persona.instructions("he", name="Hermes", gender="male", voice="cedar", engine="openai")) < persona.CARRY_LIMIT + 600
    gem = Gemini()
    providers.connect(["gemini-paid"], cfg(), src(gemini=gem), carry="User: hi\nHermes: hello")
    assert "User: hi" in gem.calls[0]["payload"]["bidiGenerateContentSetup"]["systemInstruction"]["parts"][0]["text"]
    gem = Gemini()
    providers.connect(["gemini-free"], cfg(), src(gemini=gem))
    assert "voice provider changed" not in json.dumps(gem.calls[0]["payload"])


def test_log_line_names_the_provider_and_never_a_secret():
    gem = Gemini({FREE_KEY: (429, {"error": "quota"})})
    minted, _ = providers.connect(cfg()["providers"], cfg(), src(gemini=gem, codex=Codex()))
    line = providers.log_line(minted, "mid_call", "gemini-free", "network")
    assert line.startswith("voice provider openai-codex serving (mid_call; model=gpt-realtime-2.1")
    assert "switched from gemini-free after network" in line and "skipped gemini-free:quota" in line
    assert EK not in line and FREE_KEY not in line


def test_describe_reports_presence_only():
    chain = providers.describe(providers.DEFAULT_ORDER, src(paid="", codex=Codex()))
    assert [(p["id"], p["ready"], p["reason"]) for p in chain] == [
        ("gemini-free", True, None), ("openai-codex", True, None), ("gemini-paid", False, "no_key")]
    assert FREE_KEY not in json.dumps(chain)
