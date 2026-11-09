"""0.9 isolated Gemini flow ack contract; no real network or credentials."""
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def test_isolated_ack_request_has_no_tools_and_only_two_bounded_context_fields():
    from dawn2_voice import ack
    calls = []
    def post(url, headers, body, timeout):
        calls.append((url, body, timeout))
        return 200, {"candidates": [{"content": {"parts": [{"text": "אה, הבנתי, רגע."}]}}]}
    result = ack.generate("test-not-a-key", "last utterance", "previous Hermes sentence", poster=post)
    assert result == {"text": "אה, הבנתי, רגע."}
    url, body, timeout = calls[0]
    assert url.endswith('/models/gemini-3.8-flash:generateContent')
    assert timeout <= .6
    assert 'tools' not in body
    assert len(body['contents']) == 1
    assert 'last utterance' in body['contents'][0]['parts'][0]['text']
    assert 'previous Hermes sentence' in body['contents'][0]['parts'][0]['text']
    assert 'max 6 words' in body['systemInstruction']['parts'][0]['text']


def test_ack_failures_do_not_return_vendor_content_or_keys():
    from dawn2_voice import ack
    assert ack.generate('', 'a', 'b') == {"text": ""}
    def post(*args):
        raise RuntimeError('private vendor content')
    assert ack.generate('private-test-key', 'a', 'b', poster=post) == {"text": ""}


def test_ack_route_uses_only_requested_gemini_provider_and_rejects_unbounded_input(monkeypatch):
    from dawn2_voice import ack
    spec = importlib.util.spec_from_file_location('d2v_ack_routes', ROOT / 'dashboard/plugin_api.py')
    api = importlib.util.module_from_spec(spec); spec.loader.exec_module(api)
    seen = []
    monkeypatch.setattr(api, '_secret', lambda name: seen.append(name) or '')
    assert api.flow_ack({'provider': 'gemini-paid', 'utterance': 'היי זה מעניין', 'previous_sentence': 'כן.'}) == {'text': ''}
    assert seen == ['GEMINI_API_KEY_PAID']
    seen.clear()
    assert api.flow_ack({'provider': 'openai-codex', 'utterance': 'a'}) == {'text': ''}
    assert api.flow_ack({'provider': 'gemini-free', 'utterance': 'a' * 3000}) == {'text': ''}
    assert not seen


def test_openai_speed_is_validated_at_session_output_and_pronunciation_is_explicit():
    from dawn2_voice import live, openai_rt
    cfg = live.resolve_persona(live.settings({'openai_speed': 1.15}))
    session = openai_rt.build_session(cfg)
    assert cfg['openai_speed'] == 1.15
    assert session['audio']['output']['speed'] == 1.15
    assert 'Israeli' in session['instructions']
    for raw in [-1, 2, float('nan'), True, 'bad']:
        assert live.settings({'openai_speed': raw})['openai_speed'] == 1.15
    assert live.settings({'openai_speed': .25})['openai_speed'] == .25
    assert live.settings({'openai_speed': 1.5})['openai_speed'] == 1.5


def test_ack_tuning_logs_content_free_enums_only():
    from dawn2_voice import ack
    rec = ack.clean_stats({'ack_source': 'dropped(echo)', 'ack_latency': 300, 'text': 'private'})
    assert rec == {'ack_source': 'dropped(echo)', 'ack_latency': 300}
    assert ack.clean_stats({'ack_source': 'private', 'ack_latency': 12}) is None
