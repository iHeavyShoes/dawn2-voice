// node --test tests/js — v0.3 result hand-off: long replies are spoken in full (in parts), silent
// replies are never spoken, the receipt forbids the voice's own content, barge-in drops the rest.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'

const sdk = makeSdk()
const P = await loadPlugin(sdk)
let env, ledger, t

beforeEach(() => {
  P.tearDown()
  ;({ env, ledger } = makeEnv())
  t = Date.UTC(2026, 10, 7, 12, 0, 0)
  P.setEnv({ ...env, now: () => t })
  sdk.requests.length = 0
  sdk.requestImpl = async () => ({ status: 'streaming' })
  sdk.host.state.activeSessionId.value = 'sess-1'
  sdk.host.state.focusedSessionId.value = 'sess-1'
  P.call.settings = { transcript_to_chat: 'off', half_duplex: false }
})

async function liveCall () {
  await P.start(makeCtx())
  await settle()
  const ws = ledger.sockets.at(-1)
  ws.open()
  ws.serve({ setupComplete: {} })
  await settle()
  return ws
}
const handed = ws => ws.sent.filter(m => m.realtimeInput && m.realtimeInput.text).map(m => m.realtimeInput.text)
const reply = text => P.onMessageComplete({ type: 'message.complete', session_id: 'sess-1', payload: { text } })
const audio = ws => ws.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } })
const done = ws => ws.serve({ serverContent: { turnComplete: true } })

// The "how does a clock work" answer from the 2026-11-07 call: 4 paragraphs of markdown, ~3.6k chars.
const para = (n, k) => `**Part ${n}.** ` + Array.from({ length: k }, (_, i) => `Sentence ${n}.${i} explains the gear train and the escapement in some detail.`).join(' ')
const CLOCK = ['# How a clock works', para(1, 14), para(2, 14), '- ' + para(3, 14), para(4, 14) + ' See https://example.com/clocks for more.'].join('\n\n')

test('a long reply is handed over in FULL, one part per model turn, never cut to its tail', async () => {
  const ws = await liveCall()
  ws.serve({ toolCall: { functionCalls: [{ id: 'c1', name: 'hermes_task', args: { request: 'how does a clock work' } }] } })
  await settle()
  assert.ok(CLOCK.length > 3000, 'longer than the old 3000-char cap')
  reply(CLOCK)
  const n = P.resultMessages(CLOCK).length
  assert.ok(n >= 3 && n <= P.MAX_PARTS, `${n} parts`)
  assert.equal(handed(ws).length, 1, 'only the first part goes out before the voice answers')
  for (let i = 1; i < n; i++) { audio(ws); done(ws) }
  const all = handed(ws)
  assert.equal(all.length, n)
  all.forEach((m, i) => assert.ok(m.startsWith(`[Hermes result ${i + 1}/${n}] `), m.slice(0, 30)))
  const spoken = all.join(' ')
  for (let p = 1; p <= 4; p++) for (const i of [0, 7, 13]) assert.ok(spoken.includes(`Sentence ${p}.${i} explains`), `${p}.${i} missing`)
  assert.ok(all.every(m => m.length <= P.PART_CHARS + 30), 'every part fits')
  assert.ok(!/[*#]|https?:/.test(spoken), 'markdown and URLs are not read out')
  assert.match(spoken, /link in the chat/)
})

test('a part that gets no turnComplete does not hold the next part forever', async () => {
  const ws = await liveCall()
  reply(CLOCK)
  assert.equal(handed(ws).length, 1)
  for (const [id, fn] of [...ledger.timers]) { ledger.timers.delete(id); fn() }
  assert.equal(handed(ws).length, 1, 'still waiting for the answer to part 1')
  t += 9000
  for (const [id, fn] of [...ledger.timers]) { ledger.timers.delete(id); fn() }
  assert.equal(handed(ws).length, 2)
})

test('silent replies ([SILENT], NO_REPLY, a suppressed stale result) are never spoken', async () => {
  const ws = await liveCall()
  for (const text of ['[SILENT]', 'NO_REPLY', 'silent.', '[SILENT] The Haifa check was cancelled; not speaking the late result.',
    'Late result for the cancelled check, suppressed.\n\n[SILENT]', '  no reply  ']) {
    reply(text)
    assert.deepEqual(handed(ws), [], text)
  }
  // a delegated turn that ends silent is not reported as "finished without a text answer" either
  ws.serve({ toolCall: { functionCalls: [{ id: 'c1', name: 'hermes_task', args: { request: 'check Haifa' } }] } })
  await settle()
  reply('[SILENT]')
  assert.deepEqual(handed(ws), [])
  assert.equal(P.call.delegations, 0)
  // prose that merely mentions the word is real content
  reply('The test printed SILENT mode is on, which is expected.')
  assert.equal(handed(ws).length, 1)
})

test('a short one-liner is one plain [Hermes result], no part numbering', async () => {
  const ws = await liveCall()
  reply('Cancelled.')
  assert.deepEqual(handed(ws), ['[Hermes result] Cancelled.'])
})

test('barge-in on a long answer drops the rest of THAT answer; a later reply is still spoken', async () => {
  const ws = await liveCall()
  reply(CLOCK)
  audio(ws)
  ws.serve({ serverContent: { interrupted: true } })
  ws.serve({ serverContent: { inputTranscription: { text: 'stop, enough' } } })
  done(ws)
  t += 5000
  for (const [id, fn] of [...ledger.timers]) { ledger.timers.delete(id); fn() }
  assert.equal(handed(ws).length, 1, 'parts 2..n are dropped')
  assert.equal(P.call.queue.length, 0)
  reply('Tomorrow: dentist at 16:00.')
  assert.deepEqual(handed(ws).at(-1), '[Hermes result] Tomorrow: dentist at 16:00.')
})

test('the user talking over buffered playback stops it; nothing is handed while they speak', async () => {
  const ws = await liveCall()
  audio(ws)
  done(ws) // generation finished, audio still queued in the player
  const player = ledger.contexts.find(c => c.sampleRate === 24000)
  ws.serve({ serverContent: { inputTranscription: { text: 'wait' } } })
  assert.ok(player.sources.every(s => s.stopped), 'playback stopped on the user speaking')
  reply('Dentist at 4pm.')
  assert.equal(handed(ws).length, 0, 'held while the user is talking')
  t += 2000
  for (const [id, fn] of [...ledger.timers]) { ledger.timers.delete(id); fn() }
  assert.deepEqual(handed(ws), ['[Hermes result] Dentist at 4pm.'])
})

test('the receipt allows an acknowledgement only, never the voice\'s own answer', () => {
  assert.match(P.RECEIPT, /Do not answer any part of it yourself: no joke, explanation, fact/)
  assert.match(P.RECEIPT, /I'm checking/)
  assert.match(P.RECEIPT, /speak it in full/)
})

test('speakable strips formatting but keeps every word', () => {
  const md = '## Title\n\n| Name | Time |\n|---|---|\n| Dentist | 16:00 |\n\n1. **First** step with `code`\n- *second*\n\n```js\nx()\n```\n\n[docs](https://a.b/c_(d))'
  assert.equal(P.speakable(md), 'Title\n\nName, Time\nDentist, 16:00\n\n1. First step with code\nsecond\n\n[code: see the chat]\n\ndocs')
  assert.equal(P.speakable('שעון מכני עובד בעזרת **מנגנון מילוט**.'), 'שעון מכני עובד בעזרת מנגנון מילוט.')
})

test('splitParts never drops text and caps very long replies with a pointer to the chat', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(60).trim() + '.').join('\n\n')
  const parts = P.splitParts(text)
  assert.equal(parts.join('\n\n').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '))
  assert.ok(parts.every(p => p.length <= P.PART_CHARS))
  const huge = 'x'.repeat(3000) // one unbreakable token
  assert.equal(P.splitParts(huge).join(''), huge)
  const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(60)).join('\n\n')
  const msgs = P.resultMessages(long)
  assert.equal(msgs.length, P.MAX_PARTS)
  assert.ok(msgs.at(-1).endsWith(P.REST_IN_CHAT))
})
