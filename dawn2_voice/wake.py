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
   ``plugin.dawn2-voice.wake.detected {token, phrase}`` goes to every connected window.
3. ``claim(token)``: the first eligible window (the Desktop app) to claim the token starts the call;
   every other window gets ``False``. Unclaimed after ``CLAIM_TIMEOUT_S``: the detector re-arms.
4. ``pause()`` before a call started from the button; ``resume()`` after every hang-up, retrying
   while the browser still holds the device.

Mic loss (v0.9): core tears the detector down by itself when the microphone dies for good (muted,
unplugged, taken by another app: ``_detector_failed``) and never tells this module. ``state`` therefore
is not trusted while it says ``listening``: ``status()`` / ``arm()`` / ``auto_arm()`` / ``recover()``
first compare it with core (``owns_listener`` + ``is_listening``). A dead detector becomes ``error``
and the next ``arm`` rebuilds ONLY the listener through ``start_listening``, throttled
(``REARM_MIN_INTERVAL_S``), one log line per distinct failure. Nothing in this module restarts the
gateway or the Desktop app, or touches a call: a ``paused`` detector (a call holds the mic) is never
rebuilt by a status check.

Nothing here touches ``config.yaml``, and the detector never runs unless the plugin's ``wake_word``
setting is on and a window asked for it.
"""

from __future__ import annotations

import logging
import re
import secrets
import sys
import threading
import time
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("dawn2-voice")

EVENT = "wake.detected"
CLAIM_TIMEOUT_S = 15.0
RESUME_DELAYS_S = (0.3, 0.7, 1.5, 3.0, 6.0)
#: v0.9: min gap between two rebuild attempts of the same settings after a failure (mic still missing):
#: the renderer polls every 45 s, this keeps a faster caller from hammering the engine build.
REARM_MIN_INTERVAL_S = 15.0
DEFAULT_SENSITIVITY = 0.5
#: sherpa's keyword model is English (BPE vocabulary): a phrase must be Latin letters.
PHRASE_RE = re.compile(r"^[a-z][a-z' ]{1,38}[a-z]$")
STATES = ("off", "arming", "listening", "paused", "error", "unsupported", "non_owner")
MIC_LOST_MESSAGE = ("The wake word's microphone stopped (muted, unplugged or taken by another app). "
                    "Re-arming automatically.")
CORE_WAKE_ON_MESSAGE = ("Hermes' own wake word is on (wake_word.enabled: true) and holds the microphone. "
                        "Turn it off so this plugin can listen.")


NON_OWNER_MESSAGE = ("Wake word is owned by the gateway process. This dashboard/CLI process does not "
                     "open the microphone; use the gateway-connected Desktop for wake calls.")
IN_USE_MESSAGE = ("The wake-word microphone lease is held by another Hermes listener (in this or "
                  "another Hermes process). This plugin cannot identify the holder; "
                  "check for another running gateway or dashboard listener.")


def is_gateway_process() -> bool:
    """Fail closed on the actual command, not an inherited environment or config import.

    sys.argv[0] covers console-script and python -m launchers alike. Consume only
    Hermes' profile selector before the command; never search arbitrary argument
    values for 'gateway run' (a dashboard/CLI argument could contain those words).
    Unknown wrappers/commands must not acquire the machine-wide microphone lease.
    """
    args = sys.argv[1:]
    while args:
        if args[0] in ("-p", "--profile"):
            if len(args) < 2:
                return False
            args = args[2:]
        elif args[0].startswith("--profile=") or (args[0].startswith("-p") and len(args[0]) > 2):
            args = args[1:]
        else:
            break
    return args[:2] == ["gateway", "run"]


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
    broadcast_plugin_event("dawn2-voice", event, payload)


def _spawn(fn: Callable[[], None], name: str) -> None:
    threading.Thread(target=fn, daemon=True, name=name).start()


class WakeManager:
    """State machine around one detector. Every public method is safe from any thread."""

    def __init__(self, load: Callable[[], Any] = _load_engine_module,
                 broadcast: Callable[[str, Dict[str, Any]], None] = _broadcast,
                 spawn: Callable[[Callable[[], None], str], None] = _spawn,
                 sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic,
                 gateway_process: Optional[bool] = None) -> None:
        self._load, self._broadcast, self._spawn, self._sleep, self._clock = load, broadcast, spawn, sleep, clock
        self._lock = threading.Lock()
        self.gateway_process = is_gateway_process() if gateway_process is None else gateway_process
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
        self._last_attempt: Optional[float] = None  # clock() of the last rebuild attempt
        self._last_warned = ""  # the last arm failure that was logged at WARNING (no log spam)
        self._handoff = 0  # pause_listening calls in flight (state lags core's by a moment)

    # ── v0.8: arm without a window (gateway restart) ────────────────────────────────────────────

    def auto_arm(self, phrase: str, sensitivity: float = DEFAULT_SENSITIVITY,
                 core_wake_on: bool = False, reason: str = "startup") -> Dict[str, Any]:
        """Arm once per process without waiting for a renderer: the gateway restarted, the old
        detector died with it, and an already-loaded window will not call ``/wake/arm`` again.

        Never disarms (only the explicit ``/wake/arm`` route does). Idempotent: a detector that is
        already arming, listening or paused (a call holds the mic) is left alone. When Hermes' own
        wake word is on, the microphone is not touched at all (one mic lease per machine)."""
        if not self.gateway_process:
            return self.status()
        self._reconcile()
        with self._lock:
            if self.auto_armed and not self._lost_locked():
                return self._status_locked()  # v0.9: a lost listener is rebuilt, not skipped
            self.auto_armed = True
            busy = self.state in ("arming", "listening", "paused")
        if busy:
            return self.status()
        if core_wake_on:
            self.refuse(CORE_WAKE_ON_MESSAGE)
            logger.warning("dawn2-voice: wake word not armed (%s): %s", reason, CORE_WAKE_ON_MESSAGE)
            return self.status()
        logger.info("dawn2-voice: arming the wake word on %s", reason)
        return self.arm(phrase, sensitivity)

    def refuse(self, msg: str) -> Dict[str, Any]:
        """Report why the detector is not armed without touching the engine. An active detector is
        left running (it already holds the lease)."""
        self._reconcile()
        with self._lock:
            if self.state not in ("arming", "listening", "paused"):
                self._gen += 1
                self.state, self.error, self._key, self._token = "error", msg, None, None
            return self._status_locked()

    # ── status ──────────────────────────────────────────────────────────────────────────────────

    def status(self) -> Dict[str, Any]:
        self._reconcile()  # v0.9: report what core really has, not what this module last set
        with self._lock:
            return self._status_locked()

    def _core_alive(self) -> Optional[bool]:
        """True: core's detector is ours and running. False: gone or not ours. None: cannot tell (a
        core without these two calls): the recorded state is then trusted, as before v0.9."""
        try:
            ww = self._load()
            owns, running = getattr(ww, "owns_listener", None), getattr(ww, "is_listening", None)
            if owns is None or running is None:
                return None
            return bool(owns(self.owner)) and bool(running())
        except Exception:
            return None

    def _reconcile(self) -> None:
        """``listening`` but core's detector is gone (mic lost: core's ``_detector_failed`` released the
        lease and told nobody) -> ``error`` (``MIC_LOST_MESSAGE``). ``paused`` is never touched: a call (or a
        claimed wake) holds the mic on purpose, and ``resume`` deals with a lease lost meanwhile.
        ``arming`` belongs to its worker. Never calls core while holding ``self._lock``."""
        with self._lock:
            if self.state != "listening" or self._handoff:
                return
            gen = self._gen
        if self._core_alive() is not False:
            return
        with self._lock:
            if gen != self._gen or self.state != "listening" or self._handoff:
                return  # something moved while core was asked
            self._gen += 1  # a stale resume worker / claim watchdog backs out
            self._token = None
            self.state, self.error, self._last_attempt = "error", MIC_LOST_MESSAGE, None  # first rebuild is immediate
        logger.warning("dawn2-voice: wake word listener is gone (microphone lost); re-arming on the next check")

    def _lost_locked(self) -> bool:
        """The listener was just found dead (``MIC_LOST_MESSAGE``) and no rebuild has been tried yet."""
        return self.state == "error" and self.error == MIC_LOST_MESSAGE

    def recover(self, phrase: str, sensitivity: float = DEFAULT_SENSITIVITY) -> Dict[str, Any]:
        """The status route's hook: right after a mic loss is found, rebuild the listener once. A failed
        rebuild stays an ``error`` (clear message) that the renderer's next ``/wake/arm`` retries, so the
        status never hides the failure behind ``arming``."""
        self._reconcile()
        with self._lock:
            lost = self._lost_locked()
        return self.arm(phrase, sensitivity) if lost else self.status()

    # ── arm / disarm ────────────────────────────────────────────────────────────────────────────

    def arm(self, phrase: str, sensitivity: float = DEFAULT_SENSITIVITY, input_device: Any = None) -> Dict[str, Any]:
        if not self.gateway_process:
            return self.status()
        key = (phrase, float(sensitivity), input_device)
        self._reconcile()  # v0.9: "listening" only counts while core's detector is really alive and ours
        with self._lock:
            if self._key == key and self.state in ("arming", "listening", "paused"):
                return self._status_locked()
            if (self._key == key and self.state == "error" and self._last_attempt is not None
                    and self._clock() - self._last_attempt < REARM_MIN_INTERVAL_S):
                return self._status_locked()  # just failed: report it, retry on a later call
        if self._key is not None and self._key != key:
            self.disarm()  # settings changed: rebuild the engine with the new phrase
        with self._lock:
            self._gen += 1
            gen = self._gen
            self._key, self.phrase, self.state, self.error = key, phrase, "arming", ""
            self._last_attempt = self._clock()
        self._spawn(lambda: self._arm_worker(gen, key), "d2v-wake-arm")
        return self.status()

    def _arm_worker(self, gen: int, key: tuple) -> None:
        if not self.gateway_process:
            return
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
                msg = IN_USE_MESSAGE
            else:
                detail = str(e.__cause__ or e)[:200] or type(e).__name__
                msg = (f"The wake word could not start: {detail}. "
                       "It retries automatically (the microphone may be muted or missing).")
            # one WARNING per distinct failure: a retry every poll must not fill the log
            (logger.debug if msg == self._last_warned else logger.warning)("dawn2-voice: wake word not armed: %s", msg)
            self._last_warned = msg
            self._fail(gen, "error", msg)
            return
        with self._lock:
            if gen != self._gen:  # disarmed while the engine was building
                stale = True
            else:
                stale = False
                self.state, self._last_warned = "listening", ""
        if stale:
            self._stop_engine(ww)
            return
        logger.info("dawn2-voice: wake word listening for %r", phrase)

    def _fail(self, gen: int, state: str, msg: str) -> None:
        with self._lock:
            if gen == self._gen:
                self.state, self.error = state, msg

    def _stop_engine(self, ww: Any) -> None:
        try:
            ww.stop_listening(owner=self.owner)
        except Exception:
            logger.debug("dawn2-voice: wake stop failed", exc_info=True)

    def disarm(self) -> Dict[str, Any]:
        with self._lock:
            self._gen += 1
            was = self.state
            self.state, self.error, self._key, self._token = "off", "", None, None
            self._last_attempt, self._last_warned = None, ""
        if was in ("listening", "paused", "arming"):
            try:
                self._stop_engine(self._load())
            except Exception:
                pass
        return self.status()

    # ── detection → claim ───────────────────────────────────────────────────────────────────────

    def _on_wake(self) -> None:
        """Detector thread: free the microphone, then tell the windows (the call opens its own mic)."""
        with self._lock:
            self._handoff += 1  # core's detector is about to stop on purpose: not a mic loss
        try:
            try:
                ww = self._load()
                if not ww.pause_listening(owner=self.owner):
                    return
            except Exception:
                logger.debug("dawn2-voice: wake pause failed", exc_info=True)
                return
            token = secrets.token_hex(8)
            with self._lock:
                self.state = "paused"
                self._token, self._token_at = token, self._clock()
                self.detections += 1
                gen = self._gen
                phrase = self.phrase
        finally:
            with self._lock:
                self._handoff -= 1
        logger.info("dawn2-voice: wake word heard; offering the call to the open windows")
        try:
            self._broadcast(EVENT, {"token": token, "phrase": phrase})
        except Exception:
            logger.warning("dawn2-voice: wake event not delivered", exc_info=True)
        self._spawn(lambda: self._claim_watchdog(gen, token), "d2v-wake-claim")

    def _claim_watchdog(self, gen: int, token: str) -> None:
        self._sleep(CLAIM_TIMEOUT_S)
        with self._lock:
            unclaimed = gen == self._gen and self._token == token
            if unclaimed:
                self._token = None
        if unclaimed:  # no window took the call (none open, or none eligible): listen again
            logger.info("dawn2-voice: wake not claimed by any window; listening again")
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
        self._reconcile()  # a dead listener is not "ours and paused": nothing to hand back later
        with self._lock:
            if self.state not in ("listening", "paused"):
                return False
            self._token = None
            self._handoff += 1
        try:
            try:
                ok = bool(self._load().pause_listening(owner=self.owner))
            except Exception:
                return False
            if ok:
                with self._lock:
                    if self.state == "listening":
                        self.state = "paused"
            return ok
        finally:
            with self._lock:
                self._handoff -= 1

    def resume(self) -> bool:
        """Re-arm after a hang-up. The browser may hold the device for a moment after its tracks
        stop, so the reopen is retried on a worker thread. False when there is nothing to resume."""
        with self._lock:
            if self.state != "paused":
                return False
            gen = self._gen
        self._spawn(lambda: self._resume_worker(gen), "d2v-wake-resume")
        return True

    def _resume_worker(self, gen: int) -> None:
        if not self.gateway_process:
            return
        last, lost = "", False
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
                last, lost = "the listener is no longer ours", True
                break
            except Exception as e:
                last = str(e)[:200] or type(e).__name__
        if lost:
            # core dropped the detector while it was paused (e.g. the mic vanished during the call). The call
            # is over (this is the hang-up resume), so rebuild ONLY the listener, right here.
            with self._lock:
                if gen != self._gen or self.state != "paused" or self._key is None:
                    return
                key = self._key
                self.state, self.error, self._last_attempt = "arming", "", self._clock()
            logger.info("dawn2-voice: wake word listener was dropped during the call; rebuilding it")
            self._arm_worker(gen, key)
            return
        with self._lock:
            if gen == self._gen and self.state == "paused":
                self.state = "error"
                # transient (browser still holds the device): the renderer's next /wake/arm resumes again
                self.error = f"The wake word could not re-open the microphone: {last}. Retrying automatically."
        logger.warning("dawn2-voice: wake word not resumed after the call: %s", last)

    def _status_locked(self) -> Dict[str, Any]:
        if not self.gateway_process:
            return {"state": "non_owner", "phrase": self.phrase, "error": NON_OWNER_MESSAGE,
                    "detections": self.detections}
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
