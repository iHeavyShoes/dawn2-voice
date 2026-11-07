"""One log line per voice turn: how long from the end of the user's speech to the first audio.

The renderer measures (it is the only side that sees both the provider's end-of-speech signal and
the first audio of the answer) and posts the numbers to ``POST /latency``; this module checks them
and formats the line the backend logs. Only ids, enums and integers: no transcript, no reply text,
no vendor message. The line goes to the gateway log (``agent.log``) next to the
``prompt.submit`` / reply timings, so before/after comparisons need nothing else.

Fields (milliseconds from ``eos``, the moment the provider's VAD declared the user's turn over):

* ``submit``             the turn was handed to Hermes (``prompt.submit``)
* ``first_text``         Hermes' first streamed text delta arrived
* ``first_audio``        the first audio of this turn played (the "checking" ack, or the answer)
* ``first_answer_audio`` the first audio of Hermes' answer played

``silence_ms`` is the configured end-of-turn silence the VAD waits before ``eos``; add it for
"user stopped talking -> first audio".
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional

from . import live, providers

FIELDS = ("submit", "first_text", "first_audio", "first_answer_audio")
MAX_MS = 600_000
_KINDS = ("turn", "abandoned")
_SAFE = re.compile(r"[^a-z0-9_.\-]")


def _ms(raw: Any) -> Optional[int]:
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    value = int(raw)
    return value if 0 <= value <= MAX_MS else None


def clean(body: Any) -> Optional[Dict[str, Any]]:
    """The checked record, or None when *body* is not a latency report."""
    if not isinstance(body, dict):
        return None
    out: Dict[str, Any] = {
        "provider": body.get("provider") if body.get("provider") in providers.PROVIDERS else "unknown",
        "brain": body.get("brain") if body.get("brain") in live.BRAINS else "unknown",
        "kind": body.get("kind") if body.get("kind") in _KINDS else "turn",
        "silence_ms": _ms(body.get("silence_ms")),
        "ack": body.get("ack") is True,
    }
    for field in FIELDS:
        out[field] = _ms(body.get(field))
    if all(out[f] is None for f in FIELDS):
        return None
    return out


def line(rec: Dict[str, Any]) -> str:
    def fmt(v: Optional[int]) -> str:
        return "-" if v is None else f"{v}ms"
    parts = [f"voice latency provider={_SAFE.sub('', rec['provider'])}", f"brain={rec['brain']}",
             f"kind={rec['kind']}"]
    parts += [f"eos->{f}={fmt(rec[f])}" for f in FIELDS]
    parts.append(f"ack={'yes' if rec['ack'] else 'no'}")
    parts.append(f"silence_ms={rec['silence_ms'] if rec['silence_ms'] is not None else '-'}")
    return " ".join(parts)
