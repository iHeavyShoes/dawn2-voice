// node --test 'tests/js/*.test.mjs' — v0.7: the spoken end-call command (explicit phrases only, no
// false positives) and the wake word ("hey ray" starts this call): claim, the microphone hand-off
// and the re-arm after every hang-up.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'

const sdk = makeSdk()
const P = await loadPlugin(sdk)
let env, ledger, t, timers, desktopApp, testEnv

beforeEach(async () => {
  P.tearDown()
  await settle()
  P.resetCooldown()
  Object.assign(P.wake, { armed: false, owned: false, status: null, ctx: null, starting: false })
  ;({ env, ledger } = makeEnv())
  t = Date.UTC(2026, 10, 8, 12, 0, 0)
  timers = new Map()
  let next = 1
  desktopApp = true
  testEnv = {
    ...env,
    now: () => t,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id },
    clearTimeout: id => { timers.delete(id) },
    log: () => {},
    isDesktopApp: () => desktopApp
  }
  P.setEnv(testEnv)
  sdk.requests.length = 0
  sdk.notes.length = 0
  sdk.requestImpl = async () => ({ status: 'streaming' })
  sdk.host.state.activeSessionId.value = 'sess-1'
  sdk.host.state.focusedSessionId.value = 'sess-1'
  P.call.settings = { transcript_to_chat: 'chat_turn', half_duplex: false, language: 'he', persona_name: 'Ray', persona_name_he: 'ריי', persona_gender: 'male', silence_ms: 1000 }
  P.call.detail = ''
})

const later = ms => { t += ms }
function fire (ms) { for (const [id, tm] of [...timers]) if (tm.ms === ms) { timers.delete(id); tm.fn() } }
const NAMES = ['Ray', 'ריי', 'hermes', 'הרמס']
const GEMINI = { provider: 'gemini-free', provider_label: 'Gemini (free key)', transport: 'gemini-live', model: 'gemini-3.8-live', brain: 'hermes', url: 'wss://example.invalid/ws?access_token=auth_tokens/x', setup: { setup: { model: 'models/gemini-3.8-live' } } }
const AUDIO = { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAAAA==' } }
const SAY = '[Say aloud] '
const says = ws => ws.sent.filter(m => m.realtimeInput && typeof m.realtimeInput.text === 'string').map(m => m.realtimeInput.text)
const submits = () => sdk.requests.filter(r => r.method === 'prompt.submit' && r.params.surface === 'voice-live')
const allTracksStopped = () => ledger.tracks.every(tr => tr.stopped)

// A ctx whose /wake/* routes behave like the backend (wake.py), recording the order of calls.
function wakeCtx ({ enabled = true, state = 'listening', surface = 'desktop', claimed = true, paused = true, mint = async () => GEMINI } = {}) {
  const order = []
  const ctx = makeCtx({ mint })
  const base = ctx.rest
  ctx.order = order
  ctx.rest = (path, opts) => {
    if (path.startsWith('/wake')) {
      ctx.rests.push({ path, opts })
      order.push(path)
      if (path === '/wake/arm') return Promise.resolve({ enabled, state, surface, phrase: 'hey ray', error: state === 'error' ? 'busy mic' : '' })
      if (path === '/wake/claim') return Promise.resolve({ claimed })
      if (path === '/wake/pause') return Promise.resolve({ paused })
      if (path === '/wake/resume') return Promise.resolve({ resuming: true })
    }
    if (path === '/session') order.push('/session')
    return base(path, opts)
  }
  const gum = env.getUserMedia
  P.setEnv({ ...testEnv, getUserMedia: async c => { order.push('getUserMedia'); return gum(c) } })
  return ctx
}

async function upGemini () {
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
function geminiReads (ws) {
  ws.serve({ serverContent: { modelTurn: { parts: [AUDIO] }, outputTranscription: { text: 'read' } } })
  ws.serve({ serverContent: { turnComplete: true } })
}

// ── the end-call phrase detector ────────────────────────────────────────────────────────────────

test('end call: the explicit phrases hang up (he/en, with punctuation, fillers and spellings)', () => {
  for (const text of [
    'ביי ריי', 'ביי, ריי!', 'ביי רי', 'אממ ביי ריי', 'ביי ביי ריי', 'תודה, ביי ריי', 'אוקיי ביי ריי',
    'תסיים שיחה', 'סיים שיחה', 'סיים את השיחה', 'תסיים את השיחה', 'ריי, תסיים שיחה', 'טוב, סיים שיחה.',
    'תודה, תסיים שיחה', 'יאללה תסיים שיחה', 'ותסיים שיחה',
    'Bye Ray', 'bye, Ray.', 'goodbye Ray', 'end call', 'End call.', 'end the call', 'Ray, end call', 'ok, end call',
    'thanks, bye Ray', 'hang up', 'תנתק'
  ]) assert.equal(P.isEndCall(text, { names: NAMES }), true, text)
})

test('end call: casual goodbyes and sentences that merely contain a phrase do not hang up', () => {
  for (const text of [
    // a goodbye without the explicit phrase
    'ביי', 'ביי ביי', 'תודה ביי', 'יאללה ביי', 'להתראות', 'לילה טוב', 'נדבר', 'bye', 'bye bye', 'goodbye', 'thanks, bye', 'see you', 'thats all',
    // "ביי" mid-sentence
    'אני אגיד לו ביי ואחזור', 'תגיד ביי לכולם', 'say bye to the team', 'אמרתי לו ביי ריי אתמול',
    // an end-call phrase inside a request or a negation
    'אל תסיים שיחה', 'לא, אל תסיים את השיחה', "don't end the call", 'do not end call', 'how do I end call in zoom',
    'תסיים שיחה עם דני ביומן', 'תזכיר לי לסיים שיחה עם אמא', 'when the meeting ends call me', 'end call notes please',
    'ביי ריי תבדוק לי קודם את היומן', 'Bye Ray, but first check my calendar',
    // the name alone, greetings, acks
    'ריי', 'היי ריי', 'Hey Ray', 'תודה ריי', 'thanks Ray', ''
  ]) assert.equal(P.isEndCall(text, { names: NAMES }), false, JSON.stringify(text))
})

test('end call: the persona name comes from the settings (another persona, another name)', () => {
  assert.equal(P.isEndCall('ביי נועה', { names: ['Noa', 'נועה'] }), true)
  assert.equal(P.isEndCall('ביי ריי', { names: ['Noa', 'נועה'] }), false, 'not this persona: a sentence, not a command')
  assert.equal(P.isEndCall('bye noa', { names: ['Noa', 'נועה'] }), true)
})

// ── the end-call command in a call ──────────────────────────────────────────────────────────────

test('end call by voice: a short goodbye is said, then the same clean hang-up as the button', async () => {
  const ctx = wakeCtx()
  await P.armWake(ctx)
  await P.start(ctx)
  const ws = await upGemini()
  P.call.turns.push({ role: 'user', text: 'מה נשאר?' }, { role: 'assistant', text: 'שני דברים.' })
  await geminiUser(ws, 'תסיים שיחה')
  assert.equal(says(ws).at(-1), `${SAY}ביי.`, 'the goodbye is spoken')
  assert.equal(submits().length, 0, 'the command never reaches Hermes')
  assert.equal(P.call.state, 'live', 'still up while the goodbye plays')
  geminiReads(ws)
  await settle()
  assert.equal(P.call.state, 'idle')
  assert.ok(allTracksStopped(), 'mic released')
  assert.equal(ws.readyState, 3, 'socket closed')
  assert.ok(ctx.rests.some(r => r.path === '/wake/resume'), 'wake word re-armed')
  assert.ok(sdk.requests.some(r => r.method === 'prompt.submit' && r.params.surface !== 'voice-live') ||
    ctx.written.length > 0 || sdk.requests.some(r => /transcript|append|note/i.test(r.method)), 'transcript saved')
})

test('end call by voice: a casual "ביי" keeps the call up and resumes an interrupted reply', async () => {
  await P.start(makeCtx({ mint: async () => GEMINI }))
  const ws = await upGemini()
  await geminiUser(ws, 'ביי')
  await geminiUser(ws, 'תודה ביי')
  assert.equal(P.call.state, 'live')
  assert.ok(!says(ws).includes(`${SAY}ביי.`), 'no goodbye said')
  assert.equal(P.call.lastTurn.kind, 'ack')
  await geminiUser(ws, 'ביי ריי תבדוק לי קודם את היומן')
  assert.equal(P.call.state, 'live')
  assert.equal(submits().length, 1, 'a request with a goodbye in it goes to Hermes')
})

// ── the wake word ───────────────────────────────────────────────────────────────────────────────

test('wake: register subscribes to the plugin event and arms the detector', async () => {
  const handlers = {}
  const ctx = wakeCtx()
  ctx.onEvent = (name, fn) => { handlers[name] = fn }
  ctx.onDispose = () => {}
  ctx.register = () => {}
  P.default.register(ctx)
  await settle()
  assert.equal(typeof handlers['plugin.dawn2-voice.wake.detected'], 'function')
  assert.ok(ctx.rests.some(r => r.path === '/wake/arm'))
  assert.equal(P.wake.armed, true)
})

test('wake: a detection claims the token and starts the call on the open chat; "כן?" once up', async () => {
  const ctx = wakeCtx()
  await P.armWake(ctx)
  const started = P.onWakeDetected({ payload: { token: 'tok-1', phrase: 'hey ray' } })
  const ws = await upGemini()
  assert.equal(await started, true)
  assert.deepEqual(ctx.rests.find(r => r.path === '/wake/claim').opts.body, { token: 'tok-1' })
  assert.equal(P.call.sessionId, 'sess-1')
  assert.equal(P.call.state, 'live')
  assert.ok(!ctx.order.includes('/wake/pause'), 'the detector already freed the mic before the event')
  assert.ok(ctx.order.indexOf('/wake/claim') < ctx.order.indexOf('getUserMedia'), 'mic opened only after the claim')
  assert.deepEqual(says(ws), [`${SAY}כן?`])
})

test('wake: a lost claim (another window took it) starts nothing', async () => {
  const ctx = wakeCtx({ claimed: false })
  await P.armWake(ctx)
  assert.equal(await P.onWakeDetected({ payload: { token: 'tok-1' } }), false)
  assert.equal(P.call.state, 'idle')
  assert.equal(ledger.micCalls, 0)
})

test('wake: the phone/browser webapp does not answer by default (surface: desktop)', async () => {
  desktopApp = false
  const ctx = wakeCtx()
  await P.armWake(ctx)
  assert.equal(await P.onWakeDetected({ payload: { token: 'tok-1' } }), false)
  assert.ok(!ctx.rests.some(r => r.path === '/wake/claim'), 'it does not even claim')
  const any = wakeCtx({ surface: 'any' })
  await P.armWake(any)
  assert.equal(P.wakeEligible(), true, 'surface: any lets the webapp answer')
})

test('wake: ignored while a call is up, and without a token', async () => {
  const ctx = wakeCtx()
  await P.armWake(ctx)
  assert.equal(await P.onWakeDetected({ payload: {} }), false)
  await P.start(ctx)
  await upGemini()
  assert.equal(await P.onWakeDetected({ payload: { token: 'tok-2' } }), false)
  assert.ok(!ctx.rests.some(r => r.path === '/wake/claim'))
})

test('wake: no chat open -> nothing starts and the detector listens again', async () => {
  sdk.host.state.activeSessionId.value = null
  sdk.host.state.focusedSessionId.value = null
  const ctx = wakeCtx()
  await P.armWake(ctx)
  assert.equal(await P.onWakeDetected({ payload: { token: 'tok-1' } }), true)
  assert.equal(P.call.state, 'idle')
  assert.ok(ctx.rests.some(r => r.path === '/wake/resume'), 're-armed')
})

test('wake: a call from the button pauses the detector BEFORE opening the mic, and re-arms it after', async () => {
  const ctx = wakeCtx()
  await P.armWake(ctx)
  await P.start(ctx)
  await upGemini()
  assert.ok(ctx.order.indexOf('/wake/pause') >= 0, 'paused')
  assert.ok(ctx.order.indexOf('/wake/pause') < ctx.order.indexOf('getUserMedia'), 'the mic barrier comes first')
  P.tearDown('')
  await settle()
  assert.equal(ctx.order.filter(p => p === '/wake/resume').length, 1, 're-armed once')
})

test('wake: off or failed -> no pause, no resume (the v0.6 flow, unchanged)', async () => {
  for (const opts of [{ enabled: false, state: 'off' }, { enabled: true, state: 'error' }]) {
    sdk.notes.length = 0
    const ctx = wakeCtx(opts)
    await P.armWake(ctx)
    assert.equal(P.wake.armed, false)
    await P.start(ctx)
    await upGemini()
    P.tearDown('')
    await settle()
    assert.ok(!ctx.order.includes('/wake/pause') && !ctx.order.includes('/wake/resume'), JSON.stringify(opts))
    if (opts.state === 'error') assert.ok(sdk.notes.some(n => /Wake word: busy mic/.test(n.message)), 'the error is shown')
  }
})

test('wake: a failed start (mint error) after a wake still re-arms the detector', async () => {
  const ctx = wakeCtx({ mint: async () => { throw Object.assign(new Error('no provider'), { status: 503 }) } })
  await P.armWake(ctx)
  await P.onWakeDetected({ payload: { token: 'tok-1' } })
  await settle()
  assert.equal(P.call.state, 'idle')
  assert.ok(ctx.rests.some(r => r.path === '/wake/resume'))
})

test('wake: plugin dispose (disable / reload) hangs up and re-arms', async () => {
  const disposers = []
  const ctx = wakeCtx()
  ctx.onEvent = () => {}
  ctx.onDispose = fn => disposers.push(fn)
  ctx.register = () => {}
  P.default.register(ctx)
  await settle()
  await P.onWakeDetected({ payload: { token: 'tok-1' } })
  await upGemini()
  disposers.forEach(fn => fn())
  await settle()
  assert.ok(allTracksStopped())
  assert.ok(ctx.rests.some(r => r.path === '/wake/resume'))
})
