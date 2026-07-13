// Write-command encoders (the channel/zone/side/VFO writes wired this slice).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  channelSelect,
  menuWrite,
  rxFrequencyWrite,
  selectSide,
  txFrequencyWrite,
  vfoMemoryMode,
  zoneSelect,
  WRITE_TAIL,
} from '../src/codec/commands'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

test('selectSide is 08 19 <00|01> + the menu tail', () => {
  assert.equal(hex(selectSide('a')), '081900' + hex(WRITE_TAIL))
  assert.equal(hex(selectSide('b')), '081901' + hex(WRITE_TAIL))
})

test('zoneSelect is 08 39 <idx> + the menu tail (clamped ≥0)', () => {
  assert.equal(hex(zoneSelect(3)), '083903' + hex(WRITE_TAIL))
  assert.equal(hex(zoneSelect(-1)), '083900' + hex(WRITE_TAIL))
  assert.equal(hex(menuWrite(0x39, 3)), hex(zoneSelect(3)))
})

test('channelSelect is 04 2c/2d 01 55 <target> <dir> (1 up / 0 down)', () => {
  assert.equal(hex(channelSelect('a', 5, 1)), '042c01550501')
  assert.equal(hex(channelSelect('b', 5, -1)), '042d01550500')
  assert.equal(hex(channelSelect('a', 0xf9, -1)), '042c0155f900') // wrap-to-last sentinel
})

test('vfoMemoryMode is 57 3d <01 vfo|00 mem> + tail', () => {
  assert.equal(hex(vfoMemoryMode(true)).slice(0, 6), '573d01')
  assert.equal(hex(vfoMemoryMode(false)).slice(0, 6), '573d00')
  assert.ok(vfoMemoryMode(true).length > 100, 'carries the fixed context tail')
})

// Working-frequency writes (2f 03 RX / 2f 04 TX).
test('rxFrequencyWrite is 2f 03 00 <BCD4 Hz/10> + the live record echo (bytes [6:22])', () => {
  // Byte-exact against the Sitting-2 capture (BT-01): editing VFO B (context = its 144.09000
  // record) to 146.52000 emits `2f 03 00 14 65 20 00` + the record's bytes [6:22] verbatim.
  // Build the 04 2d record by index so the echo range is unambiguous (from the 16:13:37 block:
  // [2:6] RX, [6:10] TX = 14 40 90 00, [10]=1c, [18:20]=26 05, rest 0).
  const block = new Uint8Array(121)
  block.set([0x04, 0x2d], 0)
  block.set([0x14, 0x40, 0x90, 0x00], 2) // RX 144.09000
  block.set([0x14, 0x40, 0x90, 0x00], 6) // TX (echoed)
  block[10] = 0x1c
  block.set([0x26, 0x05], 18)
  const echo = hex(block.subarray(6, 22)) // '14409000' '1c' 00×7 '2605' '0000'
  assert.equal(hex(rxFrequencyWrite(146_520_000, block)), '2f0300' + '14652000' + echo)
  // The new frequency is spliced in; the echo after the BCD is verbatim block[6:22].
  assert.equal(hex(rxFrequencyWrite(446_006_250, block)).slice(0, 14), '2f030044600625')
  assert.equal(hex(rxFrequencyWrite(446_006_250, block)).slice(14), echo)
})

test('rxFrequencyWrite refuses to write without the working-channel record (no stale tail)', () => {
  assert.throws(() => rxFrequencyWrite(146_520_000, new Uint8Array(0)), /working-channel record/)
  assert.throws(() => rxFrequencyWrite(146_520_000, new Uint8Array(10)), /working-channel record/)
})

test('txFrequencyWrite is 2f 04 00 <BE32 Hz/10> + tail (EXPERIMENTAL, capture-decoded)', () => {
  // From the relay-capture decode notes: 145.00000 MHz → 00 dd 40 a0.
  assert.equal(hex(txFrequencyWrite(145_000_000)), '2f040000dd40a000000000050505059f80030800000000')
  // 444.82500 MHz → 02 a6 bf c4.
  assert.equal(hex(txFrequencyWrite(444_825_000)).slice(0, 14), '2f040002a6bfc4')
})

test('frequency writes validate range before returning a frame', () => {
  const block = new Uint8Array(72) // valid-length context so we test the RANGE guard, not the echo guard
  assert.throws(() => rxFrequencyWrite(50_000, block), /out of range/)
  assert.throws(() => rxFrequencyWrite(1_000_000_000, block), /out of range/)
  assert.throws(() => txFrequencyWrite(20_000), /out of range/)
  assert.throws(() => txFrequencyWrite(500_000_000), /out of range/)
})

import { volumeWrite, VOLUME_MAX } from '../src/codec/commands'

test('volumeWrite is byte-exact against the BT-01 relay capture (knob at 0x07)', () => {
  // 2026-07-12 capture: 08 4a 07 88 1f 00 20 71 02 00 08 51 06 00 08 45 04 00 08 4d 06 00 08
  const expected = Uint8Array.from([
    0x08, 0x4a, 0x07, 0x88, 0x1f, 0x00, 0x20, 0x71, 0x02, 0x00, 0x08, 0x51, 0x06, 0x00, 0x08,
    0x45, 0x04, 0x00, 0x08, 0x4d, 0x06, 0x00, 0x08,
  ])
  assert.deepEqual(volumeWrite(7), expected)
})

test('volumeWrite validates its range before any state change', () => {
  assert.throws(() => volumeWrite(-1))
  assert.throws(() => volumeWrite(VOLUME_MAX + 1))
  assert.throws(() => volumeWrite(2.5))
  assert.equal(volumeWrite(0)[2], 0)
  assert.equal(volumeWrite(VOLUME_MAX)[2], VOLUME_MAX)
})
