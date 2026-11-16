import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'
const sdk = makeSdk(), P = await loadPlugin(sdk)
let ledger, now, timers, ctx, rng
const ev = payload => ({ session_id: 'sess-1', payload })
beforeEach(async () => {
  P.tearDown(); await settle(); P.resetCooldown(); P.resetAckMemory()
  const e = makeEnv(); ledger = e.ledger; now = 100000; timers = new Map()
  rng = .5
  P.setEnv({ ...e.env, now: () => now, random: () => rng, log: () => {},
    setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, at: now + ms }); return id },
    clearTimeout: id => timers.delete(id) })
  P.call.settings = { interim_guard_ms: 0, language: 'he', transcript_to_chat: 'off' }
  sdk.requestImpl = async () => ({ status: 'streaming' })
})
function advance(ms) {
  const end = now + ms
  for (;;) {
    const next = [...timers].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at)[0]
    if (!next) break
    now = next[1].at; timers.delete(next[0]); next[1].fn()
  }
  now = end
}
async function start(transport = 'openai-realtime') {
  ctx = makeCtx({ mint: async () => transport === 'openai-realtime'
    ? { provider: 'openai-codex', transport, brain: 'hermes', client_secret: 'synthetic', offer_url: 'https://api.openai.com/v1/realtime/calls' }
    : { provider: 'gemini-free', transport, brain: 'hermes', url: 'wss://example.invalid', setup: {} } })
  await P.start(ctx); await settle()
  if (transport === 'openai-realtime') { const dc = ledger.peers.at(-1).dc; dc.open(); return dc }
  const ws = ledger.sockets.at(-1); ws.open(); ws.serve({ setupComplete: {} }); return ws
}
const says = dc => dc.sent.filter(m => m.response?.metadata?.d2v === 'say')
function done(dc) {
  const req = says(dc).at(-1)
  dc.serve({ type: 'response.created', response: { id: String(says(dc).length), metadata: req.response.metadata } })
  dc.serve({ type: 'response.done', response: { id: String(says(dc).length), metadata: req.response.metadata, status: 'completed' } })
}
const text = dc => says(dc).at(-1)?.response.input[0].content[0].text || ''
test('neutral banks have sufficient variety and no evaluative words or question flags', () => {
  const deny = /אחלה|סבבה|יאללה|מגניב|שאלה טובה|good question|great|sure thing|ooh|awesome|wonderful/i
  for (const [lang, min] of [['he',30],['en',20]]) {
    assert.ok(P.ACK_BANK[lang].length >= min)
    for (const e of P.ACK_BANK[lang]) { assert.equal(typeof e, 'string'); assert.doesNotMatch(e, deny) }
  }
})
test('bank choice ignores all turn content including incomplete, echoed and question text', () => {
  for (const lang of ['he','en']) for (const female of [false,true]) {
    const results = ['?', '', 'a', 'I was thinking and', 'רגע אחד', 'תבדוק את זה בבקשה'].map(turn => {
      P.resetAckMemory(); return P.pickAck(turn, { lang, female, noSilence:true, rand: () => .5 })
    })
    assert.ok(results[0]); assert.equal(new Set(results).size, 1)
  }
})
for (const transport of ['openai-realtime','gemini-live']) test(`bank default never requests model ack: ${transport}`, async () => {
  const dc = await start(transport)
  P.onUserTurn('תבדוק בבקשה את המצב עכשיו', now)
  await settle(); advance(900)
  assert.equal(ctx.rests.filter(r => r.path === '/ack').length, 0)
  assert.equal(dc.sent.filter(m => m.response?.metadata?.d2v === 'ack').length, 0)
})
test('progress waits 75s then randomized cadence and permits apologies only later', async () => {
  const dc = await start(); P.onMessageStart(ev({turn_id:'a'}))
  advance(74999); assert.equal(says(dc).length,0)
  advance(1); assert.equal(says(dc).length,1); assert.doesNotMatch(text(dc), /סליחה|sorry/i)
  assert.equal(P.call.lastHanded.kind,'progress')
  done(dc); advance(34999); assert.equal(says(dc).length,1)
  advance(1); assert.equal(says(dc).length,2)
  assert.ok(P.PROGRESS_BANK.he.some(e => e.apology))
})
for (const reason of ['end','hangup','speech','stop']) test(`progress ceases on ${reason}`, async () => {
  const dc = await start(); P.onMessageStart(ev({turn_id:'a'})); advance(75000)
  if (reason === 'end') P.onMessageComplete(ev({turn_id:'a',text:'NO_REPLY'}))
  if (reason === 'hangup') P.tearDown()
  if (reason === 'speech') dc.serve({type:'input_audio_buffer.speech_started',item_id:'u'})
  if (reason === 'stop') P.onUserTurn('stop',now)
  advance(180000); assert.equal(says(dc).length,1)
})
test('real reply preempts progress and mid-answer silence restarts the 75s window', async () => {
  const dc = await start(); P.onMessageStart(ev({turn_id:'a'})); advance(75000)
  dc.serve({type:'response.created',response:{id:'progress-1',metadata:says(dc).at(-1).response.metadata}})
  P.onMessageDelta(ev({turn_id:'a',text:'Actual answer. '}))
  assert.ok(dc.sent.some(m => m.type === 'response.cancel'))
  assert.equal(P.call.lastHanded.kind,'reply')
  done(dc); advance(74999); assert.equal(says(dc).length,2)
  advance(1); assert.equal(says(dc).length,3); assert.equal(P.call.lastHanded.kind,'progress')
})
test('progress is not a held/resumable reply after wordless barge-in', async () => {
  const dc = await start(); P.onMessageStart(ev({turn_id:'a'})); advance(75000)
  dc.serve({type:'input_audio_buffer.speech_started',item_id:'u'})
  assert.equal(P.call.held,null)
  assert.ok(!P.call.queue.some(i => i.kind === 'progress'))
  dc.serve({type:'conversation.item.input_audio_transcription.completed',item_id:'u',transcript:'yes'})
  advance(180000); assert.equal(says(dc).length,1)
})
for (const setting of ['progress_first_ms','progress_every_ms']) test(`${setting}=0 disables progress`, async () => {
  P.call.settings[setting]=0
  const dc = await start(); P.onMessageStart(ev({turn_id:'a'})); advance(200000)
  assert.equal(says(dc).length,0)
})

for (const [rand, cadence] of [[0, 30000], [.999999, 40000]]) test(`progress cadence boundary ${cadence}ms and apology eligibility`, async () => {
  rng = rand
  const dc = await start(); P.onMessageStart(ev({turn_id:'a'}))
  advance(75000); assert.equal(says(dc).length,1)
  assert.doesNotMatch(text(dc), /סליחה|sorry/i)
  done(dc); advance(cadence - 1); assert.equal(says(dc).length,1)
  advance(1); assert.equal(says(dc).length,2)
  if (rand > .9) assert.match(text(dc), /סליחה/)
})
for (const busy of ['speech', 'playback']) test(`progress is suppressed throughout existing ${busy}`, async () => {
  const dc = await start(); P.onMessageStart(ev({turn_id:'a'}))
  if (busy === 'speech') dc.serve({type:'input_audio_buffer.speech_started',item_id:'u'})
  else {
    P.onMessageDelta(ev({turn_id:'a',text:'Answer in progress. '}))
    dc.serve({type:'response.created',response:{id:'r',metadata:says(dc).at(-1).response.metadata}})
    dc.serve({type:'output_audio_buffer.started'})
  }
  const before = says(dc).length
  advance(240000); assert.equal(says(dc).length,before)
})
test('progress language and persona gender follow active Hebrew call, not Latin request terms', async () => {
  P.call.settings.persona_gender = 'female'
  rng = .01
  const dc = await start()
  P.onUserTurn('תבדוק בבקשה את Hermes ואת plugin.js', now)
  P.onMessageStart(ev({turn_id:'a'}))
  advance(75000); assert.match(text(dc), /עדיין בודקת/)
})
test('English progress follows an explicit English conversation switch', async () => {
  rng = .01
  const dc = await start()
  P.onUserTurn('Please switch to English and check the current build status', now)
  P.onMessageStart(ev({turn_id:'a'}))
  advance(75000); assert.equal(text(dc),'Still checking.')
})
test('Gemini progress is preempted and real answer survives muted progress tail', async () => {
  const ws = await start('gemini-live')
  const gsays = () => ws.sent.filter(m => m.realtimeInput?.text).map(m => m.realtimeInput.text)
  P.onMessageStart(ev({turn_id:'a'})); advance(75000)
  assert.equal(P.call.lastHanded.kind,'progress')
  ws.serve({serverContent:{modelTurn:{parts:[{inlineData:{data:'AAAAAA=='}}]}}})
  P.onMessageDelta(ev({turn_id:'a',text:'Actual first answer. '}))
  assert.ok(ledger.contexts.every(c => c.sources.every(s => s.stopped)))
  ws.serve({serverContent:{turnComplete:true}})
  assert.equal(gsays().at(-1),'[Say aloud] Actual first answer.')
  ws.serve({serverContent:{modelTurn:{parts:[{inlineData:{data:'AAAAAA=='}}]},turnComplete:true}})
  for (const c of ledger.contexts) for (const s of c.sources) s.onended?.()
  advance(74999); assert.equal(gsays().length,2)
  advance(1); assert.equal(gsays().length,3)
  assert.equal(P.call.lastHanded.kind,'progress')
})
const geminiSays = ws => ws.sent.filter(m => m.realtimeInput?.text).map(m => m.realtimeInput.text)
function geminiAudio(ws, complete = true) {
  ws.serve({serverContent:{modelTurn:{parts:[{inlineData:{data:'AAAAAA=='}}]}, ...(complete ? {turnComplete:true} : {})}})
  for (const c of ledger.contexts) for (const s of c.sources) s.onended?.()
}
test('Gemini cancelled active progress drains a missing completion within the optional deadline', async () => {
  const ws = await start('gemini-live')
  P.onMessageStart(ev({turn_id:'drain'})); advance(75000)
  geminiAudio(ws,false); advance(1000)
  P.onMessageComplete(ev({turn_id:'drain',text:'Ready while progress was open.'}))
  assert.equal(P.call.owner,'muted')
  advance(7000) // 8s since optional speech, no next user turn or turnComplete
  assert.equal(geminiSays(ws).at(-1),'[Say aloud] Ready while progress was open.')
  geminiAudio(ws)
  assert.equal(P.call.turns.filter(t => t.role === 'assistant').at(-1)?.text,'Ready while progress was open.')
})
test('Gemini final after long silent tool wait is audible without next user speech or lost optional turnComplete', async () => {
  const ws = await start('gemini-live')
  P.onMessageStart(ev({turn_id:'long-1'})); advance(75000)
  geminiAudio(ws, false) // audio drains, but optional progress turnComplete never arrives
  advance(45000)
  P.onMessageComplete(ev({turn_id:'long-1',text:'The two minutes have passed.'}))
  advance(1000)
  assert.equal(geminiSays(ws).at(-1),'[Say aloud] The two minutes have passed.')
  geminiAudio(ws)
  assert.equal(P.call.turns.filter(t => t.role === 'assistant').at(-1)?.text,'The two minutes have passed.')
  assert.equal(P.call.held,null)
})
test('Gemini two consecutive long turns recover missing ack completion and each plays progress and final', async () => {
  const ws = await start('gemini-live')
  for (const [id, wait, answer] of [['first',120000,'First finished.'],['second',85000,'Second finished.']]) {
    const before = geminiSays(ws).length
    P.onUserTurn('Please wait a long time before you answer this request',now)
    P.onMessageStart(ev({turn_id:id})); advance(900)
    assert.equal(P.call.lastHanded.kind,'ack')
    geminiAudio(ws, false) // a missing optional completion must not poison this or the next turn
    advance(wait - 900)
    assert.ok(geminiSays(ws).slice(before).some(t => P.PROGRESS_BANK.en.some(e => t === '[Say aloud] '+e.t)))
    P.onMessageComplete(ev({turn_id:id,text:answer})); advance(1000)
    assert.equal(geminiSays(ws).at(-1),'[Say aloud] '+answer)
    geminiAudio(ws)
    assert.equal(P.call.turns.filter(t => t.role === 'assistant').at(-1)?.text,answer)
  }
  for (const [id, answer] of [['third','Settings updated.'],['fourth','Noted.']]) {
    P.onUserTurn('Please check this next request for me',now)
    P.onMessageStart(ev({turn_id:id}))
    P.onMessageComplete(ev({turn_id:id,text:answer})); advance(1000); geminiAudio(ws)
    assert.equal(P.call.turns.filter(t => t.role === 'assistant').at(-1)?.text,answer)
  }
})
test('completed turn cancels a pending first progress deadline', async () => {
  const dc = await start(); P.onMessageStart(ev({turn_id:'a'}))
  advance(74000); P.onMessageComplete(ev({turn_id:'a',text:'NO_REPLY'}))
  advance(240000); assert.equal(says(dc).length,0)
})
