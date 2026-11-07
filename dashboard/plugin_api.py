"""Backend half of gemini-live-chat, mounted at ``/api/plugins/gemini-live-chat/``.

* ``GET  /status``  -> ``{available, reason, message, settings, problems}`` (key presence only)
* ``POST /session`` -> ``{url, expires_at, model, voice, setup}``; body ``{resume_handle?}``

The Gemini key is read per request through ``agent.secret_scope.get_secret`` (profile-scoped,
catalog rule 11), spent only inside :func:`gemini_live_chat.live.mint_session`, and never returned,
logged or stored. The routes hold no socket and start no process: the renderer opens the Live socket
itself with the single-use token, so stopping a call needs nothing from this side.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from gemini_live_chat import live  # noqa: E402

logger = logging.getLogger("gemini-live-chat")
router = APIRouter()
PLUGIN_ID = "gemini-live-chat"
NO_KEY_MESSAGE = ("Gemini Live needs GEMINI_API_KEY. Add it to this Hermes profile's .env "
                  "(Google AI Studio key), then reload the plugin.")


def _key() -> str:
    """The profile's key, or "" when it is missing or unscoped. Never logged."""
    try:
        from agent.secret_scope import UnscopedSecretError, get_secret
    except ImportError:  # outside Hermes (tests): nothing to read
        return ""
    try:
        return (get_secret("GEMINI_API_KEY") or "").strip()
    except UnscopedSecretError:  # several profiles, none bound: never fall back to another's key
        return ""


def _settings() -> Dict[str, Any]:
    try:
        from hermes_cli.config import load_config_readonly
        entry = (((load_config_readonly() or {}).get("plugins") or {}).get("entries") or {}).get(PLUGIN_ID) or {}
        return live.settings(entry.get("settings"))
    except Exception:
        logger.warning("gemini-live-chat: settings unreadable, using defaults")
        return live.settings(None)


@router.get("/status")
def status() -> Dict[str, Any]:
    cfg = _settings()
    ready = bool(_key())
    return {
        "available": ready,
        "reason": None if ready else "no_key",
        "message": None if ready else NO_KEY_MESSAGE,
        "settings": live.client_settings(cfg),
        "problems": cfg["problems"],
    }


@router.post("/session")
def session(body: Optional[Dict[str, Any]] = None):
    body = body if isinstance(body, dict) else {}
    try:
        out = live.mint_session(_key(), _settings(), resume_handle=body.get("resume_handle"))
    except live.VoiceError as exc:
        logger.info("gemini-live-chat: session refused (%s)", exc.reason)
        detail = exc.detail()
        if exc.reason == "no_key":
            detail["message"] = NO_KEY_MESSAGE
        return JSONResponse(status_code=exc.status, content={"detail": detail})
    logger.info("gemini-live-chat: live token minted (model=%s, expires_at=%s)", out["model"], out["expires_at"])
    return out
