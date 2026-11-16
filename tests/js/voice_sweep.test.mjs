import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'
const sdk = makeSdk()
const P = await loadPlugin(sdk)
let ledger, timers
const ev = payload => ({ session_id: 'sess-1', payload })
beforeEach(async () => {
  P.tearDown(); await settle(); P.resetAckMemory()
  const e = makeEnv(); ledger = e.ledger; timers = new Map()
  P.setEnv({ ...e.env, random: () => .99, log: () => {},
    setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id) })
  P.call.settings = { interim_guard_ms: 0, language: 'he', transcript_to_chat: 'off' }
  sdk.requestImpl = async () => ({ status: 'streaming' })
})
async function start () {
  await P.start(makeCtx({ mint: async () => ({ provider: 'openai-codex', transport: 'openai-realtime', brain: 'hermes', client_secret: 'synthetic', offer_url: 'https://api.openai.com/v1/realtime/calls' }) }))
  await settle(); const dc = ledger.peers.at(-1).dc; dc.open(); return dc
}
const texts = dc => dc.sent.filter(m => m.response?.metadata?.d2v === 'say').map(m => m.response.input[0].content[0].text)
function drain(dc) {
  for (let k = 0; k < 20; k++) {
    const req = dc.sent.filter(m => m.response?.metadata?.d2v === 'say').at(-1)
    if (!P.call.pendingHand && !P.call.queue.length) break
    dc.serve({ type: 'response.created', response: { id: `r${k}`, metadata: req.response.metadata } })
    dc.serve({ type: 'response.done', response: { id: `r${k}`, metadata: req.response.metadata, status: 'completed' } })
  }
}
test('V2 final punctuation revision never rereads a streamed soft-cut prefix', async () => {
  const dc = await start()
  const prefix = 'A Spotify curator that knows you: it learns your taste from your listening and your reactions, builds playlists with a'
  P.onMessageStart(ev({ turn_id: 'one' }))
  P.onMessageDelta(ev({ turn_id: 'one', text: prefix + ' personalized selection based on your mood and your favorite artists ' }))
  assert.ok(texts(dc).length)
  P.onMessageComplete(ev({ turn_id: 'one', text: prefix + '. It also learns from feedback.' }))
  drain(dc)
  assert.equal(texts(dc).join(' ').split(prefix).length - 1, 1)
  assert.match(texts(dc).join(' '), /It also learns from feedback/)
})
for (const kind of ['correction', 'stop']) test(`V3 ${kind}: late old frames cannot contaminate a new stream`, async () => {
  const dc = await start()
  P.onMessageStart(ev({ turn_id: 'old' }))
  P.onMessageDelta(ev({ turn_id: 'old', text: 'Old first sentence. Old queued sentence. ' }))
  dc.serve({ type: 'response.created', response: { id: 'old-audio' } })
  dc.serve({ type: 'input_audio_buffer.speech_started', item_id: 'user2' })
  dc.serve({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user2', transcript: kind === 'stop' ? 'stop' : 'Are we absolutely sure about that?' })
  dc.serve({ type: 'output_audio_buffer.cleared' })
  dc.serve({ type: 'response.done', response: { id: 'old-audio', status: 'cancelled' } })
  P.onMessageStart(ev({ turn_id: 'new' }))
  P.onMessageDelta(ev({ turn_id: 'new', text: 'New answer. ' }))
  P.onMessageDelta(ev({ turn_id: 'old', text: 'STALE delta. ' }))
  P.onMessageInterim(ev({ turn_id: 'old', segment: 1, text: 'STALE interim.' }))
  P.onMessageComplete(ev({ turn_id: 'old', text: 'STALE final.' }))
  P.onMessageComplete(ev({ turn_id: 'new', text: 'New answer. New tail.' }))
  drain(dc)
  assert.doesNotMatch(texts(dc).join(' '), /STALE|Old queued/)
  assert.match(texts(dc).join(' '), /New answer\. New tail\./)
})
test('V3 a correction discards completed queued groups, not just the currently held group', async () => {
  const dc = await start()
  P.onMessageStart(ev({ turn_id: 'first' }))
  P.onMessageDelta(ev({ turn_id: 'first', text: 'First answer. ' }))
  P.onMessageComplete(ev({ turn_id: 'first', text: 'First answer. First queued tail.' }))
  P.onMessageComplete(ev({ turn_id: 'second', text: 'STALE queued other reply.' }))
  P.onUserTurn('No please check the latest information', 10000)
  dc.serve({ type: 'response.done', response: { id: 'old-audio', status: 'cancelled' } })
  P.onMessageComplete(ev({ turn_id: 'third', text: 'Fresh answer.' }))
  drain(dc)
  assert.doesNotMatch(texts(dc).join(' '), /STALE|First queued/)
  assert.match(texts(dc).join(' '), /Fresh answer/)
})
test('V1 a borrowed backchannel is not a conversation-language switch', async () => {
  await start()
  P.onUserTurn('תבדוק בבקשה את הפרויקט הזה', 10000)
  P.onUserTurn('okay', 11000)
  assert.equal(P.callLang(), 'he')
  P.onUserTurn('Please explain this in English', 12000)
  assert.equal(P.callLang(), 'en')
  P.onUserTurn('תודה', 13000)
  assert.equal(P.callLang(), 'en')
})
test('V1 technical Latin names in a Hebrew request do not switch acknowledgments to English', async () => {
  P.call.settings.ack_source = 'model'
  const dc = await start()
  P.onUserTurn('תבדוק את Spotify Recommendation Engine GitHub repository', 10000)
  assert.equal(P.callLang(), 'he')
  const req = dc.sent.find(m => m.response?.metadata?.d2v === 'ack')
  dc.serve({ type: 'response.done', response: { id: 'ack1', metadata: req.response.metadata, status: 'completed', output: [{ content: [{ type: 'output_text', text: 'One moment.' }] }] } })
  for (const [id, tm] of [...timers]) if (tm.ms === 900) { timers.delete(id); tm.fn() }
  assert.equal(P.langOf(texts(dc).at(-1)), 'he')
  assert.equal(P.localLine('rest'), "ההמשך בצ'אט.")
})
test('V1 an English switch allows English ack; Hebrew okay remains a valid Hebrew ack', async () => {
  P.call.settings.ack_source = 'model'
  const dc = await start()
  P.onUserTurn('תבדוק בבקשה את הפרויקט הזה', 10000)
  P.onUserTurn('Please check the latest project status', 11000)
  assert.equal(P.callLang(), 'en')
  const req = dc.sent.filter(m => m.response?.metadata?.d2v === 'ack').at(-1)
  dc.serve({ type: 'response.done', response: { id: 'ack2', metadata: req.response.metadata, status: 'completed', output: [{ content: [{ type: 'output_text', text: 'One moment.' }] }] } })
  for (const [id, tm] of [...timers]) if (tm.ms === 900) { timers.delete(id); tm.fn() }
  assert.equal(texts(dc).at(-1), 'One moment.')
  assert.equal(P.ackDropReason('אוקיי, בוא נראה.', 'תבדוק את הפרויקט בבקשה'), '')
  P.onUserTurn('Please explain the Hebrew word שלום in English', 12000)
  assert.equal(P.callLang(), 'en', 'a quoted Hebrew word must not disable English practice')
})
for (const suffix of [' with useful recommendations.', '. Another sentence.']) test(`V2 prefix reconciliation preserves extension ${suffix}`, async () => {
  const dc = await start()
  const prefix = 'A Spotify curator that knows you: it learns your taste from your listening and your reactions, builds playlists with a'
  P.onMessageStart(ev({ turn_id: 'extended' }))
  P.onMessageDelta(ev({ turn_id: 'extended', text: prefix + ' long unfinished tail' }))
  P.onMessageComplete(ev({ turn_id: 'extended', text: prefix + suffix }))
  drain(dc)
  assert.equal(texts(dc).join(' ').split(prefix).length - 1, 1)
  assert.ok(texts(dc).join(' ').includes(suffix.replace(/^\. /, '')))
})
test('V3 stale partial text cannot cancel the new turn acknowledgment', async () => {
  await start()
  P.onMessageStart(ev({ turn_id: 'old' }))
  P.onUserTurn('Please check the latest answer instead', 10000)
  const ack = P.call.ackRequest
  assert.ok(ack)
  P.onMessageDelta(ev({ turn_id: 'old', text: 'STALE partial' }))
  assert.equal(P.call.ackRequest, ack)
})
test('V3 an interleaved late terminal never truncates the current reply or overwrites repeat memory', async () => {
  const dc = await start()
  P.onMessageStart(ev({ turn_id: 'old' }))
  P.onMessageDelta(ev({ turn_id: 'old', text: 'Old partial ' }))
  P.onUserTurn('Please check the latest answer instead', 10000)
  P.onMessageStart(ev({ turn_id: 'fresh' }))
  P.onMessageDelta(ev({ turn_id: 'fresh', text: 'Fresh first sentence. ' }))
  P.onMessageComplete(ev({ turn_id: 'old', text: 'STALE old completion.' }))
  P.onMessageDelta(ev({ turn_id: 'fresh', text: 'Fresh second sentence. ' }))
  P.onMessageComplete(ev({ turn_id: 'fresh', text: 'Fresh first sentence. Fresh second sentence.' }))
  drain(dc)
  assert.doesNotMatch(texts(dc).join(' '), /STALE|Old partial/)
  assert.equal(P.call.lastReply, 'Fresh first sentence. Fresh second sentence.')
})
