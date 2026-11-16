"""Neutral defaults are enforced on both sides of the wire, without network."""
import importlib.util
from pathlib import Path
import pytest
from dawn2_voice import live


def test_neutral_defaults_and_client_settings():
    cfg = live.settings(None)
    assert cfg['ack_source'] == 'bank'
    assert cfg['progress_first_ms'] == 75000
    assert cfg['progress_every_ms'] == 35000
    out = live.client_settings(cfg)
    for key in ('ack_source', 'progress_first_ms', 'progress_every_ms'):
        assert out[key] == cfg[key]
    assert live.settings({'ack_source': 'model'})['ack_source'] == 'model'
    assert live.settings({'ack_source': 'unknown'})['ack_source'] == 'bank'


@pytest.mark.parametrize('key,default', [('progress_first_ms', 75000), ('progress_every_ms', 35000)])
def test_progress_setting_validation(key, default):
    assert live.settings({key: 0})[key] == 0
    assert live.settings({key: 12345})[key] == 12345
    for bad in (-1, True, float('nan'), float('inf'), 'bad'):
        assert live.settings({key: bad})[key] == default


def test_ack_endpoint_default_never_reads_secret_or_calls_model(monkeypatch):
    path = Path(__file__).resolve().parents[1] / 'dashboard/plugin_api.py'
    spec = importlib.util.spec_from_file_location('neutral_ack_api', path)
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    monkeypatch.setattr(api, '_settings', lambda: live.settings(None))
    def forbidden(*args, **kwargs):
        pytest.fail('default bank ack must never access model or secret')
    monkeypatch.setattr(api, '_secret', forbidden)
    monkeypatch.setattr(api.ack, 'generate', forbidden)
    assert api.flow_ack({'provider': 'gemini-free', 'utterance': 'hello'}) == {'text': ''}
