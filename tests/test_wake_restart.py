"""v0.8: the wake word survives a gateway restart.

A restart is simulated as a NEW process: a fresh ``WakeManager`` (the old detector and its engine
lease are gone) and a fresh import of ``dashboard/plugin_api.py`` (what the gateway's route mount
does). The backend must arm on its own, without any renderer call, once per process, and respect
the setting, the one-mic rule (core's wake word on) and an active call.
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
from tests.test_wake import FakeEngine, rig as _rig  # noqa: E402,F401

rig = _rig


# ── WakeManager.auto_arm ────────────────────────────────────────────────────────────────────────

def test_auto_arm_starts_the_detector_without_a_window(rig):
    s = rig.m.auto_arm("hey ray", 0.5)
    assert s["state"] == "arming"
    rig.run("d2v-wake-arm")
    assert rig.m.status()["state"] == "listening"
    assert rig.engine.owner is rig.m.owner and rig.engine.config["phrase"] == "hey ray"


def test_auto_arm_is_idempotent_once_per_process(rig):
    rig.m.auto_arm("hey ray", 0.5)
    rig.run()
    starts = [c for c in rig.engine.calls if c[0] == "start"]
    rig.m.auto_arm("hey ray", 0.5)
    rig.m.auto_arm("hey other", 0.9)  # never rebuilds: only /wake/arm applies setting changes
    rig.run()
    assert [c for c in rig.engine.calls if c[0] == "start"] == starts
    assert rig.m.status()["phrase"] == "hey ray"


def test_auto_arm_leaves_a_window_armed_or_paused_detector_alone(rig):
    rig.m.arm("hey ray", 0.5)
    rig.run()
    assert rig.m.pause() is True  # a call holds the mic
    calls = list(rig.engine.calls)
    s = rig.m.auto_arm("hey ray", 0.5)
    assert s["state"] == "paused" and rig.engine.calls == calls and rig.pending == []


def test_auto_arm_with_core_wake_on_never_touches_the_mic(rig):
    s = rig.m.auto_arm("hey ray", 0.5, core_wake_on=True)
    assert s["state"] == "error" and "wake_word.enabled" in s["error"]
    assert rig.engine.calls == [] and rig.pending == []


def test_restart_new_process_detector_gone_then_re_armed():
    """Process 1 listens; the gateway restarts (process 1 and its lease are gone); process 2 arms
    by itself at route mount, with no renderer call."""
    engine = FakeEngine()
    run_now = lambda fn, name: fn()  # noqa: E731

    def process():
        return wake.WakeManager(load=lambda: engine, broadcast=lambda e, p: None, spawn=run_now,
                                sleep=lambda s: None)

    first = process()
    first.auto_arm("hey ray", 0.5)
    assert first.status()["state"] == "listening" and engine.owner is first.owner
    engine.owner = None  # the process died: its mic stream and machine lock went with it
    second = process()  # the new gateway: nothing armed it yet
    assert second.status()["state"] == "off"
    second.auto_arm("hey ray", 0.5)
    assert second.status()["state"] == "listening" and engine.owner is second.owner


# ── the route module: mount (import) and lazy-on-first-route ────────────────────────────────────

def _import_api(monkeypatch, *, in_hermes: bool, settings: dict, core_on: bool, manager):
    """Import plugin_api.py the way the gateway mounts it, with Hermes' config faked."""
    if in_hermes:
        cli = types.ModuleType("hermes_cli")
        cfg = types.ModuleType("hermes_cli.config")
        cfg.load_config_readonly = lambda: {
            "wake_word": {"enabled": core_on},
            "plugins": {"entries": {"dawn2-voice": {"settings": settings}}},
        }
        cli.config = cfg
        monkeypatch.setitem(sys.modules, "hermes_cli", cli)
        monkeypatch.setitem(sys.modules, "hermes_cli.config", cfg)
    monkeypatch.setattr(wake, "manager", lambda: manager)
    spawned = []
    monkeypatch.setattr(wake, "_spawn", lambda fn, name: spawned.append(name) or fn())
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_dawn2_voice_t", ROOT / "dashboard" / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, spawned


def _manager(engine):
    return wake.WakeManager(load=lambda: engine, broadcast=lambda e, p: None, spawn=lambda fn, name: fn(),
                            sleep=lambda s: None)


def test_route_mount_arms_when_the_setting_is_on(monkeypatch):
    engine = FakeEngine()
    m = _manager(engine)
    _, spawned = _import_api(monkeypatch, in_hermes=True, settings={"wake_word": True}, core_on=False, manager=m)
    assert "d2v-wake-auto-arm" in spawned
    assert m.status()["state"] == "listening" and engine.config["phrase"] == "hey hermes"


def test_route_mount_does_nothing_when_the_setting_is_off(monkeypatch):
    engine = FakeEngine()
    m = _manager(engine)
    _import_api(monkeypatch, in_hermes=True, settings={"wake_word": False}, core_on=False, manager=m)
    assert m.status()["state"] == "off" and engine.calls == [] and m.auto_armed is False


def test_route_mount_respects_core_wake_on(monkeypatch):
    engine = FakeEngine()
    m = _manager(engine)
    _import_api(monkeypatch, in_hermes=True, settings={"wake_word": True}, core_on=True, manager=m)
    assert m.status()["state"] == "error" and engine.calls == []


def test_outside_hermes_import_has_no_side_effect(monkeypatch):
    engine = FakeEngine()
    m = _manager(engine)
    monkeypatch.setitem(sys.modules, "hermes_cli", None)  # import fails -> not in Hermes
    monkeypatch.setitem(sys.modules, "hermes_cli.config", None)
    _, spawned = _import_api(monkeypatch, in_hermes=False, settings={}, core_on=False, manager=m)
    assert spawned == [] and engine.calls == []


def test_lazy_first_route_arms_after_the_setting_turns_on(monkeypatch):
    """Plugin-host isolation or a setting turned on later: the first /status or /wake request arms."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    engine = FakeEngine()
    m = _manager(engine)
    settings = {"wake_word": False}
    mod, _ = _import_api(monkeypatch, in_hermes=True, settings=settings, core_on=False, manager=m)
    monkeypatch.setattr(mod, "_settings", lambda: live.resolve_persona(live.settings(settings), "You are Ray."))
    app = FastAPI()
    app.include_router(mod.router, prefix="/p")
    c = TestClient(app)
    assert c.get("/p/wake").json()["state"] == "off"
    settings["wake_word"] = True
    assert c.get("/p/wake").json()["state"] == "listening"
    assert engine.config["phrase"] == "hey ray"
    starts = len([x for x in engine.calls if x[0] == "start"])
    c.get("/p/wake")
    c.get("/p/status")
    assert len([x for x in engine.calls if x[0] == "start"]) == starts, "once per process"


def test_wake_arm_route_refuses_when_core_wake_is_on(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    engine = FakeEngine()
    m = _manager(engine)
    mod, _ = _import_api(monkeypatch, in_hermes=True, settings={"wake_word": False}, core_on=True, manager=m)
    monkeypatch.setattr(mod, "_settings", lambda: live.resolve_persona(live.settings({"wake_word": True}), None))
    app = FastAPI()
    app.include_router(mod.router, prefix="/p")
    r = TestClient(app).post("/p/wake/arm").json()
    assert r["state"] == "error" and "wake_word.enabled" in r["error"] and engine.calls == []
