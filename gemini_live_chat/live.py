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
DEFAULT_VOICE = "Aoede"
DEFAULT_LANGUAGE = "he"
DEFAULT_SILENCE_MS = 1000
SILENCE_MS_RANGE = (400, 5000)
PREFIX_MS = 300
TOKEN_TTL_MIN = 30           # messages are rejected after this; Google's default
NEW_SESSION_WINDOW_S = 60    # the token must open its session within this window
#: chat_turn: at hang-up the call transcript is submitted once to the open chat (a normal, queued
#: turn; Hermes acknowledges it). file: saved only to the plugin's data folder. off: neither.
TRANSCRIPT_MODES = ("chat_turn", "file", "off")
DEFAULT_TRANSCRIPT_MODE = "chat_turn"

#: Prebuilt voices of Google's native-audio / TTS models. The Live endpoint answers
#: ``setupComplete`` to ANY voiceName and silently falls back to a default voice, so this list is
#: what turns a typo into a visible settings problem instead of a different voice.
VOICES = (
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
    "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi",
    "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird",
    "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
)
_MODEL_RE = re.compile(r"^(models/)?gemini-[a-z0-9.\-]+$")
_LANG_RE = re.compile(r"^[a-z]{2,3}(-[A-Za-z]{2,4})?$")
_HANDLE_RE = re.compile(r"^[A-Za-z0-9_\-./=+:]{1,2048}$")

Poster = Callable[[str, Dict[str, str], Dict[str, Any], float], Tuple[int, Any]]


class VoiceError(Exception):
    """A typed refusal. ``reason`` is machine-readable: no_key, scope, rejected, unreachable."""

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
    return {
        "model": model,
        "voice": pick("voice", lambda v: v in VOICES, DEFAULT_VOICE),
        "language": pick("language", lambda v: isinstance(v, str) and bool(_LANG_RE.match(v)), DEFAULT_LANGUAGE),
        "silence_ms": _int_in(raw.get("silence_ms"), DEFAULT_SILENCE_MS, SILENCE_MS_RANGE),
        "instructions": str(raw.get("instructions") or "").strip()[:4000],
        "transcript_to_chat": pick("transcript_to_chat", lambda v: v in TRANSCRIPT_MODES, DEFAULT_TRANSCRIPT_MODE),
        "half_duplex": raw.get("half_duplex") is True,
        "api_version": pick("api_version", lambda v: v in API_VERSIONS, DEFAULT_API_VERSION),
        "problems": problems,
    }


def build_setup(cfg: Dict[str, Any], resume_handle: Optional[str] = None) -> Dict[str, Any]:
    """The ``BidiGenerateContentSetup`` body (camelCase wire names, as the endpoint accepts them).

    Fields accepted by the endpoint per the API reference and the measurements published in
    skappafrost/hermes-gemini-live (setup frame shape, NON_BLOCKING on the declaration, no
    ``thinkingLevel`` for gemini-3.8-live).
    """
    setup: Dict[str, Any] = {
        "model": f"models/{cfg['model']}",
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": cfg["voice"]}}},
        },
        "systemInstruction": {"parts": [{"text": persona.instructions(cfg["language"], cfg.get("instructions", ""))}]},
        "tools": [{"functionDeclarations": persona.tool_declarations()}],
        "realtimeInputConfig": {"automaticActivityDetection": {
            "silenceDurationMs": cfg["silence_ms"], "prefixPaddingMs": PREFIX_MS}},
        "inputAudioTranscription": {},
        "outputAudioTranscription": {},
        # Without the sliding window an audio-only session hard-stops near 15 minutes.
        "contextWindowCompression": {"slidingWindow": {}},
        "sessionResumption": {"handle": resume_handle} if resume_handle else {},
    }
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


def mint_session(key: Optional[str], cfg: Optional[Dict[str, Any]], resume_handle: Optional[str] = None,
                 poster: Optional[Poster] = None, now: Optional[_dt.datetime] = None) -> Dict[str, Any]:
    """Ephemeral token + socket URL + the setup frame for the renderer. Raises :class:`VoiceError`.

    The returned body never contains the API key (asserted by the tests)."""
    key = (key or "").strip()
    if not key:
        raise VoiceError("no_key", "Gemini Live needs GEMINI_API_KEY in this Hermes profile's environment.", 503)
    cfg = cfg if isinstance(cfg, dict) and "problems" in cfg else settings(cfg)
    setup = build_setup(cfg, valid_handle(resume_handle))
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
        hint = " Check that GEMINI_API_KEY is valid." if status in (400, 401, 403) else ""
        raise VoiceError("rejected", _scrub(f"Google refused the Live token request ({status}).{hint}", key), 502)
    token = answer.get("name")
    if not isinstance(token, str) or not token or key in token:
        raise VoiceError("rejected", "Unexpected answer from Google's token service.", 502)
    return {
        "url": socket_url(cfg["api_version"], token),
        "expires_at": body["expireTime"],
        "model": cfg["model"],
        "voice": cfg["voice"],
        "setup": {"setup": setup},
    }


def client_settings(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """The non-secret settings the renderer needs (status route)."""
    return {k: cfg[k] for k in ("model", "voice", "language", "transcript_to_chat", "half_duplex")}
