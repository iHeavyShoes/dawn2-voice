"""v0.7: the plugin's own wake word ("hey ray" starts THIS plugin's call, not core voice mode).

Why the plugin owns a listener instead of riding core's ``wake.detected``: on that event the Desktop
renderer lets plugins hear it first, then ALWAYS stops its client capture, plays the wake sound and
starts core's own voice conversation (``requestVoiceConversationStart``). There is no setting and no
SDK claim flag that makes core only emit the event, so a plugin answering it would start a second
voice session on the same microphone. With core's wake word off (``wake_word.enabled: false``) core
never emits the event, and this module runs the detector instead, through the same engine core uses
(``tools.wake_word``: sherpa-onnx open-vocabulary keyword spotting, any English phrase, no training).

Flow (one detector per gateway process, owned by this module):

1. ``arm(cfg)``: the renderer asks once per window; the engine is built on a worker thread (the
   first arm may install ``wake-sherpa`` and download the ~13 MB model).
2. Detection (detector thread): the microphone is released FIRST (``pause_listening``), then
   ``plugin.gemini-live-chat.wake.detected {token, phrase}`` goes to every connected window.
3. ``claim(token)``: the first eligible window (the Desktop app) to claim the token starts the call;
   every other window gets ``False``. Unclaimed after ``CLAIM_TIMEOUT_S``: the detector re-arms.
4. ``pause()`` before a call started from the button; ``resume()`` after every hang-up, retrying
   while the browser still holds the device.

Nothing here touches ``config.yaml``, and the detector never runs unless the plugin's ``wake_word``
setting is on and a window asked for it.
"""

from __future__ import annotations

import logging
import re
import secrets
import threading
import time
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("gemini-live-chat")

EVENT = "wake.detected"
CLAIM_TIMEOUT_S = 15.0
RESUME_DELAYS_S = (0.3, 0.7, 1.5, 3.0, 6.0)
DEFAULT_SENSITIVITY = 0.5
#: sherpa's keyword model is English (BPE vocabulary): a phrase must be Latin letters.
PHRASE_RE = re.compile(r"^[a-z][a-z' ]{1,38}[a-z]$")
STATES = ("off", "arming", "listening", "paused", "error", "unsupported")
CORE_WAKE_ON_MESSAGE = ("Hermes' own wake word is on (wake_word.enabled: true) and holds the microphone. "
                        "Turn it off so this plugin can listen.")


def engine_config(phrase: str, sensitivity: float, input_device: Any = None) -> Dict[str, Any]:
    """The config handed to ``tools.wake_word`` (its own ``wake_word`` section shape), never written
    to ``config.yaml``. ``profile_routing`` off: listen for this phrase only, not for the core wake
    phrases other profiles enrolled."""
    return {
        "enabled": True, "provider": "sherpa", "phrase": phrase, "sensitivity": float(sensitivity),
        "input_device": input_device, "capture": "local", "profile_routing": False,
        "sherpa": {"model_dir": ""},
    }


def clean_phrase(raw: Any) -> Optional[str]:
    """``"Hey Ray"`` -> ``"hey ray"``; None when the engine cannot spot it (Hebrew, digits, ...)."""
    if not isinstance(raw, str):
        return None
    p = re.sub(r"\s+", " ", raw.strip().lower())
    return p if PHRASE_RE.match(p) else None


def default_phrase(persona_name: Any) -> str:
    """``hey <persona name>`` when the name is spottable (Ray -> "hey ray"), else ``hey hermes``."""
    name = clean_phrase(f"hey {persona_name}") if isinstance(persona_name, str) and persona_name.strip() else None
    return name or "hey hermes"


def _load_engine_module():
    from tools import wake_word  # Hermes core's wake engine (the gateway's own listener uses it)
    return wake_word


def _broadcast(event: str, payload: Dict[str, Any]) -> None:
    from hermes_cli.plugin_events import broadcast_plugin_event
    broadcast_plugin_event("gemini-live-chat", event, payload)


def _spawn(fn: Callable[[], None], name: str) -> None:
    threading.Thread(target=fn, daemon=True, name=name).start()


class WakeManager:
    """State machine around one detector. Every public method is safe from any thread."""

    def __init__(self, load: Callable[[], Any] = _load_engine_module,
                 broadcast: Callable[[str, Dict[str, Any]], None] = _broadcast,
                 spawn: Callable[[Callable[[], None], str], None] = _spawn,
                 sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._load, self._broadcast, self._spawn, self._sleep, self._clock = load, broadcast, spawn, sleep, clock
        self._lock = threading.Lock()
        self.owner = object()  # the detector lease holder (tools.wake_word owner identity)
        self.state = "off"
        self.error = ""
        self.phrase = ""
        self._key: Optional[tuple] = None
        self._token: Optional[str] = None
        self._token_at = 0.0
        self._gen = 0  # bumped by every arm/disarm; stale worker threads back out
        self.detections = 0
        self.auto_armed = False  # v0.8: the gateway-side arm ran once in this process

    # ── v0.8: arm without a window (gateway restart) ────────────────────────────────────────────

    def auto_arm(self, phrase: str, sensitivity: float = DEFAULT_SENSITIVITY,
                 core_wake_on: bool = False, reason: str = "startup") -> Dict[str, Any]:
        """Arm once per process without waiting for a renderer: the gateway restarted, the old
        detector died with it, and an already-loaded window will not call ``/wake/arm`` again.

        Never disarms (only the explicit ``/wake/arm`` route does). Idempotent: a detector that is
        already arming, listening or paused (a call holds the mic) is left alone. When Hermes' own
        wake word is on, the microphone is not touched at all (one mic lease per machine)."""
        with self._lock:
            if self.auto_armed:
                return self._status_locked()
            self.auto_armed = True
            busy = self.state in ("arming", "listening", "paused")
        if busy:
            return self.status()
        if core_wake_on:
            self.refuse(CORE_WAKE_ON_MESSAGE)
            logger.warning("gemini-live-chat: wake word not armed (%s): %s", reason, CORE_WAKE_ON_MESSAGE)
            return self.status()
        logger.info("gemini-live-chat: arming the wake word on %s", reason)
        return self.arm(phrase, sensitivity)

    def refuse(self, msg: str) -> Dict[str, Any]:
        """Report why the detector is not armed without touching the engine. An active detector is
        left running (it already holds the lease)."""
        with self._lock:
            if self.state not in ("arming", "listening", "paused"):
                self._gen += 1
                self.state, self.error, self._key, self._token = "error", msg, None, None
            return self._status_locked()

    # ── status ──────────────────────────────────────────────────────────────────────────────────

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {"state": self.state, "phrase": self.phrase, "error": self.error,
                    "detections": self.detections}

    # ── arm / disarm ────────────────────────────────────────────────────────────────────────────

    def arm(self, phrase: str, sensitivity: float = DEFAULT_SENSITIVITY, input_device: Any = None) -> Dict[str, Any]:
        key = (phrase, float(sensitivity), input_device)
        with self._lock:
            if self._key == key and self.state in ("arming", "listening", "paused"):
                return self._status_locked()
        if self._key is not None and self._key != key:
            self.disarm()  # settings changed: rebuild the engine with the new phrase
        with self._lock:
            self._gen += 1
            gen = self._gen
            self._key, self.phrase, self.state, self.error = key, phrase, "arming", ""
        self._spawn(lambda: self._arm_worker(gen, key), "glc-wake-arm")
        return self.status()

    def _arm_worker(self, gen: int, key: tuple) -> None:
        phrase, sensitivity, input_device = key
        try:
            ww = self._load()
        except Exception as e:  # a Hermes without tools.wake_word
            self._fail(gen, "unsupported", f"This Hermes has no wake-word engine ({type(e).__name__}).")
            return
        try:
            ww.start_listening(self._on_wake, owner=self.owner,
                               config=engine_config(phrase, sensitivity, input_device), external_audio=False)
        except Exception as e:
            if type(e).__name__ == "WakeWordInUse":
                msg = ("The microphone's wake-word listener is already in use, most likely by Hermes' own "
                       "wake word. Turn that off (wake_word.enabled: false) so this plugin can listen.")
            else:
                msg = f"The wake word could not start: {str(e)[:200] or type(e).__name__}"
            logger.warning("gemini-live-chat: wake word not armed: %s", msg)
            self._fail(gen, "error", msg)
            return
        with self._lock:
            if gen != self._gen:  # disarmed while the engine was building
                stale = True
            else:
                stale = False
                self.state = "listening"
        if stale:
            self._stop_engine(ww)
            return
        logger.info("gemini-live-chat: wake word listening for %r", phrase)

    def _fail(self, gen: int, state: str, msg: str) -> None:
        with self._lock:
            if gen == self._gen:
                self.state, self.error = state, msg

    def _stop_engine(self, ww: Any) -> None:
        try:
            ww.stop_listening(owner=self.owner)
        except Exception:
            logger.debug("gemini-live-chat: wake stop failed", exc_info=True)

    def disarm(self) -> Dict[str, Any]:
        with self._lock:
            self._gen += 1
            was = self.state
            self.state, self.error, self._key, self._token = "off", "", None, None
        if was in ("listening", "paused", "arming"):
            try:
                self._stop_engine(self._load())
            except Exception:
                pass
        return self.status()

    # ── detection → claim ───────────────────────────────────────────────────────────────────────

    def _on_wake(self) -> None:
        """Detector thread: free the microphone, then tell the windows (the call opens its own mic)."""
        try:
            ww = self._load()
            if not ww.pause_listening(owner=self.owner):
                return
        except Exception:
            logger.debug("gemini-live-chat: wake pause failed", exc_info=True)
            return
        token = secrets.token_hex(8)
        with self._lock:
            self.state = "paused"
            self._token, self._token_at = token, self._clock()
            self.detections += 1
            gen = self._gen
            phrase = self.phrase
        logger.info("gemini-live-chat: wake word heard; offering the call to the open windows")
        try:
            self._broadcast(EVENT, {"token": token, "phrase": phrase})
        except Exception:
            logger.warning("gemini-live-chat: wake event not delivered", exc_info=True)
        self._spawn(lambda: self._claim_watchdog(gen, token), "glc-wake-claim")

    def _claim_watchdog(self, gen: int, token: str) -> None:
        self._sleep(CLAIM_TIMEOUT_S)
        with self._lock:
            unclaimed = gen == self._gen and self._token == token
            if unclaimed:
                self._token = None
        if unclaimed:  # no window took the call (none open, or none eligible): listen again
            logger.info("gemini-live-chat: wake not claimed by any window; listening again")
            self.resume()

    def claim(self, token: Any) -> bool:
        with self._lock:
            ok = (isinstance(token, str) and self._token is not None and secrets.compare_digest(token, self._token)
                  and self._clock() - self._token_at <= CLAIM_TIMEOUT_S)
            if ok:
                self._token = None
            return ok

    # ── the call's microphone hand-off ──────────────────────────────────────────────────────────

    def pause(self) -> bool:
        """Release the mic before a call opens its own (no-op when not armed). True when the detector
        is ours and is now paused, so the caller knows to resume it after the call."""
        with self._lock:
            if self.state not in ("listening", "paused"):
                return False
            self._token = None
        try:
            ok = bool(self._load().pause_listening(owner=self.owner))
        except Exception:
            return False
        if ok:
            with self._lock:
                if self.state == "listening":
                    self.state = "paused"
        return ok

    def resume(self) -> bool:
        """Re-arm after a hang-up. The browser may hold the device for a moment after its tracks
        stop, so the reopen is retried on a worker thread. False when there is nothing to resume."""
        with self._lock:
            if self.state != "paused":
                return False
            gen = self._gen
        self._spawn(lambda: self._resume_worker(gen), "glc-wake-resume")
        return True

    def _resume_worker(self, gen: int) -> None:
        last = ""
        for delay in RESUME_DELAYS_S:
            self._sleep(delay)
            with self._lock:
                if gen != self._gen or self.state != "paused" or self._token is not None:
                    return  # disarmed, already resumed, or a new detection is being claimed
            try:
                if self._load().resume_listening(owner=self.owner):
                    with self._lock:
                        if gen == self._gen and self.state == "paused":
                            self.state, self.error = "listening", ""
                    return
                last = "the listener is no longer ours"
                break
            except Exception as e:
                last = str(e)[:200] or type(e).__name__
        with self._lock:
            if gen == self._gen and self.state == "paused":
                self.state = "error"
                self.error = f"The wake word could not re-open the microphone: {last}. Reload the plugin to retry."
        logger.warning("gemini-live-chat: wake word not resumed after the call: %s", last)

    def _status_locked(self) -> Dict[str, Any]:
        return {"state": self.state, "phrase": self.phrase, "error": self.error, "detections": self.detections}


_MANAGER: Optional[WakeManager] = None
_MANAGER_LOCK = threading.Lock()


def manager() -> WakeManager:
    """The process-wide manager. Kept in this package module (cached in ``sys.modules``), so a reload
    of ``dashboard/plugin_api.py`` finds the same detector lease instead of an orphaned one."""
    global _MANAGER
    with _MANAGER_LOCK:
        if _MANAGER is None:
            _MANAGER = WakeManager()
        return _MANAGER
