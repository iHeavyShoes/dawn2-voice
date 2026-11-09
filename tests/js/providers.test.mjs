// node --test 'tests/js/*.test.mjs' — v0.4 providers: the OpenAI Realtime (Codex subscription)
// transport, mid-call failover with carried context, cleanup per provider, and that delegation,
// ack-only, full readout, barge-in and the transcript behave the same on every provider.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'

const sdk = makeSdk()
const P = await loadPlugin(sdk)
let env, ledger, t

beforeEach(async () => {
  P.tearDown()
  await settle() // let the previous call's async transcript save land before the ledger is reset
  P.resetCooldown()
  ;({ env, ledger } = makeEnv())
  t = Date.UTC(2026, 10, 7, 12, 0, 0)
  P.setEnv({ ...env, now: () => t })
  sdk.requests.length = 0
  sdk.notes.length = 0
  sdk.requestImpl = async () => ({ status: 'streaming' })
  sdk.host.state.activeSessionId.value = 'sess-1'
  sdk.host.state.focusedSessionId.value = 'sess-1'
  P.call.settings = { transcript_to_chat: 'chat_turn', half_duplex: false }
  P.call.detail = ''
})

const GEMINI = { provider: 'gemini-free', provider_label: 'Gemini (free key)', transport: 'gemini-live', model: 'gemini-3.8-live', url: 'wss://example.invalid/ws?access_token=auth_tokens/x', setup: { setup: { model: 'models/gemini-3.8-live' } } }
const PAID = { ...GEMINI, provider: 'gemini-paid', provider_label: 'Gemini (paid key)' }
const CODEX = { provider: 'openai-codex', provider_label: 'ChatGPT (Codex subscription)', transport: 'openai-realtime', model: 'gpt-realtime-2.1', client_secret: 'ek_test_secret_123', offer_url: 'https://api.openai.com/v1/realtime/calls' }

// A backend that serves the given sessions in order and records every request body.
function chainCtx (...served) {
  const bodies = []
  const ctx = makeCtx({
    mint: async body => {
      bodies.push(body)
      const next = served.shift()
      if (!next) { const e = new Error('502'); e.detail = { reason: 'exhausted', message: 'No voice provider could start.' }; throw e }
      if (next instanceof Error) throw next
      return next
    }
  })
  ctx.bodies = bodies
  return ctx
}

async function codexCall (ctx = chainCtx(CODEX)) {
  await P.start(ctx)
  await settle(10)
  const pc = ledger.peers.at(-1)
  pc.dc.open()
  await settle()
  return { pc, dc: pc.dc, ctx }
}

async function geminiCall (ctx) {
  await P.start(ctx)
  await settle()
  const ws = ledger.sockets.at(-1)
  ws.open()
  ws.serve({ setupComplete: {} })
  await settle()
  return { ws, ctx }
}

const fnCall = (dc, name, args, id = 'call_1') => dc.serve({ type: 'response.function_call_arguments.done', call_id: id, name, arguments: JSON.stringify(args) })
const userTexts = dc => dc.sent.filter(m => m.type === 'conversation.item.create' && m.item.type === 'message').map(m => m.item.content[0].text)
const reply = text => P.onMessageComplete({ type: 'message.complete', session_id: 'sess-1', payload: { text } })
const later = ms => { t += ms }

function assertReleased () {
  assert.equal(P.call.state, 'idle')
  assert.equal(P.call.ws, null)
  assert.equal(P.call.rtc, null)
  assert.equal(P.call.stopMic, null)
  assert.equal(P.call.player, null)
  assert.equal(P.call.provider, null)
  assert.ok(ledger.sockets.every(s => s.closed || s.readyState === 3), 'every socket closed')
  assert.ok(ledger.peers.every(p => p.closed), 'every peer connection closed')
  assert.ok(ledger.peers.every(p => !p.dc || p.dc.closed), 'every data channel closed')
  assert.ok(ledger.peers.every(p => !p.dc || (!p.dc.onmessage && !p.dc.onclose)), 'no live channel handlers left')
  assert.ok(ledger.tracks.every(tr => tr.stopped), 'every mic track stopped')
  assert.ok(ledger.audios.every(a => a.paused && a.srcObject === null), 'remote audio released')
  assert.ok(ledger.contexts.every(c => c.state === 'closed'), 'every AudioContext closed')
}

// ── OpenAI Realtime transport ────────────────────────────────────────────────────────────────────

test('codex: SDP offer goes to api.openai.com with the ephemeral secret; the call goes live on the data channel', async () => {
  const { pc } = await codexCall()
  assert.equal(ledger.fetches.length, 1)
  const f = ledger.fetches[0]
  assert.equal(f.url, 'https://api.openai.com/v1/realtime/calls?model=gpt-realtime-2.1')
  assert.equal(f.opts.headers.Authorization, 'Bearer ek_test_secret_123')
  assert.equal(f.opts.headers['Content-Type'], 'application/sdp')
  assert.equal(f.opts.body, 'v=0 offer')
  assert.deepEqual(pc.remote, { type: 'answer', sdp: 'v=0 answer' })
  assert.equal(pc.dc.label, 'oai-events')
  assert.equal(pc.tracks.length, 1, 'the microphone track is on the peer connection')
  assert.equal(P.call.state, 'live')
  assert.equal(P.chipText(), 'ChatGPT (Codex subscription): on call')
  assert.equal(P.call.ws, null, 'no Gemini socket')
})

test('codex: an offer URL outside api.openai.com is refused and nothing is sent there', async () => {
  const ctx = chainCtx({ ...CODEX, offer_url: 'https://evil.example/realtime' })
  await P.start(ctx)
  await settle(10)
  assert.equal(ledger.fetches.length, 0)
  assertReleased()
})

test('codex: hermes_task delegates to the open chat exactly like Gemini (surface, voice_context, receipt)', async () => {
  const { dc } = await codexCall()
  dc.serve({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'תזכיר לי לקנות חלב' })
  dc.serve({ type: 'response.output_audio_transcript.delta', delta: 'Sure, one moment.' })
  fnCall(dc, 'hermes_task', { request: 'Remind me to buy milk' })
  await settle()
  const submit = sdk.requests.find(r => r.method === 'prompt.submit')
  assert.equal(submit.params.session_id, 'sess-1')
  assert.equal(submit.params.surface, 'voice-live')
  assert.equal(submit.params.text, 'Remind me to buy milk')
  assert.match(submit.params.voice_context, /User: תזכיר לי לקנות חלב\nVoice: Sure, one moment\./)
  const out = dc.sent.find(m => m.type === 'conversation.item.create' && m.item.type === 'function_call_output')
  assert.equal(out.item.call_id, 'call_1')
  assert.equal(out.item.output, P.RECEIPT, 'same ack-only receipt as Gemini')
  assert.equal(P.call.delegations, 1)
  // the voice acknowledges after its current response is done, never mid-response
  assert.equal(dc.sent.filter(m => m.type === 'response.create').length, 0)
  dc.serve({ type: 'response.done' })
  assert.equal(dc.sent.filter(m => m.type === 'response.create').length, 1)
})

test('codex: a long Hermes reply is read in full, one part per model response', async () => {
  const { dc } = await codexCall()
  fnCall(dc, 'hermes_task', { request: 'explain clocks' })
  dc.serve({ type: 'response.done' })
  dc.serve({ type: 'response.done' }) // the acknowledgement finished
  later(5000)
  const para = n => Array.from({ length: 14 }, (_, i) => `Sentence ${n}.${i} explains the gear train and the escapement.`).join(' ')
  reply([para(1), para(2), para(3)].join('\n\n'))
  let texts = userTexts(dc)
  assert.equal(texts.length, 1)
  assert.match(texts[0], /^\[Hermes result 1\/3\] Sentence 1\.0/)
  dc.serve({ type: 'response.created' })
  dc.serve({ type: 'output_audio_buffer.started' })
  dc.serve({ type: 'response.done' })
  dc.serve({ type: 'output_audio_buffer.stopped' })
  texts = userTexts(dc)
  assert.equal(texts.length, 2)
  assert.match(texts[1], /^\[Hermes result 2\/3\]/)
  dc.serve({ type: 'response.done' })
  assert.match(userTexts(dc)[2], /^\[Hermes result 3\/3\]/)
  assert.equal(P.call.delegations, 0)
})

test('codex: barge-in clears buffered audio and drops the rest of the reply being read', async () => {
  const { dc } = await codexCall()
  later(5000)
  const para = n => Array.from({ length: 14 }, (_, i) => `Sentence ${n}.${i} explains the gear train and the escapement.`).join(' ')
  reply([para(1), para(2), para(3)].join('\n\n'))
  dc.serve({ type: 'output_audio_buffer.started' })
  dc.serve({ type: 'input_audio_buffer.speech_started' })
  assert.ok(dc.sent.some(m => m.type === 'output_audio_buffer.clear'))
  assert.equal(P.call.queue.length, 0, 'remaining parts dropped (they stay in the chat)')
  assert.equal(P.call.modelSpeaking, false)
})

test('codex: end_call hangs up after the goodbye finishes playing', async () => {
  const { dc } = await codexCall()
  fnCall(dc, 'end_call', {}, 'call_9')
  assert.equal(P.call.state, 'live')
  dc.serve({ type: 'output_audio_buffer.started' })
  dc.serve({ type: 'response.done' })
  assert.equal(P.call.state, 'live', 'goodbye still playing')
  dc.serve({ type: 'output_audio_buffer.stopped' })
  assertReleased()
})

test('codex: hang-up releases peer connection, data channel, mic track and remote audio; idempotent', async () => {
  const { pc } = await codexCall()
  pc.ontrack({ streams: [{ id: 'remote' }] })
  assert.equal(ledger.audios.length, 1)
  P.tearDown('')
  assertReleased()
  P.tearDown('')
  assertReleased()
})

test('codex: stop while the SDP exchange is in flight opens nothing afterwards', async () => {
  let answer
  P.setEnv({ ...env, now: () => t, fetch: async (url, opts) => { ledger.fetches.push({ url, opts }); return new Promise(resolve => { answer = resolve }) } })
  await P.start(chainCtx(CODEX))
  await settle(10)
  assert.equal(ledger.fetches.length, 1)
  P.tearDown('')
  answer({ ok: true, status: 201, text: async () => 'v=0 late answer' })
  await settle(10)
  assert.equal(ledger.peers[0].remote, null, 'the late answer is never applied')
  assertReleased()
})

test('codex: stop during the microphone prompt releases the late stream', async () => {
  let grant
  ledger.micGate = new Promise(resolve => { grant = resolve })
  await P.start(chainCtx(CODEX))
  await settle()
  P.tearDown('')
  grant()
  await settle(10)
  assert.equal(ledger.peers.length, 0)
  assertReleased()
})

test('codex: transcript at hang-up has the missed-request note and names the provider', async () => {
  const { dc } = await codexCall()
  dc.serve({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'שלום' })
  dc.serve({ type: 'response.output_audio_transcript.delta', delta: 'Hi there!' })
  dc.serve({ type: 'response.output_audio_transcript.done' })
  P.tearDown('')
  await settle()
  const saves = sdk.requests.filter(r => r.method === 'prompt.submit')
  assert.equal(saves.length, 1)
  assert.ok(saves[0].params.text.startsWith(P.TRANSCRIPT_HEADER + '\n\nVoice provider: ChatGPT (Codex subscription)\n\n'))
  assert.match(saves[0].params.text, /User: שלום\nVoice: Hi there!/)
})

// ── fallback ─────────────────────────────────────────────────────────────────────────────────────

test('mid-call: a Gemini quota close switches to the next provider with the recent turns, says so, and keeps the open request', async () => {
  const ctx = chainCtx(GEMINI, CODEX)
  const { ws } = await geminiCall(ctx)
  ws.serve({ serverContent: { inputTranscription: { text: 'what is on my calendar?' } } })
  ws.serve({ serverContent: { outputTranscription: { text: 'Let me check.' } } })
  ws.serve({ toolCall: { functionCalls: [{ id: 'c1', name: 'hermes_task', args: { request: 'calendar today' } }] } })
  await settle()
  assert.equal(P.call.delegations, 1)
  ws.drop(1011, 'RESOURCE_EXHAUSTED: quota exceeded')
  await settle(10)
  // the old provider is fully released before the next one opens
  assert.ok(ws.closed || ws.readyState === 3)
  assert.equal(ledger.tracks.filter(tr => !tr.stopped).length, 1, 'only the new provider holds the microphone')
  const body = ctx.bodies.at(-1)
  assert.deepEqual(body.exclude, ['gemini-free'])
  assert.equal(body.switch_from, 'gemini-free')
  assert.equal(body.reason, 'quota')
  assert.match(body.carry, /User: what is on my calendar\?\nVoice: Let me check\./)
  assert.equal(P.chipText(), 'Voice: switching provider')
  assert.match(sdk.notes.at(-1).message, /switching voice provider/)
  // a Hermes reply that lands during the switch waits for the new voice
  later(5000)
  reply('You have a dentist appointment at 4.')
  const pc = ledger.peers.at(-1)
  pc.dc.open()
  await settle()
  assert.equal(P.call.state, 'live')
  assert.equal(P.call.provider.id, 'openai-codex')
  assert.equal(P.chipText(), 'ChatGPT (Codex subscription): on call')
  let texts = userTexts(pc.dc)
  assert.equal(texts[0], P.SWITCH_NOTE, 'the new voice first tells the user it switched')
  pc.dc.serve({ type: 'response.done' })
  texts = userTexts(pc.dc)
  assert.equal(texts[1], '[Hermes result] You have a dentist appointment at 4.')
  assert.equal(P.call.delegations, 0)
  assert.equal(sdk.requests.filter(r => r.method === 'prompt.submit').length, 1, 'the request is not re-submitted')
})

test('mid-call: an OpenAI quota error moves the call to paid Gemini and cools OpenAI down for the next call', async () => {
  const ctx = chainCtx(CODEX, PAID)
  const { dc } = await codexCall(ctx)
  dc.serve({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello there' })
  dc.serve({ type: 'error', error: { type: 'invalid_request_error', code: 'insufficient_quota', message: 'You exceeded your current quota' } })
  await settle(10)
  assert.deepEqual(ctx.bodies.at(-1).exclude, ['openai-codex'])
  assert.equal(ledger.peers[0].closed, true)
  const ws = ledger.sockets.at(-1)
  ws.open()
  ws.serve({ setupComplete: {} })
  await settle()
  assert.equal(P.call.provider.id, 'gemini-paid')
  assert.equal(P.chipText(), 'Gemini (paid key): on call')
  assert.equal(ws.sent[0].setup.model, 'models/gemini-3.8-live')
  P.tearDown('')
  await settle()
  const saved = sdk.requests.filter(r => r.method === 'prompt.submit')
  assert.equal(saved.length, 1)
  assert.match(saved[0].params.text, /Voice provider: ChatGPT \(Codex subscription\) -> Gemini \(paid key\)\n\nUser: hello there/)
  // next call: OpenAI is skipped while it cools down, then tried again
  const next = chainCtx(GEMINI)
  await P.start(next)
  await settle()
  assert.deepEqual(next.bodies[0], { exclude: ['openai-codex'] })
  P.tearDown('')
  later(P.COOLDOWN_MS + 1)
  const after = chainCtx(GEMINI)
  await P.start(after)
  await settle()
  assert.deepEqual(after.bodies[0], {})
  P.tearDown('')
})

test('a cooled-down provider is asked again when nothing else can serve', async () => {
  const first = chainCtx(CODEX, null)
  const { dc } = await codexCall(first)
  dc.serve({ type: 'error', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } })
  await settle(10)
  assertReleased()
  const exhausted = Object.assign(new Error('502'), { detail: { reason: 'exhausted', message: 'none' } })
  const again = chainCtx(exhausted, CODEX)
  await P.start(again)
  await settle(10)
  assert.deepEqual(again.bodies, [{ exclude: ['openai-codex'] }, {}])
  assert.equal(P.call.provider.id, 'openai-codex')
  P.tearDown('')
})

test('codex: a refused SDP exchange (429) fails over at connect time', async () => {
  ledger.sdpAnswer = { ok: false, status: 429, body: '{"error":{"code":"rate_limit_exceeded"}}' }
  const ctx = chainCtx(CODEX, PAID)
  await P.start(ctx)
  await settle(10)
  assert.equal(ctx.bodies.at(-1).reason, 'quota')
  assert.equal(P.call.provider.id, 'gemini-paid')
  assert.equal(ledger.peers[0].closed, true)
  assert.ok(ledger.tracks[0].stopped, 'the OpenAI microphone track is released')
  P.tearDown('')
  assertReleased()
})

// The same-provider backoff timer (1.0) fires only when a test says so.
async function fireRetry () {
  const id = P.call.retryTimer
  const fn = id != null && ledger.timers.get(id)
  if (!fn) return false
  ledger.timers.delete(id)
  fn()
  await settle(10)
  return true
}

test('codex: a failed peer connection reconnects, then fails over; both are bounded per call', async () => {
  const ctx = chainCtx(...Array(20).fill(CODEX))
  await codexCall(ctx)
  for (let i = 0; i < 20 && P.call.state !== 'idle'; i++) {
    ledger.peers.at(-1).fail()
    await settle(10)
    await fireRetry()
    if (P.call.state !== 'idle') { ledger.peers.at(-1).dc.open(); await settle() }
  }
  assert.equal(P.call.state, 'idle')
  assert.equal(ctx.bodies.filter(b => b && b.reconnect).length, P.MAX_RECONNECTS)
  assert.equal(ctx.bodies.filter(b => b && b.switch_from).length, P.MAX_SWITCHES)
  assert.equal(ctx.bodies.length, 1 + P.MAX_RECONNECTS + P.MAX_SWITCHES)
  assertReleased()
})

test('1.0: a network blip reconnects the SAME provider with the recent turns; nothing is announced or re-spoken', async () => {
  const ctx = chainCtx(GEMINI, GEMINI)
  const { ws } = await geminiCall(ctx)
  ws.serve({ serverContent: { inputTranscription: { text: 'what is on my calendar?' } } })
  ws.serve({ serverContent: { outputTranscription: { text: 'Let me check.' } } })
  ws.serve({ serverContent: { turnComplete: true } })
  await settle()
  ws.drop(1011, 'internal error')
  await settle()
  assert.equal(P.call.state, 'connecting')
  assert.equal(ctx.bodies.length, 1, 'waits SAME_PROVIDER_BACKOFF_MS before asking again')
  assert.ok(await fireRetry())
  const body = ctx.bodies.at(-1)
  assert.equal(body.provider, 'gemini-free')
  assert.equal(body.reconnect, true)
  assert.equal(body.reason, 'network')
  assert.equal(body.switch_from, undefined)
  assert.equal(body.exclude, undefined)
  assert.match(body.carry, /User: what is on my calendar\?/)
  const ws2 = ledger.sockets.at(-1)
  assert.notEqual(ws2, ws)
  ws2.open()
  ws2.serve({ setupComplete: {} })
  await settle()
  assert.equal(P.call.state, 'live')
  assert.equal(P.call.provider.id, 'gemini-free')
  assert.equal(P.call.retries, 0, 'a live reconnect resets the retries in a row')
  assert.ok(!ws2.sent.some(m => m.realtimeInput && JSON.stringify(m).includes('switch')), 'no switch note')
  assert.ok(!sdk.notes.some(n => /switching voice provider/.test(n.message)))
})

test('1.0: two failed reconnects move the call on along the chain, excluding the failed provider', async () => {
  const down = Object.assign(new Error('502'), { detail: { reason: 'exhausted', attempts: [{ provider: 'gemini-free', reason: 'unavailable' }] } })
  const ctx = chainCtx(GEMINI, down, down, PAID)
  const { ws } = await geminiCall(ctx)
  ws.drop(1011, 'internal error')
  await settle()
  assert.ok(await fireRetry())
  assert.ok(await fireRetry())
  assert.equal(await fireRetry(), false, 'no third retry')
  assert.deepEqual(ctx.bodies.map(b => b && (b.reconnect ? 'reconnect' : b.switch_from ? 'switch' : 'start')),
    ['start', 'reconnect', 'reconnect', 'switch'])
  assert.deepEqual(ctx.bodies.at(-1).exclude, ['gemini-free'])
  assert.equal(ctx.bodies.at(-1).reason, 'unavailable')
  const ws2 = ledger.sockets.at(-1)
  ws2.open(); ws2.serve({ setupComplete: {} }); await settle()
  assert.equal(P.call.provider.id, 'gemini-paid')
  P.tearDown('')
})

test('1.0: a quota close never retries the same provider', async () => {
  const ctx = chainCtx(GEMINI, PAID)
  const { ws } = await geminiCall(ctx)
  ws.drop(1011, 'RESOURCE_EXHAUSTED: quota exceeded')
  await settle(10)
  assert.equal(P.call.retryTimer, null)
  assert.equal(ctx.bodies.at(-1).switch_from, 'gemini-free')
  P.tearDown('')
})

test('1.0: no provider may take over mid-call (fallback_mid_call): the call ends with a spoken notice and a call-again action', async () => {
  const off = Object.assign(new Error('503'), { detail: { reason: 'exhausted', message: 'No voice provider could start.',
    attempts: [{ provider: 'gemini-free', reason: 'excluded' }, { provider: 'openai-codex', reason: 'mid_call_off' }] } })
  const ctx = chainCtx(GEMINI, off)
  const { ws } = await geminiCall(ctx)
  ws.drop(1011, 'RESOURCE_EXHAUSTED: quota exceeded')
  await settle(10)
  assertReleased()
  assert.equal(ledger.peers.length, 0, 'Codex was never started')
  assert.equal(ledger.spoken.at(-1).text, P.droppedNoticeText('en'))
  const note = sdk.notes.at(-1)
  assert.equal(note.kind, 'warning')
  assert.equal(note.action.label, 'Call again')
})

test('1.0: a Hermes part the user already heard is not read again after a switch', async () => {
  const ctx = chainCtx(GEMINI, CODEX)
  const { ws } = await geminiCall(ctx)
  ws.serve({ toolCall: { functionCalls: [{ id: 'c1', name: 'hermes_task', args: { request: 'calendar today' } }] } })
  ws.serve({ serverContent: { turnComplete: true } })
  await settle()
  later(5000)
  reply('You have a dentist appointment at 4.')
  await settle()
  const handed = ws.sent.filter(m => m.realtimeInput && JSON.stringify(m).includes('dentist'))
  assert.equal(handed.length, 1, 'the part was handed to the voice')
  ws.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAAAA==' } }] } } })
  ws.drop(1011, 'RESOURCE_EXHAUSTED: quota exceeded')
  await settle(10)
  const pc = ledger.peers.at(-1)
  pc.dc.open()
  await settle()
  pc.dc.serve({ type: 'response.done' })
  pc.dc.serve({ type: 'response.done' })
  assert.ok(!userTexts(pc.dc).some(t => t.includes('dentist')), 'heard part not repeated')
  P.tearDown('')
})

test('1.0: a Hermes part that was never heard is handed again after a switch', async () => {
  const ctx = chainCtx(GEMINI, CODEX)
  const { ws } = await geminiCall(ctx)
  ws.serve({ toolCall: { functionCalls: [{ id: 'c1', name: 'hermes_task', args: { request: 'calendar today' } }] } })
  ws.serve({ serverContent: { turnComplete: true } })
  await settle()
  later(5000)
  reply('You have a dentist appointment at 4.')
  await settle()
  ws.drop(1011, 'RESOURCE_EXHAUSTED: quota exceeded')
  await settle(10)
  const pc = ledger.peers.at(-1)
  pc.dc.open()
  await settle()
  pc.dc.serve({ type: 'response.done' })
  assert.ok(userTexts(pc.dc).some(t => t.includes('dentist')), 'unheard part handed to the new voice')
  P.tearDown('')
})

test('hang-up during a same-provider reconnect backoff opens nothing afterwards', async () => {
  const ctx = chainCtx(GEMINI, GEMINI)
  const { ws } = await geminiCall(ctx)
  ws.drop(1011, 'internal error')
  await settle()
  const id = P.call.retryTimer
  assert.ok(id != null)
  P.tearDown('')
  assert.equal(ledger.timers.has(id), false, 'the backoff timer is cleared')
  assert.equal(ctx.bodies.length, 1)
  assertReleased()
})

test('hang-up during a provider switch opens nothing afterwards', async () => {
  let release
  const ctx = makeCtx({ mint: body => (body && body.switch_from) ? new Promise(resolve => { release = resolve }) : Promise.resolve(GEMINI) })
  const { ws } = await geminiCall(ctx)
  ws.drop(1011, 'RESOURCE_EXHAUSTED: quota exceeded')
  await settle()
  assert.equal(P.call.state, 'connecting')
  P.tearDown('')
  release(CODEX)
  await settle(10)
  assert.equal(ledger.peers.length, 0)
  assertReleased()
})

test('end_call on Gemini followed by the socket closing does not switch providers', async () => {
  const ctx = chainCtx(GEMINI, CODEX)
  const { ws } = await geminiCall(ctx)
  ws.serve({ toolCall: { functionCalls: [{ id: 'c9', name: 'end_call', args: {} }] } })
  ws.drop(1011, 'gone')
  await settle()
  assert.equal(ctx.bodies.length, 1)
  assertReleased()
})

test('the failure reason is classified from close codes and vendor text', () => {
  assert.equal(P.failureReason('RESOURCE_EXHAUSTED', 1011), 'quota')
  assert.equal(P.failureReason('', 429), 'quota')
  assert.equal(P.failureReason('API key not valid', 1007), 'auth')
  assert.equal(P.failureReason('', 401), 'auth')
  assert.equal(P.failureReason('session expired', 1011), 'expired')
  assert.equal(P.failureReason('', 503), 'unavailable')
  assert.equal(P.failureReason('internal', 1011), 'network')
})
