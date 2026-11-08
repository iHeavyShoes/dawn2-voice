"""Backend half of gemini-live-chat, mounted at ``/api/plugins/gemini-live-chat/``.

* ``GET  /status``  -> ``{available, reason, message, settings, problems, providers}``
  (credential *presence* per provider only)
* ``POST /session`` -> the first provider of the chain that can serve:
  ``{provider, provider_label, transport, model, voice, attempts, ...transport fields}``.
  Body (all optional): ``{resume_handle, provider, exclude: [ids], carry, switch_from, reason}``.
  The minted session carries ``brain`` (v0.6): ``hermes`` (default; the renderer delegates every
  substantive turn, the voice only reads) or ``voice`` (v0.5: the voice model delegates).

  - ``provider`` + ``resume_handle``: Gemini session resumption on the provider that issued the
    handle (no fallback: a handle belongs to its key).
  - ``exclude``: providers the renderer already saw fail on this call, or that are cooling down
    after a quota/auth refusal; the chain skips them.
  - ``carry``: the recent spoken turns after a mid-call switch, put into the next provider's
    instructions so it continues the conversation (``brain: voice`` only).

* ``POST /latency`` -> one log line per voice turn (milliseconds from end-of-speech to submit,
  first Hermes text, first audio; ids, enums and integers only).
* v0.7 wake word (``settings.wake_word``): ``GET /wake`` (state), ``POST /wake/arm`` (listen when the
  setting is on, stop when off), ``/wake/claim {token}`` (the first window to claim a detection
  starts the call), ``/wake/pause`` and ``/wake/resume`` (the call's microphone hand-off). A
  detection is pushed as the plugin event ``plugin.gemini-live-chat.wake.detected {token, phrase}``.

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

from gemini_live_chat import latency, live, openai_rt, prefs, providers, wake  # noqa: E402

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
    """One request's view of Hermes: each secret is read at most once per request."""
    seen: Dict[str, str] = {}

    def secret(name: str) -> str:
        if name not in seen:
            seen[name] = _secret(name)
        return seen[name]

    return providers.Sources(secret=secret, codex_post=_codex_post if _provider_requests() else None)


_FALLBACK_STORE = prefs.MemoryStore()


def _prefs() -> prefs.Prefs:
    """The picker's state for the profile this request is scoped to, in the plugin's own data dir
    (``<HERMES_HOME>/plugin-data/<namespace>/state.json``) through Hermes' public plugin state API.
    Never ``config.yaml``. A Hermes without that API gets an in-memory store (lost on restart; the
    status route says so)."""
    try:
        from hermes_cli.plugins_state import PluginState
    except ImportError:
        return prefs.Prefs(_FALLBACK_STORE)
    return prefs.Prefs(PluginState(PLUGIN_ID))


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


def _picker(cfg: Dict[str, Any], src: providers.Sources, p: prefs.Prefs) -> Dict[str, Any]:
    choice = p.choice()
    return {"choice": choice, "persistent": p.persistent,
            "options": providers.picker(cfg["providers"], src, p.health(), choice)}


@router.get("/status")
def status() -> Dict[str, Any]:
    cfg = _settings()
    src = _sources()
    p = _prefs()
    picker = _picker(cfg, src, p)
    order = providers.order_for(picker["choice"], cfg["providers"])
    chain = providers.describe(order, src)
    ready = any(x["ready"] for x in chain)
    only_gemini_free = [x["id"] for x in chain] == [providers.GEMINI_FREE] and picker["choice"] == providers.AUTO
    message = None
    if not ready:
        if picker["choice"] != providers.AUTO:
            message = providers.pinned_failure_message(
                picker["choice"], [{"provider": x["id"], "reason": x["reason"]} for x in chain])
        else:
            message = NO_KEY_MESSAGE if only_gemini_free else providers.failure_message(
                [{"provider": x["id"], "reason": x["reason"]} for x in chain])
    return {
        "available": ready,
        "reason": None if ready else "no_key",
        "message": message,
        "settings": live.client_settings(cfg),
        "problems": cfg["problems"],
        "providers": chain,
        # v0.5: the provider picker (choice, per-provider availability, remembered refusals).
        "picker": picker,
    }


@router.post("/choice")
def set_choice(body: Optional[Dict[str, Any]] = None):
    """Store the user's provider choice (``auto`` or one provider id) for this profile."""
    body = body if isinstance(body, dict) else {}
    choice = providers.clean_choice(body.get("choice"))
    if choice is None:
        return JSONResponse(status_code=400, content={"detail": {
            "reason": "invalid", "message": f"choice must be one of: {', '.join(providers.CHOICES)}"}})
    p = _prefs()
    if not p.set_choice(choice):
        return JSONResponse(status_code=500, content={"detail": {
            "reason": "not_saved", "message": "The provider choice could not be saved."}})
    logger.info("gemini-live-chat: voice provider choice set to %s", choice)
    return _picker(_settings(), _sources(), p)


@router.post("/report")
def report(body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """A refusal the renderer saw on the provider's own connection (mid-call quota, billing, auth),
    remembered so the picker can show it. Ids and enums only."""
    body = body if isinstance(body, dict) else {}
    ok = _prefs().report(body.get("provider"), body.get("reason"))
    if ok:
        logger.info("gemini-live-chat: voice provider %s reported %s", body.get("provider"), body.get("reason"))
    return {"recorded": ok}


@router.post("/latency")
def latency_report(body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """One latency line per voice turn (milliseconds from the provider's end-of-speech; ids, enums
    and integers only, no transcript or reply text), for before/after measurements in the log."""
    rec = latency.clean(body)
    if rec is None:
        return {"ok": False}
    logger.info("gemini-live-chat: %s", latency.line(rec))
    return {"ok": True}


# ── v0.7: the plugin's own wake word (gemini_live_chat/wake.py) ─────────────────────────────────


def _wake_status(m: "wake.WakeManager", cfg: Dict[str, Any]) -> Dict[str, Any]:
    out = m.status()
    out["enabled"] = bool(cfg.get("wake_word"))
    out["surface"] = cfg.get("wake_surface", live.DEFAULT_WAKE_SURFACE)
    if out["enabled"]:
        out["phrase"] = out["phrase"] or live.effective_wake_phrase(cfg)
    return out


@router.get("/wake")
def wake_status() -> Dict[str, Any]:
    return _wake_status(wake.manager(), _settings())


@router.post("/wake/arm")
def wake_arm() -> Dict[str, Any]:
    """Start listening when the ``wake_word`` setting is on (idempotent); disarm when it is off, so a
    settings change applies on the next window load. The renderer calls this once per window."""
    cfg = _settings()
    m = wake.manager()
    if not cfg.get("wake_word"):
        m.disarm()
    else:
        m.arm(live.effective_wake_phrase(cfg), cfg.get("wake_sensitivity", live.DEFAULT_WAKE_SENSITIVITY))
    return _wake_status(m, cfg)


@router.post("/wake/claim")
def wake_claim(body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The first window to claim a detection starts the call; every later claim gets false."""
    body = body if isinstance(body, dict) else {}
    return {"claimed": wake.manager().claim(body.get("token"))}


@router.post("/wake/pause")
def wake_pause() -> Dict[str, Any]:
    """Free the microphone before a call opens its own (a call started from the button)."""
    return {"paused": wake.manager().pause()}


@router.post("/wake/resume")
def wake_resume() -> Dict[str, Any]:
    """Listen again after a hang-up (retries while the browser still holds the device)."""
    return {"resuming": wake.manager().resume()}


@router.post("/session")
def session(body: Optional[Dict[str, Any]] = None):
    body = body if isinstance(body, dict) else {}
    cfg = _settings()
    p = _prefs()
    choice = p.choice()
    pinned = choice != providers.AUTO
    only = body.get("provider") if body.get("provider") in providers.PROVIDERS else None
    switch_from = body.get("switch_from") if body.get("switch_from") in providers.PROVIDERS else None
    reason = providers.clean_reason(body.get("reason"))
    kind = "resume" if only else ("mid_call" if switch_from else "connect")
    minted, attempts = providers.connect(
        providers.order_for(choice, cfg["providers"]), cfg, _sources(),
        # The user picked this one provider: a cooldown (advice) never skips it.
        exclude=() if pinned else providers.clean_ids(body.get("exclude")),
        only=only,
        resume_handle=live.valid_handle(body.get("resume_handle")) if only else None,
        carry=body.get("carry") or "",
    )
    p.record(attempts, served=minted["provider"] if minted else None)
    if minted is None:
        logger.info("gemini-live-chat: no voice provider could serve (%s; choice=%s; %s)", kind, choice,
                    ",".join(f"{a['provider']}:{a['reason']}" for a in attempts) or "none configured")
        unconfigured = all(a["reason"] in providers.UNCONFIGURED for a in attempts)
        if pinned and not only:
            message = providers.pinned_failure_message(choice, attempts)
            reason_out = "pinned_unavailable"
        elif [a["provider"] for a in attempts] == [providers.GEMINI_FREE] and attempts[0]["reason"] == "no_key":
            message = NO_KEY_MESSAGE
            reason_out = "no_key"
        else:
            message = providers.failure_message(attempts)
            # no_key: nothing is set up (v0.3 contract); exhausted: something was tried and refused.
            reason_out = "no_key" if unconfigured else "exhausted"
        status_code = 503 if unconfigured or all(a["reason"] in providers.UNCONFIGURED + ("excluded",)
                                                 for a in attempts) else 502
        return JSONResponse(status_code=status_code, content={"detail": {
            "reason": reason_out, "message": message, "attempts": attempts, "choice": choice}})
    logger.info("gemini-live-chat: %s", providers.log_line(minted, kind, switch_from, reason))
    minted["choice"] = choice
    return minted
