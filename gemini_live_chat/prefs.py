"""The provider picker's durable state: the user's choice and what each provider last did.

Stored per Hermes profile in the plugin's own data directory through Hermes' plugin state API
(``hermes_cli.plugins_state.PluginState``: ``<HERMES_HOME>/plugin-data/<namespace>/state.json``,
atomic, locked), never in ``config.yaml``. The store is injected so tests need no Hermes:
anything with ``get(key, default)`` and ``set(key, value)`` works.

Two keys:

* ``provider_choice``: ``auto`` (walk the configured chain) or one provider id (that one only).
* ``provider_health``: ``{provider_id: {"reason": <REMEMBERED reason or None>, "at": <unix s>}}``,
  the last outcome per provider. ``reason`` None means it served. Only ids and enums are stored;
  never a key, a token or vendor text.

Reading never raises: a broken or missing store reads as ``auto`` with no history, so the voice
button always works.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Dict, Optional, Sequence

from . import providers

logger = logging.getLogger("gemini-live-chat")

CHOICE_KEY = "provider_choice"
HEALTH_KEY = "provider_health"


class MemoryStore:
    """Stand-in when this Hermes has no plugin state API: works, but is lost on restart."""

    persistent = False

    def __init__(self) -> None:
        self._data: Dict[str, Any] = {}

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self._data[key] = value


class Prefs:
    def __init__(self, store: Any, now: Callable[[], float] = time.time) -> None:
        self.store = store
        self.now = now

    @property
    def persistent(self) -> bool:
        return getattr(self.store, "persistent", True)

    def _get(self, key: str, default: Any) -> Any:
        try:
            return self.store.get(key, default)
        except Exception:  # unreadable state file: behave as a fresh install
            logger.warning("gemini-live-chat: plugin state unreadable (%s); using defaults", key)
            return default

    def _set(self, key: str, value: Any) -> bool:
        try:
            self.store.set(key, value)
            return True
        except Exception:
            logger.warning("gemini-live-chat: plugin state not writable (%s)", key)
            return False

    # ── choice ──────────────────────────────────────────────────────────────────────────────────

    def choice(self) -> str:
        return providers.clean_choice(self._get(CHOICE_KEY, providers.AUTO)) or providers.AUTO

    def set_choice(self, choice: str) -> bool:
        if providers.clean_choice(choice) is None:
            raise ValueError(f"unknown provider choice {choice!r}")
        return self._set(CHOICE_KEY, choice)

    # ── health ──────────────────────────────────────────────────────────────────────────────────

    def health(self) -> Dict[str, Dict[str, Any]]:
        raw = self._get(HEALTH_KEY, {})
        out: Dict[str, Dict[str, Any]] = {}
        if not isinstance(raw, dict):
            return out
        for pid, entry in raw.items():
            if pid not in providers.PROVIDERS or not isinstance(entry, dict):
                continue
            reason = entry.get("reason")
            at = entry.get("at")
            if reason is not None and reason not in providers.REMEMBERED:
                continue
            if not isinstance(at, (int, float)):
                continue
            out[pid] = {"reason": reason, "at": float(at)}
        return out

    def _update(self, changes: Dict[str, Optional[str]]) -> None:
        if not changes:
            return
        health = self.health()
        now = float(self.now())
        for pid, reason in changes.items():
            health[pid] = {"reason": reason, "at": now}
        self._set(HEALTH_KEY, health)

    def record(self, attempts: Sequence[Dict[str, str]], served: Optional[str] = None) -> None:
        """Remember the refusals worth showing (quota, billing, auth, not signed in) and that
        *served* worked. Skips that say nothing about the provider (excluded, no key) are ignored:
        the picker computes key presence live."""
        changes: Dict[str, Optional[str]] = {}
        for a in attempts or ():
            pid, reason = a.get("provider"), a.get("reason")
            if pid in providers.PROVIDERS and reason in providers.REMEMBERED:
                changes[pid] = reason
        if served in providers.PROVIDERS:
            changes[served] = None
        self._update(changes)

    def report(self, provider_id: Any, reason: Any) -> bool:
        """A failure the renderer saw (mid-call, or on the provider's own socket)."""
        if provider_id not in providers.PROVIDERS or reason not in providers.REMEMBERED:
            return False
        self._update({provider_id: reason})
        return True
