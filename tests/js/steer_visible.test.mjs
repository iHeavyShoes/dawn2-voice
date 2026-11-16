// V22: a queued voice turn must show a clearly visible Steer control while the owner's turn runs.
// Payload shapes come from the owner contract (CanonicalPendingAdmission.controls): Desktop's forced
// clarify_batch makes the owner list controls: [] (see owner/ evidence); with the owner fix it lists both.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'

const sdk = makeSdk(), P = await loadPlugin(sdk)
const ev = payload => ({ session_id: 'sess-1', payload })
let queued
beforeEach(async () => {
  P.tearDown(); await settle()
  const { env, ledger } = makeEnv()
  P.setEnv(env)
  P.call.settings = { interim_guard_ms: 0, language: 'he', transcript_to_chat: 'off' }
  await P.start(makeCtx({ mint: async () => ({ provider: 'gemini-free', transport: 'gemini-live', brain: 'hermes', url: 'wss://example.invalid', setup: {} }) })); await settle()
  const ws = ledger.sockets.at(-1); ws.open(); ws.serve({ setupComplete: {} })
  queued = 0
  sdk.requests.length = 0; sdk.notes.length = 0
  sdk.requestImpl = async method => method === 'prompt.submit'
    ? { admission_id: 'a' + (++queued), status: 'queued' }
    : { status: 'started', outcome: 'steering' }
})
const info = (pending, running = true) => P.onSessionInfo(ev({ running, pending }))
const pendingRow = (id, controls) => ({ admission_id: id, input_id: id, status: 'queued', text: 'x', controls, steering: false })
const flat = node => JSON.stringify(node)

test('owner lists steer: the pill renders in the composer and in the status bar, with the queue count', async () => {
  await P.delegate('first'); await P.delegate('second')
  info([pendingRow('a1', ['steer', 'replace']), pendingRow('a2', ['steer', 'replace'])])
  const inline = P.VoiceSteerButton({}), bar = P.VoiceSteerButton({ bar: true })
  assert.match(flat(inline), /העבר לתשובה הנוכחית \(2 בתור\)/)
  assert.match(flat(bar), /"data-voice-steer":"bar"/)
  assert.match(flat(inline), /rounded-full/)
})

test('no queued voice turn or Mike idle: nothing is rendered', async () => {
  assert.equal(P.VoiceSteerButton({ bar: true }), null)
  await P.delegate('first')
  info([pendingRow('a1', ['steer', 'replace'])], false)
  assert.equal(P.VoiceSteerButton({ bar: true }), null)
})

test('Desktop-forced clarify_batch shape (owner lists controls: []) offers no steer — the owner would refuse it', async () => {
  await P.delegate('first')
  info([pendingRow('a1', [])])
  assert.equal(P.steerCandidate(), null)
  assert.equal(P.VoiceSteerButton({}), null)
  assert.match(flat(P.VoiceSteerButton({ bar: true })), /"data-voice-steer":"hint".*לא זמינה בשרת/)
  assert.deepEqual(P.queuedVoiceState(), { queued: 1, steerable: false })
  assert.equal(await P.steerQueuedVoice(), false)
  assert.equal(sdk.requests.filter(r => r.method === 'prompt.steer_queued').length, 0)
})

test('click transfers the admission once and never re-submits text', async () => {
  await P.delegate('only this')
  info([pendingRow('a1', ['steer', 'replace'])])
  const btn = P.VoiceSteerButton({})
  const props = btn[1]
  props.onClick(); props.onClick()
  await settle()
  assert.deepEqual(sdk.requests.filter(r => r.method === 'prompt.steer_queued').map(r => r.params), [{ session_id: 'sess-1', admission_id: 'a1' }])
  assert.equal(sdk.requests.filter(r => r.method === 'prompt.submit').length, 1)
  assert.equal(P.steerCandidate(), null)
})
