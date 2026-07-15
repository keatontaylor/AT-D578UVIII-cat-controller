// DMR live activity: the 5e link-state push (+ 58 alias) decode into the `dmr` state slice.
// Group vs private falls out of source==dest; alias merges from the 58 talker push; idle clears.
// 5e layout (18B): b1 00 idle/01 RX/02 TX, b2 0x40=voice frame, b7 CC, b8-11 src BCD, b12 slot,
// b13-16 dest BCD. b17 = checksum (the frame() helper marks checksumOk directly).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeDmr, decodeDmrAlias } from '../src/codec/decode'
import { applyFrame, applyEvent } from '../src/domain/reduce'
import { initialState, type RadioState } from '../src/domain/state'
import { dmrRxOn, dmrBusy, dmrSideFor, vfoView } from '../src/domain/view'
import { audioGateOpen } from '../src/domain/receive'
import { hexToBytes } from './capture'

const frame = (hex: string) => {
  const b = hexToBytes(hex)
  return { head: b[0]!, reg: b[0] === 0x04 ? b[1]! : undefined, bytes: b, checksumOk: true }
}

// PARROT private call: src 3223436 (@8-11 = 03 22 34 36) != dst 310997 (@13-16 = 00 31 09 97).
const PARROT_5E = '5e 01 61 00 00 00 00 01 03 22 34 36 00 00 31 09 97 00'
// Group call: TG 67498 (00 06 74 98) in BOTH src and dest slots.
const GROUP_5E = '5e 01 61 00 00 00 00 01 00 06 74 98 00 00 06 74 98 00'

test('decodeDmr reads a private voice frame (src != dst)', () => {
  const d = decodeDmr(hexToBytes(PARROT_5E))
  assert.ok(d)
  assert.equal(d!.direction, 'rx')
  assert.equal(d!.source, 3223436)
  assert.equal(d!.dest, 310997)
  assert.equal(d!.private, true)
  assert.equal(d!.colorCode, 1)
  assert.equal(d!.slot, 1)
})

test('decodeDmr: a group voice frame (src == dst) is not private', () => {
  const d = decodeDmr(hexToBytes(GROUP_5E))
  assert.ok(d)
  assert.equal(d!.source, 67498)
  assert.equal(d!.dest, 67498)
  assert.equal(d!.private, false)
})

test('decodeDmr: idle (byte1 == 0) → null; zero-identity control frame (0x21) → no src/dest', () => {
  assert.equal(decodeDmr(hexToBytes('5e 00 21 00 00 00 00 0d 00 00 00 00 00 00 00 00 00 00')), null)
  const ctrl = decodeDmr(hexToBytes('5e 01 21 00 00 00 00 0d 00 00 00 00 00 00 00 00 00 00'))
  assert.ok(ctrl)
  assert.equal(ctrl!.source, null, 'zeroed identity → nothing claimed')
  assert.equal(ctrl!.colorCode, null, 'byte7 here is an LC/reason code, NOT a color code')
})

test('decodeDmr trusts CARRIED identity regardless of the byte-2 frame type (wire-pinned 2026-07-10)', () => {
  // Byte-exact from the live capture that reproduced the every-other-call dropout: TG 5031320
  // group call, CC 1, TS2 — byte 2 = 0x24/0x20 (NO 0x40 "voice" bit), identity fully populated.
  for (const hex of [
    '5e 01 24 02 02 02 00 01 05 03 13 20 01 05 03 13 20 01',
    '5e 01 20 02 00 00 00 01 05 03 13 20 01 05 03 13 20 f9',
    '5e 01 64 22 02 02 00 01 05 03 13 20 01 05 03 13 20 61', // 0x40-bit variant of the same call
  ]) {
    const d = decodeDmr(hexToBytes(hex))
    assert.ok(d, hex)
    assert.equal(d!.direction, 'rx')
    assert.equal(d!.colorCode, 1, hex)
    assert.equal(d!.slot, 2, hex)
    assert.equal(d!.source, 5031320, hex)
    assert.equal(d!.dest, 5031320, hex)
    assert.equal(d!.private, false, 'src == dest → group call')
  }
})

test('5e push drives the dmr slice; idle clears it', () => {
  let s = applyFrame(initialState(), frame(PARROT_5E))
  assert.equal(s.dmr?.source, 3223436)
  assert.equal(s.dmr?.private, true)
  s = applyFrame(s, frame('5e 00 21 00 00 00 00 0d 00 00 00 00 00 00 00 00 00 00'))
  assert.equal(s.dmr, null, 'idle push clears the call')
})

test('scan-sample 5e does not corrupt a PRESENTED call (dual-receive scan bug)', () => {
  // One side holds a live PRESENTED call (PARROT, dest 310997); the OTHER side scans and the
  // radio pushes scan-engine SAMPLES of other channels into the same single dmr slice. A sample
  // (unpresented, DIFFERENT dest) must not overwrite the presented call — else resolveDmrSide
  // loses its side and the smeter/caller vanish until the call ends.
  let s = applyFrame(initialState(), frame(PARROT_5E))
  // the 59 call-log push is the lock (58 only enriches) — see the 59-lock block below
  s = applyFrame(
    s,
    frame('59 00 00 31 09 97 52 4d 48 41 4d 00 00 00 00 00 00 00 00 00 00 00 00 00 03 22 34 36 50 41 52 52 4f 54 00 00 00 00 00 00 00 00 00 00 00'),
  )
  assert.equal(s.dmr?.presented, true)
  assert.equal(s.dmr?.dest, 310997)

  // scan sample: an UNPRESENTED 5e for a different channel (group TG 67498) — must be ignored
  s = applyFrame(s, frame(GROUP_5E))
  assert.equal(s.dmr?.dest, 310997, 'the scan sample did NOT overwrite the presented call')
  assert.equal(s.dmr?.private, true, 'nor its call type')

  // the call's OWN voice frame (same dest) still refreshes it
  s = applyFrame(s, frame(PARROT_5E))
  assert.equal(s.dmr?.dest, 310997)

  // and its genuine idle still clears the slice
  s = applyFrame(s, frame('5e 00 21 00 00 00 00 0d 00 00 00 00 00 00 00 00 00 00'))
  assert.equal(s.dmr, null, 'the real end-of-call idle still clears')
})

test('an UNPRESENTED call is still freely updated by any 5e (guard only protects presented)', () => {
  // Before presentation, scan samples legitimately populate the slice (they just do not render).
  let s = applyFrame(initialState(), frame(PARROT_5E)) // presented=false
  assert.equal(s.dmr?.presented ?? false, false)
  s = applyFrame(s, frame(GROUP_5E)) // a different sample overwrites freely (nothing presented)
  assert.equal(s.dmr?.dest, 67498)
})

// A minimal DMR channel config on side A so resolveDmrSide attributes a call to it.
const DIGITAL_A = {
  type: 'digital' as const, power: 'high' as const, bandwidthKHz: 12.5, reverse: false, txProhibit: false,
  talkaround: false, rxTone: null, txTone: null, squelchMode: null, optionalSignal: null, compander: null,
  scrambler: null, busyLock: null, colorCode: 1, timeSlot: 1, txInterrupt: null, aprsReceive: null,
  smsForbid: null, dataAckForbid: null, dmrMode: 'repeater' as const,
  contact: { callType: 'private' as const, talkgroup: 310997, name: 'X' },
}
/** State: a PRESENTED private DMR call on side A, side B selected + scanning, A's squelch open. */
function callOnA_scanningB(): RadioState {
  const base = applyFrame(initialState(), frame(PARROT_5E)) // dmr slice: dest 310997
  return {
    ...base,
    selectedSide: 'b' as const,
    sides: { ...base.sides, a: { ...base.sides.a, channel: DIGITAL_A } },
    dmr: { ...base.dmr!, presented: true },
    signal: { ...base.signal, aOpen: true, bOpen: false },
    scan: { ...base.scan, active: true },
  }
}

test('5c teardown does NOT clear a DMR call whose side is still receiving (scan-start dismissal)', () => {
  // Wire-pinned 2026-07-14 04:15:02: starting a scan makes the radio fire a 5c while the DMR call
  // on the other side is STILL LIVE (5a shows its side open). The old code cleared → smeter/caller
  // vanished for a call that hadn't ended and never came back.
  let s = callOnA_scanningB()
  s = applyFrame(s, frame('5c 07 01 00 00 00 00 00 00 00 00 00'))
  assert.ok(s.dmr, 'the live call is KEPT — its side (A) is still receiving')
  assert.equal(s.dmr?.dest, 310997)

  // once A actually goes quiet, a 5c IS the real end-of-call → clears
  s = { ...s, signal: { ...s.signal, aOpen: false } }
  s = applyFrame(s, frame('5c 07 01 00 00 00 00 00 00 00 00 00'))
  assert.equal(s.dmr, null, 'a 5c with the call side quiet is the genuine teardown')
})

test('scan-held DMR call clears when its side goes quiet (5e + 5c suppressed during scan)', () => {
  // During a scan the radio suppresses BOTH the 5e stream and the end-of-call 5c, so the only end
  // signal is the side's per-side 5a bit closing. applySmeter must clear the stale slice on it.
  let s = callOnA_scanningB()
  // a 5a with A (other, since B is selected) now CLOSED, scan still running (byte12 = 0x02)
  s = applyFrame(s, frame('5a 00 00 00 00 00 ff 89 00 00 00 00 02 00 00 00'))
  assert.equal(s.signal.aOpen, false, 'A closed')
  assert.equal(s.scan.active, true, 'still scanning')
  assert.equal(s.dmr, null, 'the stale scan-held call was cleared on the side-close edge')
})

test('NOT scanning: the side-close does not early-clear a call (normal 5c-driven hang preserved)', () => {
  let s = callOnA_scanningB()
  s = { ...s, scan: { ...s.scan, active: false } } // no scan
  // A closes, but not scanning → the slice survives (hang display waits for the real 5c)
  s = applyFrame(s, frame('5a 00 00 00 00 00 ff 89 00 00 00 00 00 00 00 00'))
  assert.ok(s.dmr, 'without a scan, the call persists through hang until its 5c')
})

// ── THE 59 LOCK: muted (busy) vs audible calls ──────────────────────────────────────────────────
// Wire-proven 2026-07-14: the 59 push is the radio WRITING ITS CALL LOG — it only fires for calls
// the radio routes to audio (corpus: 59-count tracks 5b-open exactly, 0↔0 in both muted captures).
// A muted (DigiMon-off non-matching) call streams 5e — and in some DigiMon states 58s too — with
// no 59, no 5b, no 5a open bits. So: no 59 lock → no call info rendered, only RSSI + BUSY.
const F58 = '58 00 00 00 00 00 03 22 34 36 50 41 52 52 4f 54 00 00 00 00 00 00 00 00 00 00'
// 59 push: dest BCD @2-5 (310997) · dest name @6-21 · caller BCD @24-27 · caller name @28-43
const F59 =
  '59 00 00 31 09 97 52 4d 48 41 4d 00 00 00 00 00 00 00 00 00 00 00 00 00 03 22 34 36 50 41 52 52 4f 54 00 00 00 00 00 00 00 00 00 00 00'

/** A DMR channel on side A, side A selected, one PARROT 5e applied. */
function dmrOnA(): RadioState {
  const base = initialState()
  const withChannel = { ...base, sides: { ...base.sides, a: { ...base.sides.a, channel: DIGITAL_A } } }
  return applyFrame(withChannel, frame(PARROT_5E))
}
const times = (s: RadioState, hex: string, n: number): RadioState => {
  for (let i = 0; i < n; i += 1) s = applyFrame(s, frame(hex))
  return s
}
/** The session's 59 lock window expiring (the ~2 s timer → dmrNoLock event). */
const lockExpires = (s: RadioState): RadioState => applyEvent(s, { kind: 'dmrNoLock' })

test('a MUTED call never renders call info — even with 58s — and reads NO MATCH when the lock window expires', () => {
  // The user's live DigiMon state (cap 05-54-31): 58 per transmission for a muted call. The 58
  // enriches internally but must not render; NO MATCH lands when the session's 2 s window fires.
  let s = applyFrame(dmrOnA(), frame(F58))
  assert.equal(s.dmr?.presented, false, 'the 58 popup line is NOT the lock')
  assert.equal(s.dmr?.alias, 'PARROT', 'but it still enriches the slice internally')
  assert.equal(dmrSideFor(s), null, 'never ATTRIBUTED as a live call without the 59 lock')
  assert.ok(vfoView(s, 'a').dmr, 'the INFO renders immediately (amber) — no wait on info')
  assert.equal(dmrBusy(s, 'a'), false, 'but no NO MATCH verdict yet — the lock may still arrive')
  s = lockExpires(s) // the session's 59 window fires — no 59 / no 5b / no 5a open bit came
  assert.equal(dmrSideFor(s), null, 'never ATTRIBUTED as a live call')
  assert.equal(dmrRxOn(s, 'a'), false)
  assert.equal(dmrBusy(s, 'a'), true, 'NO MATCH on the call side')
  assert.equal(dmrBusy(s, 'b'), false)
  // the decoded call info DOES render (amber) — the operator may want to flip DigiMon on
  const v = vfoView(s, 'a')
  assert.ok(v.dmr, 'the busy card carries the dmr slice')
  assert.match(v.dmrLive?.label ?? '', /TG 310997|PRIV/, 'tuple visible in the amber badge')
  assert.equal(vfoView(s, 'b').dmr, null, 'the other card carries nothing')
  assert.equal(audioGateOpen(s), false, 'and the recorder gate stays shut')
})

test('the 59 push IS the lock: renders the call and marks it audible', () => {
  let s = applyFrame(dmrOnA(), frame(F58))
  s = applyFrame(s, frame(F59))
  assert.equal(s.dmr?.presented, true)
  assert.equal(s.dmr?.audioRouted, true, 'the call-log write = the radio took this call')
  assert.equal(dmrSideFor(s), 'a')
  assert.equal(dmrRxOn(s, 'a'), true)
  assert.equal(dmrBusy(s, 'a'), false)
})

test('a PRIVATE call locks via the 59 CALLER field (its dest slot is stale)', () => {
  // Byte-exact from cap 16-30-21 (parrot private calls): the live 5e is src=3223436 dst=310997,
  // but the 59 record's dest slot holds the STALE last-group TG (05 06 74 98 = 5067498) — only
  // its caller field (310997, the transmitting station) identifies the call. The old dest-only
  // guard rejected every private 59 → the call never locked → NO MATCH on an audible call.
  const F59_PRIVATE =
    '59 00 05 06 74 98 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 31 09 97 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00'
  let s = dmrOnA() // live private call: src 3223436 → dst 310997
  s = applyFrame(s, frame(F59_PRIVATE))
  assert.equal(s.dmr?.presented, true, 'the private 59 locks the call')
  assert.equal(s.dmr?.audioRouted, true)
  assert.equal(s.dmr?.callerId, 310997, 'caller = the transmitting station')
  assert.equal(dmrRxOn(s, 'a'), true)
  assert.equal(dmrBusy(s, 'a'), false)

  // an UNRELATED record (neither dest nor caller matches either party) still never locks
  const F59_FOREIGN =
    '59 00 05 06 74 98 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 07 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00'
  let f = dmrOnA()
  f = applyFrame(f, frame(F59_FOREIGN))
  assert.equal(f.dmr?.presented, false, 'a foreign record locks nothing')
})

test('a late 59 flips a NO MATCH verdict to the full rendered call', () => {
  let s = lockExpires(dmrOnA())
  assert.equal(dmrBusy(s, 'a'), true)
  s = applyFrame(s, frame(F59))
  assert.equal(dmrBusy(s, 'a'), false)
  assert.equal(dmrRxOn(s, 'a'), true)
})

test('own 5a open bit RISING is backup audio evidence (audioRouted without rendering)', () => {
  // The per-side open bit is audio truth (a muted call never sets one) — its rising edge marks
  // the call audible for the recorder/attribution even before its 59 lands; rendering waits.
  let s = applyFrame(dmrOnA(), frame('5a 04 00 00 00 02 ff 89 00 00 00 00 00 00 00 00'))
  assert.equal(s.dmr?.audioRouted, true, 'own bit rising = audible')
  assert.equal(dmrSideFor(s), null, 'render still waits for the 59 lock')
  assert.equal(dmrBusy(s, 'a'), false, 'an audible call is never BUSY')
})

test('DigiMon toggled OFF mid-call: the rebuilt slice does NOT inherit the stale open bit', () => {
  // Live bug 2026-07-14 15:08 (cap 15-02-40 @345.336): flipping DigiMon off during an audible
  // call tears the presented slice down (idle) while the side's 5a bit is STILL UP from the
  // audible phase; the call keeps decoding and 5e rebuilds the slice immediately. A LEVEL check
  // handed the muted rebuild audioRouted=true with presented=false — rendering neither RX nor
  // BUSY. Evidence must be the bit's RISING edge during the call, never an inherited level.
  let s = applyFrame(dmrOnA(), frame(F59)) // audible phase: locked
  s = applyFrame(s, frame('5a 04 00 00 00 02 ff 89 00 00 00 00 00 00 00 00')) // A's bit up
  assert.equal(dmrRxOn(s, 'a'), true)
  // DigiMon off: the radio ends the presented call (5e idle) — bit still up for a beat
  s = applyFrame(s, frame('5e 00 21 00 00 00 00 0d 00 00 00 00 00 00 00 00 00 00'))
  assert.equal(s.dmr, null, 'the lapse')
  assert.equal(s.signal.aOpen, true, 'stale bit still up when 5e resumes')
  // the call keeps decoding — the slice rebuilds while the stale bit is STILL open
  s = applyFrame(s, frame(PARROT_5E))
  assert.equal(s.dmr?.audioRouted, false, 'stale level is NOT evidence')
  // the radio drops the bit shortly after (no rising edge for this slice)
  s = applyFrame(s, frame('5a 00 00 00 00 00 ff 89 00 00 00 00 00 00 00 00'))
  s = lockExpires(s) // no 59 within the window
  assert.equal(dmrBusy(s, 'a'), true, 'the now-muted call reads NO MATCH')
  assert.equal(dmrRxOn(s, 'a'), false)
})

test("the OTHER side's audio never corroborates a muted call (dual case)", () => {
  // B analog audible (its bit + the global gate) while A runs a muted DMR call: neither B's bit
  // nor the mono 5b gate may mark A's call audible.
  let s = applyFrame(dmrOnA(), frame(F58))
  s = applyFrame(s, frame('5a 00 04 00 00 04 ff 89 00 00 00 00 00 00 00 00')) // B (other) open
  s = applyFrame(s, frame('5b 01 5c')) // the gate is B's
  assert.equal(s.dmr?.audioRouted, false, "B's audio never corroborates A's muted call")
  s = lockExpires(s)
  assert.equal(dmrBusy(s, 'a'), true, "A's call reads NO MATCH")
})

test('the NO MATCH verdict carries across transmissions of the same muted conversation', () => {
  // The muted 5e stream is sparse and IDLES between transmissions (live 2026-07-14: 2 frames, a
  // 7 s gap, BUSY for 0.7 s, idle) — the earned verdict must survive the idle, or the amber info
  // flickers in late or never. Same-dest remnant seeds the counter: earn once, instant after.
  let s = lockExpires(dmrOnA()) // transmission 1: the lock window expires → verdict
  assert.equal(dmrBusy(s, 'a'), true)
  s = applyFrame(s, frame('5e 00 21 00 00 00 00 0d 00 00 00 00 00 00 00 00 00 00')) // idle
  assert.equal(s.dmr, null)
  assert.equal(s.dmrRemnant?.dest, 310997, 'unlocked call leaves a remnant')
  s = applyFrame(s, frame(PARROT_5E)) // transmission 2, frame 1
  assert.equal(dmrBusy(s, 'a'), true, 'same dest: NO MATCH shows instantly on the next transmission')

  // a LOCK clears the remnant — an audible phase must not inherit amber flashes
  s = applyFrame(s, frame(F59))
  assert.equal(s.dmrRemnant, null, 'locking wipes the remnant')
  s = applyFrame(s, frame('5e 00 21 00 00 00 00 0d 00 00 00 00 00 00 00 00 00 00')) // idle (locked → no stash)
  assert.equal(s.dmrRemnant, null, 'a locked call stashes nothing')
  s = applyFrame(s, frame(PARROT_5E))
  assert.equal(dmrBusy(s, 'a'), false, 'the next transmission starts clean (a fresh lock window)')
})

test('BUSY is suppressed while a scan runs (scan-sample safety)', () => {
  // During a scan, sustained unlocked 5e streams are the scan engine's channel SAMPLES —
  // fully identified, no presentation, no audio. They must never render OR read BUSY.
  let s = dmrOnA()
  s = { ...s, scan: { ...s.scan, active: true } }
  s = times(s, PARROT_5E, 10)
  s = lockExpires(s) // even a stray expiry event must not surface during a scan
  assert.equal(s.dmr?.presented, false)
  assert.equal(dmrSideFor(s), null)
  assert.equal(dmrBusy(s, 'a'), false, 'scan samples never read NO MATCH')
})

test('58 alias merges onto the active call and survives the next 5e', () => {
  let s = applyFrame(initialState(), frame(PARROT_5E))
  // 58 talker push: id @6-9, alias ASCII @10-25 (26 bytes is enough for the alias decode).
  const f58 = '58 00 00 00 00 00 03 22 34 36 50 41 52 52 4f 54 00 00 00 00 00 00 00 00 00 00'
  s = applyFrame(s, frame(f58))
  assert.equal(s.dmr?.alias, 'PARROT')
  s = applyFrame(s, frame(PARROT_5E))
  assert.equal(s.dmr?.alias, 'PARROT', 'alias carried forward across 5e updates')
})

test('decodeDmrAlias reads id + alias', () => {
  const a = decodeDmrAlias(hexToBytes('58 00 00 00 00 00 03 22 34 36 50 41 52 52 4f 54 00 00 00 00 00 00 00 00 00 00'))
  assert.equal(a?.id, 3223436)
  assert.equal(a?.alias, 'PARROT')
})

test('58 captures the talker id (callerId) — the RadioID lookup key', () => {
  let s = applyFrame(initialState(), frame(PARROT_5E))
  const f58 = '58 00 00 00 00 00 03 22 34 36 50 41 52 52 4f 54 00 00 00 00 00 00 00 00 00 00'
  s = applyFrame(s, frame(f58))
  assert.equal(s.dmr?.callerId, 3223436)
})

test('dmrCaller event enriches the current call; a stale callerId is ignored', () => {
  let s = applyFrame(initialState(), frame(PARROT_5E))
  s = applyFrame(s, frame('58 00 00 00 00 00 03 22 34 36 50 41 52 52 4f 54 00 00 00 00 00 00 00 00 00 00'))
  // resolved caller-id for the live call (callerId 3223436) is applied
  s = applyEvent(s, { kind: 'dmrCaller', callerId: 3223436, callsign: 'W1ABC', name: 'John Smith', location: 'Boston, MA' })
  assert.equal(s.dmr?.callsign, 'W1ABC')
  assert.equal(s.dmr?.name, 'John Smith')
  assert.equal(s.dmr?.location, 'Boston, MA')
  // a late lookup for a DIFFERENT id must not paint this call
  s = applyEvent(s, { kind: 'dmrCaller', callerId: 9999999, callsign: 'X9XXX', name: null, location: null })
  assert.equal(s.dmr?.callsign, 'W1ABC', 'stale caller-id ignored')
  // caller fields survive the next 5e voice frame
  s = applyFrame(s, frame(PARROT_5E))
  assert.equal(s.dmr?.callsign, 'W1ABC', 'caller-id carried across 5e updates')
})

// ── clock date (04 51 bytes 6-9: year LE16, month, day) ──────────────────────────
import { decodeClock } from '../src/codec/decode'

test('decodeClock reads the calendar date; unset (implausible year) → null date', () => {
  // Real radio 2026-06-18: 04 51 <h m s> 00 <ea 07> 06 12
  const real = decodeClock(hexToBytes('04 51 15 1c 02 00 ea 07 06 12 00 00'))
  assert.deepEqual(real, { hour: 21, minute: 28, second: 2, year: 2026, month: 6, day: 18 })
  // Unset default (2070) → date fields null, time still decodes
  const unset = decodeClock(hexToBytes('04 51 15 1c 02 00 16 08 01 01 00 00'))
  assert.deepEqual(unset, { hour: 21, minute: 28, second: 2, year: null, month: null, day: null })
  // Short form (no date bytes) → null date
  const short = decodeClock(hexToBytes('04 51 15 1c 02'))
  assert.equal(short?.year, null)
})

// ── navigation away from a live call: the channel read that lands the NEW identity clears the
// call latched to the OLD one (its 5e stream died with the channel — no teardown ever arrives;
// same latch class as the scan-stop bug, live 2026-07-15) ────────────────────────────────────
import { channelBlock } from './sim/frames'

const chFrame = (side: 'a' | 'b', name: string, rxMHz: number, digital = true) => {
  const bytes = channelBlock(side, { name, rxMHz, type: digital ? 'digital' : 'analog', colorCode: 1, timeSlot: 1 }, 1)
  return { head: 0x04, reg: bytes[1]!, bytes, checksumOk: true }
}

test('zone/channel nav away from a live call clears it on the new channel read', () => {
  let s = applyFrame(initialState(), chFrame('a', 'JOENX', 449.7))
  s = applyFrame(s, frame(GROUP_5E))
  s = applyFrame(s, frame('59 01 00 00 06 74 98 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 06 74 98 00 00 00'))
  assert.ok(s.dmr, 'call live before the nav')
  // user steps to another zone → the session re-reads the side → a DIFFERENT identity lands
  s = applyFrame(s, chFrame('a', 'BCSO SOUTH', 159.27, false))
  assert.equal(s.dmr, null, 'the departed channel takes its call with it')
})

test('a same-channel re-read mid-call does NOT clear it', () => {
  let s = applyFrame(initialState(), chFrame('a', 'JOENX', 449.7))
  s = applyFrame(s, frame(GROUP_5E))
  s = applyFrame(s, chFrame('a', 'JOENX', 449.7))
  assert.ok(s.dmr, 'identity unchanged — the call survives a refresh')
})

test('nav on the OTHER side leaves the call alone', () => {
  let s = applyFrame(initialState(), chFrame('a', 'JOENX', 449.7))
  s = applyFrame(s, frame(GROUP_5E)) // latches side a (first-wins pick on selected side)
  s = applyFrame(s, chFrame('b', 'WEATHER', 162.55, false))
  assert.ok(s.dmr, 'side b navigation is independent of side a\'s call')
})

test('mid-call connect: the FIRST channel read (no prior identity) is not a departure', () => {
  let s = applyFrame(initialState(), frame(GROUP_5E)) // call seeds before any channel read
  assert.ok(s.dmr)
  s = applyFrame(s, chFrame('a', 'JOENX', 449.7))
  assert.ok(s.dmr, 'the seed survives the connect-time read landing the real identity')
})
