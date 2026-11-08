# Live voice for Hermes Desktop (`gemini-live-chat`)

Talk to Hermes out loud, full duplex. The voice layer is a **provider chain** with automatic
fallback, also mid-call: Google **Gemini Live** on a free key, then **OpenAI Realtime** on your
ChatGPT/Codex sign-in, then Gemini Live on a paid key (see
[Voice providers and fallback](#voice-providers-and-fallback-design)). Every real
request is handed to Hermes as a normal turn **in the chat you have open**, so nothing said on the
call is lost.

## What makes it different

- **Delegation lands in the open chat.** The voice model's `hermes_task` tool becomes
  `prompt.submit` on the chat that was focused when the call started (`surface: "voice-live"`, the
  same seam Hermes core's GPT-Live uses), with the recent spoken turns as `voice_context`. The request
  and Hermes' full answer are ordinary rows in that chat. While the request is open the voice only
  acknowledges it ("I'm checking"); it never answers first with content of its own.
- **Hermes' answer is spoken in full.** The whole reply is made speakable (markdown, code blocks and
  URLs removed; code and links are announced as "in the chat") and handed over in parts of about a
  minute of speech, one per model turn, so a long explanation is read out instead of summarised.
  Very long replies stop after about ten minutes and say the rest is in the chat. A reply that is
  Hermes' silence sentinel (`[SILENT]`, `NO_REPLY`, as on Hermes' autonomous lanes) is not spoken.
- **Transcript persisted and checked.** At hang-up the whole spoken transcript is submitted once to
  the same chat as a queued turn (and also written to the plugin's own data folder). Configurable.
  The turn asks Hermes to check the call for any request that was not delegated or answered in
  the chat, and for any voice bug, and to report only problems. Otherwise it does not comment on
  the call: a hang-up is often just to save live quota, so it continues the conversation in text
  from where the call left off (the last open point or next step), in one or two lines.
- **Hebrew first, switch any time.** The voice starts in Hebrew (configurable) and answers in
  whichever language you spoke last.
- **Barge-in.** Talk over the voice and it stops at once (the provider's server VAD plus a local flush of
  every queued audio buffer, also when the model has finished generating but audio is still
  playing). Interrupting a long answer drops its remaining parts; they stay in the chat.
- **Clean stop.** Hang-up, `end_call`, a dropped socket, disabling or hot-reloading the plugin all
  run one idempotent teardown that closes the sockets or the peer connection, stops every
  microphone track, closes the AudioContexts and remote audio, and clears timers. The backend holds no socket and starts no process, so there is
  nothing to orphan or kill.
- **No credential in the renderer.** For Gemini it gets a single-use ephemeral token (60 s to
  connect, 30 min lifetime) whose whole session setup (model, persona, tools, voice) is locked by
  Google; for OpenAI a short-lived client secret that Hermes core signed for with your Codex
  sign-in.
- **Same behaviour on every provider.** Delegation, ack-only, full readout, barge-in, transcript
  and stop are shared code above a small transport layer, and the tests run them on each provider.

## Requirements

- Hermes Agent **0.21.5 or newer** with Hermes Desktop (Windows, macOS or Linux).
- At least one provider: a Google AI Studio key with Gemini Live access (`GEMINI_API_KEY`), a
  ChatGPT/Codex sign-in in Hermes (Providers → OpenAI Codex), or a billed key
  (`GEMINI_API_KEY_PAID`).
- A microphone. Headphones are recommended; on loudspeakers see `half_duplex`.

## Install

1. Copy this folder (or `git clone` the repository) to `%LOCALAPPDATA%\hermes\plugins\gemini-live-chat` (folder name must match).
2. Add `GEMINI_API_KEY` (a Google AI Studio key, https://aistudio.google.com/apikey) to the Hermes
   profile's `.env`. The plugin reads it only through `agent.secret_scope.get_secret`; it never
   reads `.env` itself, and never logs, returns or stores the key. Optional: a billed key as
   `GEMINI_API_KEY_PAID` (the last fallback), read the same way; absent, it is skipped.
   For the ChatGPT/Codex voice, sign in to OpenAI Codex in Hermes; nothing else to configure.
3. Enable the Python half (it serves the token route): `hermes plugins enable gemini-live-chat`.
4. In Desktop: **Capabilities → Plugins → Rescan**, then switch **Gemini Live** on (the desktop
   half ships off by default).
5. A waveform button appears in the composer. Click to call, click again to hang up.

Without the key the button is disabled and its tooltip says exactly what to add.

## Settings (`plugins.entries.gemini-live-chat.settings`)

| Key | Default | Meaning |
|---|---|---|
| `brain` | `hermes` | `hermes`: every substantive spoken turn goes to the Hermes chat model; the voice model only listens and reads. `voice`: the v0.5 behaviour (the voice model chats and decides when to delegate). See [Hermes is the brain](#hermes-is-the-brain-v06). |
| `providers` | `gemini-free,openai-codex,gemini-paid` | The fallback chain, in order. Drop an id to never use it. |
| `openai_model` | `gpt-realtime-2.1` | OpenAI Realtime model for `openai-codex` (`gpt-realtime*`). |
| `openai_voice` | `auto` | `auto`: `cedar` (male) or `marin` (female) by the persona. Or `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`. |
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
| `wake_word` | `false` | v0.7: say the wake phrase to start this call on the open chat. Needs Hermes' own wake word off. See [Wake word](#wake-word-v07). |
| `wake_phrase` | empty | English letters only (`hey ray`). Empty: `hey <persona name>`. |
| `wake_sensitivity` | `0.5` | 0..1; higher fires more easily (more false wakes). |
| `wake_surface` | `desktop` | `desktop`: only the Hermes Desktop app answers the wake word. `any`: the first open window (also a browser tab). |

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

### On a phone: earpiece instead of loudspeaker (Chrome on Android)

Once the microphone opens, Chrome on Android puts the phone in *communication* (VoIP) audio mode,
the same mode a phone call uses, so the voice can come out of the quiet earpiece instead of the
loudspeaker. A web page cannot fix this from code (checked against Chromium `main`, 2026-11-07):

- `AudioContext.setSinkId()` / `HTMLMediaElement.setSinkId()` are not available on Chrome for Android,
  and Chromium's Android audio manager lists only a `default` output device to pages.
- The output route follows the *communication device* Chromium picks when the mic opens (wired
  headset, USB, Bluetooth, else speakerphone); the earpiece is the phone's own routing for that mode,
  and the Desktop SDK gives a plugin no control over it.
- Echo cancellation (`echoCancellation: true`) is what keeps full duplex and barge-in usable on a
  loudspeaker, so turning it off to leave communication mode is not an option.

What works:

1. **Headphones or a Bluetooth headset/speaker** (best: no echo either). Connect them before you
   start the call; Chromium chooses the route when the mic opens.
2. **Switch the output during the call** from Android's own controls: the volume panel's *output /
   cast* button or the media output switcher in Quick Settings, where your Android version shows
   it (Android 11+ on most phones), and pick the phone speaker.
3. **Volume keys during the call** set the *call* volume, not the media volume; raise them once
   the call is live.
4. On a loud speaker, if the voice starts answering itself, set `half_duplex: true` (no barge-in).

### Choosing another male voice

`Charon` is the `auto` male voice. If its "s" sounds sharp or whistling (more noticeable on a phone
earpiece), try these Gemini prebuilt male voices (Google's own labels in brackets): `Algieba`
(smooth), `Schedar` (even), `Umbriel` (easy-going), `Orus` (firm), `Algenib` (gravelly),
`Iapetus` (clear), `Achird` (friendly), `Sadaltager` (knowledgeable), `Rasalgethi` (informative),
`Enceladus` (breathy), `Puck` (upbeat), `Fenrir` (excitable), `Sadachbia` (lively),
`Zubenelgenubi` (casual). Smooth, even and gravelly voices usually carry less sibilance; Google AI
Studio's voice picker plays a sample of each. Set one with
`hermes -p <profile> config set plugins.entries.gemini-live-chat.settings.voice Algieba`; it applies
from the next call, and the persona stays male because the voice is labelled male.

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

**Provider abstraction.** The backend (`gemini_live_chat/providers.py`) only *mints* sessions:
`gemini_live_chat/live.py` for Gemini, `gemini_live_chat/openai_rt.py` for OpenAI. Both are built
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
- *Bounds*: at most 3 switches per call; a provider that failed on a call is not retried on it;
  one that refused for quota or auth is skipped for 15 minutes on the next calls, unless nothing
  else can serve. `end_call` and a normal close (1000) end the call, never switch. A resumption
  handle (Gemini `goAway`) is honoured only on the provider that issued it.
- *Log*: one line per served session, ids and reasons only, for example
  `gemini-live-chat: voice provider openai-codex serving (connect; model=gpt-realtime-2.1; skipped
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
(`<HERMES_HOME>/plugin-data/gemini-live-chat/state.json`, through Hermes' plugin state API
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

**Name.** The plugin is no longer Gemini-only. Proposed rename: `live-voice-chat` (folder, plugin
id, repo). It is not done here: the plugin id is the folder name, the settings key
(`plugins.entries.gemini-live-chat`) and the Desktop data folder, so a rename moves settings and
transcripts and needs one coordinated step (rename the GitHub repo, move the folder, copy the
settings block).

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

**Ack (v0.8).** If Hermes has not produced its first sentence 900 ms after the turn was submitted, the
voice says one short acknowledgement, like a person would ("רגע", "שנייה, בוא נראה", "הממ, רגע",
"Hmm, let me see"). On a fast answer (first sentence within 900 ms) nothing is said before it.

*How it is made (design choice).* The ack is picked **locally in the renderer** from a phrase bank
(`ACK_BANK`, 29 Hebrew and 28 English phrases); the voice model never writes it, so it cannot
answer, guess or promise. A model-written ack was rejected: even a "≤8 words, never answer" prompt
leaks content now and then, and the guard would then have to drop it after the fact.

- About one turn in three (`ACK_ECHO_ODDS`, never twice in a row) the ack echoes 1–3 words copied
  from the user's own transcript ("אה, ביומן מחר, שנייה."); the topic is rule-based (`ackTopic`: the
  first content words, skipping question/request words, pronouns, the persona's name and digits).
- Silence is a valid ack: on a short turn that asks for no work (likely fast) it is sometimes skipped.
- Never the same phrase within the last 5 acks; "good question" only after a question; Hebrew forms
  follow `persona_gender`; the bare "בודק" is rare (low weight), not the default.
- A guard (`verifyAck`) drops any ack longer than 8 words or with a word that is neither the bank's
  nor the user's own, so no new fact, number, time or name can be spoken.

**Speaker labels (v0.8).** A leading `<persona>:` label on a line of Hermes' reply ("ריי: כן, זה
אפשרי", `**Ray:**`, also `Hermes:`) is stripped before the text reaches the voice, and a piece that
is only the persona's name ("ריי") is not read. A colon elsewhere ("השעה: 10") is untouched.

**Barge-in and corrections.** Speech during a reply stops playback, and what is left of that reply
is held for up to 2.5 s until the user's words are known. A backchannel ("ok", "כן") or noise
resumes it. Anything substantive drops it and goes to Hermes as a new turn on the same chat (Hermes
core queues it after, or steers, the running turn, so it acts as a follow-up or correction).
"Stop" drops everything queued.

**Fast-answer hint.** Each delegated turn adds a model-only line to `voice_context`: *answer first
in one short spoken sentence, then add detail only if needed; don't deliberate at length unless
the question requires it.* `prompt.submit` has no per-turn reasoning-effort field (it reads
`text`, `surface`, `voice_context`, `voice_turn` and display fields; `reasoning_effort` is only a
per-session override on session create, which would change the chat for typed turns too), so the
note is the only hint. The model is not changed.

**Latency trade-off.** Every substantive turn waits for the chat model instead of a voice model
that answers in about 0.5 s. Baseline before streaming (agent.log, prompt received → reply ready,
`voice-live` turns, measured by Ray): about 3–7 s for simple turns, about 12 s with a short tool
check, about 46 s with longer tool work. Streaming moves first audio to "first sentence written +
voice TTS start". The target is about 2–3 s after the user stops on simple questions; the short
ack covers anything slower. Greetings, acks, "repeat" and "stop" stay local and instant. If you
prefer speed over always getting the chat model's answer, set `brain: voice`.

**Measuring.** The renderer logs one line per delegated turn to the gateway log, with numbers only:

```
gemini-live-chat: voice latency provider=gemini-free brain=hermes kind=turn eos->submit=412ms eos->first_text=2310ms eos->first_audio=1310ms eos->first_answer_audio=2890ms ack=yes silence_ms=1000
```

`eos` is the provider's end-of-speech signal, so add `silence_ms` to get "user stopped talking →
first audio". `kind=abandoned` marks a turn superseded before it got an answer. Compare these lines
before and after a change; the measured numbers belong here once Ray has a call's worth of lines.

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
   `plugin.gemini-live-chat.wake.detected {token}` to every window.
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
  switch the recent spoken turns also go to the next one. Nothing else leaves the machine.
- Reads: `GEMINI_API_KEY` and `GEMINI_API_KEY_PAID` through Hermes' secret scope, this plugin's own settings, and the first
  16 KB of the profile's `SOUL.md` to take the agent's **name** (and an explicitly stated gender).
  Only the name is sent to the voice provider; the SOUL text is not. The Codex token is never
  read by the plugin (Hermes core signs the one request).
- Writes: call transcripts in the plugin's Desktop data folder (`ctx.files`, `data`), and one
  queued turn per call in the open chat (unless `transcript_to_chat` says otherwise).
- No shell commands, no background processes, no telemetry, no self-update.

### Issue log

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

## Limitations

- **The transcript note is a turn.** The Desktop SDK has no supported way to append a non-turn
  note to a chat, so `chat_turn` submits the transcript as a normal queued turn (a small extra
  model call) in which Hermes looks for anything the call missed. Set `file` to avoid it.
- **Results wait for a pause.** A Hermes reply is handed to the voice (`realtimeInput.text`) when it
  next stops speaking and you are not talking, or after 4 s with no audio if a model turn never
  closes. Parts of a long reply follow one per model turn (or after 8 s if a turn never closes).
- **Faithful, not verbatim.** The voice model is told to speak the content completely and may
  rephrase or translate it; it is a language model, so wording can differ from the chat. Every assistant
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
python -m pytest -q                   # 151 tests: minting, chain, fallback, routes, persona, wake word, restart
node --test 'tests/js/*.test.mjs'     # 124 tests: delegation, hand-off, barge-in, transcript, transports, wake, ack, labels
hermes plugins validate . --install-deps
```

The JavaScript tests drive `desktop/plugin.js` with a fake SDK, fake WebSocket, fake WebRTC (peer
connection, data channel, SDP fetch) and fake audio, so neither a key, a Codex sign-in nor a
microphone is needed. The Python route tests stand in for Hermes core's signer. CI (`.github/workflows/ci.yml`) runs both suites on every
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
- **hermes-live-voice** by Synero: the OpenAI Realtime client-secret body and WebRTC/SDP flow on
  the Codex sign-in were checked against it. Its `codex app-server` child process is **not** used.
- Delegation policy persona follows Hermes core `tools/voice_live.py`.
- New here: Gemini ephemeral-token flow with a locked setup, delegation into the open chat with
  Gemini, Hebrew-first language switching, transcript persistence, `goAway` resumption, and the
  generation-guarded stop path with its tests.

Both upstream projects are MIT-licensed (checked at the commits named above). Their copyright
notices are kept in `LICENSE`.

## License

MIT. See `LICENSE`.
