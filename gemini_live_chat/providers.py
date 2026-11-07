"""Voice providers and the fallback chain.

A *provider* is one way to start a live voice session. Each has a ``transport`` the renderer knows
how to drive (``gemini-live``: a WebSocket with PCM audio; ``openai-realtime``: WebRTC) and a
credential that never leaves the backend:

=================  ===============================  ===================================================
id                 transport                        credential (read only here, never returned or logged)
=================  ===============================  ===================================================
``gemini-free``    ``gemini-live``                  ``GEMINI_API_KEY`` via ``agent.secret_scope``
``openai-codex``   ``openai-realtime``              the profile's openai-codex sign-in; Hermes core signs
                                                    the request (``credentialed_provider_request``)
``gemini-paid``    ``gemini-live``                  ``GEMINI_API_KEY_PAID`` via ``agent.secret_scope``
=================  ===============================  ===================================================

:func:`connect` walks the configured order (setting ``providers``), skipping providers the renderer
excluded (already failed on this call, or cooling down after a quota/auth refusal) and providers
that cannot start (no key, no sign-in, old Hermes). The first provider that mints a session serves;
every skipped or failed provider is reported in ``attempts`` (id + reason, never a secret or a
vendor message that could echo one). A provider that refused is never retried on the same call:
falling back to a *different* provider is the only reaction to a block.

This module is pure: secrets and the Codex signer are injected (:class:`Sources`), so the chain is
tested without Hermes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from . import live, openai_rt, persona

GEMINI_FREE = "gemini-free"
OPENAI_CODEX = "openai-codex"
GEMINI_PAID = "gemini-paid"


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    transport: str
    secret: Optional[str] = None  # env name for a key-based provider


PROVIDERS: Dict[str, Provider] = {
    GEMINI_FREE: Provider(GEMINI_FREE, "Gemini (free key)", "gemini-live", "GEMINI_API_KEY"),
    OPENAI_CODEX: Provider(OPENAI_CODEX, "ChatGPT (Codex subscription)", "openai-realtime"),
    GEMINI_PAID: Provider(GEMINI_PAID, "Gemini (paid key)", "gemini-live", "GEMINI_API_KEY_PAID"),
}
DEFAULT_ORDER: Tuple[str, ...] = (GEMINI_FREE, OPENAI_CODEX, GEMINI_PAID)

#: Why a provider did not serve. The renderer uses the same words for mid-call failures.
REASONS = ("no_key", "not_signed_in", "unsupported", "quota", "auth", "unavailable", "unreachable",
           "rejected", "excluded", "network", "expired")
_REASON_TEXT = {
    "no_key": "no key", "not_signed_in": "not signed in", "unsupported": "this Hermes is too old",
    "quota": "quota or rate limit", "auth": "credential refused", "unavailable": "service unavailable",
    "unreachable": "unreachable", "rejected": "request refused", "excluded": "skipped on this call",
    "network": "connection lost", "expired": "session expired",
}
#: Reasons that mean "not set up" rather than "tried and refused".
UNCONFIGURED = ("no_key", "not_signed_in", "unsupported")


@dataclass
class Sources:
    """What the chain needs from Hermes, injected so tests need no Hermes.

    ``secret(name)`` returns the profile's value or "" (never raises); ``codex_post`` is the core
    signer adapter (:data:`openai_rt.Poster`) or None on a Hermes without signed provider requests.
    """

    secret: Callable[[str], str]
    codex_post: Optional[openai_rt.Poster] = None
    gemini_post: Optional[live.Poster] = None


def parse_order(raw: Any, problems: List[str]) -> List[str]:
    """``providers`` setting: a list or comma-separated string of provider ids, deduplicated, in
    order. Unknown ids are dropped (and reported); empty means the default chain."""
    if raw in (None, "", []):
        return list(DEFAULT_ORDER)
    if isinstance(raw, str):
        items = [p.strip() for p in raw.split(",")]
    elif isinstance(raw, (list, tuple)):
        items = [str(p).strip() for p in raw]
    else:
        problems.append(f"settings.providers {raw!r} is not valid; using {', '.join(DEFAULT_ORDER)}")
        return list(DEFAULT_ORDER)
    order: List[str] = []
    for item in items:
        if not item:
            continue
        if item not in PROVIDERS:
            problems.append(f"settings.providers: unknown provider {item!r} ignored "
                            f"(known: {', '.join(PROVIDERS)})")
        elif item not in order:
            order.append(item)
    if not order:
        problems.append(f"settings.providers has no known provider; using {', '.join(DEFAULT_ORDER)}")
        return list(DEFAULT_ORDER)
    return order


def clean_ids(raw: Any) -> List[str]:
    """Provider ids from a request body (anything else is dropped)."""
    if not isinstance(raw, (list, tuple)):
        return []
    return [p for p in dict.fromkeys(str(x) for x in raw[:10]) if p in PROVIDERS]


def clean_reason(raw: Any) -> Optional[str]:
    return raw if isinstance(raw, str) and raw in REASONS else None


def readiness(provider_id: str, src: Sources) -> Tuple[bool, Optional[str]]:
    """Can this provider be tried at all? Cheap and local: key presence, signer presence. The
    Codex sign-in itself is checked by Hermes when the session is minted."""
    p = PROVIDERS[provider_id]
    if p.secret:
        return (True, None) if src.secret(p.secret) else (False, "no_key")
    if p.id == OPENAI_CODEX:
        return (True, None) if src.codex_post is not None else (False, "unsupported")
    return False, "unsupported"  # pragma: no cover - every provider is one of the above


def describe(order: Sequence[str], src: Sources) -> List[Dict[str, Any]]:
    """Non-secret view of the chain for ``/status`` and the UI."""
    out = []
    for pid in order:
        ok, reason = readiness(pid, src)
        p = PROVIDERS[pid]
        out.append({"id": pid, "label": p.label, "transport": p.transport, "ready": ok, "reason": reason})
    return out


def _mint_one(provider_id: str, cfg: Dict[str, Any], src: Sources, resume_handle: Optional[str],
              carry: str) -> Dict[str, Any]:
    p = PROVIDERS[provider_id]
    if p.transport == "gemini-live":
        out = live.mint_session(src.secret(p.secret), cfg, resume_handle=resume_handle,
                                poster=src.gemini_post, carry=carry, key_name=p.secret)
        out["transport"] = "gemini-live"
    else:
        out = openai_rt.mint_session(src.codex_post, cfg, carry=carry)
    out["provider"] = p.id
    out["provider_label"] = p.label
    return out


def connect(order: Sequence[str], cfg: Dict[str, Any], src: Sources, *, exclude: Sequence[str] = (),
            only: Optional[str] = None, resume_handle: Optional[str] = None,
            carry: str = "") -> Tuple[Optional[Dict[str, Any]], List[Dict[str, str]]]:
    """Mint a session on the first provider of *order* that can serve.

    ``only`` pins one provider (Gemini resumption: a handle belongs to the key that issued it) and
    disables fallback. Returns ``(minted or None, attempts)``; ``attempts`` lists every provider
    that was skipped or refused, in order, as ``{"provider", "reason"}``.
    """
    attempts: List[Dict[str, str]] = []
    candidates = [only] if only else list(order)
    carry = persona.clean_carry(carry)
    for pid in candidates:
        if pid not in PROVIDERS:
            continue
        if pid in exclude and not only:
            attempts.append({"provider": pid, "reason": "excluded"})
            continue
        ok, reason = readiness(pid, src)
        if not ok:
            attempts.append({"provider": pid, "reason": reason or "unsupported"})
            continue
        try:
            minted = _mint_one(pid, cfg, src, resume_handle if only else None, carry)
        except live.VoiceError as exc:
            attempts.append({"provider": pid, "reason": exc.reason if exc.reason in REASONS else "rejected"})
            continue
        minted["attempts"] = attempts
        return minted, attempts
    return None, attempts


def failure_message(attempts: Sequence[Dict[str, str]]) -> str:
    if not attempts:
        return "No voice provider is configured (settings.providers)."
    parts = [f"{PROVIDERS[a['provider']].label}: {_REASON_TEXT.get(a['reason'], a['reason'])}"
             for a in attempts if a.get("provider") in PROVIDERS]
    text = "No voice provider could start. " + "; ".join(parts) + "."
    if any(a["reason"] == "no_key" and a["provider"] == GEMINI_FREE for a in attempts):
        text += " Add GEMINI_API_KEY (Google AI Studio key) to this Hermes profile's .env."
    if any(a["reason"] == "not_signed_in" for a in attempts):
        text += " Sign in to OpenAI Codex under Providers in Hermes."
    return text


_SAFE = re.compile(r"[^a-z0-9_.\-:,]")


def log_line(minted: Dict[str, Any], kind: str, switch_from: Optional[str], reason: Optional[str]) -> str:
    """One INFO line per served session: which provider, why the earlier ones did not serve. Only
    ids, enums and the model name; no secret, no token, no vendor text."""
    skipped = ",".join(f"{a['provider']}:{a['reason']}" for a in minted.get("attempts") or [])
    model = _SAFE.sub("", str(minted.get("model", "")).lower())[:60]
    line = f"voice provider {minted['provider']} serving ({kind}; model={model}"
    if switch_from:
        line += f"; switched from {switch_from}" + (f" after {reason}" if reason else "")
    if skipped:
        line += f"; skipped {skipped}"
    return line + ")"
