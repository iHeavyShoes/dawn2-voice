// gemini-live-chat — full-duplex Google Gemini Live voice in the Hermes Desktop composer.
//
// Uncompiled ESM, one file: the loader resolves only @hermes/plugin-sdk and react, so every element
// goes through createElement. The Gemini key never reaches this window: the backend half
// (dashboard/plugin_api.py) mints a single-use ephemeral token whose setup (model, persona, tools,
// voice) is locked server-side, and this file opens the Live socket with it.
//
// Delegation (the point of this plugin): the voice model has one work tool, `hermes_task`. Each call
// becomes a normal `prompt.submit` on the chat that was open when the call started, with
// surface 'voice-live' and the recent spoken turns as `voice_context` — the same seam Hermes core's
// GPT-Live uses. The request and Hermes' answer are therefore ordinary rows in that chat. The turn's
// `message.complete` text goes back to the voice as a "[Hermes result]" text input it says aloud.
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
const RESULT_LIMIT = 3000
const HANGUP_GRACE_MS = 2500
export const RESULT_TAG = '[Hermes result]'
export const TRANSCRIPT_HEADER = '[Voice call transcript (Gemini Live), saved for the record. No action needed; reply with one short line.]'

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

export function formatTranscript (turns) {
  return turns.map(t => `${t.role === 'user' ? 'User' : 'Voice'}: ${t.text}`).join('\n')
}

// ── injectable environment (tests replace it) ────────────────────────────────────────────────────

const defaultEnv = () => ({
  WebSocket: globalThis.WebSocket,
  AudioContext: globalThis.AudioContext,
  AudioWorkletNode: globalThis.AudioWorkletNode,
  getUserMedia: c => globalThis.navigator.mediaDevices.getUserMedia(c),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: id => globalThis.clearTimeout(id),
  now: () => Date.now()
})
let env = null
const E = () => env || (env = defaultEnv())
export function setEnv (overrides) { env = { ...defaultEnv(), ...overrides } }

// ── audio ────────────────────────────────────────────────────────────────────────────────────────

async function startMic (onFrame, isLive) {
  const stream = await E().getUserMedia({
    audio: { channelCount: 1, autoGainControl: true, echoCancellation: true, noiseSuppression: true }
  })
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

// ── the call (module scope: a composer row remounts on navigation, the call must not) ────────────

export const call = {
  state: 'idle', // idle | connecting | live | stopping
  detail: '',
  gen: 0, // bumped by every start and every stop; stale async work checks it and backs out
  ws: null,
  standby: null, // the replacement socket while resuming after goAway
  stopMic: null,
  player: null,
  sessionId: null,
  resumeHandle: null,
  modelSpeaking: false,
  hangUp: false,
  hangTimer: null,
  results: [],
  turns: [], // [{ role: 'user'|'assistant', text }]
  partial: { user: '', assistant: '' },
  delegations: 0,
  settings: null,
  ctx: null,
  listeners: new Set()
}
const publish = () => call.listeners.forEach(fn => { try { fn() } catch { /* isolated */ } })

function sendOn (ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
}
const send = msg => sendOn(call.ws, msg)

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

async function saveTranscript (ctx, sid, turns, mode) {
  if (!turns.length || mode === 'off') return
  const body = formatTranscript(turns)
  const stamp = new Date(E().now()).toISOString().replace(/[:.]/g, '-')
  if (ctx && ctx.files && typeof ctx.files.writeText === 'function') {
    try { await ctx.files.writeText('data', `transcript-${stamp}.md`, `# Gemini Live call ${stamp}\n\n${body}\n`) } catch { /* best effort */ }
  }
  if (mode !== 'chat_turn' || !sid) return
  try {
    // A normal queued turn: if Hermes is still working on a delegation, it runs after it.
    await host.request('prompt.submit', { session_id: sid, text: `${TRANSCRIPT_HEADER}\n\n${body}`, queued: true })
  } catch (error) {
    host.notify({ kind: 'warning', message: 'Could not save the call transcript to the chat', detail: String(error && error.message ? error.message : error) })
  }
}

// Idempotent. Releases every resource the call holds, synchronously: both sockets, the microphone
// tracks and its AudioContext, the player, the hang-up timer. Nothing survives it.
export function tearDown (note) {
  const wasActive = call.state !== 'idle'
  const ctx = call.ctx
  const sid = call.sessionId
  flushPartial('user')
  flushPartial('assistant')
  const turns = call.turns.slice()
  call.gen += 1
  const ws = call.ws
  const standby = call.standby
  call.ws = null
  call.standby = null
  detach(ws)
  detach(standby)
  if (call.stopMic) { const stop = call.stopMic; call.stopMic = null; stop() }
  if (call.player) { call.player.close(); call.player = null }
  if (call.hangTimer) { E().clearTimeout(call.hangTimer); call.hangTimer = null }
  Object.assign(call, {
    state: 'idle', modelSpeaking: false, hangUp: false, results: [], turns: [],
    partial: { user: '', assistant: '' }, delegations: 0, resumeHandle: null
  })
  if (note !== undefined) call.detail = note
  publish()
  if (wasActive) void saveTranscript(ctx, sid, turns, (call.settings && call.settings.transcript_to_chat) || 'chat_turn')
}

function flushResults () {
  if (!call.results.length || !call.ws || call.modelSpeaking) return
  const text = call.results.join('\n\n')
  call.results = []
  // realtimeInput.text: Gemini Live has no scheduling knob on this endpoint, so the result is
  // handed over only while the model is quiet.
  send({ realtimeInput: { text: `${RESULT_TAG} ${text}` } })
}

export async function delegate (request) {
  const sid = call.sessionId
  if (!sid) {
    call.results.push('No chat is open, so the request could not be handed to Hermes.')
    flushResults()
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
    call.results.push(`The request did not reach Hermes: ${error && error.message ? error.message : String(error)}`)
    flushResults()
    publish()
    return { ok: false }
  }
}

function onToolCall (calls) {
  const responses = []
  for (const fc of calls || []) {
    const id = String(fc.id || '')
    const name = String(fc.name || '')
    const args = fc.args || {}
    if (name === 'hermes_task') {
      const request = String(args.request || '').trim()
      if (request) void delegate(request)
      responses.push({ id, name, response: { result: request ? 'WORK_STARTED: Hermes is working on it in the open chat. Do not describe a result yet; it will arrive as a "[Hermes result]" message.' : 'No request text was given.' } })
    } else if (name === 'end_call') {
      call.hangUp = true
      responses.push({ id, name, response: { result: 'OK' } })
      if (!call.hangTimer) call.hangTimer = E().setTimeout(() => tearDown(''), HANGUP_GRACE_MS)
    } else {
      responses.push({ id, name, response: { error: 'unknown tool' } })
    }
  }
  if (responses.length) send({ toolResponse: { functionResponses: responses } })
}

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
    if (call.state === 'connecting') { call.state = 'live'; publish(); void attachMic() }
    return
  }
  if (ws !== call.ws) return // frames from a socket being replaced
  const content = msg.serverContent
  if (content) {
    if (content.interrupted) { // barge-in: the server's VAD already stopped generation
      call.player && call.player.flush()
      call.modelSpeaking = false
      flushPartial('assistant')
    }
    const parts = (content.modelTurn && content.modelTurn.parts) || []
    for (const part of parts) {
      const inline = part.inlineData
      if (inline && inline.data) {
        call.modelSpeaking = true
        call.player && call.player.play(b64ToPcm(inline.data))
      }
    }
  }
  const heard = transcriptOf(msg, content, 'inputTranscription')
  if (heard) { flushPartial('assistant'); call.partial.user += heard }
  const said = transcriptOf(msg, content, 'outputTranscription')
  if (said) { flushPartial('user'); call.partial.assistant += said }
  if (content && content.turnComplete) {
    flushPartial('user')
    flushPartial('assistant')
    call.modelSpeaking = false
    if (call.hangUp) { tearDown(''); return }
    flushResults()
  }
  if (msg.toolCall) onToolCall(msg.toolCall.functionCalls)
  if (msg.sessionResumptionUpdate && msg.sessionResumptionUpdate.resumable && msg.sessionResumptionUpdate.newHandle) {
    call.resumeHandle = String(msg.sessionResumptionUpdate.newHandle)
  }
  if (msg.goAway) void resume()
  if (msg.error) { call.detail = String(msg.error.message || 'Gemini Live error'); publish() }
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
    if (ws === call.ws) tearDown(call.detail || closeNote(ev))
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
    const minted = await mint(ctx, { resume_handle: call.resumeHandle })
    if (call.gen !== gen) return
    call.standby = openSocket(minted, gen)
  } catch { /* the old socket keeps going until Google closes it */ }
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
  Object.assign(call, { state: 'connecting', detail: '', turns: [], results: [], sessionId: sid, ctx })
  publish()
  let minted
  try {
    minted = await mint(ctx, {})
  } catch (error) {
    if (call.gen === gen) {
      const message = errorMessage(error, 'Could not start Gemini Live')
      tearDown(message)
      host.notify({ kind: 'warning', message })
    }
    return
  }
  if (call.gen !== gen) return // stopped while the token was minting: open nothing
  call.player = createPlayer()
  call.ws = openSocket(minted, gen)
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

function VoiceButton ({ ctx }) {
  useCall()
  const [status, setStatus] = useState(null)
  useEffect(() => {
    let alive = true
    ctx.rest('/status').then(s => { if (alive) { setStatus(s); call.settings = s.settings } },
      () => { if (alive) setStatus({ available: false, message: 'Gemini Live backend is off. Enable the gemini-live-chat plugin for this profile.' }) })
    return () => { alive = false }
  }, [ctx])
  const live = call.state !== 'idle'
  const blocked = !live && status && !status.available
  const model = status && status.settings ? status.settings.model : 'gemini-3.8-live'
  const label = call.state === 'connecting' ? 'Connecting to Gemini Live'
    : live ? (call.delegations ? 'Gemini Live: Hermes is working (click to hang up)' : 'Gemini Live: listening (click to hang up)')
      : blocked ? status.message : (call.detail || `Talk with Gemini Live (${model})`)
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

function StatusChip () {
  useCall()
  if (call.state === 'idle') return null
  const text = call.state === 'connecting' ? 'Gemini Live: connecting'
    : call.delegations ? `Gemini Live: Hermes working (${call.delegations})` : 'Gemini Live: on call'
  return h('button', {
    type: 'button',
    title: 'Hang up',
    onClick: () => tearDown(''),
    className: 'px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)'
  }, text)
}

export function onMessageComplete (event) {
  if (!call.ws || !call.delegations || !event || event.session_id !== call.sessionId) return
  call.delegations -= 1
  const payload = event.payload || {}
  const text = textOf(payload.text).trim()
  call.results.push(text ? text.slice(0, RESULT_LIMIT) : 'Hermes finished without a text answer.')
  flushResults()
  publish()
}

export default {
  id: PLUGIN_ID,
  name: 'Gemini Live',
  defaultEnabled: false,
  register (ctx) {
    ctx.onEvent('message.complete', onMessageComplete)
    // Disable / unload / hot-reload: hang up and release everything (mic, sockets, audio).
    ctx.onDispose(() => tearDown())
    ctx.register({ id: 'talk', area: 'composer.actions', order: 42, render: () => h(VoiceButton, { ctx }) })
    ctx.register({ id: 'status', area: 'statusBar.right', order: 140, render: () => h(StatusChip, {}) })
  }
}
