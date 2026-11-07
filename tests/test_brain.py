"""v0.6 "Hermes is the brain": the backend half (settings, provider sessions, latency line).

The renderer half (classifier, delegation of every substantive turn, no voice-model content) is in
tests/js/brain.test.mjs.
"""

from __future__ import annotations

import importlib.util
import json
import logging
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from gemini_live_chat import latency, live, openai_rt, persona, providers

ROOT = Path(__file__).resolve().parents[1]
FREE, PAID = "AIzaFREE...0001", "AIzaPAID...0002"
EK = "ek_test_secret_123456"


def cfg(**settings):
    return live.resolve_persona(live.settings(settings or None))


class Gemini:
    def __init__(self):
        self.calls = []

    def __call__(self, url, headers, payload, timeout):
        self.calls.append(payload)
        return 200, {"name": "auth_tokens/x"}


class Codex:
    def __init__(self):
        self.calls = []

    def __call__(self, url, body, timeout):
        self.calls.append(body)
        return 200, {"value": EK, "expires_at": 1_800_000_000}, ""


def src(gem, codex):
    keys = {"GEMINI_API_KEY": FREE, "GEMINI_API_KEY_PAID": PAID}
    return providers.Sources(secret=lambda n: keys.get(n, ""), codex_post=codex, gemini_post=gem)


def test_brain_defaults_to_hermes_and_validates():
    assert live.settings(None)["brain"] == "hermes"
    assert live.settings({"brain": "voice"})["brain"] == "voice"
    bad = live.settings({"brain": "gemini"})
    assert bad["brain"] == "hermes" and any("settings.brain" in p for p in bad["problems"])
    assert live.client_settings(cfg())["brain"] == "hermes"


def test_gemini_hermes_setup_has_no_tools_and_a_relay_persona():
    setup = live.build_setup(cfg(persona_name="Ray"), carry="User: hi")
    assert "tools" not in setup  # the voice can neither delegate nor hang up by itself
    text = setup["systemInstruction"]["parts"][0]["text"]
    assert text.startswith("Identity: You are the voice of Ray")
    assert persona.SAY_TAG in text and "word for word" in text
    assert "When the user speaks, stay silent" in text
    assert "hermes_task" not in text and "Hermes result" not in text
    assert "User: hi" not in text  # no carry-over: the renderer keeps the conversation
    # VAD, barge-in and transcription stay exactly as in voice mode
    voice = live.build_setup(cfg(persona_name="Ray", brain="voice"))
    for key in ("realtimeInputConfig", "inputAudioTranscription", "outputAudioTranscription",
                "generationConfig", "contextWindowCompression"):
        assert setup[key] == voice[key], key


def test_voice_mode_is_the_v05_setup_byte_for_byte():
    setup = live.build_setup(cfg(brain="voice"))
    assert [d["name"] for d in setup["tools"][0]["functionDeclarations"]] == ["hermes_task", "end_call"]
    assert setup["systemInstruction"]["parts"][0]["text"] == persona.instructions(
        "he", name="Hermes", gender="male", voice="Charon", engine="gemini")


def test_openai_hermes_session_never_answers_by_itself():
    session = openai_rt.build_session(cfg(persona_name="Ray"))
    td = session["audio"]["input"]["turn_detection"]
    assert td["create_response"] is False  # the server never creates a response on its own
    assert td["interrupt_response"] is True and td["type"] == "server_vad"
    assert "tools" not in session and "tool_choice" not in session
    assert session["instructions"].startswith("Identity: You are the voice of Ray")
    assert session["audio"]["input"]["transcription"]["model"] == openai_rt.TRANSCRIBE_MODEL
    voice = openai_rt.build_session(cfg(persona_name="Ray", brain="voice"))
    assert voice["audio"]["input"]["turn_detection"]["create_response"] is True
    assert [t["name"] for t in voice["tools"]] == ["hermes_task", "end_call"]


@pytest.mark.parametrize("pid", list(providers.PROVIDERS))
def test_every_provider_serves_hermes_mode_without_delegation_tools(pid):
    gem, codex = Gemini(), Codex()
    minted, attempts = providers.connect([pid], cfg(persona_name="Ray"), src(gem, codex))
    assert attempts == [] and minted["brain"] == "hermes"
    sent = gem.calls[0]["bidiGenerateContentSetup"] if gem.calls else codex.calls[0]["session"]
    assert "hermes_task" not in json.dumps(sent) and "end_call" not in json.dumps(sent)
    assert FREE not in json.dumps(minted) and PAID not in json.dumps(minted)


def test_extra_instructions_follow_the_relay_rules():
    text = persona.relay_instructions("Speak a little slower.", name="Ray", gender="male")
    assert text.index("Rules:") < text.index("Speak a little slower.")
    assert "masculine" in text


def test_latency_record_is_numbers_and_enums_only():
    rec = latency.clean({"provider": "openai-codex", "brain": "hermes", "submit": 410, "first_text": 2100.7,
                         "first_audio": 1300, "first_answer_audio": 2650, "ack": True, "silence_ms": 1000,
                         "text": "what is left to do", "extra": "x"})
    assert latency.line(rec) == ("voice latency provider=openai-codex brain=hermes kind=turn eos->submit=410ms "
                                 "eos->first_text=2100ms eos->first_audio=1300ms eos->first_answer_audio=2650ms "
                                 "ack=yes silence_ms=1000")
    odd = latency.clean({"provider": "<script>", "brain": "x", "submit": -5, "first_text": "12", "first_audio": True,
                         "first_answer_audio": 10 ** 9})
    assert odd is None  # nothing valid to log
    part = latency.clean({"provider": "gemini-free", "kind": "abandoned", "submit": 300})
    assert latency.line(part).startswith("voice latency provider=gemini-free brain=unknown kind=abandoned eos->submit=300ms eos->first_text=-")


def test_latency_route_logs_one_line_without_content(caplog):
    spec = importlib.util.spec_from_file_location("glc_plugin_api_latency", ROOT / "dashboard" / "plugin_api.py")
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/gemini-live-chat")
    client = TestClient(app)
    caplog.set_level(logging.INFO)
    r = client.post("/api/plugins/gemini-live-chat/latency", json={
        "provider": "gemini-free", "brain": "hermes", "submit": 350, "first_text": 1900, "first_audio": 1200,
        "first_answer_audio": 2400, "ack": True, "silence_ms": 1000, "transcript": "SECRET-WORDS"})
    assert r.json() == {"ok": True}
    assert "voice latency provider=gemini-free brain=hermes kind=turn eos->submit=350ms" in caplog.text
    assert "SECRET-WORDS" not in caplog.text
    assert client.post("/api/plugins/gemini-live-chat/latency", json={"x": 1}).json() == {"ok": False}
