import {test, beforeEach} from 'node:test'
import assert from 'node:assert/strict'
import {makeSdk, loadPlugin, makeEnv, makeCtx, settle} from './harness.mjs'
const sdk = makeSdk(), P = await loadPlugin(sdk)
const ev = payload => ({session_id:'sess-1', payload})
let queued, replies
beforeEach(async () => {
  P.tearDown(); await settle()
  const {env, ledger} = makeEnv()
  P.setEnv(env)
  P.call.settings = { interim_guard_ms: 0, language:'he', transcript_to_chat:'off'}
  await P.start(makeCtx({mint:async () => ({provider:'gemini-free',transport:'gemini-live',brain:'hermes',url:'wss://example.invalid',setup:{}})})); await settle()
  const ws = ledger.sockets.at(-1); ws.open(); ws.serve({setupComplete:{}})
  queued = 0; replies = []
  sdk.requests.length = 0; sdk.notes.length = 0
  sdk.requestImpl = async method => method === 'prompt.submit'
    ? {admission_id:'a'+(++queued), status:'queued'}
    : replies.shift() || {status:'started', outcome:'steering'}
})
const info = (pending, running = true) => P.onSessionInfo(ev({running, pending_submissions:pending}))
const row = (id, extra = {}) => ({admission_id:id, status:'queued', controls:['steer','replace'], ...extra})
test('default stays queued; button steers only the last own queued voice admission, once', async () => {
  info([])
  await P.delegate('First voice instruction'); await P.delegate('Second voice instruction')
  assert.equal(sdk.requests.filter(r => r.method === 'prompt.steer_queued').length,0)
  assert.equal(P.steerCandidate().text,'Second voice instruction')
  await Promise.all([P.steerQueuedVoice(), P.steerQueuedVoice()])
  assert.deepEqual(sdk.requests.filter(r => r.method === 'prompt.steer_queued'), [
    {method:'prompt.steer_queued',params:{session_id:'sess-1',admission_id:'a2'}}
  ])
  assert.equal(P.steerCandidate().text,'First voice instruction')
})
test('no button while idle, no queued voice, or owner does not support steer', async () => {
  info([row('typed')]); assert.equal(P.steerCandidate(),null)
  await P.delegate('Voice instruction')
  info([row('a1')],false); assert.equal(P.steerCandidate(),null)
  info([row('a1',{controls:['replace']})]); assert.equal(P.steerCandidate(),null)
  info([row('a1')]); assert.ok(P.steerCandidate())
  info([row('a1',{status:'started'})]); assert.equal(P.steerCandidate(),null)
})
test('authoritative pending removes a consumed voice row and ignores another session', async () => {
  info([]); await P.delegate('Voice instruction')
  info([row('a1')]); assert.ok(P.steerCandidate())
  P.onSessionInfo({session_id:'other',payload:{running:false,pending:[]}})
  assert.ok(P.steerCandidate())
  info([]); assert.equal(P.steerCandidate(),null)
  assert.equal(await P.steerQueuedVoice(),false)
})
test('RPC refusal leaves original queued admission, never resubmits its text', async () => {
  info([]); await P.delegate('Keep this queued')
  sdk.requestImpl = async () => {throw Error('steer_unavailable')}
  assert.equal(await P.steerQueuedVoice(),false)
  assert.ok(P.steerCandidate())
  assert.equal(sdk.requests.filter(r => r.method === 'prompt.submit').length,1)
  assert.ok(sdk.notes.length)
})
test('pending fanout before submit receipt fences stale queued receipt', async () => {
  info([])
  let finish
  sdk.requestImpl = async (method, params) => {
    if (method !== 'prompt.submit') return {status:'started'}
    info([row('race',{input_id:params.submission_id})])
    info([])
    return new Promise(resolve => {finish=resolve})
  }
  const promise = P.delegate('Racing voice instruction')
  finish({admission_id:'race',status:'queued'}); await promise
  assert.equal(P.steerCandidate(),null)
})
test('call UI renders a steer button only for a running queued voice and uses its click RPC', async () => {
  assert.equal(P.VoiceSteerButton(),null)
  info([]); await P.delegate('Queued voice')
  const button = P.VoiceSteerButton()
  assert.equal(button[0],'button')
  assert.equal(button[1]['aria-label'],'העבר לתשובה הנוכחית')
  button[1].onClick(); await settle()
  assert.equal(sdk.requests.at(-1).method,'prompt.steer_queued')
  assert.equal(P.VoiceSteerButton(),null)
})
test('a late queued receipt after hangup cannot reappear in a new call', async () => {
  info([])
  let finish
  sdk.requestImpl = () => new Promise(resolve => {finish=resolve})
  const promise = P.delegate('Old instruction')
  P.tearDown()
  finish({status:'queued',admission_id:'old'}); await promise
  assert.equal(P.call.voiceSubmissions.size,0)
  assert.equal(P.steerCandidate(),null)
})
test('hangup during submit or steer cannot affect the next call', async () => {
  info([]); await P.delegate('Old voice instruction')
  let finish
  sdk.requestImpl = () => new Promise(resolve => {finish=resolve})
  const promise = P.steerQueuedVoice()
  P.tearDown(); finish({status:'started'}); await promise
  assert.equal(P.steerCandidate(),null)
})
