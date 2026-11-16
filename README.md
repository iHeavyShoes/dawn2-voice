# Dawn 2.0 Voice (`dawn2-voice`)

**One brain; the voice is only the messenger.** A live, full-duplex voice call for
[Hermes Agent](https://github.com/NousResearch/hermes-agent) Desktop. Every answer comes from your
main Hermes model, in the chat you have open, and nothing is lost between the call and the chat.

You talk; a realtime voice model (Gemini Live or OpenAI Realtime) listens, hands what you said to
Hermes as a normal turn in the open chat, and reads Hermes' reply back to you while it is being
written. The request and the full answer stay in the chat as ordinary rows.

## What's different from other voice plugins

- **The voice model never answers.** With the default `brain: hermes`, every substantive turn goes
  to the chat's own model. The voice model gets a relay persona and **no tools**. A small local
  classifier, not the model, decides what counts as a turn. On OpenAI the server never creates a
  response by itself (`create_response: false`). On Gemini, any turn that doesn't read Hermes'
  text is never played. So answers can't come from the voice model, even when prompting fails.
- **Acks are neutral by default.** `ack_source: bank` chooses from 32 Hebrew and 24 English
  content-free holding phrases ("בודק", "רגע אחד", "One moment"). Selection uses only the active
  call language, persona gender, randomness and recent-repeat memory, never the turn's content.
  About 25% of turns stay silent; a fast Hermes answer suppresses the ack. No model ack request
  is made. `ack_source: model` explicitly restores the legacy content-reacting request (last
  utterance + previous Hermes sentence only), guard and bank fallback.
- **Long waits have bounded progress.** In Hermes mode, after 75 seconds of silence during a
  running turn, the voice says a short progress phrase in the active call language, then every
  randomized 30–40 seconds. Apologies are eligible only from the second progress phrase.
  Reply playback resets the first-silence window; speech/playback blocks progress, real replies
  preempt it, and interruption, turn end or hang-up cancels it. Progress is never held/resumed
  as a reply. Set either `progress_first_ms` or `progress_every_ms` to `0` to disable.
- **Full readout.** Hermes' reply is read while it streams, sentence by sentence (markdown, code
  and URLs are made speakable). At the end it is reconciled with the final text: every sentence is
  read, and none twice. If you interrupt with "ok" or "כן", reading resumes from the start of the
  sentence you cut. Very long replies stop after about ten minutes and say the rest is in the chat.
- **Transcript and missed-request check.** At hang-up the spoken transcript goes to the same chat
  as one queued turn, and to the plugin's data folder. That turn asks Hermes to check the call for
  any request that was missed. The voice lines in the transcript are Hermes' own text, not the
  provider's transcription.
- **Provider chain.** Gemini Live on a free key, then OpenAI Realtime on your ChatGPT/Codex
  sign-in in Hermes, then Gemini Live on a paid key, with automatic fallback also mid-call. A
  network blip first reconnects the same provider. An expensive provider never takes over a
  running call unless you allow it. A picker next to the call button pins one provider.
- **No credential in the renderer.** The renderer gets a single-use, setup-locked Gemini token or
  a short-lived OpenAI client secret that Hermes core signed. The plugin never sees your Codex
  token.
- **Clean stop.** Hang-up, a voice "end call", a dropped connection and disabling the plugin all
  run one idempotent teardown: no socket, peer connection, microphone track or process is left
  behind.

## Requirements

- Hermes Agent **0.21.5 or newer** with Hermes Desktop (Windows, macOS or Linux).
- At least one voice provider:
  - a Google AI Studio key with Gemini Live access as `GEMINI_API_KEY`;
  - a ChatGPT/Codex sign-in in Hermes (Providers → OpenAI Codex);
  - a billed Google key as `GEMINI_API_KEY_PAID`.
- A microphone. Headphones are recommended; on loudspeakers see `half_duplex`.

## Setup

1. Clone the repository into your Hermes plugins folder as `dawn2-voice`. The folder name must be
   the plugin id. For example:
   `git clone https://github.com/iHeavyShoes/dawn2-voice ~/.hermes/plugins/dawn2-voice`
   (on Windows, `%LOCALAPPDATA%\hermes\plugins\dawn2-voice`).
2. Add `GEMINI_API_KEY` (https://aistudio.google.com/apikey) to your Hermes profile's `.env`.
   - Optional: add `GEMINI_API_KEY_PAID`.
   - For the ChatGPT voice, sign in to OpenAI Codex in Hermes.
   - The plugin reads keys only through Hermes' secret scope, and never logs, returns or stores
     them.
3. Enable the backend half, then restart the gateway: `hermes plugins enable dawn2-voice`.
4. In Desktop: **Capabilities → Plugins → Rescan**, then switch **Dawn 2.0 Voice** on (the
   Desktop half ships off by default).
5. A waveform button appears in the composer. Click it to call, and click again to hang up. The
   chevron next to it picks the voice provider.

Without any provider, the button is disabled and its tooltip says what to add.

## Settings

Settings live under `plugins.entries.dawn2-voice.settings` in the profile's `config.yaml`. Edit
them in Desktop → Plugins → Dawn 2.0 Voice → Settings, or with
`hermes config set plugins.entries.dawn2-voice.settings.<key> <value>`. A change applies from the
next call.

| Key | Default | Meaning |
|---|---|---|
| `brain` | `hermes` | `hermes`: the chat model answers and the voice only reads. `voice`: the voice model chats itself and delegates (faster, but answers are the voice model's own). |
| `ack_source` | `bank` | Neutral bank by default; `model` opts in to legacy guarded model reactions. |
| `progress_first_ms` | `75000` | First progress after silence in a running Hermes turn; `0` disables. |
| `progress_every_ms` | `35000` | Later cadence, randomized ±1/7; `0` disables. |
| `providers` | `gemini-free,openai-codex,gemini-paid` | The fallback chain, in order. Leave an id out to never use it. |
| `fallback_mid_call` | `gemini-free,gemini-paid` | Providers that may take over a call that is already running (`all`, `none`, or ids). |
| `persona_name` | empty | The voice's name. Empty: the agent name from the profile's `SOUL.md` (`You are Ray ...`), else `Hermes`. Only the name is sent to the provider. |
| `persona_gender` | `auto` | `male` / `female` / `auto`. Sets Hebrew grammatical forms and the `auto` voice. |
| `language` | `auto` | Starting language: `auto` follows the Desktop UI language and then whatever you speak; or `he`, `en`, any BCP-47 code. |
| `voice` | `auto` | Gemini voice. `auto` picks `Charon` for a male persona and `Aoede` for a female one; or any Gemini prebuilt voice. |
| `openai_voice` | `auto` | OpenAI voice. `auto` picks `cedar` for a male persona and `marin` for a female one; or `ash`, `alloy`, `coral`, ... |
| `openai_model` / `openai_speed` | `gpt-realtime-2.1` / `1.15` | OpenAI Realtime model and speech speed. |
| `model` | `gemini-3.8-live` | Gemini Live model. |
| `transcription_languages` | empty | BCP-47 hints for input transcription (`he-IL,en-US`). |
| `vocabulary` | empty | Comma-separated terms the transcription should spell right (the persona name is always added). |
| `silence_ms` | `1000` | End-of-turn silence, 400–5000 ms. |
| `instructions` | empty | Extra delivery instructions for the voice. |
| `transcript_to_chat` | `chat_turn` | `chat_turn` (chat and file), `file`, or `off`. |
| `half_duplex` | `false` | Mute the mic while the voice speaks (for loudspeakers; disables barge-in). |
| `wake_word` | `false` | Start a call by saying the wake phrase (see Limitations). |
| `wake_phrase` | empty | English letters only. Empty: `hey <persona name>`. |
| `wake_sensitivity` / `wake_surface` | `0.5` / `desktop` | Detector sensitivity; which window answers a wake. |
| `api_version` | `v1alpha` | Gemini Live API version for ephemeral tokens. |
| `debug_picker` | `false` | Opt-in diagnostic for the provider picker (counts and booleans only). |

Example: a Hebrew-first assistant named Ray with a male voice, Codex first, and the wake word on:

```
hermes config set plugins.entries.dawn2-voice.settings.persona_name Ray
hermes config set plugins.entries.dawn2-voice.settings.language he
hermes config set plugins.entries.dawn2-voice.settings.voice Charon
hermes config set plugins.entries.dawn2-voice.settings.openai_voice ash
hermes config set plugins.entries.dawn2-voice.settings.providers "openai-codex,gemini-free,gemini-paid"
hermes config set plugins.entries.dawn2-voice.settings.wake_word true
```

## Cost and privacy

- **Gemini Live** is billed to your Google key, separately from Hermes.
  - With `gemini-3.8-live` on the paid tier, audio in costs about $0.005/min and audio out about
    $0.018/min (Google's pricing page, 2026-11): roughly $0.7–0.85 per hour of conversation.
  - On the **free tier**, Google's terms allow your audio, transcripts and the answers read back to
    be used to improve Google's products and to be seen by human reviewers. A paid key is not used
    that way. Use a paid key for anything private.
- **OpenAI Realtime** (`openai-codex`) runs on your ChatGPT plan's realtime allowance. A long call
  uses it fast, which is why that provider doesn't take over a running call by default.
- **The work itself** runs on whatever model your Hermes chat uses, and costs what that turn costs.
- **Sent to the serving voice provider:**
  - your microphone audio;
  - the text Hermes wrote for it to read;
  - the last few spoken turns;
  - the agent's name.
  After a provider switch, the recent turns also go to the next provider. Only opt-in
  `ack_source: model` sends an extra ack request containing
  your last utterance and the previous Hermes sentence: to Gemini Flash on Google's host, or as an
  out-of-band text response on the OpenAI connection.
- **Not sent:** your chat history, your files, or the `SOUL.md` text.
- **Written to disk:** call transcripts, in the plugin's Desktop data folder and (by default) one
  queued turn in the open chat. The plugin runs no shell commands or background processes and
  sends no telemetry.

## Limitations

- **The Codex route uses Hermes' Codex sign-in.** It needs `requires_auth: openai-codex` and a
  Hermes that can sign plugin requests (0.21.5+). Whether you are signed in only shows on the first
  call that asks. The realtime allowance is OpenAI's to set.
- **Android earpiece.** In Chrome on Android, once the mic opens the phone switches to call audio
  mode, and the voice may come out of the quiet earpiece. A web page can't change that route.
  Connect headphones or Bluetooth before calling, or switch the output from Android's media output
  panel during the call.
- **The wake word is English-only and Desktop-only.**
  - The local keyword spotter (sherpa-onnx, the same engine Hermes core uses) has an English
    vocabulary. "Hey Ray" works; a Hebrew wake phrase doesn't. The call itself can be in any
    language.
  - It listens on the microphone of the PC running the gateway, so a phone can't be woken.
  - Hermes' own wake word must be off (`wake_word.enabled: false`), because only one detector can
    use the microphone.
- **Latency.** Every substantive turn waits for the chat model's first sentence (typically 2–3 s
  on simple questions); the guarded ack covers slower ones. `brain: voice` trades this for speed.
- **The transcript is a chat turn.** The Desktop SDK can't add a non-turn note, so `chat_turn` costs
  one small model call. Set `file` to avoid it.
- **Voice fidelity.** The voice reads Hermes' text word for word by instruction. It is still a
  speech model, so pronunciation, and very rarely wording, can differ from the chat.

## Development

```
pip install -r requirements-dev.txt   # test-only: pytest, fastapi, httpx
python -m pytest -q                   # backend: minting, provider chain, routes, persona, wake word
node --test 'tests/js/*.test.mjs'     # renderer: delegation, readout, barge-in, transcript, transports, acks, failover
hermes plugins validate . --install-deps
```

The JavaScript tests drive `desktop/plugin.js` with a fake SDK, WebSocket, WebRTC and audio, so
they need no key, sign-in or microphone. CI (`.github/workflows/ci.yml`) runs both suites.

The design notes are in [`docs/DESIGN.md`](docs/DESIGN.md): the provider chain, the relay, the
streaming readout, acks, barge-in, the wake word and the issue log.
`catalog/plugin-catalog/dawn2-voice.yaml` is a draft catalog entry; it hasn't been submitted.

## Credits

- **hermes-xai** by Julien Talbot (MIT), `8fd9bf8`: the Desktop-half structure (module-scope call,
  composer button, `prompt.submit` delegation with `voice_context`, `message.complete` hand-back,
  worklet capture and player) and the backend route shape. Adapted here.
- **hermes-gemini-live** by Ha Trung (MIT), `cf549e7`: Gemini Live wire facts (accepted setup
  fields, `NON_BLOCKING` on the declaration, `realtimeInput.text`, model measurements). Its
  delegation path is not used.
- **hermes-live-voice** by Synero: the OpenAI Realtime client-secret body and the WebRTC/SDP flow
  were checked against it. Its `codex app-server` child process is not used.
- The delegation persona follows Hermes core's `tools/voice_live.py`. The wake word uses Hermes
  core's `tools.wake_word` engine (sherpa-onnx, Apache-2.0) and isn't bundled here.

Both MIT upstreams were checked at the commits named above. Their copyright notices are kept in
`LICENSE`.

## License

MIT © iHeavyShoes. See `LICENSE`.
