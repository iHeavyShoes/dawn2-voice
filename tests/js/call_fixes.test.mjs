import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'
const sdk = makeSdk()
const P = await loadPlugin(sdk)
let ledger, timers, now
beforeEach(async () => {
  P.tearDown(); await settle()
  const e = makeEnv(); ledger = e.ledger; timers = new Map(); now = 10000
  P.setEnv({ ...e.env, now: () => now, random: () => .99, log: () => {},
    setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id) })
  sdk.requests.length = 0
  sdk.requestImpl = async () => ({ status: 'streaming' })
  P.call.settings = { language: 'he', persona_name: 'Ray', persona_name_he: 'ריי', transcript_to_chat: 'off' }
})
const ev = payload => ({ session_id: 'sess-1', payload })
const AUDIO = { inlineData: { data: 'AAAAAA==' } }
const fire = ms => { now += ms; for (const [id, tm] of [...timers]) if (tm.ms === ms) { timers.delete(id); tm.fn() } }
async function start (overrides = {}) {
  const ctx = makeCtx({ mint: async () => ({ provider: 'gemini-free', brain: 'hermes', url: 'wss://example.invalid', setup: {} }) })
  if (overrides.rest) {
    const original = ctx.rest
    ctx.rest = (path, opts) => path === '/session' ? original(path, opts) : overrides.rest(path, opts)
  }
  await P.start(ctx)
  const ws = ledger.sockets.at(-1); ws.open(); ws.serve({ setupComplete: {} }); await settle(); return ws
}
const says = ws => ws.sent.filter(x => x.realtimeInput?.text).map(x => x.realtimeInput.text)
function reads (ws) {
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] } } })
  ws.serve({ serverContent: { turnComplete: true } })
  for (const c of ledger.contexts) for (const s of c.sources) s.onended?.()
}

test('a re-sent start and delta cannot replay the streamed first sentence', async () => {
  const ws = await start()
  P.onMessageStart(ev({ turn_id: 'once' }))
  P.onMessageDelta(ev({ turn_id: 'once', segment: 0, offset: 0, text: 'לא בטוח שהבנתי. ' }))
  reads(ws)
  P.onMessageStart(ev({ turn_id: 'once' }))
  P.onMessageDelta(ev({ turn_id: 'once', segment: 0, offset: 0, text: 'לא בטוח שהבנתי. ' }))
  P.onMessageComplete(ev({ text: 'לא בטוח שהבנתי. אפשר להסביר שוב?' }))
  reads(ws)
  assert.equal(says(ws).filter(x => x.includes('לא בטוח שהבנתי')).length, 1)
})

test('unfinished utterance waits one 400ms classifier window and merges a continuation', async () => {
  await start()
  P.onUserTurn('חשבתי על זה אבל', now)
  assert.equal(sdk.requests.filter(x => x.params?.surface === 'voice-live').length, 0)
  P.onUserTurn('בעצם אני מעדיף משהו אחר', now + 200)
  const sub = sdk.requests.filter(x => x.params?.surface === 'voice-live')
  assert.deepEqual(sub.map(x => x.params.text), ['חשבתי על זה אבל בעצם אני מעדיף משהו אחר'])
})

test('saved transcript drops niqqud and foreign scripts, preserves Hebrew/Latin/numbers', async () => {
  const ws = await start()
  ws.serve({ serverContent: { inputTranscription: { text: 'שָׁלוֹם مرحبا Hello 123 שלום' }, turnComplete: true } })
  fire(400)
  const transcript = P.formatTranscript(P.call.turns)
  assert.match(transcript, /שלום/)
  assert.match(transcript, /Hello 123/)
  assert.doesNotMatch(transcript, /[\u0591-\u05c7\u0600-\u06ff]/u)
})

test('model ack uses only last utterance and last Hermes sentence, waits 900ms', async () => {
  const requests = []
  const ws = await start({ rest: async (path, opts) => {
    requests.push({ path, opts }); return { text: 'אה, הבנתי, רגע.' }
  } })
  P.call.lastReply = 'Private earlier history. זאת התשובה האחרונה.'
  P.onUserTurn('תבדוק מה השתנה מאז הפעם האחרונה', now)
  await settle()
  assert.equal(says(ws).length, 0)
  const body = requests.find(x => x.path === '/ack')?.opts.body
  assert.deepEqual(body, { provider: 'gemini-free', utterance: 'תבדוק מה השתנה מאז הפעם האחרונה', previous_sentence: 'זאת התשובה האחרונה.' })
  fire(900)
  assert.equal(says(ws).at(-1), '[Say aloud] אה, הבנתי, רגע.')
})

test('600ms timeout uses bank at 900ms; late model response cannot ack twice', async () => {
  let resolve
  const ws = await start({ rest: path => path === '/ack' ? new Promise(r => { resolve = r }) : Promise.resolve({}) })
  P.onUserTurn('תבדוק מה השתנה מאז הפעם האחרונה', now)
  fire(600)
  fire(900)
  assert.equal(says(ws).length, 1)
  resolve({ text: 'אה, הבנתי, רגע.' }); await settle()
  assert.equal(says(ws).length, 1)
})

test('even a partial first Hermes delta suppresses the ack before a full sentence', async () => {
  const ws = await start({ rest: async () => ({ text: 'אה, הבנתי, רגע.' }) })
  P.onUserTurn('תבדוק מה השתנה מאז הפעם האחרונה', now)
  await settle()
  P.onMessageDelta(ev({ text: 'התשובה' }))
  fire(900)
  assert.equal(says(ws).length, 0)
})

test('barge-in cuts a playing ack and it never resumes after a backchannel', async () => {
  const ws = await start({ rest: async () => ({ text: 'אה, הבנתי, רגע.' }) })
  P.onUserTurn('תבדוק מה השתנה מאז הפעם האחרונה', now)
  await settle(); fire(900)
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] } } })
  assert.ok(ledger.contexts.some(c => c.sources.some(s => !s.stopped)))
  ws.serve({ serverContent: { inputTranscription: { text: 'כן' } } })
  assert.ok(ledger.contexts.every(c => c.sources.every(s => s.stopped)))
  assert.equal(P.call.held, null)
})

test('preempt an ack before its first audio: the muted terminal releases the queued Hermes reply', async () => {
  const ws = await start({ rest: async () => ({ text: 'אה, הבנתי, רגע.' }) })
  P.onUserTurn('תבדוק מה השתנה מאז הפעם האחרונה', now)
  await settle(); fire(900)
  P.onMessageDelta(ev({ text: 'התשובה החדשה. ' }))
  reads(ws)
  assert.equal(says(ws).at(-1), '[Say aloud] התשובה החדשה.')
})

test('Hermes text cuts a playing ack before queuing its own audio', async () => {
  const ws = await start({ rest: async () => ({ text: 'אה, הבנתי, רגע.' }) })
  P.onUserTurn('תבדוק מה השתנה מאז הפעם האחרונה', now)
  await settle(); fire(900)
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] } } })
  P.onMessageDelta(ev({ text: 'התשובה החדשה. ' }))
  assert.ok(ledger.contexts.every(c => c.sources.every(s => s.stopped)))
  assert.ok(!P.call.queue.some(i => i.kind === 'ack'))
})

async function codex () {
  await P.start(makeCtx({ mint: async () => ({ provider: 'openai-codex', transport: 'openai-realtime', brain: 'hermes', client_secret: 'test-ephemeral', offer_url: 'https://api.openai.com/v1/realtime/calls' }) }))
  await settle()
  const dc = ledger.peers.at(-1).dc; dc.open(); return dc
}

test('OpenAI ack is text-only out-of-band, no history/tools, and only guarded text is spoken', async () => {
  const dc = await codex()
  P.onUserTurn('please check what changed in the project', now)
  const request = dc.sent.find(x => x.type === 'response.create')
  assert.deepEqual(request.response.output_modalities, ['text'])
  assert.deepEqual(request.response.tools, [])
  assert.equal(request.response.conversation, 'none')
  const metadata = request.response.metadata
  dc.serve({ type: 'response.created', response: { id: 'ack1', metadata } })
  assert.equal(P.call.rtc.responding, false)
  dc.serve({ type: 'response.done', response: { id: 'ack1', metadata, status: 'completed', output: [{ content: [{ type: 'output_text', text: 'Ah, let me see.' }] }] } })
  fire(900)
  const spoken = dc.sent.filter(x => x.response?.output_modalities?.includes('audio'))
  assert.equal(spoken.length, 1)
  assert.equal(spoken[0].response.input[0].content[0].text, 'Ah, let me see.')
})

test('OpenAI optional ack refusal never surfaces as a voice-session failure', async () => {
  const dc = await codex()
  P.onUserTurn('please check what changed in the project', now)
  const request = dc.sent.find(x => x.type === 'response.create')
  dc.serve({ type: 'error', error: { event_id: request.event_id, message: 'quota: optional text response refused' } })
  assert.equal(P.call.state, 'live')
  assert.equal(P.call.detail, '')
})

test('Gemini voiceActivity EOS submits at 400ms even when relay produces no model output', async () => {
  const ws = await start()
  ws.serve({ serverContent: { inputTranscription: { text: 'תבדוק מה השתנה מאז הפעם האחרונה' } } })
  ws.serve({ voiceActivity: { type: 'ACTIVITY_END', audioOffset: '1s' } })
  fire(400)
  assert.equal(sdk.requests.filter(x => x.params?.surface === 'voice-live').length, 1)
})

test('OpenAI waits for final transcription and deduplicates a re-sent final by item id', async () => {
  const dc = await codex()
  dc.serve({ type: 'input_audio_buffer.speech_started', item_id: 'u1' })
  dc.serve({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'u1', delta: 'please check what changed in the project' })
  dc.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' })
  fire(400)
  assert.equal(sdk.requests.filter(x => x.params?.surface === 'voice-live').length, 0, 'a partial transcript can still change')
  dc.serve({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'please check what changed in the project' })
  dc.serve({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'please check what changed in the project' })
  assert.equal(sdk.requests.filter(x => x.params?.surface === 'voice-live').length, 1)
})

test('provider release cancels a pending model ack; late text cannot leak to the next voice', async () => {
  let resolve
  const ws = await start({ rest: path => path === '/ack' ? new Promise(r => { resolve = r }) : Promise.resolve({}) })
  P.onUserTurn('תבדוק מה השתנה מאז הפעם האחרונה', now)
  await P.failover('network', 'switch')
  assert.equal(P.call.ackRequest, null, 'release cancels before any old deadline fires')
  resolve({ text: 'אה, הבנתי, רגע.' }); await settle()
  fire(600); fire(900)
  assert.equal(P.call.ackRequest, null)
  assert.equal(says(ws).length, 0)
})

test('reuse terminal never replays the previous completed reply before a correction', async () => {
  const ws = await start()
  P.onMessageStart(ev({ turn_id: 'old' }))
  P.onMessageComplete(ev({ text: 'לא בטוח שהבנתי. הנה ההסבר הקודם.' }))
  reads(ws)
  const before = says(ws).length
  P.onUserTurn('שיניתי דעתי לגבי התשובה הקודמת', now)
  P.onMessageStart(ev({ turn_id: 'reused' }))
  P.onMessageComplete(ev({ text: 'לא בטוח שהבנתי. הנה ההסבר הקודם.', response_reused: true }))
  reads(ws)
  assert.equal(says(ws).length, before)
  P.onMessageStart(ev({ turn_id: 'new' }))
  P.onMessageComplete(ev({ text: 'זאת התשובה החדשה.' }))
  reads(ws)
  assert.equal(says(ws).at(-1), '[Say aloud] זאת התשובה החדשה.')
})
