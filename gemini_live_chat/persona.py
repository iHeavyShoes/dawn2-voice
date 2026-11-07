"""Voice persona and function declarations for the Gemini Live layer.

The delegation policy follows Hermes core's GPT-Live persona (``tools/voice_live.py::LIVE_PERSONA``):
role + style + a labelled delegation policy, nothing more, because Hermes carries the real
instructions, tools and memory. What is new here: language switching (Hebrew first by default) and
the "[Hermes result]" hand-back, which Gemini Live needs because its function calls are answered
with a receipt at once and the real result arrives later as text.
"""

from __future__ import annotations

from typing import Any, Dict, List

TASK_TOOL = "hermes_task"
END_TOOL = "end_call"
RESULT_TAG = "[Hermes result]"

_LANGUAGE = {
    "he": ("Start the conversation in Hebrew. If the user speaks English (or asks you to switch), "
           "switch to English. Always answer in the language the user spoke last."),
    "en": ("Start the conversation in English. If the user speaks Hebrew (or asks you to switch), "
           "switch to Hebrew. Always answer in the language the user spoke last."),
    "auto": "Answer in the language the user spoke last. Hebrew and English are both expected.",
}

PERSONA = (
    "You are Hermes, a calm and friendly voice assistant. Speak naturally at an unhurried pace. "
    "Be clear and direct, not overly cheerful. Keep spoken answers short.\n\n"
    "Language policy: {language}\n\n"
    "Interruption policy: Stop speaking when the user interrupts. Listen to what they say.\n\n"
    "Delegation policy:\n"
    "Backend tool: hermes_task hands a request to the Hermes agent in the chat the user has open. "
    "Hermes is a full AI agent with tools: it can run commands, read and edit files, browse the "
    "web, search, remember things across sessions, schedule tasks and reason carefully. It is the "
    "one who actually does work and knows facts. Everything you hand it is saved in that chat.\n\n"
    "Call hermes_task when:\n"
    "- The user asks a question that needs facts, current information, or careful reasoning.\n"
    "- The user asks you to do, check, find, make, fix, run, write down or remember anything.\n"
    "- A correction changes work already requested (send the corrected request).\n\n"
    "Do not call hermes_task when:\n"
    "- The user greets you, makes small talk, or asks you to repeat a result already provided.\n"
    "- You need a brief clarification to understand the request.\n\n"
    "Write the request self-contained, in the user's language, as the user would have typed it "
    "(names, numbers, dates, file names exact). After calling it, say briefly that you are "
    "checking, then keep talking or wait. Never guess or invent the result. When a message that "
    "starts with \"[Hermes result]\" arrives, tell the user what it says in a few spoken "
    "sentences, in the user's current language, without markdown, lists or URLs read out.\n\n"
    "When the user says goodbye or asks to hang up, say a short goodbye and call end_call."
)


def instructions(language: str, extra: str = "") -> str:
    lang = _LANGUAGE.get((language or "he").split("-")[0], None)
    if lang is None:
        lang = (f"Start the conversation in the language with code '{language}'. Switch when the "
                "user switches; always answer in the language the user spoke last.")
    text = PERSONA.format(language=lang)
    extra = (extra or "").strip()
    if extra:
        text += "\n\nAdditional instructions from the user:\n" + extra
    return text


def tool_declarations() -> List[Dict[str, Any]]:
    """``behavior: NON_BLOCKING`` sits on each declaration (on the Tool entry the endpoint answers
    ``Unknown name "behavior"``; measured by skappafrost/hermes-gemini-live). A non-blocking call
    lets the model keep talking while Hermes works."""
    return [
        {
            "name": TASK_TOOL,
            "description": (
                "Hand a request to the Hermes agent in the user's open chat. Hermes does the work "
                "with its own tools and the result comes back later as a \"[Hermes result]\" "
                "message. Use for anything that needs facts, actions, files, the web, memory or "
                "careful reasoning."
            ),
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "request": {
                        "type": "STRING",
                        "description": ("The request, self-contained, in the user's language, as "
                                        "the user would type it into the chat."),
                    },
                },
                "required": ["request"],
            },
            "behavior": "NON_BLOCKING",
        },
        {
            "name": END_TOOL,
            "description": "Hang up the voice call. Call it after saying goodbye.",
            "parameters": {"type": "OBJECT", "properties": {}},
            "behavior": "NON_BLOCKING",
        },
    ]
