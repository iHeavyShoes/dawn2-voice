// gemini-live-chat — full-duplex live voice in the Hermes Desktop composer, on a provider chain:
// Gemini Live (free key) -> OpenAI Realtime on the ChatGPT/Codex sign-in -> Gemini Live (paid key).
//
// Uncompiled ESM, one file: the loader resolves only @hermes/plugin-sdk and react, so every element
// goes through createElement. No credential ever reaches this window: the backend half
// (dashboard/plugin_api.py) walks the chain and mints a short-lived session on the first provider
// that can serve (a single-use Gemini token whose setup is locked server-side, or an OpenAI
// ephemeral client secret Hermes core signed for). This file opens that provider's transport (a
// WebSocket for Gemini, WebRTC for OpenAI); everything above the transport is shared (see
// TRANSPORTS). When the serving provider fails mid-call, `failover` reconnects the same call to the
// next provider with the recent spoken turns as context.
//
// Delegation (the point of this plugin): the voice model has one work tool, `hermes_task`. Each call
// becomes a normal `prompt.submit` on the chat that was open when the call started, with
// surface 'voice-live' and the recent spoken turns as `voice_context` — the same seam Hermes core's
// GPT-Live uses. The request and Hermes' answer are therefore ordinary rows in that chat. The turn's
// `message.complete` text goes back to the voice as a "[Hermes result]" text input it says aloud:
// the whole reply, made speakable (no markdown, code or URLs) and cut into parts the voice reads one
// model turn at a time, so a long answer is spoken in full instead of being summarised away.
//
// Structure adapted from hermes-xai's voice module (MIT, Julien Talbot); Gemini Live wire facts from
// hermes-gemini-live (MIT, Ha Trung). See README "Credits".
import { host, icons, Popover, PopoverContent, PopoverTrigger } from '@hermes/plugin-sdk'
import { createElement as h, useEffect, useState } from 'react'

export const PLUGIN_ID = 'gemini-live-chat'
export const IN_RATE = 16000 // Gemini Live input: 16 kHz PCM16 mono
export const OUT_RATE = 24000 // Gemini Live output: 24 kHz PCM16 mono
const IN_MIME = 'audio/pcm;rate=16000'
export const CONTEXT_TURNS = 12
export const PART_CHARS = 1200 // ~1 minute of speech per part; one part per model turn
export const MAX_PARTS = 8 // ~10 minutes; anything longer is left in the chat, and the voice says so
export const REST_IN_CHAT = '[The rest of this answer is only in the chat.]'
const HANGUP_GRACE_MS = 2500
const STALL_MS = 4000 // an open model turn with no audio for this long no longer holds results back
const AWAIT_MS = 8000 // a handed part that gets no answer this long no longer holds the next one back
const USER_QUIET_MS = 1200 // nothing is handed over while the user was heard this recently
const FLUSH_RETRY_MS = 1000
export const RESULT_TAG = '[Hermes result]'
// The function call is answered at once (NON_BLOCKING) so the model keeps talking; the real result
// follows as a "[Hermes result]" text input, from this turn or any later one on the pinned chat.
// v0.3: the receipt forbids any content of the voice's own while the request is open (it told its
// own joke while Hermes wrote a different one) and asks for a present-tense acknowledgement only.
export const RECEIPT = 'WORK_STARTED: the whole request is in the open chat and is being worked on. Acknowledge it once, in a few words and in the present tense (for example "I\'m checking"). Do not answer any part of it yourself: no joke, explanation, fact, guess or opinion of your own; the user must hear the answer from the chat. Do not repeat that you are waiting. The answer arrives as a "[Hermes result]" message, possibly after a minute or more; speak it in full then.'
// Hermes' intentional-silence sentinels (gateway/response_filters.py LIVE_GATEWAY_SILENT_MARKERS,
// the autonomous-lane rule): a reply that is one of these, or has one as its own first or last line,
// or opens with a bracketed one, is not for the user and is never handed to the voice.
export const SILENT_MARKERS = ['[SILENT]', 'SILENT', 'NO_REPLY', 'NO REPLY', '[静默]', '静默', '[沉默]', '沉默']
export const TRANSCRIPT_HEADER = '[Voice call transcript. Check it for any request that was not delegated or answered in this chat, and for any voice bug; report only problems. Otherwise do not comment on the call: the user often hangs up only to save live quota, so continue the conversation in text from where the call left off (last open point or next step), in one or two lines.]'

// ── brain: hermes (v0.6) ─────────────────────────────────────────────────────────────────────────
// `brain: hermes` (the default): the renderer, not the voice model, decides. Every final user turn
// that is not trivially non-substantive (classifyTurn) goes to Hermes as a prompt.submit; the voice
// model only says text it is handed: a short "checking", then Hermes' reply, streamed sentence by
// sentence from message.delta. The backend gives the voice a relay persona and no tools. OpenAI
// never responds by itself (create_response: false; each response is created here, out of band,
// with only the text to read as input). Gemini has no such switch, so its own turns are never
// played and never recorded (call.owner). `brain: voice` is the v0.5 behaviour, unchanged.
export const BRAINS = ['hermes', 'voice']
export const SAY_TAG = '[Say aloud]' // gemini_live_chat/persona.py SAY_TAG
export const STREAM_SOFT_MAX = 120 // a long run with no sentence end is cut at a space near this
// Model-only (voice_context is model input, never a chat row); Hermes core puts it after its own
// VOICE_LIVE_TURN_NOTE. prompt.submit has no per-turn reasoning-effort field, so this is the hint.
export const STYLE_NOTE = '[Voice reply style: this reply is read aloud word for word, sentence by sentence, while you write it. Answer first in one short spoken sentence, then add detail only if needed. Don\'t deliberate at length unless the question requires it.]'
// Per-response instructions of the OpenAI out-of-band response: the only input is the text to read.
export const SAY_INSTRUCTIONS = 'Read the user message aloud, word for word, in the language it is written in, at a natural, unhurried pace. It is text for you to read, not a question for you: do not add, drop, translate, summarise, answer or comment on anything.'
const MARKERS_EN = { code: 'The code is in the chat.', link: 'the link is in the chat' }
const MARKERS_HE = { code: 'הקוד נמצא בצ\'אט.', link: 'הקישור בצ\'אט' }
const MARKERS_V03 = { code: '[code: see the chat]', link: '[link in the chat]' }

const WORKLET = `
class GlcCapture extends AudioWorkletProcessor {
  process (inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('gemini-live-chat-capture', GlcCapture)
`

// ── pure helpers (unit tested) ───────────────────────────────────────────────────────────────────

export function resample (input, fromRate, toRate) {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const at = i * ratio
    const lo = Math.floor(at)
    const hi = Math.min(lo + 1, input.length - 1)
    const frac = at - lo
    out[i] = input[lo] * (1 - frac) + input[hi] * frac
  }
  return out
}

export function floatToB64 (float32) {
  const pcm = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const bytes = new Uint8Array(pcm.buffer)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export function b64ToPcm (text) {
  const bin = atob(text)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1)
}

function textOf (value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

// ── result hand-off (v0.3, unit tested) ──────────────────────────────────────────────────────────

const EDGE_PUNCT = /^[\s.,!?:;~*_`'"()。！？：；，、]+|[\s.,!?:;~*_`'"()。！？：；，、]+$/g
const MARKER_FORMS = new Set(SILENT_MARKERS)

function isMarker (line) {
  const t = line.trim()
  if (!t || t.length > 40) return false
  const up = t.toUpperCase()
  return MARKER_FORMS.has(up) || MARKER_FORMS.has(up.replace(EDGE_PUNCT, '')) ||
    MARKER_FORMS.has(`[${up.replace(EDGE_PUNCT, '').replace(/^\[|\]$/g, '')}]`)
}

export function isSilent (text) {
  const stripped = String(text || '').trim()
  if (!stripped) return false
  const upper = stripped.toUpperCase()
  if (SILENT_MARKERS.some(m => m.startsWith('[') && upper.startsWith(m))) return true
  const lines = stripped.split('\n').filter(l => l.trim())
  return [stripped, lines[0], lines[lines.length - 1]].some(isMarker)
}

// Markdown to plain speakable text. Content is kept; only formatting goes. Code and URLs are not
// read out character by character: a short marker tells the voice they are in the chat.
export function speakable (text, markers = MARKERS_V03) {
  let t = String(text || '').replace(/\r\n?/g, '\n')
  t = t.replace(/```[\s\S]*?(```|$)/g, `\n${markers.code}\n`)
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')
  t = t.replace(/<?https?:\/\/[^\s>)]+>?/g, markers.link)
  t = t.replace(/`([^`\n]+)`/g, '$1')
  const lines = []
  for (let line of t.split('\n')) {
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue // table rule
    if (/^\s*([-*_]\s*){3,}$/.test(line)) continue // horizontal rule
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean).join(', ')
    line = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>\s?/, '').replace(/^\s*[-*+•]\s+(\[[ xX]\]\s+)?/, '')
    line = line.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|[\s(])[*_]([^*_\n]+?)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    lines.push(line.trim())
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function splitLong (piece, size) {
  const out = []
  let cur = ''
  for (const s of piece.split(/(?<=[.!?。…])\s+/)) {
    if (s.length > size) { // one huge sentence: cut at spaces
      if (cur) { out.push(cur); cur = '' }
      let rest = s
      while (rest.length > size) {
        let at = rest.lastIndexOf(' ', size)
        if (at < size / 2) at = size
        out.push(rest.slice(0, at).trim())
        rest = rest.slice(at).trim()
      }
      cur = rest
    } else if (cur && cur.length + 1 + s.length > size) {
      out.push(cur)
      cur = s
    } else cur = cur ? `${cur} ${s}` : s
  }
  if (cur) out.push(cur)
  return out
}

// Parts of at most `size` characters, cut at paragraph, then sentence, then word boundaries.
// Nothing is dropped: the parts together hold every word of the text, in order.
export function splitParts (text, size = PART_CHARS) {
  const parts = []
  let cur = ''
  for (const para of String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)) {
    for (const piece of (para.length > size ? splitLong(para, size) : [para])) {
      if (cur && cur.length + 2 + piece.length > size) {
        parts.push(cur)
        cur = piece
      } else cur = cur ? `${cur}\n\n${piece}` : piece
    }
  }
  if (cur) parts.push(cur)
  return parts
}

// The realtimeInput.text messages for one Hermes reply: none for a silent reply, one
// "[Hermes result] ..." for a short one, "[Hermes result k/n] ..." parts for a long one.
export function resultMessages (text) {
  if (isSilent(text)) return []
  const body = speakable(text)
  if (!body || isSilent(body)) return []
  let parts = splitParts(body)
  if (parts.length > MAX_PARTS) {
    parts = parts.slice(0, MAX_PARTS)
    parts[MAX_PARTS - 1] += `\n\n${REST_IN_CHAT}`
  }
  if (parts.length === 1) return [`${RESULT_TAG} ${parts[0]}`]
  return parts.map((p, i) => `[Hermes result ${i + 1}/${parts.length}] ${p}`)
}

export function formatTranscript (turns) {
  return turns.map(t => `${t.role === 'user' ? 'User' : 'Voice'}: ${t.text}`).join('\n')
}

// ── brain: hermes — pure helpers (unit tested) ───────────────────────────────────────────────────

const norm = s => String(s || '').replace(/\s+/g, ' ').trim()

// 'he' when the text has at least as many Hebrew letters as Latin ones, 'en' for Latin, else null.
export function langOf (text) {
  const t = String(text || '')
  const he = (t.match(/[\u05D0-\u05EA]/g) || []).length
  const lat = (t.match(/[A-Za-z]/g) || []).length
  if (he && he >= lat) return 'he'
  return lat ? 'en' : null
}

// Hermes' markdown as words to read verbatim, with the code/link notes in the reply's language.
// v0.8: a leading speaker label ("ריי: ", "**Ray:**") is never read aloud.
export function sayText (text, names) {
  const t = stripSpeakerLabels(text, names)
  return speakable(t, langOf(t) === 'he' ? MARKERS_HE : MARKERS_EN)
}

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const DEFAULT_LABEL_NAMES = ['hermes', 'הרמס', 'assistant']
function labelNames (names) {
  const out = new Set()
  for (const n of [...(names || []), ...DEFAULT_LABEL_NAMES].filter(Boolean)) {
    const k = String(n).trim()
    if (!k) continue
    out.add(k)
    if (k.includes('יי')) out.add(k.replace(/יי/g, 'י')) // the transcript spells ריי also רי
  }
  return [...out].sort((a, b) => b.length - a.length)
}
function labelRe (names) {
  const alt = labelNames(names).map(escapeRe).join('|')
  // At a line start: optional markdown emphasis, the name, optional emphasis, a colon (":" or "：").
  return new RegExp(`^([ \\t>]*)(?:[*_]{1,2})?(?:${alt})(?:[*_]{1,2})?\\s*[:：](?:[*_]{1,2})?[ \\t]*`, 'gimu')
}

// v0.8: "ריי: כן, זה אפשרי" -> "כן, זה אפשרי". Only a label at the start of a line, and only the
// persona's names (he/en) or Hermes: a colon later in a sentence ("השעה: 10") stays.
export function stripSpeakerLabels (text, names) {
  return String(text || '').replace(labelRe(names), '$1')
}

// A piece that is nothing but the persona's name ("ריי", "Ray.") is a dangling label, not words.
export function isLabelOnly (piece, names) {
  const t = String(piece || '').replace(/[\s*_.,:：!?…-]+/g, ' ').trim().toLowerCase()
  return !!t && labelNames(names).some(n => n.toLowerCase() === t)
}

// The turn classifier: small, local, rule based, Hebrew and English. A turn is trivially
// non-substantive only when ALL of its words are covered by these phrases (fillers, "please" and
// the persona's name are ignored), or when it is a single word with no question and no request
// verb. Everything else is substantive and goes to Hermes. A yes/no or ack right after Hermes
// asked a question is an answer, so it is substantive too (`awaiting`).
const PHRASES = {
  greeting: ['hi', 'hello', 'hey', 'hey there', 'hiya', 'yo', 'good morning', 'good afternoon', 'good evening',
    'how are you', 'how are you doing', 'how is it going', 'hows it going', 'whats up', 'sup',
    'היי', 'הי', 'הלו', 'שלום', 'אהלן', 'אהלן וסהלן', 'בוקר טוב', 'צהריים טובים', 'צהרים טובים', 'ערב טוב',
    'מה נשמע', 'מה קורה', 'מה שלומך', 'מה המצב', 'מה העניינים', 'מה איתך', 'מה הולך'],
  ack: ['ok', 'okay', 'k', 'kay', 'alright', 'all right', 'yes', 'yeah', 'yep', 'yup', 'sure', 'right', 'correct',
    'exactly', 'got it', 'i see', 'understood', 'cool', 'nice', 'great', 'awesome', 'perfect', 'good', 'very good',
    'fine', 'thanks', 'thank you', 'thank you very much', 'thanks a lot', 'mhm', 'mm', 'uhhuh', 'oh', 'wow', 'no',
    'nope', 'no thanks', 'makes sense', 'sounds good', 'interesting', 'lovely', 'ah', 'aha',
    'אוקיי', 'אוקי', 'אוקה', 'בסדר', 'בסדר גמור', 'כן', 'יופי', 'יופי טופי', 'מגניב', 'תודה', 'תודה רבה',
    'סבבה', 'אחלה', 'נכון', 'הבנתי', 'ברור', 'וואו', 'וואלה', 'אהה', 'אהא', 'מעולה', 'נהדר', 'טוב',
    'טוב מאוד', 'יפה', 'יפה מאוד', 'מצוין', 'מצויין', 'לא', 'לא תודה', 'הגיוני', 'מעניין', 'נשמע טוב',
    'אש', 'יאללה', 'קיבלתי', 'אמממ', 'נו', 'וואי'],
  repeat: ['repeat', 'repeat that', 'say that again', 'say again', 'again', 'one more time', 'come again',
    'pardon', 'what did you say', 'i didnt catch that', 'i didnt hear', 'i didnt hear that', 'what', 'huh',
    'sorry what', 'תחזור', 'תחזור על זה', 'תחזור שוב', 'חזור', 'חזור על זה', 'שוב', 'עוד פעם', 'עוד הפעם',
    'מה אמרת', 'לא שמעתי', 'מה', 'הא', 'סליחה מה', 'תגיד שוב', 'תגיד עוד פעם'],
  stop: ['stop', 'stop it', 'stop talking', 'enough', 'quiet', 'be quiet', 'shh', 'shush', 'hush', 'hold on',
    'wait', 'wait a second', 'one second', 'pause', 'silence',
    'עצור', 'תעצור', 'די', 'די כבר', 'מספיק', 'שקט', 'תפסיק', 'הפסק', 'רגע', 'רק רגע', 'שנייה', 'שניה',
    'חכה', 'שתוק', 'תשתוק'],
  bye: ['bye', 'bye bye', 'goodbye', 'good bye', 'good night', 'see you', 'see you later', 'talk later',
    'talk to you later', 'later', 'hang up', 'end call', 'end the call', 'thats all', 'thats it for now',
    'ביי', 'ביי ביי', 'להתראות', 'לילה טוב', 'נדבר', 'נדבר אחר כך', 'נדבר אחכ', 'תנתק', 'נתק',
    'סיים שיחה', 'סיים את השיחה', 'תסיים שיחה', 'תסיים את השיחה', 'זהו להיום', 'זהו זה', 'יאללה ביי']
}
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'hmm', 'hm', 'er', 'erm', 'please', 'אממ', 'אמ', 'אהמ', 'אההה', 'אה', 'בבקשה', 'hermes', 'הרמס'])
const REQUEST_WORDS = new Set(['check', 'continue', 'explain', 'summarize', 'summarise', 'search', 'find', 'open',
  'run', 'send', 'remind', 'read', 'write', 'show', 'tell', 'translate', 'fix', 'schedule', 'play', 'go', 'next',
  'בדוק', 'המשך', 'הסבר', 'סכם', 'חפש', 'פתח', 'הרץ', 'שלח', 'קרא', 'כתוב', 'ספר', 'תרגם', 'תקן', 'נגן', 'הבא'])
const QUESTION_WORDS = new Set(['what', 'who', 'how', 'why', 'when', 'where', 'which', 'can', 'could', 'should',
  'would', 'is', 'are', 'do', 'does', 'did', 'will', 'מה', 'מי', 'איך', 'למה', 'מתי', 'איפה', 'כמה', 'האם',
  'איזה', 'איזו', 'אילו', 'מדוע', 'היכן', 'לאן', 'מאיפה'])
const PHRASE_INDEX = (() => {
  const map = new Map() // first word -> [{ words, kind }], longest first
  for (const [kind, list] of Object.entries(PHRASES)) {
    for (const p of list) {
      const words = p.split(' ')
      if (!map.has(words[0])) map.set(words[0], [])
      map.get(words[0]).push({ words, kind })
    }
  }
  for (const list of map.values()) list.sort((a, b) => b.words.length - a.words.length)
  return map
})()
const KIND_ORDER = ['bye', 'stop', 'repeat', 'greeting', 'ack']

function tokens (text) {
  const t = String(text || '').toLowerCase()
    .replace(/[\u0591-\u05C7]/g, '') // niqqud and cantillation
    .replace(/['’`׳"״]/g, '') // what's -> whats, צ'יפס -> ציפס
    .replace(/\b(uh|mm)[\s-]*(huh|hm+)\b/g, 'uhhuh') // a backchannel, not "uh" + "huh?"
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  return t.split(/\s+/).filter(Boolean)
}

function words (text, names) {
  return tokens(text).filter(w => !FILLERS.has(w) && !names.has(w))
}

// Persona names as the transcript may spell them: "ריי" also as "רי".
const nameSet = names => {
  const out = new Set()
  for (const n of (names || []).filter(Boolean)) {
    const k = String(n).toLowerCase().replace(/['’`׳"״]/g, '')
    out.add(k)
    if (k.includes('יי')) out.add(k.replace(/יי/g, 'י'))
  }
  return out
}

// v0.7: the spoken end-call command. A turn hangs up only when it is a "bye" turn AS A WHOLE (every
// word is a goodbye, thanks or the persona's name: classifyTurn) AND it contains one of these
// explicit phrases. So "ביי ריי", "סיים שיחה", "Bye Ray" and "end call" hang up, while a bare "ביי",
// "ביי ביי" or "תודה ביי" does not, and neither does a sentence that only contains one ("תגיד לו ביי
// ריי", "don't end the call": not a bye turn as a whole). <name> is each persona name, he and en.
const END_PHRASES = ['end call', 'end the call', 'hang up', 'סיים שיחה', 'תסיים שיחה', 'סיים את השיחה',
  'תסיים את השיחה', 'תנתק', 'נתק']
const END_BY_NAME = ['bye', 'goodbye', 'good bye', 'bye bye', 'ביי', 'ביי ביי']
export function isEndCall (text, opts = {}) {
  const names = nameSet(opts.names)
  if (classifyTurn(text, opts).kind !== 'bye') return false
  const ws = tokens(text).filter(w => !FILLERS.has(w) || names.has(w)).map(w => (w.length > 2 && w.startsWith('ו') && !names.has(w) ? w.slice(1) : w))
  const phrases = END_PHRASES.map(p => p.split(' '))
  for (const n of names) for (const b of END_BY_NAME) phrases.push([...b.split(' '), n])
  return phrases.some(p => ws.some((_, i) => p.every((w, k) => ws[i + k] === w)))
}

// Every word covered by phrases (longest match first; a Hebrew "ו" prefix is allowed)?
function cover (ws) {
  const kinds = new Set()
  let i = 0
  while (i < ws.length) {
    let hit = null
    for (const w0 of [ws[i], ws[i].startsWith('ו') && ws[i].length > 2 ? ws[i].slice(1) : null]) {
      if (!w0) continue
      for (const cand of PHRASE_INDEX.get(w0) || []) {
        const n = cand.words.length
        if (cand.words.every((w, k) => (k === 0 ? w0 : ws[i + k]) === w)) { hit = cand; break }
        if (n === 1 && cand.words[0] === w0) { hit = cand; break }
      }
      if (hit) break
    }
    if (!hit) return null
    kinds.add(hit.kind)
    i += hit.words.length
  }
  return kinds
}

// -> { kind, lang, words }. kind: empty | greeting | ack | repeat | stop | bye | short | substantive.
export function classifyTurn (text, opts = {}) {
  const names = nameSet(opts.names)
  const raw = String(text || '')
  const ws = words(raw, names)
  const lang = langOf(raw)
  const question = /[?？]/.test(raw) || (ws.length > 0 && QUESTION_WORDS.has(ws[0]) && ws.length > 1)
  let kind
  if (!ws.length) kind = 'empty'
  else {
    const kinds = cover(ws)
    if (kinds) kind = KIND_ORDER.find(k => kinds.has(k))
    else if (ws.length === 1 && !/[?？]/.test(raw) && !REQUEST_WORDS.has(ws[0]) && !QUESTION_WORDS.has(ws[0]) &&
      !(/^ת[\u05D0-\u05EA]{3,}$/.test(ws[0]))) kind = 'short' // תבדוק, תמשיך, תסביר...: a request
    else kind = 'substantive'
  }
  // An answer to Hermes' own question ("should I send it?" -> "yes") must reach Hermes.
  if (opts.awaiting && (kind === 'ack' || kind === 'short')) kind = 'substantive'
  return { kind, lang, question, words: ws.length }
}
export const SUBSTANTIVE = 'substantive'

// Cut text into pieces to speak: at a sentence end followed by whitespace, at a line break, or, for
// a long run with no sentence end, at the last space before `max` characters. Decisions only use
// text up to `max + 1` characters ahead, so cutting a growing prefix yields the same leading pieces
// as cutting the whole text (streaming and the final reconciliation agree). Not final: the
// unfinished tail is held back (`rest`).
const END_CHARS = '.!?…。！？'
const CLOSERS = '.!?…"\'”’)]»'
export function cutPieces (text, final, max = STREAM_SOFT_MAX) {
  const s = String(text || '')
  const n = s.length
  const pieces = []
  let i = 0
  for (;;) {
    while (i < n && /\s/.test(s[i])) i++
    if (i >= n) break
    let cut = -1
    let wait = false
    const lim = Math.min(n, i + max)
    for (let j = i; j < lim; j++) {
      const c = s[j]
      if (c === '\n') { cut = j; break }
      if (END_CHARS.includes(c)) {
        let k = j + 1
        while (k < n && CLOSERS.includes(s[k])) k++
        if (k >= n) { if (final) cut = n; else wait = true; break }
        if (/\s/.test(s[k])) { cut = k; break }
        j = k - 1
      }
    }
    if (wait) break
    if (cut < 0) {
      if (n - i > max) {
        let at = s.lastIndexOf(' ', i + max)
        if (at <= i + max / 2) at = i + max
        cut = at
      } else if (final) cut = n
      else break
    }
    const piece = s.slice(i, cut).trim()
    if (piece) pieces.push(piece)
    i = cut
  }
  return { pieces, rest: s.slice(i) }
}

// The pieces not yet spoken: those after the longest leading run whose words are already in
// `spoken` (normalised). A piece that differs is spoken whole: nothing is skipped; at worst a
// fragment is repeated when Hermes' final text differs from what it streamed.
export function freshPieces (pieces, spoken) {
  const done = norm(spoken)
  let acc = ''
  let i = 0
  for (; i < pieces.length; i++) {
    const next = acc ? `${acc} ${norm(pieces[i])}` : norm(pieces[i])
    if (done.startsWith(next) && (done.length === next.length || done[next.length] === ' ')) acc = next
    else break
  }
  return pieces.slice(i)
}

// ── injectable environment (tests replace it) ────────────────────────────────────────────────────

const defaultEnv = () => ({
  WebSocket: globalThis.WebSocket,
  AudioContext: globalThis.AudioContext,
  AudioWorkletNode: globalThis.AudioWorkletNode,
  RTCPeerConnection: globalThis.RTCPeerConnection,
  fetch: (...a) => globalThis.fetch(...a),
  createAudio: () => new globalThis.Audio(),
  getUserMedia: c => globalThis.navigator.mediaDevices.getUserMedia(c),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: id => globalThis.clearTimeout(id),
  now: () => Date.now(),
  random: () => Math.random(), // v0.8: the ack picker (tests make it deterministic)
  // v0.5: the spoken notice when the chosen provider fails (its own voice is gone by then): the
  // browser's local speech synthesis, nothing leaves the machine. False when unavailable.
  speak: (text, lang) => {
    const synth = globalThis.speechSynthesis
    const Utterance = globalThis.SpeechSynthesisUtterance
    if (!synth || !Utterance) return false
    try {
      const u = new Utterance(text)
      u.lang = lang
      const voice = synth.getVoices().find(v => String(v.lang || '').toLowerCase().startsWith(lang.slice(0, 2)))
      if (voice) u.voice = voice
      synth.cancel()
      synth.speak(u)
      return true
    } catch { return false }
  },
  hasVoice: prefix => {
    try { return (globalThis.speechSynthesis ? globalThis.speechSynthesis.getVoices() : []).some(v => String(v.lang || '').toLowerCase().startsWith(prefix)) } catch { return false }
  },
  // v0.6: the per-turn latency line (numbers only) in the renderer console; the backend logs it too.
  log: (...a) => { try { globalThis.console.info(...a) } catch { /* no console */ } },
  // v0.7: the Hermes Desktop app (Electron) as opposed to the webapp in a phone/desktop browser.
  isDesktopApp: () => /\bElectron\//.test(String((globalThis.navigator && globalThis.navigator.userAgent) || ''))
})
let env = null
const E = () => env || (env = defaultEnv())
export function setEnv (overrides) { env = { ...defaultEnv(), ...overrides } }
export const __env = () => E() // tests: extend the current env

const MIC_CONSTRAINTS = { audio: { channelCount: 1, autoGainControl: true, echoCancellation: true, noiseSuppression: true } }

// ── audio (Gemini transport: PCM over the socket) ────────────────────────────────────────────────

async function startMic (onFrame, isLive) {
  await micReleased()
  if (!isLive()) return null
  const stream = await E().getUserMedia(MIC_CONSTRAINTS)
  if (!isLive()) { // the call was stopped while the permission prompt was open
    stream.getTracks().forEach(t => t.stop())
    return null
  }
  // The device rate is kept (Firefox refuses a source/context rate mismatch); frames are resampled.
  const context = new (E().AudioContext)()
  let node = null
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    try { await context.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }
    node = new (E().AudioWorkletNode)(context, 'gemini-live-chat-capture')
  } catch (error) {
    stream.getTracks().forEach(t => t.stop())
    void context.close().catch(() => {})
    throw error
  }
  const rate = context.sampleRate
  let pending = []
  let size = 0
  node.port.onmessage = ({ data }) => {
    pending.push(data)
    size += data.length
    if (size < rate / 10) return // ~100 ms per chunk
    const frame = new Float32Array(size)
    let at = 0
    for (const part of pending) { frame.set(part, at); at += part.length }
    pending = []
    size = 0
    onFrame(resample(frame, rate, IN_RATE))
  }
  const source = context.createMediaStreamSource(stream)
  source.connect(node)
  void context.resume?.()
  return () => {
    node.port.onmessage = null
    try { source.disconnect() } catch { /* gone */ }
    try { node.disconnect() } catch { /* gone */ }
    stream.getTracks().forEach(t => t.stop())
    void context.close().catch(() => {})
  }
}

function createPlayer () {
  const context = new (E().AudioContext)({ sampleRate: OUT_RATE })
  let next = 0
  const live = new Set()
  void context.resume?.()
  return {
    play (pcm) {
      const buffer = context.createBuffer(1, pcm.length, OUT_RATE)
      const ch = buffer.getChannelData(0)
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000
      const node = context.createBufferSource()
      node.buffer = buffer
      node.connect(context.destination)
      next = Math.max(next, context.currentTime)
      node.start(next)
      next += buffer.duration
      live.add(node)
      node.onended = () => live.delete(node)
    },
    playing () { return live.size > 0 },
    flush () {
      live.forEach(n => { try { n.stop() } catch { /* already ended */ } })
      live.clear()
      next = 0
    },
    close () { this.flush(); void context.close().catch(() => {}) }
  }
}

// ── providers and fallback (v0.4) ────────────────────────────────────────────────────────────────

export const PROVIDER_LABELS = {
  'gemini-free': 'Gemini (free key)',
  'openai-codex': 'ChatGPT (Codex subscription)',
  'gemini-paid': 'Gemini (paid key)'
}
export const MAX_SWITCHES = 3 // per call: at most once through the whole default chain
export const COOLDOWN_MS = 15 * 60 * 1000 // a provider that refused for quota/auth is skipped this long
// Handed to the new voice right after a mid-call switch (ahead of any queued result).
export const SWITCH_NOTE = '[Voice provider switched] The call just moved to another voice provider because the previous one failed. Tell the user so in one short sentence in their language (for example "switching voice provider"), then continue where the conversation was. Do not greet again.'
const OPENAI_ORIGIN = 'https://api.openai.com/'
const cooldown = new Map() // provider id -> until (ms)
export function cooledProviders () {
  const now = E().now()
  for (const [id, until] of cooldown) if (until <= now) cooldown.delete(id)
  return [...cooldown.keys()]
}
export function resetCooldown () { cooldown.clear() }

// Refusals that cool a provider down for later calls, and that the backend remembers for the picker.
const REFUSALS = ['quota', 'billing', 'auth']
// The backend's REASONS wording (gemini_live_chat/providers.py _REASON_TEXT).
export const REASON_TEXT = {
  no_key: 'no key', not_signed_in: 'not signed in', unsupported: 'this Hermes is too old',
  quota: 'quota or rate limit', billing: 'no credit / billing', auth: 'credential refused',
  unavailable: 'service unavailable', unreachable: 'unreachable', rejected: 'request refused',
  excluded: 'skipped on this call', network: 'connection lost', expired: 'session expired'
}
export const unavailableText = (id, reason) => `${id} unavailable: ${REASON_TEXT[reason] || reason || 'failed'}`
// A paid Gemini key on a Prepay account with no credit: HTTP 402 Payment Required (Google AI
// Studio billing docs), or a billing/credit text inside a 400/403/429 RESOURCE_EXHAUSTED.
const BILLING_RE = /billing|prepa(y|id)|payment.required|credit.balance|insufficient.(credit|fund|balance)|out of credit|no credit/

// Why a live connection failed, from a close reason / vendor error text and a close or HTTP code.
// The words match the backend's REASONS (gemini_live_chat/providers.py).
export function failureReason (text, code) {
  const t = String(text || '').toLowerCase()
  if (code === 402 || BILLING_RE.test(t)) return 'billing'
  if (code === 429 || /quota|resource_exhausted|rate.?limit|usage limit|insufficient_quota/.test(t)) return 'quota'
  if (code === 401 || code === 403 || /api key|api_key|unauthori[sz]ed|permission_denied|forbidden|invalid_api_key/.test(t)) return 'auth'
  if (/expired/.test(t)) return 'expired'
  if (code >= 500 && code < 600) return 'unavailable'
  if (code === 1008 || code === 400) return 'rejected'
  return 'network'
}

// ── the call (module scope: a composer row remounts on navigation, the call must not) ────────────

export const call = {
  state: 'idle', // idle | connecting | live
  detail: '',
  gen: 0, // bumped by every start, stop and provider switch; stale async work checks it and backs out
  provider: null, // { id, label, transport, model } of the provider serving now
  ws: null, // gemini-live: the Live socket
  standby: null, // gemini-live: the replacement socket while resuming after goAway
  stopMic: null, // gemini-live: releases the PCM microphone
  player: null, // gemini-live: PCM playback
  rtc: null, // openai-realtime: { pc, dc, stream, audio, open, speaking, responding, needResponse }
  sessionId: null,
  resumeHandle: null,
  modelSpeaking: false,
  hangUp: false,
  hangTimer: null,
  flushTimer: null,
  lastAudioAt: 0,
  lastHeardAt: 0, // when the user's speech was last transcribed
  queue: [], // [{ text, group }] result messages not yet handed to the voice, one per model turn
  group: 0, // id of the last enqueued reply; every part of one reply shares it
  speakingGroup: 0, // the reply whose part was handed last (barge-in drops its remaining parts)
  handing: false, // a part was handed and the model's turn for it has not completed yet
  handedAt: 0,
  lastHanded: null, // the part handed last (re-handed when the provider fails before answering it)
  interim: [], // message.interim text of the Hermes turn in progress on the pinned chat
  turns: [], // [{ role: 'user'|'assistant', text }]
  partial: { user: '', assistant: '' },
  delegations: 0,
  tried: [], // providers that failed on this call (never retried on it)
  switches: 0,
  switching: false,
  providersUsed: [], // labels, in order, for the transcript
  choice: 'auto', // v0.5: the picker choice this call started with ('auto' or one provider id)
  // v0.6 brain: hermes
  brain: null, // 'hermes' | 'voice', from the minted session
  owner: null, // gemini: whose model turn is open: 'hermes' (handed text), 'voice' (its own; never played), 'muted'
  pendingHand: 0, // gemini: handed text whose turn has not started yet
  userPending: false, // the user is mid-turn (heard, not finalised yet)
  eosAt: 0, // when the provider's VAD ended the user's turn
  finalTimer: null,
  fallbackTimer: null,
  ackTimer: null,
  holdTimer: null,
  held: null, // { group, items }: a reply interrupted by the user, until their words are known
  dropped: new Set(), // reply groups never to be read again (barge-in, "stop")
  stream: null, // the Hermes reply being streamed into the voice
  lastReply: '', // for "repeat that"
  awaitingAnswer: false, // Hermes' last reply ended with a question: a "yes" is an answer
  lang: null, // the language the user speaks (from the classifier)
  lastTurn: null, // the classifier's verdict on the last user turn
  lat: null, // latency of the turn in flight
  settings: null,
  ctx: null,
  fromWake: false, // v0.7: this call was started by the wake word (it says "כן?" once it is up)
  listeners: new Set()
}
const publish = () => call.listeners.forEach(fn => { try { fn() } catch { /* isolated */ } })

function sendOn (ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
}
const send = msg => sendOn(call.ws, msg)
function rtcSend (msg) {
  const dc = call.rtc && call.rtc.dc
  if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg))
}

// ── transport abstraction ────────────────────────────────────────────────────────────────────────
// Everything above the transports (delegation, result hand-off, barge-in bookkeeping, transcript,
// hang-up) is shared; a transport only knows how to move text, tool answers and audio on its wire.

const TRANSPORTS = {
  'gemini-live': {
    connected: () => !!call.ws,
    playing: () => !!(call.player && call.player.playing()),
    // brain: hermes: the text to read is tagged; the relay persona reads it word for word.
    handText: (text, item) => send({ realtimeInput: { text: item && item.say ? `${SAY_TAG} ${text}` : text } }),
    answerTools: responses => send({ toolResponse: { functionResponses: responses } }),
    stopPlayback: () => {
      call.player && call.player.flush()
      if (call.owner === 'hermes') call.owner = 'muted' // the rest of that turn is not played
    }
  },
  'openai-realtime': {
    connected: () => !!(call.rtc && call.rtc.open),
    playing: () => !!(call.rtc && call.rtc.speaking),
    handText: (text, item) => {
      if (item && item.say) {
        // brain: hermes. An out-of-band response (conversation "none") whose only input is the text
        // to read: the voice model sees no conversation to answer, and nothing is added to it.
        rtcSend({
          type: 'response.create',
          response: {
            conversation: 'none',
            instructions: SAY_INSTRUCTIONS,
            output_modalities: ['audio'],
            metadata: { glc: 'say' },
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }]
          }
        })
      } else {
        rtcSend({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
        rtcSend({ type: 'response.create' })
      }
      if (call.rtc) call.rtc.responding = true
    },
    answerTools: responses => {
      for (const r of responses) {
        const out = r.response && 'result' in r.response ? r.response.result : JSON.stringify(r.response || {})
        rtcSend({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: r.id, output: String(out) } })
        if (r.name !== 'end_call' && call.rtc) call.rtc.needResponse = true
      }
    },
    // The server stops its own audio on barge-in (interrupt_response); this clears what is buffered.
    // brain: hermes also cancels a reading the user stopped by word ("stop"), not by voice.
    stopPlayback: () => {
      const rtc = call.rtc
      if (rtc && rtc.responding && rtc.responseId && call.brain === 'hermes') rtcSend({ type: 'response.cancel', response_id: rtc.responseId })
      rtcSend({ type: 'output_audio_buffer.clear' })
    }
  }
}
const T = () => TRANSPORTS[(call.provider && call.provider.transport) || 'gemini-live']
export const connected = () => T().connected()

function remember (role, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return
  call.turns.push({ role, text: t })
}

function flushPartial (role) {
  if (call.partial[role]) { remember(role, call.partial[role]); call.partial[role] = '' }
}

// Recent turns plus whatever is still being spoken (not flushed: a mid-sentence tool call must not
// split the transcript row).
export function voiceContext () {
  const turns = call.turns.slice()
  for (const role of ['user', 'assistant']) {
    const t = call.partial[role].replace(/\s+/g, ' ').trim()
    if (t) turns.push({ role, text: t })
  }
  const text = formatTranscript(turns.slice(-CONTEXT_TURNS))
  if (call.brain !== 'hermes') return text.slice(-6000)
  // v0.6: every reply is read aloud as it streams, so ask for the answer first.
  return `${STYLE_NOTE}\n${text.slice(-(6000 - STYLE_NOTE.length - 1))}`
}

function detach (ws) {
  if (!ws) return
  ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
  try { ws.close(1000, 'hang up') } catch { /* closed */ }
}

function closeRealtime () {
  const rtc = call.rtc
  if (!rtc) return
  call.rtc = null
  if (rtc.dc) {
    rtc.dc.onopen = rtc.dc.onmessage = rtc.dc.onclose = null
    try { rtc.dc.close() } catch { /* closed */ }
  }
  if (rtc.pc) {
    rtc.pc.ontrack = rtc.pc.onconnectionstatechange = null
    try { rtc.pc.close() } catch { /* closed */ }
  }
  if (rtc.stream) rtc.stream.getTracks().forEach(t => t.stop())
  if (rtc.audio) {
    try { rtc.audio.pause() } catch { /* not playing */ }
    rtc.audio.srcObject = null
  }
}

// Releases the provider connection and its audio, synchronously, and keeps the conversation
// (turns, queue, open delegations, pinned chat): used by tearDown and by a provider switch.
function releaseTransport () {
  const ws = call.ws
  const standby = call.standby
  call.ws = null
  call.standby = null
  detach(ws)
  detach(standby)
  if (call.stopMic) { const stop = call.stopMic; call.stopMic = null; stop() }
  if (call.player) { call.player.close(); call.player = null }
  closeRealtime()
  if (call.flushTimer) { E().clearTimeout(call.flushTimer); call.flushTimer = null }
  flushPartial('user')
  flushPartial('assistant')
  Object.assign(call, { modelSpeaking: false, resumeHandle: null, lastAudioAt: 0, owner: null, pendingHand: 0 })
}

async function saveTranscript (ctx, sid, turns, mode, used) {
  if (!turns.length || mode === 'off') return
  const via = used.length ? `Voice provider: ${used.join(' -> ')}\n\n` : ''
  const body = formatTranscript(turns)
  const stamp = new Date(E().now()).toISOString().replace(/[:.]/g, '-')
  if (ctx && ctx.files && typeof ctx.files.writeText === 'function') {
    try { await ctx.files.writeText('data', `transcript-${stamp}.md`, `# Live voice call ${stamp}\n\n${via}${body}\n`) } catch { /* best effort */ }
  }
  if (mode !== 'chat_turn' || !sid) return
  try {
    // A normal queued turn: if Hermes is still working on a delegation, it runs after it.
    await host.request('prompt.submit', { session_id: sid, text: `${TRANSCRIPT_HEADER}\n\n${via}${body}`, queued: true })
  } catch (error) {
    host.notify({ kind: 'warning', message: 'Could not save the call transcript to the chat', detail: String(error && error.message ? error.message : error) })
  }
}

// Idempotent. Releases every resource the call holds, synchronously: sockets, the peer connection,
// the microphone tracks and its AudioContext, the player, the timers. Nothing survives it.
export function tearDown (note) {
  const wasActive = call.state !== 'idle'
  const ctx = call.ctx
  const sid = call.sessionId
  call.gen += 1
  latFlush('abandoned')
  for (const t of ['finalTimer', 'fallbackTimer', 'ackTimer', 'holdTimer']) {
    if (call[t]) { E().clearTimeout(call[t]); call[t] = null }
  }
  releaseTransport()
  const turns = call.turns.slice()
  const used = call.providersUsed.slice()
  if (call.hangTimer) { E().clearTimeout(call.hangTimer); call.hangTimer = null }
  Object.assign(call, {
    state: 'idle', modelSpeaking: false, hangUp: false, queue: [], handing: false, handedAt: 0, lastHanded: null,
    interim: [], turns: [], lastAudioAt: 0, lastHeardAt: 0, speakingGroup: 0, provider: null, switching: false,
    partial: { user: '', assistant: '' }, delegations: 0, resumeHandle: null, tried: [], switches: 0, providersUsed: [],
    choice: 'auto', brain: null, owner: null, pendingHand: 0, userPending: false, eosAt: 0, held: null,
    dropped: new Set(), stream: null, lastReply: '', awaitingAnswer: false, lang: null, lastTurn: null, lat: null,
    fromWake: false
  })
  if (note !== undefined) call.detail = note
  publish()
  if (wasActive) void saveTranscript(ctx, sid, turns, (call.settings && call.settings.transcript_to_chat) || 'chat_turn', used)
  resumeWake() // v0.7: every hang-up path (button, voice command, failure, dispose) re-arms the wake word
}

// The model counts as quiet when the user is not talking, no handed part is still waiting for its
// answer (AWAIT_MS), and no turn is open, or an open turn has sent no audio for STALL_MS and nothing
// is still playing: a turn whose turnComplete never arrives (async reasoning, a lost frame) must not
// hold a Hermes result back for the rest of the call.
function modelQuiet () {
  const now = E().now()
  // brain: hermes knows exactly when the user's turn ends (userPending), so it needs no quiet window;
  // nothing is read while the user is mid-turn (bounded: a lost end-of-turn signal)
  if (call.brain !== 'hermes' && call.lastHeardAt && now - call.lastHeardAt < USER_QUIET_MS) return false
  if (call.userPending && now - call.lastHeardAt < AWAIT_MS) return false
  if (call.handing && now - Math.max(call.handedAt, call.lastAudioAt) < AWAIT_MS) return false
  if (call.handing) call.pendingHand = 0 // never answered: the next part goes ahead
  if (call.rtc && call.rtc.responding && now - Math.max(call.handedAt, call.lastAudioAt) < AWAIT_MS) return false
  if (!call.modelSpeaking) return true
  if (T().playing()) return false
  return now - call.lastAudioAt >= STALL_MS
}

function armFlushRetry () {
  if (call.flushTimer || !call.queue.length || !connected()) return
  call.flushTimer = E().setTimeout(() => { call.flushTimer = null; flushResults() }, FLUSH_RETRY_MS)
}

// Queue one Hermes reply for the voice. Returns the number of messages queued (0: silent or empty).
export function enqueueResult (text) {
  if (isHermes()) return sayReply(text)
  const messages = resultMessages(stripSpeakerLabels(text, personaNames()))
  if (!messages.length) return 0
  call.group += 1
  for (const m of messages) call.queue.push({ text: m, group: call.group })
  flushResults()
  return messages.length
}

// Hands over ONE queued message, only while the model is quiet; the next one follows when the
// model's answer to it completes, so the voice reads a long reply part by part instead of
// summarising one big block (and a new part never cuts the previous one off). While a provider
// switch is under way the queue simply waits for the next transport.
export function flushResults () {
  if (!call.queue.length || !connected()) return
  if (!modelQuiet()) { armFlushRetry(); return }
  let item = call.queue.shift()
  if (item.say && item.kind === 'reply') { // ready sentences of one reply go as one message
    let text = item.text
    while (call.queue[0] && call.queue[0].group === item.group && call.queue[0].kind === 'reply' &&
      text.length + 1 + call.queue[0].text.length <= MERGE_CHARS) text += ' ' + call.queue.shift().text
    if (text !== item.text) item = { ...item, text }
  }
  call.modelSpeaking = false
  call.handing = true
  call.handedAt = E().now()
  call.lastHanded = item
  call.speakingGroup = item.group
  if (item.say) call.pendingHand = 1
  if (item.bye) { // brain: hermes "bye": hang up once it is said (or after a grace period)
    call.hangUp = true
    if (!call.hangTimer) call.hangTimer = E().setTimeout(() => tearDown(''), HANGUP_GRACE_MS * 2)
  }
  T().handText(item.text, item)
  armFlushRetry() // the next part normally follows on turn completion; this covers a lost one
}

// Barge-in on a long answer: the rest of the reply being read is dropped (it stays in the chat).
function dropSpeakingRest () {
  if (!call.speakingGroup) return
  call.queue = call.queue.filter(i => i.group !== call.speakingGroup)
  call.speakingGroup = 0
  call.lastHanded = null
}

export async function delegate (request) {
  const sid = call.sessionId
  if (!sid) {
    enqueueResult('No chat is open, so the request could not be handed to Hermes.')
    return { ok: false }
  }
  call.delegations += 1
  publish()
  try {
    const res = await host.request('prompt.submit', {
      session_id: sid, text: request, surface: 'voice-live', voice_context: voiceContext()
    })
    return { ok: true, status: res && res.status }
  } catch (error) {
    call.delegations = Math.max(0, call.delegations - 1)
    enqueueResult(`The request did not reach Hermes: ${error && error.message ? error.message : String(error)}`)
    publish()
    return { ok: false }
  }
}

// calls: [{ id, name, args }] from either transport.
function onToolCall (calls) {
  const responses = []
  for (const fc of calls || []) {
    const id = String(fc.id || '')
    const name = String(fc.name || '')
    const args = fc.args || {}
    if (name === 'hermes_task') {
      const request = String(args.request || '').trim()
      if (request) void delegate(request)
      // No FunctionResponse.scheduling: the docs disagree on where it goes (reference: top level;
      // Live tools guide: inside `response`) and it was not measured against the live endpoint.
      responses.push({ id, name, response: { result: request ? RECEIPT : 'No request text was given.' } })
    } else if (name === 'end_call') {
      call.hangUp = true
      responses.push({ id, name, response: { result: 'OK' } })
      if (!call.hangTimer) call.hangTimer = E().setTimeout(() => tearDown(''), HANGUP_GRACE_MS)
    } else {
      responses.push({ id, name, response: { error: 'unknown tool' } })
    }
  }
  if (responses.length) T().answerTools(responses)
}

// Barge-in bookkeeping shared by both transports (the audio itself is stopped by the transport).
function onBargeIn () {
  T().stopPlayback()
  if (isHermes()) holdForBargeIn()
  call.modelSpeaking = false
  call.handing = false
  if (!isHermes()) dropSpeakingRest()
  flushPartial('assistant')
  armFlushRetry() // other replies wait until the user has finished (USER_QUIET_MS)
}

// The provider connection is ready: the call is live (again).
function onReady () {
  if (call.state !== 'connecting') return false
  call.state = 'live'
  if (call.fromWake && !call.switching && isHermes()) {
    call.fromWake = false
    sayLocal('wake') // v0.7: "כן?" tells the user the call is up and listening
  }
  if (call.switching) {
    call.switching = false
    call.detail = ''
    if (isHermes()) call.queue.unshift({ text: localLine('switch'), group: 0, say: true, kind: 'local' })
    else call.queue.unshift({ text: SWITCH_NOTE, group: 0 })
  }
  publish()
  flushResults()
  return true
}

// ── brain: hermes — runtime ──────────────────────────────────────────────────────────────────────

export const ACK_DELAY_MS = 900 // "checking" is said only when Hermes has not started talking by then
const FINAL_LAG_MS = 400 // gemini: transcription can trail the end-of-turn signal a little
const FINAL_FALLBACK_MS = 1500 // gemini: no end-of-turn signal at all: finish the turn after silence + this
const HOLD_MS = 2500 // an interrupted reply waits this long for the user's words before it is dropped
const MERGE_CHARS = 600 // consecutive ready sentences of one reply are handed as one message
const MAX_REPLY_CHARS = MAX_PARTS * PART_CHARS // same cap as v0.3's readout, then "the rest is in the chat"
export const isHermes = () => call.brain === 'hermes'

function callLang () {
  if (call.lang) return call.lang
  return String((call.settings && call.settings.language) || 'he').startsWith('en') ? 'en' : 'he'
}

// The few lines the plugin says itself (never content: content always comes from Hermes).
export function localLine (kind) {
  const he = callLang() === 'he'
  const female = !!(call.settings && call.settings.persona_gender === 'female')
  switch (kind) {
    case 'greeting': return he ? 'היי, אני כאן.' : "Hi, I'm here."
    case 'bye': return he ? 'ביי.' : 'Bye.'
    case 'wake': return he ? 'כן?' : 'Yes?'
    case 'switch': return he ? (female ? 'החלפתי ספק קול, ממשיכה.' : 'החלפתי ספק קול, ממשיך.') : 'I switched voice provider; carrying on.'
    case 'rest': return he ? 'ההמשך בצ\'אט.' : 'The rest is in the chat.'
    default: return ''
  }
}

function personaNames () {
  const s = call.settings || {}
  return [s.persona_name, s.persona_name_he, 'hermes', 'הרמס']
}

// ── v0.8: the acknowledgement (a person saying "hmm, one sec", not a bot narrating) ──────────────
// Picked locally from a phrase bank; the voice model never writes it, so it cannot answer, guess or
// promise. Sometimes it echoes 1-3 words of the user's own turn; sometimes it says nothing at all.
// Rules: <= ACK_MAX_WORDS words; never one of the last ACK_RECENT acks; an echo about one turn in
// three and never twice in a row; a q-only phrase ("good question") only after a question; the bare
// "בודק" is rare; every word is either the bank's or the user's own (verifyAck), so no new fact,
// number, time or name can appear. {m|f} is the persona's grammatical gender.
export const ACK_MAX_WORDS = 8
export const ACK_RECENT = 5
export const ACK_ECHO_ODDS = 1 / 3
export const ACK_SILENT_ODDS = 0.35 // only when the reply is likely fast (a short question)
export const ACK_BANK = {
  he: [
    'רגע.', 'שנייה, בוא נראה.', 'אוקיי, {מסתכל|מסתכלת}.', 'הממ, רגע.', 'כן, שנייה.', 'אה, בוא נראה.',
    { t: 'שאלה טובה, שנייה.', q: true }, 'רגע אחד.', 'אוקיי, שנייה.', 'טוב, בוא נראה.', 'רגע, רגע.',
    'אוקיי, רגע אחד.', 'הממ, בוא נראה.', 'כן כן, שנייה.', 'שנייה אחת.', 'אחלה, רגע.', 'סבבה, שנייה.',
    'רגע, {מסתכל|מסתכלת}.', 'יאללה, שנייה.', 'טוב, רגע.', 'אה, שנייה.', 'בסדר, בוא נראה.', 'כן, רגע.',
    'הממ, שנייה אחת.', 'רגע, אני {מסתכל|מסתכלת}.', 'יאללה, רגע אחד.', 'אוקיי, בוא נראה.',
    { t: 'יאללה, {בודק|בודקת} לך.', w: 0.3 }, { t: 'שאלה טובה, רגע.', q: true }
  ],
  en: [
    'One sec.', 'Hmm, let me see.', 'Okay, looking.', 'Sure, one moment.', "Let's see.",
    { t: 'Good question, one sec.', q: true }, 'Hold on.', 'Okay, one sec.', 'Right, let me look.',
    'Mm, one moment.', "Alright, let's see.", 'Yeah, one sec.', 'Just a sec.', 'Hmm, hold on.',
    'Sure, let me look.', 'Let me see.', 'One moment.', "Okay, let's see.", 'Alright, one sec.',
    'Got it, one sec.', 'Mm-hm, let me look.', 'Right, one moment.', 'Sure thing, hold on.',
    'Okay, just a moment.', "Ah, let's see.", 'Hmm, one sec.', { t: 'Ooh, good question.', q: true },
    { t: 'Checking.', w: 0.3 }
  ]
}
// {topic} is 1-3 words copied from the user's turn; every template tolerates any phrase there.
export const ACK_ECHO = {
  he: ['אה, {topic}, שנייה.', '{topic}? רגע.', '{topic}, בוא נראה.', 'אוקיי, {topic}, רגע.', 'הממ, {topic}, שנייה.'],
  en: ['Ah, {topic}, one sec.', '{topic}? Let me see.', 'Okay, {topic}, let me look.', 'Hmm, {topic}, hold on.']
}
// Words that are never a topic: question/request words, pronouns, function words, fillers.
const TOPIC_STOP = new Set(('מה איך למה מתי איפה מי כמה האם אם יש אין לי לך לו לה לנו לכם להם את אותו אותה ' +
  'של על עם אל זה זאת זו הזה הזאת הזו גם רק כבר עוד אני אתה את אנחנו הוא היא הם תבדוק תבדקי בדוק תגיד תגידי ' +
  'תסביר תסבירי תספר תספרי תראה תראי תמצא תמצאי תחפש תחפשי תסתכל תסתכלי תוכל תוכלי אפשר בבקשה רגע טוב אוקיי ' +
  'כן לא נו אז ו או קורה מצב ' +
  'what whats how why when where who which is are was were do does did can could would should will the a an ' +
  'my me your i you we it its this that of on in at for to about with please check tell show find look ' +
  'search give any there have has get okay ok so and or just').split(' '))

const ackMemory = { recent: [], lastEcho: false }
export function resetAckMemory () { ackMemory.recent = []; ackMemory.lastEcho = false }

const gendered = (t, female) => t.replace(/\{([^|{}]+)\|([^|{}]+)\}/g, (_, m, f) => (female ? f : m))
const ackWords = t => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}'\s-]/gu, ' ').split(/\s+/).filter(Boolean)

// The topic: the first 1-3 consecutive content words of the turn, exactly as the user said them.
export function ackTopic (turn, names) {
  const skip = nameSet(names)
  const raw = String(turn || '').split(/[\s]+/).map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean)
  const out = []
  for (const w of raw) {
    const k = w.toLowerCase().replace(/['’`׳"״]/g, '')
    const content = !TOPIC_STOP.has(k) && !skip.has(k) && !FILLERS.has(k) && !/^\p{N}+$/u.test(k) && k.length > 1
    if (content) { out.push(w); if (out.length === 3) break } else if (out.length) break
  }
  return out.length ? out.slice(0, 2).join(' ') : ''
}

// The guard: true only when the ack is short and adds nothing. Every word must come from the phrase
// bank (any gender form) or from the user's own turn, so no fact, number, time or name is new.
let ACK_VOCAB = null
function ackVocab () {
  if (ACK_VOCAB) return ACK_VOCAB
  ACK_VOCAB = new Set()
  for (const lang of Object.keys(ACK_BANK)) {
    for (const e of [...ACK_BANK[lang], ...ACK_ECHO[lang]]) {
      const t = typeof e === 'string' ? e : e.t
      for (const g of [false, true]) ackWords(gendered(t, g).replace('{topic}', '')).forEach(w => ACK_VOCAB.add(w))
    }
  }
  return ACK_VOCAB
}
export function verifyAck (ack, turn) {
  const ws = ackWords(ack)
  if (!ws.length || ws.length > ACK_MAX_WORDS) return false
  const own = new Set(ackWords(turn))
  return ws.every(w => ackVocab().has(w) || own.has(w))
}

// One ack for the user's turn, or '' (silence). Pure apart from the shared memory of recent acks;
// `rand` is injectable (tests).
export function pickAck (turn, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'he'
  const female = !!opts.female
  const rand = opts.rand || Math.random
  const ws = words(turn, nameSet(opts.names))
  const question = /[?？]/.test(String(turn || '')) || (ws.length > 0 && QUESTION_WORDS.has(ws[0]))
  const request = ws.some(w => REQUEST_WORDS.has(w) || /^ת[\u05D0-\u05EA]{3,}$/.test(w))
  // Likely fast: a short question that asks for no work. Silence is a valid answer then.
  if (ws.length <= 4 && !request && rand() < ACK_SILENT_ODDS) return ''
  let ack = ''
  const topic = ackTopic(turn, opts.names)
  if (topic && !ackMemory.lastEcho && rand() < ACK_ECHO_ODDS) {
    const choices = ACK_ECHO[lang].map(t => gendered(t, female).replace('{topic}', topic))
      .filter(t => !ackMemory.recent.includes(t) && verifyAck(t, turn))
    if (choices.length) ack = choices[Math.floor(rand() * choices.length)]
  }
  const echo = !!ack
  if (!ack) {
    const pool = ACK_BANK[lang].map(e => (typeof e === 'string' ? { t: e } : e))
      .filter(e => !e.q || question)
      .map(e => ({ t: gendered(e.t, female), w: e.w || 1 }))
      .filter(e => !ackMemory.recent.includes(e.t) && verifyAck(e.t, turn))
    const total = pool.reduce((n, e) => n + e.w, 0)
    let r = rand() * total
    for (const e of pool) { r -= e.w; if (r < 0) { ack = e.t; break } }
    if (!ack && pool.length) ack = pool[pool.length - 1].t
  }
  if (!ack || !verifyAck(ack, turn)) return ''
  ackMemory.lastEcho = echo
  ackMemory.recent = [...ackMemory.recent, ack].slice(-ACK_RECENT)
  return ack
}

// Queue words for the voice to read verbatim. kind: ack | local | reply.
function enqueueSay (text, group, extra = {}) {
  const t = norm(text)
  if (!t || call.dropped.has(group)) return
  const item = { text: t, group, say: true, kind: 'reply', ...extra }
  if (call.held && call.held.group === group) { call.held.items.push(item); return }
  if (item.kind !== 'ack') dropPendingAck()
  call.queue.push(item)
  flushResults()
}

function dropPendingAck () {
  if (call.ackTimer) { E().clearTimeout(call.ackTimer); call.ackTimer = null }
  if (call.queue.some(i => i.kind === 'ack')) call.queue = call.queue.filter(i => i.kind !== 'ack')
}

function sayLocal (kind, extra = {}) {
  call.group += 1
  enqueueSay(localLine(kind), call.group, { kind: kind === 'ack' ? 'ack' : 'local', ...extra })
}

// A whole reply at once (repeat, an error, a reply that did not stream): cut like a stream.
export function sayReply (text) {
  if (isSilent(text)) return 0
  call.group += 1
  const g = call.group
  let total = 0
  let n = 0
  for (const p of cutPieces(sayText(text, personaNames()), true).pieces) {
    if (isMarker(p) || isLabelOnly(p, personaNames())) continue
    if (total > MAX_REPLY_CHARS) { enqueueSay(localLine('rest'), g); break }
    total += p.length
    n += 1
    enqueueSay(p, g)
  }
  return n
}

// ── the streamed reply (message.start / message.delta / message.interim / message.complete)
function newStream () {
  call.group += 1
  call.stream = { group: call.group, raw: '', spoken: '', said: new Set(), chars: 0, silent: false, capped: false, active: true, createdAt: E().now(), text: [] }
  return call.stream
}

const couldBeMarker = raw => {
  const t = raw.trim().toUpperCase()
  return !t || SILENT_MARKERS.some(m => m.toUpperCase().startsWith(t))
}

function emitPiece (s, p) {
  s.spoken = s.spoken ? `${s.spoken} ${p}` : p
  if (isMarker(p) || s.capped || isLabelOnly(p, personaNames())) return
  if (s.said.has(norm(p))) return // already read in an earlier segment of this reply
  if (s.chars > MAX_REPLY_CHARS) { s.capped = true; enqueueSay(localLine('rest'), s.group); return }
  s.chars += p.length
  s.said.add(norm(p))
  s.text.push(p)
  latText(s)
  enqueueSay(p, s.group)
}

// Speak every complete sentence of the current segment that is not spoken yet.
function pump (s, final) {
  if (!s || s.silent) return
  if (isSilent(s.raw)) { s.silent = !s.chars; return }
  if (!final && !s.spoken && couldBeMarker(s.raw)) return // "NO" may still become "NO_REPLY"
  // sayText trims; a trailing space in the raw stream is what confirms the last sentence ended.
  const text = sayText(s.raw, personaNames()) + (/\s$/.test(s.raw) ? ' ' : '')
  const { pieces } = cutPieces(text, final)
  for (const p of freshPieces(pieces, s.spoken)) emitPiece(s, p)
}

// A segment ends (interim seal, a null delta, a tool call): speak its tail, start the next one.
function closeSegment (s) {
  pump(s, true)
  s.raw = ''
  s.spoken = ''
}

const liveStream = () => (call.stream && call.stream.active ? call.stream : newStream())

function relayStart () {
  if (call.stream && call.stream.active) finishStream(call.stream)
  newStream()
}

function relayDelta (text) {
  const s = liveStream()
  if (text === null) { closeSegment(s); return } // segment boundary (before tool lines)
  if (typeof text !== 'string' || !text) return
  s.raw += text
  pump(s, false)
}

function relayInterim (payload) {
  const s = liveStream()
  const text = textOf(payload.text)
  if (!payload.already_streamed && text.trim()) {
    if (s.raw.trim()) closeSegment(s)
    s.raw = text
  }
  closeSegment(s)
}

// Full-readout guarantee: the final text is cut the same way; any sentence not read yet is read
// (an exact sentence already read in this reply is not read twice). An empty final keeps the
// streamed text (Hermes core's contract for a held silence marker).
function relayComplete (payload) {
  const s = liveStream()
  const owed = call.delegations > 0
  if (owed) call.delegations -= 1
  const final = textOf(payload.text).trim()
  if (final && !isSilent(final)) {
    pump(s, false) // complete sentences only: the unfinished tail is covered by the final text
    for (const p of cutPieces(sayText(final, personaNames()), true).pieces) {
      if (!s.said.has(norm(p))) emitPiece(s, p)
    }
  } else if (!final) {
    pump(s, true)
  } else if (!s.chars) {
    s.silent = true
  }
  finishStream(s)
  if (!s.chars && !s.silent && owed) {
    sayReply(payload.status === 'error' || payload.error
      ? `Hermes stopped with an error: ${textOf(payload.error || payload.failure_reason || 'unknown').slice(0, 300)}`
      : 'Hermes finished without a text answer.')
  }
}

function finishStream (s) {
  s.active = false
  if (call.stream === s) call.stream = null
  if (s.chars) {
    call.lastReply = s.text.join(' ')
    call.awaitingAnswer = /[?？]["'”’)]*$/.test(call.lastReply)
  }
  if (call.lat && call.lat.group === s.group && !s.chars) latFlush('turn') // a silent reply
}

// ── the user's turn: the renderer decides
export function onUserTurn (text, eos) {
  const t = norm(text)
  const c = classifyTurn(t, { names: personaNames(), awaiting: call.awaitingAnswer })
  // v0.7: a goodbye without an explicit end-call phrase ("ביי", "תודה ביי") does not hang up; it
  // counts as a backchannel (an interrupted reply resumes).
  if (c.kind === 'bye' && !isEndCall(t, { names: personaNames() })) c.kind = 'ack'
  if (c.lang) call.lang = c.lang
  call.lastTurn = c
  resolveHold(c.kind)
  if (c.kind === 'empty' || c.kind === 'ack' || c.kind === 'short') { publish(); return c }
  call.awaitingAnswer = false
  if (c.kind === 'greeting') sayLocal('greeting')
  else if (c.kind === 'stop') stopSpeaking()
  else if (c.kind === 'bye') endByVoice()
  else if (c.kind === 'repeat' && call.lastReply) { stopSpeaking(); sayReply(call.lastReply) } else delegateTurn(t, eos)
  publish()
  return c
}

// The spoken end-call command: the voice says a short goodbye, then the call hangs up through the
// same tearDown as the button (transcript saved, mic released, wake word re-armed).
function endByVoice () {
  stopSpeaking()
  sayLocal('bye', { bye: true })
}

function delegateTurn (text, eos) {
  latStart(eos)
  armAck(text)
  void delegate(text)
}

// The 900 ms rule: when Hermes' first sentence is in by then, no ack at all.
function armAck (turn) {
  if (call.ackTimer) E().clearTimeout(call.ackTimer)
  const lat = call.lat
  call.ackTimer = E().setTimeout(() => {
    call.ackTimer = null
    if (call.state === 'idle' || (lat && lat.firstText) || call.lat !== lat) return
    const ack = pickAck(turn, {
      lang: callLang(), female: !!(call.settings && call.settings.persona_gender === 'female'),
      names: personaNames(), rand: E().random
    })
    if (!ack) return // silence is a valid ack
    call.group += 1
    enqueueSay(ack, call.group, { kind: 'ack' })
  }, ACK_DELAY_MS)
}

// "stop", "bye", "repeat": nothing queued or playing is read any further.
function stopSpeaking () {
  const groups = new Set(call.queue.filter(i => i.say).map(i => i.group))
  if (call.held) { groups.add(call.held.group); call.held = null }
  if (call.holdTimer) { E().clearTimeout(call.holdTimer); call.holdTimer = null }
  if (call.speakingGroup) groups.add(call.speakingGroup)
  if (call.stream && call.stream.active) groups.add(call.stream.group)
  groups.forEach(g => call.dropped.add(g))
  call.queue = call.queue.filter(i => !i.say)
  if (call.handing || call.modelSpeaking || T().playing()) T().stopPlayback()
  Object.assign(call, { modelSpeaking: false, handing: false, pendingHand: 0, lastHanded: null, speakingGroup: 0 })
  dropPendingAck()
}

// Barge-in on a reply: what is still queued of it is held back until the user's words are known.
// A backchannel ("ok", "כן") or noise resumes it (the interrupted sentence is read again); anything
// else drops it: the user moved on, and the new turn goes to Hermes as a follow-up or correction.
function holdForBargeIn () {
  const g = call.speakingGroup
  if (g && !call.held && !call.dropped.has(g)) {
    const items = []
    const last = call.lastHanded
    if (last && last.group === g && last.kind === 'reply') items.push(last)
    for (const i of call.queue) if (i.group === g && i.kind === 'reply') items.push(i)
    call.queue = call.queue.filter(i => i.group !== g)
    call.held = { group: g, items }
    if (call.holdTimer) E().clearTimeout(call.holdTimer)
    const tick = () => {
      call.holdTimer = null
      if (!call.held || call.held.group !== g) return
      if (call.userPending) { call.holdTimer = E().setTimeout(tick, HOLD_MS); return }
      resolveHold('empty')
    }
    call.holdTimer = E().setTimeout(tick, HOLD_MS)
  }
  call.queue = call.queue.filter(i => i.kind !== 'ack') // a stale "checking" is not said after an interruption
  Object.assign(call, { pendingHand: 0, lastHanded: null, speakingGroup: 0 })
}

function resolveHold (kind) {
  const h = call.held
  if (!h) return
  call.held = null
  if (call.holdTimer) { E().clearTimeout(call.holdTimer); call.holdTimer = null }
  if (kind === 'empty' || kind === 'ack' || kind === 'short') {
    call.queue.unshift(...h.items)
    flushResults()
  } else {
    call.dropped.add(h.group)
  }
}

// ── gemini end-of-turn (no create_response switch there): the first output of the voice's own turn,
// or its empty turnComplete, is the server VAD saying the user's turn is over.
function relayHeard (text, now) {
  call.lastHeardAt = now
  call.userPending = true
  // our handed text is answered after the user, not before: hand it again later
  if (call.pendingHand > 0 && call.owner !== 'hermes') {
    call.pendingHand = 0
    call.handing = false
    if (call.lastHanded && call.lastHanded.kind === 'reply') call.queue.unshift(call.lastHanded)
    call.lastHanded = null
  }
  flushPartial('assistant')
  call.partial.user += text
  if (call.fallbackTimer) E().clearTimeout(call.fallbackTimer)
  const wait = ((call.settings && call.settings.silence_ms) || 1000) + FINAL_FALLBACK_MS
  call.fallbackTimer = E().setTimeout(() => { call.fallbackTimer = null; finalizeUser() }, wait)
}

function userTurnEnded (now) {
  if (!call.userPending) return
  if (!call.eosAt) call.eosAt = now
  if (!call.finalTimer) call.finalTimer = E().setTimeout(() => { call.finalTimer = null; finalizeUser() }, FINAL_LAG_MS)
}

export function finalizeUser () {
  if (call.finalTimer) { E().clearTimeout(call.finalTimer); call.finalTimer = null }
  if (call.fallbackTimer) { E().clearTimeout(call.fallbackTimer); call.fallbackTimer = null }
  if (!call.userPending) return
  call.userPending = false
  const text = norm(call.partial.user)
  flushPartial('user')
  const eos = call.eosAt || call.lastHeardAt || E().now()
  call.eosAt = 0
  onUserTurn(text, eos)
  flushResults()
}

// ── latency: one line per delegated turn, numbers only (no content)
function latStart (eos) {
  latFlush('abandoned')
  call.lat = { eos, submit: E().now(), firstText: 0, firstAudio: 0, firstAnswerAudio: 0, group: 0, ack: false }
}

function latText (s) {
  const l = call.lat
  if (l && !l.firstText && s.createdAt >= l.submit) { l.firstText = E().now(); l.group = s.group }
}

// The first audio of a handed item started playing.
function noteAudio () {
  const l = call.lat
  const item = call.lastHanded
  if (!l || !item) return
  const now = E().now()
  if (item.kind === 'ack') { l.ack = true; if (!l.firstAudio) l.firstAudio = now; return }
  if (l.group && item.group === l.group) {
    if (!l.firstAudio) l.firstAudio = now
    if (!l.firstAnswerAudio) { l.firstAnswerAudio = now; latFlush('turn') }
  }
}

function latFlush (kind) {
  const l = call.lat
  if (!l) return
  call.lat = null
  const rel = t => (t ? Math.max(0, Math.round(t - l.eos)) : null)
  const rec = {
    provider: (call.provider && call.provider.id) || 'unknown',
    brain: call.brain || 'unknown',
    kind,
    silence_ms: (call.settings && call.settings.silence_ms) || null,
    ack: l.ack,
    submit: rel(l.submit),
    first_text: rel(l.firstText),
    first_audio: rel(l.firstAudio),
    first_answer_audio: rel(l.firstAnswerAudio)
  }
  E().log('[gemini-live-chat] latency', JSON.stringify(rec))
  const ctx = call.ctx
  if (ctx) try { void Promise.resolve(ctx.rest('/latency', { method: 'POST', body: rec })).catch(() => {}) } catch { /* best effort */ }
}

// ── gemini-live transport ────────────────────────────────────────────────────────────────────────

function transcriptOf (msg, content, field) {
  const v = (content && content[field]) || msg[field]
  return v && typeof v.text === 'string' ? v.text : ''
}

export function receive (msg, ws) {
  if (!msg || typeof msg !== 'object') return
  if (msg.setupComplete !== undefined) {
    if (ws === call.standby) { // resumed socket is ready: swap, then drop the old one
      const old = call.ws
      call.ws = ws
      call.standby = null
      detach(old)
    }
    if (onReady()) void attachMic()
    return
  }
  if (ws !== call.ws) return // frames from a socket being replaced
  if (isHermes()) { receiveRelay(msg); return }
  const content = msg.serverContent
  if (content) {
    if (content.interrupted) onBargeIn() // the server's VAD already stopped generation
    const parts = (content.modelTurn && content.modelTurn.parts) || []
    for (const part of parts) {
      const inline = part.inlineData
      if (inline && inline.data) {
        call.modelSpeaking = true
        call.lastAudioAt = E().now()
        call.player && call.player.play(b64ToPcm(inline.data))
      }
    }
  }
  const heard = transcriptOf(msg, content, 'inputTranscription')
  if (heard) {
    call.lastHeardAt = E().now()
    // The server finishes generating long before playback ends; speech heard while buffered audio
    // still plays gets no "interrupted" from the server, so it is stopped here.
    if (!call.modelSpeaking && call.player && call.player.playing()) {
      call.player.flush()
      dropSpeakingRest()
    }
    flushPartial('assistant')
    call.partial.user += heard
  }
  const said = transcriptOf(msg, content, 'outputTranscription')
  if (said) { flushPartial('user'); call.partial.assistant += said }
  if (content && content.turnComplete) {
    flushPartial('user')
    flushPartial('assistant')
    call.modelSpeaking = false
    call.handing = false
    if (call.hangUp) { tearDown(''); return }
    flushResults()
  }
  if (msg.toolCall) onToolCall(msg.toolCall.functionCalls)
  receiveSession(msg)
}

// Resumption, goAway and errors: the same in both brains.
function receiveSession (msg) {
  if (msg.sessionResumptionUpdate && msg.sessionResumptionUpdate.resumable && msg.sessionResumptionUpdate.newHandle) {
    call.resumeHandle = String(msg.sessionResumptionUpdate.newHandle)
  }
  if (msg.goAway) void resume()
  if (msg.error) {
    const text = String(msg.error.message || 'Gemini Live error')
    const reason = failureReason(text, msg.error.code)
    if (REFUSALS.includes(reason)) { void failover(reason, text); return }
    call.detail = text
    publish()
  }
}

// brain: hermes on Gemini Live. Gemini has no "don't respond" switch, so every model turn is
// classified when its first output arrives: a turn that follows our handed text (pendingHand) is
// Hermes' words and is played; any other turn is the voice model's own and is neither played nor
// recorded; its first output (or its empty turnComplete) only marks the end of the user's turn.
function receiveRelay (msg) {
  const now = E().now()
  const content = msg.serverContent
  const heard = transcriptOf(msg, content, 'inputTranscription')
  if (heard) {
    // speech heard while buffered audio still plays gets no "interrupted" from the server
    if (call.owner !== 'hermes' && call.player && call.player.playing()) onBargeIn()
    relayHeard(heard, now)
  }
  if (content) {
    const parts = (content.modelTurn && content.modelTurn.parts) || []
    const audio = parts.filter(p => p.inlineData && p.inlineData.data)
    const said = transcriptOf(msg, content, 'outputTranscription')
    if (content.interrupted) {
      if (call.owner === 'hermes' || (call.player && call.player.playing())) onBargeIn()
      call.owner = null
    }
    if ((audio.length || said) && !call.owner) {
      if (call.pendingHand > 0) { call.pendingHand -= 1; call.owner = 'hermes' } else call.owner = 'voice'
    }
    if (call.owner === 'voice' || (!call.owner && content.turnComplete)) userTurnEnded(now)
    if (call.owner === 'hermes') {
      for (const part of audio) {
        if (!call.modelSpeaking) noteAudio()
        call.modelSpeaking = true
        call.lastAudioAt = now
        call.player && call.player.play(b64ToPcm(part.inlineData.data))
      }
      if (said) { if (!call.userPending) flushPartial('user'); call.partial.assistant += said }
    }
    if (content.turnComplete) {
      const was = call.owner
      call.owner = null
      if (was === 'hermes' || was === 'muted') {
        flushPartial('assistant')
        call.modelSpeaking = false
        call.handing = false
        if (call.hangUp) { tearDown(''); return }
      }
      flushResults()
    }
  }
  if (msg.toolCall) { // no tools are declared in this mode; answer anything stray so the turn goes on
    const calls = msg.toolCall.functionCalls || []
    if (calls.length) T().answerTools(calls.map(fc => ({ id: String(fc.id || ''), name: String(fc.name || ''), response: { error: 'not available' } })))
  }
  receiveSession(msg)
}

function decode (data) {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data)
  return ''
}

function openSocket (minted, gen) {
  const ws = new (E().WebSocket)(minted.url)
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => { if (call.gen === gen) sendOn(ws, minted.setup) }
  ws.onmessage = ({ data }) => {
    if (call.gen !== gen) return
    let msg
    try { msg = JSON.parse(decode(data)) } catch { return }
    receive(msg, ws)
  }
  ws.onclose = ev => {
    if (call.gen !== gen) return
    if (ws === call.standby) { call.standby = null; return } // resume failed; the old socket still runs until it dies
    if (ws !== call.ws) return
    const note = call.detail || closeNote(ev)
    // A normal close (1000) or a close after end_call ends the call; anything else (quota, auth,
    // server error, network) moves the call to the next provider.
    if (ev && ev.code !== 1000 && !call.hangUp) void failover(failureReason(ev.reason, ev.code), note)
    else tearDown(note)
  }
  ws.onerror = () => {}
  return ws
}

function closeNote (ev) {
  if (!ev || ev.code === 1000) return 'The voice call ended'
  return `The voice call closed (${ev.code}${ev.reason ? ': ' + ev.reason : ''})`
}

async function mint (ctx, body) {
  return ctx.rest('/session', { method: 'POST', body })
}

async function resume () {
  const ctx = call.ctx
  const gen = call.gen
  if (!call.resumeHandle || call.standby || !ctx) return
  try {
    // A handle belongs to the key that issued it: resume on the same provider, never fall back.
    const minted = await mint(ctx, { resume_handle: call.resumeHandle, provider: call.provider && call.provider.id })
    if (call.gen !== gen) return
    call.standby = openSocket(minted, gen)
  } catch { /* the old socket keeps going until Google closes it, then the call fails over */ }
}

async function attachMic () {
  const gen = call.gen
  try {
    const stop = await startMic(frame => {
      if (call.settings && call.settings.half_duplex && call.player && call.player.playing()) return
      send({ realtimeInput: { audio: { mimeType: IN_MIME, data: floatToB64(frame) } } })
    }, () => call.gen === gen)
    if (!stop) return
    if (call.gen !== gen) { stop(); return }
    call.stopMic = stop
  } catch (error) {
    if (call.gen === gen) tearDown('Microphone unavailable: ' + (error && error.message ? error.message : String(error)))
  }
}

// ── openai-realtime transport (WebRTC; the Codex subscription route) ─────────────────────────────
// The backend minted a short-lived client secret with Hermes' openai-codex sign-in; it is used once,
// as the bearer of the SDP offer to api.openai.com, and never stored. Audio flows over the peer
// connection, events over the "oai-events" data channel.

async function openRealtime (minted, gen) {
  const rtc = { pc: null, dc: null, stream: null, audio: null, open: false, speaking: false, responding: false, needResponse: false }
  call.rtc = rtc
  const current = () => call.gen === gen && call.rtc === rtc
  if (typeof minted.offer_url !== 'string' || !minted.offer_url.startsWith(OPENAI_ORIGIN) || !minted.client_secret) {
    void failover('rejected', 'Unexpected OpenAI session from the backend')
    return
  }
  let stream
  try {
    await micReleased()
    if (!current()) return
    stream = await E().getUserMedia(MIC_CONSTRAINTS)
  } catch (error) {
    if (current()) tearDown('Microphone unavailable: ' + (error && error.message ? error.message : String(error)))
    return
  }
  if (!current()) { stream.getTracks().forEach(t => t.stop()); return } // stopped during the permission prompt
  rtc.stream = stream
  const pc = new (E().RTCPeerConnection)()
  rtc.pc = pc
  stream.getTracks().forEach(t => pc.addTrack(t, stream))
  pc.ontrack = ev => {
    if (!current()) return
    const audio = E().createAudio()
    audio.autoplay = true
    audio.srcObject = (ev.streams && ev.streams[0]) || null
    rtc.audio = audio
    try { void Promise.resolve(audio.play && audio.play()).catch(() => {}) } catch { /* autoplay refused */ }
  }
  pc.onconnectionstatechange = () => {
    if (current() && pc.connectionState === 'failed') void failover('network', 'The voice connection was lost')
  }
  const dc = pc.createDataChannel('oai-events')
  rtc.dc = dc
  dc.onopen = () => { if (current()) { rtc.open = true; onReady() } }
  dc.onmessage = ({ data }) => {
    if (!current()) return
    let msg
    try { msg = JSON.parse(decode(data)) } catch { return }
    receiveRealtime(msg)
  }
  dc.onclose = () => {
    if (!current()) return
    if (call.hangUp) tearDown('')
    else void failover('network', 'The voice connection closed')
  }
  try {
    const offer = await pc.createOffer()
    if (!current()) return
    await pc.setLocalDescription(offer)
    if (!current()) return
    const res = await E().fetch(`${minted.offer_url}?model=${encodeURIComponent(minted.model || '')}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${minted.client_secret}`, 'Content-Type': 'application/sdp' },
      body: offer.sdp
    })
    if (!current()) return
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      if (current()) void failover(failureReason(text, res.status), `OpenAI refused the call (${res.status})`)
      return
    }
    const sdp = await res.text()
    if (!current()) return
    await pc.setRemoteDescription({ type: 'answer', sdp })
  } catch (error) {
    if (current()) void failover('network', 'Could not connect to OpenAI Realtime: ' + (error && error.message ? error.message : String(error)))
  }
}

// brain: hermes on OpenAI Realtime (create_response: false): the server detects and transcribes the
// user's turn but never answers it; the only responses are the out-of-band readings created in
// handText. Returns true when the event is fully handled here; the rest (audio buffer state,
// errors) is shared with voice mode.
function receiveRealtimeRelay (msg, rtc, now) {
  switch (msg.type) {
    case 'input_audio_buffer.speech_started': // barge-in: interrupt_response already cut the reading
      call.lastHeardAt = now
      call.userPending = true
      call.eosAt = 0
      if (call.modelSpeaking || call.handing || rtc.responding || rtc.speaking) onBargeIn()
      else flushPartial('assistant')
      return true
    case 'input_audio_buffer.speech_stopped':
      call.eosAt = now
      return true
    case 'conversation.item.input_audio_transcription.delta':
      if (msg.delta) { call.lastHeardAt = now; flushPartial('assistant'); call.partial.user += msg.delta }
      return true
    case 'conversation.item.input_audio_transcription.completed': {
      flushPartial('assistant')
      if (typeof msg.transcript === 'string' && msg.transcript.trim()) call.partial.user = msg.transcript
      const text = norm(call.partial.user)
      flushPartial('user')
      call.userPending = false
      const eos = call.eosAt || now
      call.eosAt = 0
      onUserTurn(text, eos)
      flushResults()
      return true
    }
    case 'conversation.item.input_audio_transcription.failed':
      call.partial.user = ''
      call.userPending = false
      resolveHold('empty')
      flushResults()
      return true
    case 'response.created':
      rtc.responding = true
      rtc.responseId = (msg.response && msg.response.id) || null
      return true
    case 'response.output_audio_transcript.delta':
      if (msg.delta) { if (!call.userPending) flushPartial('user'); call.partial.assistant += msg.delta }
      return true
    case 'output_audio_buffer.started':
      if (!call.modelSpeaking) noteAudio()
      return false
    case 'response.function_call_arguments.done': // no tools in this mode
      return true
    case 'response.done':
      flushPartial('assistant')
      rtc.responding = false
      rtc.responseId = null
      rtc.needResponse = false
      call.handing = false
      if (call.hangUp) { if (!rtc.speaking) tearDown(''); return true }
      flushResults()
      return true
  }
  return false
}

// OpenAI Realtime server events (GA names), mapped onto the shared call logic.
export function receiveRealtime (msg) {
  const rtc = call.rtc
  if (!msg || typeof msg !== 'object' || !rtc) return
  const now = E().now()
  if (isHermes() && receiveRealtimeRelay(msg, rtc, now)) return
  switch (msg.type) {
    case 'input_audio_buffer.speech_started': // barge-in: the server already cut its response
      call.lastHeardAt = now
      if (call.modelSpeaking || call.handing) onBargeIn()
      else flushPartial('assistant')
      break
    case 'conversation.item.input_audio_transcription.delta':
      if (msg.delta) { call.lastHeardAt = now; flushPartial('assistant'); call.partial.user += msg.delta }
      break
    case 'conversation.item.input_audio_transcription.completed':
      flushPartial('assistant')
      if (typeof msg.transcript === 'string' && msg.transcript.trim()) call.partial.user = msg.transcript
      flushPartial('user')
      break
    case 'response.created':
      rtc.responding = true
      break
    case 'response.output_audio_transcript.delta':
      if (msg.delta) { flushPartial('user'); call.partial.assistant += msg.delta }
      break
    case 'response.output_audio_transcript.done':
      flushPartial('assistant')
      break
    case 'output_audio_buffer.started':
      call.modelSpeaking = true
      rtc.speaking = true
      call.lastAudioAt = now
      break
    case 'output_audio_buffer.stopped':
    case 'output_audio_buffer.cleared':
      call.modelSpeaking = false
      rtc.speaking = false
      call.lastAudioAt = now
      if (call.hangUp && !rtc.responding) { tearDown(''); return }
      flushResults()
      break
    case 'response.function_call_arguments.done': {
      let args = {}
      try { args = JSON.parse(msg.arguments || '{}') } catch { /* no arguments */ }
      onToolCall([{ id: msg.call_id, name: msg.name, args }])
      break
    }
    case 'response.done':
      flushPartial('user')
      flushPartial('assistant')
      rtc.responding = false
      call.handing = false
      if (call.hangUp) { if (!rtc.speaking) tearDown(''); return }
      if (rtc.needResponse) { // a tool answer is in: let the voice acknowledge it
        rtc.needResponse = false
        rtcSend({ type: 'response.create' })
        rtc.responding = true
        return
      }
      flushResults()
      break
    case 'error': {
      const e = msg.error || {}
      const text = [e.code, e.type, e.message].filter(Boolean).join(' ')
      const reason = failureReason(text)
      if (REFUSALS.includes(reason) || reason === 'expired') { void failover(reason, `OpenAI Realtime: ${e.message || e.code}`); return }
      rtc.responding = false
      call.detail = String(e.message || e.code || 'OpenAI Realtime error').slice(0, 200)
      publish()
      break
    }
  }
}

// ── provider selection, start and mid-call failover ──────────────────────────────────────────────

function openTransport (minted, gen) {
  const id = minted.provider || 'gemini-free'
  call.provider = {
    id,
    label: minted.provider_label || PROVIDER_LABELS[id] || id,
    transport: minted.transport || 'gemini-live',
    model: minted.model || ''
  }
  call.brain = BRAINS.includes(minted.brain) ? minted.brain : 'voice' // an older backend: v0.5 behaviour
  if (call.providersUsed.at(-1) !== call.provider.label) call.providersUsed.push(call.provider.label)
  publish()
  if (call.provider.transport === 'openai-realtime') {
    void openRealtime(minted, gen)
  } else {
    call.player = createPlayer()
    call.ws = openSocket(minted, gen)
  }
}

// v0.5: the chosen provider could not serve. Its own voice is gone, so the notice is spoken by the
// browser's local speech synthesis (Hebrew when the call language is Hebrew and a Hebrew voice is
// installed) and shown as a toast whose button switches the picker to Auto.
export function pinnedNoticeText (id, reason, lang) {
  const label = PROVIDER_LABELS[id] || id
  if (String(lang || '').startsWith('he') && E().hasVoice('he')) {
    const why = { billing: 'אין קרדיט או חיוב בחשבון', quota: 'נגמרה המכסה', auth: 'המפתח נדחה', not_signed_in: 'אין התחברות', no_key: 'חסר מפתח' }[reason] || 'הוא לא זמין'
    return `ספק הקול ${label} לא זמין: ${why}. אפשר לעבור לאוטומטי בתפריט שליד כפתור השיחה.`
  }
  return `The voice provider ${label} is unavailable: ${REASON_TEXT[reason] || reason}. You can switch to Auto in the menu next to the call button.`
}

export function announcePinnedFailure (ctx, id, reason, message) {
  const lang = (call.settings && call.settings.language) || 'he'
  E().speak(pinnedNoticeText(id, reason, lang), String(lang).startsWith('he') && E().hasVoice('he') ? 'he-IL' : 'en-US')
  host.notify({
    kind: 'warning',
    message: message || `${unavailableText(id, reason)}.`,
    action: ctx ? { label: 'Use Auto', onClick: () => { void setChoice(ctx, 'auto') } } : undefined
  })
}

// Tell the backend about a refusal it could not see (it happened on the provider's own socket), so
// the picker shows it. Best effort; ids and enums only.
function reportRefusal (ctx, provider, reason) {
  if (!ctx || !provider || !(REFUSALS.includes(reason) || reason === 'not_signed_in')) return
  try { void Promise.resolve(ctx.rest('/report', { method: 'POST', body: { provider, reason } })).catch(() => {}) } catch { /* best effort */ }
}

// The serving provider failed (at connect or mid-call): release it, remember it, and reconnect the
// SAME call to the next provider of the chain, carrying the recent spoken turns. A provider that
// failed is never retried on this call; quota/billing/auth refusals also cool it down for the next
// calls. v0.5: when the user chose this one provider (not Auto), there is no next provider: the
// call ends, the notice says why and offers Auto.
export async function failover (reason, note) {
  if (call.state === 'idle') return
  const from = call.provider && call.provider.id
  if (from) {
    if (!call.tried.includes(from)) call.tried.push(from)
    if (REFUSALS.includes(reason)) cooldown.set(from, E().now() + COOLDOWN_MS)
    reportRefusal(call.ctx, from, reason)
  }
  if (from && call.choice && call.choice !== 'auto' && !call.hangUp) {
    const ctx = call.ctx
    const text = `${unavailableText(from, reason)}. Switch the voice provider to Auto to use the fallback chain.`
    tearDown(text)
    announcePinnedFailure(ctx, from, reason, text)
    return
  }
  if (call.hangUp || call.switches >= MAX_SWITCHES || !call.ctx) { tearDown(note); return }
  call.gen += 1
  const gen = call.gen
  if (isHermes() && call.userPending) finalizeUser() // the words heard so far still go to Hermes
  if (call.handing && call.lastHanded) call.queue.unshift(call.lastHanded) // never answered: hand it again
  releaseTransport()
  Object.assign(call, { state: 'connecting', switching: true, handing: false, switches: call.switches + 1, detail: 'Switching voice provider…' })
  publish()
  host.notify({ kind: 'info', message: `${(call.provider && call.provider.label) || 'The voice provider'} failed (${reason}); switching voice provider` })
  let minted
  try {
    minted = await mint(call.ctx, { exclude: call.tried.slice(), carry: voiceContext(), switch_from: from, reason })
  } catch (error) {
    if (call.gen === gen) tearDown(`${note}. ${errorMessage(error, 'No other voice provider could start.')}`)
    return
  }
  if (call.gen !== gen) return
  openTransport(minted, gen)
}

function errorDetail (error) {
  const d = error && (error.detail || (error.body && error.body.detail))
  return d && typeof d === 'object' ? d : {}
}

function errorMessage (error, fallback) {
  const d = errorDetail(error)
  if (d.message) return d.message
  if (error && error.message) return error.message
  return fallback
}

export async function start (ctx) {
  if (call.state !== 'idle') return
  const sid = (host.state.focusedSessionId && host.state.focusedSessionId.get()) || host.state.activeSessionId.get()
  if (!sid) {
    call.detail = 'Open a chat first: the call delegates into the open chat.'
    host.notify({ kind: 'info', message: call.detail })
    publish()
    return
  }
  call.gen += 1
  const gen = call.gen
  if (!wake.ctx) wake.ctx = ctx
  Object.assign(call, {
    state: 'connecting', detail: '', turns: [], queue: [], handing: false, sessionId: sid, ctx,
    provider: null, tried: [], switches: 0, switching: false, providersUsed: []
  })
  publish()
  const cooled = cooledProviders()
  let minted
  try {
    minted = await mint(ctx, cooled.length ? { exclude: cooled } : {})
  } catch (error) {
    if (call.gen !== gen) return
    let failure = error
    const pinned = errorDetail(error).reason === 'pinned_unavailable' // the backend ignores cooldowns for a pin
    if (cooled.length && !pinned) { // the cooldown is advice: when nothing else can serve, ask the providers again
      try { minted = await mint(ctx, {}); failure = null } catch (again) { failure = again }
      if (call.gen !== gen) return
    }
    if (failure) {
      const detail = errorDetail(failure)
      const message = errorMessage(failure, 'Could not start the voice call')
      tearDown(message)
      if (detail.reason === 'pinned_unavailable') {
        const id = detail.choice
        const reason = ((detail.attempts || []).find(a => a.provider === id) || {}).reason
        announcePinnedFailure(ctx, id, reason, message)
      } else {
        host.notify({ kind: 'warning', message })
      }
      void refreshStatus(ctx) // the picker shows what just failed
      return
    }
  }
  if (call.gen !== gen) return // stopped while the session was minting: open nothing
  call.choice = minted.choice || 'auto'
  openTransport(minted, gen)
}

// ── UI ───────────────────────────────────────────────────────────────────────────────────────────

function useCall () {
  const [, rerender] = useState(0)
  useEffect(() => {
    const fn = () => rerender(n => n + 1)
    call.listeners.add(fn)
    return () => call.listeners.delete(fn)
  }, [])
}

const servingLabel = () => (call.provider && call.provider.label) || 'Voice'

function chainText (status) {
  const ready = ((status && status.providers) || []).filter(p => p.ready).map(p => p.label)
  return ready.length ? ready.join(' -> ') : 'Gemini Live'
}

// ── provider picker (v0.5) ───────────────────────────────────────────────────────────────────────
// The backend's /status (with `picker`) is shared by the button and the picker; the choice itself is
// stored by the backend in the plugin's data folder (POST /choice), so it is the same on every
// window and device connected to this Hermes, and survives restarts.

export const ui = { status: null, open: false, saving: false }
const OFFLINE = { available: false, message: 'The voice backend is off. Enable the gemini-live-chat plugin for this profile.' }

export async function refreshStatus (ctx) {
  try {
    const s = await ctx.rest('/status')
    ui.status = s
    call.settings = s.settings
  } catch {
    ui.status = OFFLINE
  }
  publish()
  return ui.status
}

// One click: store the choice, then show the fresh availability. Refused while a call is up (the
// call keeps the provider it started with; the new choice applies to the next call).
export async function setChoice (ctx, choice) {
  if (ui.saving) return false
  ui.saving = true
  publish()
  try {
    const picker = await ctx.rest('/choice', { method: 'POST', body: { choice } })
    if (ui.status && picker && picker.options) ui.status = { ...ui.status, picker }
    await refreshStatus(ctx)
    return true
  } catch (error) {
    host.notify({ kind: 'warning', message: errorMessage(error, 'Could not save the voice provider choice') })
    return false
  } finally {
    ui.saving = false
    publish()
  }
}

export function choiceOf (status) {
  return (status && status.picker && status.picker.choice) || 'auto'
}

const STATE_HINT = { ready: '', refused: ' (last attempt refused)', missing: ' (not available)' }

// The rows of the picker: Auto, then each provider. A `missing` provider is greyed out and not
// clickable; its tooltip says what is missing. A `refused` one stays clickable (the refusal may be
// over: credit added, signed in again) and its tooltip says why it failed last time.
export function pickerRows (status) {
  const opts = (status && status.picker && status.picker.options) || []
  return opts.map(o => ({
    id: o.id,
    label: o.id === 'auto' ? 'Auto (fallback chain)' : (o.label || PROVIDER_LABELS[o.id] || o.id),
    selected: !!o.selected,
    disabled: o.state === 'missing',
    tone: o.state,
    tooltip: o.detail || '',
    note: STATE_HINT[o.state] || ''
  }))
}

function PickerRow ({ ctx, row, busy }) {
  const dot = row.tone === 'ready' ? 'bg-emerald-500' : row.tone === 'refused' ? 'bg-amber-500' : 'bg-muted-foreground/40'
  return h('button', {
    type: 'button',
    role: 'menuitemradio',
    'aria-checked': row.selected,
    'aria-disabled': row.disabled || busy,
    disabled: row.disabled || busy,
    title: row.tooltip,
    onClick: () => { if (!row.disabled && !row.selected) void setChoice(ctx, row.id) },
    className: 'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ' +
      (row.disabled ? 'cursor-not-allowed opacity-50 ' : 'hover:bg-muted ') + (row.selected ? 'bg-muted/60 ' : '')
  },
  h('span', { className: `mt-1.5 inline-block size-2 shrink-0 rounded-full ${dot}`, 'aria-hidden': true }),
  h('span', { className: 'flex min-w-0 flex-1 flex-col' },
    h('span', { className: 'font-medium' }, row.label, row.note ? h('span', { className: 'font-normal text-(--ui-text-tertiary)' }, row.note) : null),
    // The reason is also written out, so it is readable on a phone, where there is no hover tooltip.
    row.tooltip ? h('span', { className: 'text-[0.6875rem] leading-snug text-(--ui-text-tertiary) break-words' }, row.tooltip) : null),
  row.selected ? h(icons.Check || 'span', { className: icons.iconSize.sm, 'aria-hidden': true }) : null)
}

function PickerPanel ({ ctx }) {
  useCall()
  const rows = pickerRows(ui.status)
  const live = call.state !== 'idle'
  const persistent = !(ui.status && ui.status.picker && ui.status.picker.persistent === false)
  return h('div', { role: 'menu', 'aria-label': 'Voice provider', className: 'flex flex-col gap-0.5' },
    h('div', { className: 'px-2 pb-1 pt-0.5 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)' }, 'Voice provider'),
    rows.length
      ? rows.map(row => h(PickerRow, { key: row.id, ctx, row, busy: ui.saving || live }))
      : h('div', { className: 'px-2 py-2 text-sm text-(--ui-text-tertiary)' }, (ui.status && ui.status.message) || 'Loading…'),
    live ? h('div', { className: 'px-2 pt-1 text-[0.6875rem] text-(--ui-text-tertiary)' }, 'Hang up to change the provider; this call keeps its own.') : null,
    persistent ? null : h('div', { className: 'px-2 pt-1 text-[0.6875rem] text-(--ui-text-tertiary)' }, 'This Hermes cannot store plugin state: the choice lasts until the gateway restarts.'))
}

function pickerSummary (status) {
  const choice = choiceOf(status)
  if (choice === 'auto') return 'Auto'
  return PROVIDER_LABELS[choice] || choice
}

function ProviderPicker ({ ctx }) {
  useCall()
  const setOpen = v => {
    ui.open = !!v
    if (ui.open) void refreshStatus(ctx) // fresh availability every time it opens
    publish()
  }
  const label = `Voice provider: ${pickerSummary(ui.status)}`
  return h(Popover, { open: ui.open, onOpenChange: setOpen },
    h(PopoverTrigger, { asChild: true },
      h('button', {
        type: 'button',
        title: label,
        'aria-label': label,
        'aria-haspopup': 'menu',
        'aria-expanded': ui.open,
        // A finger-sized target on a phone; the chevron itself stays small.
        className: 'inline-flex h-7 min-w-5 shrink-0 items-center justify-center rounded-full px-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
      }, h(icons.ChevronDown || icons.ChevronUp || 'span', { className: 'size-3' }))),
    h(PopoverContent, { side: 'top', align: 'end', className: 'w-72 p-1.5', 'aria-label': 'Voice provider' },
      h(PickerPanel, { ctx })))
}

function VoiceButton ({ ctx }) {
  useCall()
  useEffect(() => { void refreshStatus(ctx) }, [ctx])
  const status = ui.status
  const live = call.state !== 'idle'
  const blocked = !live && status && !status.available
  const s = (status && status.settings) || {}
  const who = s.persona_name || 'Hermes'
  const via = choiceOf(status) === 'auto' ? chainText(status) : `only ${pickerSummary(status)}`
  const label = call.state === 'connecting'
    ? (call.switching ? 'Switching voice provider' : 'Connecting voice')
    : live ? (call.delegations ? `${servingLabel()}: ${who} is working (click to hang up)` : `${servingLabel()}: ${who} is listening (click to hang up)`)
      : blocked ? status.message : (call.detail || `Talk with ${who} (${via}). Right-click to choose the voice provider.`)
  return h('span', { className: 'inline-flex shrink-0 items-center' },
    h('button', {
      type: 'button',
      title: label,
      'aria-label': label,
      'aria-pressed': live,
      disabled: !!blocked,
      onClick: () => (live ? tearDown('') : void start(ctx)),
      // Right-click (desktop) or long-press (Android Chrome fires contextmenu) opens the picker.
      onContextMenu: ev => { if (ev && ev.preventDefault) ev.preventDefault(); ui.open = true; void refreshStatus(ctx); publish() },
      className: 'inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors ' +
        'hover:bg-muted disabled:opacity-50 ' + (live ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground')
    }, h(live ? icons.PhoneOff || icons.VolumeX : icons.AudioLines, { className: icons.iconSize.sm })),
    h(ProviderPicker, { ctx }))
}

// The status-bar chip always names the provider serving the call.
export function chipText () {
  if (call.state === 'idle') return ''
  if (call.state === 'connecting') return call.switching ? 'Voice: switching provider' : 'Voice: connecting'
  return call.delegations ? `${servingLabel()}: Hermes working (${call.delegations})` : `${servingLabel()}: on call`
}

function StatusChip () {
  useCall()
  if (call.state === 'idle') return null
  return h('button', {
    type: 'button',
    title: 'Hang up',
    onClick: () => tearDown(''),
    className: 'px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)'
  }, chipText())
}

// Every assistant reply on the pinned chat is handed to the voice while the call is up — not only
// the reply to a counted delegation. A delegated turn often ends with "I've asked a sub-agent" and
// the real answer arrives in a LATER turn on the same session (async delegation completion, a
// queued follow-up, a reply to something typed mid-call); counting delegations dropped those.
// Interim assistant text sealed during the turn (message.interim) is kept with the final text.
// v0.3: the whole text is handed over (v0.2 kept only its last 3000 characters), in parts.
// v0.4: a reply that lands during a provider switch is queued and spoken by the next provider.
const onPinnedChat = event => !!(event && call.state !== 'idle' && call.sessionId && event.session_id === call.sessionId)

export function onMessageStart (event) {
  if (!onPinnedChat(event) || !isHermes()) return
  relayStart()
}

// brain: hermes: Hermes' reply is read while it streams, sentence by sentence.
export function onMessageDelta (event) {
  if (!onPinnedChat(event) || !isHermes()) return
  const payload = event.payload || {}
  relayDelta(payload.text === null ? null : payload.text)
}

export function onMessageInterim (event) {
  if (!onPinnedChat(event)) return
  if (isHermes()) { relayInterim(event.payload || {}); return }
  const text = textOf((event.payload || {}).text).replace(/\s+/g, ' ').trim()
  if (text) call.interim.push(text)
}

export function onMessageComplete (event) {
  if (!onPinnedChat(event)) return
  const payload = event.payload || {}
  if (isHermes()) { relayComplete(payload); publish(); return }
  const final = textOf(payload.text).trim()
  const interim = call.interim
  call.interim = []
  const flat = final.replace(/\s+/g, ' ')
  const parts = interim.filter(t => !flat.includes(t))
  if (final) parts.push(final)
  const owed = call.delegations > 0
  if (owed) call.delegations -= 1
  if (parts.length) {
    enqueueResult(parts.join('\n\n')) // a silent reply ([SILENT], NO_REPLY) queues nothing
  } else if (owed) {
    enqueueResult(payload.status === 'error' || payload.error
      ? `Hermes stopped with an error: ${textOf(payload.error || payload.failure_reason || 'unknown').slice(0, 300)}`
      : 'Hermes finished without a text answer.')
  }
  // else: an empty turn nobody is waiting for (e.g. an interrupted queued turn)
  publish()
}

// ── v0.7: wake word ("hey ray" starts this call) ───────────────────────────────────────────────
// The detector runs in the gateway (gemini_live_chat/wake.py, core's sherpa engine) while core's own
// wake word is off. A detection arrives as plugin.gemini-live-chat.wake.detected {token}; the first
// eligible window to claim the token starts the call on its open chat. The detector has already
// released the microphone when the event is sent; a call started from the button pauses it first
// (micReleased). Every hang-up re-arms it (resumeWake in tearDown).
export const wake = { armed: false, owned: false, status: null, ctx: null, starting: false, pollTimer: null, lastError: '' }
export const WAKE_POLL_MS = 45000 // v0.8: idle check that the detector is still up (gateway restart)
const WAKE_UP = ['arming', 'listening', 'paused']

async function wakeRest (path, body = {}) {
  const ctx = wake.ctx
  if (!ctx || !ctx.rest) return null
  try { return await ctx.rest(path, { method: 'POST', body }) } catch { return null }
}

export async function armWake (ctx) {
  wake.ctx = ctx
  let s
  try { s = await ctx.rest('/wake/arm', { method: 'POST', body: {} }) } catch { s = null }
  if (!s) return s // gateway unreachable (restarting): keep the last known state; the next check retries
  wake.status = s
  wake.armed = !!(s.enabled && WAKE_UP.includes(s.state))
  const err = s.enabled && s.state === 'error' && s.error ? s.error : ''
  if (err && err !== wake.lastError) host.notify({ kind: 'warning', message: 'Wake word: ' + err }) // once per error
  wake.lastError = err
  return s
}

// v0.8: the detector lives in the gateway; a gateway restart kills it while this window stays loaded.
// Re-arm (POST /wake/arm, idempotent) when the gateway socket comes back, and when the idle check
// finds it down. Never during a call or while a wake is being claimed: the call holds the mic, and
// tearDown's resumeWake re-arms after it.
export async function rearmWake (reason) {
  if (!wake.ctx || call.state !== 'idle' || wake.starting) return null
  wake.owned = false // a restarted detector is not paused by this window
  return armWake(wake.ctx)
}

export async function checkWake () {
  if (!wake.ctx || call.state !== 'idle' || wake.starting) return null
  let s
  try { s = await wake.ctx.rest('/wake', { method: 'GET' }) } catch { s = null }
  if (!s || call.state !== 'idle' || wake.starting) return null
  if (!s.enabled) { wake.status = s; wake.armed = false; return s }
  if (WAKE_UP.includes(s.state)) { wake.status = s; wake.armed = true; return s }
  return rearmWake('poll')
}

function scheduleWakePoll () {
  stopWakePoll()
  wake.pollTimer = E().setTimeout(() => {
    wake.pollTimer = null
    void Promise.resolve(checkWake()).catch(() => {}).finally(() => { if (wake.ctx) scheduleWakePoll() })
  }, WAKE_POLL_MS)
}

function stopWakePoll () {
  if (wake.pollTimer) { E().clearTimeout(wake.pollTimer); wake.pollTimer = null }
}

// host.state.gateway (SDK: the gateway WebSocket state, 'idle' | 'connecting' | 'open' | ...).
// Returns the disposer, or null on an SDK without the atom (the idle check still covers it).
export function watchGateway () {
  const g = host.state && host.state.gateway
  const sub = g && (typeof g.listen === 'function' ? g.listen : typeof g.subscribe === 'function' ? g.subscribe : null)
  if (!sub) return null
  let last = typeof g.get === 'function' ? g.get() : null
  const off = sub.call(g, v => {
    const was = last
    last = v
    if (v === 'open' && was !== 'open') void rearmWake('reconnect')
  })
  return typeof off === 'function' ? off : null
}

// Only this window answers when the setting says so: "desktop" (default) = the Hermes Desktop app;
// the PC's microphone heard the phrase, so a phone tab must not start talking.
export function wakeEligible () {
  const surface = (wake.status && wake.status.surface) || 'desktop'
  return surface === 'any' || !!E().isDesktopApp()
}

export async function onWakeDetected (ev) {
  const payload = (ev && ev.payload) || ev || {}
  if (!wake.ctx || !payload.token || call.state !== 'idle' || wake.starting || !wakeEligible()) return false
  wake.starting = true
  try {
    const r = await wakeRest('/wake/claim', { token: payload.token })
    if (!r || !r.claimed || call.state !== 'idle') return false // another window took it
    wake.owned = true // the detector paused itself (mic released) before sending the event
    call.fromWake = true
    await start(wake.ctx) // the open chat, as with the button; "כן?" once the call is up
    if (call.state === 'idle') { call.fromWake = false; resumeWake() } // no chat open: listen again
    return true
  } finally {
    wake.starting = false
  }
}

// Wait until the wake detector no longer holds the microphone (the wakePauseBarrier pattern of
// core's composer). The gateway answers after pause_listening() returned, i.e. the stream is closed.
async function micReleased () {
  if (!wake.armed || wake.owned) return
  const r = await wakeRest('/wake/pause')
  wake.owned = !!(r && r.paused)
}

function resumeWake () {
  if (!wake.armed || !wake.owned) return // only a detector this window paused is re-armed
  wake.owned = false
  void wakeRest('/wake/resume')
}

export default {
  id: PLUGIN_ID,
  name: 'Live voice (Gemini / ChatGPT)',
  defaultEnabled: false,
  register (ctx) {
    ctx.onEvent('message.complete', onMessageComplete)
    ctx.onEvent('message.interim', onMessageInterim)
    ctx.onEvent('message.start', onMessageStart) // v0.6 brain: hermes streaming
    ctx.onEvent('message.delta', onMessageDelta)
    ctx.onEvent('plugin.gemini-live-chat.wake.detected', ev => { void onWakeDetected(ev) }) // v0.7
    void armWake(ctx)
    // v0.8: re-arm after a gateway restart (socket reconnect, plus a slow idle check).
    const offGateway = watchGateway()
    scheduleWakePoll()
    // Disable / unload / hot-reload: hang up and release everything (mic, sockets, peer, audio).
    ctx.onDispose(() => {
      if (offGateway) offGateway()
      stopWakePoll()
      tearDown()
      wake.ctx = null
    })
    ctx.register({ id: 'talk', area: 'composer.actions', order: 42, render: () => h(VoiceButton, { ctx }) })
    ctx.register({ id: 'status', area: 'statusBar.right', order: 140, render: () => h(StatusChip, {}) })
  }
}
