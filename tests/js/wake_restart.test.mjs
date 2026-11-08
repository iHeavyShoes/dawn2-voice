// node --test 'tests/js/*.test.mjs' — v0.8: the wake word survives a gateway restart. The detector
// lives in the gateway; a restart kills it while this window stays loaded. The renderer re-arms on
// the SDK's gateway socket reconnect (host.state.gateway -> 'open') and on an idle GET /wake check,
// never during a call.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'

const sdk = makeSdk()
const P = await loadPlugin(sdk)
let env, ledger, timers, backend

// A gateway atom with nanostores' listen(): called on every change, returns the disposer.
function gatewayAtom (v) {
  const fns = new Set()
  return {
    value: v,
    get () { return this.value },
    listen (fn) { fns.add(fn); return () => fns.delete(fn) },
    set (x) { this.value = x; for (const fn of [...fns]) fn(x) },
    listeners: () => fns.size
  }
}

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
  // The gateway's detector: `state` is what the CURRENT gateway process reports.
  backend = { enabled: true, state: 'listening' }
})

function fire (ms) { for (const [id, tm] of [...timers]) if (tm.ms === ms) { timers.delete(id); tm.fn() } }
const pending = ms => [...timers.values()].filter(tm => tm.ms === ms).length

function restartCtx () {
  const ctx = makeCtx({ mint: async () => ({ provider: 'gemini-free', transport: 'gemini-live', brain: 'hermes', url: 'wss://x.invalid/ws', setup: { setup: {} } }) })
  const base = ctx.rest
  ctx.wakeCalls = []
  ctx.rest = (path, opts) => {
    if (path.startsWith('/wake')) {
      ctx.wakeCalls.push(`${(opts && opts.method) || 'GET'} ${path}`)
      if (backend.down) return Promise.reject(new Error('gateway restarting'))
      if (path === '/wake/arm') { if (backend.enabled) backend.state = 'listening'; else backend.state = 'off' }
      if (path === '/wake/pause') return Promise.resolve({ paused: true })
      if (path === '/wake/resume') return Promise.resolve({ resuming: true })
      return Promise.resolve({ enabled: backend.enabled, state: backend.state, surface: 'desktop', phrase: 'hey ray', error: '' })
    }
    return base(path, opts)
  }
  ctx.onEvent = () => {}
  ctx.disposers = []
  ctx.onDispose = fn => ctx.disposers.push(fn)
  ctx.register = () => {}
  return ctx
}
const arms = ctx => ctx.wakeCalls.filter(c => c === 'POST /wake/arm').length

test('restart: gateway socket drops and reconnects -> the window re-arms the new detector', async () => {
  sdk.host.state.gateway = gatewayAtom('open')
  const ctx = restartCtx()
  P.default.register(ctx)
  await settle()
  assert.equal(arms(ctx), 1, 'armed at load')
  // gateway restart: the process (and its detector) is gone
  backend.down = true
  sdk.host.state.gateway.set('connecting')
  await settle()
  assert.equal(arms(ctx), 1, 'no arm while disconnected')
  backend.down = false
  backend.state = 'off' // the new process: nobody armed it
  sdk.host.state.gateway.set('open')
  await settle()
  assert.equal(arms(ctx), 2, 're-armed on reconnect')
  assert.equal(backend.state, 'listening')
  assert.equal(P.wake.armed, true)
  sdk.host.state.gateway.set('open') // no change: no extra arm
  await settle()
  assert.equal(arms(ctx), 2)
})

test('restart: a reconnect during a call does not touch the detector (the call holds the mic)', async () => {
  sdk.host.state.gateway = gatewayAtom('open')
  const ctx = restartCtx()
  P.default.register(ctx)
  await settle()
  P.call.state = 'live'
  sdk.host.state.gateway.set('connecting')
  sdk.host.state.gateway.set('open')
  await settle()
  assert.equal(arms(ctx), 1)
  P.call.state = 'idle'
})

test('restart: no reconnect event (SDK without the atom) -> the idle check finds it down and re-arms', async () => {
  const ctx = restartCtx()
  P.default.register(ctx)
  await settle()
  assert.equal(pending(P.WAKE_POLL_MS), 1, 'idle check scheduled')
  assert.ok(P.WAKE_POLL_MS >= 30000 && P.WAKE_POLL_MS <= 60000)
  backend.state = 'listening'
  fire(P.WAKE_POLL_MS)
  await settle()
  assert.deepEqual(ctx.wakeCalls.slice(1), ['GET /wake'], 'healthy: a GET only')
  assert.equal(pending(P.WAKE_POLL_MS), 1, 'rescheduled')
  backend.state = 'off' // gateway restarted, detector gone
  fire(P.WAKE_POLL_MS)
  await settle()
  assert.equal(arms(ctx), 2, 're-armed by the idle check')
  assert.equal(backend.state, 'listening')
  for (const state of ['paused', 'arming']) {
    backend.state = state
    fire(P.WAKE_POLL_MS)
    await settle()
    assert.equal(arms(ctx), 2, `${state} is left alone`)
  }
})

test('restart: the idle check never runs during a call or while a wake is being claimed', async () => {
  const ctx = restartCtx()
  P.default.register(ctx)
  await settle()
  backend.state = 'off'
  P.call.state = 'live'
  fire(P.WAKE_POLL_MS)
  await settle()
  assert.ok(!ctx.wakeCalls.includes('GET /wake'), 'not even a GET during a call')
  P.call.state = 'idle'
  P.wake.starting = true
  fire(P.WAKE_POLL_MS)
  await settle()
  assert.equal(arms(ctx), 1)
  P.wake.starting = false
  assert.equal(pending(P.WAKE_POLL_MS), 1, 'still scheduled for later')
})

test('restart: setting off -> no re-arm; gateway unreachable -> state kept, retried next time', async () => {
  const ctx = restartCtx()
  P.default.register(ctx)
  await settle()
  backend.enabled = false
  backend.state = 'off'
  fire(P.WAKE_POLL_MS)
  await settle()
  assert.equal(arms(ctx), 1)
  assert.equal(P.wake.armed, false)
  backend.enabled = true
  backend.down = true
  fire(P.WAKE_POLL_MS)
  await settle()
  assert.equal(pending(P.WAKE_POLL_MS), 1, 'a failed check reschedules')
  backend.down = false
  fire(P.WAKE_POLL_MS)
  await settle()
  assert.equal(arms(ctx), 2)
})

test('restart: an error is shown once, not on every check', async () => {
  const ctx = restartCtx()
  const base = ctx.rest
  ctx.rest = (path, opts) => path === '/wake/arm'
    ? (ctx.wakeCalls.push('POST /wake/arm'), Promise.resolve({ enabled: true, state: 'error', error: 'core wake on', surface: 'desktop' }))
    : path === '/wake' ? (ctx.wakeCalls.push('GET /wake'), Promise.resolve({ enabled: true, state: 'error', error: 'core wake on' })) : base(path, opts)
  P.default.register(ctx)
  await settle()
  for (let i = 0; i < 3; i++) { fire(P.WAKE_POLL_MS); await settle() }
  assert.equal(sdk.notes.filter(n => /core wake on/.test(n.message)).length, 1)
})

test('restart: dispose stops the idle check and the gateway listener', async () => {
  sdk.host.state.gateway = gatewayAtom('open')
  const ctx = restartCtx()
  P.default.register(ctx)
  await settle()
  assert.equal(sdk.host.state.gateway.listeners(), 1)
  ctx.disposers.forEach(fn => fn())
  await settle()
  assert.equal(sdk.host.state.gateway.listeners(), 0)
  assert.equal(pending(P.WAKE_POLL_MS), 0)
  assert.equal(P.wake.ctx, null)
})
