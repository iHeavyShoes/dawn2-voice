// node --test 'tests/js/*.test.mjs' — 1.0: a backchannel resumes the reply from the START of the
// sentence it cut (never mid-sentence, never dropping Latin tokens), and the transcript records
// Hermes' own words, not the voice model's output transcription.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'
const sdk = makeSdk()
const P = await loadPlugin(sdk)
let ledger, timers, now
beforeEach(async () => {
  P.tearDown(); await settle()
  P.resetAckMemory()
  const e = makeEnv(); ledger = e.ledger; timers = new Map(); now = 10000
  P.setEnv({ ...e.env, now: () => now, random: () => 0, log: () => {}, // random 0: the ack stays silent
    setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id) })
  sdk.requests.length = 0
  sdk.requestImpl = async () => ({ status: 'streaming' })
  P.call.settings = { language: 'he', persona_name: 'Ray', persona_name_he: 'ריי', transcript_to_chat: 'off' }
})
const ev = payload => ({ session_id: 'sess-1', payload })
const AUDIO = { inlineData: { data: 'AAAAAA==' } }
async function start () {
  const ctx = makeCtx({ mint: async () => ({ provider: 'gemini-free', brain: 'hermes', url: 'wss://example.invalid', setup: {} }) })
  await P.start(ctx)
  const ws = ledger.sockets.at(-1); ws.open(); ws.serve({ setupComplete: {} }); await settle(); return ws
}
const says = ws => ws.sent.filter(x => x.realtimeInput?.text).map(x => x.realtimeInput.text)
const SAY = '[Say aloud] '
const S1 = 'הייתי מאחד הכל לחשבון אחד, החשבון הראשי ZorroK42, ונותן לו את השם BlueFoxes.'
const S2 = 'משנים את ZorroK42 ל-BlueFoxes בהגדרות.'
const S3 = 'זה לוקח דקה.'
const S0 = 'שאלה טובה.'
const assistantLines = () => P.call.turns.filter(t => t.role === 'assistant').map(t => t.text)
// S0 is handed alone; S1–S3 stream in while it is read, so they are handed as ONE merged message.
function readS0ThenMerged (ws) {
  P.onUserTurn('מה לעשות עם החשבונות?', now)
  P.onMessageStart(ev({ turn_id: 't1' }))
  P.onMessageDelta(ev({ turn_id: 't1', segment: 0, offset: 0, text: `${S0} ` }))
  P.onMessageDelta(ev({ turn_id: 't1', segment: 0, offset: S0.length + 1, text: `${S1} ${S2} ${S3} ` }))
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: S0 } } })
  ws.serve({ serverContent: { turnComplete: true } })
  assert.equal(says(ws).at(-1), SAY + [S1, S2, S3].join(' '), 'the ready sentences go as one message')
}

test('heardParts: counts only sentences heard to their end; short transcription never skips one', () => {
  const parts = [S1, S2, S3]
  assert.equal(P.heardParts(parts, ''), 0)
  assert.equal(P.heardParts(parts, 'הייתי מאחד הכל'), 0)
  assert.equal(P.heardParts(parts, S1), 1)
  assert.equal(P.heardParts(parts, `${S1} משנים את`), 1)
  // pointed, defective spelling (shorter): errs towards re-reading S1, never skipping it
  assert.equal(P.heardParts(parts, 'הָיִיתִי מְאַחֵד הַכֹּל לְחֶשְׁבּוֹן אֶחָד הַחֶשְׁבּוֹן הָרָאשִׁי ZorroK42 וְנוֹתֵן לוֹ אֶת הַשֵּׁם BlueFox'), 0)
})

test('backchannel mid-sentence: the reply resumes at the start of the cut sentence, Latin tokens intact', async () => {
  const ws = await start()
  readS0ThenMerged(ws)
  // S1 is read in full and S2 is cut after "משנים את"
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: `${S1} משנים את` } } })
  ws.serve({ serverContent: { interrupted: true } })
  P.onUserTurn('כן', now) // a backchannel
  const resumed = says(ws).at(-1)
  assert.equal(resumed, SAY + `${S2} ${S3}`, 'S2 is read again from its first word; S1 is not repeated')
  assert.match(resumed, /ZorroK42 ל-BlueFoxes/)
})

test('backchannel inside the FIRST sentence: the first sentence is read again whole', async () => {
  const ws = await start()
  P.onUserTurn('מה לעשות עם החשבונות?', now)
  P.onMessageStart(ev({ turn_id: 't1' }))
  P.onMessageDelta(ev({ turn_id: 't1', segment: 0, offset: 0, text: `${S1} ${S2} ` }))
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'הייתי מאחד הכל' } } })
  ws.serve({ serverContent: { interrupted: true } })
  P.onUserTurn('אוקיי', now)
  assert.equal(says(ws).at(-1), SAY + `${S1} ${S2}`)
})

test('transcript: a Voice line is Hermes\' own text, not the output transcription', async () => {
  const ws = await start()
  P.onUserTurn('מה לעשות עם החשבונות?', now)
  P.onMessageStart(ev({ turn_id: 't1' }))
  P.onMessageDelta(ev({ turn_id: 't1', segment: 0, offset: 0, text: `${S2} ` }))
  // Gemini transcribes pointed, defective spelling and drops the Latin token
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'מְשַׁנִּים אֶת לְBlueFoxes בַּהַגְדָּרוֹת' } } })
  ws.serve({ serverContent: { turnComplete: true } })
  assert.deepEqual(assistantLines(), [S2])
  assert.doesNotMatch(P.formatTranscript(P.call.turns), /משנים את לBlueFoxes/)
})

test('transcript after a barge-in + backchannel: every heard sentence once, in order', async () => {
  const ws = await start()
  readS0ThenMerged(ws)
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: `${S1} משנים את` } } })
  ws.serve({ serverContent: { interrupted: true } })
  P.onUserTurn('כן', now)
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: `${S2} ${S3}` } } })
  ws.serve({ serverContent: { turnComplete: true } })
  // S2 was heard in part before the cut: it is logged with S1; the re-read does not log it again
  assert.deepEqual(assistantLines(), [S0, `${S1} ${S2}`, S3])
})

test('transcript: an ack or local line still uses the output transcription', async () => {
  const ws = await start()
  P.onUserTurn('היי', now) // a greeting: a local line
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'היי, אני כאן.' } } })
  ws.serve({ serverContent: { turnComplete: true } })
  assert.deepEqual(assistantLines(), ['היי, אני כאן.'])
})

test('OpenAI: the transcript keeps the reply text; the output transcript only locates the cut', async () => {
  await P.start(makeCtx({ mint: async () => ({ provider: 'openai-codex', transport: 'openai-realtime', brain: 'hermes', client_secret: 'test-ephemeral', offer_url: 'https://api.openai.com/v1/realtime/calls' }) }))
  await settle()
  const dc = ledger.peers.at(-1).dc; dc.open()
  P.onUserTurn('מה לעשות עם החשבונות?', now)
  P.onMessageStart(ev({ turn_id: 't1' }))
  P.onMessageDelta(ev({ turn_id: 't1', segment: 0, offset: 0, text: `${S2} ` }))
  const say = dc.sent.filter(x => x.response?.metadata?.d2v === 'say').at(-1)
  assert.equal(say.response.input[0].content[0].text, S2)
  dc.serve({ type: 'response.created', response: { id: 'r-1', metadata: say.response.metadata } })
  dc.serve({ type: 'output_audio_buffer.started' })
  dc.serve({ type: 'response.output_audio_transcript.delta', delta: 'משנים את לBlueFoxes בהגדרות' })
  dc.serve({ type: 'response.done', response: { id: 'r-1', metadata: say.response.metadata, status: 'completed' } })
  assert.deepEqual(assistantLines(), [S2])
})

test('the read-aloud instructions forbid dropping Latin tokens inside Hebrew', () => {
  assert.match(P.SAY_INSTRUCTIONS, /Latin-script word.*never skip one/)
})
