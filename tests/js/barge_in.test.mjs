// Offline Gemini event replay; SDK, audio device and transport are harness doubles.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx, settle } from './harness.mjs'
const sdk = makeSdk()
const P = await loadPlugin(sdk)
let ledger, now
beforeEach(async () => {
  P.tearDown(); await settle()
  const e = makeEnv(); ledger = e.ledger; now = 10000
  P.setEnv({ ...e.env, now: () => now, random: () => 0, log: () => {} })
  sdk.requests.length = 0
  sdk.requestImpl = async () => ({ status: 'streaming' })
  P.call.settings = { interim_guard_ms: 0, transcript_to_chat: 'off' }
})
const ev = payload => ({ session_id: 'sess-1', payload })
const audio = ws => ws.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } })
const done = ws => ws.serve({ serverContent: { turnComplete: true } })
const says = ws => ws.sent.filter(m => m.realtimeInput?.text).map(m => m.realtimeInput.text)
async function reading (withAudio = true) {
  await P.start(makeCtx({ mint: async () => ({ provider: 'gemini-free', brain: 'hermes', url: 'wss://example.invalid', setup: {} }) }))
  const ws = ledger.sockets.at(-1); ws.open(); ws.serve({ setupComplete: {} }); await settle()
  P.onMessageStart(ev({ turn_id: 'old' }))
  P.onMessageDelta(ev({ turn_id: 'old', segment: 0, offset: 0, text: 'First sentence. More of the old reply. ' }))
  if (withAudio) audio(ws)
  assert.equal(says(ws).length, 1)
  return ws
}
test('held reply treats yes as resume even when the full answer ends in a question', async () => {
  const ws = await reading()
  P.onMessageComplete(ev({ turn_id: 'old', text: 'First sentence. More of the old reply. Shall I continue?' }))
  assert.equal(P.call.awaitingAnswer, true)
  ws.serve({ serverContent: { interrupted: true } })
  ws.serve({ serverContent: { inputTranscription: { text: 'כן.' } } })
  P.finalizeUser()
  assert.equal(P.call.held, null)
  assert.equal(sdk.requests.filter(r => r.method === 'prompt.submit').length, 0)
  assert.ok(says(ws).at(-1).startsWith('[Say aloud] First sentence.'))
})

for (const text of ['כן. כן, כן, אתה יכול להמשיך.', 'כן, כן, אתה יכול להמשיך.', 'אוקיי, יאללה, אפשר להמשיך!', 'המשך, תמשיך; continue resume', 'yes, go on, keep going.', 'כֵּן! כֵּן! אתה יכול להמשיך.']) {
  test(`merged backchannels and continue phrases resume as a whole: ${text}`, async () => {
    const ws = await reading()
    ws.serve({ serverContent: { interrupted: true } })
    ws.serve({ serverContent: { inputTranscription: { text } } })
    P.finalizeUser()
    assert.equal(P.call.fragment, null)
    assert.equal(P.call.held, null)
    assert.equal(P.call.dropped.size, 0)
    assert.equal(sdk.requests.filter(r => r.method === 'prompt.submit').length, 0)
    assert.equal(says(ws).at(-1), '[Say aloud] First sentence. More of the old reply.')
  })
}

test('Gemini yes before old turnComplete waits then plays the resumed audio', async () => {
  const ws = await reading()
  const player = ledger.contexts.find(c => c.sampleRate === 24000)
  ws.serve({ voiceActivity: { type: 'ACTIVITY_START' } }) // old owner is muted
  ws.serve({ serverContent: { inputTranscription: { text: 'כן.' } } })
  ws.serve({ voiceActivity: { type: 'ACTIVITY_END' } })
  P.finalizeUser()
  assert.equal(P.call.held, null, 'known yes has resolved the hold')
  assert.equal(says(ws).length, 1, 'do not hand a new reading into the still-muted turn')
  const before = player.sources.length
  audio(ws)
  assert.equal(player.sources.length, before, 'old tail stays muted')
  done(ws)
  assert.equal(says(ws).length, 2)
  audio(ws)
  assert.equal(player.sources.length, before + 1, 'resumed audio is actually played, not swallowed')
})

test('classified backchannel resumes the held reply from the cut sentence', async () => {
  const ws = await reading()
  ws.serve({ serverContent: { interrupted: true } })
  P.onUserTurn('כן', now, true)
  assert.equal(says(ws).at(-1), '[Say aloud] First sentence. More of the old reply.')
})
for (const words of ['Actually use the other date']) {
  test(`interruption permanently drops queued and late old text even for ${JSON.stringify(words)}`, async () => {
    const ws = await reading()
    ws.serve({ serverContent: { interrupted: true } })
    assert.ok(ledger.contexts.find(c => c.sampleRate === 24000).sources.every(s => s.stopped))
    P.onUserTurn(words, now, true)
    P.onMessageComplete(ev({ turn_id: 'old', text: 'First sentence. More of the old reply. Late old tail.' }))
    done(ws)
    now += 10000
    for (const [id, fn] of [...ledger.timers]) { ledger.timers.delete(id); fn() }
    P.flushResults()
    assert.equal(says(ws).length, 1, 'no automatic replay of any old sentence')
    assert.equal(P.call.queue.length, 0)
    P.onMessageStart(ev({ turn_id: 'new' }))
    P.onMessageComplete(ev({ turn_id: 'new', text: 'New answer.' }))
    assert.equal(says(ws).at(-1), '[Say aloud] New answer.')
  })
}
test('late transcript cannot be outrun by HOLD_MS, EOS, or the classifier timer', async () => {
  const ws = await reading()
  ws.serve({ voiceActivity: { type: 'ACTIVITY_START' } })
  ws.serve({ serverContent: { interrupted: true } })
  ws.serve({ voiceActivity: { type: 'ACTIVITY_END' } })
  done(ws)
  now += 10000
  for (const [id, fn] of [...ledger.timers]) { ledger.timers.delete(id); fn() }
  P.flushResults()
  assert.equal(says(ws).length, 1, 'EOS without known words is not an empty classified turn')
  ws.serve({ serverContent: { inputTranscription: { text: 'Actually use the other date' } } })
  P.finalizeUser()
  P.onMessageComplete(ev({ turn_id: 'old', text: 'First sentence. More of the old reply. Late old tail.' }))
  done(ws)
  now += 10000
  P.flushResults()
  assert.equal(says(ws).length, 1)
})
test('interruption without a transcript never times out into replay', async () => {
  const ws = await reading()
  ws.serve({ serverContent: { interrupted: true } })
  done(ws)
  now += 10000
  for (const [id, fn] of [...ledger.timers]) { ledger.timers.delete(id); fn() }
  assert.equal(says(ws).length, 1)
})
test('speech before the first audio frame discards the pending old reading', async () => {
  const ws = await reading(false)
  ws.serve({ serverContent: { inputTranscription: { text: 'Actually use the other date' } } })
  done(ws)
  P.finalizeUser()
  now += 10000
  P.flushResults()
  assert.equal(says(ws).length, 1, 'pending reading is not requeued behind the user turn')
  assert.ok(sdk.requests.some(r => r.method === 'prompt.submit' && r.params.text === 'Actually use the other date'))
})
test('speech over buffered audio after generation ended discards the old reply', async () => {
  const ws = await reading()
  done(ws) // fake audio device still has scheduled playback
  const handedBeforeSpeech = says(ws).length
  ws.serve({ serverContent: { inputTranscription: { text: 'Actually use the other date' } } })
  P.finalizeUser()
  now += 10000
  P.flushResults()
  assert.equal(says(ws).length, handedBeforeSpeech)
})
test('local speech-start mutes late audio and holds before server interruption arrives', async () => {
  const ws = await reading()
  ws.serve({ voiceActivity: { type: 'ACTIVITY_START' } })
  const player = ledger.contexts.find(c => c.sampleRate === 24000)
  const sources = player.sources.length
  audio(ws)
  assert.equal(player.sources.length, sources, 'late audio from the discarded turn stays muted')
  ws.serve({ serverContent: { interrupted: true } })
  done(ws)
  P.finalizeUser()
  now += 10000
  P.flushResults()
  assert.equal(says(ws).length, 1)
})
test('without interruption all remaining sentences are still read', async () => {
  const ws = await reading()
  const player = ledger.contexts.find(c => c.sampleRate === 24000)
  player.sources.forEach(s => s.onended?.())
  done(ws)
  assert.deepEqual(says(ws), ['[Say aloud] First sentence.', '[Say aloud] More of the old reply.'])
})

for (const word of ['כן', 'אוקיי', 'המשך', 'x']) {
  test(`pre-audio interruption holds, then resumes only after known ${word}`, async () => {
    const ws = await reading(false)
    ws.serve({ voiceActivity: { type: 'ACTIVITY_START' } })
    ws.serve({ voiceActivity: { type: 'ACTIVITY_END' } })
    done(ws)
    now += 10000
    for (const [id, fn] of [...ledger.timers]) { ledger.timers.delete(id); fn() }
    assert.equal(says(ws).length, 1)
    assert.ok(P.call.held, 'unknown is held, not discarded')
    assert.equal(P.call.dropped.size, 0)
    ws.serve({ serverContent: { inputTranscription: { text: word } } })
    P.finalizeUser()
    for (const [id, fn] of [...ledger.timers]) { ledger.timers.delete(id); fn() }
    assert.equal(says(ws).at(-1), '[Say aloud] First sentence. More of the old reply.')
    assert.equal(P.call.held, null)
  })
}
test('empty final and cough stay held until a later known resume word', async () => {
  const ws = await reading()
  ws.serve({ voiceActivity: { type: 'ACTIVITY_START' } })
  ws.serve({ serverContent: { interrupted: true, inputTranscription: { text: '', finished: true } } })
  ws.serve({ voiceActivity: { type: 'ACTIVITY_END' } })
  done(ws)
  now += 60000
  for (const [id, fn] of [...ledger.timers]) { ledger.timers.delete(id); fn() }
  P.onUserTurn('', now, true)
  assert.equal(says(ws).length, 1)
  assert.ok(P.call.held)
  ws.serve({ voiceActivity: { type: 'ACTIVITY_START' } })
  ws.serve({ serverContent: { inputTranscription: { text: 'המשך', finished: true } } })
  ws.serve({ voiceActivity: { type: 'ACTIVITY_END' } })
  P.finalizeUser()
  assert.equal(says(ws).length, 2)
})
for (const word of ['עצור', 'stop']) {
  test(`known ${word} clears held and future old text permanently`, async () => {
    const ws = await reading()
    ws.serve({ serverContent: { interrupted: true } })
    P.onUserTurn(word, now)
    P.onMessageComplete(ev({ turn_id: 'old', text: 'First sentence. More of the old reply. Late old tail.' }))
    P.onUserTurn('כן', now)
    done(ws)
    assert.equal(says(ws).length, 1)
    assert.equal(P.call.held, null)
  })
}
test('teardown releases a wordless hold', async () => {
  const ws = await reading()
  ws.serve({ voiceActivity: { type: 'ACTIVITY_START' } })
  assert.ok(P.call.held)
  P.tearDown()
  assert.equal(P.call.held, null)
})

async function rtcReading () {
  await P.start(makeCtx({ mint: async () => ({ provider: 'openai-codex', transport: 'openai-realtime', brain: 'hermes', client_secret: 'test-ephemeral', offer_url: 'https://api.openai.com/v1/realtime/calls' }) }))
  await settle()
  const dc = ledger.peers.at(-1).dc; dc.open()
  P.onMessageStart(ev({ turn_id: 'old' }))
  P.onMessageDelta(ev({ turn_id: 'old', segment: 0, offset: 0, text: 'First sentence. More of the old reply. ' }))
  return dc
}
const rtcSays = dc => dc.sent.filter(x => x.response?.metadata?.d2v === 'say')
const runTimers = () => {
  now += 60000
  for (const [id, fn] of [...ledger.timers]) { ledger.timers.delete(id); fn() }
  P.flushResults()
}
for (const failure of ['failed', 'completed']) {
  test(`OpenAI ${failure} empty does not promote a partial word into resume`, async () => {
    const dc = await rtcReading()
    dc.serve({ type: 'input_audio_buffer.speech_started', item_id: 'u1' })
    dc.serve({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'u1', delta: 'yes' })
    dc.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' })
    P.finalizeUser() // even a fallback/reconnect must not classify an uncompleted partial
    assert.ok(P.call.held)
    dc.serve({ type: `conversation.item.input_audio_transcription.${failure}`, item_id: 'u1', transcript: '' })
    runTimers()
    assert.equal(rtcSays(dc).length, 1)
    assert.ok(P.call.held)
    dc.serve({ type: 'input_audio_buffer.speech_started', item_id: 'u2' })
    dc.serve({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: 'כן' })
    dc.serve({ type: 'response.done', response: { id: 'old-response' } })
    dc.serve({ type: 'output_audio_buffer.cleared' })
    runTimers()
    assert.equal(rtcSays(dc).length, 2)
    assert.equal(rtcSays(dc).at(-1).response.input[0].content[0].text, 'First sentence. More of the old reply.')
  })
}
test('OpenAI late full transcript discards held pre-audio reply and late stream tail', async () => {
  const dc = await rtcReading()
  dc.serve({ type: 'input_audio_buffer.speech_started', item_id: 'u1' })
  dc.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' })
  dc.serve({ type: 'response.done', response: { id: 'old-response' } })
  runTimers()
  assert.equal(rtcSays(dc).length, 1)
  assert.ok(P.call.held)
  dc.serve({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Actually use the other date' })
  P.onMessageComplete(ev({ turn_id: 'old', text: 'First sentence. More of the old reply. Late old tail.' }))
  runTimers()
  assert.equal(P.call.held, null)
  assert.equal(rtcSays(dc).length, 1)
  assert.ok(sdk.requests.some(r => r.method === 'prompt.submit' && r.params.text === 'Actually use the other date'))
})
test('future old stream and final text remain quarantined until known resume', async () => {
  const ws = await reading()
  ws.serve({ voiceActivity: { type: 'ACTIVITY_START' } })
  P.onMessageComplete(ev({ turn_id: 'old', text: 'First sentence. More of the old reply. Late old tail.' }))
  done(ws)
  runTimers()
  assert.equal(says(ws).length, 1)
  assert.ok(P.call.held)
  assert.equal(P.call.queue.length, 0)
  ws.serve({ serverContent: { inputTranscription: { text: 'כן' } } })
  P.finalizeUser()
  assert.equal(says(ws).at(-1), '[Say aloud] First sentence. More of the old reply. Late old tail.')
})

for (const text of ['כן, תבדוק את מזג האוויר', 'כן, אתה יכול להמשיך אבל תשלח הודעה', 'go on and search for it', 'keep going tomorrow', 'אפשר להמשיך לפרויקט אחר']) {
  test(`resume prefix never swallows genuine content: ${text}`, async () => {
    const ws = await reading()
    ws.serve({ serverContent: { interrupted: true } })
    P.onUserTurn(text, now, true)
    assert.equal(P.call.held, null)
    assert.equal(P.call.dropped.size, 1)
    assert.ok(sdk.requests.some(r => r.method === 'prompt.submit' && r.params.text === text))
    assert.equal(says(ws).length, 1)
  })
}
for (const text of ['כן כן כן', 'אוקיי', 'יאללה', 'המשך', 'תמשיך', 'אתה יכול להמשיך', 'אפשר להמשיך', 'go on', 'continue', 'keep going']) {
  test(`standalone held resume stays instant: ${text}`, async () => {
    const ws = await reading()
    ws.serve({ serverContent: { interrupted: true } })
    assert.equal(P.onUserTurn(text, now).kind, 'ack')
    assert.equal(P.call.fragment, null)
    assert.equal(says(ws).length, 2)
  })
}
test('fragmented late transcription concatenation still covers every resume word', async () => {
  const ws = await reading()
  ws.serve({ serverContent: { interrupted: true } })
  for (const text of ['כן.', ' כן, כן, ', 'אתה יכול ', 'להמשיך.']) {
    ws.serve({ serverContent: { inputTranscription: { text } } })
  }
  P.finalizeUser()
  assert.equal(P.call.held, null)
  assert.equal(says(ws).length, 2)
  assert.equal(sdk.requests.filter(r => r.method === 'prompt.submit').length, 0)
})
test('outside a hold yes still answers a question and continue stays a request', async () => {
  await reading()
  P.call.awaitingAnswer = true
  assert.equal(P.onUserTurn('כן.', now).kind, 'substantive')
  P.onUserTurn('אתה יכול להמשיך.', now)
  assert.deepEqual(sdk.requests.filter(r => r.method === 'prompt.submit').map(r => r.params.text), ['כן.', 'אתה יכול להמשיך.'])
})
test('Mike then bye Mike never delegate a name; only hang-up transcript is submitted', async () => {
  const ws = await reading()
  Object.assign(P.call.settings, { persona_name: 'Mike', persona_name_he: 'מייק', transcript_to_chat: 'chat_turn' })
  ws.serve({ serverContent: { interrupted: true } })
  ws.serve({ serverContent: { inputTranscription: { text: 'מייק' } } })
  P.finalizeUser()
  assert.equal(P.call.lastTurn.kind, 'empty')
  assert.equal(sdk.requests.filter(r => r.method === 'prompt.submit').length, 0)
  ws.serve({ serverContent: { inputTranscription: { text: 'ביי מייק.' } } })
  P.finalizeUser()
  assert.equal(P.call.lastTurn.kind, 'bye')
  assert.equal(P.call.held, null)
  assert.equal(sdk.requests.filter(r => r.method === 'prompt.submit').length, 0)
  audio(ws) // the local goodbye owns a model turn only after its first output
  done(ws)
  await settle()
  const submitted = sdk.requests.filter(r => r.method === 'prompt.submit')
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].params.queued, true)
  assert.ok(submitted[0].params.text.startsWith(P.TRANSCRIPT_HEADER))
  assert.match(submitted[0].params.text, /User: מייק/)
  assert.match(submitted[0].params.text, /User: ביי מייק/)
  assert.ok(!submitted[0].params.text.includes('Your request was not processed'))
})
test('OpenAI completed repeated continue resumes rather than delegating', async () => {
  const dc = await rtcReading()
  dc.serve({ type: 'input_audio_buffer.speech_started', item_id: 'u1' })
  dc.serve({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'כן, כן, אתה יכול להמשיך.' })
  dc.serve({ type: 'response.done', response: { id: 'old-response' } })
  dc.serve({ type: 'output_audio_buffer.cleared' })
  runTimers()
  assert.equal(P.call.held, null)
  assert.equal(rtcSays(dc).length, 2)
  assert.equal(sdk.requests.filter(r => r.method === 'prompt.submit').length, 0)
})
