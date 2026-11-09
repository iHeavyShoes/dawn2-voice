# Dawn 2.0 Voice: design notes

The detailed design behind the README: provider chain and fallback, the relay ("Hermes is the brain"), streaming readout, acks, barge-in, the wake word and the issue log. Version markers (v0.5, v0.6, ...) say when a behaviour was introduced.

## Voice providers and fallback (design)

One call, one conversation, several possible voices. The chain is an ordered list of providers;
the first that can serve takes the call, and a provider that fails hands the **same** call to the
next one.

| Id | Voice | Credential | Transport |
|---|---|---|---|
| `gemini-free` | Gemini Live | `GEMINI_API_KEY` (free tier) | WebSocket, single-use setup-locked token |
| `openai-codex` | OpenAI Realtime (GPT voice) | your ChatGPT/Codex sign-in in Hermes | WebRTC, short-lived client secret |
| `gemini-paid` | Gemini Live | `GEMINI_API_KEY_PAID` (billed) | WebSocket, single-use setup-locked token |

Default order `gemini-free,openai-codex,gemini-paid` (setting `providers`). A provider with no
credential (`no_key`, `not_signed_in`, `unsupported`) is skipped without a network call.

**Provider abstraction.** The backend (`dawn2_voice/providers.py`) only *mints* sessions:
`dawn2_voice/live.py` for Gemini, `dawn2_voice/openai_rt.py` for OpenAI. Both are built
from the same persona (`persona.py`; only the sentence naming the engine differs, the Gemini text
is byte-identical to v0.3) and the same two tools, `hermes_task` and `end_call`. In the renderer
everything above the wire is shared: delegation (`prompt.submit`, surface `voice-live`,
`voice_context`), the ack-only receipt, chunked readout of Hermes' replies, barge-in bookkeeping,
the transcript and the stop path. A transport (`TRANSPORTS` in `desktop/plugin.js`) only moves
text, tool answers and audio on its wire: `gemini-live` (`realtimeInput` / `toolResponse` on the
socket, PCM through an AudioWorklet) and `openai-realtime` (`conversation.item.create` +
`response.create` on the `oai-events` data channel, audio on the peer connection).

**The Codex route.** Hermes core already has a supported path, so the plugin uses it instead of
spawning `codex app-server`: `plugin.yaml` declares `requires_auth: [openai-codex]`, and the backend
asks `hermes_cli.plugin_provider_requests.credentialed_provider_request("openai-codex", "POST",
"https://api.openai.com/v1/realtime/client_secrets", ...)` for one ephemeral client secret per call.
Core attaches the Codex token server-side and refreshes it; the plugin never sees it, never reads
`~/.codex/auth.json`, and starts no child process, so there is nothing to hang, orphan or keep a
stale token in (the three failures of the app-server approach). The renderer uses the secret once,
as the bearer of its SDP offer to `https://api.openai.com/v1/realtime/calls`; it accepts no other
origin. A refusal is respected as such: a quota or auth error moves the call on, it is never
retried around.

**Failure handling.**

- *At connect* (`POST /session`): each provider in order is minted; `quota` (429, exhausted),
  `auth` (401/403, bad key) and `unavailable` (5xx, network) move to the next. The answer names the
  serving provider and lists the skipped ones with their reasons. All unconfigured: 503 `no_key`.
  All refused: 502 `exhausted`, with one line per provider.
- *Mid-call*: a Gemini socket closing with a non-1000 code, a Live `error`, an OpenAI `error` event
  for quota/auth/expiry, a refused SDP exchange or a failed peer connection triggers `failover`.
  It releases the failed transport completely (socket or peer connection, microphone tracks,
  AudioContexts, remote audio), keeps the conversation (turns, queued replies, open delegations,
  pinned chat), and asks for the next provider with `exclude` = every provider that failed on this
  call and `carry` = the recent spoken turns, which go into the new voice's instructions. The new
  voice first says it switched ("switching voice provider", in your language), then continues; a
  reply part handed over but never answered is handed again, and a Hermes reply that arrived
  during the switch is read by the new voice. Delegations are never re-submitted.
- *1.0: same provider first.* A `network`/`unavailable`/`expired` failure mid-call first
  reconnects the **same** provider (2 retries in a row, 500 ms then 1500 ms backoff, at most 6
  reconnects per call), carrying the recent spoken turns; nothing is re-spoken and no switch notice
  is said. Only quota, billing and auth (or retries used up) move the call along the chain.
- *1.0: who may take over a running call* (`fallback_mid_call`, default `gemini-free,gemini-paid`).
  `openai-codex` is left out by default because a long call uses a ChatGPT plan's realtime quota
  fast: when no allowed provider is left, the call ends with a spoken "the call dropped" notice and
  a **Call again** toast; a new call may still start on Codex.
- *1.0: nothing heard is read twice after a switch.* A part whose audio the user already heard
  (even partly) is not handed to the new voice; only the short switch notice is said.
- *Bounds*: at most 3 switches per call; a provider that failed on a call is not retried on it;
  one that refused for quota or auth is skipped for 15 minutes on the next calls, unless nothing
  else can serve. `end_call` and a normal close (1000) end the call, never switch. A resumption
  handle (Gemini `goAway`) is honoured only on the provider that issued it.
- *Log*: one line per served session, ids and reasons only, for example
  `dawn2-voice: voice provider openai-codex serving (connect; model=gpt-realtime-2.1; skipped
  gemini-free:quota)` or `... (switched from gemini-free after network)`. No key, token, secret or
  vendor error body is logged or returned. The transcript names the provider(s) that served.
- *UI*: the status-bar chip and the button tooltip name the serving provider
  (`Gemini (free key): on call`, `ChatGPT (Codex subscription): Hermes working (1)`), and show
  `Voice: switching provider` during a switch.

### Choosing the provider (picker, v0.5)

Next to the waveform button there is a small chevron; clicking it (or right-clicking the waveform
button; a long-press on Android) opens **Voice provider**:

| Option | What a call does |
|---|---|
| **Auto (fallback chain)** (default) | Walks the chain above (setting `providers`), with fallback. |
| **Gemini (free key)** / **ChatGPT (Codex subscription)** / **Gemini (paid key)** | Uses only that provider. No fallback. If it cannot serve, the call ends; a local voice (the browser's speech synthesis, Hebrew when installed) and a toast say `<id> unavailable: <reason>`, and the toast's **Use Auto** button switches back to Auto. |

Each row shows its state, both as a tooltip and written under the label (a phone has no hover):

- green, *ready*: the key is present, or this Hermes can sign Codex requests. Whether you are
  actually signed in to Codex is only known when a call asks, so a Codex sign-out shows after the
  first refused call;
- amber, *last attempt refused*: still clickable, because the refusal may be over (credit added,
  signed in again); the text says why, for example `gemini-paid unavailable: no credit / billing`;
  it clears as soon as that provider serves again;
- grey, *not available*: no key / this Hermes is too old; not clickable; the text says what to add.

The choice is stored per profile by the plugin's backend in the plugin's own data folder
(`<HERMES_HOME>/plugin-data/dawn2-voice/state.json`, through Hermes' plugin state API
`hermes_cli.plugins_state.PluginState`), never in `config.yaml`. It therefore survives restarts and
is the same on the Desktop app and on the phone. The routes: `GET /status` (adds `picker`),
`POST /choice {"choice": "auto"|<provider id>}`, `POST /report {"provider", "reason"}` (a refusal
the renderer saw on the provider's own connection; ids and enums only). A call in progress keeps
the provider it started with; the picker is read-only until you hang up.

### Paid Gemini key: billing

`GEMINI_API_KEY_PAID` is a Google AI Studio key on a billed account. On **Prepay**, a $0 credit
balance makes every key on that billing account fail with **HTTP 402 Payment Required** until
credit is added (Google, ai.google.dev/gemini-api/docs/billing, checked 2026-11-07); a
billing-disabled account can also answer 400/403, or 429 `RESOURCE_EXHAUSTED` with a billing
message. The plugin maps 402, and any 400/403/429 whose body mentions billing, prepay or credit, to
the reason `billing`, before the generic quota check. In Auto the chain moves on to the next
provider; the picker then shows `gemini-paid unavailable: no credit / billing (add credit or billing
in Google AI Studio)`. A 429 without billing words stays `quota`. Fix: add credit or billing in
Google AI Studio; the next successful call clears the warning.

**Catalog exception (documented).** The OpenAI route sends audio to `api.openai.com` on your
ChatGPT subscription through a core-signed request; it needs `requires_auth`, and its realtime
allowance is OpenAI's to set. That is outside the catalog's single-provider shape, which is fine
for a personal plugin and is disclosed below.

**Name.** Since 1.0 the plugin is **Dawn 2.0 Voice**, id `dawn2-voice`: it is no longer
Gemini-only. The id is the folder name, the settings key (`plugins.entries.dawn2-voice`), the
route prefix (`/api/plugins/dawn2-voice/`), the plugin-data namespace and the Desktop data folder.

## Hermes is the brain (v0.6)

With `brain: hermes` (the default) the voice model is only the ears and the mouth. Every answer
with content comes from the chat's own model (the one Hermes runs for that chat), never from
Gemini or GPT Realtime. Prompt rules alone did not hold this: on v0.5, Gemini answered "what's
left to do in this session?" and "should I use my reset?" by itself. So the decision moved out of
the model and into code.

**Who decides.** The renderer classifies every final user transcript with a small local
rule-based classifier (`classifyTurn`, Hebrew and English, no network):

| Kind | Examples | What happens |
|---|---|---|
| `greeting` | "hi", "שלום", "מה נשמע" | a fixed local line ("היי, אני כאן.") |
| `ack` / `short` | "ok", "כן", "תודה", "מגניב", one word with no question and no request verb | nothing (a backchannel); resumes a reply that was interrupted |
| `repeat` | "repeat that", "תחזור על זה" | the last Hermes reply is read again, locally |
| `stop` / `bye` | "stop", "די", "ביי" | playback stops / a local "bye" |
| `substantive` | everything else | `prompt.submit` on the pinned chat (surface `voice-live`, `voice_context`) |

A turn is trivial only if all of its words are covered by those phrase lists (fillers, "please"
and the persona's name are ignored). Any question mark, question word or request verb
(`תבדוק`, `תמשיך`, "check") makes it substantive. When Hermes' last reply ended with a question,
"yes" or "no" is an answer and goes to Hermes too.

**How the voice model is kept quiet.** It gets a relay persona ("you are only the voice; speak
only text tagged `[Say aloud]`, word for word") and **no tools**, so it can neither delegate, answer
on its own initiative, nor hang up. On top of that, each provider has its own control:

| Provider | Control | Deterministic? |
|---|---|---|
| OpenAI Realtime (`openai-codex`) | `turn_detection: {type: server_vad, create_response: false, interrupt_response: true}`. Server VAD still detects turns, transcribes and cancels on barge-in, but never creates a response. The renderer creates each one itself: `response.create` with `conversation: "none"` (out of band), whose only input is the text to read plus per-response read-verbatim instructions. | Yes: the model never produces a turn we did not request, and the request contains no user audio. |
| Gemini Live (`gemini-free`, `gemini-paid`) | Gemini Live has no "detect but don't respond" switch. Manual activity control (`automaticActivityDetection.disabled` + `activityStart/End`) would need our own VAD in the renderer and lose server barge-in. So: automatic VAD stays on, Hermes' text goes in as `realtimeInput.text` tagged `[Say aloud]`, and the renderer **gates the output**: a model turn that follows text we handed over (`pendingHand`) is played; any other turn is the voice model's own and is neither played nor written to the transcript. Its first output (or empty `turnComplete`) is used only as the end-of-turn signal. | Yes for what the user hears. The model may still generate a turn server-side, which costs a little output audio, but it never reaches the speaker. |

**Streaming.** Hermes' reply is spoken while it is being written. The renderer subscribes to
`message.start`, `message.delta` (text chunks; `text: null` is a segment boundary before tool
lines), `message.interim` and `message.complete` on the pinned chat. It cuts the text into
sentences (`. ! ? …` plus Hebrew/CJK equivalents, line breaks; a run with no sentence end longer
than about 120 characters is cut at the last space). Each sentence goes to the voice as soon as it
is complete. Only assistant text reaches the voice: tool progress lines are separate events and are
never read. At `message.complete` the final text is cut the same way and reconciled with what was
already read: every sentence not yet read is read, and none is read twice (the full-readout
guarantee). A silent reply (`[SILENT]`, `NO_REPLY`) is never read. Long replies are capped as
before, ending with "the rest is in the chat".

**Ack (v0.9).** A model may write a **flow-only** reaction; never the answer. The only input is
this last user utterance (up to 2000 characters) and the previous Hermes sentence (up to 400),
with a separate hard prompt: max six words, user's language, no facts/opinions/names/numbers/promises,
no verbatim echo. No tools, history, SOUL or voice transcript is included in this request.

- OpenAI: an out-of-band `response.create` on the serving connection (`conversation: "none"`,
  `output_modalities: ["text"]`, `tools: []`, explicit input). Text-only responses are never played
  and never change the main reading's state. Optional ack errors do not fail over the call.
- Gemini: Live is audio-only, so there is **no text-only request to the Live model**. Instead the
  backend calls `gemini-3.8-flash:generateContent` using the serving Gemini key tier, on the same
  Google host. This is an extra small model request (quota/billing applies), not a second Live
  connection. If that model is unavailable or slow, the phrase bank serves. This deliberate
  provider-contract adjustment is not a claim that Gemini Live can produce guarded text alone.
- Generation has a **600ms** deadline. Playback waits until **900ms** after submit. Any Hermes
  text (even an unfinished first sentence), user speech, provider switch or hang-up preempts it.
  Generation never holds up `prompt.submit` or Hermes' text. Late model output cannot ack twice.
- The guard strips niqqud/foreign script, rejects >6 words, all digits/times, an echo of three
  consecutive user words, and any word outside a conservative flow-only vocabulary. It does not
  admit user vocabulary merely because the user mentioned it: names/facts still fail. This favors
  safe bank fallbacks over permissive model prose; it is not a semantic guarantee for arbitrary text.
- No rule-based topic echo. The old 29-he / 28-en bank remains the fallback; recent five exclusions,
  gender forms and low weight for “checking” remain. About **one in four turns is silent**, even
  on slow requests. Clearly unfinished turns (connector tail or <3 words) get no ack; potentially
  substantive fragments may merge in one additional 400ms classifier window. Known commands and
  backchannels stay instant. An ack is never resumed after a backchannel.
- A playing ack is cut on speech or Hermes text. Gemini's generated tail is muted until its
  `turnComplete` before a queued reading is handed over (no Gemini `response.cancel` exists);
  OpenAI cancels and clears its audio buffer. This prevents overlap, but provider turnover can
  still add latency. A genuinely substantive barge-in drops the remaining answer, intentionally;
  that answer remains in the chat.
- Tuning lines contain only `ack_source=model|bank|silence|dropped(reason)` and `ack_latency`
  (generation/selection milliseconds). Drops are logged separately from a chosen fallback.
  No utterance, ack, previous sentence or vendor error is logged. Actual provider latency and
  accent quality still require a live call; fake-wire tests do not establish either.

**Speaker labels (v0.8).** A leading `<persona>:` label on a line of Hermes' reply ("ריי: כן, זה
אפשרי", `**Ray:**`, also `Hermes:`) is stripped before the text reaches the voice, and a piece that
is only the persona's name ("ריי") is not read. A colon elsewhere ("השעה: 10") is untouched.

**Barge-in and corrections.** Speech during a reply stops playback, and what is left of that reply
is held for up to 2.5 s until the user's words are known. A backchannel ("ok", "כן") or noise
resumes it from the **start of the sentence that was cut** (1.0): the renderer keeps the sentences
of every part it hands over and uses the voice's output transcription only to find how many were
heard to their end, erring towards reading a sentence again rather than skipping one. Anything
substantive drops it and goes to Hermes as a new turn on the same chat (Hermes core queues it
after, or steers, the running turn, so it acts as a follow-up or correction). "Stop" drops
everything queued.

**Transcript (1.0).** The voice lines of the saved transcript are Hermes' own text, sentence by
sentence as they were heard, not the provider's output transcription (which can come back in
pointed, defective spelling or drop Latin words inside Hebrew). The output transcription is kept
only for the plugin's own lines (acks, greeting, goodbye).

**Fast-answer hint (v0.9).** Each delegated turn adds a model-only line to `voice_context`:
when the full answer would be long, give the bottom line in 1–2 spoken sentences, stop and offer
“רוצה פירוט?”. Read the full version only on request (“תקריא הכל”). Write the bottom line first;
do not plan a full long answer before starting. Start directly with content, without a second
opener (“בסדר”, “מבין”, “כן”); the flow layer already supplies any needed acknowledgement.
`prompt.submit` has no per-turn reasoning-effort field, so this remains a hint, not a model switch.

**Latency trade-off.** Every substantive turn waits for the chat model instead of a voice model
that answers in about 0.5 s. Baseline before streaming (agent.log, prompt received → reply ready,
`voice-live` turns, measured on a real call): about 3–7 s for simple turns, about 12 s with a short tool
check, about 46 s with longer tool work. Streaming moves first audio to "first sentence written +
voice TTS start". The target is about 2–3 s after the user stops on simple questions; the short
ack covers anything slower. Greetings, acks, "repeat" and "stop" stay local and instant. If you
prefer speed over always getting the chat model's answer, set `brain: voice`.

**Measuring.** The renderer logs one line per delegated turn to the gateway log, with numbers only:

```
dawn2-voice: voice latency provider=gemini-free brain=hermes kind=turn eos->submit=412ms eos->first_text=2310ms eos->first_audio=1310ms eos->first_answer_audio=2890ms ack=yes silence_ms=1000
```

New lines append `eos_source`. `voice_activity` (Gemini `ACTIVITY_END`), `model_turn` and
`speech_stopped` (OpenAI) identify provider events; `transcript_idle` explicitly identifies the
inferred fallback, whose anchor is the last transcript chunk, **not** a measured EOS. Add
`silence_ms` only when comparing a true VAD end to the physical end of speech. Gemini takes the
400ms transcript-lag path on `voiceActivity.ACTIVITY_END` even if its silent relay emits no model
output. When no provider EOS arrives, the fallback now waits `silence_ms + 400` instead of
`silence_ms + 1500` (default 1400ms rather than 2500ms from the last transcript chunk). It is not
reported as a 400ms measured EOS. OpenAI still waits for the **final** input transcription: an
incomplete transcript may change, so a 400ms submit is not guaranteed there. `kind=abandoned` marks a turn superseded before it got an answer. Compare these lines
before and after a change; the measured numbers belong here once there is a call's worth of lines.

## Wake word (v0.7)

Say **"Hey Ray"** (the persona name; `wake_phrase` to change it) and this plugin's call starts on
the open chat, with a short "כן?" once it is up. Say **"ביי ריי"**, **"תסיים שיחה"**, **"סיים
שיחה"**, **"Bye Ray"** or **"end call"** to end it: the voice says "ביי." and the call hangs up
exactly like the button (transcript saved, microphone released, wake word listening again).

**Why the plugin runs its own detector.** On the gateway's `wake.detected` event the Desktop app
lets plugins hear it first, then *always* stops its capture, plays the wake sound and starts its own
voice conversation. No setting and no SDK flag makes core only emit the event, so answering it from
a plugin would open two voice sessions on one microphone. Instead, with core's wake word **off**,
the plugin's backend runs the same engine core uses (`tools.wake_word`, sherpa-onnx
open-vocabulary keyword spotting: any English phrase, no training, local, offline):

1. The gateway arms the detector itself when it mounts the plugin's routes (v0.8), and each window
   calls `POST /wake/arm` at load; the detector starts if `wake_word` is on (the first start
   lazy-installs `wake-sherpa` and downloads the ~13 MB model, like core's own first use).
2. On the phrase the detector **releases the microphone first**, then sends
   `plugin.dawn2-voice.wake.detected {token}` to every window.
3. The first eligible window to `POST /wake/claim` the token starts the call (the open chat, as
   the button does). Unclaimed for 15 s (no chat open, no Desktop window): it listens again.
4. A call started from the button calls `/wake/pause` before `getUserMedia` (the mic barrier);
   every hang-up calls `/wake/resume`, retried while the browser still holds the device.

**End-call phrases.** A turn hangs up only when the whole turn is a goodbye (the `bye` class of the
turn classifier) *and* holds an explicit phrase: `bye/ביי + <persona name>`, `end call`, `end the
call`, `hang up`, `סיים שיחה`, `תסיים שיחה`, `סיים/תסיים את השיחה`, `תנתק`. A bare "ביי", "תודה ביי",
"להתראות", or a sentence that merely contains a phrase ("אל תסיים שיחה", "Bye Ray, but first
check my calendar") keeps the call up; a request goes to Hermes as usual.

**Limits.** The wake phrase must be English: the keyword model has an English BPE vocabulary, so
"היי ריי" cannot be enrolled (say "Hey Ray"; the call itself is in Hebrew). The detector listens on
the gateway host's microphone, so it is for the PC running Hermes; a phone opening the webapp over
Tailscale cannot be woken (its microphone is not the one listening), and with `wake_surface:
desktop` a phone tab never answers a PC-side wake. Core's own wake word and this one cannot run at
once (one microphone lease per machine): turning this on means `wake_word.enabled: false`.

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

On `openai-codex` the backend asks core to sign `POST /v1/realtime/client_secrets` and returns
`{ client_secret, offer_url, model }`; the renderer opens an `RTCPeerConnection` with the mic track
and an `oai-events` data channel, posts its SDP offer to `offer_url`, and maps the Realtime events
(`response.function_call_arguments.done`, `input_audio_buffer.speech_started`,
`output_audio_buffer.*`, transcripts, `error`) onto the same call logic.

Surfaces used: `composer.actions` and `statusBar.right` slots, `ctx.rest`, `ctx.onEvent`,
`ctx.onDispose`, `ctx.files` (own data folder), `host.request('prompt.submit')`, `host.notify`.
No DOM access, no `window.hermesDesktop`, no dynamic import, no core patches.

## Browser / phone (Hermes webapp)

The design has no Electron dependency: audio is `getUserMedia` + AudioWorklet + a browser
WebSocket, and the webapp's CSP allows `connect-src wss:` and `blob:` workers. The microphone
requires a **secure context**, so it works over `https://` (for example Tailscale HTTPS) or on
`localhost`, not over plain `http://<lan-ip>`. The Hermes docs state that the Webapp loads the
desktop plugins installed on the host that serves it, so the button and the provider picker are
there too; the picker uses only SDK components (`Popover`) and plugin routes, and writes each
row's reason as text because a touchscreen has no hover tooltip. Not yet tried on a real phone.
After updating `plugin.js`, a Webapp tab needs **⌘K → Reload desktop plugins** (or a page reload).

## Disclosure

- Network: Gemini: the backend calls `generativelanguage.googleapis.com` (token creation) and the
  renderer opens a WebSocket to the same host. OpenAI: Hermes core calls
  `api.openai.com/v1/realtime/client_secrets` for the plugin (`requires_auth: openai-codex`) and
  the renderer opens WebRTC to `api.openai.com`. Audio goes to the serving provider; after a
  switch the recent spoken turns also go to the next one. A flow ack additionally sends only the
  last utterance + previous Hermes sentence to Gemini Flash on the same Google host (or an
  out-of-band text response on the serving OpenAI connection). No new destination is used.
- Reads: `GEMINI_API_KEY` and `GEMINI_API_KEY_PAID` through Hermes' secret scope, this plugin's own settings, and the first
  16 KB of the profile's `SOUL.md` to take the agent's **name** (and an explicitly stated gender).
  Only the name is sent to the voice provider; the SOUL text is not. The Codex token is never
  read by the plugin (Hermes core signs the one request).
- Writes: call transcripts in the plugin's Desktop data folder (`ctx.files`, `data`), and one
  queued turn per call in the open chat (unless `transcript_to_chat` says otherwise).
- No shell commands, no background processes, no telemetry, no self-update.

### Issue log

- **v0.9.1: the provider picker never opened in Hermes Desktop** (chevron or right-click); it
  worked in the phone webapp. Cause: Desktop keeps a composer mounted for every kept-alive chat
  tab and split pane (hidden ones under `data-pane-hidden` / `inert`), so the composer action, and
  with it the picker's Radix Popover, exists several times. All of them read one shared `open`
  flag, so one click opened every copy; each `PopoverContent` took focus, focus in one was
  "outside" the others, and Radix's dismissable layer called `onOpenChange(false)` on both in the
  same tick. The webapp mounts one composer, so nothing competed there. Reproduced with React
  19.3 + `radix-ui` 1.7.0 (Desktop's versions) in jsdom: 1 composer opens, 2 or more close at once,
  for both the chevron and the right-click. Fix: each voice button is its own picker instance and
  only the owner renders open (a notification action opens the one in the visible pane); the
  extra `onClick` toggle next to Radix's own trigger toggle is gone. An opt-in diagnostic
  (`debug_picker`, or an empty `debug-picker.on` in the plugin data folder) writes
  `picker-debug.jsonl` with event names, counts and booleans only. Real Desktop acceptance is
  the maintainer's.
- **v0.9.0: previous/first-sentence readout repeated.** Two reproducible client defects: terminal
  `response_reused` was treated as a fresh answer after the stream was destroyed, and re-sent
  `message.start` / delta frames reset or appended the sentence ledger. The client now honors
  the reuse flag, `turn_id` / segment / UTF-16 offset identities and committed final-row ids,
  while preserving legitimate identical text from distinct turns and explicit “repeat”. These
  reproduce the reported symptoms offline; the particular deployed call has not been traced.
- **v0.9.0: picker could not recover from a pinned exhausted free tier.** The chevron used an
  `asChild` wrapper with another button inside the SDK trigger. It now uses the trigger's own
  button with an explicit click handler, never disabled by call availability. Right-click is on
  the outer group; an obvious “Gemini free only” / “Gemini paid only” / “ChatGPT only” label shows
  a pin. Quota/connect errors offer the picker; the pinned “Use Auto” action also opens it. Merely
  opening it does not save a choice. No evidence identifies who/what made the earlier pin, and
  no automatic migration changes existing choices. Real Desktop acceptance was done by the maintainer in 0.9.1.
- **v0.9.0: 2500ms submit path.** The silent Gemini relay can emit no model-turn EOS, activating
  the old `silence_ms + 1500` timeout. The new documented `voiceActivity.ACTIVITY_END` path takes
  400ms; fallback is reduced and labeled inferred as described above. No claim that a restart
  changed a setting, or that the real call is fixed, without post-deploy latency lines.


- **v0.8.0 (2026-11-08): "Hey Ray" stopped working after a gateway restart** until the Desktop
  plugins were rescanned. Cause: the detector lives in the gateway process and was armed only by
  the renderer, once, at plugin load; a restart killed the detector and the still-loaded window
  never armed it again (agent.log: routes mounted after the restart, no "wake word listening" line).
  Fix, both sides: (1) the backend arms on its own when the gateway imports the route module
  (background thread), with a lazy fallback on the first `/status` or `/wake` request (e.g. under
  `plugins.isolation: host`). It runs once per process, only with `wake_word` on, never while core's
  own wake word is on (one mic lease; it reports an error instead), and leaves an armed or paused
  detector alone. (2) The renderer re-arms when the SDK's `host.state.gateway` socket state goes
  back to `open`, and every 45 s while idle it reads `GET /wake` and calls `/wake/arm` if the state
  is not listening, arming or paused. Neither runs during a call or while a wake is being claimed.
  A wake-word error is shown once, not on every check.

