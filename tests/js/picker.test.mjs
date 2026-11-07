// node --test 'tests/js/*.test.mjs' — v0.5: the provider picker (rows, one-click choice), a pinned
// provider that fails (spoken notice + "Use Auto"), and the paid-Gemini billing refusal (HTTP 402).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'

const sdk = makeSdk()
const P = await loadPlugin(sdk)
let env, ledger

beforeEach(async () => {
  P.tearDown()
  await settle()
  P.resetCooldown()
  ;({ env, ledger } = makeEnv())
  P.setEnv(env)
  sdk.notes.length = 0
  P.ui.status = null
  P.ui.saving = false
  P.call.settings = { transcript_to_chat: 'chat_turn', half_duplex: false, language: 'he' }
  P.call.detail = ''
})

const GEMINI = { provider: 'gemini-free', provider_label: 'Gemini (free key)', transport: 'gemini-live', model: 'm', url: 'wss://example.invalid/ws?access_token=auth_tokens/x', setup: { setup: { model: 'models/m' } } }
const PAID = { ...GEMINI, provider: 'gemini-paid', provider_label: 'Gemini (paid key)' }

const PICKER = {
  choice: 'auto',
  persistent: true,
  options: [
    { id: 'auto', label: 'Auto (fallback chain)', state: 'ready', detail: 'Gemini (free key) -> Gemini (paid key)', selected: true },
    { id: 'gemini-free', label: 'Gemini (free key)', state: 'ready', detail: 'GEMINI_API_KEY is set', selected: false },
    { id: 'openai-codex', label: 'ChatGPT (Codex subscription)', state: 'missing', reason: 'not_signed_in', detail: 'openai-codex unavailable: not signed in', selected: false },
    { id: 'gemini-paid', label: 'Gemini (paid key)', state: 'refused', reason: 'billing', detail: 'gemini-paid unavailable: no credit / billing (add credit or billing in Google AI Studio)', selected: false }
  ]
}

function err (status, detail) { const e = new Error(String(status)); e.detail = detail; return e }

test('402 and billing texts are "billing"; plain quota stays "quota"', () => {
  assert.equal(P.failureReason('Payment Required', 402), 'billing')
  assert.equal(P.failureReason('RESOURCE_EXHAUSTED: billing account has no prepaid credit', 429), 'billing')
  assert.equal(P.failureReason('This method requires billing to be enabled', 403), 'billing')
  assert.equal(P.failureReason('RESOURCE_EXHAUSTED: quota exceeded', 429), 'quota')
  assert.equal(P.unavailableText('gemini-paid', 'billing'), 'gemini-paid unavailable: no credit / billing')
})

test('picker rows: missing is greyed out with its reason; refused stays clickable with its reason', () => {
  const rows = Object.fromEntries(P.pickerRows({ picker: PICKER }).map(r => [r.id, r]))
  assert.deepEqual(Object.keys(rows), ['auto', 'gemini-free', 'openai-codex', 'gemini-paid'])
  assert.equal(rows.auto.selected, true)
  assert.equal(rows['openai-codex'].disabled, true)
  assert.equal(rows['openai-codex'].tooltip, 'openai-codex unavailable: not signed in')
  assert.equal(rows['gemini-paid'].disabled, false)
  assert.match(rows['gemini-paid'].tooltip, /^gemini-paid unavailable: no credit \/ billing/)
  assert.equal(P.choiceOf({ picker: PICKER }), 'auto')
  assert.equal(P.choiceOf(null), 'auto')
})

test('one click stores the choice through the plugin route and refreshes availability', async () => {
  let stored = 'auto'
  const ctx = makeCtx({
    choose: async body => { stored = body.choice; return { ...PICKER, choice: stored } },
    status: () => ({ available: true, settings: {}, picker: { ...PICKER, choice: stored } })
  })
  assert.equal(await P.setChoice(ctx, 'gemini-free'), true)
  assert.deepEqual(ctx.rests.find(r => r.path === '/choice').opts, { method: 'POST', body: { choice: 'gemini-free' } })
  assert.equal(P.choiceOf(P.ui.status), 'gemini-free')
  assert.equal(P.ui.saving, false)
})

test('a choice that cannot be saved says so', async () => {
  const ctx = makeCtx({ choose: async () => { throw err(500, { reason: 'not_saved', message: 'The provider choice could not be saved.' }) } })
  assert.equal(await P.setChoice(ctx, 'gemini-paid'), false)
  assert.equal(sdk.notes.at(-1).message, 'The provider choice could not be saved.')
})

test('auto: a mid-call 402 on the paid key moves the chain on and reports billing', async () => {
  const served = [PAID, GEMINI]
  const bodies = []
  const ctx = makeCtx({ mint: async body => { bodies.push(body); return { ...served.shift(), choice: 'auto' } } })
  await P.start(ctx)
  await settle()
  const ws = ledger.sockets.at(-1)
  ws.open()
  ws.serve({ setupComplete: {} })
  await settle()
  ws.serve({ error: { code: 402, message: 'Payment Required: prepayment credit balance is $0' } })
  await settle(10)
  assert.equal(bodies[1].switch_from, 'gemini-paid')
  assert.equal(bodies[1].reason, 'billing')
  assert.ok(bodies[1].exclude.includes('gemini-paid'))
  assert.deepEqual(ctx.rests.find(r => r.path === '/report').opts.body, { provider: 'gemini-paid', reason: 'billing' })
  assert.ok(P.cooledProviders().includes('gemini-paid'))
  assert.equal(P.call.provider.id, 'gemini-free')
  assert.equal(ledger.spoken.length, 0)
})

test('pinned: a mid-call 402 ends the call, says why out loud, and offers Auto', async () => {
  const bodies = []
  const ctx = makeCtx({
    mint: async body => { bodies.push(body); return { ...PAID, choice: 'gemini-paid' } },
    choose: async body => ({ ...PICKER, choice: body.choice })
  })
  await P.start(ctx)
  await settle()
  const ws = ledger.sockets.at(-1)
  ws.open()
  ws.serve({ setupComplete: {} })
  await settle()
  ws.serve({ error: { code: 402, message: 'Payment Required' } })
  await settle(10)
  assert.equal(bodies.length, 1, 'no fallback to another provider')
  assert.equal(P.call.state, 'idle')
  assert.ok(ws.closed || ws.readyState === 3)
  const note = sdk.notes.at(-1)
  assert.equal(note.message, 'gemini-paid unavailable: no credit / billing. Switch the voice provider to Auto to use the fallback chain.')
  assert.equal(note.action.label, 'Use Auto')
  assert.equal(ledger.spoken.length, 1)
  assert.match(ledger.spoken[0].text, /Gemini \(paid key\) is unavailable: no credit \/ billing.*Auto/)
  note.action.onClick()
  await settle()
  assert.deepEqual(ctx.rests.find(r => r.path === '/choice').opts.body, { choice: 'auto' })
})

test('pinned: the spoken notice is Hebrew when the call is in Hebrew and a Hebrew voice exists', () => {
  ledger.voices.push('he-IL')
  assert.match(P.pinnedNoticeText('gemini-paid', 'billing', 'he'), /^ספק הקול Gemini \(paid key\) לא זמין: אין קרדיט או חיוב בחשבון/)
  assert.match(P.pinnedNoticeText('gemini-paid', 'billing', 'en'), /^The voice provider/)
})

test('pinned: a refusal at connect is announced with the backend reason and no retry', async () => {
  const bodies = []
  const ctx = makeCtx({
    mint: async body => {
      bodies.push(body)
      throw err(502, { reason: 'pinned_unavailable', choice: 'gemini-paid', attempts: [{ provider: 'gemini-paid', reason: 'billing' }], message: 'gemini-paid unavailable: no credit / billing. Switch the voice provider to Auto to use the fallback chain.' })
    }
  })
  await P.start(ctx)
  await settle(10)
  assert.equal(bodies.length, 1)
  assert.equal(P.call.state, 'idle')
  assert.equal(ledger.sockets.length, 0)
  const note = sdk.notes.at(-1)
  assert.match(note.message, /^gemini-paid unavailable: no credit \/ billing/)
  assert.equal(note.action.label, 'Use Auto')
  assert.equal(ledger.spoken.length, 1)
  assert.ok(ctx.rests.some(r => r.path === '/status'), 'the picker is refreshed after the failure')
})
