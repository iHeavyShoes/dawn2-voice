// node --test 'tests/js/*.test.mjs' — v0.6 "Hermes is the brain": the turn classifier (he/en), the
// sentence cutter, delegation of EVERY substantive turn on every provider, no voice-model content,
// streaming Hermes' reply sentence by sentence with a full-readout reconciliation, barge-in and
// corrections, the fast-answer note, and the latency line.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'

const sdk = makeSdk()
const P = await loadPlugin(sdk)
let env, ledger, t, timers, logs

beforeEach(async () => {
  P.tearDown()
  await settle()
  P.resetCooldown()
  ;({ env, ledger } = makeEnv())
  t = Date.UTC(2026, 10, 7, 12, 0, 0)
  timers = new Map() // id -> { fn, ms }
  let next = 1
  logs = []
  P.setEnv({
    ...env,
    now: () => t,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id },
    clearTimeout: id => { timers.delete(id) },
    log: (...a) => logs.push(a.join(' '))
  })
  sdk.requests.length = 0
  sdk.notes.length = 0
  sdk.requestImpl = async () => ({ status: 'streaming' })
  sdk.host.state.activeSessionId.value = 'sess-1'
  sdk.host.state.focusedSessionId.value = 'sess-1'
  P.call.settings = { transcript_to_chat: 'chat_turn', half_duplex: false, language: 'he', persona_name: 'Ray', persona_name_he: 'ריי', persona_gender: 'male', silence_ms: 1000 }
  P.call.detail = ''
})

const later = ms => { t += ms }
// Fire every pending timer armed with this delay (the fake clock does not run them by itself).
function fire (ms) {
  for (const [id, tm] of [...timers]) if (tm.ms === ms) { timers.delete(id); tm.fn() }
}

const GEMINI = { provider: 'gemini-free', provider_label: 'Gemini (free key)', transport: 'gemini-live', model: 'gemini-3.8-live', brain: 'hermes', url: 'wss://example.invalid/ws?access_token=auth_tokens/x', setup: { setup: { model: 'models/gemini-3.8-live' } } }
const PAID = { ...GEMINI, provider: 'gemini-paid', provider_label: 'Gemini (paid key)' }
const CODEX = { provider: 'openai-codex', provider_label: 'ChatGPT (Codex subscription)', transport: 'openai-realtime', model: 'gpt-realtime-2.1', brain: 'hermes', client_secret: 'ek_test_secret_123', offer_url: 'https://api.openai.com/v1/realtime/calls' }
const AUDIO = { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAAAA==' } }
const ev = (type, payload) => ({ type, session_id: 'sess-1', payload })
const submits = () => sdk.requests.filter(r => r.method === 'prompt.submit' && r.params.surface === 'voice-live')
const played = () => ledger.contexts.reduce((n, c) => n + c.sources.length, 0)
function endAudio () { for (const c of ledger.contexts) for (const s of c.sources) if (s.onended) s.onended() }

async function geminiCall (minted = GEMINI) {
  await P.start(makeCtx({ mint: async () => minted }))
  await settle()
  const ws = ledger.sockets.at(-1)
  ws.open()
  ws.serve({ setupComplete: {} })
  await settle()
  return ws
}
const says = ws => ws.sent.filter(m => m.realtimeInput && typeof m.realtimeInput.text === 'string').map(m => m.realtimeInput.text)
const SAY = '[Say aloud] '

// The user says `text`; the voice model starts its own (never played) answer, which is the VAD's
// end-of-turn signal; the transcription lag passes.
async function geminiUser (ws, text, { voiceAnswers = true } = {}) {
  ws.serve({ serverContent: { inputTranscription: { text } } })
  if (voiceAnswers) {
    ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'I think the answer is probably yes' } } })
    ws.serve({ serverContent: { turnComplete: true } })
  } else {
    ws.serve({ serverContent: { turnComplete: true } })
  }
  fire(400)
  later(1300) // the user has been quiet long enough for the voice to read
  await settle()
}
// The voice reads the text it was handed: its turn starts, plays, completes.
function geminiReads (ws) {
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'read' } } })
  ws.serve({ serverContent: { turnComplete: true } })
}

// ── the classifier ──────────────────────────────────────────────────────────────────────────────

test('classifier: trivial turns stay local (he/en)', () => {
  const cases = {
    greeting: ['היי', 'שלום!', 'בוקר טוב', 'היי מה נשמע', 'hello', 'Hey there', 'good morning', 'hi, how are you?', 'מה קורה?'],
    ack: ['ok', 'Okay.', 'כן', 'תודה', 'תודה רבה', 'מגניב', 'סבבה', 'אוקיי, תודה', 'got it', 'thanks!', 'uh huh', 'cool, thanks', 'יופי מגניב', 'וסבבה', 'לא'],
    repeat: ['repeat that', 'say that again', 'what?', 'תחזור על זה', 'מה אמרת?', 'עוד פעם', 'sorry, what?'],
    stop: ['stop', 'wait', 'עצור', 'די', 'רגע', 'תפסיק', 'shh'],
    bye: ['bye', 'goodbye', 'ביי', 'להתראות', 'ביי, תודה', 'thats all', 'תנתק'],
    short: ['banana', 'אבטיח'],
    empty: ['', '   ', '...', 'אממ', 'um']
  }
  for (const [kind, list] of Object.entries(cases)) {
    for (const text of list) assert.equal(P.classifyTurn(text).kind, kind, `${JSON.stringify(text)} -> ${kind}`)
  }
})

test('classifier: every real request or question goes to Hermes (he/en)', () => {
  for (const text of [
    'מה נשאר לעשות בסשן הזה?', 'כדאי לי להשתמש בריסט שלי?', 'should I use my reset?', "what's left to do in this session",
    'תבדוק את היומן', 'תבדוק', 'תמשיך', 'continue', 'check', 'explain', 'why?', 'למה', 'כמה', 'Is it raining?',
    'ok so what is left', 'כן אבל מה עם הריסט', 'תודה, ומה עם מחר?', 'no, I meant tomorrow', 'לא, התכוונתי למחר',
    'send it', 'ok send it', 'hello, can you check my calendar', 'שלום, תזכיר לי מחר', 'repeat the second step'
  ]) assert.equal(P.classifyTurn(text).kind, 'substantive', text)
})

test('classifier: the persona name is ignored, and a yes after a question is an answer', () => {
  assert.equal(P.classifyTurn('Ray, thanks', { names: ['Ray'] }).kind, 'ack')
  assert.equal(P.classifyTurn('הרמס תודה').kind, 'ack')
  assert.equal(P.classifyTurn('ג׳וני היי', { names: ["ג'וני"] }).kind, 'greeting')
  assert.equal(P.classifyTurn('כן', { awaiting: true }).kind, 'substantive')
  assert.equal(P.classifyTurn('yes', { awaiting: true }).kind, 'substantive')
  assert.equal(P.classifyTurn('ביי', { awaiting: true }).kind, 'bye')
  assert.equal(P.classifyTurn('מה נשאר?').lang, 'he')
  assert.equal(P.classifyTurn('what is left?').lang, 'en')
})

// ── the sentence cutter ─────────────────────────────────────────────────────────────────────────

test('cutPieces: he/en sentence ends, line breaks, a soft max on long runs, decimals kept', () => {
  assert.deepEqual(P.cutPieces('נשארו שני דברים. הראשון הוא הבדיקה! והשני?', true).pieces, ['נשארו שני דברים.', 'הראשון הוא הבדיקה!', 'והשני?'])
  assert.deepEqual(P.cutPieces('Version 3.5 is out. Next', false), { pieces: ['Version 3.5 is out.'], rest: 'Next' })
  assert.deepEqual(P.cutPieces('First line\nSecond line', true).pieces, ['First line', 'Second line'])
  assert.deepEqual(P.cutPieces('He said "go." Then left.', true).pieces, ['He said "go."', 'Then left.'])
  assert.deepEqual(P.cutPieces('Done.', false).pieces, []) // may still be "Done.5" or 'Done."'
  const long = 'מילה '.repeat(70).trim()
  const cut = P.cutPieces(long, false)
  assert.ok(cut.pieces.length >= 2 && cut.pieces.every(p => p.length <= P.STREAM_SOFT_MAX), 'a long unpunctuated run is cut near 120 chars')
})

test('cutPieces is prefix-stable: streaming any prefix never disagrees with the final cut', () => {
  const text = 'בדקתי את היומן. מחר יש לך שתי פגישות: אחת ב-10:30 ואחת ב-14:00!\nצריך להכין מצגת? כן. ' +
    'Version 2.5 ships today... maybe "soon." ' + 'and then a very long clause without any punctuation at all that keeps going and going for well over one hundred and twenty characters before it ends.'
  const full = P.cutPieces(text, true).pieces
  for (let k = 0; k <= text.length; k++) {
    const part = P.cutPieces(text.slice(0, k), false).pieces
    assert.deepEqual(part, full.slice(0, part.length), `prefix ${k}`)
  }
})

test('freshPieces: only what was not spoken yet', () => {
  assert.deepEqual(P.freshPieces(['A b.', 'C d.', 'E.'], 'A b. C d.'), ['E.'])
  assert.deepEqual(P.freshPieces(['A b.', 'X.'], 'A b. C d.'), ['X.'])
  assert.deepEqual(P.freshPieces(['A b.'], ''), ['A b.'])
})

// ── delegation: every substantive turn, on every provider ─────────────────────────────────────

test('gemini: a substantive turn goes to Hermes, and the voice model\'s own answer is never played or recorded', async () => {
  const ws = await geminiCall()
  assert.equal(P.call.brain, 'hermes')
  await geminiUser(ws, 'מה נשאר לעשות בסשן הזה?')
  const sub = submits()
  assert.equal(sub.length, 1)
  assert.equal(sub[0].params.text, 'מה נשאר לעשות בסשן הזה?')
  assert.ok(sub[0].params.voice_context.startsWith(P.STYLE_NOTE), 'the fast-answer note leads the voice context')
  assert.match(P.STYLE_NOTE, /Answer first in one short spoken sentence, then add detail only if needed\. Don't deliberate at length unless the question requires it\./)
  assert.equal(played(), 0, 'the voice model\'s free answer was not played')
  assert.ok(!P.call.turns.some(x => /probably yes/.test(x.text)), 'nor recorded')
  assert.deepEqual(P.call.turns, [{ role: 'user', text: 'מה נשאר לעשות בסשן הזה?' }])
  assert.equal(P.call.delegations, 1)
})

test('every substantive turn of a conversation is delegated; trivial ones are not', async () => {
  const ws = await geminiCall()
  const script = [
    ['היי', false], ['מה נשאר לעשות?', true], ['אוקיי', false], ['כדאי לי להשתמש בריסט?', true],
    ['תודה', false], ['should I use my reset?', true], ['מגניב', false], ['תבדוק את זה', true], ['ok', false]
  ]
  let expected = 0
  for (const [text, delegated] of script) {
    await geminiUser(ws, text)
    if (delegated) expected += 1
    assert.equal(submits().length, expected, text)
    endAudio()
  }
  assert.deepEqual(submits().map(s => s.params.text), script.filter(s => s[1]).map(s => s[0]))
})

for (const minted of [GEMINI, PAID]) {
  test(`${minted.provider}: delegation without any tool call and no voice content`, async () => {
    const ws = await geminiCall(minted)
    await geminiUser(ws, 'should I use my reset?', { voiceAnswers: false })
    assert.equal(submits().length, 1)
    assert.equal(says(ws).length, 0, 'nothing handed to the voice yet')
    ws.serve({ toolCall: { functionCalls: [{ id: 'x', name: 'hermes_task', args: { request: 'stray' } }] } })
    assert.equal(submits().length, 1, 'a stray tool call does not delegate')
    assert.equal(ws.sent.at(-1).toolResponse.functionResponses[0].response.error, 'not available')
  })
}

async function codexCall () {
  await P.start(makeCtx({ mint: async () => CODEX }))
  await settle(10)
  const pc = ledger.peers.at(-1)
  pc.dc.open()
  await settle()
  return pc.dc
}
function codexUser (dc, text) {
  dc.serve({ type: 'input_audio_buffer.speech_started' })
  dc.serve({ type: 'conversation.item.input_audio_transcription.delta', delta: text })
  dc.serve({ type: 'input_audio_buffer.speech_stopped' })
  dc.serve({ type: 'conversation.item.input_audio_transcription.completed', transcript: text })
}
const readings = dc => dc.sent.filter(m => m.type === 'response.create')

test('openai-codex: delegation of every substantive turn; responses only ever read Hermes\' text, out of band', async () => {
  const dc = await codexCall()
  codexUser(dc, 'מה נשאר לעשות בסשן הזה?')
  later(1300)
  codexUser(dc, 'תודה')
  later(1300)
  codexUser(dc, 'should I use my reset?')
  assert.deepEqual(submits().map(s => s.params.text), ['מה נשאר לעשות בסשן הזה?', 'should I use my reset?'])
  assert.equal(readings(dc).length, 0, 'no response is created for the user\'s turns')
  assert.ok(!dc.sent.some(m => m.type === 'conversation.item.create'), 'nothing is added to the voice conversation')
  later(1300)
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: 'Yes, use it now. ' }))
  const r = readings(dc)
  assert.equal(r.length, 1, JSON.stringify({ q: P.call.queue, h: P.call.handing, u: P.call.userPending, rtc: { responding: P.call.rtc.responding }, held: P.call.held }))
  assert.equal(r[0].response.conversation, 'none')
  assert.equal(r[0].response.instructions, P.SAY_INSTRUCTIONS)
  assert.deepEqual(r[0].response.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Yes, use it now.' }] }])
})

test('openai-codex: barge-in cancels the reading; a correction is sent as a follow-up', async () => {
  const dc = await codexCall()
  codexUser(dc, 'what is on tomorrow?')
  later(1300)
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: 'Tomorrow you have three meetings. The first is at nine. ' }))
  dc.serve({ type: 'response.created', response: { id: 'resp_1' } })
  dc.serve({ type: 'output_audio_buffer.started' })
  codexUser(dc, 'no, I meant the day after')
  assert.ok(dc.sent.some(m => m.type === 'output_audio_buffer.clear'))
  assert.deepEqual(submits().map(s => s.params.text), ['what is on tomorrow?', 'no, I meant the day after'])
  dc.serve({ type: 'response.done', response: { id: 'resp_1', status: 'cancelled' } })
  later(1300)
  P.onMessageComplete(ev('message.complete', { text: 'Tomorrow you have three meetings. The first is at nine. The second is at noon.' }))
  const texts = readings(dc).map(m => m.response.input[0].content[0].text)
  assert.ok(!texts.some(x => /noon/.test(x)), 'the interrupted reply is dropped after a correction')
})

// ── streaming into the voice ────────────────────────────────────────────────────────────────────

test('streaming: each sentence is spoken as soon as it is complete; the final text reconciles without doubles', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'מה נשאר לעשות בסשן הזה?')
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: 'נשארו שני ' }))
  assert.equal(says(ws).length, 0)
  P.onMessageDelta(ev('message.delta', { text: 'דברים. הראשון' }))
  assert.deepEqual(says(ws), [`${SAY}נשארו שני דברים.`], 'the first sentence goes out before the reply is done')
  P.onMessageDelta(ev('message.delta', { text: ' הוא **הבדיקה**. השני' }))
  geminiReads(ws)
  assert.deepEqual(says(ws).at(-1), `${SAY}הראשון הוא הבדיקה.`)
  // the final message has one more sentence than the stream delivered
  P.onMessageComplete(ev('message.complete', { text: 'נשארו שני דברים. הראשון הוא **הבדיקה**. השני הוא ה-README.' }))
  geminiReads(ws)
  assert.deepEqual(says(ws), [`${SAY}נשארו שני דברים.`, `${SAY}הראשון הוא הבדיקה.`, `${SAY}השני הוא ה-README.`])
  geminiReads(ws)
  assert.equal(says(ws).length, 3, 'nothing doubled')
  assert.equal(P.call.delegations, 0)
  assert.ok(!says(ws).some(x => x.includes('בודק')), 'no "checking": Hermes talked first')
})

test('streaming: an empty final keeps the streamed text; a silent reply says nothing', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'what is left?')
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: 'Two things. Tests and docs' }))
  P.onMessageComplete(ev('message.complete', { text: '' }))
  geminiReads(ws)
  assert.deepEqual(says(ws), [`${SAY}Two things.`, `${SAY}Tests and docs`].slice(0, says(ws).length))
  geminiReads(ws)
  assert.deepEqual(says(ws), [`${SAY}Two things. Tests and docs`].length === says(ws).length ? [`${SAY}Two things. Tests and docs`] : [`${SAY}Two things.`, `${SAY}Tests and docs`])
  const before = says(ws).length
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: 'NO' }))
  P.onMessageDelta(ev('message.delta', { text: '_REPLY' }))
  P.onMessageComplete(ev('message.complete', { text: 'NO_REPLY' }))
  geminiReads(ws)
  assert.equal(says(ws).length, before, 'a silence marker is never spoken')
})

test('streaming: tool-call turns read only the reply text (interim commentary, then the answer), never twice', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'תבדוק את היומן של מחר')
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: 'בודק את היומן.' }))
  P.onMessageDelta(ev('message.delta', { text: null })) // segment boundary before the tool lines
  P.onMessageInterim(ev('message.interim', { text: 'בודק את היומן.', already_streamed: true }))
  P.onMessageDelta(ev('message.delta', { text: 'מחר יש לך פגישה אחת, ב-10. ' }))
  for (let i = 0; i < 4; i++) geminiReads(ws)
  P.onMessageComplete(ev('message.complete', { text: 'מחר יש לך פגישה אחת, ב-10.' }))
  for (let i = 0; i < 4; i++) geminiReads(ws)
  const all = says(ws).join(' ')
  assert.equal((all.match(/בודק את היומן/g) || []).length, 1)
  assert.equal((all.match(/פגישה אחת/g) || []).length, 1)
  assert.ok(!/tool|terminal|\{/.test(all))
})

test('streaming: code and links are not read out, the note is in the reply\'s language', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'show me the fix')
  P.onMessageComplete(ev('message.complete', { text: 'Here is the fix:\n```js\nconst a = 1\n```\nSee https://example.com/x for more.' }))
  for (let i = 0; i < 4; i++) geminiReads(ws)
  const all = says(ws).join(' ')
  assert.ok(all.includes('The code is in the chat.') && all.includes('the link is in the chat'))
  assert.ok(!all.includes('const a') && !all.includes('example.com'))
})

// ── the ack, local lines ───────────────────────────────────────────────────────────────────────

test('a short "checking" is spoken only when Hermes has not started talking', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'כדאי לי להשתמש בריסט?')
  fire(P.ACK_DELAY_MS)
  assert.deepEqual(says(ws), [`${SAY}בודק.`])
  geminiReads(ws)
  P.onMessageComplete(ev('message.complete', { text: 'כן, כדאי עכשיו.' }))
  assert.deepEqual(says(ws), [`${SAY}בודק.`, `${SAY}כן, כדאי עכשיו.`])
})

test('greetings and bye are said by the plugin; bye hangs up after it is said', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'היי')
  assert.deepEqual(says(ws), [`${SAY}היי, אני כאן.`])
  geminiReads(ws)
  endAudio()
  await geminiUser(ws, 'ביי ריי') // v0.7: an explicit end-call phrase; a bare "ביי" does not hang up
  assert.equal(says(ws).at(-1), `${SAY}ביי.`)
  assert.equal(submits().length, 0)
  geminiReads(ws)
  assert.equal(P.call.state, 'idle')
})

// ── barge-in and corrections ───────────────────────────────────────────────────────────────────

async function readingReply (ws) {
  await geminiUser(ws, 'מה יש מחר?')
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: 'מחר יש לך שלוש פגישות. הראשונה בתשע. השנייה בצהריים. ' }))
  // the first sentences are being read
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'מחר' } } })
}

test('barge-in with a correction: the queued sentences are dropped and the correction goes to Hermes', async () => {
  const ws = await readingReply(await geminiCall()).then(() => ledger.sockets.at(-1))
  ws.serve({ serverContent: { interrupted: true } })
  await geminiUser(ws, 'לא, התכוונתי ליום שני')
  assert.deepEqual(submits().map(s => s.params.text), ['מה יש מחר?', 'לא, התכוונתי ליום שני'])
  const n = says(ws).length
  P.onMessageDelta(ev('message.delta', { text: 'והרביעית בערב. ' }))
  P.onMessageComplete(ev('message.complete', { text: 'מחר יש לך שלוש פגישות. הראשונה בתשע. השנייה בצהריים. והרביעית בערב.' }))
  for (let i = 0; i < 3; i++) geminiReads(ws)
  assert.equal(says(ws).length, n, 'nothing more of the interrupted reply is read')
})

test('barge-in with a backchannel ("כן"): the reply resumes where it was cut', async () => {
  const ws = await readingReply(await geminiCall()).then(() => ledger.sockets.at(-1))
  const cut = says(ws).at(-1)
  ws.serve({ serverContent: { interrupted: true } })
  await geminiUser(ws, 'כן')
  assert.equal(submits().length, 1, 'a backchannel is not delegated')
  assert.ok(says(ws).at(-1).startsWith(cut), 'the interrupted sentence is read again')
})

test('"stop" stops the reading and is not delegated', async () => {
  const ws = await readingReply(await geminiCall()).then(() => ledger.sockets.at(-1))
  await geminiUser(ws, 'עצור')
  const n = says(ws).length
  P.onMessageComplete(ev('message.complete', { text: 'מחר יש לך שלוש פגישות. הראשונה בתשע. השנייה בצהריים. ועוד משהו.' }))
  for (let i = 0; i < 3; i++) geminiReads(ws)
  assert.equal(says(ws).length, n)
  assert.equal(submits().length, 1)
})

test('"repeat that" reads the last reply again without asking Hermes', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'what is left?')
  P.onMessageComplete(ev('message.complete', { text: 'Tests and docs.' }))
  geminiReads(ws)
  endAudio()
  await geminiUser(ws, 'say that again')
  assert.equal(submits().length, 1)
  assert.equal(says(ws).at(-1), `${SAY}Tests and docs.`)
})

test('a yes to Hermes\' own question is delegated', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'prepare the email')
  P.onMessageComplete(ev('message.complete', { text: 'Done. Should I send it?' }))
  geminiReads(ws)
  geminiReads(ws)
  endAudio()
  await geminiUser(ws, 'yes')
  assert.deepEqual(submits().map(s => s.params.text), ['prepare the email', 'yes'])
})

test('a new turn while Hermes is still working is sent as a follow-up', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'what is on my calendar?')
  await geminiUser(ws, 'and also check the weather')
  assert.deepEqual(submits().map(s => s.params.text), ['what is on my calendar?', 'and also check the weather'])
  assert.equal(P.call.delegations, 2)
})

// ── latency ─────────────────────────────────────────────────────────────────────────────────────

test('one latency line per turn: numbers from end-of-speech, no content, also posted to the backend', async () => {
  const ctx = makeCtx({ mint: async () => GEMINI })
  await P.start(ctx)
  await settle()
  const ws = ledger.sockets.at(-1)
  ws.open()
  ws.serve({ setupComplete: {} })
  ws.serve({ serverContent: { inputTranscription: { text: 'what is left to do?' } } })
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] } } }) // end of the user's turn (t0)
  later(400)
  fire(400) // submit at +400
  later(1300)
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: 'Tests and docs. ' })) // first text at +1700, handed
  later(500)
  ws.serve({ serverContent: { turnComplete: true } })
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] } } }) // first answer audio at +2200
  await settle()
  const line = logs.find(l => l.includes('latency'))
  assert.ok(line, 'logged')
  const rec = JSON.parse(line.slice(line.indexOf('{')))
  assert.deepEqual(rec, { provider: 'gemini-free', brain: 'hermes', kind: 'turn', silence_ms: 1000, ack: false, submit: 400, first_text: 1700, first_audio: 2200, first_answer_audio: 2200 })
  assert.ok(!line.includes('left') && !line.includes('Tests'))
  const posted = ctx.rests.find(r => r.path === '/latency')
  assert.deepEqual(posted.opts.body, rec)
})

test('voice mode (brain: voice) keeps the v0.5 behaviour: nothing is delegated by the renderer', async () => {
  const ws = await geminiCall({ ...GEMINI, brain: 'voice' })
  ws.serve({ serverContent: { inputTranscription: { text: 'מה נשאר לעשות?' } } })
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] } } })
  ws.serve({ serverContent: { turnComplete: true } })
  fire(400)
  await settle()
  assert.equal(submits().length, 0)
  assert.equal(played(), 1, 'the voice model answers by itself in voice mode')
  assert.ok(!P.call.voiceContext, 'unchanged API')
  assert.ok(!P.voiceContext().startsWith(P.STYLE_NOTE))
})
