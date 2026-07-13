// DMR live activity: the 5e link-state push (+ 58 alias) decode into the `dmr` state slice.
// Group vs private falls out of source==dest; alias merges from the 58 talker push; idle clears.
// 5e layout (18B): b1 00 idle/01 RX/02 TX, b2 0x40=voice frame, b7 CC, b8-11 src BCD, b12 slot,
// b13-16 dest BCD. b17 = checksum (the frame() helper marks checksumOk directly).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeDmr, decodeDmrAlias } from '../src/codec/decode'
import { applyFrame, applyEvent } from '../src/domain/reduce'
import { initialState } from '../src/domain/state'
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
