"""Process ownership regressions; fake engine only, never opens a real mic."""
import importlib.util
import sys
import types
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from dawn2_voice import wake
from tests.test_wake import FakeEngine, WakeWordInUse


@pytest.mark.parametrize('args,expected', [
    (['gateway', 'run'], True),
    (['--profile', 'default', 'gateway', 'run'], True),
    (['-p', 'default', 'gateway', 'run'], True),
    (['--profile=default', 'gateway', 'run'], True),
    (['-pdefault', 'gateway', 'run'], True),
    (['dashboard', '--host', '100.125.120.123', '--port', '9119'], False),
    (['-p', 'default', 'dashboard', '--host', '100.125.120.123'], False),
    (['chat', '-q', 'gateway', 'run'], False),
    (['dashboard', '--title', 'gateway', 'run'], False),
    (['--profile', 'gateway', 'run'], False),
    (['gateway', 'status'], False),
    (['plugins', 'validate'], False),
    (['--', 'gateway', 'run'], False),
    ([], False),
])
def test_process_detection(monkeypatch, args, expected):
    monkeypatch.setattr(sys, 'argv', ['hermes'] + args)
    # Inherited context is NOT a process identity.
    monkeypatch.setenv('HERMES_GATEWAY', '1')
    assert wake.is_gateway_process() is expected


def mount(monkeypatch, args, engine):
    monkeypatch.setattr(sys, 'argv', ['hermes'] + args)
    config = types.ModuleType('hermes_cli.config')
    config.load_config_readonly = lambda: {
        'wake_word': {'enabled': False},
        'plugins': {'entries': {'dawn2-voice': {'settings': {
            'wake_word': True, 'wake_phrase': 'hey mike'}}}}}
    cli = types.ModuleType('hermes_cli')
    cli.config = config
    monkeypatch.setitem(sys.modules, 'hermes_cli', cli)
    monkeypatch.setitem(sys.modules, 'hermes_cli.config', config)
    m = wake.WakeManager(load=lambda: engine, spawn=lambda fn, name: fn(),
                         broadcast=lambda *a: None, sleep=lambda s: None)
    monkeypatch.setattr(wake, 'manager', lambda: m)
    spawned = []
    monkeypatch.setattr(wake, '_spawn', lambda fn, name: spawned.append(name) or fn())
    spec = importlib.util.spec_from_file_location('owner_api', Path(__file__).resolve().parents[1] / 'dashboard/plugin_api.py')
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    app = FastAPI()
    app.include_router(api.router)
    return m, TestClient(app), spawned


@pytest.mark.parametrize('args', [
    ['-p', 'default', 'dashboard', '--host', '100.125.120.123', '--port', '9119', '--no-open', '--skip-build'],
    ['chat', '-q', 'gateway run'],
    ['plugins', 'validate'],
])
def test_non_gateway_never_opens_engine_even_on_routes(monkeypatch, args):
    engine = FakeEngine()
    m, client, spawned = mount(monkeypatch, args, engine)
    assert spawned == []
    for _ in range(2):
        for method, route in [('get', '/wake'), ('post', '/wake/arm')]:
            s = getattr(client, method)(route).json()
            assert s['state'] == 'non_owner'
            assert 'gateway process' in s['error']
            assert s['enabled'] is True
            assert s['phrase'] == 'hey mike'
        assert client.post('/wake/claim', json={'token': 'bogus'}).json() == {'claimed': False}
        assert client.post('/wake/pause').json() == {'paused': False}
        assert client.post('/wake/resume').json() == {'resuming': False}
        m.auto_arm('hey mike')
        m.arm('hey mike')
        m.recover('hey mike')
        m.disarm()
        assert m.status()['state'] == 'non_owner'
    assert engine.calls == []
    assert not m.auto_armed


def test_gateway_arms_at_mount_without_a_window(monkeypatch):
    engine = FakeEngine()
    m, client, spawned = mount(monkeypatch, ['--profile', 'default', 'gateway', 'run'], engine)
    assert spawned == ['d2v-wake-auto-arm']
    assert m.status()['state'] == 'listening'
    assert engine.config['phrase'] == 'hey mike'
    client.post('/wake/arm')
    client.get('/wake')
    assert engine.calls == [('start', False)]


def test_dashboard_first_cannot_steal_gateway_lease(monkeypatch):
    engine = FakeEngine()
    dashboard, client, _ = mount(monkeypatch, ['dashboard'], engine)
    client.post('/wake/arm')
    gateway, _, _ = mount(monkeypatch, ['gateway', 'run'], engine)
    assert engine.owner is gateway.owner
    assert gateway.status()['state'] == 'listening'
    assert dashboard.status()['state'] == 'non_owner'


def test_in_use_message_does_not_guess_core_setting(monkeypatch):
    engine = FakeEngine()
    engine.start_error = WakeWordInUse('Wake-word microphone is already owned.')
    m, _, _ = mount(monkeypatch, ['gateway', 'run'], engine)
    s = m.status()
    assert s['state'] == 'error'
    assert 'another Hermes' in s['error']
    assert 'cannot identify the holder' in s['error']
    assert 'wake_word.enabled' not in s['error']
    assert 'Turn' not in s['error']
