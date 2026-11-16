// node --test 'tests/js/*.test.mjs' - v0.9: the wake word comes back after core tore the detector down
// (microphone lost). The gateway now reports that as state 'error'; the idle poll's GET /wake sees it and
// POSTs /wake/arm. Only the wake-word REST calls are made: no restart of the gateway/Desktop, nothing during a call.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'

const sdk = makeSdk()
const P = await loadPlugin(sdk)
let env, ledger, timers, backend

beforeEach(async () => {
  P.tearDown()
  await settle()
  P.resetCooldown()
  Object.assign(P.wake, { armed: false, owned: false, status: null, ctx: null, starting: false, pollTimer: null, lastError: '' })
  ;({ env, ledger } = makeEnv())
  timers = new Map()
  let next = 1
  P.setEnv({
    ...env,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id },
    clearTimeout: id => { timers.delete(id) },
    log: () => {},
    isDesktopApp: () => true
  })
  sdk.notes.length = 0
  sdk.host.state.activeSessionId.value = 'sess-1'
  sdk.host.state.focusedSessionId.value = 'sess-1'
  delete sdk.host.state.gateway
  P.call.settings = { transcript_to_chat: 'file', half_duplex: false, language: 'he', persona_name: 'Ray', persona_name_he: 'ריי', persona_gender: 'male', silence_ms: 1000 }
  // `micBack` false: arming fails with the mic-missing error, like the gateway's WakeManager does.
  backend = { enabled: true, state: 'listening', error: '', micBack: true }
})

function fire (ms) { for (const [id, tm] of [...timers]) if (tm.ms === ms) { timers.delete(id); tm.fn() } }

function micCtx () {
  const ctx = makeCtx({ mint: async () => ({ provider: 'gemini-free', transport: 'gemini-live', brain: 'hermes', url: 'wss://x.invalid/ws', setup: { setup: {} } }) })
  const base = ctx.rest
  ctx.wakeCalls = []
  const status = () => ({ enabled: backend.enabled, state: backend.state, surface: 'desktop', phrase: 'hey ray', error: backend.error })
  ctx.rest = (path, opts) => {
    if (path.startsWith('/wake')) {
      ctx.wakeCalls.push(`${(opts && opts.method) || 'GET'} ${path}`)
      if (path === '/wake/arm') {
        if (backend.micBack) { backend.state = 'listening'; backend.error = '' } else { backend.state = 'error'; backend.error = 'The wake word could not start: MME error 6.' }
      }
      return Promise.resolve(status())
    }
    return base(path, opts)
  }
  ctx.onEvent = () => {}
  ctx.onDispose = () => {}
  ctx.register = () => {}
  return ctx
}
const arms = ctx => ctx.wakeCalls.filter(c => c === 'POST /wake/arm').length
const poll = async () => { fire(P.WAKE_POLL_MS); await settle() }

test('mic loss: the idle poll sees the gateway report error and re-arms; a healthy poll is a GET only', async () => {
  const ctx = micCtx()
  P.default.register(ctx)
  await settle()
  assert.equal(arms(ctx), 1)
  await poll()
  assert.equal(arms(ctx), 1, 'listening: GET only')
  backend.state = 'error'; backend.error = 'The wake word\'s microphone stopped (muted, unplugged or taken by another app). Re-arming automatically.'
  await poll()
  assert.equal(arms(ctx), 2, 're-armed by the idle poll')
  assert.equal(backend.state, 'listening')
  assert.equal(P.wake.armed, true)
})

test('mic loss: mic still missing -> error once on screen, retried on every poll (45 s apart), then success', async () => {
  const ctx = micCtx()
  P.default.register(ctx)
  await settle()
  backend.micBack = false
  backend.state = 'error'; backend.error = 'mic lost'
  await poll(); await poll(); await poll()
  assert.equal(arms(ctx), 4, 'one arm per poll, never a tight loop')
  assert.equal(P.wake.armed, false)
  assert.equal(sdk.notes.filter(n => /MME error 6/.test(n.message)).length, 1, 'the error is shown once')
  assert.equal(timers.size, 1, 'exactly one poll timer pending')
  assert.ok(P.WAKE_POLL_MS >= 30000)
  backend.micBack = true
  await poll()
  assert.equal(backend.state, 'listening')
  assert.equal(P.wake.armed, true)
})

test('mic loss: nothing is re-armed during a call or while paused', async () => {
  const ctx = micCtx()
  P.default.register(ctx)
  await settle()
  backend.state = 'error'
  P.call.state = 'live'
  await poll()
  assert.deepEqual(ctx.wakeCalls, ['POST /wake/arm'], 'not even a GET during a call')
  P.call.state = 'idle'
  backend.state = 'paused'
  await poll()
  assert.equal(arms(ctx), 1, 'paused (a call holds the mic) is left alone')
})

test('mic loss: the plugin only ever calls the /wake routes (no gateway or Desktop restart request)', async () => {
  const ctx = micCtx()
  P.default.register(ctx)
  await settle()
  backend.state = 'error'
  await poll()
  assert.ok(ctx.wakeCalls.every(c => /^(GET|POST) \/wake(\/arm)?$/.test(c)), ctx.wakeCalls.join())
})
