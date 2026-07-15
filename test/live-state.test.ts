// Live analog state: the unsolicited 5a (smeter) / 5b (squelch) pushes drive RadioState.
// Deterministic unit checks on crafted frames, plus a whole-corpus replay that proves the
// signals actually toggle over real traffic. (DMR pushes 5e/58/59 are a later slice.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { Framer } from '../src/codec/framing'
import { applyFrame, reduceFrames } from '../src/domain/reduce'
import { initialState, RadioState } from '../src/domain/state'
import { concatAll, hexToBytes, loadCapture } from './capture'

function withChecksum(prefix: number[], totalLen: number): Uint8Array {
  const b = new Uint8Array(totalLen)
  b.set(prefix, 0)
  let sum = 0
  for (let i = 0; i < totalLen - 1; i += 1) sum = (sum + b[i]!) & 0xff
  b[totalLen - 1] = sum
  return b
}
function frame(bytes: Uint8Array) {
  return { head: bytes[0]!, reg: undefined, bytes, checksumOk: true }
}

test('5b drives squelchOpen', () => {
  let s = initialState()
  assert.equal(s.audioGate, false)
  s = applyFrame(s, frame(hexToBytes('5b 01 5c')))
  assert.equal(s.audioGate, true)
  s = applyFrame(s, frame(hexToBytes('5b 00 5b')))
  assert.equal(s.audioGate, false)
})

test('5a resolves the smeter to physical sides via selectedSide', () => {
  // selected RSSI @1, other @2, open mask @5 (0x02 = selected open)
  const f = withChecksum([0x5a, 0x04, 0x00, 0x2a, 0x40, 0x02, 0xff, 0x8a, 0, 0, 0, 0, 0, 0x01], 16)
  // default selectedSide 'a' → selected→a, other→b
  assert.deepEqual(applyFrame(initialState(), frame(f)).signal, { aRssi: 4, bRssi: 0, aOpen: true, bOpen: false, holder: 'a', focus: 'b' })
  // selectedSide 'b' flips the mapping: selected→b, other→a
  const onB = applyFrame({ ...initialState(), selectedSide: 'b' }, frame(f))
  assert.deepEqual(onB.signal, { aRssi: 0, bRssi: 4, aOpen: false, bOpen: true, holder: 'b', focus: 'b' })
})

// Real frames from the live per-side-squelch capture (5a byte-5 = per-side open mask, relative to
// the selected side; bit1 = selected, bit2 = other, bit0 = DMR timeslot which must be ignored).
test('5a byte-5 decodes per-side squelch open (analog + DMR), mapped via selectedSide', () => {
  const bytes = (hex: string) => hexToBytes(hex)
  const sig = (hex: string, sel: 'a' | 'b' = 'a') =>
    applyFrame({ ...initialState(), selectedSide: sel }, frame(bytes(hex))).signal

  // other side receiving, selected silent → 0x04
  assert.deepEqual(sig('5a 00 04 0c 00 04 ff 8a 00 00 00 00 00 01 00 f8'), { aRssi: 0, bRssi: 4, aOpen: false, bOpen: true, holder: 'b', focus: 'a' })
  // both sides open → 0x06
  assert.deepEqual(sig('5a 03 04 0e 40 06 ff 8a 00 00 00 00 00 01 00 3f'), { aRssi: 3, bRssi: 4, aOpen: true, bOpen: true, holder: 'a', focus: 'b' })
  // selected (active) side open, other silent → 0x02
  assert.deepEqual(sig('5a 04 00 0a 40 02 ff 8a 00 00 00 00 00 01 00 34'), { aRssi: 4, bRssi: 0, aOpen: true, bOpen: false, holder: 'a', focus: 'b' })
  // both closed → 0x00
  assert.deepEqual(sig('5a 00 00 08 40 00 ff 8a 00 00 00 00 00 00 00 2b'), { aRssi: 0, bRssi: 0, aOpen: false, bOpen: false, holder: null, focus: 'b' })

  // DMR: bit0 (timeslot) set but bit1 clear → still CLOSED (0x01), and bit1 set → OPEN (0x03)
  assert.equal(sig('5a 04 00 0a 40 01 ff 8a 00 00 00 00 00 00 00 32').aOpen, false, '0x01 = DMR slot bit, not open')
  assert.equal(sig('5a 04 00 0a 40 03 ff 8a 00 00 00 00 00 01 00 35').aOpen, true, '0x03 = open + DMR slot bit')
})

// Startup hydration: the enumeration READS these registers (`04 5a` / `04 5b`) rather than waiting
// for a push — the replies are the push payloads behind an `04` prefix and must land through the
// same decoders, so the UI's first snapshot already carries live squelch/RSSI.
test('04 5a read reply (startup/refresh) hydrates the smeter + per-side open like a 5a push', () => {
  const read = (prefix: number[]) => {
    const bytes = withChecksum(prefix, 17)
    return { head: 0x04, reg: 0x5a, bytes, checksumOk: true }
  }
  // read form = push shifted by the 04 prefix: selected RSSI @2, other @3, open mask @6
  const s = applyFrame(initialState(), read([0x04, 0x5a, 0x04, 0x00, 0x2a, 0x40, 0x02, 0xff, 0x8a]))
  assert.deepEqual(s.signal, { aRssi: 4, bRssi: 0, aOpen: true, bOpen: false, holder: 'a', focus: 'b' })
  // and it resolves through selectedSide exactly like the push does
  const onB = applyFrame(
    { ...initialState(), selectedSide: 'b' },
    read([0x04, 0x5a, 0x03, 0x02, 0x2a, 0x40, 0x04, 0xff, 0x8a]),
  )
  assert.deepEqual(onB.signal, { aRssi: 2, bRssi: 3, aOpen: true, bOpen: false, holder: 'a', focus: 'b' })
})

test('04 5b read reply (startup) hydrates squelchOpen like a 5b push', () => {
  const read = (open: number) => {
    const bytes = withChecksum([0x04, 0x5b, open], 4)
    return { head: 0x04, reg: 0x5b, bytes, checksumOk: true }
  }
  assert.equal(applyFrame(initialState(), read(1)).audioGate, true)
  assert.equal(applyFrame({ ...initialState(), audioGate: true }, read(0)).audioGate, false)
})

// Zone count from `04 1b` byte 36 — the BT-01's own bound for zone navigation (it never walks
// zone names). Real-capture layout: mostly zeros/ff with the count at 36; live-matched 2026-07-02.
test('04 1b hydrates zoneCount on BOTH sides from byte 36', () => {
  const mk = (count: number, len = 60) => {
    const bytes = withChecksum([0x04, 0x1b], len)
    if (len > 36) bytes[36] = count
    return { head: 0x04, reg: 0x1b, bytes, checksumOk: true }
  }
  const s = applyFrame(initialState(), mk(0x0b))
  assert.equal(s.sides.a.zoneCount, 11)
  assert.equal(s.sides.b.zoneCount, 11)
  // implausible values (0, >250) and short frames leave the prior count untouched
  assert.equal(applyFrame(s, mk(0)).sides.a.zoneCount, 11)
  assert.equal(applyFrame(s, mk(0xfe)).sides.a.zoneCount, 11)
  assert.equal(applyFrame(s, mk(5, 20)).sides.a.zoneCount, 11)
})

test('the 05 block sets the active side from byte 37 (0=A / 1=B)', () => {
  const mk = (b37: number) => {
    const bytes = withChecksum([0x04, 0x05], 40)
    bytes[37] = b37
    return { head: 0x04, reg: 0x05, bytes, checksumOk: true }
  }
  assert.equal(applyFrame({ ...initialState(), selectedSide: 'a' }, mk(1)).selectedSide, 'b')
  assert.equal(applyFrame({ ...initialState(), selectedSide: 'b' }, mk(0)).selectedSide, 'a')
  // a short/odd 05 (e.g. a relay status-probe) leaves the prior side untouched
  const short = { head: 0x04, reg: 0x05, bytes: withChecksum([0x04, 0x05, 0x00], 7), checksumOk: true }
  assert.equal(applyFrame({ ...initialState(), selectedSide: 'b' }, short).selectedSide, 'b')
})

test('a 05 read-back that matches a pending side-select clears the pending flag', () => {
  const mk = (b37: number) => {
    const bytes = withChecksum([0x04, 0x05], 40)
    bytes[37] = b37
    return { head: 0x04, reg: 0x05, bytes, checksumOk: true }
  }
  // pending switch to B, read-back confirms B → selectedSide=b, pendingSide cleared
  const confirmed = applyFrame({ ...initialState(), selectedSide: 'a', pendingSide: 'b' }, mk(1))
  assert.equal(confirmed.selectedSide, 'b')
  assert.equal(confirmed.pendingSide, null)
  // pending switch to B, but a read-back still showing A leaves the pending flag in place
  const stillPending = applyFrame({ ...initialState(), selectedSide: 'a', pendingSide: 'b' }, mk(0))
  assert.equal(stillPending.selectedSide, 'a')
  assert.equal(stillPending.pendingSide, 'b')
})

// 5a byte 7 = radio-state field; 0x86/0x87 bracket TX (live-pinned Sitting 1). Only the two
// proven values read as transmitting — idle (0x89/0x8a) and unpinned values (0x85/0x88/0x8b)
// read false, so an unknown state can never fake a TX indication.
test('5a byte 7 drives transmitting (0x86/0x87 only)', () => {
  const mk = (b7: number) => withChecksum([0x5a, 0, 0, 0x08, 0, 0, 0xff, b7], 16)
  assert.equal(applyFrame(initialState(), frame(mk(0x86))).transmitting, true)
  assert.equal(applyFrame(initialState(), frame(mk(0x87))).transmitting, true)
  assert.equal(applyFrame(initialState(), frame(mk(0x89))).transmitting, false)
  assert.equal(applyFrame(initialState(), frame(mk(0x8a))).transmitting, false)
  assert.equal(applyFrame(initialState(), frame(mk(0x88))).transmitting, false, 'unpinned value reads idle')
  // and it clears when the radio returns to idle
  const during = applyFrame(initialState(), frame(mk(0x86)))
  assert.equal(applyFrame(during, frame(mk(0x89))).transmitting, false)
})

test('a too-short 5a is ignored (no partial decode)', () => {
  const s = applyFrame(initialState(), frame(hexToBytes('5a 04 00')))
  assert.deepEqual(s.signal, initialState().signal)
})

const WIRE = resolve(dirname(fileURLToPath(import.meta.url)), '../captures/wire.ndjson')

test(
  'replaying real traffic exercises squelch + smeter (both states observed)',
  { skip: existsSync(WIRE) ? false : 'wire capture not present' },
  () => {
    const rx = loadCapture(WIRE).filter((f) => f.dir === 'rx')
    const f = new Framer()
    f.push(concatAll(rx.map((x) => x.bytes)))
    let state = initialState()
    let sqOpen = false
    let sqClosed = false
    let sawRssi = false
    let maxRssi = 0
    for (const fr of f.drain()) {
      state = applyFrame(state, fr)
      if (state.audioGate) sqOpen = true
      else sqClosed = true
      maxRssi = Math.max(maxRssi, state.signal.aRssi, state.signal.bRssi)
      if (maxRssi > 0) sawRssi = true
    }
    assert.doesNotThrow(() => RadioState.parse(state))
    assert.ok(sqOpen && sqClosed, 'squelch opened and closed over the corpus')
    assert.ok(sawRssi, 'observed nonzero RSSI')
    assert.ok(maxRssi < 32, `RSSI in a sane uncalibrated range (saw max ${maxRssi})`)
  },
)

// reduceFrames stays equivalent to folding applyFrame
test('reduceFrames folds applyFrame', () => {
  const frames = [frame(hexToBytes('5b 01 5c')), frame(hexToBytes('5b 00 5b'))]
  const viaReduce = reduceFrames(frames, initialState())
  let viaFold = initialState()
  for (const fr of frames) viaFold = applyFrame(viaFold, fr)
  assert.deepEqual(viaReduce, viaFold)
})

// ── the AUDIO-HOLDER latch (ear+clip-proven 2026-07-13): the mono audio path is a latch — first
// side to open keeps the audio; instant transfer when the holder releases while the other side
// receives; the released side reopening does NOT reclaim; tail-holds through its own squelch
// close while the 5b gate is up; resets when the whole gate closes. FOCUS (byte 4) seeds the
// latch for 5b-only audio when it points away from the selected side.
import { activeReceive } from '../src/domain/receive'

test('audio-holder latch: first-wins, instant transfer, no reclaim, tail-hold, gate-close reset', () => {
  const push = (selRssi: number, othRssi: number, mask: number, focusB = false) =>
    frame(withChecksum([0x5a, selRssi, othRssi, 0x08, focusB ? 0x40 : 0x00, mask, 0xff, 0x89, 0, 0, 0, 0, 0, mask ? 0x01 : 0x00], 16))

  let s = initialState() // selected 'a': mask bit1 = A, bit2 = B
  s = applyFrame(s, push(4, 0, 0x02)) // A opens first
  assert.equal(s.signal.holder, 'a')
  s = applyFrame(s, push(4, 4, 0x06)) // B joins — the holder keeps the audio
  assert.equal(s.signal.holder, 'a')
  s = applyFrame(s, push(0, 4, 0x04)) // A releases while B receives → INSTANT transfer
  assert.equal(s.signal.holder, 'b')
  s = applyFrame(s, push(4, 4, 0x06)) // A reopens — no reclaim
  assert.equal(s.signal.holder, 'b')
  s = applyFrame(s, push(4, 0, 0x02)) // B ends while A still open → hands back
  assert.equal(s.signal.holder, 'a')

  // tail: the holder's own squelch closes but the 5b gate is still up → the latch holds
  s = applyFrame(s, frame(hexToBytes('5b 01 5c')))
  s = applyFrame(s, push(0, 0, 0x00))
  assert.equal(s.signal.holder, 'a', 'tail-holds while the gate is up')
  // the gate closes with the bits down → reset
  s = applyFrame(s, frame(hexToBytes('5b 00 5b')))
  assert.equal(s.signal.holder, null)

  // 5b-only audio (no per-side bits — undecoded DMR): FOCUS pointing off-selected seeds the latch
  let d = applyFrame(initialState(), frame(hexToBytes('5b 01 5c')))
  d = applyFrame(d, push(0, 0, 0x00, true)) // focus = B ≠ selected(A) → B is the sole active side
  assert.equal(d.signal.holder, 'b')
  // focus == selected is the idle default — ambiguous, stays unlatched
  let amb = applyFrame(initialState(), frame(hexToBytes('5b 01 5c')))
  amb = applyFrame(amb, push(0, 0, 0x00, false))
  assert.equal(amb.signal.holder, null)
})

test('activeReceive follows the holder: overlaps and tails attribute to the side whose audio is playing', () => {
  const base = initialState() // selected 'a'
  // Overlap, holder = B (B opened first), selected = A: the old selected-side tiebreak said A —
  // the latch says B, and B it is.
  const overlap: RadioState = { ...base, signal: { ...base.signal, aOpen: true, bOpen: true, holder: 'b' } }
  const r1 = activeReceive(overlap, true)
  assert.equal(r1.side, 'b')
  assert.equal(r1.source, 'analog', "the holder's own squelch is open — plain side evidence")
  // Tail: holder's bit closed, gate still open → side sticks with the holder, source 'holder'
  const tail: RadioState = { ...base, audioGate: true, signal: { ...base.signal, holder: 'b' } }
  const r2 = activeReceive(tail, true)
  assert.equal(r2.side, 'b')
  assert.equal(r2.source, 'holder')
})
