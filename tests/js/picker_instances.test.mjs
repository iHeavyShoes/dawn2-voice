// node --test 'tests/js/*.test.mjs' — v0.9.1: the provider picker opens on Hermes Desktop.
// Desktop keeps one composer mounted per kept-alive chat tab / split pane, so the composer action
// (voice button + chevron Popover) exists several times. These tests mirror the two Radix
// behaviours that closed it there (radix-ui 1.7.0, Hermes Desktop's version):
//  * PopoverTrigger: onClick = composeEventHandlers(props.onClick, onOpenToggle), i.e. our onClick
//    runs first, then (unless it called preventDefault) onOpenChange(!open) with the render-time open.
//  * PopoverContent (DismissableLayer + FocusScope): an open content takes focus; focus landing in
//    another layer is "outside", so with two open contents both call onOpenChange(false).
// The same scenario was reproduced with the real React 19.3 + radix-ui 1.7.0 in jsdom before the
// fix (2+ composers: content never stays mounted); that repro is not part of CI (no node_modules).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSdk, loadPlugin, makeEnv, makeCtx } from './harness.mjs'

const sdk = makeSdk()
const P = await loadPlugin(sdk)
P.setEnv(makeEnv().env) // fake timers: register() schedules the wake poll

const STATUS = { available: true, settings: {}, picker: { choice: 'auto', persistent: true, options: [
  { id: 'auto', label: 'Auto (fallback chain)', state: 'ready', detail: 'x', selected: true }] } }

let talk, ctx
beforeEach(() => {
  P.ui.open = false
  P.ui.owner = null
  P.pickers.clear()
  ctx = makeCtx({ status: () => STATUS })
  const registered = []
  P.default.register({ ...ctx, onEvent: () => {}, onDispose: () => {}, register: r => registered.push(r) })
  talk = registered.find(r => r.id === 'talk')
})

// Mount one composer action; the fake React runs no effects, so register the instance by hand the
// way VoiceButton's mount effect does (`el` stands for its wrapper element).
function mount (el = null) {
  const r = talk.render()
  const voice = r[0](r[1])
  const pickerEl = voice.at(-1)
  P.pickers.set(pickerEl[1].id, el)
  return { id: pickerEl[1].id, voice, pickerEl }
}
const popover = inst => inst.pickerEl[0](inst.pickerEl[1]) // [Popover, { open, onOpenChange }, trigger, content]

function radixTriggerClick (inst) {
  const pop = popover(inst)
  const ev = { defaultPrevented: false, preventDefault () { this.defaultPrevented = true } }
  pop[2][1].onClick && pop[2][1].onClick(ev)
  if (!ev.defaultPrevented) pop[1].onOpenChange(!pop[1].open) // onOpenToggle, render-time `open`
}
function radixFocusSettle (instances) {
  const open = instances.map(popover).filter(p => p[1].open)
  if (open.length > 1) open.forEach(p => p[1].onOpenChange(false)) // each sees focus outside
  return instances.map(popover).filter(p => p[1].open).length
}

test('chevron opens exactly one picker when several composers are mounted (Desktop tabs/panes)', () => {
  const hidden = { closest: () => ({}) } // inside [data-pane-hidden]
  const shown = { closest: () => null }
  const insts = [mount(hidden), mount(hidden), mount(shown)]
  radixTriggerClick(insts[2])
  assert.equal(P.ui.open, true)
  assert.equal(radixFocusSettle(insts), 1, 'one open PopoverContent, so Radix has nothing to dismiss')
  assert.equal(P.ui.open, true, 'still open after the focus settles')
  assert.equal(popover(insts[2])[1].open, true, 'the clicked instance is the one that is open')
  // a second click closes it
  radixTriggerClick(insts[2])
  assert.equal(P.ui.open, false)
  assert.equal(radixFocusSettle(insts), 0)
})

test('right-click on the voice button opens the picker of that composer only', () => {
  const insts = [mount({ closest: () => ({}) }), mount({ closest: () => null })]
  const span = insts[1].voice
  span[1].onContextMenu({ preventDefault () {} })
  assert.equal(radixFocusSettle(insts), 1)
  assert.equal(popover(insts[1])[1].open, true)
  assert.equal(popover(insts[0])[1].open, false)
})

test('a notification action opens the picker in the visible composer, not a hidden tab', () => {
  const insts = [mount({ closest: () => null }), mount({ closest: () => ({}) })]
  P.openPicker(ctx)
  assert.equal(radixFocusSettle(insts), 1)
  assert.equal(popover(insts[0])[1].open, true, 'the hidden (last-mounted) tab is skipped')
})

test('a stray close from an instance that does not own the picker is ignored', () => {
  const insts = [mount(), mount()]
  radixTriggerClick(insts[1])
  popover(insts[0])[1].onOpenChange(false)
  assert.equal(P.ui.open, true)
  popover(insts[1])[1].onOpenChange(false) // Escape / outside click on the open one
  assert.equal(P.ui.open, false)
})

test('the picker diagnostic is off by default and writes counts only when on', async () => {
  const writes = []
  const files = { writeText: async (folder, name, text) => { writes.push({ folder, name, text }); return { ok: true } },
    stat: async () => ({ ok: true, exists: false }) }
  const dctx = { ...ctx, files }
  const insts = [mount()]
  P.openPicker(dctx, true, insts[0].id)
  assert.equal(writes.length, 0, 'off by default')
  files.stat = async () => ({ ok: true, exists: true })
  assert.equal(await P.checkPickerDebugFile(dctx), true)
  P.pickerOpenChange(dctx, insts[0].id, false)
  assert.equal(writes.length, 2, 'onOpenChange, then the openPicker it caused')
  assert.ok(writes.every(w => w.folder === 'data' && w.name === 'picker-debug.jsonl'))
  const lines = writes.at(-1).text.trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(lines.map(l => l.ev), ['onOpenChange', 'openPicker'])
  const allowed = new Set(['accepted', 'by', 'desktop', 'ev', 'instances', 'open', 'owner', 'self', 't', 'value', 'visibleOwner', 'want',
    'contents', 'focusInContent', 'triggers', 'wasOpen'])
  for (const l of lines) {
    for (const [k, v] of Object.entries(l)) {
      assert.ok(allowed.has(k), `unexpected key ${k}`)
      assert.ok(v === null || ['boolean', 'number'].includes(typeof v) || /^(picker-\d+|[a-zA-Z.+0-9]+)$/.test(v), `content-free value for ${k}`)
    }
  }
  P.pickerDbg.file = false
  P.pickerDbg.lines = []
})
