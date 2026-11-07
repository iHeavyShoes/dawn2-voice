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
    # No persona configured anywhere: "Hermes", male by default, so a male prebuilt voice.
    assert setup["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Charon"
    assert "languageCode" not in setup["generationConfig"]["speechConfig"]  # would pin one spoken language
    assert "thinkingConfig" not in setup["generationConfig"]  # gemini-3.8-live refuses thinkingLevel
    assert setup["inputAudioTranscription"] == {"languageCodes": ["he", "en"], "customVocabulary": ["Hermes"]}
    assert setup["outputAudioTranscription"] == {}
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
    assert err.value.reason == "auth"  # v0.4: typed, so the chain can fall back
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
    assert cfg["voice"] == "auto"
    assert cfg["silence_ms"] == 1000
    assert cfg["language"] == "he"
    assert cfg["transcript_to_chat"] == "chat_turn"
    assert cfg["api_version"] == "v1alpha"
    assert len(cfg["problems"]) == 5  # silence_ms clamps silently
    assert live.settings({"model": "models/gemini-3.1-flash-live-preview"})["model"] == "gemini-3.1-flash-live-preview"


def test_client_settings_carry_no_secret_and_no_instructions():
    out = live.client_settings(live.settings({"instructions": "be brief"}))
    assert set(out) == {"model", "voice", "language", "transcript_to_chat", "half_duplex", "persona_name",
                        "persona_gender", "identity_source", "transcription_languages", "providers",
                        "openai_model", "openai_voice"}
    assert "be brief" not in json.dumps(out)
    assert out["voice"] == "Charon"  # the effective voice, never "auto"


# ── v0.2: persona / identity ────────────────────────────────────────────────────────────────────

RAY_SOUL = """<!-- GENERATED by scripts/souls.py -->

# Ray — Dawn 2.0

You are Ray (in Hebrew exactly ריי), Dawn 2.0's orchestrator.

## Voice
Calm. The user prefers his own pace; his sister is busy and she says so.
"""


def _prompt(setup):
    return setup["systemInstruction"]["parts"][0]["text"]


def test_identity_is_read_from_the_profile_soul():
    assert persona.identity_from_soul(RAY_SOUL) == ("Ray", "ריי", None)  # prose pronouns never count
    assert persona.identity_from_soul("You are Hermes Agent, built by Nous Research.") == (None, None, None)
    assert persona.identity_from_soul("# Nova\nGender: female\n") == ("Nova", None, "female")
    assert persona.identity_from_soul("You are Ada. Pronouns: she/her") == ("Ada", None, "female")
    assert persona.identity_from_soul("You are Ezra. דבר בלשון זכר.") == ("Ezra", None, "male")
    assert persona.identity_from_soul(None) == (None, None, None)


def test_voice_speaks_as_the_serving_agent_male_by_default():
    cfg = live.resolve_persona(live.settings(None), RAY_SOUL)
    assert (cfg["persona_name"], cfg["persona_name_he"], cfg["identity_source"]) == ("Ray", "ריי", "soul")
    assert cfg["persona_gender"] == "male" and cfg["voice"] == live.MALE_VOICE
    assert live.VOICE_GENDER[live.MALE_VOICE] == "male"
    setup = live.build_setup(cfg)
    text = _prompt(setup)
    assert "You are Ray" in text and "\"ריי\"" in text
    assert "masculine" in text and "אני בודק" in text
    assert "Never call yourself a generic \"virtual assistant\"" in text
    assert "you are Ray; your voice runs on Google's Gemini Live" in text  # "why Google, not Ray?"
    assert setup["inputAudioTranscription"]["customVocabulary"][:2] == ["Ray", "ריי"]
    assert "(Ray, in the user's open chat)" in setup["tools"][0]["functionDeclarations"][0]["description"]


def test_persona_setting_beats_soul_and_explicit_voice_is_kept():
    cfg = live.resolve_persona(live.settings({"persona_name": "Dana", "persona_gender": "female", "voice": "Kore"}), RAY_SOUL)
    assert (cfg["persona_name"], cfg["persona_name_he"], cfg["identity_source"]) == ("Dana", "", "setting")
    assert cfg["persona_gender"] == "female" and cfg["voice"] == "Kore"
    assert "feminine" in _prompt(live.build_setup(cfg))
    # voice auto follows a female persona; an explicit voice with gender auto sets the forms
    assert live.resolve_persona(live.settings({"persona_gender": "female"}))["voice"] == live.FEMALE_VOICE
    assert live.resolve_persona(live.settings({"voice": "Aoede"}))["persona_gender"] == "female"
    assert live.resolve_persona(live.settings({"voice": "Puck"}), RAY_SOUL)["persona_gender"] == "male"
    # the same name as the SOUL keeps the Hebrew spelling
    assert live.resolve_persona(live.settings({"persona_name": "ray"}), RAY_SOUL)["persona_name_he"] == "ריי"


def test_bad_persona_settings_fall_back():
    cfg = live.settings({"persona_name": "x" * 80, "persona_gender": "robot"})
    assert cfg["persona_name"] == "" and cfg["persona_gender"] == "auto"
    assert len(cfg["problems"]) == 2


def test_persona_forbids_invented_capabilities_and_actions():
    text = _prompt(live.build_setup(live.resolve_persona(live.settings(None), RAY_SOUL)))
    assert "Never invent capabilities, limitations, settings or actions" in text
    assert "Never say you passed feedback" in text
    assert "say plainly that you do not know" in text
    # it knows the true facts it was wrong about on the first call
    assert "male and female voices exist" in text and "currently set to Charon" in text
    assert "persona_gender" in text and "from the next call" in text


def test_persona_does_not_nag_while_waiting():
    text = _prompt(live.build_setup(live.settings(None)))
    assert "do not keep announcing that you are still waiting" in text
    assert "in a follow-up turn" in text


# ── v0.3: delegate first, then speak Hermes' answer in full ─────────────────────────────────────

def test_v03_knowledge_questions_and_side_requests_are_delegated():
    text = _prompt(live.build_setup(live.settings(None)))
    assert "explain, describe or teach anything" in text and "even when you think you know the answer" in text
    assert "tell me a joke meanwhile\": both go to hermes_task" in text
    desc = live.build_setup(live.settings(None))["tools"][0]["functionDeclarations"][0]["description"]
    assert "explanations" in desc and "Do not answer the request yourself meanwhile" in desc


def test_v03_voice_only_acknowledges_while_a_request_is_open():
    text = _prompt(live.build_setup(live.settings(None)))
    assert "Do not answer any part of it yourself: no explanation, fact, joke" in text
    assert "The user must hear one answer, the one from the chat" in text
    # present-tense acknowledgement, no promises (the "I'll pass your feedback to the team" line)
    assert "present tense" in text and "Never promise a future action" in text
    assert "Keep spoken answers short" not in text  # v0.2 line that licensed the summaries


def test_v03_results_are_spoken_faithfully_in_parts_never_as_placeholders():
    text = _prompt(live.build_setup(live.settings(None)))
    assert "faithfully and completely" in text and "keep every point, step, name and number" in text
    assert "Never replace the content with a description of it" in text
    assert "\"(detailed explanation)\"" in text  # the placeholder it actually read on 2026-11-07
    assert "[Hermes result 1/3]" in text and "Do not summarise or skip parts" in text
    assert "A short result gets a short answer" in text
    assert "[link in the chat]" in text and "[code: see the chat]" in text  # markers plugin.js emits


def test_v03_prompt_has_no_broken_escapes():
    text = _prompt(live.build_setup(live.settings(None)))
    assert '\\' not in text  # a doubled escape once left literal \" and stray quotes in the prompt


# ── v0.2: Hebrew input transcription ────────────────────────────────────────────────────────────

def test_transcription_language_hints_follow_the_starting_language():
    assert live.settings(None)["transcription_languages"] == ["he", "en"]
    assert live.settings({"language": "en"})["transcription_languages"] == ["en", "he"]
    assert live.settings({"language": "he-IL"})["transcription_languages"] == ["he-IL", "en"]
    assert live.settings({"language": "fr"})["transcription_languages"] == ["fr"]
    assert live.settings({"language": "auto"})["transcription_languages"] == []
    assert live.settings({"transcription_languages": "auto"})["transcription_languages"] == []
    assert live.settings({"transcription_languages": "he-IL, en-US"})["transcription_languages"] == ["he-IL", "en-US"]
    assert live.settings({"transcription_languages": ["he"]})["transcription_languages"] == ["he"]
    bad = live.settings({"transcription_languages": ["hebrew!"]})
    assert bad["transcription_languages"] == [] and len(bad["problems"]) == 1


def test_auto_language_sends_no_hints_and_vocabulary_is_merged():
    setup = live.build_setup(live.settings({"language": "auto", "vocabulary": "יומן, Dawn 2.0, Ray"}))
    assert "languageCodes" not in setup["inputAudioTranscription"]
    assert setup["inputAudioTranscription"]["customVocabulary"] == ["Hermes", "יומן", "Dawn 2.0", "Ray"]
    assert len(live.settings({"vocabulary": [f"t{i}" for i in range(500)]})["vocabulary"]) == live.MAX_VOCABULARY
