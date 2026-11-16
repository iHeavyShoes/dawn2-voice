"""v0.9: the wake word comes back after core tore the detector down (microphone lost).

Core's ``_detector_failed`` drops the detector and releases the lease when the mic dies for good
(``MME error 6`` -> ``microphone recovery exhausted``) and never tells ``WakeManager``. These tests
simulate that with ``FakeEngine.lose_mic()`` and check that ONLY the listener is rebuilt: through the
routes, throttled, quietly, never during a call, and with no way to restart the gateway or Desktop.
"""

from __future__ import annotations

import ast
import importlib.util
import logging
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dawn2_voice import live, wake  # noqa: E402
from tests.test_wake import FakeEngine, WakeWordInUse, armed, rig as _rig  # noqa: E402,F401

rig = _rig


def mic_missing(engine):
    """What core raises while the device is still gone: RuntimeError from the PortAudio error."""
    err = RuntimeError("Failed to open the wake-word microphone.")
    err.__cause__ = OSError("Error opening InputStream: MME error 6")
    engine.start_error = err


# -- manager ---------------------------------------------------------------------------------------

def test_status_reports_the_real_state_after_core_tore_the_detector_down(rig):
    armed(rig)
    rig.engine.lose_mic()
    st = rig.m.status()
    assert st["state"] == "error" and "microphone" in st["error"].lower()
    assert rig.pending == [], "reading the status never starts anything"


def test_arm_rebuilds_only_the_listener_after_a_mic_loss(rig):
    armed(rig)
    rig.engine.lose_mic()
    st = rig.m.arm("hey ray", 0.5)  # what POST /wake/arm does, same settings
    assert st["state"] == "arming" and st["error"] == ""
    rig.run()
    assert rig.m.status()["state"] == "listening"
    assert rig.engine.owner is rig.m.owner
    assert rig.engine.calls == [("start", False), ("mic_lost",), ("start", False)]  # no stop/pause/anything else


def test_auto_arm_does_not_skip_a_lost_listener(rig):
    rig.m.auto_arm("hey ray", 0.5)
    rig.run()
    rig.engine.lose_mic()
    rig.m.auto_arm("hey ray", 0.5)  # auto_armed is already True
    rig.run()
    assert rig.m.status()["state"] == "listening" and rig.engine.calls.count(("start", False)) == 2


def test_mic_still_missing_reports_error_then_a_later_arm_succeeds(rig):
    armed(rig)
    rig.engine.lose_mic()
    mic_missing(rig.engine)
    rig.m.arm("hey ray", 0.5)
    rig.run()
    st = rig.m.status()
    assert st["state"] == "error"
    assert "MME error 6" in st["error"] and "retries automatically" in st["error"]
    rig.clock.t += wake.REARM_MIN_INTERVAL_S + 1  # the renderer's next idle poll
    rig.engine.start_error = None  # the mic is back
    assert rig.m.arm("hey ray", 0.5)["state"] == "arming"
    rig.run()
    assert rig.m.status() == {"state": "listening", "phrase": "hey ray", "error": "", "detections": 0}


def test_retries_are_throttled_and_do_not_spam_the_log(rig, caplog):
    armed(rig)
    rig.engine.lose_mic()
    mic_missing(rig.engine)
    with caplog.at_level(logging.DEBUG, logger="dawn2-voice"):
        for _ in range(3):  # three polls, each past the throttle
            rig.m.arm("hey ray", 0.5)
            rig.run()
            if _ < 2:
                rig.clock.t += wake.REARM_MIN_INTERVAL_S + 1
        starts_before = rig.engine.calls.count(("start", False))
        for _ in range(20):  # a hot caller inside the throttle window: no engine call at all
            assert rig.m.arm("hey ray", 0.5)["state"] == "error"
        rig.run()
    assert rig.engine.calls.count(("start", False)) == starts_before
    warned = [r for r in caplog.records if r.levelno >= logging.WARNING and "not armed" in r.getMessage()]
    assert len(warned) == 1, "one WARNING per distinct failure, the repeats are DEBUG"


def test_paused_during_a_call_is_never_rearmed_by_a_status_check(rig):
    armed(rig)
    assert rig.m.pause() is True  # a call holds the mic
    calls = list(rig.engine.calls)
    for _ in range(3):
        assert rig.m.status()["state"] == "paused"
        assert rig.m.arm("hey ray", 0.5)["state"] == "paused"
    assert rig.engine.calls == calls and rig.pending == []
    # even when core lost the lease meanwhile: no start during the call
    rig.engine.lose_mic()
    assert rig.m.status()["state"] == "paused"
    assert rig.m.arm("hey ray", 0.5)["state"] == "paused"
    assert rig.engine.calls == calls + [("mic_lost",)] and rig.pending == []


def test_hangup_after_a_loss_during_the_call_rebuilds_the_listener(rig):
    armed(rig)
    rig.m.pause()
    rig.engine.lose_mic()  # the mic vanished while the call ran
    assert rig.m.resume() is True  # the hang-up
    rig.run()
    assert rig.m.status()["state"] == "listening" and rig.engine.owner is rig.m.owner
    assert rig.engine.calls.count(("start", False)) == 2


def test_hangup_after_a_loss_with_the_mic_still_missing_ends_in_error_then_recovers(rig):
    armed(rig)
    rig.m.pause()
    rig.engine.lose_mic()
    mic_missing(rig.engine)
    rig.m.resume()
    rig.run()
    assert rig.m.status()["state"] == "error"
    rig.clock.t += wake.REARM_MIN_INTERVAL_S + 1
    rig.engine.start_error = None
    rig.m.arm("hey ray", 0.5)
    rig.run()
    assert rig.m.status()["state"] == "listening"


def test_a_busy_device_after_hangup_is_retried_by_the_next_arm(rig):
    armed(rig)
    rig.m.pause()
    rig.engine.resume_failures = 99
    rig.m.resume()
    rig.run()
    assert rig.m.status()["state"] == "error"
    rig.clock.t += wake.REARM_MIN_INTERVAL_S + 1
    rig.engine.resume_failures = 0
    rig.m.arm("hey ray", 0.5)  # start_listening resumes the detector we still own
    rig.run()
    assert rig.m.status()["state"] == "listening"


def test_a_wake_detection_is_not_mistaken_for_a_mic_loss(rig):
    armed(rig)
    rig.engine.say_phrase()  # the detector paused itself to hand the mic to the call
    assert rig.m.status()["state"] == "paused"
    assert rig.m.arm("hey ray", 0.5)["state"] == "paused"
    assert rig.engine.calls.count(("start", False)) == 1


def test_a_stale_claim_watchdog_does_not_resume_a_rebuilt_listener(rig):
    armed(rig)
    rig.engine.say_phrase()
    rig.engine.lose_mic()
    assert rig.m.status()["state"] == "paused"  # paused is the call's; never reconciled
    rig.run("d2v-wake-claim")  # unclaimed: the watchdog resumes -> lease lost -> rebuild the listener
    rig.run()
    assert rig.m.status()["state"] == "listening"


def test_core_wake_word_on_after_a_loss_is_refused_not_rebuilt(rig):
    armed(rig)
    rig.engine.lose_mic()
    st = rig.m.refuse(wake.CORE_WAKE_ON_MESSAGE)
    assert st["state"] == "error" and "wake_word.enabled" in st["error"]
    assert rig.pending == [] and rig.engine.calls == [("start", False), ("mic_lost",)]


def test_another_owner_holding_the_mic_is_in_use_not_stolen(rig):
    armed(rig)
    rig.engine.lose_mic()
    rig.engine.owner = object()  # core's own wake word (or another process) took the lease
    rig.m.arm("hey ray", 0.5)
    rig.run()
    st = rig.m.status()
    assert st["state"] == "error" and "another Hermes" in st["error"]
    assert "wake_word.enabled" not in st["error"]
    assert rig.engine.owner is not rig.m.owner


def test_an_engine_without_the_liveness_calls_keeps_the_old_behaviour(rig):
    armed(rig)
    del FakeEngine.owns_listener  # a core that predates them
    try:
        rig.engine.owner = None
        assert rig.m.status()["state"] == "listening"
    finally:
        FakeEngine.owns_listener = lambda self, owner: self.owner is not None and owner is self.owner


# -- routes ----------------------------------------------------------------------------------------

@pytest.fixture
def api(monkeypatch, rig):
    spec = importlib.util.spec_from_file_location("d2v_plugin_api_miclost", ROOT / "dashboard" / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    settings = {"wake_word": True}
    monkeypatch.setattr(mod, "_settings", lambda: live.resolve_persona(live.settings(settings), "You are Ray, the orchestrator."))
    monkeypatch.setattr(mod, "_core_wake_on", lambda: False)
    monkeypatch.setattr(mod.wake, "manager", lambda: rig.m)
    app = FastAPI()
    app.include_router(mod.router, prefix="/p")
    c = TestClient(app)
    c.settings, c.rig, c.mod = settings, rig, mod
    return c


def test_route_arm_rebuilds_a_listener_core_tore_down(api):
    api.post("/p/wake/arm")
    api.rig.run()
    assert api.get("/p/wake").json()["state"] == "listening"
    api.rig.engine.lose_mic()  # 18:07:25
    r = api.post("/p/wake/arm").json()  # the renderer's idle poll
    assert r["enabled"] is True and r["state"] == "arming"
    api.rig.run()
    assert api.get("/p/wake").json()["state"] == "listening"


def test_route_status_reports_the_loss_and_starts_the_rebuild(api):
    api.post("/p/wake/arm")
    api.rig.run()
    api.rig.engine.lose_mic()
    r = api.get("/p/wake").json()  # never "listening" for a dead detector
    assert r["state"] in ("arming", "error") and r["state"] != "listening"
    api.rig.run()
    assert api.get("/p/wake").json()["state"] == "listening"


def test_route_status_with_the_mic_still_missing_is_error_with_a_message(api):
    api.post("/p/wake/arm")
    api.rig.run()
    api.rig.engine.lose_mic()
    mic_missing(api.rig.engine)
    api.get("/p/wake")  # first poll: found dead, one rebuild attempt
    api.rig.run()
    r = api.get("/p/wake").json()
    assert r["state"] == "error" and "MME error 6" in r["error"]
    starts = api.rig.engine.calls.count(("start", False))
    for _ in range(10):  # status reads inside the throttle window never rebuild again
        assert api.get("/p/wake").json()["state"] == "error"
    api.rig.run()
    assert api.rig.engine.calls.count(("start", False)) == starts
    api.rig.clock.t += wake.REARM_MIN_INTERVAL_S + 1
    api.rig.engine.start_error = None
    assert api.post("/p/wake/arm").json()["state"] == "arming"
    api.rig.run()
    assert api.get("/p/wake").json()["state"] == "listening"


def test_route_status_leaves_a_paused_detector_alone(api):
    api.post("/p/wake/arm")
    api.rig.run()
    assert api.post("/p/wake/pause").json() == {"paused": True}
    calls = list(api.rig.engine.calls)
    for _ in range(3):
        assert api.get("/p/wake").json()["state"] == "paused"
        assert api.post("/p/wake/arm").json()["state"] == "paused"
    assert api.rig.engine.calls == calls and api.rig.pending == []


def test_route_status_does_not_arm_when_the_setting_is_off_or_core_wake_is_on(api):
    api.post("/p/wake/arm")
    api.rig.run()
    api.rig.engine.lose_mic()
    api.settings["wake_word"] = False
    assert api.get("/p/wake").json()["enabled"] is False and api.rig.pending == []
    api.settings["wake_word"] = True
    api.mod._core_wake_on = lambda: True
    api.get("/p/wake")
    assert api.rig.pending == [], "core's wake word is on: one mic lease per machine, never touched"


# -- no restart path -------------------------------------------------------------------------------

def test_no_gateway_or_desktop_restart_path_in_the_wake_code():
    banned_imports = {"subprocess", "signal", "multiprocessing", "ctypes"}
    banned_names = {"_exit", "execv", "execl", "execvp", "kill", "killpg", "system", "popen", "Popen", "startfile",
                    "restart", "restart_gateway", "relaunch", "reload_plugins"}
    for rel in ("dawn2_voice/wake.py", "dashboard/plugin_api.py"):
        tree = ast.parse((ROOT / rel).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                assert not banned_imports & {a.name.split(".")[0] for a in node.names}, rel
            elif isinstance(node, ast.ImportFrom):
                assert (node.module or "").split(".")[0] not in banned_imports, rel
            elif isinstance(node, ast.Attribute):
                assert node.attr not in banned_names, (rel, node.attr)
            elif isinstance(node, ast.Name):
                assert node.id not in banned_names, (rel, node.id)
    # the only engine calls the manager makes are the five listener calls (+ the two read-only checks)
    src = (ROOT / "dawn2_voice" / "wake.py").read_text(encoding="utf-8")
    called = {n.func.attr for n in ast.walk(ast.parse(src)) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
              and n.func.attr.endswith("_listening")}
    assert called <= {"start_listening", "pause_listening", "resume_listening", "stop_listening"}, called
