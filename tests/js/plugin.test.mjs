// node --test 'tests/js/*.test.mjs' — delegation seam, barge-in, transcript and the stop path of desktop/plugin.js.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'

const sdk = makeSdk()
const P = await loadPlugin(sdk)
let env, ledger

beforeEach(() => {
  P.tearDown()
  ;({ env, ledger } = makeEnv())
  P.setEnv(env)
  sdk.requests.length = 0
  sdk.notes.length = 0
  sdk.requestImpl = async () => ({ status: 'streaming' })
  sdk.host.state.activeSessionId.value = 'sess-1'
  sdk.host.state.focusedSessionId.value = 'sess-1'
  P.call.settings = { transcript_to_chat: 'chat_turn', half_duplex: false }
  P.call.detail = ''
})

async function liveCall (ctx = makeCtx()) {
  await P.start(ctx)
  await settle()
  const ws = ledger.sockets.at(-1)
  ws.open()
  ws.serve({ setupComplete: {} })
  await settle()
  return { ws, ctx }
}

const toolCall = (name, args, id = 'c1') => ({ toolCall: { functionCalls: [{ id, name, args }] } })

test('setup frame is the minted, locked setup and is sent first', async () => {
  const { ws } = await liveCall()
  assert.deepEqual(ws.sent[0], { setup: { model: 'models/gemini-3.8-live' } })
  assert.equal(P.call.state, 'live')
  assert.equal(ledger.tracks.length, 1, 'microphone opened after setupComplete')
})

test('hermes_task becomes prompt.submit on the OPEN chat with surface voice-live and voice_context', async () => {
  const { ws } = await liveCall()
  ws.serve({ serverContent: { inputTranscription: { text: 'תזכיר לי לקנות חלב' } } })
  ws.serve({ serverContent: { outputTranscription: { text: 'Sure, one moment.' } } })
  ws.serve(toolCall('hermes_task', { request: 'Remind me tomorrow at 9 to buy milk' }))
  await settle()
  const submits = sdk.requests.filter(r => r.method === 'prompt.submit')
  assert.equal(submits.length, 1)
  const p = submits[0].params
  assert.equal(p.session_id, 'sess-1')
  assert.equal(p.surface, 'voice-live')
  assert.equal(p.text, 'Remind me tomorrow at 9 to buy milk')
  assert.match(p.voice_context, /User: תזכיר לי לקנות חלב/)
  assert.match(p.voice_context, /Voice: Sure, one moment\./)
  assert.ok(!('display_kind' in p), 'delegations are visible user rows')
  // the model got a receipt at once
  const resp = ws.sent.find(m => m.toolResponse)
  assert.equal(resp.toolResponse.functionResponses[0].id, 'c1')
  assert.match(resp.toolResponse.functionResponses[0].response.result, /WORK_STARTED/)
  assert.equal(P.call.delegations, 1)
})

test('the chat is pinned at call start: switching chats mid-call does not move delegations', async () => {
  const { ws } = await liveCall()
  sdk.host.state.focusedSessionId.value = 'sess-OTHER'
  sdk.host.state.activeSessionId.value = 'sess-OTHER'
  ws.serve(toolCall('hermes_task', { request: 'check the weather' }))
  await settle()
  assert.equal(sdk.requests.find(r => r.method === 'prompt.submit').params.session_id, 'sess-1')
})

test('Hermes reply (message.complete on that chat) is handed back as [Hermes result] once the model is quiet', async () => {
  const { ws } = await liveCall()
  ws.serve(toolCall('hermes_task', { request: 'what is on my calendar' }))
  await settle()
  // model is speaking: result must wait
  ws.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } } })
  P.onMessageComplete({ type: 'message.complete', session_id: 'sess-OTHER', payload: { text: 'not ours' } })
  assert.equal(P.call.delegations, 1, 'other chats are ignored')
  P.onMessageComplete({ type: 'message.complete', session_id: 'sess-1', payload: { text: 'Dentist at 4pm.' } })
  assert.equal(ws.sent.filter(m => m.realtimeInput && m.realtimeInput.text).length, 0, 'not while speaking')
  ws.serve({ serverContent: { turnComplete: true } })
  const handed = ws.sent.filter(m => m.realtimeInput && m.realtimeInput.text)
  assert.equal(handed.length, 1)
  assert.equal(handed[0].realtimeInput.text, '[Hermes result] Dentist at 4pm.')
  assert.equal(P.call.delegations, 0)
})

const handedTexts = ws => ws.sent.filter(m => m.realtimeInput && m.realtimeInput.text).map(m => m.realtimeInput.text)

test('v0.2 receipt tells the model to say it once and not to keep announcing it is waiting', async () => {
  const { ws } = await liveCall()
  ws.serve(toolCall('hermes_task', { request: 'calendar tomorrow' }))
  await settle()
  const fr = ws.sent.find(m => m.toolResponse).toolResponse.functionResponses[0]
  assert.equal(fr.response.result, P.RECEIPT)
  assert.match(P.RECEIPT, /do not repeat that you are waiting/i)
  assert.ok(!('scheduling' in fr), 'unmeasured wire field stays out')
})

test('v0.2 late result: a LATER turn on the pinned chat (sub-agent finished) is still spoken', async () => {
  const { ws } = await liveCall()
  ws.serve(toolCall('hermes_task', { request: 'check my calendar tomorrow' }))
  await settle()
  // the delegated turn ends with a hand-off line…
  P.onMessageComplete({ type: 'message.complete', session_id: 'sess-1', payload: { text: 'Asked a sub-agent to check the calendar.' } })
  assert.equal(P.call.delegations, 0)
  ws.serve({ serverContent: { turnComplete: true } }) // the voice said it
  // …and the real answer arrives ~20 s later as a new turn on the same chat
  P.onMessageComplete({ type: 'message.complete', session_id: 'sess-1', payload: { text: 'Tomorrow: dentist at 16:00.' } })
  assert.deepEqual(handedTexts(ws), [
    '[Hermes result] Asked a sub-agent to check the calendar.',
    '[Hermes result] Tomorrow: dentist at 16:00.'
  ])
  // other chats still never reach the voice
  P.onMessageComplete({ type: 'message.complete', session_id: 'sess-OTHER', payload: { text: 'not ours' } })
  assert.equal(handedTexts(ws).length, 2)
})

test('v0.2 interim assistant messages in the same turn are handed over with the final text', async () => {
  const { ws } = await liveCall()
  ws.serve(toolCall('hermes_task', { request: 'calendar' }))
  await settle()
  P.onMessageInterim({ type: 'message.interim', session_id: 'sess-1', payload: { text: 'You have 2 meetings tomorrow.' } })
  P.onMessageInterim({ type: 'message.interim', session_id: 'sess-OTHER', payload: { text: 'nope' } })
  P.onMessageComplete({ type: 'message.complete', session_id: 'sess-1', payload: { text: 'The first is at 9.' } })
  assert.deepEqual(handedTexts(ws), ['[Hermes result] You have 2 meetings tomorrow.\n\nThe first is at 9.'])
  ws.serve({ serverContent: { turnComplete: true } })
  // an interim already contained in the final is not repeated
  P.onMessageInterim({ type: 'message.interim', session_id: 'sess-1', payload: { text: 'Done.' } })
  P.onMessageComplete({ type: 'message.complete', session_id: 'sess-1', payload: { text: 'Done. Booked.' } })
  assert.equal(handedTexts(ws).at(-1), '[Hermes result] Done. Booked.')
})

test('v0.2 an empty turn nobody waits for is dropped; an empty delegated turn still reports', async () => {
  const { ws } = await liveCall()
  P.onMessageComplete({ type: 'message.complete', session_id: 'sess-1', payload: { text: '' } })
  assert.equal(handedTexts(ws).length, 0)
  ws.serve(toolCall('hermes_task', { request: 'x' }))
  await settle()
  P.onMessageComplete({ type: 'message.complete', session_id: 'sess-1', payload: { text: '', status: 'error', error: 'rate limited' } })
  assert.deepEqual(handedTexts(ws), ['[Hermes result] Hermes stopped with an error: rate limited'])
})

test('v0.2 a model turn that never completes does not hold a result forever', async () => {
  let t = Date.UTC(2026, 10, 7, 12, 0, 0)
  P.setEnv({ ...env, now: () => t })
  const { ws } = await liveCall()
  ws.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } } })
  P.onMessageComplete({ type: 'message.complete', session_id: 'sess-1', payload: { text: 'Dentist at 4pm.' } })
  assert.equal(handedTexts(ws).length, 0, 'held while the model speaks')
  assert.equal(ledger.timers.size >= 1, true, 'a retry is armed')
  // audio finished playing, no turnComplete, 5 s of silence: the retry delivers it
  P.call.player.flush()
  t += 5000
  for (const [id, fn] of [...ledger.timers]) { ledger.timers.delete(id); fn() }
  assert.deepEqual(handedTexts(ws), ['[Hermes result] Dentist at 4pm.'])
})

test('v0.2 results are not handed to a call that already hung up', async () => {
  const { ws } = await liveCall()
  P.tearDown()
  P.onMessageComplete({ type: 'message.complete', session_id: 'sess-1', payload: { text: 'late' } })
  assert.equal(handedTexts(ws).length, 0)
})

test('a failed prompt.submit is spoken back, not swallowed', async () => {
  sdk.requestImpl = async () => { throw new Error('session busy') }
  const { ws } = await liveCall()
  ws.serve(toolCall('hermes_task', { request: 'x' }))
  await settle()
  const handed = ws.sent.filter(m => m.realtimeInput && m.realtimeInput.text)
  assert.equal(handed.length, 1)
  assert.match(handed[0].realtimeInput.text, /did not reach Hermes: session busy/)
  assert.equal(P.call.delegations, 0)
})

test('no open chat: the call refuses to start and opens nothing', async () => {
  sdk.host.state.focusedSessionId.value = null
  sdk.host.state.activeSessionId.value = null
  const ctx = makeCtx()
  await P.start(ctx)
  assert.equal(P.call.state, 'idle')
  assert.equal(ctx.rests.length, 0)
  assert.equal(ledger.sockets.length, 0)
  assert.match(sdk.notes[0].message, /Open a chat first/)
})

test('missing key: the backend message is shown and nothing is opened', async () => {
  const ctx = makeCtx({ mint: async () => { const e = new Error('503'); e.detail = { reason: 'no_key', message: 'Gemini Live needs GEMINI_API_KEY.' }; throw e } })
  await P.start(ctx)
  await settle()
  assert.equal(P.call.state, 'idle')
  assert.equal(P.call.detail, 'Gemini Live needs GEMINI_API_KEY.')
  assert.equal(ledger.sockets.length, 0)
  assert.equal(ledger.contexts.length, 0)
})

test('barge-in: serverContent.interrupted stops every queued audio buffer', async () => {
  const { ws } = await liveCall()
  ws.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAAAAAA' } }, { inlineData: { data: 'AAAAAAAA' } }] } } })
  const player = ledger.contexts.find(c => c.sampleRate === 24000)
  assert.equal(player.sources.length, 2)
  ws.serve({ serverContent: { interrupted: true } })
  assert.ok(player.sources.every(s => s.stopped), 'all queued audio stopped')
  assert.equal(P.call.modelSpeaking, false)
})

test('mic frames go up as realtimeInput.audio PCM16 at 16 kHz', async () => {
  const { ws } = await liveCall()
  ledger.worklet.port.onmessage({ data: new Float32Array(4800).fill(0.25) }) // 100 ms at 48 kHz
  const audio = ws.sent.filter(m => m.realtimeInput && m.realtimeInput.audio)
  assert.equal(audio.length, 1)
  assert.equal(audio[0].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000')
  assert.equal(Buffer.from(audio[0].realtimeInput.audio.data, 'base64').length, 1600 * 2)
})

// ── stop path ────────────────────────────────────────────────────────────────────────────────────

function assertAllReleased () {
  assert.equal(P.call.state, 'idle')
  assert.equal(P.call.ws, null)
  assert.equal(P.call.standby, null)
  assert.equal(P.call.stopMic, null)
  assert.equal(P.call.player, null)
  assert.equal(P.call.hangTimer, null)
  assert.ok(ledger.sockets.every(s => s.closed || s.readyState === 3), 'every socket closed')
  assert.ok(ledger.sockets.every(s => !s.onmessage && !s.onclose), 'no live handlers left')
  assert.ok(ledger.tracks.every(t => t.stopped), 'every mic track stopped')
  assert.ok(ledger.contexts.every(c => c.state === 'closed'), 'every AudioContext closed')
}

test('hang-up releases socket, mic tracks, both AudioContexts, and is idempotent', async () => {
  await liveCall()
  P.tearDown('')
  assertAllReleased()
  P.tearDown('')
  P.tearDown()
  assertAllReleased()
})

test('stop while the token is minting opens nothing afterwards', async () => {
  let release
  const ctx = makeCtx({ mint: () => new Promise(resolve => { release = resolve }) })
  const pending = P.start(ctx)
  await settle()
  assert.equal(P.call.state, 'connecting')
  P.tearDown('')
  release({ url: 'wss://x', setup: { setup: {} } })
  await pending
  await settle()
  assert.equal(ledger.sockets.length, 0)
  assert.equal(ledger.contexts.length, 0)
  assertAllReleased()
})

test('stop while the microphone permission prompt is open releases the late stream', async () => {
  let grant
  ledger.micGate = new Promise(resolve => { grant = resolve })
  await P.start(makeCtx())
  await settle()
  const ws = ledger.sockets.at(-1)
  ws.open()
  ws.serve({ setupComplete: {} })
  await settle()
  assert.equal(ledger.micCalls, 1)
  P.tearDown('')
  grant()
  await settle()
  assert.equal(ledger.tracks.length, 1)
  assertAllReleased()
})

test('remote close tears the call down when no other provider can take over', async () => {
  let n = 0
  const ctx = makeCtx({ mint: async () => { if (n++) { const e = new Error('503'); e.detail = { reason: 'exhausted', message: 'No voice provider could start.' }; throw e } return { url: 'wss://x', setup: { setup: {} } } } })
  const { ws } = await liveCall(ctx)
  ws.drop(1011, 'internal')
  await settle()
  // 1.0: a network-class close first reconnects the same provider (SAME_PROVIDER_BACKOFF_MS)
  for (let i = 0; i < P.SAME_PROVIDER_BACKOFF_MS.length && P.call.retryTimer; i++) {
    const id = P.call.retryTimer
    const fn = ledger.timers.get(id); ledger.timers.delete(id); fn()
    await settle(10)
  }
  assertAllReleased()
  assert.match(P.call.detail, /1011/)
  assert.match(P.call.detail, /No voice provider could start/)
})

test('a normal close (1000) ends the call without a provider switch', async () => {
  const ctx = makeCtx()
  const { ws } = await liveCall(ctx)
  ws.drop(1000, '')
  await settle()
  assertAllReleased()
  assert.equal(ctx.rests.filter(r => r.path === '/session').length, 1)
})

test('end_call: goodbye plays out, then the call hangs up on turnComplete', async () => {
  const { ws } = await liveCall()
  ws.serve(toolCall('end_call', {}, 'c9'))
  assert.equal(P.call.state, 'live')
  assert.equal(ledger.timers.size, 1, 'grace timer armed')
  ws.serve({ serverContent: { turnComplete: true } })
  assertAllReleased()
  assert.equal(ledger.timers.size, 0, 'grace timer cleared')
})

test('plugin dispose (disable / hot reload) hangs up', async () => {
  const disposers = []
  const ctx = makeCtx({ onEvent: () => {}, onDispose: fn => disposers.push(fn), register: () => {} })
  P.default.register(ctx)
  await liveCall()
  disposers.forEach(fn => fn())
  assertAllReleased()
})

test('late frames from a closed socket are ignored', async () => {
  const { ws } = await liveCall()
  const onmessage = ws.onmessage
  P.tearDown('')
  onmessage({ data: JSON.stringify(toolCall('hermes_task', { request: 'ghost' })) })
  await settle()
  assert.equal(sdk.requests.filter(r => r.params && r.params.text === 'ghost').length, 0)
})

test('goAway resumes on a new socket with the last handle and closes the old one', async () => {
  const ctx = makeCtx()
  const { ws } = await liveCall(ctx)
  ws.serve({ sessionResumptionUpdate: { newHandle: 'h-42', resumable: true } })
  ws.serve({ goAway: { timeLeft: '10s' } })
  await settle()
  // v0.4: a handle belongs to the key that issued it, so the resume is pinned to that provider
  assert.deepEqual(ctx.rests.at(-1).opts.body, { resume_handle: 'h-42', provider: 'gemini-free' })
  const fresh = ledger.sockets.at(-1)
  assert.notEqual(fresh, ws)
  fresh.open()
  fresh.serve({ setupComplete: {} })
  assert.equal(P.call.ws, fresh)
  assert.ok(ws.closed)
  assert.equal(ledger.tracks.length, 1, 'microphone is reused, not reopened')
  P.tearDown('')
  assertAllReleased()
})

// ── transcript ───────────────────────────────────────────────────────────────────────────────────

test('hang-up saves the transcript once to the open chat (queued turn) and to the data folder', async () => {
  const { ws, ctx } = await liveCall()
  ws.serve({ serverContent: { inputTranscription: { text: 'שלום, ' } } })
  ws.serve({ serverContent: { inputTranscription: { text: 'מה שלומך?' } } })
  ws.serve({ serverContent: { outputTranscription: { text: 'Hi there!' } } })
  P.tearDown('')
  await settle()
  const saves = sdk.requests.filter(r => r.method === 'prompt.submit')
  assert.equal(saves.length, 1)
  assert.equal(saves[0].params.session_id, 'sess-1')
  assert.equal(saves[0].params.queued, true)
  assert.ok(!saves[0].params.surface, 'not a voice delegation')
  assert.ok(saves[0].params.text.startsWith(P.TRANSCRIPT_HEADER + '\n\n'), 'the hang-up note heads the turn')
  assert.equal(P.TRANSCRIPT_HEADER, '[Voice call transcript. Check it for any request that was not delegated or answered in this chat, and for any voice bug; report only problems. Otherwise do not comment on the call: the user often hangs up only to save live quota, so continue the conversation in text from where the call left off (last open point or next step), in one or two lines.]')
  assert.match(saves[0].params.text, /User: שלום, מה שלומך\?\nVoice: Hi there!/)
  assert.equal(ctx.written.length, 1)
  assert.equal(ctx.written[0].folder, 'data')
  assert.match(ctx.written[0].path, /^transcript-2026-11-07T12-00-00-000Z\.md$/)
})

test('transcript_to_chat=off saves nothing; file mode writes only the data folder', async () => {
  P.call.settings = { transcript_to_chat: 'off' }
  let { ws, ctx } = await liveCall()
  ws.serve({ serverContent: { inputTranscription: { text: 'hello' } } })
  P.tearDown('')
  await settle()
  assert.equal(sdk.requests.length, 0)
  assert.equal(ctx.written.length, 0)
  P.call.settings = { transcript_to_chat: 'file' }
  ;({ ws, ctx } = await liveCall())
  ws.serve({ serverContent: { inputTranscription: { text: 'hello' } } })
  P.tearDown('')
  await settle()
  assert.equal(sdk.requests.length, 0)
  assert.equal(ctx.written.length, 1)
})

test('an empty call writes no transcript', async () => {
  const { ctx } = await liveCall()
  P.tearDown('')
  await settle()
  assert.equal(sdk.requests.length, 0)
  assert.equal(ctx.written.length, 0)
})

test('voice_context keeps only the most recent turns', async () => {
  const { ws } = await liveCall()
  for (let i = 0; i < 20; i++) {
    ws.serve({ serverContent: { inputTranscription: { text: `q${i}` } } })
    ws.serve({ serverContent: { outputTranscription: { text: `a${i}` } } })
  }
  ws.serve(toolCall('hermes_task', { request: 'go' }))
  await settle()
  const ctxText = sdk.requests.find(r => r.method === 'prompt.submit').params.voice_context
  assert.equal(ctxText.split('\n').length, P.CONTEXT_TURNS)
  assert.ok(!ctxText.includes('q0'))
  assert.match(ctxText, /q19/)
})

test('pure helpers: resample and PCM round trip', () => {
  assert.equal(P.resample(new Float32Array(4800), 48000, 16000).length, 1600)
  const b64 = P.floatToB64(new Float32Array([0, 0.5, -0.5, 1, -1]))
  const pcm = P.b64ToPcm(b64)
  assert.deepEqual(Array.from(pcm), [0, 16383, -16384, 32767, -32768])
})
