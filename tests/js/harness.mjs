// Loads desktop/plugin.js with its two SDK imports pointed at in-memory fakes, and provides fake
// WebSocket / AudioContext / microphone objects that record every resource opened and released.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..', '..', 'desktop', 'plugin.js')

export function makeSdk () {
  const requests = []
  const notes = []
  const atom = v => ({ value: v, get () { return this.value } })
  const sdk = {
    requests,
    notes,
    requestImpl: async (method, params) => ({ status: 'streaming' }),
    host: {
      state: { activeSessionId: atom('sess-1'), focusedSessionId: atom('sess-1') },
      request: (method, params) => { requests.push({ method, params }); return sdk.requestImpl(method, params) },
      notify: n => { notes.push(n) }
    },
    icons: { AudioLines: 'AudioLines', VolumeX: 'VolumeX', PhoneOff: 'PhoneOff', ChevronDown: 'ChevronDown', Check: 'Check', iconSize: { sm: 'sm' } },
    Popover: 'Popover',
    PopoverContent: 'PopoverContent',
    PopoverTrigger: 'PopoverTrigger'
  }
  return sdk
}

export async function loadPlugin (sdk) {
  const dir = mkdtempSync(join(tmpdir(), 'd2v-'))
  writeFileSync(join(dir, 'sdk.mjs'), 'export const host = globalThis.__d2vSdk.host; export const icons = globalThis.__d2vSdk.icons\n' +
    'export const Popover = globalThis.__d2vSdk.Popover; export const PopoverContent = globalThis.__d2vSdk.PopoverContent; export const PopoverTrigger = globalThis.__d2vSdk.PopoverTrigger\n')
  writeFileSync(join(dir, 'react.mjs'), 'export const createElement = (...a) => a; export const useEffect = () => {}; export const useState = v => [typeof v === \'function\' ? v() : v, () => {}]; export const useRef = v => ({ current: v ?? null })\n')
  const src = readFileSync(PLUGIN, 'utf8')
    .replace("from '@hermes/plugin-sdk'", "from './sdk.mjs'")
    .replace("from 'react'", "from './react.mjs'")
  if (/^import .*from '(?!\.\/)/m.test(src)) throw new Error('import rewrite failed')
  writeFileSync(join(dir, 'plugin.mjs'), src)
  globalThis.__d2vSdk = sdk
  return import(pathToFileURL(join(dir, 'plugin.mjs')).href)
}

export function makeEnv () {
  const ledger = { sockets: [], contexts: [], tracks: [], timers: new Map(), nextTimer: 1, micCalls: 0, micGate: null }
  class FakeWS {
    constructor (url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      this.closed = false
      ledger.sockets.push(this)
    }
    send (data) { if (this.readyState !== 1) throw new Error('send on closed socket'); this.sent.push(JSON.parse(data)) }
    close () { this.readyState = 3; this.closed = true }
    // test drivers
    open () { this.readyState = 1; this.onopen && this.onopen() }
    serve (msg) { this.onmessage && this.onmessage({ data: JSON.stringify(msg) }) }
    drop (code = 1011, reason = 'gone') { this.readyState = 3; this.onclose && this.onclose({ code, reason }) }
  }
  class FakeAudioContext {
    constructor (opts) {
      this.sampleRate = (opts && opts.sampleRate) || 48000
      this.state = 'running'
      this.currentTime = 0
      this.destination = {}
      this.sources = []
      this.audioWorklet = { addModule: async () => {} }
      ledger.contexts.push(this)
    }
    resume () { return Promise.resolve() }
    close () { this.state = 'closed'; return Promise.resolve() }
    createMediaStreamSource () { return { connect () {}, disconnect () {} } }
    createBuffer (ch, len, rate) { const data = new Float32Array(len); return { duration: len / rate, getChannelData: () => data } }
    createBufferSource () {
      const ctx = this
      const node = { stopped: false, connect () {}, start () {}, stop () { node.stopped = true; node.onended && node.onended() } }
      ctx.sources.push(node)
      return node
    }
  }
  class FakeWorkletNode {
    constructor () { this.port = { onmessage: null }; ledger.worklet = this }
    connect () {}
    disconnect () {}
  }
  // OpenAI Realtime (WebRTC) fakes: a peer connection with one data channel, and the SDP fetch.
  ledger.peers = []
  ledger.spoken = []
  ledger.voices = ['en-US']
  ledger.fetches = []
  ledger.audios = []
  ledger.sdpAnswer = { ok: true, status: 201, body: 'v=0 answer' }
  class FakeDC {
    constructor (label) { this.label = label; this.readyState = 'connecting'; this.sent = []; this.closed = false }
    send (data) { if (this.readyState !== 'open') throw new Error('send on closed channel'); this.sent.push(JSON.parse(data)) }
    close () { this.readyState = 'closed'; this.closed = true }
    // test drivers
    open () { this.readyState = 'open'; this.onopen && this.onopen() }
    serve (msg) { this.onmessage && this.onmessage({ data: JSON.stringify(msg) }) }
    drop () { this.readyState = 'closed'; this.onclose && this.onclose() }
  }
  class FakePC {
    constructor () { this.tracks = []; this.closed = false; this.connectionState = 'new'; this.dc = null; this.remote = null; ledger.peers.push(this) }
    addTrack (track) { this.tracks.push(track) }
    createDataChannel (label) { this.dc = new FakeDC(label); return this.dc }
    async createOffer () { return { type: 'offer', sdp: 'v=0 offer' } }
    async setLocalDescription (d) { this.local = d }
    async setRemoteDescription (d) { this.remote = d }
    close () { this.closed = true; this.connectionState = 'closed' }
    // test driver
    fail () { this.connectionState = 'failed'; this.onconnectionstatechange && this.onconnectionstatechange() }
  }
  const env = {
    WebSocket: FakeWS,
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    RTCPeerConnection: FakePC,
    fetch: async (url, opts) => {
      ledger.fetches.push({ url, opts })
      const a = ledger.sdpAnswer
      return { ok: a.ok, status: a.status, text: async () => a.body }
    },
    createAudio: () => { const a = { paused: false, srcObject: null, play () { return Promise.resolve() }, pause () { this.paused = true } }; ledger.audios.push(a); return a },
    getUserMedia: async () => {
      ledger.micCalls += 1
      if (ledger.micGate) await ledger.micGate
      const track = { stopped: false, stop () { this.stopped = true } }
      ledger.tracks.push(track)
      return { getTracks: () => [track] }
    },
    setTimeout: (fn, ms) => { const id = ledger.nextTimer++; ledger.timers.set(id, fn); return id },
    clearTimeout: id => { ledger.timers.delete(id) },
    now: () => Date.UTC(2026, 10, 7, 12, 0, 0),
    speak: (text, lang) => { ledger.spoken.push({ text, lang }); return true },
    hasVoice: prefix => ledger.voices.some(v => v.startsWith(prefix))
  }
  return { env, ledger }
}

export function makeCtx (overrides = {}) {
  const rests = []
  const written = []
  const ctx = {
    rests,
    written,
    mint: async () => ({ url: 'wss://example.invalid/ws?access_token=auth_tokens/x', setup: { setup: { model: 'models/gemini-3.8-live' } } }),
    status: () => ({ available: true, settings: { transcript_to_chat: 'chat_turn' } }),
    choose: async body => ({ choice: body.choice, persistent: true, options: [] }),
    rest: (path, opts) => {
      rests.push({ path, opts })
      if (path === '/session') return ctx.mint(opts && opts.body)
      if (path === '/choice') return ctx.choose(opts && opts.body)
      if (path === '/report') return Promise.resolve({ recorded: true })
      return Promise.resolve(ctx.status())
    },
    files: { writeText: async (folder, path, text) => { written.push({ folder, path, text }); return { ok: true } } },
    ...overrides
  }
  return ctx
}

export const tick = () => new Promise(resolve => setImmediate(resolve))
export async function settle (n = 5) { for (let i = 0; i < n; i++) await tick() }
