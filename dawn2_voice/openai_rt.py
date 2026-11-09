"""OpenAI Realtime session minting on the user's ChatGPT/Codex sign-in.

The plugin never sees the Codex token. :func:`mint_session` builds the Realtime ``session`` object
(model, persona, tools, voice, VAD, transcription) and hands ``POST /v1/realtime/client_secrets`` to a
``post`` callable. In production that callable is Hermes core's
``hermes_cli.plugin_provider_requests.credentialed_provider_request("openai-codex", ...)``: Hermes
resolves the sign-in through its own locked refresh, attaches ``Authorization`` itself, sends only to
``api.openai.com`` and never follows a redirect (``plugin.yaml`` declares
``requires_auth: [openai-codex]``). What comes back is a short-lived ephemeral client secret
(``ek_...``); the renderer uses it once, for the WebRTC SDP exchange with
``https://api.openai.com/v1/realtime/calls``. Audio then flows renderer <-> OpenAI directly.

Difference from the Gemini route (documented in the README): an OpenAI client secret pins the model
and the initial session, but a client may still send ``session.update``. The renderer here never
does; the persona and tools are set only by this module.

Vendor contract (checked 2026-11-07):
- https://platform.openai.com/docs/api-reference/realtime-sessions  (client_secrets, session shape)
- https://platform.openai.com/docs/guides/realtime-webrtc  (SDP exchange on /v1/realtime/calls)
- Hermes core ``hermes_cli/plugin_provider_requests.py`` (signed requests for plugins)
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import live, persona
from .live import AUTO, VoiceError

CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"
CALLS_URL = "https://api.openai.com/v1/realtime/calls"
#: The Realtime model a ChatGPT/Codex sign-in can mint a client secret for. ``gpt-live-1-codex``
#: is only reachable through the Codex app-server, which this plugin deliberately does not drive.
DEFAULT_MODEL = live._OPENAI_DEFAULT_MODEL
TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe"
VOICES = live._OPENAI_VOICES
VOICE_GENDER = {
    **dict.fromkeys(("ash", "ballad", "echo", "verse", "cedar"), "male"),
    **dict.fromkeys(("alloy", "coral", "sage", "shimmer", "marin"), "female"),
}
MALE_VOICE = "cedar"
FEMALE_VOICE = "marin"
_MODEL_RE = re.compile(r"^gpt-(?:4o-)?realtime(?:-[a-z0-9.\-]+)?$")
_SECRET_RE = re.compile(r"^[A-Za-z0-9_\-.]{8,512}$")

#: ``post(url, json_body, timeout) -> (status, parsed_json_or_None, text)``; raises
#: :class:`NotSignedIn` when the profile has no Codex sign-in and :class:`Unsupported` when this
#: Hermes cannot sign requests for plugins.
Poster = Callable[[str, Dict[str, Any], float], Tuple[int, Any, str]]


class NotSignedIn(Exception):
    """No usable openai-codex sign-in in this Hermes profile."""


class Unsupported(Exception):
    """This Hermes has no core-signed provider requests (``hermes_cli.plugin_provider_requests``)."""


def valid_model(value: Any) -> bool:
    return isinstance(value, str) and bool(_MODEL_RE.match(value.strip()))


def resolve_voice(setting: str, gender: str) -> str:
    """``openai_voice`` setting, or by the persona's gender when it is ``auto``."""
    if setting and setting != AUTO:
        return setting
    return FEMALE_VOICE if gender == "female" else MALE_VOICE


def tool_definitions(name: str = persona.DEFAULT_PERSONA_NAME) -> List[Dict[str, Any]]:
    """The same two tools as the Gemini route, in Realtime's JSON-schema form."""
    out = []
    for decl in persona.tool_declarations(name):
        out.append({
            "type": "function",
            "name": decl["name"],
            "description": decl["description"],
            "parameters": _lower_types(decl["parameters"]),
        })
    return out


def _lower_types(schema: Any) -> Any:
    if isinstance(schema, dict):
        return {k: (v.lower() if k == "type" and isinstance(v, str) else _lower_types(v)) for k, v in schema.items()}
    if isinstance(schema, list):
        return [_lower_types(v) for v in schema]
    return schema


def _transcription_prompt(cfg: Dict[str, Any]) -> str:
    """A spelling hint for the input transcription (names, terms). Hebrew and English are both
    expected, so no ``language`` is pinned: a pinned language would mistranscribe the other one."""
    terms = [t for t in [cfg.get("persona_name", ""), cfg.get("persona_name_he", "")] + list(cfg.get("vocabulary") or []) if t]
    hint = "Hebrew and English conversation."
    if terms:
        hint += " Names and terms: " + ", ".join(dict.fromkeys(terms)) + "."
    return hint[:1000]


ISRAELI_PRONUNCIATION = ("When speaking Hebrew, use a native Israeli accent and natural Israeli pronunciation, "
                         "stress and prosody, not an American English accent. Keep Hebrew as Hebrew; "
                         "do not translate or switch language. When reading English, keep it English.")


def build_session(cfg: Dict[str, Any], carry: str = "") -> Dict[str, Any]:
    """The Realtime ``session`` object (GA shape) for ``client_secrets``. *cfg* has the persona
    resolved (``live.resolve_persona``)."""
    name = cfg["persona_name"]
    voice = resolve_voice(cfg.get("openai_voice", AUTO), cfg["persona_gender"])
    if cfg.get("brain", live.DEFAULT_BRAIN) == "hermes":
        # brain: hermes. Server VAD still detects turns, transcribes, and cancels on barge-in, but
        # never creates a response (create_response: false). The renderer creates every response
        # itself, out of band, with only the text to speak as its input. No tools: the voice can
        # neither delegate nor hang up by itself.
        return {
            "type": "realtime",
            "model": cfg.get("openai_model") or DEFAULT_MODEL,
            "instructions": persona.relay_instructions(
                cfg.get("instructions", ""), name=name, gender=cfg["persona_gender"],
                name_he=cfg.get("persona_name_he", "")) + "\n" + ISRAELI_PRONUNCIATION,
            "audio": {
                "input": {
                    "noise_reduction": {"type": "near_field"},
                    "transcription": {"model": TRANSCRIBE_MODEL, "prompt": _transcription_prompt(cfg)},
                    "turn_detection": {
                        "type": "server_vad",
                        "silence_duration_ms": cfg["silence_ms"],
                        "prefix_padding_ms": 300,
                        "create_response": False,
                        "interrupt_response": True,
                    },
                },
                "output": {"voice": voice, "speed": cfg.get("openai_speed", 1.15)},
            },
        }
    return {
        "type": "realtime",
        "model": cfg.get("openai_model") or DEFAULT_MODEL,
        "instructions": persona.instructions(
            cfg["language"], cfg.get("instructions", ""), name=name, gender=cfg["persona_gender"],
            voice=voice, name_he=cfg.get("persona_name_he", ""), engine="openai", carry=carry),
        "audio": {
            "input": {
                "noise_reduction": {"type": "near_field"},
                "transcription": {"model": TRANSCRIBE_MODEL, "prompt": _transcription_prompt(cfg)},
                "turn_detection": {
                    "type": "server_vad",
                    "silence_duration_ms": cfg["silence_ms"],
                    "prefix_padding_ms": 300,
                    "create_response": True,
                    "interrupt_response": True,
                },
            },
            "output": {"voice": voice, "speed": cfg.get("openai_speed", 1.15)},
        },
        "tools": tool_definitions(name),
        "tool_choice": "auto",
    }


def _error_code(payload: Any, text: str) -> str:
    err = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(err, dict):
        return " ".join(str(err.get(k) or "") for k in ("code", "type", "message"))
    return text or ""


def classify(status: int, detail: str) -> str:
    """Map a refused mint to a fallback reason: quota, auth, unavailable or rejected."""
    low = (detail or "").lower()
    if status == 429 or "insufficient_quota" in low or "rate_limit" in low or "quota" in low or "usage limit" in low:
        return "quota"
    if status in (401, 403) or "invalid_api_key" in low or "unauthorized" in low:
        return "auth"
    if status >= 500 or "overloaded" in low or "high demand" in low:
        return "unavailable"
    return "rejected"


_UNSUPPORTED = ("This Hermes cannot sign Codex requests for plugins (no hermes_cli.plugin_provider_requests); "
                "update Hermes to use the ChatGPT/Codex voice.")

_REASON_MESSAGES = {
    "quota": "OpenAI Realtime refused the call: the ChatGPT/Codex voice allowance or rate limit is used up ({status}).",
    "auth": ("OpenAI refused the Codex sign-in ({status}). Sign in again under Providers in Hermes "
             "(or `hermes auth login openai-codex`)."),
    "unavailable": "OpenAI Realtime is unavailable right now ({status}).",
    "rejected": "OpenAI refused the Realtime session request ({status}).",
}


def mint_session(post: Optional[Poster], cfg: Dict[str, Any], carry: str = "") -> Dict[str, Any]:
    """Ephemeral client secret + offer URL + effective model/voice. Raises :class:`VoiceError`."""
    if post is None:
        raise VoiceError("unsupported", _UNSUPPORTED, 503)
    session = build_session(cfg, carry)
    # Same body shape as the proven Synero/hermes-live-voice route; OpenAI's default secret TTL applies.
    body = {"session": session}
    try:
        status, payload, text = post(CLIENT_SECRETS_URL, body, 30.0)
    except NotSignedIn:
        raise VoiceError("not_signed_in", "Not signed in to OpenAI Codex in this Hermes profile. Sign in under "
                         "Providers in Hermes (openai-codex).", 503) from None
    except Unsupported:
        raise VoiceError("unsupported", _UNSUPPORTED, 503) from None
    except PermissionError:
        raise VoiceError("auth", "Hermes refused to sign the request for this plugin (requires_auth or a custom "
                         "Codex endpoint).", 502) from None
    except Exception as exc:  # DNS, TLS, timeout; never echo the exception text (it may carry headers)
        raise VoiceError("unreachable", f"OpenAI is unreachable ({type(exc).__name__}).", 502) from None
    if status >= 400 or not isinstance(payload, dict):
        reason = classify(status, _error_code(payload, text)) if status >= 400 else "rejected"
        raise VoiceError(reason, _REASON_MESSAGES[reason].format(status=status), 502)
    secret = payload.get("value")
    nested = payload.get("client_secret")
    if not isinstance(secret, str) and isinstance(nested, dict):
        secret = nested.get("value")
    if not isinstance(secret, str) or not _SECRET_RE.match(secret):
        raise VoiceError("rejected", "Unexpected answer from OpenAI's client-secret service.", 502)
    expires = payload.get("expires_at")
    if not isinstance(expires, (int, float)) and isinstance(nested, dict):
        expires = nested.get("expires_at")
    return {
        "transport": "openai-realtime",
        "client_secret": secret,
        "expires_at": int(expires) if isinstance(expires, (int, float)) else None,
        "offer_url": CALLS_URL,
        "model": session["model"],
        "voice": session["audio"]["output"]["voice"],
        "persona_name": cfg["persona_name"],
        "brain": cfg.get("brain", live.DEFAULT_BRAIN),
    }
