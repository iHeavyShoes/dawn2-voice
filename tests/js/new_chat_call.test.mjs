// Live call from a brand-new chat (ledger C8): no session id yet -> the plugin creates one through the
// same gateway RPC Desktop's composer uses (session.create, source 'desktop'), shows it, and pins the call.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'

const sdk = makeSdk()
const P = await loadPlugin(sdk)
let env, ledger, opened

beforeEach(() => {
  P.tearDown()
  ;({ env, ledger } = makeEnv())
  P.setEnv(env)
  sdk.requests.length = 0
  sdk.notes.length = 0
  opened = []
  sdk.host.openSession = async (stored, options) => { opened.push({ stored, options }) }
  sdk.host.state.activeSessionId.value = null
  sdk.host.state.focusedSessionId.value = null
  sdk.requestImpl = async method => method === 'session.create'
    ? { session_id: 'new-rt', stored_session_id: 'new-stored' }
    : { status: 'streaming' }
  P.call.settings = { interim_guard_ms: 0, transcript_to_chat: 'off', half_duplex: false }
  P.call.detail = ''
})

const live = async (ctx = makeCtx()) => {
  await P.start(ctx)
  await settle()
  const ws = ledger.sockets.at(-1)
  if (ws) { ws.open(); ws.serve({ setupComplete: {} }); await settle() }
  return ws
}

test('fresh chat: session.create runs once, the chat is opened, and the call is pinned to the new session', async () => {
  await live()
  const creates = sdk.requests.filter(r => r.method === 'session.create')
  assert.equal(creates.length, 1)
  assert.deepEqual(creates[0].params, { cols: 96, source: 'desktop' })
  assert.deepEqual(opened.map(o => o.stored), ['new-stored'])
  assert.equal(P.call.sessionId, 'new-rt')
  assert.notEqual(P.call.state, 'idle')
  await P.delegate('first spoken request')
  const submit = sdk.requests.find(r => r.method === 'prompt.submit')
  assert.equal(submit.params.session_id, 'new-rt')
  assert.equal(sdk.requests.filter(r => r.method === 'session.create').length, 1)
})

test('existing session: nothing is created, behaviour unchanged', async () => {
  sdk.host.state.focusedSessionId.value = 'sess-1'
  await live()
  assert.equal(sdk.requests.filter(r => r.method === 'session.create').length, 0)
  assert.equal(opened.length, 0)
  assert.equal(P.call.sessionId, 'sess-1')
})

test('two quick presses create only one session', async () => {
  let release
  sdk.requestImpl = method => method === 'session.create'
    ? new Promise(resolve => { release = () => resolve({ session_id: 'new-rt', stored_session_id: 'new-stored' }) })
    : Promise.resolve({ status: 'streaming' })
  const a = P.start(makeCtx()), b = P.start(makeCtx())
  await settle()
  release()
  await Promise.all([a, b])
  await settle()
  assert.equal(sdk.requests.filter(r => r.method === 'session.create').length, 1)
  assert.equal(P.call.sessionId, 'new-rt')
})

test('session.create fails: the call does not start, the reason is shown', async () => {
  sdk.requestImpl = async () => { throw new Error('gateway down') }
  await P.start(makeCtx())
  assert.equal(P.call.state, 'idle')
  assert.equal(ledger.sockets.length, 0)
  assert.match(sdk.notes[0].message, /gateway down/)
})

test('openSession fails: the call still starts pinned to the created session, with a warning', async () => {
  sdk.host.openSession = async () => { throw new Error('open refused') }
  await live()
  assert.equal(P.call.sessionId, 'new-rt')
  assert.ok(sdk.notes.some(n => /open refused/.test(n.message)))
})
