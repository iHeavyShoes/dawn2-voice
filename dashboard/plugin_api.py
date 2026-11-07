"""Backend half of gemini-live-chat, mounted at ``/api/plugins/gemini-live-chat/``.

* ``GET  /status``  -> ``{available, reason, message, settings, problems, providers}``
  (credential *presence* per provider only)
* ``POST /session`` -> the first provider of the chain that can serve:
  ``{provider, provider_label, transport, model, voice, attempts, ...transport fields}``.
  Body (all optional): ``{resume_handle, provider, exclude: [ids], carry, switch_from, reason}``.

  - ``provider`` + ``resume_handle``: Gemini session resumption on the provider that issued the
    handle (no fallback: a handle belongs to its key).
  - ``exclude``: providers the renderer already saw fail on this call, or that are cooling down
    after a quota/auth refusal; the chain skips them.
  - ``carry``: the recent spoken turns after a mid-call switch, put into the next provider's
    instructions so it continues the conversation.

Credentials never leave this side and are never returned or logged:

* Gemini keys (``GEMINI_API_KEY``, ``GEMINI_API_KEY_PAID``) are read per request through
  ``agent.secret_scope.get_secret`` (profile-scoped) and spent only in
  :func:`gemini_live_chat.live.mint_session`.
* The Codex sign-in is never read by the plugin: :func:`_codex_post` asks Hermes core
  (``hermes_cli.plugin_provider_requests.credentialed_provider_request``) to sign one
  ``POST /v1/realtime/client_secrets``; ``plugin.yaml`` declares ``requires_auth: [openai-codex]``.

The routes hold no socket and start no process: the renderer opens the provider connection itself
with the short-lived token/secret, so stopping a call needs nothing from this side.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter
from fastapi.responses import JSONResponse

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from gemini_live_chat import live, openai_rt, providers  # noqa: E402

logger = logging.getLogger("gemini-live-chat")
router = APIRouter()
PLUGIN_ID = "gemini-live-chat"
NO_KEY_MESSAGE = ("Gemini Live needs GEMINI_API_KEY. Add it to this Hermes profile's .env "
                  "(Google AI Studio key), then reload the plugin.")


def _secret(name: str) -> str:
    """The profile's value for *name*, or "" when it is missing or unscoped. Never logged."""
    try:
        from agent.secret_scope import UnscopedSecretError, get_secret
    except ImportError:  # outside Hermes (tests): nothing to read
        return ""
    try:
        return (get_secret(name) or "").strip()
    except UnscopedSecretError:  # several profiles, none bound: never fall back to another's key
        return ""


def _key() -> str:
    """The free-tier key (kept for v0.3 callers)."""
    return _secret("GEMINI_API_KEY")


def _provider_requests():
    """Hermes core's signed-request API; None on a Hermes too old to ship it."""
    try:
        from hermes_cli import plugin_provider_requests
    except ImportError:
        return None
    return plugin_provider_requests


def _codex_post(url: str, body: Dict[str, Any], timeout: float) -> Tuple[int, Any, str]:
    """POST *body* to *url* with the profile's openai-codex sign-in, attached by Hermes core.

    Must stay plugin code called from plugin code: core attributes the request to the plugin it
    finds on the call stack and checks ``requires_auth`` in this plugin's ``plugin.yaml``. Only the
    status and the JSON body come back; core never hands the token to the plugin.
    """
    ppr = _provider_requests()
    if ppr is None:
        raise openai_rt.Unsupported()
    try:
        r = ppr.credentialed_provider_request("openai-codex", "POST", url, json=body, timeout=timeout)
    except ppr.ProviderNotSignedIn:
        raise openai_rt.NotSignedIn() from None
    try:
        payload = r.json()
    except Exception:  # non-JSON error page
        payload = None
    return r.status, payload, (r.text[:300] if r.status >= 400 else "")


def _sources() -> providers.Sources:
    return providers.Sources(secret=_secret, codex_post=_codex_post if _provider_requests() else None)


SOUL_READ_LIMIT = 16_384


def _soul_text() -> Optional[str]:
    """The head of the serving profile's ``SOUL.md`` (``hermes_constants.get_hermes_home()``, the
    home this request is scoped to), or None. Only the agent's name and stated gender are extracted
    from it (:func:`gemini_live_chat.persona.identity_from_soul`); the text itself is not sent."""
    try:
        from hermes_constants import get_hermes_home
        path = Path(get_hermes_home()) / "SOUL.md"
        if not path.is_file():
            return None
        with path.open("r", encoding="utf-8-sig", errors="replace") as fh:
            return fh.read(SOUL_READ_LIMIT)
    except Exception:  # outside Hermes (tests) or unreadable: the persona falls back to settings/defaults
        return None


def _settings() -> Dict[str, Any]:
    """This profile's ``plugins.entries.gemini-live-chat.settings`` (``load_config`` is scoped to the
    profile the request is for), with the persona resolved against that profile's SOUL.md."""
    try:
        from hermes_cli.config import load_config_readonly
        entry = (((load_config_readonly() or {}).get("plugins") or {}).get("entries") or {}).get(PLUGIN_ID) or {}
        cfg = live.settings(entry.get("settings"))
    except Exception:
        logger.warning("gemini-live-chat: settings unreadable, using defaults")
        cfg = live.settings(None)
    return live.resolve_persona(cfg, _soul_text())


@router.get("/status")
def status() -> Dict[str, Any]:
    cfg = _settings()
    chain = providers.describe(cfg["providers"], _sources())
    ready = any(p["ready"] for p in chain)
    only_gemini_free = [p["id"] for p in chain] == [providers.GEMINI_FREE]
    message = None
    if not ready:
        message = NO_KEY_MESSAGE if only_gemini_free else providers.failure_message(
            [{"provider": p["id"], "reason": p["reason"]} for p in chain])
    return {
        "available": ready,
        "reason": None if ready else "no_key",
        "message": message,
        "settings": live.client_settings(cfg),
        "problems": cfg["problems"],
        "providers": chain,
    }


@router.post("/session")
def session(body: Optional[Dict[str, Any]] = None):
    body = body if isinstance(body, dict) else {}
    cfg = _settings()
    only = body.get("provider") if body.get("provider") in providers.PROVIDERS else None
    switch_from = body.get("switch_from") if body.get("switch_from") in providers.PROVIDERS else None
    reason = providers.clean_reason(body.get("reason"))
    kind = "resume" if only else ("mid_call" if switch_from else "connect")
    minted, attempts = providers.connect(
        cfg["providers"], cfg, _sources(),
        exclude=providers.clean_ids(body.get("exclude")),
        only=only,
        resume_handle=live.valid_handle(body.get("resume_handle")) if only else None,
        carry=body.get("carry") or "",
    )
    if minted is None:
        logger.info("gemini-live-chat: no voice provider could serve (%s; %s)", kind,
                    ",".join(f"{a['provider']}:{a['reason']}" for a in attempts) or "none configured")
        unconfigured = all(a["reason"] in providers.UNCONFIGURED for a in attempts)
        if [a["provider"] for a in attempts] == [providers.GEMINI_FREE] and attempts[0]["reason"] == "no_key":
            message = NO_KEY_MESSAGE
        else:
            message = providers.failure_message(attempts)
        # no_key: nothing is set up (v0.3 contract); exhausted: something was tried and refused.
        reason_out = "no_key" if unconfigured else "exhausted"
        status_code = 503 if unconfigured or all(a["reason"] in providers.UNCONFIGURED + ("excluded",)
                                                 for a in attempts) else 502
        return JSONResponse(status_code=status_code,
                            content={"detail": {"reason": reason_out, "message": message, "attempts": attempts}})
    logger.info("gemini-live-chat: %s", providers.log_line(minted, kind, switch_from, reason))
    return minted
