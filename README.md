# Gemini Live for Hermes Desktop (`gemini-live-chat`)

Talk to Hermes out loud, full duplex, with Google **Gemini Live** as the voice layer. Every real
request is handed to Hermes as a normal turn **in the chat you have open**, so nothing said on the
call is lost.

## What makes it different

- **Delegation lands in the open chat.** The voice model's `hermes_task` tool becomes
  `prompt.submit` on the chat that was focused when the call started (`surface: "voice-live"`, the
  same seam Hermes core's GPT-Live uses), with the recent spoken turns as `voice_context`. The request
  and Hermes' full answer are ordinary rows in that chat. The voice reads a short version back.
- **Transcript persisted.** At hang-up the whole spoken transcript is submitted once to the same
  chat as a queued turn (and also written to the plugin's own data folder). Configurable.
- **Hebrew first, switch any time.** The voice starts in Hebrew (configurable) and answers in
  whichever language you spoke last.
- **Barge-in.** Talk over the voice and it stops at once (Gemini's server VAD plus a local flush of
  every queued audio buffer).
- **Clean stop.** Hang-up, `end_call`, a dropped socket, disabling or hot-reloading the plugin all
  run one idempotent teardown that closes both sockets, stops every microphone track, closes both
  AudioContexts and clears timers. The backend holds no socket and starts no process, so there is
  nothing to orphan or kill.
- **Key stays on the server.** The renderer gets a single-use ephemeral token (60 s to connect,
  30 min lifetime) whose whole session setup (model, persona, tools, voice) is locked by Google.

## Requirements

- Hermes Agent **0.21.5 or newer** with Hermes Desktop (Windows, macOS or Linux).
- A Google AI Studio API key with access to the Gemini Live API.
- A microphone. Headphones are recommended; on loudspeakers see `half_duplex`.

## Install

1. Copy this folder (or `git clone` the repository) to `%LOCALAPPDATA%\hermes\plugins\gemini-live-chat` (folder name must match).
2. Add `GEMINI_API_KEY` (a Google AI Studio key, https://aistudio.google.com/apikey) to the Hermes
   profile's `.env`. The plugin reads it only through `agent.secret_scope.get_secret`; it never
   reads `.env` itself, and never logs, returns or stores the key.
3. Enable the Python half (it serves the token route): `hermes plugins enable gemini-live-chat`.
4. In Desktop: **Capabilities → Plugins → Rescan**, then switch **Gemini Live** on (the desktop
   half ships off by default).
5. A waveform button appears in the composer. Click to call, click again to hang up.

Without the key the button is disabled and its tooltip says exactly what to add.

## Settings (`plugins.entries.gemini-live-chat.settings`)

| Key | Default | Meaning |
|---|---|---|
| `model` | `gemini-3.8-live` | Live model. `gemini-3.8-live` delegates reliably; `-extended-thinking` decides to answer itself about 3 times in 5 (measured by hermes-gemini-live). |
| `voice` | `auto` | `auto`: `Charon` (male) or `Aoede` (female) by the persona's gender. Or any Gemini prebuilt voice: male `Charon`, `Puck`, `Fenrir`, `Orus`, `Iapetus`, ...; female `Aoede`, `Kore`, `Leda`, `Zephyr`, ... Unknown names fall back to `auto`. |
| `persona_name` | empty | Who the voice is. Empty: the agent name from this profile's `SOUL.md` (`You are Ray (in Hebrew exactly ריי)` gives `Ray`/`ריי`), else `Hermes`. |
| `persona_gender` | `auto` | `male`, `female` or `auto` (an explicit `Gender:`/`Pronouns:`/`לשון זכר` line in SOUL.md, else the voice's sound, else male). Sets the Hebrew grammatical forms. |
| `language` | `he` | Starting language: `he`, `en`, any BCP-47 code, or `auto`. |
| `transcription_languages` | empty | BCP-47 hints for input transcription (`he-IL, en-US`). Empty: the starting language plus English/Hebrew, so switching keeps working. `auto`: no hints. |
| `vocabulary` | empty | Comma-separated names/terms the input transcription should spell right (up to 100; the persona name is always added). |
| `silence_ms` | `1000` | End-of-turn silence, 400-5000 ms. |
| `instructions` | empty | Extra persona text. |
| `transcript_to_chat` | `chat_turn` | `chat_turn`: one queued turn in the open chat at hang-up + data-folder file. `file`: data folder only. `off`: nothing. |
| `half_duplex` | `false` | Mute the mic while the voice speaks (loudspeakers that beat echo cancellation). Disables barge-in. |
| `api_version` | `v1alpha` | API version for the ephemeral token and socket. Both official Google SDKs use `v1alpha` for ephemeral tokens. |

### Changing the voice, persona and language

Settings are per profile (each profile's own `config.yaml`; the routes read the profile the
request is scoped to). Either use **Desktop → Plugins → Gemini Live → Settings**, or the CLI:

```
hermes -p ray config set plugins.entries.gemini-live-chat.settings.voice Puck
hermes -p ray config set plugins.entries.gemini-live-chat.settings.persona_gender male
hermes -p ray config set plugins.entries.gemini-live-chat.settings.language he
hermes -p ray config set plugins.entries.gemini-live-chat.settings.transcription_languages "he-IL,en-US"
hermes -p ray config set plugins.entries.gemini-live-chat.settings.vocabulary "Acme,יומן"
```

A change applies from the **next** call (each call mints a token whose setup is locked); no restart.
Asked mid-call, the voice says exactly that rather than inventing an answer. Hover the composer
button to see the effective persona and voice.

### What the Live API supports for language (checked 2026-11-07)

- `inputAudioTranscription.languageCodes[]` (BCP-47 hints) and `customVocabulary[]` (up to 1000
  terms; this plugin caps at 100, Google's recommendation): used. They shape the *transcript* (the
  chat record and the `voice_context` Hermes reads), which was the source of "בוטידוג מחר".
- `speechConfig.languageCode`: deliberately **not** set. On native-audio Live models the model picks
  the spoken language itself; pinning it would break switching to English. The persona's language
  policy steers it instead.
- There is no separate input-recognition language for what the voice *model* hears; it hears the
  audio directly.

## Cost and privacy

Gemini Live is billed on your Google key, separately from the Hermes turn. With `gemini-3.8-live`
paid tier: audio in $0.005/min, audio out $0.018/min (Google pricing page, 2026-11). A typical
conversation is roughly **$0.7-0.85 per hour**. Delegated work runs on whatever model your Hermes
chat uses and costs what that turn costs.

**Free tier vs paid tier.** A key on the free tier costs nothing, but under Google's terms the
content you send (your voice, the transcripts, and the Hermes answers the voice reads back) may be
used to improve Google's products and may be seen by human reviewers. On a paid (billing-enabled)
key Google does not use it for that. If you talk about anything private, use a paid key. Check
Google's current Gemini API terms; they are Google's to change.

What is sent to Google during a call: your microphone audio, the delegated requests, Hermes'
answers (as text, so the voice can summarise them) and the last few spoken turns. Your chat history
and files are not sent; Hermes itself still runs on whatever provider your chat uses.

## How it works

```
Desktop renderer (desktop/plugin.js)                 Hermes backend (dashboard/plugin_api.py)
  click ─ POST /session ───────────────────────────▶  get_secret("GEMINI_API_KEY")
                                                       POST /v1alpha/auth_tokens (uses=1, setup locked)
        ◀── { url (access_token), setup } ───────────
  WebSocket ─▶ wss://generativelanguage.googleapis.com/…BidiGenerateContentConstrained
  mic 16 kHz PCM ─▶ realtimeInput.audio      audio 24 kHz ◀─ serverContent.modelTurn
  toolCall hermes_task ─▶ toolResponse "WORK_STARTED" (at once)
                       └▶ host.request('prompt.submit', {session_id, text, surface:'voice-live', voice_context})
  message.interim + message.complete (same chat, any turn while live)
                       ─▶ realtimeInput.text "[Hermes result] …" when the voice is quiet
  goAway ─▶ new token with the last resumption handle, swap sockets, keep the mic
  hang-up ─▶ tearDown(): sockets, mic tracks, AudioContexts, timers; transcript saved once
```

Surfaces used: `composer.actions` and `statusBar.right` slots, `ctx.rest`, `ctx.onEvent`,
`ctx.onDispose`, `ctx.files` (own data folder), `host.request('prompt.submit')`, `host.notify`.
No DOM access, no `window.hermesDesktop`, no dynamic import, no core patches.

## Browser / phone (Hermes webapp)

The design has no Electron dependency: audio is `getUserMedia` + AudioWorklet + a browser
WebSocket, and the webapp's CSP allows `connect-src wss:` and `blob:` workers. The microphone
requires a **secure context**, so it works over `https://` (for example Tailscale HTTPS) or on
`localhost`, not over plain `http://<lan-ip>`. Whether the webapp loads this desktop plugin at all
is a property of the Hermes webapp build and has not been tested; see "Not verified".

## Disclosure

- Network: the backend calls `generativelanguage.googleapis.com` (token creation); the renderer
  opens a WebSocket to the same host. Audio goes to Google; nothing else leaves the machine.
- Reads: `GEMINI_API_KEY` through Hermes' secret scope, this plugin's own settings, and the first
  16 KB of the profile's `SOUL.md` to take the agent's **name** (and an explicitly stated gender).
  Only the name is sent to Google; the SOUL text is not.
- Writes: call transcripts in the plugin's Desktop data folder (`ctx.files`, `data`), and one
  queued turn per call in the open chat (unless `transcript_to_chat` says otherwise).
- No shell commands, no background processes, no telemetry, no self-update.

## Limitations

- **The transcript note is a turn.** The Desktop SDK has no supported way to append a non-turn
  note to a chat, so `chat_turn` submits the transcript as a normal queued turn that Hermes
  acknowledges in one line (a small extra model call). Set `file` to avoid it.
- **Results wait for a pause.** A Hermes reply is handed to the voice (`realtimeInput.text`) when it
  next stops speaking, or after 4 s with no audio if a model turn never closes. Every assistant
  reply on the pinned chat counts while the call is up, not only the reply to the delegation: an
  answer from a sub-agent that lands in a later turn ~20 s afterwards is spoken too, and interim
  assistant messages of a turn are included. `FunctionResponse.scheduling` is not used: Google's
  reference puts it on the FunctionResponse, the Live tools guide inside `response`, and it was not
  measured against the live endpoint.
- **Long calls.** Context compression is on; Google's `goAway` is handled by resuming on a new token.
- **Backend responses are buffered.** With `plugins.isolation: host` the dashboard API runs in the
  plugin host, which buffers responses. The plugin's two routes (`GET /status`, `POST /session`)
  are short JSON request/response calls, so this does not affect it; the audio stream itself goes
  straight from the renderer to Google.

## Development

```
pip install -r requirements-dev.txt   # test-only: pytest, fastapi, httpx
python -m pytest -q                   # 21 tests: token minting, setup lock, key handling, routes
node --test tests/js/                 # 22 tests: delegation seam, barge-in, transcript, stop path
hermes plugins validate . --install-deps
```

The JavaScript tests drive `desktop/plugin.js` with a fake SDK, fake WebSocket and fake audio, so
neither a key nor a microphone is needed. CI (`.github/workflows/ci.yml`) runs both suites on every
push and pull request, installing test dependencies with a 7-day release quarantine
(`uv pip install --exclude-newer`).

`catalog/plugin-catalog/gemini-live-chat.yaml` is a draft Hermes plugin-catalog entry. Fill in
`repo` and the 40-character `sha` before submitting it.

## Credits

- **hermes-xai** by Julien Talbot (MIT), `8fd9bf8`: the desktop-half structure (module-scope call,
  composer button, `prompt.submit` delegation with `voice_context`, `message.complete` hand-back,
  worklet capture and player) and the backend route shape. Adapted here.
- **hermes-gemini-live** by Ha Trung (MIT), `cf549e7`: Gemini Live wire facts (setup fields the
  endpoint accepts and rejects, `NON_BLOCKING` on the declaration, `realtimeInput.text`, model
  measurements). Its delegation path (api_server `/v1/runs` in a separate session) is **not** used.
- Delegation policy persona follows Hermes core `tools/voice_live.py`.
- New here: Gemini ephemeral-token flow with a locked setup, delegation into the open chat with
  Gemini, Hebrew-first language switching, transcript persistence, `goAway` resumption, and the
  generation-guarded stop path with its tests.

Both upstream projects are MIT-licensed (checked at the commits named above). Their copyright
notices are kept in `LICENSE`.

## License

MIT. See `LICENSE`.
