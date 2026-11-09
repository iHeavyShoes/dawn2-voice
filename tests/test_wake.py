"""v0.7: the plugin's own wake word (dawn2_voice/wake.py) and its /wake/* routes.

The engine (Hermes core's ``tools.wake_word``) is replaced by a fake with the same four calls, so the
state machine, the microphone hand-off, the claim and the re-arm retries are tested without audio.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dawn2_voice import live, wake  # noqa: E402


class WakeWordInUse(RuntimeError):
    pass


class FakeEngine:
    """The ``tools.wake_word`` surface wake.py uses: start/pause/resume/stop_listening(owner=...)."""

    def __init__(self):
        self.owner = None
        self.on_wake = None
        self.config = None
        self.paused = False
        self.calls = []
        self.start_error = None
        self.resume_failures = 0

    def start_listening(self, on_wake, *, owner, config=None, external_audio=False):
        self.calls.append(("start", external_audio))
        if self.start_error:
            raise self.start_error
        if self.owner is not None and self.owner is not owner:
            raise WakeWordInUse("Wake-word microphone is already owned.")
        self.owner, self.on_wake, self.config, self.paused = owner, on_wake, config, False

    def pause_listening(self, *, owner):
        self.calls.append(("pause",))
        if owner is not self.owner:
            return False
        self.paused = True
        return True

    def resume_listening(self, *, owner):
        self.calls.append(("resume",))
        if owner is not self.owner:
            return False
        if self.resume_failures:
            self.resume_failures -= 1
            raise OSError("device busy")
        self.paused = False
        return True

    def stop_listening(self, *, owner):
        self.calls.append(("stop",))
        if owner is not self.owner:
            return False
        self.owner = None
        return True

    def say_phrase(self):
        """The detector thread fires (the real one calls on_wake from its own thread)."""
        self.on_wake()


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def rig():
    engine = FakeEngine()
    events, sleeps, clock = [], [], Clock()
    pending = []  # spawned workers, run on demand (deterministic threads)

    def spawn(fn, name):
        pending.append((name, fn))

    def run(name_prefix=None):
        while True:
            idx = next((i for i, (n, _) in enumerate(pending) if name_prefix is None or n.startswith(name_prefix)), None)
            if idx is None:
                return
            pending.pop(idx)[1]()

    m = wake.WakeManager(load=lambda: engine, broadcast=lambda e, p: events.append((e, p)),
                         spawn=spawn, sleep=sleeps.append, clock=clock)
    return types.SimpleNamespace(m=m, engine=engine, events=events, sleeps=sleeps, clock=clock, pending=pending, run=run)


def armed(rig, phrase="hey ray"):
    rig.m.arm(phrase, 0.5)
    rig.run("d2v-wake-arm")
    assert rig.m.status()["state"] == "listening"


# ── phrases ─────────────────────────────────────────────────────────────────────────────────────

def test_phrase_is_english_letters_only_and_normalized():
    assert wake.clean_phrase("  Hey   Ray ") == "hey ray"
    assert wake.clean_phrase("ok computer") == "ok computer"
    for bad in ("היי ריי", "hey ray 2", "", "a", "hey-ray!", None, 7, "x" * 60):
        assert wake.clean_phrase(bad) is None, bad


def test_default_phrase_is_hey_persona_name():
    assert wake.default_phrase("Ray") == "hey ray"
    assert wake.default_phrase("ריי") == "hey hermes"  # not spottable: the safe default
    assert wake.default_phrase(None) == "hey hermes"


def test_settings_wake_keys_default_off_and_validate():
    cfg = live.settings(None)
    assert cfg["wake_word"] is False and cfg["wake_phrase"] == "" and cfg["wake_surface"] == "desktop"
    assert cfg["wake_sensitivity"] == 0.5
    cfg = live.settings({"wake_word": True, "wake_phrase": "Hey Ray", "wake_sensitivity": 0.7, "wake_surface": "any"})
    assert (cfg["wake_word"], cfg["wake_phrase"], cfg["wake_sensitivity"], cfg["wake_surface"]) == (True, "hey ray", 0.7, "any")
    cfg = live.settings({"wake_word": "true", "wake_phrase": "היי ריי", "wake_sensitivity": 9, "wake_surface": "phone"})
    assert cfg["wake_word"] is True and cfg["wake_phrase"] == "" and cfg["wake_sensitivity"] == 0.5
    assert cfg["wake_surface"] == "desktop"
    assert any("wake_phrase" in p for p in cfg["problems"])


def test_effective_phrase_comes_from_the_persona(tmp_path):
    cfg = live.resolve_persona(live.settings({"wake_word": True}), "You are Ray (in Hebrew exactly ריי), the orchestrator.")
    assert live.effective_wake_phrase(cfg) == "hey ray"
    out = live.client_settings(cfg)
    assert out["wake_word"] is True and out["wake_phrase"] == "hey ray"
    assert "wake_phrase" not in live.client_settings(live.resolve_persona(live.settings(None), ""))


# ── arm / disarm ────────────────────────────────────────────────────────────────────────────────

def test_arm_builds_core_engine_with_the_plugin_phrase_and_local_capture(rig):
    st = rig.m.arm("hey ray", 0.5)
    assert st["state"] == "arming", "the engine is built off the request thread"
    assert rig.engine.calls == []
    rig.run()
    assert rig.m.status()["state"] == "listening"
    assert rig.engine.config == {"enabled": True, "provider": "sherpa", "phrase": "hey ray", "sensitivity": 0.5,
                                 "input_device": None, "capture": "local", "profile_routing": False,
                                 "sherpa": {"model_dir": ""}}
    assert rig.engine.calls == [("start", False)]


def test_arm_is_idempotent_and_a_new_phrase_rebuilds(rig):
    armed(rig)
    rig.m.arm("hey ray", 0.5)
    assert rig.pending == [], "same settings: nothing rebuilt"
    rig.m.arm("ok ray", 0.5)
    rig.run()
    assert rig.engine.config["phrase"] == "ok ray"
    assert ("stop",) in rig.engine.calls


def test_core_wake_word_on_means_in_use_and_a_clear_message(rig):
    rig.engine.start_error = WakeWordInUse("Wake-word microphone is already owned.")
    rig.m.arm("hey ray")
    rig.run()
    st = rig.m.status()
    assert st["state"] == "error"
    assert "wake_word.enabled: false" in st["error"]


def test_no_engine_in_this_hermes_is_unsupported():
    def load():
        raise ImportError("no tools.wake_word")
    m = wake.WakeManager(load=load, broadcast=lambda *a: None, spawn=lambda fn, n: fn(), sleep=lambda s: None)
    m.arm("hey ray")
    assert m.status()["state"] == "unsupported"


def test_disarm_while_building_stops_the_fresh_engine(rig):
    rig.m.arm("hey ray")
    rig.m.disarm()
    rig.run()
    assert rig.m.status()["state"] == "off"
    assert rig.engine.owner is None, "the late engine was stopped, not leaked"


# ── detection → claim ───────────────────────────────────────────────────────────────────────────

def test_detection_releases_the_mic_before_telling_the_windows(rig):
    armed(rig)
    rig.engine.say_phrase()
    assert rig.engine.paused is True
    assert rig.engine.calls.index(("pause",)) < len(rig.engine.calls)
    assert len(rig.events) == 1
    name, payload = rig.events[0]
    assert name == "wake.detected" and payload["phrase"] == "hey ray" and len(payload["token"]) == 16
    assert rig.m.status() == {"state": "paused", "phrase": "hey ray", "error": "", "detections": 1}


def test_first_claim_wins_and_a_replay_or_wrong_token_loses(rig):
    armed(rig)
    rig.engine.say_phrase()
    token = rig.events[0][1]["token"]
    assert rig.m.claim("wrong") is False
    assert rig.m.claim(token) is True
    assert rig.m.claim(token) is False, "a second window gets nothing"
    assert rig.m.claim(None) is False


def test_expired_claim_is_refused(rig):
    armed(rig)
    rig.engine.say_phrase()
    token = rig.events[0][1]["token"]
    rig.clock.t += wake.CLAIM_TIMEOUT_S + 1
    assert rig.m.claim(token) is False


def test_unclaimed_detection_re_arms_after_the_timeout(rig):
    armed(rig)
    rig.engine.say_phrase()
    rig.run("d2v-wake-claim")
    assert wake.CLAIM_TIMEOUT_S in rig.sleeps
    rig.run("d2v-wake-resume")
    assert rig.m.status()["state"] == "listening"
    assert rig.engine.paused is False


def test_claimed_detection_is_not_re_armed_by_the_watchdog(rig):
    armed(rig)
    rig.engine.say_phrase()
    assert rig.m.claim(rig.events[0][1]["token"])
    rig.run("d2v-wake-claim")
    assert not any(n.startswith("d2v-wake-resume") for n, _ in rig.pending)
    assert rig.m.status()["state"] == "paused", "the call holds the mic until it hangs up"


# ── the call's microphone hand-off ──────────────────────────────────────────────────────────────

def test_pause_then_resume_around_a_button_call(rig):
    armed(rig)
    assert rig.m.pause() is True
    assert rig.engine.paused is True and rig.m.status()["state"] == "paused"
    assert rig.m.resume() is True
    rig.run()
    assert rig.engine.paused is False and rig.m.status()["state"] == "listening"


def test_pause_and_resume_are_no_ops_when_not_armed(rig):
    assert rig.m.pause() is False
    assert rig.m.resume() is False
    assert rig.engine.calls == []


def test_resume_retries_while_the_browser_still_holds_the_device(rig):
    armed(rig)
    rig.m.pause()
    rig.engine.resume_failures = 2
    rig.m.resume()
    rig.run()
    assert rig.m.status()["state"] == "listening"
    assert rig.engine.calls.count(("resume",)) == 3
    assert rig.sleeps[:3] == list(wake.RESUME_DELAYS_S[:3])


def test_resume_gives_up_with_a_visible_error(rig):
    armed(rig)
    rig.m.pause()
    rig.engine.resume_failures = 99
    rig.m.resume()
    rig.run()
    st = rig.m.status()
    assert st["state"] == "error" and "device busy" in st["error"]


def test_resume_after_disarm_does_nothing(rig):
    armed(rig)
    rig.m.pause()
    rig.m.resume()
    rig.m.disarm()
    rig.run()
    assert ("resume",) not in rig.engine.calls


def test_manager_is_one_per_process():
    assert wake.manager() is wake.manager()


# ── routes ──────────────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def api(monkeypatch, rig):
    spec = importlib.util.spec_from_file_location("d2v_plugin_api_wake", ROOT / "dashboard" / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    settings = {"wake_word": True}
    monkeypatch.setattr(mod, "_settings", lambda: live.resolve_persona(live.settings(settings), "You are Ray, the orchestrator."))
    monkeypatch.setattr(mod.wake, "manager", lambda: rig.m)
    app = FastAPI()
    app.include_router(mod.router, prefix="/p")
    c = TestClient(app)
    c.settings, c.rig = settings, rig
    return c


def test_route_arm_listens_with_hey_persona_and_reports_state(api):
    r = api.post("/p/wake/arm").json()
    assert r["enabled"] is True and r["phrase"] == "hey ray" and r["surface"] == "desktop"
    api.rig.run()
    assert api.get("/p/wake").json()["state"] == "listening"


def test_route_arm_with_the_setting_off_disarms(api):
    api.post("/p/wake/arm")
    api.rig.run()
    api.settings["wake_word"] = False
    r = api.post("/p/wake/arm").json()
    assert r["enabled"] is False and r["state"] == "off"
    assert api.rig.engine.owner is None


def test_route_claim_pause_resume(api):
    api.post("/p/wake/arm")
    api.rig.run()
    api.rig.engine.say_phrase()
    token = api.rig.events[0][1]["token"]
    assert api.post("/p/wake/claim", json={"token": "nope"}).json() == {"claimed": False}
    assert api.post("/p/wake/claim", json={"token": token}).json() == {"claimed": True}
    assert api.post("/p/wake/resume").json() == {"resuming": True}
    api.rig.run("d2v-wake-resume")
    assert api.post("/p/wake/pause").json() == {"paused": True}
    assert api.post("/p/wake/claim").json() == {"claimed": False}
