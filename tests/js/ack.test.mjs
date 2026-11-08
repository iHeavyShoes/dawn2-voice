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

// ── the bank and the guard ─────────────────────────────────────────────────────────────────────

test('ack bank: at least 25 natural phrases per language; the bare "בודק" is not the default', () => {
  for (const lang of ['he', 'en']) {
    const bank = P.ACK_BANK[lang]
    assert.ok(bank.length >= 25, `${lang}: ${bank.length}`)
    const texts = bank.map(e => (typeof e === 'string' ? e : e.t))
    assert.equal(new Set(texts).size, texts.length, `${lang}: no duplicates`)
    for (const x of texts) assert.ok(x.split(/\s+/).length <= P.ACK_MAX_WORDS, x)
    assert.ok(!/\d/.test(texts.join(' ')), `${lang}: no digits in the bank`)
  }
  assert.ok(!P.ACK_BANK.he.includes('בודק.') && !P.ACK_BANK.he.includes('בודק'))
})

test('ack guard: too long, digits, times and names not in the transcript are refused', () => {
  const turn = 'תבדוק מה יש לי ביומן'
  assert.equal(P.verifyAck('רגע, בוא נראה.', turn), true)
  assert.equal(P.verifyAck('אה, ביומן, שנייה.', turn), true, 'an echo of the user\'s own word')
  assert.equal(P.verifyAck('יש לך פגישה ב-10.', turn), false, 'a fact/time')
  assert.equal(P.verifyAck('רגע, 10:30.', turn), false, 'digits')
  assert.equal(P.verifyAck('שנייה, דני.', turn), false, 'a name the user did not say')
  assert.equal(P.verifyAck('כן, יש לך פגישה מחר.', turn), false, 'an answer')
  assert.equal(P.verifyAck('רגע רגע רגע רגע רגע רגע רגע רגע רגע', turn), false, 'over 8 words')
  assert.equal(P.verifyAck('', turn), false)
  assert.equal(P.verifyAck('One sec, the meeting is at noon.', 'what time is the meeting'), false)
})

test('ack topic: 1-3 words copied from the user turn, never a question/request word', () => {
  assert.equal(P.ackTopic('תבדוק מה יש לי ביומן מחר', NAMES), 'ביומן מחר')
  assert.equal(P.ackTopic('ריי, איך הולך הגיבוי', NAMES), 'הולך הגיבוי')
  assert.equal(P.ackTopic('check what is on my calendar', NAMES), 'calendar')
  assert.equal(P.ackTopic('מה?', NAMES), '')
  assert.equal(P.ackTopic('what is 7 plus 5', NAMES), 'plus')
})

// ── the picker over many turns ─────────────────────────────────────────────────────────────────

for (const lang of ['he', 'en']) {
  test(`ack picker (${lang}): no new facts, <= 8 words, varied, echo ~1/3 never twice in a row, some silence`, () => {
    const rand = seeded(lang === 'he' ? 7 : 11)
    const acks = []
    let echoes = 0
    let silent = 0
    let prevEcho = false
    for (let i = 0; i < 600; i++) {
      const turn = TURNS[lang][i % TURNS[lang].length]
      const a = P.pickAck(turn, { lang, names: NAMES, rand })
      if (!a) { silent += 1; continue }
      assert.ok(P.verifyAck(a, turn), `guard: ${a}`)
      assert.ok(a.split(/\s+/).length <= P.ACK_MAX_WORDS, a)
      assert.ok(!/\d/.test(a), a)
      if (lang === 'he') assert.ok(/[\u05D0-\u05EA]/.test(a), `Hebrew: ${a}`)
      else assert.ok(!/[\u05D0-\u05EA]/.test(a), `English: ${a}`)
      assert.ok(!acks.slice(-P.ACK_RECENT).includes(a), `not within the last 5: ${a}`)
      const topic = P.ackTopic(turn, NAMES)
      const isEcho = !!topic && a.includes(topic) && P.ACK_ECHO[lang].some(tpl => a === tpl.replace('{topic}', topic))
      if (isEcho) { echoes += 1; assert.ok(!prevEcho, 'two echoes in a row') }
      prevEcho = isEcho
      acks.push(a)
    }
    const spoken = acks.length
    assert.ok(echoes / spoken > 0.15 && echoes / spoken < 0.4, `echo share ${echoes}/${spoken}`)
    assert.ok(new Set(acks).size >= 20, `variety: ${new Set(acks).size}`)
    assert.ok(spoken > 300, 'most turns get an ack')
    for (let i = 1; i < acks.length; i++) assert.notEqual(acks[i], acks[i - 1])
    const checking = acks.filter(a => /^(בודק\.|Checking\.)$|בודק לך/.test(a)).length
    assert.ok(checking / spoken < 0.05, `"בודק" is rare: ${checking}/${spoken}`)
    assert.ok(silent >= 0)
  })
}

test('ack picker: silence only for a short turn that asks for no work', () => {
  const always = () => 0 // every draw "succeeds"
  assert.equal(P.pickAck('מה השעה?', { lang: 'he', names: NAMES, rand: always }), '', 'short question: silence')
  P.resetAckMemory()
  const a = P.pickAck('תבדוק לי מה יש ביומן של מחר', { lang: 'he', names: NAMES, rand: always })
  assert.ok(a, 'a request always gets an ack')
})

test('ack picker: "good question" only after a question; female persona is grammatical', () => {
  const rand = seeded(3)
  for (let i = 0; i < 300; i++) {
    const a = P.pickAck('תמצא לי את הקובץ של החוזה', { lang: 'he', names: NAMES, rand })
    assert.ok(!/שאלה טובה/.test(a), a)
  }
  P.resetAckMemory()
  const female = []
  for (let i = 0; i < 300; i++) female.push(P.pickAck('תמצא לי את הקובץ של החוזה עכשיו', { lang: 'he', female: true, names: NAMES, rand }))
  assert.ok(!female.some(a => /מסתכל\b|מסתכל\.|בודק\b/.test(a)), 'no masculine forms')
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
