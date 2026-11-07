"""Token minting, setup shape, settings, and the key-handling guarantees of gemini_live_chat.live."""

from __future__ import annotations

import datetime as dt
import json

import pytest

from gemini_live_chat import live, persona

FAKE_KEY = "AIzaFAKE-test-key-not-real-0000000000"
NOW = dt.datetime(2026, 11, 7, 12, 0, 0, tzinfo=dt.timezone.utc)


class Recorder:
    def __init__(self, status=200, answer=None, exc=None):
        self.calls = []
        self.status = status
        self.answer = answer if answer is not None else {"name": "auth_tokens/abc123"}
        self.exc = exc

    def __call__(self, url, headers, payload, timeout):
        self.calls.append({"url": url, "headers": headers, "payload": payload, "timeout": timeout})
        if self.exc:
            raise self.exc
        return self.status, self.answer


def test_mint_returns_constrained_socket_and_never_the_key():
    rec = Recorder()
    out = live.mint_session(FAKE_KEY, None, poster=rec, now=NOW)
    assert out["url"] == ("wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha."
                          "GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens/abc123")
    assert FAKE_KEY not in json.dumps(out)
    call = rec.calls[0]
    assert call["url"] == "https://generativelanguage.googleapis.com/v1alpha/auth_tokens"
    assert call["headers"]["x-goog-api-key"] == FAKE_KEY  # header only, never the URL
    assert FAKE_KEY not in call["url"]


def test_token_is_single_use_short_lived_and_locks_the_whole_setup():
    rec = Recorder()
    out = live.mint_session(FAKE_KEY, None, poster=rec, now=NOW)
    body = rec.calls[0]["payload"]
    assert body["uses"] == 1
    assert body["expireTime"] == "2026-11-07T12:30:00Z"
    assert body["newSessionExpireTime"] == "2026-11-07T12:01:00Z"
    assert "fieldMask" not in body  # global lock: the renderer cannot change persona or tools
    assert body["bidiGenerateContentSetup"] == out["setup"]["setup"]


def test_setup_frame_defaults():
    setup = live.build_setup(live.settings(None))
    assert setup["model"] == "models/gemini-3.8-live"
    assert setup["generationConfig"]["responseModalities"] == ["AUDIO"]
    assert setup["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Aoede"
    assert "thinkingConfig" not in setup["generationConfig"]  # gemini-3.8-live refuses thinkingLevel
    assert setup["inputAudioTranscription"] == {} and setup["outputAudioTranscription"] == {}
    assert setup["contextWindowCompression"] == {"slidingWindow": {}}
    assert setup["sessionResumption"] == {}
    aad = setup["realtimeInputConfig"]["automaticActivityDetection"]
    assert aad == {"silenceDurationMs": 1000, "prefixPaddingMs": 300}
    names = [d["name"] for d in setup["tools"][0]["functionDeclarations"]]
    assert names == ["hermes_task", "end_call"]
    assert all(d["behavior"] == "NON_BLOCKING" for d in setup["tools"][0]["functionDeclarations"])
    assert "behavior" not in setup["tools"][0]  # the endpoint rejects it on the Tool entry


def test_persona_is_hebrew_first_with_switching_and_result_tag():
    text = live.build_setup(live.settings(None))["systemInstruction"]["parts"][0]["text"]
    assert "Start the conversation in Hebrew" in text
    assert "switch to English" in text
    assert persona.RESULT_TAG in text
    en = live.build_setup(live.settings({"language": "en"}))["systemInstruction"]["parts"][0]["text"]
    assert "Start the conversation in English" in en


def test_extended_thinking_model_gets_thinking_level():
    setup = live.build_setup(live.settings({"model": "gemini-3.8-live-extended-thinking"}))
    assert setup["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "low"}


def test_resume_handle_is_passed_and_validated():
    rec = Recorder()
    live.mint_session(FAKE_KEY, None, resume_handle="h-42_ok", poster=rec, now=NOW)
    assert rec.calls[0]["payload"]["bidiGenerateContentSetup"]["sessionResumption"] == {"handle": "h-42_ok"}
    rec = Recorder()
    live.mint_session(FAKE_KEY, None, resume_handle="bad handle\n{}", poster=rec, now=NOW)
    assert rec.calls[0]["payload"]["bidiGenerateContentSetup"]["sessionResumption"] == {}


@pytest.mark.parametrize("key", [None, "", "   "])
def test_missing_key_is_a_clear_no_key_error_and_no_request(key):
    rec = Recorder()
    with pytest.raises(live.VoiceError) as err:
        live.mint_session(key, None, poster=rec)
    assert err.value.reason == "no_key"
    assert err.value.status == 503
    assert "GEMINI_API_KEY" in err.value.message
    assert rec.calls == []


def test_rejected_key_is_reported_without_echoing_the_key():
    rec = Recorder(status=403, answer={"error": f"API key {FAKE_KEY} not valid"})
    with pytest.raises(live.VoiceError) as err:
        live.mint_session(FAKE_KEY, None, poster=rec)
    assert err.value.reason == "rejected"
    assert FAKE_KEY not in err.value.message
    assert "GEMINI_API_KEY is valid" in err.value.message


def test_network_failure_is_unreachable():
    with pytest.raises(live.VoiceError) as err:
        live.mint_session(FAKE_KEY, None, poster=Recorder(exc=OSError(f"dns failed for {FAKE_KEY}")))
    assert err.value.reason == "unreachable"
    assert FAKE_KEY not in err.value.message


def test_answer_without_token_is_rejected():
    with pytest.raises(live.VoiceError) as err:
        live.mint_session(FAKE_KEY, None, poster=Recorder(answer={}))
    assert err.value.reason == "rejected"


def test_settings_fall_back_and_report_problems():
    cfg = live.settings({"model": "gpt-4o; drop", "voice": "Nope", "silence_ms": 99999,
                         "language": "english!", "transcript_to_chat": "everything", "api_version": "v9"})
    assert cfg["model"] == "gemini-3.8-live"
    assert cfg["voice"] == "Aoede"
    assert cfg["silence_ms"] == 1000
    assert cfg["language"] == "he"
    assert cfg["transcript_to_chat"] == "chat_turn"
    assert cfg["api_version"] == "v1alpha"
    assert len(cfg["problems"]) == 5  # silence_ms clamps silently
    assert live.settings({"model": "models/gemini-3.1-flash-live-preview"})["model"] == "gemini-3.1-flash-live-preview"


def test_client_settings_carry_no_secret_and_no_instructions():
    out = live.client_settings(live.settings({"instructions": "be brief"}))
    assert set(out) == {"model", "voice", "language", "transcript_to_chat", "half_duplex"}
