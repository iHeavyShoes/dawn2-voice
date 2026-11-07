// gemini-live-chat — full-duplex live voice in the Hermes Desktop composer, on a provider chain:
// Gemini Live (free key) -> OpenAI Realtime on the ChatGPT/Codex sign-in -> Gemini Live (paid key).
//
// Uncompiled ESM, one file: the loader resolves only @hermes/plugin-sdk and react, so every element
// goes through createElement. No credential ever reaches this window: the backend half
// (dashboard/plugin_api.py) walks the chain and mints a short-lived session on the first provider
// that can serve (a single-use Gemini token whose setup is locked server-side, or an OpenAI
// ephemeral client secret Hermes core signed for). This file opens that provider's transport (a
// WebSocket for Gemini, WebRTC for OpenAI); everything above the transport is shared (see
// TRANSPORTS). When the serving provider fails mid-call, `failover` reconnects the same call to the
// next provider with the recent spoken turns as context.
//
// Delegation (the point of this plugin): the voice model has one work tool, `hermes_task`. Each call
// becomes a normal `prompt.submit` on the chat that was open when the call started, with
// surface 'voice-live' and the recent spoken turns as `voice_context` — the same seam Hermes core's
// GPT-Live uses. The request and Hermes' answer are therefore ordinary rows in that chat. The turn's
// `message.complete` text goes back to the voice as a "[Hermes result]" text input it says aloud:
// the whole reply, made speakable (no markdown, code or URLs) and cut into parts the voice reads one
// model turn at a time, so a long answer is spoken in full instead of being summarised away.
//
// Structure adapted from hermes-xai's voice module (MIT, Julien Talbot); Gemini Live wire facts from
// hermes-gemini-live (MIT, Ha Trung). See README "Credits".
import { host, icons } from '@hermes/plugin-sdk'
import { createElement as h, useEffect, useState } from 'react'

export const PLUGIN_ID = 'gemini-live-chat'
export const IN_RATE = 16000 // Gemini Live input: 16 kHz PCM16 mono
export const OUT_RATE = 24000 // Gemini Live output: 24 kHz PCM16 mono
const IN_MIME = 'audio/pcm;rate=16000'
export const CONTEXT_TURNS = 12
export const PART_CHARS = 1200 // ~1 minute of speech per part; one part per model turn
export const MAX_PARTS = 8 // ~10 minutes; anything longer is left in the chat, and the voice says so
export const REST_IN_CHAT = '[The rest of this answer is only in the chat.]'
const HANGUP_GRACE_MS = 2500
const STALL_MS = 4000 // an open model turn with no audio for this long no longer holds results back
const AWAIT_MS = 8000 // a handed part that gets no answer this long no longer holds the next one back
const USER_QUIET_MS = 1200 // nothing is handed over while the user was heard this recently
const FLUSH_RETRY_MS = 1000
export const RESULT_TAG = '[Hermes result]'
// The function call is answered at once (NON_BLOCKING) so the model keeps talking; the real result
// follows as a "[Hermes result]" text input, from this turn or any later one on the pinned chat.
// v0.3: the receipt forbids any content of the voice's own while the request is open (it told its
// own joke while Hermes wrote a different one) and asks for a present-tense acknowledgement only.
export const RECEIPT = 'WORK_STARTED: the whole request is in the open chat and is being worked on. Acknowledge it once, in a few words and in the present tense (for example "I\'m checking"). Do not answer any part of it yourself: no joke, explanation, fact, guess or opinion of your own; the user must hear the answer from the chat. Do not repeat that you are waiting. The answer arrives as a "[Hermes result]" message, possibly after a minute or more; speak it in full then.'
// Hermes' intentional-silence sentinels (gateway/response_filters.py LIVE_GATEWAY_SILENT_MARKERS,
// the autonomous-lane rule): a reply that is one of these, or has one as its own first or last line,
// or opens with a bracketed one, is not for the user and is never handed to the voice.
export const SILENT_MARKERS = ['[SILENT]', 'SILENT', 'NO_REPLY', 'NO REPLY', '[静默]', '静默', '[沉默]', '沉默']
export const TRANSCRIPT_HEADER = '[Voice call transcript (live voice). Check it for any request the user made during the call that was not delegated or not answered in this chat; if you find one, tell the user or handle it. If nothing was missed, reply with one short line.]'

const WORKLET = `
class GlcCapture extends AudioWorkletProcessor {
  process (inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('gemini-live-chat-capture', GlcCapture)
`

// ── pure helpers (unit tested) ───────────────────────────────────────────────────────────────────

export function resample (input, fromRate, toRate) {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const at = i * ratio
    const lo = Math.floor(at)
    const hi = Math.min(lo + 1, input.length - 1)
    const frac = at - lo
    out[i] = input[lo] * (1 - frac) + input[hi] * frac
  }
  return out
}

export function floatToB64 (float32) {
  const pcm = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const bytes = new Uint8Array(pcm.buffer)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export function b64ToPcm (text) {
  const bin = atob(text)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1)
}

function textOf (value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

// ── result hand-off (v0.3, unit tested) ──────────────────────────────────────────────────────────

const EDGE_PUNCT = /^[\s.,!?:;~*_`'"()。！？：；，、]+|[\s.,!?:;~*_`'"()。！？：；，、]+$/g
const MARKER_FORMS = new Set(SILENT_MARKERS)

function isMarker (line) {
  const t = line.trim()
  if (!t || t.length > 40) return false
  const up = t.toUpperCase()
  return MARKER_FORMS.has(up) || MARKER_FORMS.has(up.replace(EDGE_PUNCT, '')) ||
    MARKER_FORMS.has(`[${up.replace(EDGE_PUNCT, '').replace(/^\[|\]$/g, '')}]`)
}

export function isSilent (text) {
  const stripped = String(text || '').trim()
  if (!stripped) return false
  const upper = stripped.toUpperCase()
  if (SILENT_MARKERS.some(m => m.startsWith('[') && upper.startsWith(m))) return true
  const lines = stripped.split('\n').filter(l => l.trim())
  return [stripped, lines[0], lines[lines.length - 1]].some(isMarker)
}

// Markdown to plain speakable text. Content is kept; only formatting goes. Code and URLs are not
// read out character by character: a short marker tells the voice they are in the chat.
export function speakable (text) {
  let t = String(text || '').replace(/\r\n?/g, '\n')
  t = t.replace(/```[\s\S]*?(```|$)/g, '\n[code: see the chat]\n')
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')
  t = t.replace(/<?https?:\/\/[^\s>)]+>?/g, '[link in the chat]')
  t = t.replace(/`([^`\n]+)`/g, '$1')
  const lines = []
  for (let line of t.split('\n')) {
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue // table rule
    if (/^\s*([-*_]\s*){3,}$/.test(line)) continue // horizontal rule
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean).join(', ')
    line = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>\s?/, '').replace(/^\s*[-*+•]\s+(\[[ xX]\]\s+)?/, '')
    line = line.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|[\s(])[*_]([^*_\n]+?)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    lines.push(line.trim())
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function splitLong (piece, size) {
  const out = []
  let cur = ''
  for (const s of piece.split(/(?<=[.!?。…])\s+/)) {
    if (s.length > size) { // one huge sentence: cut at spaces
      if (cur) { out.push(cur); cur = '' }
      let rest = s
      while (rest.length > size) {
        let at = rest.lastIndexOf(' ', size)
        if (at < size / 2) at = size
        out.push(rest.slice(0, at).trim())
        rest = rest.slice(at).trim()
      }
      cur = rest
    } else if (cur && cur.length + 1 + s.length > size) {
      out.push(cur)
      cur = s
    } else cur = cur ? `${cur} ${s}` : s
  }
  if (cur) out.push(cur)
  return out
}

// Parts of at most `size` characters, cut at paragraph, then sentence, then word boundaries.
// Nothing is dropped: the parts together hold every word of the text, in order.
export function splitParts (text, size = PART_CHARS) {
  const parts = []
  let cur = ''
  for (const para of String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)) {
    for (const piece of (para.length > size ? splitLong(para, size) : [para])) {
      if (cur && cur.length + 2 + piece.length > size) {
        parts.push(cur)
        cur = piece
      } else cur = cur ? `${cur}\n\n${piece}` : piece
    }
  }
  if (cur) parts.push(cur)
  return parts
}

// The realtimeInput.text messages for one Hermes reply: none for a silent reply, one
// "[Hermes result] ..." for a short one, "[Hermes result k/n] ..." parts for a long one.
export function resultMessages (text) {
  if (isSilent(text)) return []
  const body = speakable(text)
  if (!body || isSilent(body)) return []
  let parts = splitParts(body)
  if (parts.length > MAX_PARTS) {
    parts = parts.slice(0, MAX_PARTS)
    parts[MAX_PARTS - 1] += `\n\n${REST_IN_CHAT}`
  }
  if (parts.length === 1) return [`${RESULT_TAG} ${parts[0]}`]
  return parts.map((p, i) => `[Hermes result ${i + 1}/${parts.length}] ${p}`)
}

export function formatTranscript (turns) {
  return turns.map(t => `${t.role === 'user' ? 'User' : 'Voice'}: ${t.text}`).join('\n')
}

// ── injectable environment (tests replace it) ────────────────────────────────────────────────────

const defaultEnv = () => ({
  WebSocket: globalThis.WebSocket,
  AudioContext: globalThis.AudioContext,
  AudioWorkletNode: globalThis.AudioWorkletNode,
  RTCPeerConnection: globalThis.RTCPeerConnection,
  fetch: (...a) => globalThis.fetch(...a),
  createAudio: () => new globalThis.Audio(),
  getUserMedia: c => globalThis.navigator.mediaDevices.getUserMedia(c),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: id => globalThis.clearTimeout(id),
  now: () => Date.now()
})
let env = null
const E = () => env || (env = defaultEnv())
export function setEnv (overrides) { env = { ...defaultEnv(), ...overrides } }

const MIC_CONSTRAINTS = { audio: { channelCount: 1, autoGainControl: true, echoCancellation: true, noiseSuppression: true } }

// ── audio (Gemini transport: PCM over the socket) ────────────────────────────────────────────────

async function startMic (onFrame, isLive) {
  const stream = await E().getUserMedia(MIC_CONSTRAINTS)
  if (!isLive()) { // the call was stopped while the permission prompt was open
    stream.getTracks().forEach(t => t.stop())
    return null
  }
  // The device rate is kept (Firefox refuses a source/context rate mismatch); frames are resampled.
  const context = new (E().AudioContext)()
  let node = null
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    try { await context.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }
    node = new (E().AudioWorkletNode)(context, 'gemini-live-chat-capture')
  } catch (error) {
    stream.getTracks().forEach(t => t.stop())
    void context.close().catch(() => {})
    throw error
  }
  const rate = context.sampleRate
  let pending = []
  let size = 0
  node.port.onmessage = ({ data }) => {
    pending.push(data)
    size += data.length
    if (size < rate / 10) return // ~100 ms per chunk
    const frame = new Float32Array(size)
    let at = 0
    for (const part of pending) { frame.set(part, at); at += part.length }
    pending = []
    size = 0
    onFrame(resample(frame, rate, IN_RATE))
  }
  const source = context.createMediaStreamSource(stream)
  source.connect(node)
  void context.resume?.()
  return () => {
    node.port.onmessage = null
    try { source.disconnect() } catch { /* gone */ }
    try { node.disconnect() } catch { /* gone */ }
    stream.getTracks().forEach(t => t.stop())
    void context.close().catch(() => {})
  }
}

function createPlayer () {
  const context = new (E().AudioContext)({ sampleRate: OUT_RATE })
  let next = 0
  const live = new Set()
  void context.resume?.()
  return {
    play (pcm) {
      const buffer = context.createBuffer(1, pcm.length, OUT_RATE)
      const ch = buffer.getChannelData(0)
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000
      const node = context.createBufferSource()
      node.buffer = buffer
      node.connect(context.destination)
      next = Math.max(next, context.currentTime)
      node.start(next)
      next += buffer.duration
      live.add(node)
      node.onended = () => live.delete(node)
    },
    playing () { return live.size > 0 },
    flush () {
      live.forEach(n => { try { n.stop() } catch { /* already ended */ } })
      live.clear()
      next = 0
    },
    close () { this.flush(); void context.close().catch(() => {}) }
  }
}

// ── providers and fallback (v0.4) ────────────────────────────────────────────────────────────────

export const PROVIDER_LABELS = {
  'gemini-free': 'Gemini (free key)',
  'openai-codex': 'ChatGPT (Codex subscription)',
  'gemini-paid': 'Gemini (paid key)'
}
export const MAX_SWITCHES = 3 // per call: at most once through the whole default chain
export const COOLDOWN_MS = 15 * 60 * 1000 // a provider that refused for quota/auth is skipped this long
// Handed to the new voice right after a mid-call switch (ahead of any queued result).
export const SWITCH_NOTE = '[Voice provider switched] The call just moved to another voice provider because the previous one failed. Tell the user so in one short sentence in their language (for example "switching voice provider"), then continue where the conversation was. Do not greet again.'
const OPENAI_ORIGIN = 'https://api.openai.com/'
const cooldown = new Map() // provider id -> until (ms)
export function cooledProviders () {
  const now = E().now()
  for (const [id, until] of cooldown) if (until <= now) cooldown.delete(id)
  return [...cooldown.keys()]
}
export function resetCooldown () { cooldown.clear() }

// Why a live connection failed, from a close reason / vendor error text and a close or HTTP code.
// The words match the backend's REASONS (gemini_live_chat/providers.py).
export function failureReason (text, code) {
  const t = String(text || '').toLowerCase()
  if (code === 429 || /quota|resource_exhausted|rate.?limit|usage limit|insufficient_quota/.test(t)) return 'quota'
  if (code === 401 || code === 403 || /api key|api_key|unauthori[sz]ed|permission_denied|forbidden|invalid_api_key/.test(t)) return 'auth'
  if (/expired/.test(t)) return 'expired'
  if (code >= 500 && code < 600) return 'unavailable'
  if (code === 1008 || code === 400) return 'rejected'
  return 'network'
}

// ── the call (module scope: a composer row remounts on navigation, the call must not) ────────────

export const call = {
  state: 'idle', // idle | connecting | live
  detail: '',
  gen: 0, // bumped by every start, stop and provider switch; stale async work checks it and backs out
  provider: null, // { id, label, transport, model } of the provider serving now
  ws: null, // gemini-live: the Live socket
  standby: null, // gemini-live: the replacement socket while resuming after goAway
  stopMic: null, // gemini-live: releases the PCM microphone
  player: null, // gemini-live: PCM playback
  rtc: null, // openai-realtime: { pc, dc, stream, audio, open, speaking, responding, needResponse }
  sessionId: null,
  resumeHandle: null,
  modelSpeaking: false,
  hangUp: false,
  hangTimer: null,
  flushTimer: null,
  lastAudioAt: 0,
  lastHeardAt: 0, // when the user's speech was last transcribed
  queue: [], // [{ text, group }] result messages not yet handed to the voice, one per model turn
  group: 0, // id of the last enqueued reply; every part of one reply shares it
  speakingGroup: 0, // the reply whose part was handed last (barge-in drops its remaining parts)
  handing: false, // a part was handed and the model's turn for it has not completed yet
  handedAt: 0,
  lastHanded: null, // the part handed last (re-handed when the provider fails before answering it)
  interim: [], // message.interim text of the Hermes turn in progress on the pinned chat
  turns: [], // [{ role: 'user'|'assistant', text }]
  partial: { user: '', assistant: '' },
  delegations: 0,
  tried: [], // providers that failed on this call (never retried on it)
  switches: 0,
  switching: false,
  providersUsed: [], // labels, in order, for the transcript
  settings: null,
  ctx: null,
  listeners: new Set()
}
const publish = () => call.listeners.forEach(fn => { try { fn() } catch { /* isolated */ } })

function sendOn (ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
}
const send = msg => sendOn(call.ws, msg)
function rtcSend (msg) {
  const dc = call.rtc && call.rtc.dc
  if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg))
}

// ── transport abstraction ────────────────────────────────────────────────────────────────────────
// Everything above the transports (delegation, result hand-off, barge-in bookkeeping, transcript,
// hang-up) is shared; a transport only knows how to move text, tool answers and audio on its wire.

const TRANSPORTS = {
  'gemini-live': {
    connected: () => !!call.ws,
    playing: () => !!(call.player && call.player.playing()),
    handText: text => send({ realtimeInput: { text } }),
    answerTools: responses => send({ toolResponse: { functionResponses: responses } }),
    stopPlayback: () => { call.player && call.player.flush() }
  },
  'openai-realtime': {
    connected: () => !!(call.rtc && call.rtc.open),
    playing: () => !!(call.rtc && call.rtc.speaking),
    handText: text => {
      rtcSend({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
      rtcSend({ type: 'response.create' })
      if (call.rtc) call.rtc.responding = true
    },
    answerTools: responses => {
      for (const r of responses) {
        const out = r.response && 'result' in r.response ? r.response.result : JSON.stringify(r.response || {})
        rtcSend({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: r.id, output: String(out) } })
        if (r.name !== 'end_call' && call.rtc) call.rtc.needResponse = true
      }
    },
    // The server stops its own audio on barge-in (interrupt_response); this clears what is buffered.
    stopPlayback: () => rtcSend({ type: 'output_audio_buffer.clear' })
  }
}
const T = () => TRANSPORTS[(call.provider && call.provider.transport) || 'gemini-live']
export const connected = () => T().connected()

function remember (role, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return
  call.turns.push({ role, text: t })
}

function flushPartial (role) {
  if (call.partial[role]) { remember(role, call.partial[role]); call.partial[role] = '' }
}

// Recent turns plus whatever is still being spoken (not flushed: a mid-sentence tool call must not
// split the transcript row).
export function voiceContext () {
  const turns = call.turns.slice()
  for (const role of ['user', 'assistant']) {
    const t = call.partial[role].replace(/\s+/g, ' ').trim()
    if (t) turns.push({ role, text: t })
  }
  return formatTranscript(turns.slice(-CONTEXT_TURNS)).slice(-6000)
}

function detach (ws) {
  if (!ws) return
  ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
  try { ws.close(1000, 'hang up') } catch { /* closed */ }
}

function closeRealtime () {
  const rtc = call.rtc
  if (!rtc) return
  call.rtc = null
  if (rtc.dc) {
    rtc.dc.onopen = rtc.dc.onmessage = rtc.dc.onclose = null
    try { rtc.dc.close() } catch { /* closed */ }
  }
  if (rtc.pc) {
    rtc.pc.ontrack = rtc.pc.onconnectionstatechange = null
    try { rtc.pc.close() } catch { /* closed */ }
  }
  if (rtc.stream) rtc.stream.getTracks().forEach(t => t.stop())
  if (rtc.audio) {
    try { rtc.audio.pause() } catch { /* not playing */ }
    rtc.audio.srcObject = null
  }
}

// Releases the provider connection and its audio, synchronously, and keeps the conversation
// (turns, queue, open delegations, pinned chat): used by tearDown and by a provider switch.
function releaseTransport () {
  const ws = call.ws
  const standby = call.standby
  call.ws = null
  call.standby = null
  detach(ws)
  detach(standby)
  if (call.stopMic) { const stop = call.stopMic; call.stopMic = null; stop() }
  if (call.player) { call.player.close(); call.player = null }
  closeRealtime()
  if (call.flushTimer) { E().clearTimeout(call.flushTimer); call.flushTimer = null }
  flushPartial('user')
  flushPartial('assistant')
  Object.assign(call, { modelSpeaking: false, resumeHandle: null, lastAudioAt: 0 })
}

async function saveTranscript (ctx, sid, turns, mode, used) {
  if (!turns.length || mode === 'off') return
  const via = used.length ? `Voice provider: ${used.join(' -> ')}\n\n` : ''
  const body = formatTranscript(turns)
  const stamp = new Date(E().now()).toISOString().replace(/[:.]/g, '-')
  if (ctx && ctx.files && typeof ctx.files.writeText === 'function') {
    try { await ctx.files.writeText('data', `transcript-${stamp}.md`, `# Live voice call ${stamp}\n\n${via}${body}\n`) } catch { /* best effort */ }
  }
  if (mode !== 'chat_turn' || !sid) return
  try {
    // A normal queued turn: if Hermes is still working on a delegation, it runs after it.
    await host.request('prompt.submit', { session_id: sid, text: `${TRANSCRIPT_HEADER}\n\n${via}${body}`, queued: true })
  } catch (error) {
    host.notify({ kind: 'warning', message: 'Could not save the call transcript to the chat', detail: String(error && error.message ? error.message : error) })
  }
}

// Idempotent. Releases every resource the call holds, synchronously: sockets, the peer connection,
// the microphone tracks and its AudioContext, the player, the timers. Nothing survives it.
export function tearDown (note) {
  const wasActive = call.state !== 'idle'
  const ctx = call.ctx
  const sid = call.sessionId
  call.gen += 1
  releaseTransport()
  const turns = call.turns.slice()
  const used = call.providersUsed.slice()
  if (call.hangTimer) { E().clearTimeout(call.hangTimer); call.hangTimer = null }
  Object.assign(call, {
    state: 'idle', modelSpeaking: false, hangUp: false, queue: [], handing: false, handedAt: 0, lastHanded: null,
    interim: [], turns: [], lastAudioAt: 0, lastHeardAt: 0, speakingGroup: 0, provider: null, switching: false,
    partial: { user: '', assistant: '' }, delegations: 0, resumeHandle: null, tried: [], switches: 0, providersUsed: []
  })
  if (note !== undefined) call.detail = note
  publish()
  if (wasActive) void saveTranscript(ctx, sid, turns, (call.settings && call.settings.transcript_to_chat) || 'chat_turn', used)
}

// The model counts as quiet when the user is not talking, no handed part is still waiting for its
// answer (AWAIT_MS), and no turn is open, or an open turn has sent no audio for STALL_MS and nothing
// is still playing: a turn whose turnComplete never arrives (async reasoning, a lost frame) must not
// hold a Hermes result back for the rest of the call.
function modelQuiet () {
  const now = E().now()
  if (call.lastHeardAt && now - call.lastHeardAt < USER_QUIET_MS) return false
  if (call.handing && now - Math.max(call.handedAt, call.lastAudioAt) < AWAIT_MS) return false
  if (call.rtc && call.rtc.responding && now - Math.max(call.handedAt, call.lastAudioAt) < AWAIT_MS) return false
  if (!call.modelSpeaking) return true
  if (T().playing()) return false
  return now - call.lastAudioAt >= STALL_MS
}

function armFlushRetry () {
  if (call.flushTimer || !call.queue.length || !connected()) return
  call.flushTimer = E().setTimeout(() => { call.flushTimer = null; flushResults() }, FLUSH_RETRY_MS)
}

// Queue one Hermes reply for the voice. Returns the number of messages queued (0: silent or empty).
export function enqueueResult (text) {
  const messages = resultMessages(text)
  if (!messages.length) return 0
  call.group += 1
  for (const m of messages) call.queue.push({ text: m, group: call.group })
  flushResults()
  return messages.length
}

// Hands over ONE queued message, only while the model is quiet; the next one follows when the
// model's answer to it completes, so the voice reads a long reply part by part instead of
// summarising one big block (and a new part never cuts the previous one off). While a provider
// switch is under way the queue simply waits for the next transport.
export function flushResults () {
  if (!call.queue.length || !connected()) return
  if (!modelQuiet()) { armFlushRetry(); return }
  const item = call.queue.shift()
  call.modelSpeaking = false
  call.handing = true
  call.handedAt = E().now()
  call.lastHanded = item
  call.speakingGroup = item.group
  T().handText(item.text)
  armFlushRetry() // the next part normally follows on turn completion; this covers a lost one
}

// Barge-in on a long answer: the rest of the reply being read is dropped (it stays in the chat).
function dropSpeakingRest () {
  if (!call.speakingGroup) return
  call.queue = call.queue.filter(i => i.group !== call.speakingGroup)
  call.speakingGroup = 0
  call.lastHanded = null
}

export async function delegate (request) {
  const sid = call.sessionId
  if (!sid) {
    enqueueResult('No chat is open, so the request could not be handed to Hermes.')
    return { ok: false }
  }
  call.delegations += 1
  publish()
  try {
    const res = await host.request('prompt.submit', {
      session_id: sid, text: request, surface: 'voice-live', voice_context: voiceContext()
    })
    return { ok: true, status: res && res.status }
  } catch (error) {
    call.delegations = Math.max(0, call.delegations - 1)
    enqueueResult(`The request did not reach Hermes: ${error && error.message ? error.message : String(error)}`)
    publish()
    return { ok: false }
  }
}

// calls: [{ id, name, args }] from either transport.
function onToolCall (calls) {
  const responses = []
  for (const fc of calls || []) {
    const id = String(fc.id || '')
    const name = String(fc.name || '')
    const args = fc.args || {}
    if (name === 'hermes_task') {
      const request = String(args.request || '').trim()
      if (request) void delegate(request)
      // No FunctionResponse.scheduling: the docs disagree on where it goes (reference: top level;
      // Live tools guide: inside `response`) and it was not measured against the live endpoint.
      responses.push({ id, name, response: { result: request ? RECEIPT : 'No request text was given.' } })
    } else if (name === 'end_call') {
      call.hangUp = true
      responses.push({ id, name, response: { result: 'OK' } })
      if (!call.hangTimer) call.hangTimer = E().setTimeout(() => tearDown(''), HANGUP_GRACE_MS)
    } else {
      responses.push({ id, name, response: { error: 'unknown tool' } })
    }
  }
  if (responses.length) T().answerTools(responses)
}

// Barge-in bookkeeping shared by both transports (the audio itself is stopped by the transport).
function onBargeIn () {
  T().stopPlayback()
  call.modelSpeaking = false
  call.handing = false
  dropSpeakingRest()
  flushPartial('assistant')
  armFlushRetry() // other replies wait until the user has finished (USER_QUIET_MS)
}

// The provider connection is ready: the call is live (again).
function onReady () {
  if (call.state !== 'connecting') return false
  call.state = 'live'
  if (call.switching) {
    call.switching = false
    call.detail = ''
    call.queue.unshift({ text: SWITCH_NOTE, group: 0 })
  }
  publish()
  flushResults()
  return true
}

// ── gemini-live transport ────────────────────────────────────────────────────────────────────────

function transcriptOf (msg, content, field) {
  const v = (content && content[field]) || msg[field]
  return v && typeof v.text === 'string' ? v.text : ''
}

export function receive (msg, ws) {
  if (!msg || typeof msg !== 'object') return
  if (msg.setupComplete !== undefined) {
    if (ws === call.standby) { // resumed socket is ready: swap, then drop the old one
      const old = call.ws
      call.ws = ws
      call.standby = null
      detach(old)
    }
    if (onReady()) void attachMic()
    return
  }
  if (ws !== call.ws) return // frames from a socket being replaced
  const content = msg.serverContent
  if (content) {
    if (content.interrupted) onBargeIn() // the server's VAD already stopped generation
    const parts = (content.modelTurn && content.modelTurn.parts) || []
    for (const part of parts) {
      const inline = part.inlineData
      if (inline && inline.data) {
        call.modelSpeaking = true
        call.lastAudioAt = E().now()
        call.player && call.player.play(b64ToPcm(inline.data))
      }
    }
  }
  const heard = transcriptOf(msg, content, 'inputTranscription')
  if (heard) {
    call.lastHeardAt = E().now()
    // The server finishes generating long before playback ends; speech heard while buffered audio
    // still plays gets no "interrupted" from the server, so it is stopped here.
    if (!call.modelSpeaking && call.player && call.player.playing()) {
      call.player.flush()
      dropSpeakingRest()
    }
    flushPartial('assistant')
    call.partial.user += heard
  }
  const said = transcriptOf(msg, content, 'outputTranscription')
  if (said) { flushPartial('user'); call.partial.assistant += said }
  if (content && content.turnComplete) {
    flushPartial('user')
    flushPartial('assistant')
    call.modelSpeaking = false
    call.handing = false
    if (call.hangUp) { tearDown(''); return }
    flushResults()
  }
  if (msg.toolCall) onToolCall(msg.toolCall.functionCalls)
  if (msg.sessionResumptionUpdate && msg.sessionResumptionUpdate.resumable && msg.sessionResumptionUpdate.newHandle) {
    call.resumeHandle = String(msg.sessionResumptionUpdate.newHandle)
  }
  if (msg.goAway) void resume()
  if (msg.error) {
    const text = String(msg.error.message || 'Gemini Live error')
    const reason = failureReason(text, msg.error.code)
    if (reason === 'quota' || reason === 'auth') { void failover(reason, text); return }
    call.detail = text
    publish()
  }
}

function decode (data) {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data)
  return ''
}

function openSocket (minted, gen) {
  const ws = new (E().WebSocket)(minted.url)
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => { if (call.gen === gen) sendOn(ws, minted.setup) }
  ws.onmessage = ({ data }) => {
    if (call.gen !== gen) return
    let msg
    try { msg = JSON.parse(decode(data)) } catch { return }
    receive(msg, ws)
  }
  ws.onclose = ev => {
    if (call.gen !== gen) return
    if (ws === call.standby) { call.standby = null; return } // resume failed; the old socket still runs until it dies
    if (ws !== call.ws) return
    const note = call.detail || closeNote(ev)
    // A normal close (1000) or a close after end_call ends the call; anything else (quota, auth,
    // server error, network) moves the call to the next provider.
    if (ev && ev.code !== 1000 && !call.hangUp) void failover(failureReason(ev.reason, ev.code), note)
    else tearDown(note)
  }
  ws.onerror = () => {}
  return ws
}

function closeNote (ev) {
  if (!ev || ev.code === 1000) return 'The voice call ended'
  return `The voice call closed (${ev.code}${ev.reason ? ': ' + ev.reason : ''})`
}

async function mint (ctx, body) {
  return ctx.rest('/session', { method: 'POST', body })
}

async function resume () {
  const ctx = call.ctx
  const gen = call.gen
  if (!call.resumeHandle || call.standby || !ctx) return
  try {
    // A handle belongs to the key that issued it: resume on the same provider, never fall back.
    const minted = await mint(ctx, { resume_handle: call.resumeHandle, provider: call.provider && call.provider.id })
    if (call.gen !== gen) return
    call.standby = openSocket(minted, gen)
  } catch { /* the old socket keeps going until Google closes it, then the call fails over */ }
}

async function attachMic () {
  const gen = call.gen
  try {
    const stop = await startMic(frame => {
      if (call.settings && call.settings.half_duplex && call.player && call.player.playing()) return
      send({ realtimeInput: { audio: { mimeType: IN_MIME, data: floatToB64(frame) } } })
    }, () => call.gen === gen)
    if (!stop) return
    if (call.gen !== gen) { stop(); return }
    call.stopMic = stop
  } catch (error) {
    if (call.gen === gen) tearDown('Microphone unavailable: ' + (error && error.message ? error.message : String(error)))
  }
}

// ── openai-realtime transport (WebRTC; the Codex subscription route) ─────────────────────────────
// The backend minted a short-lived client secret with Hermes' openai-codex sign-in; it is used once,
// as the bearer of the SDP offer to api.openai.com, and never stored. Audio flows over the peer
// connection, events over the "oai-events" data channel.

async function openRealtime (minted, gen) {
  const rtc = { pc: null, dc: null, stream: null, audio: null, open: false, speaking: false, responding: false, needResponse: false }
  call.rtc = rtc
  const current = () => call.gen === gen && call.rtc === rtc
  if (typeof minted.offer_url !== 'string' || !minted.offer_url.startsWith(OPENAI_ORIGIN) || !minted.client_secret) {
    void failover('rejected', 'Unexpected OpenAI session from the backend')
    return
  }
  let stream
  try {
    stream = await E().getUserMedia(MIC_CONSTRAINTS)
  } catch (error) {
    if (current()) tearDown('Microphone unavailable: ' + (error && error.message ? error.message : String(error)))
    return
  }
  if (!current()) { stream.getTracks().forEach(t => t.stop()); return } // stopped during the permission prompt
  rtc.stream = stream
  const pc = new (E().RTCPeerConnection)()
  rtc.pc = pc
  stream.getTracks().forEach(t => pc.addTrack(t, stream))
  pc.ontrack = ev => {
    if (!current()) return
    const audio = E().createAudio()
    audio.autoplay = true
    audio.srcObject = (ev.streams && ev.streams[0]) || null
    rtc.audio = audio
    try { void Promise.resolve(audio.play && audio.play()).catch(() => {}) } catch { /* autoplay refused */ }
  }
  pc.onconnectionstatechange = () => {
    if (current() && pc.connectionState === 'failed') void failover('network', 'The voice connection was lost')
  }
  const dc = pc.createDataChannel('oai-events')
  rtc.dc = dc
  dc.onopen = () => { if (current()) { rtc.open = true; onReady() } }
  dc.onmessage = ({ data }) => {
    if (!current()) return
    let msg
    try { msg = JSON.parse(decode(data)) } catch { return }
    receiveRealtime(msg)
  }
  dc.onclose = () => {
    if (!current()) return
    if (call.hangUp) tearDown('')
    else void failover('network', 'The voice connection closed')
  }
  try {
    const offer = await pc.createOffer()
    if (!current()) return
    await pc.setLocalDescription(offer)
    if (!current()) return
    const res = await E().fetch(`${minted.offer_url}?model=${encodeURIComponent(minted.model || '')}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${minted.client_secret}`, 'Content-Type': 'application/sdp' },
      body: offer.sdp
    })
    if (!current()) return
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      if (current()) void failover(failureReason(text, res.status), `OpenAI refused the call (${res.status})`)
      return
    }
    const sdp = await res.text()
    if (!current()) return
    await pc.setRemoteDescription({ type: 'answer', sdp })
  } catch (error) {
    if (current()) void failover('network', 'Could not connect to OpenAI Realtime: ' + (error && error.message ? error.message : String(error)))
  }
}

// OpenAI Realtime server events (GA names), mapped onto the shared call logic.
export function receiveRealtime (msg) {
  const rtc = call.rtc
  if (!msg || typeof msg !== 'object' || !rtc) return
  const now = E().now()
  switch (msg.type) {
    case 'input_audio_buffer.speech_started': // barge-in: the server already cut its response
      call.lastHeardAt = now
      if (call.modelSpeaking || call.handing) onBargeIn()
      else flushPartial('assistant')
      break
    case 'conversation.item.input_audio_transcription.delta':
      if (msg.delta) { call.lastHeardAt = now; flushPartial('assistant'); call.partial.user += msg.delta }
      break
    case 'conversation.item.input_audio_transcription.completed':
      flushPartial('assistant')
      if (typeof msg.transcript === 'string' && msg.transcript.trim()) call.partial.user = msg.transcript
      flushPartial('user')
      break
    case 'response.created':
      rtc.responding = true
      break
    case 'response.output_audio_transcript.delta':
      if (msg.delta) { flushPartial('user'); call.partial.assistant += msg.delta }
      break
    case 'response.output_audio_transcript.done':
      flushPartial('assistant')
      break
    case 'output_audio_buffer.started':
      call.modelSpeaking = true
      rtc.speaking = true
      call.lastAudioAt = now
      break
    case 'output_audio_buffer.stopped':
    case 'output_audio_buffer.cleared':
      call.modelSpeaking = false
      rtc.speaking = false
      call.lastAudioAt = now
      if (call.hangUp && !rtc.responding) { tearDown(''); return }
      flushResults()
      break
    case 'response.function_call_arguments.done': {
      let args = {}
      try { args = JSON.parse(msg.arguments || '{}') } catch { /* no arguments */ }
      onToolCall([{ id: msg.call_id, name: msg.name, args }])
      break
    }
    case 'response.done':
      flushPartial('user')
      flushPartial('assistant')
      rtc.responding = false
      call.handing = false
      if (call.hangUp) { if (!rtc.speaking) tearDown(''); return }
      if (rtc.needResponse) { // a tool answer is in: let the voice acknowledge it
        rtc.needResponse = false
        rtcSend({ type: 'response.create' })
        rtc.responding = true
        return
      }
      flushResults()
      break
    case 'error': {
      const e = msg.error || {}
      const text = [e.code, e.type, e.message].filter(Boolean).join(' ')
      const reason = failureReason(text)
      if (reason === 'quota' || reason === 'auth' || reason === 'expired') { void failover(reason, `OpenAI Realtime: ${e.message || e.code}`); return }
      rtc.responding = false
      call.detail = String(e.message || e.code || 'OpenAI Realtime error').slice(0, 200)
      publish()
      break
    }
  }
}

// ── provider selection, start and mid-call failover ──────────────────────────────────────────────

function openTransport (minted, gen) {
  const id = minted.provider || 'gemini-free'
  call.provider = {
    id,
    label: minted.provider_label || PROVIDER_LABELS[id] || id,
    transport: minted.transport || 'gemini-live',
    model: minted.model || ''
  }
  if (call.providersUsed.at(-1) !== call.provider.label) call.providersUsed.push(call.provider.label)
  publish()
  if (call.provider.transport === 'openai-realtime') {
    void openRealtime(minted, gen)
  } else {
    call.player = createPlayer()
    call.ws = openSocket(minted, gen)
  }
}

// The serving provider failed (at connect or mid-call): release it, remember it, and reconnect the
// SAME call to the next provider of the chain, carrying the recent spoken turns. A provider that
// failed is never retried on this call; quota/auth refusals also cool it down for the next calls.
export async function failover (reason, note) {
  if (call.state === 'idle') return
  const from = call.provider && call.provider.id
  if (from) {
    if (!call.tried.includes(from)) call.tried.push(from)
    if (reason === 'quota' || reason === 'auth') cooldown.set(from, E().now() + COOLDOWN_MS)
  }
  if (call.hangUp || call.switches >= MAX_SWITCHES || !call.ctx) { tearDown(note); return }
  call.gen += 1
  const gen = call.gen
  if (call.handing && call.lastHanded) call.queue.unshift(call.lastHanded) // never answered: hand it again
  releaseTransport()
  Object.assign(call, { state: 'connecting', switching: true, handing: false, switches: call.switches + 1, detail: 'Switching voice provider…' })
  publish()
  host.notify({ kind: 'info', message: `${(call.provider && call.provider.label) || 'The voice provider'} failed (${reason}); switching voice provider` })
  let minted
  try {
    minted = await mint(call.ctx, { exclude: call.tried.slice(), carry: voiceContext(), switch_from: from, reason })
  } catch (error) {
    if (call.gen === gen) tearDown(`${note}. ${errorMessage(error, 'No other voice provider could start.')}`)
    return
  }
  if (call.gen !== gen) return
  openTransport(minted, gen)
}

function errorMessage (error, fallback) {
  const d = error && (error.detail || (error.body && error.body.detail))
  if (d && typeof d === 'object' && d.message) return d.message
  if (error && error.message) return error.message
  return fallback
}

export async function start (ctx) {
  if (call.state !== 'idle') return
  const sid = (host.state.focusedSessionId && host.state.focusedSessionId.get()) || host.state.activeSessionId.get()
  if (!sid) {
    call.detail = 'Open a chat first: the call delegates into the open chat.'
    host.notify({ kind: 'info', message: call.detail })
    publish()
    return
  }
  call.gen += 1
  const gen = call.gen
  Object.assign(call, {
    state: 'connecting', detail: '', turns: [], queue: [], handing: false, sessionId: sid, ctx,
    provider: null, tried: [], switches: 0, switching: false, providersUsed: []
  })
  publish()
  const cooled = cooledProviders()
  let minted
  try {
    minted = await mint(ctx, cooled.length ? { exclude: cooled } : {})
  } catch (error) {
    if (call.gen !== gen) return
    let failure = error
    if (cooled.length) { // the cooldown is advice: when nothing else can serve, ask the providers again
      try { minted = await mint(ctx, {}); failure = null } catch (again) { failure = again }
      if (call.gen !== gen) return
    }
    if (failure) {
      const message = errorMessage(failure, 'Could not start the voice call')
      tearDown(message)
      host.notify({ kind: 'warning', message })
      return
    }
  }
  if (call.gen !== gen) return // stopped while the session was minting: open nothing
  openTransport(minted, gen)
}

// ── UI ───────────────────────────────────────────────────────────────────────────────────────────

function useCall () {
  const [, rerender] = useState(0)
  useEffect(() => {
    const fn = () => rerender(n => n + 1)
    call.listeners.add(fn)
    return () => call.listeners.delete(fn)
  }, [])
}

const servingLabel = () => (call.provider && call.provider.label) || 'Voice'

function chainText (status) {
  const ready = ((status && status.providers) || []).filter(p => p.ready).map(p => p.label)
  return ready.length ? ready.join(' -> ') : 'Gemini Live'
}

function VoiceButton ({ ctx }) {
  useCall()
  const [status, setStatus] = useState(null)
  useEffect(() => {
    let alive = true
    ctx.rest('/status').then(s => { if (alive) { setStatus(s); call.settings = s.settings } },
      () => { if (alive) setStatus({ available: false, message: 'The voice backend is off. Enable the gemini-live-chat plugin for this profile.' }) })
    return () => { alive = false }
  }, [ctx])
  const live = call.state !== 'idle'
  const blocked = !live && status && !status.available
  const s = (status && status.settings) || {}
  const who = s.persona_name || 'Hermes'
  const label = call.state === 'connecting'
    ? (call.switching ? 'Switching voice provider' : 'Connecting voice')
    : live ? (call.delegations ? `${servingLabel()}: ${who} is working (click to hang up)` : `${servingLabel()}: ${who} is listening (click to hang up)`)
      : blocked ? status.message : (call.detail || `Talk with ${who} (${chainText(status)})`)
  return h('button', {
    type: 'button',
    title: label,
    'aria-label': label,
    'aria-pressed': live,
    disabled: !!blocked,
    onClick: () => (live ? tearDown('') : void start(ctx)),
    className: 'inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors ' +
      'hover:bg-muted disabled:opacity-50 ' + (live ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground')
  }, h(live ? icons.PhoneOff || icons.VolumeX : icons.AudioLines, { className: icons.iconSize.sm }))
}

// The status-bar chip always names the provider serving the call.
export function chipText () {
  if (call.state === 'idle') return ''
  if (call.state === 'connecting') return call.switching ? 'Voice: switching provider' : 'Voice: connecting'
  return call.delegations ? `${servingLabel()}: Hermes working (${call.delegations})` : `${servingLabel()}: on call`
}

function StatusChip () {
  useCall()
  if (call.state === 'idle') return null
  return h('button', {
    type: 'button',
    title: 'Hang up',
    onClick: () => tearDown(''),
    className: 'px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)'
  }, chipText())
}

// Every assistant reply on the pinned chat is handed to the voice while the call is up — not only
// the reply to a counted delegation. A delegated turn often ends with "I've asked a sub-agent" and
// the real answer arrives in a LATER turn on the same session (async delegation completion, a
// queued follow-up, a reply to something typed mid-call); counting delegations dropped those.
// Interim assistant text sealed during the turn (message.interim) is kept with the final text.
// v0.3: the whole text is handed over (v0.2 kept only its last 3000 characters), in parts.
// v0.4: a reply that lands during a provider switch is queued and spoken by the next provider.
const onPinnedChat = event => !!(event && call.state !== 'idle' && call.sessionId && event.session_id === call.sessionId)

export function onMessageInterim (event) {
  if (!onPinnedChat(event)) return
  const text = textOf((event.payload || {}).text).replace(/\s+/g, ' ').trim()
  if (text) call.interim.push(text)
}

export function onMessageComplete (event) {
  if (!onPinnedChat(event)) return
  const payload = event.payload || {}
  const final = textOf(payload.text).trim()
  const interim = call.interim
  call.interim = []
  const flat = final.replace(/\s+/g, ' ')
  const parts = interim.filter(t => !flat.includes(t))
  if (final) parts.push(final)
  const owed = call.delegations > 0
  if (owed) call.delegations -= 1
  if (parts.length) {
    enqueueResult(parts.join('\n\n')) // a silent reply ([SILENT], NO_REPLY) queues nothing
  } else if (owed) {
    enqueueResult(payload.status === 'error' || payload.error
      ? `Hermes stopped with an error: ${textOf(payload.error || payload.failure_reason || 'unknown').slice(0, 300)}`
      : 'Hermes finished without a text answer.')
  }
  // else: an empty turn nobody is waiting for (e.g. an interrupted queued turn)
  publish()
}

export default {
  id: PLUGIN_ID,
  name: 'Live voice (Gemini / ChatGPT)',
  defaultEnabled: false,
  register (ctx) {
    ctx.onEvent('message.complete', onMessageComplete)
    ctx.onEvent('message.interim', onMessageInterim)
    // Disable / unload / hot-reload: hang up and release everything (mic, sockets, peer, audio).
    ctx.onDispose(() => tearDown())
    ctx.register({ id: 'talk', area: 'composer.actions', order: 42, render: () => h(VoiceButton, { ctx }) })
    ctx.register({ id: 'status', area: 'statusBar.right', order: 140, render: () => h(StatusChip, {}) })
  }
}
