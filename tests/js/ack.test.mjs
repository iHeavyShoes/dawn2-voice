// node --test 'tests/js/*.test.mjs' — v0.8: the natural acknowledgement (phrase bank, he/en) and the
// speaker-label strip ("ריי: ..." is never read aloud).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'

const sdk = makeSdk()
const P = await loadPlugin(sdk)
let env, ledger, t, timers

beforeEach(async () => {
  P.tearDown()
  await settle()
  P.resetCooldown()
  P.resetAckMemory()
  ;({ env, ledger } = makeEnv())
  t = Date.UTC(2026, 10, 8, 12, 0, 0)
  timers = new Map()
  let next = 1
  P.setEnv({
    ...env,
    now: () => t,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id },
    clearTimeout: id => { timers.delete(id) },
    log: () => {},
    random: () => 0.99
  })
  sdk.requests.length = 0
  sdk.requestImpl = async () => ({ status: 'streaming' })
  sdk.host.state.activeSessionId.value = 'sess-1'
  sdk.host.state.focusedSessionId.value = 'sess-1'
  P.call.settings = { transcript_to_chat: 'chat_turn', half_duplex: false, language: 'he', persona_name: 'Ray', persona_name_he: 'ריי', persona_gender: 'male', silence_ms: 1000 }
})

const NAMES = ['Ray', 'ריי', 'hermes', 'הרמס']
const SAY = '[Say aloud] '
const later = ms => { t += ms }
function fire (ms) { for (const [id, tm] of [...timers]) if (tm.ms === ms) { timers.delete(id); tm.fn() } }
const says = ws => ws.sent.filter(m => m.realtimeInput && typeof m.realtimeInput.text === 'string').map(m => m.realtimeInput.text)
const ev = (type, payload) => ({ type, session_id: 'sess-1', payload })
const GEMINI = { provider: 'gemini-free', provider_label: 'Gemini (free key)', transport: 'gemini-live', model: 'gemini-3.8-live', brain: 'hermes', url: 'wss://example.invalid/ws?access_token=auth_tokens/x', setup: { setup: { model: 'models/gemini-3.8-live' } } }
const AUDIO = { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAAAA==' } }

// A seeded PRNG so the statistical tests are reproducible.
function seeded (seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }

const TURNS = {
  he: ['תבדוק מה יש לי ביומן מחר בבוקר', 'מה המצב של הפרויקט של דני?', 'איך הולך הגיבוי של השרת', 'תמצא לי את הקובץ של החוזה',
    'כמה עולה הטיסה לברלין ביום שלישי?', 'תסביר לי את הבאג בפלאגין', 'מתי הפגישה עם יעל', 'תכתוב טיוטה למייל לאורי'],
  en: ['check what is on my calendar tomorrow', 'how is the backup doing', 'what time is the meeting with Dana?',
    'find the contract file for me', 'explain the bug in the plugin please', 'can you summarize the last call']
}

// ── model guard and phrase-bank fallback ──────────────────────────────────────────────────────
test('model ack guard: six words maximum, no echo, digits, facts, names or promises (he/en)', () => {
  for (const [ack, turn] of [
    ['אה, הבנתי, רגע.', 'תבדוק מה יש ביומן מחר'],
    ['Good question, let me see.', 'why does the build fail today']
  ]) assert.equal(P.verifyAck(ack, turn), true, ack)
  for (const [ack, turn] of [
    ['רגע רגע רגע רגע רגע רגע רגע', 'תבדוק בבקשה את זה'],
    ['רגע, 10:30.', 'הפגישה ב10:30'],
    ['שנייה, דני.', 'תבדוק ביומן בבקשה'],
    ['יש לך פגישה מחר.', 'יש לך פגישה מחר'],
    ['מגניב ומבחינת השינוי רגע', 'מגניב ומבחינת השינוי של האורך'],
    ['I will finish tomorrow.', 'check the build status'],
    ['The answer is five.', 'what is the answer'],
    ['one short natural reaction', 'one short natural reaction please']
  ]) assert.equal(P.verifyAck(ack, turn), false, ack)
})
test('fallback bank: no topic echo, variety, recent exclusion, ~25% silence even on requests', () => {
  const rand = seeded(7)
  const spoken = []
  let silent = 0
  for (let i = 0; i < 1000; i++) {
    const ack = P.pickAck(TURNS.he[i % TURNS.he.length], { lang: 'he', rand })
    if (!ack) { silent++; continue }
    assert.ok(!spoken.slice(-5).includes(ack))
    assert.ok(P.verifyAck(ack, TURNS.he[i % TURNS.he.length]))
    assert.ok(!ack.includes('ביומן') && !ack.includes('הגיבוי'))
    spoken.push(ack)
  }
  assert.ok(silent > 200 && silent < 300, String(silent))
  assert.ok(new Set(spoken).size > 20)
})
test('unfinished turns have no acknowledgement (he/en)', () => {
  for (const text of ['חשבתי על זה אבל', 'I was thinking and', 'מבחינת השינוי', 'a thing'])
    assert.equal(P.pickAck(text, { rand: () => .99 }), '')
})

// ── in a call: the 900 ms rule ─────────────────────────────────────────────────────────────────

async function geminiCall () {
  await P.start(makeCtx({ mint: async () => GEMINI }))
  await settle()
  const ws = ledger.sockets.at(-1)
  ws.open()
  ws.serve({ setupComplete: {} })
  await settle()
  return ws
}
async function geminiUser (ws, text) {
  ws.serve({ serverContent: { inputTranscription: { text } } })
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'I think so' } } })
  ws.serve({ serverContent: { turnComplete: true } })
  fire(400)
  later(1300)
  await settle()
}

test('ack in a call: skipped entirely when Hermes speaks first (900 ms rule)', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'תבדוק מה יש לי ביומן מחר')
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: 'מחר יש לך פגישה אחת. ' }))
  fire(P.ACK_DELAY_MS)
  assert.deepEqual(says(ws), [`${SAY}מחר יש לך פגישה אחת.`])
})

test('ack in a call: a bank phrase after 900 ms, never containing the answer', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'תבדוק מה יש לי ביומן מחר')
  fire(P.ACK_DELAY_MS)
  const s = says(ws)
  assert.equal(s.length, 1)
  assert.ok(P.verifyAck(s[0].slice(SAY.length), 'תבדוק מה יש לי ביומן מחר'))
})

// ── the speaker label ──────────────────────────────────────────────────────────────────────────

test('speaker label: "ריי:" / "Ray:" / "**ריי:**" at a line start are stripped; other colons stay', () => {
  assert.equal(P.stripSpeakerLabels('ריי: כן, זה אפשרי.', NAMES), 'כן, זה אפשרי.')
  assert.equal(P.stripSpeakerLabels('רי: כן.', NAMES), 'כן.')
  assert.equal(P.stripSpeakerLabels('**Ray:** Sure, it works.', NAMES), 'Sure, it works.')
  assert.equal(P.stripSpeakerLabels('Hermes: done.\nRay: and one more.', NAMES), 'done.\nand one more.')
  assert.equal(P.stripSpeakerLabels('השעה: 10. ריי: לא בתחילת שורה.', NAMES), 'השעה: 10. ריי: לא בתחילת שורה.')
  assert.equal(P.stripSpeakerLabels('Rayy: hi', NAMES), 'Rayy: hi', 'only whole names')
  assert.equal(P.sayText('ריי: כן, זה **אפשרי**.', NAMES), 'כן, זה אפשרי.')
  assert.equal(P.isLabelOnly('ריי', NAMES), true)
  assert.equal(P.isLabelOnly('Ray.', NAMES), true)
  assert.equal(P.isLabelOnly('ריי צודק', NAMES), false)
})

test('speaker label: the voice never reads "ריי:" or a bare "ריי" (streamed and whole replies)', async () => {
  const ws = await geminiCall()
  await geminiUser(ws, 'אפשר לעשות את זה היום?')
  P.onMessageStart(ev('message.start', {}))
  P.onMessageDelta(ev('message.delta', { text: 'ריי: כן, זה ' }))
  P.onMessageDelta(ev('message.delta', { text: 'אפשרי. ' }))
  P.onMessageComplete(ev('message.complete', { text: 'ריי: כן, זה אפשרי.' }))
  const all = says(ws)
  assert.deepEqual(all, [`${SAY}כן, זה אפשרי.`])
  // A reply that is only the label line, then the text on the next line (the "call opened with ריי" case).
  P.onMessageStart(ev('message.start', {}))
  P.onMessageComplete(ev('message.complete', { text: 'ריי\nהיי, מה נשמע?' }))
  for (let i = 0; i < 3; i++) { ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'r' } } }); ws.serve({ serverContent: { turnComplete: true } }) }
  const after = says(ws).slice(1).map(x => x.slice(SAY.length))
  assert.ok(!after.some(x => /^ריי[.:]?$/.test(x.trim())), JSON.stringify(after))
  assert.ok(after.join(' ').includes('היי, מה נשמע?'))
})

test('speaker label: brain: voice results are stripped too', () => {
  P.call.brain = 'voice'
  assert.ok(!P.resultMessages(P.stripSpeakerLabels('Ray: the build passed.', NAMES))[0].includes('Ray:'))
  P.call.brain = null
})
