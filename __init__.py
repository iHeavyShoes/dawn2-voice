"""gemini-live-chat — Gemini Live voice for Hermes Desktop that delegates into the open chat.

Nothing is registered on the agent: the voice layer lives in the Desktop renderer
(``desktop/plugin.js``) and two backend routes (``dashboard/plugin_api.py``) that mint a
single-use ephemeral Gemini Live token. Real work is handed to Hermes as a normal
``prompt.submit`` on the chat the user has open (surface ``voice-live``).

``register`` exists so the loader and ``hermes plugins validate`` see a loadable Python half; it
only logs when the key is missing, never the key.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("gemini-live-chat")


def register(ctx) -> None:  # noqa: ARG001 - the plugin registers no agent capabilities
    try:
        from agent.secret_scope import UnscopedSecretError, get_secret
    except ImportError:
        return
    try:
        present = bool((get_secret("GEMINI_API_KEY") or "").strip())
    except UnscopedSecretError:
        present = False
    if not present:
        logger.info("gemini-live-chat: GEMINI_API_KEY is not set for this profile; "
                    "the Desktop button will say so until it is added.")
