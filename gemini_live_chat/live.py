"""Gemini Live session minting: the only place the Gemini key is used.

The renderer never sees ``GEMINI_API_KEY``. :func:`mint_session` exchanges it for a single-use
ephemeral token (``POST /{version}/auth_tokens``) whose ``bidiGenerateContentSetup`` locks the whole
session setup (model, persona, tools, voice, VAD, transcription, resumption handle), and returns what
the renderer needs to open the Live socket itself::

    wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.<version>.
        GenerativeService.BidiGenerateContentConstrained?access_token=<token>

Because the setup is locked inside the token, a renderer cannot change the persona or the tools, and
because the token is single-use with a 60 s start window, a leaked token is close to worthless.
Audio never passes through Hermes, so the backend holds no socket and no process for a call.

Vendor contract (checked 2026-11-07):
- https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
- https://ai.google.dev/api/live  (AuthToken, BidiGenerateContentSetup, GoAway, SessionResumption)
- https://ai.google.dev/gemini-api/docs/live-api/tools  (behavior NON_BLOCKING, scheduling)
"""

from __future__ import annotations

import datetime as _dt
import json
import re
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional, Tuple

from . import persona

API_HOST = "https://generativelanguage.googleapis.com"
WS_HOST = "wss://generativelanguage.googleapis.com"
API_VERSIONS = ("v1alpha", "v1beta")
# Both official SDKs (google-genai Python tokens.py, @google/genai 3.0.0 live connect) create the
# token and open the constrained socket on v1alpha ("Support in v1alpha only"); v1beta is selectable.
DEFAULT_API_VERSION = "v1alpha"

DEFAULT_MODEL = "gemini-3.8-live"  # Google's default Live model (models page, 2026-11)
AUTO = "auto"
DEFAULT_VOICE = AUTO  # follows the persona's gender: MALE_VOICE or FEMALE_VOICE
MALE_VOICE = "Charon"
FEMALE_VOICE = "Aoede"
DEFAULT_LANGUAGE = "he"
PERSONA_GENDERS = (AUTO,) + persona.GENDERS
#: When neither the setting, the profile's SOUL.md nor an explicit voice says otherwise.
FALLBACK_GENDER = "male"
DEFAULT_SILENCE_MS = 1000
SILENCE_MS_RANGE = (400, 5000)
PREFIX_MS = 300
TOKEN_TTL_MIN = 30           # messages are rejected after this; Google's default
NEW_SESSION_WINDOW_S = 60    # the token must open its session within this window
#: chat_turn: at hang-up the call transcript is submitted once to the open chat (a normal, queued
#: turn; Hermes acknowledges it). file: saved only to the plugin's data folder. off: neither.
TRANSCRIPT_MODES = ("chat_turn", "file", "off")
DEFAULT_TRANSCRIPT_MODE = "chat_turn"
#: v0.6. hermes: the renderer sends every substantive user turn to Hermes and the voice model only
#: speaks the text it is handed (no tools, relay persona). voice: v0.5 behaviour, where the voice
#: model decides when to call hermes_task.
BRAINS = ("hermes", "voice")
DEFAULT_BRAIN = "hermes"

#: Prebuilt voices of Google's native-audio / TTS models. The Live endpoint answers
#: ``setupComplete`` to ANY voiceName and silently falls back to a default voice, so this list is
#: what turns a typo into a visible settings problem instead of a different voice.
VOICES = (
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
    "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi",
    "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird",
    "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
)
#: How each prebuilt voice sounds, as labelled in Google AI Studio's voice picker. Used only to pick
#: matching grammatical forms when ``persona_gender`` is ``auto`` and an explicit voice is set.
VOICE_GENDER = {
    **dict.fromkeys(("Puck", "Charon", "Fenrir", "Orus", "Enceladus", "Iapetus", "Umbriel", "Algieba",
                     "Algenib", "Rasalgethi", "Alnilam", "Schedar", "Achird", "Zubenelgenubi",
                     "Sadachbia", "Sadaltager"), "male"),
    **dict.fromkeys(("Zephyr", "Kore", "Leda", "Aoede", "Callirrhoe", "Autonoe", "Despina", "Erinome",
                     "Laomedeia", "Achernar", "Gacrux", "Pulcherrima", "Vindemiatrix", "Sulafat"), "female"),
}
_MODEL_RE = re.compile(r"^(models/)?gemini-[a-z0-9.\-]+$")
_LANG_RE = re.compile(r"^[a-z]{2,3}(-[A-Za-z]{2,4})?$")
_PERSONA_NAME_RE = re.compile(r"^[^\x00-\x1f{}<>\[\]\"\\]{1,40}$")
MAX_VOCABULARY = 100  # Google: up to 1,000 terms, best results with up to 100
_HANDLE_RE = re.compile(r"^[A-Za-z0-9_\-./=+:]{1,2048}$")

Poster = Callable[[str, Dict[str, str], Dict[str, Any], float], Tuple[int, Any]]


class VoiceError(Exception):
    """A typed refusal. ``reason`` is machine-readable (``providers.REASONS``): no_key, quota, auth,
    unavailable, unreachable, rejected, not_signed_in, unsupported."""

    def __init__(self, reason: str, message: str, status: int = 502):
        super().__init__(message)
        self.reason = reason
        self.message = message
        self.status = status

    def detail(self) -> Dict[str, str]:
        return {"reason": self.reason, "message": self.message}


def _int_in(raw: Any, default: int, bounds: Tuple[int, int]) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if bounds[0] <= value <= bounds[1] else default


def settings(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """``plugins.entries.gemini-live-chat.settings`` with defaults. Invalid values fall back to the
    default and are listed in ``problems`` so the status route can show them."""
    raw = raw if isinstance(raw, dict) else {}
    problems = []

    def pick(key, ok, default):
        value = raw.get(key)
        if value in (None, ""):
            return default
        if ok(value):
            return value
        problems.append(f"settings.{key} {value!r} is not valid; using {default!r}")
        return default

    model = str(pick("model", lambda v: isinstance(v, str) and bool(_MODEL_RE.match(v.strip())), DEFAULT_MODEL)).strip()
    if model.startswith("models/"):
        model = model[len("models/"):]
    language = pick("language", lambda v: v == AUTO or (isinstance(v, str) and bool(_LANG_RE.match(v))), DEFAULT_LANGUAGE)
    return {
        "model": model,
        "voice": pick("voice", lambda v: v == AUTO or v in VOICES, DEFAULT_VOICE),
        "persona_name": str(pick("persona_name", lambda v: isinstance(v, str) and bool(_PERSONA_NAME_RE.match(v.strip())), "")).strip(),
        "persona_gender": pick("persona_gender", lambda v: v in PERSONA_GENDERS, AUTO),
        "language": language,
        "transcription_languages": _languages(raw.get("transcription_languages"), language, problems),
        "vocabulary": _vocabulary(raw.get("vocabulary"), problems),
        "silence_ms": _int_in(raw.get("silence_ms"), DEFAULT_SILENCE_MS, SILENCE_MS_RANGE),
        "instructions": str(raw.get("instructions") or "").strip()[:4000],
        "transcript_to_chat": pick("transcript_to_chat", lambda v: v in TRANSCRIPT_MODES, DEFAULT_TRANSCRIPT_MODE),
        "half_duplex": raw.get("half_duplex") is True,
        "api_version": pick("api_version", lambda v: v in API_VERSIONS, DEFAULT_API_VERSION),
        "brain": pick("brain", lambda v: v in BRAINS, DEFAULT_BRAIN),
        # v0.4: the provider chain (order of providers.PROVIDERS ids) and the OpenAI Realtime engine.
        "providers": _providers(raw.get("providers"), problems),
        "openai_model": str(pick("openai_model", _valid_openai_model, _OPENAI_DEFAULT_MODEL)).strip(),
        "openai_voice": pick("openai_voice", lambda v: v == AUTO or v in _OPENAI_VOICES, AUTO),
        # v0.7: the plugin's own wake word (off by default; see gemini_live_chat/wake.py).
        "wake_word": raw.get("wake_word") is True or str(raw.get("wake_word")).strip().lower() in ("true", "on", "yes", "1"),
        "wake_phrase": _wake_phrase(raw.get("wake_phrase"), problems),
        "wake_sensitivity": _float_in(raw.get("wake_sensitivity"), DEFAULT_WAKE_SENSITIVITY, (0.0, 1.0)),
        "wake_surface": pick("wake_surface", lambda v: v in WAKE_SURFACES, DEFAULT_WAKE_SURFACE),
        "problems": problems,
    }


DEFAULT_WAKE_SENSITIVITY = 0.5
#: desktop: only the Hermes Desktop app answers the wake word (the detector hears the PC's
#: microphone, so a phone tab answering it would talk through the phone about a PC-side wake).
#: any: the first open window claims it.
WAKE_SURFACES = ("desktop", "any")
DEFAULT_WAKE_SURFACE = "desktop"


def _float_in(raw: Any, default: float, bounds: Tuple[float, float]) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return value if bounds[0] <= value <= bounds[1] else default


def _wake_phrase(raw: Any, problems: list) -> str:
    """"" = ``hey <persona name>`` (resolved later); else an English phrase the engine can spot."""
    if raw in (None, ""):
        return ""
    from . import wake
    phrase = wake.clean_phrase(raw)
    if phrase is None:
        problems.append(f"settings.wake_phrase {raw!r} is not valid (English letters only, e.g. \"hey ray\"); "
                        "using \"hey <persona name>\"")
        return ""
    return phrase


# Late-bound to keep live.py importable on its own (openai_rt and providers import live).
_OPENAI_DEFAULT_MODEL = "gpt-realtime-2.1"
_OPENAI_VOICES = ("alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar")


def _valid_openai_model(value: Any) -> bool:
    from . import openai_rt
    return openai_rt.valid_model(value)


def _providers(raw: Any, problems: list) -> list:
    from . import providers
    return providers.parse_order(raw, problems)


def _as_list(raw: Any) -> Optional[list]:
    if isinstance(raw, str):
        return [p.strip() for p in raw.split(",") if p.strip()]
    if isinstance(raw, (list, tuple)):
        return [str(p).strip() for p in raw if str(p).strip()]
    return None


def _languages(raw: Any, language: str, problems: list) -> list:
    """BCP-47 hints for ``inputAudioTranscription.languageCodes``. Unset: the starting language
    first, then the other of Hebrew/English (so switching keeps working); ``auto`` or an empty list:
    no hints, Google detects the language itself."""
    if raw in (None, ""):
        if language == AUTO:
            return []
        base = language.split("-")[0]
        other = {"he": "en", "en": "he"}.get(base)
        return [language] + ([other] if other else [])
    if raw == AUTO:
        return []
    codes = _as_list(raw)
    if codes is None or not all(_LANG_RE.match(c) for c in codes):
        problems.append(f"settings.transcription_languages {raw!r} is not valid; using automatic detection")
        return []
    return codes[:8]


def _vocabulary(raw: Any, problems: list) -> list:
    if raw in (None, ""):
        return []
    terms = _as_list(raw)
    if terms is None:
        problems.append(f"settings.vocabulary {raw!r} is not valid; ignoring it")
        return []
    return [t[:80] for t in terms][:MAX_VOCABULARY]


def resolve_persona(cfg: Dict[str, Any], soul_text: Optional[str] = None) -> Dict[str, Any]:
    """Who the voice is and how it sounds, in this order of precedence:

    * name: ``persona_name`` setting > the profile's ``SOUL.md`` ("You are Ray ...") > "Hermes";
    * grammatical gender: ``persona_gender`` setting > ``SOUL.md`` > the explicit voice's sound >
      ``FALLBACK_GENDER`` (male);
    * voice: an explicit ``voice`` setting always wins; ``auto`` picks ``MALE_VOICE`` or
      ``FEMALE_VOICE`` by the gender.

    Returns a copy of ``cfg`` with ``persona_name``, ``persona_name_he``, ``persona_gender`` and
    ``voice`` resolved (``identity_source`` says where the name came from)."""
    out = dict(cfg)
    soul_name, soul_he, soul_gender = persona.identity_from_soul(soul_text)
    if cfg.get("persona_name"):
        out["persona_name"], out["identity_source"] = cfg["persona_name"], "setting"
        out["persona_name_he"] = soul_he if soul_name and soul_name.lower() == cfg["persona_name"].lower() else ""
    elif soul_name:
        out["persona_name"], out["persona_name_he"], out["identity_source"] = soul_name, soul_he or "", "soul"
    else:
        out["persona_name"], out["persona_name_he"], out["identity_source"] = persona.DEFAULT_PERSONA_NAME, "", "default"
    voice = cfg.get("voice") or AUTO
    gender = cfg.get("persona_gender") or AUTO
    if gender == AUTO:
        gender = soul_gender or (VOICE_GENDER.get(voice) if voice != AUTO else None) or FALLBACK_GENDER
    out["persona_gender"] = gender
    out["voice"] = voice if voice != AUTO else (FEMALE_VOICE if gender == "female" else MALE_VOICE)
    return out


def build_setup(cfg: Dict[str, Any], resume_handle: Optional[str] = None, carry: str = "") -> Dict[str, Any]:
    """The ``BidiGenerateContentSetup`` body (camelCase wire names, as the endpoint accepts them).

    Fields accepted by the endpoint per the API reference and the measurements published in
    skappafrost/hermes-gemini-live (setup frame shape, NON_BLOCKING on the declaration, no
    ``thinkingLevel`` for gemini-3.8-live).
    """
    if "identity_source" not in cfg:
        cfg = resolve_persona(cfg)
    name = cfg["persona_name"]
    # Input transcription: language hints + names it must spell right. The voice model hears the
    # audio itself; this only shapes the transcript (chat record and voice_context for Hermes).
    transcription: Dict[str, Any] = {}
    if cfg.get("transcription_languages"):
        transcription["languageCodes"] = list(cfg["transcription_languages"])
    vocabulary = [t for t in [name, cfg.get("persona_name_he", "")] + list(cfg.get("vocabulary") or []) if t]
    if vocabulary:
        transcription["customVocabulary"] = list(dict.fromkeys(vocabulary))[:MAX_VOCABULARY]
    relay = cfg.get("brain", DEFAULT_BRAIN) == "hermes"
    if relay:
        # brain: hermes. The voice only speaks "[Say aloud]" text: relay persona and no tools, so
        # it cannot answer, delegate or hang up by itself. The carry-over is not needed: the
        # renderer, not the voice, keeps the conversation.
        system_text = persona.relay_instructions(
            cfg.get("instructions", ""), name=name, gender=cfg["persona_gender"],
            name_he=cfg.get("persona_name_he", ""))
    else:
        system_text = persona.instructions(
            cfg["language"], cfg.get("instructions", ""), name=name, gender=cfg["persona_gender"],
            voice=cfg["voice"], name_he=cfg.get("persona_name_he", ""), engine="gemini", carry=carry)
    setup: Dict[str, Any] = {
        "model": f"models/{cfg['model']}",
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            # No speechConfig.languageCode: native-audio models pick the spoken language themselves
            # (the persona's language policy steers it), and the code would pin one language.
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": cfg["voice"]}}},
        },
        "systemInstruction": {"parts": [{"text": system_text}]},
        "tools": [{"functionDeclarations": persona.tool_declarations(name)}],
        "realtimeInputConfig": {"automaticActivityDetection": {
            "silenceDurationMs": cfg["silence_ms"], "prefixPaddingMs": PREFIX_MS}},
        "inputAudioTranscription": transcription,
        "outputAudioTranscription": {},
        # Without the sliding window an audio-only session hard-stops near 15 minutes.
        "contextWindowCompression": {"slidingWindow": {}},
        "sessionResumption": {"handle": resume_handle} if resume_handle else {},
    }
    if relay:
        del setup["tools"]
    if "extended-thinking" in cfg["model"]:
        # Required by that model (low/medium/high). gemini-3.8-live refuses the field.
        setup["generationConfig"]["thinkingConfig"] = {"thinkingLevel": "low"}
    return setup


def socket_url(api_version: str, token: str) -> str:
    return (f"{WS_HOST}/ws/google.ai.generativelanguage.{api_version}."
            f"GenerativeService.BidiGenerateContentConstrained?access_token={token}")


def _iso(when: _dt.datetime) -> str:
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def _post_json(url: str, headers: Dict[str, str], payload: Dict[str, Any], timeout: float) -> Tuple[int, Any]:
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        return exc.code, {"error": exc.read().decode("utf-8", "replace")[:300]}


def _scrub(text: str, key: str) -> str:
    return (text or "").replace(key, "***") if key else (text or "")


def valid_handle(handle: Any) -> Optional[str]:
    if isinstance(handle, str) and _HANDLE_RE.match(handle):
        return handle
    return None


#: Words Google uses when a billed account cannot pay: the Prepay "$0 credit balance" refusal
#: (HTTP 402 Payment Required, every key on that billing account), and billing-disabled or
#: billing-required bodies that arrive as 400/403/429.
_BILLING_RE = re.compile(r"billing|prepa(y|id)|payment.required|credit.balance|insufficient.(credit|fund|balance)"
                         r"|out of credit|no credit")


def classify(status: int, detail: Any) -> str:
    """Map a refused token request to a fallback reason (see ``providers.REASONS``): ``billing`` for
    402 Payment Required or a billing/credit body (checked first: Google can send it as 429
    RESOURCE_EXHAUSTED or 403), ``quota`` for 429 / RESOURCE_EXHAUSTED, ``auth`` for a bad or
    unauthorised key, ``unavailable`` for 5xx."""
    low = json.dumps(detail).lower() if not isinstance(detail, str) else detail.lower()
    if status == 402 or (status in (400, 403, 429) and _BILLING_RE.search(low)):
        return "billing"
    if status == 429 or "resource_exhausted" in low or "quota" in low or "rate limit" in low:
        return "quota"
    if status in (401, 403) or "api_key_invalid" in low or "permission_denied" in low or "api key not valid" in low:
        return "auth"
    if status >= 500:
        return "unavailable"
    return "rejected"


_REFUSALS = {
    "billing": ("Google refused the Live token request: the billing account of {key_name} has no credit "
                "or no billing ({status}). Add credit in Google AI Studio."),
    "quota": "Google refused the Live token request: quota or rate limit reached ({status}).",
    "auth": "Google refused the Live token request ({status}). Check that {key_name} is valid.",
    "unavailable": "Google's Live service is unavailable right now ({status}).",
    "rejected": "Google refused the Live token request ({status}).",
}


def mint_session(key: Optional[str], cfg: Optional[Dict[str, Any]], resume_handle: Optional[str] = None,
                 poster: Optional[Poster] = None, now: Optional[_dt.datetime] = None, carry: str = "",
                 key_name: str = "GEMINI_API_KEY") -> Dict[str, Any]:
    """Ephemeral token + socket URL + the setup frame for the renderer. Raises :class:`VoiceError`.

    *carry* is the recent conversation after a mid-call provider switch (into the persona).
    The returned body never contains the API key (asserted by the tests)."""
    key = (key or "").strip()
    if not key:
        raise VoiceError("no_key", f"Gemini Live needs {key_name} in this Hermes profile's environment.", 503)
    cfg = cfg if isinstance(cfg, dict) and "problems" in cfg else settings(cfg)
    if "identity_source" not in cfg:
        cfg = resolve_persona(cfg)
    setup = build_setup(cfg, valid_handle(resume_handle), carry=carry)
    now = now or _dt.datetime.now(tz=_dt.timezone.utc)
    body = {
        "uses": 1,
        "expireTime": _iso(now + _dt.timedelta(minutes=TOKEN_TTL_MIN)),
        "newSessionExpireTime": _iso(now + _dt.timedelta(seconds=NEW_SESSION_WINDOW_S)),
        # No fieldMask: the whole effective setup is taken from the token (global lock).
        "bidiGenerateContentSetup": setup,
    }
    post = poster or _post_json
    try:
        status, answer = post(
            f"{API_HOST}/{cfg['api_version']}/auth_tokens",
            {"x-goog-api-key": key, "Content-Type": "application/json"},
            body,
            15.0,
        )
    except Exception as exc:  # DNS, TLS, timeout
        raise VoiceError("unreachable", f"Google is unreachable ({type(exc).__name__}).", 502) from None
    if status >= 400 or not isinstance(answer, dict):
        reason = classify(status, answer) if status >= 400 else "rejected"
        if reason == "rejected" and status == 400 and "api key" in json.dumps(answer).lower():
            reason = "auth"  # Google answers an invalid key with 400 INVALID_ARGUMENT
        raise VoiceError(reason, _scrub(_REFUSALS[reason].format(status=status, key_name=key_name), key), 502)
    token = answer.get("name")
    if not isinstance(token, str) or not token or key in token:
        raise VoiceError("rejected", "Unexpected answer from Google's token service.", 502)
    return {
        "url": socket_url(cfg["api_version"], token),
        "expires_at": body["expireTime"],
        "model": cfg["model"],
        "voice": cfg["voice"],
        "persona_name": cfg["persona_name"],
        "brain": cfg.get("brain", DEFAULT_BRAIN),
        "setup": {"setup": setup},
    }


def client_settings(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """The non-secret settings the renderer needs (status route): the effective values, after the
    persona is resolved (so ``voice`` is the real voice name, never ``auto``)."""
    if "identity_source" not in cfg:
        cfg = resolve_persona(cfg)
    keys = ("model", "voice", "language", "transcript_to_chat", "half_duplex", "persona_name",
            "persona_gender", "identity_source", "transcription_languages", "providers",
            "openai_model", "openai_voice", "brain", "silence_ms", "persona_name_he",
            "wake_word", "wake_surface")
    out = {k: cfg[k] for k in keys if k in cfg}
    if cfg.get("wake_word"):
        out["wake_phrase"] = effective_wake_phrase(cfg)
    return out


def effective_wake_phrase(cfg: Dict[str, Any]) -> str:
    """The phrase the detector listens for: the setting, else ``hey <persona name>``."""
    from . import wake
    if cfg.get("wake_phrase"):
        return cfg["wake_phrase"]
    if "identity_source" not in cfg:
        cfg = resolve_persona(cfg)
    return wake.default_phrase(cfg.get("persona_name"))
