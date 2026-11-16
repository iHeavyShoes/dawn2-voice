// node --test 'tests/js/*.test.mjs' — t_9541ec0c
//   V23: a voice utterance steered into the running Hermes turn must never owe an answer of its own
//        ("Hermes finished without a text answer." spoken although Mike answered), in either
//        completion order. A genuinely empty or failed delegated turn still reports.
//   V5 : interim assistant narration that precedes a tool call is not read; only the answer is.
//   V4 : an utterance that stops on a dangling particle ("... את") is held longer for its continuation.
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
  t = Date.UTC(2026, 10, 15, 12, 0, 0)
  timers = new Map()
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
  P.call.settings = { transcript_to_chat: 'chat_turn', half_duplex: false, language: 'he', persona_name: 'Ray', persona_name_he: 'ריי', persona_gender: 'male', silence_ms: 1500 }
  P.call.detail = ''
})

const later = ms => { t += ms }
function fire (ms) { for (const [id, tm] of [...timers]) if (tm.ms === ms) { timers.delete(id); tm.fn() } }
const GEMINI = { provider: 'gemini-free', provider_label: 'Gemini (free key)', transport: 'gemini-live', model: 'gemini-3.8-live', brain: 'hermes', url: 'wss://example.invalid/ws?access_token=auth_tokens/x', setup: { setup: { model: 'models/gemini-3.8-live' } } }
const AUDIO = { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAAAA==' } }
const ev = (type, payload, extra = {}) => ({ type, session_id: 'sess-1', payload, ...extra })
const says = ws => ws.sent.filter(m => m.realtimeInput && typeof m.realtimeInput.text === 'string').map(m => m.realtimeInput.text)
const FALLBACK = 'Hermes finished without a text answer.'
const submits = () => sdk.requests.filter(r => r.method === 'prompt.submit' && r.params.surface === 'voice-live')

async function geminiCall () {
  await P.start(makeCtx({ mint: async () => GEMINI }))
  await settle()
  const ws = ledger.sockets.at(-1)
  ws.open(); ws.serve({ setupComplete: {} })
  await settle()
  return ws
}
async function geminiUser (ws, text) {
  ws.serve({ serverContent: { inputTranscription: { text } } })
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'I think the answer is probably yes' } } })
  ws.serve({ serverContent: { turnComplete: true } })
  fire(400)
  later(1300)
  await settle()
}
function geminiReads (ws) {
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'read' } } })
  ws.serve({ serverContent: { turnComplete: true } })
}
// Let the voice read everything handed over so far; returns the spoken texts (marker stripped).
function spoken (ws) {
  for (let i = 0; i < 8; i++) { later(1300); geminiReads(ws) }
  return says(ws).map(x => x.replace('[Say aloud] ', ''))
}
const turnComplete = (text, extra = {}) => ev('message.complete', { text, status: 'complete', usage: {}, ...extra })
// What the owner publishes when a steered admission settles (gateway/session_authority._settle_cancelled).
const settlement = (admission, extra = {}, top = true) => ev('message.complete',
  { text: '', content: '', admission_id: admission, outcome: 'steered', ...extra }, top ? { admission_id: admission } : {})
const row = (id, extra = {}) => ({ admission_id: id, status: 'queued', controls: ['steer', 'replace'], ...extra })
const info = (pending, running = true) => P.onSessionInfo({ session_id: 'sess-1', payload: { running, pending_submissions: pending } })

// A long Hermes turn is running (delegation 1); Jojo speaks again and the utterance is queued as a.2.
async function steeredSetup () {
  const ws = await geminiCall()
  await geminiUser(ws, 'תריץ בדיקה ארוכה על היומן')
  P.onMessageStart(ev('message.start', {}))
  info([])
  let n = 0
  sdk.requestImpl = async method => method === 'prompt.submit' ? { admission_id: 'a' + (++n), status: 'queued' } : { status: 'started', outcome: 'steering' }
  await geminiUser(ws, 'ואל תשכח לבדוק גם את המייל')
  info([row('a1')])
  assert.equal(P.call.delegations, 2)
  assert.equal(await P.steerQueuedVoice(), true)
  // Speaking over the running reply drops its stream (stopSpeaking); after the steer the owner continues the
  // turn as a fresh message.start, and that stream carries the answer.
  P.onMessageStart(ev('message.start', {}))
  return ws
}

for (const [label, top] of [['frame carries admission_id', true], ['admission_id only inside the payload', false]]) {
  test(`V23 case B (${label}): answer first, then the steered row's empty settlement says nothing`, async () => {
    const ws = await steeredSetup()
    P.onMessageComplete(turnComplete('בדקתי. הכל תקין.'))
    P.onMessageComplete(settlement('a1', {}, top))
    const out = spoken(ws)
    assert.ok(out.includes('בדקתי.'), JSON.stringify(out))
    assert.ok(!out.includes(FALLBACK), 'no phantom fallback after the real answer')
    assert.equal(P.call.delegations, 0)
  })
  test(`V23 case A (${label}): the steered row's empty settlement first, then the answer: no phantom`, async () => {
    const ws = await steeredSetup()
    P.onMessageComplete(settlement('a1', {}, top))
    const early = spoken(ws)
    assert.ok(!early.includes(FALLBACK), 'settlement frame must not be read as an empty delegated turn')
    P.onMessageComplete(turnComplete('בדקתי. הכל תקין.'))
    const out = spoken(ws)
    assert.ok(out.includes('בדקתי.'))
    assert.ok(!out.includes(FALLBACK))
    assert.equal(P.call.delegations, 0)
  })
}

test('V23: a settlement frame with no ids at all (no status/usage) right after a steer is still not an owed turn', async () => {
  const ws = await steeredSetup()
  P.onMessageComplete(ev('message.complete', { text: '' }))
  P.onMessageComplete(turnComplete('הנה התשובה.'))
  assert.ok(!spoken(ws).includes(FALLBACK))
})

test('V23: a steered utterance that was interrupted settles as cancelled and is silent too', async () => {
  const ws = await steeredSetup()
  P.onMessageComplete(turnComplete('הנה התשובה.'))
  P.onMessageComplete(settlement('a1', { outcome: 'cancelled' }))
  assert.ok(!spoken(ws).includes(FALLBACK))
})

test('V23: prompt.submit answering "steered" (core busy_input_mode=steer) owes no answer of its own', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'תריץ בדיקה ארוכה על היומן')
  P.onMessageStart(ev('message.start', {}))
  sdk.requestImpl = async () => ({ status: 'steered' })
  await geminiUser(ws, 'ואל תשכח לבדוק גם את המייל')
  assert.equal(submits().length, 2)
  assert.equal(P.call.delegations, 1, 'only the running turn is owed')
  P.onMessageComplete(turnComplete('בדקתי הכל.'))
  assert.equal(P.call.delegations, 0)
  P.onMessageComplete(ev('message.complete', { text: '', status: 'complete', usage: {} })) // a stray empty completion
  assert.ok(!spoken(ws).includes(FALLBACK))
})

test('V23: the Desktop queue card Steer (session.info row steering:true) also stops owing; a revert owes again', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'תריץ בדיקה ארוכה על היומן')
  P.onMessageStart(ev('message.start', {}))
  info([])
  sdk.requestImpl = async () => ({ admission_id: 'a9', status: 'queued' })
  await geminiUser(ws, 'ואל תשכח לבדוק גם את המייל')
  assert.equal(P.call.delegations, 2)
  info([row('a9', { status: 'started', steering: true, controls: [] })])
  assert.equal(P.call.delegations, 1)
  info([row('a9', { status: 'started', steering: true, controls: [] })])
  assert.equal(P.call.delegations, 1, 'idempotent')
  info([row('a9')]) // the transfer went back to its queue place
  assert.equal(P.call.delegations, 2)
})

test('V23 preserved: a genuinely empty delegated turn still says the fallback; an errored one says the error', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'תבדוק את היומן')
  P.onMessageComplete(turnComplete(''))
  assert.ok(spoken(ws).includes(FALLBACK))
  await geminiUser(ws, 'ועכשיו את המייל')
  P.onMessageComplete(ev('message.complete', { text: '', status: 'error', error: 'rate limited', usage: {} }))
  assert.ok(spoken(ws).some(x => x.includes('Hermes stopped with an error: rate limited')))
})

test('V23 preserved: a steered turn whose running turn really ends empty still reports once (no steer settlement seen)', async () => {
  const ws = await steeredSetup()
  P.onMessageComplete(settlement('a1'))
  P.onMessageComplete(turnComplete(''))
  const out = spoken(ws)
  assert.equal(out.filter(x => x === FALLBACK).length, 1)
})

// ── V5 ──────────────────────────────────────────────────────────────────────────────────────────
const NARRATION = 'Run a 60-second foreground sleep so the turn stays busy and steer can be tested.'
const GUARD = () => P.INTERIM_GUARD_MS ?? 1000

test('V5: narration streamed before a tool call is never read; the final answer is', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'תריץ בדיקה')
  P.onMessageStart(ev('message.start', { turn_id: 'T1' }))
  P.onMessageDelta(ev('message.delta', { text: NARRATION + ' ', turn_id: 'T1', segment: 0, offset: 0 }))
  later(200)
  P.onMessageDelta(ev('message.delta', { text: null, turn_id: 'T1' })) // boundary before the tool lines
  P.onMessageInterim(ev('message.interim', { text: NARRATION, already_streamed: true, turn_id: 'T1', segment: 0 }))
  later(GUARD() + 500); fire(GUARD())
  P.onMessageDelta(ev('message.delta', { text: 'הבדיקה הסתיימה. ', turn_id: 'T1', segment: 1, offset: 0 }))
  later(GUARD() + 100); fire(GUARD())
  P.onMessageComplete(turnComplete('הבדיקה הסתיימה.'))
  const out = spoken(ws)
  assert.ok(!out.some(x => x.includes('foreground sleep')), JSON.stringify(out))
  assert.equal(out.filter(x => x === 'הבדיקה הסתיימה.').length, 1)
})

test('V5: a tool event that arrives before any segment boundary also discards the held narration', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'תריץ בדיקה')
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: NARRATION + ' ' }))
  later(300)
  P.onToolActivity?.(ev('tool.generating', { name: 'terminal' }))
  later(GUARD() + 500); fire(GUARD())
  P.onMessageComplete(turnComplete('סיימתי.'))
  const out = spoken(ws)
  assert.ok(!out.some(x => x.includes('foreground sleep')))
  assert.ok(out.includes('סיימתי.'))
})

test('V5: an unsealed (not streamed) interim is not read either', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'תריץ בדיקה')
  P.onMessageStart(ev('message.start', {}))
  P.onMessageInterim(ev('message.interim', { text: NARRATION, already_streamed: false }))
  P.onMessageComplete(turnComplete('סיימתי.'))
  const out = spoken(ws)
  assert.ok(!out.some(x => x.includes('foreground sleep')))
  assert.ok(out.includes('סיימתי.'))
})

test('V5 does not break streaming: a plain answer is read sentence by sentence once the guard passes, never twice', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'מה נשאר?')
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: 'נשארו שני דברים. הראשון' }))
  assert.equal(says(ws).length, 0, 'held for the guard window, not spoken yet')
  later(GUARD() + 10); fire(GUARD())
  geminiReads(ws)
  assert.deepEqual(says(ws).map(x => x.replace('[Say aloud] ', '')).slice(0, 1), ['נשארו שני דברים.'])
  P.onMessageComplete(turnComplete('נשארו שני דברים. הראשון הוא הבדיקה.'))
  const out = spoken(ws)
  assert.equal(out.filter(x => x === 'נשארו שני דברים.').length, 1)
  assert.ok(out.includes('הראשון הוא הבדיקה.'))
})

test('V5: complete releases anything still held at once (a short final answer is not delayed by the guard)', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'מה השעה?')
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: 'השעה שתיים. ' }))
  P.onMessageComplete(turnComplete('השעה שתיים.'))
  assert.ok(spoken(ws).includes('השעה שתיים.'))
})

test('V5: when the sealed interim IS the answer (empty or reused final), it is read once, not lost', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'מה השעה?')
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: 'השעה שתיים. ' }))
  P.onMessageInterim(ev('message.interim', { text: 'השעה שתיים.', already_streamed: true }))
  P.onMessageComplete(turnComplete('השעה שתיים.', { response_reused: true }))
  const out = spoken(ws)
  assert.equal(out.filter(x => x === 'השעה שתיים.').length, 1, JSON.stringify(out))
})

// ── V4 ──────────────────────────────────────────────────────────────────────────────────────────
test('V4: an utterance ending on a dangling particle waits for its continuation instead of being delegated', async () => {
  const ws = await geminiCall()
  ws.serve({ serverContent: { inputTranscription: { text: 'כן, צריך לבדוק את הנושא הזה. אני שמעתי הפעם את' } } })
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'probably' } } })
  ws.serve({ serverContent: { turnComplete: true } })
  fire(400)
  await settle()
  assert.equal(submits().length, 0, 'not delegated at the first end-of-turn')
  assert.ok(P.call.fragment, 'held as a fragment')
  fire(400) // the old 400 ms fragment timer must not cut it
  assert.equal(submits().length, 0)
  // the user finds the word: the continuation is merged into ONE request
  later(2000)
  ws.serve({ serverContent: { inputTranscription: { text: 'אור אמר לי אתמול' } } })
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'probably' } } })
  ws.serve({ serverContent: { turnComplete: true } })
  fire(400)
  await settle()
  assert.equal(submits().length, 1)
  assert.match(submits()[0].params.text, /שמעתי הפעם את אור אמר לי אתמול/)
})

test('V4: a dangling fragment that is never continued is still delegated after the longer wait', async () => {
  const ws = await geminiCall()
  ws.serve({ serverContent: { inputTranscription: { text: 'כן, צריך לבדוק את הנושא הזה. אני שמעתי הפעם את' } } })
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'probably' } } })
  ws.serve({ serverContent: { turnComplete: true } })
  fire(400); await settle()
  assert.equal(submits().length, 0)
  fire(P.FRAGMENT_DANGLING_MS ?? 2000); await settle()
  assert.equal(submits().length, 1)
})
