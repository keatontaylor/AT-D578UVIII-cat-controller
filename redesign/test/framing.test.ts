import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Framer, FramingError } from '../src/codec/framing'
import { concatAll, hexToBytes } from './capture'

/** Build a `totalLen`-byte frame starting with `prefix`, zero-filled, with a valid checksum. */
function withChecksum(prefix: number[], totalLen: number): Uint8Array {
  const b = new Uint8Array(totalLen)
  b.set(prefix, 0)
  let sum = 0
  for (let i = 0; i < totalLen - 1; i += 1) sum = (sum + b[i]!) & 0xff
  b[totalLen - 1] = sum
  return b
}

test('variable 04 4b: a 135-byte reply whose first 18 bytes COINCIDENTALLY checksum is not truncated', () => {
  // Regression: one scan-list slot returned a 135-byte frame whose 18-byte prefix happened to carry
  // a valid additive checksum AND a plausible head at byte 18. Ascending framing accepted the false
  // 18-byte frame and orphaned 117 bytes → a framing incident on every scan-list refresh. The frame
  // must resolve to the full 135 bytes.
  const b = new Uint8Array(135)
  b.set([0x04, 0x4b], 0)
  b[18] = 0x5a // a real inbound head at the false 18-byte boundary
  let p = 0
  for (let i = 0; i < 17; i += 1) p = (p + b[i]!) & 0xff
  b[17] = p // makes the 18-byte prefix checksum-valid (the coincidence)
  let s = 0
  for (let i = 0; i < 134; i += 1) s = (s + b[i]!) & 0xff
  b[134] = s // the real 135-byte checksum
  const f = new Framer()
  f.push(b)
  const out = f.drain()
  assert.equal(out.length, 1, 'one frame, not a truncated 18 + garbage')
  assert.equal(out[0]!.bytes.length, 135)
  assert.equal(f.hasPartialFrame, false, 'no orphaned tail bytes')
})

test('frames a single fixed-length push (5a = 16 bytes)', () => {
  const f = new Framer()
  f.push(withChecksum([0x5a, 0x00, 0x04, 0x0c], 16))
  const out = f.drain()
  assert.equal(out.length, 1)
  assert.equal(out[0]!.head, 0x5a)
  assert.equal(out[0]!.reg, undefined)
  assert.ok(out[0]!.checksumOk)
  assert.equal(f.pending.length, 0)
})

test('frames a fixed 04 register read by table length (04 05 = 99)', () => {
  const f = new Framer()
  f.push(withChecksum([0x04, 0x05], 99))
  const out = f.drain()
  assert.equal(out.length, 1)
  assert.equal(out[0]!.head, 0x04)
  assert.equal(out[0]!.reg, 0x05)
  assert.equal(out[0]!.bytes.length, 99)
})

test('variable 04 4b: an empty slot (18) coalesced with a 5b (3) splits correctly', () => {
  const empty = withChecksum([0x04, 0x4b], 18)
  const sb = hexToBytes('5b 00 5b')
  const f = new Framer()
  f.push(concatAll([empty, sb]))
  const out = f.drain()
  assert.deepEqual(out.map((x) => x.bytes.length), [18, 3])
  assert.equal(out[0]!.reg, 0x4b)
  assert.ok(out.every((x) => x.checksumOk))
})

test('variable 04 4b: a populated slot (135) split across two pushes', () => {
  const full = withChecksum([0x04, 0x4b, 0x01, 0x53], 135)
  const f = new Framer()
  f.push(full.subarray(0, 100))
  assert.equal(f.drain().length, 0, '18-byte prefix must not false-match a 135 frame')
  f.push(full.subarray(100))
  const out = f.drain()
  assert.equal(out.length, 1)
  assert.equal(out[0]!.bytes.length, 135)
})

test('variable 04 2c: a compact channel block (72) coalesced with a 5b splits correctly', () => {
  const compact = withChecksum([0x04, 0x2c], 72)
  const sb = hexToBytes('5b 00 5b')
  const f = new Framer()
  f.push(concatAll([compact, sb]))
  const out = f.drain()
  assert.deepEqual(out.map((x) => x.bytes.length), [72, 3])
  assert.equal(out[0]!.reg, 0x2c)
  assert.ok(out.every((x) => x.checksumOk))
})

test('variable 04 2c/2d: full channel blocks do not false-match at 72 bytes', () => {
  const cases = [
    { reg: 0x2c, len: 118 },
    { reg: 0x2d, len: 121 },
  ]
  for (const { reg, len } of cases) {
    const full = withChecksum([0x04, reg, 0x01], len)
    const f = new Framer()
    f.push(full.subarray(0, 100))
    assert.equal(f.drain().length, 0, `04 ${reg.toString(16)} must wait for its full frame`)
    f.push(full.subarray(100))
    const out = f.drain()
    assert.equal(out.length, 1)
    assert.equal(out[0]!.reg, reg)
    assert.equal(out[0]!.bytes.length, len)
    assert.ok(out[0]!.checksumOk)
  }
})

test('a partial fixed frame buffers until complete', () => {
  const frame = withChecksum([0x5a, 0x00], 16)
  const f = new Framer()
  f.push(frame.subarray(0, 5))
  assert.equal(f.drain().length, 0)
  assert.equal(f.pending.length, 5)
  f.push(frame.subarray(5))
  assert.equal(f.drain().length, 1)
  assert.equal(f.pending.length, 0)
})

test('an unknown head raises FramingError', () => {
  const f = new Framer()
  f.push(hexToBytes('99 00 00'))
  assert.throws(() => f.drain(), FramingError)
})

test('next() extracts one frame at a time; discardPending clears and returns the bad bytes', () => {
  const f = new Framer()
  // the real corpus garble (wire.ndjson line 45108): checksum-valid but register 0x00 is unknown
  const garble = hexToBytes('04 00 4d 49 44 53 4f 55 d5')
  const good = withChecksum([0x5a, 0x00, 0x04, 0x0c], 16)
  f.push(concatAll([good, garble]))

  const first = f.next()
  assert.equal(first?.head, 0x5a, 'the frame before the garble extracts cleanly')
  assert.throws(() => f.next(), FramingError)
  assert.deepEqual([...f.discardPending()], [...garble], 'discard returns the garbled bytes for diagnostics')
  assert.equal(f.pending.length, 0)
  assert.equal(f.next(), null)

  f.push(good) // the stream re-aligns at the next packet
  assert.equal(f.next()?.head, 0x5a)
})

// ── Sub-typed 5f pushes (live-diagnosed 2026-07-12): `5f 33 <ck>` = 3 bytes (post-DMR-TX status,
// retried 1/s by the radio until acked) and `5f 34 02 00 <ck>` = 5 bytes. Head-variable framing.
test('5f: both sub-type lengths frame correctly', () => {
  const f = new Framer()
  f.push(Uint8Array.of(0x5f, 0x33, 0x92))
  const a = f.next()
  assert.ok(a && a.checksumOk && a.bytes.length === 3)
  f.push(Uint8Array.of(0x5f, 0x34, 0x02, 0x00, 0x95))
  const b = f.next()
  assert.ok(b && b.checksumOk && b.bytes.length === 5)
  assert.equal(f.hasPartialFrame, false)
})

test('5f: a 1 Hz retry storm coalesced into one chunk frames as individual pushes', () => {
  const f = new Framer()
  const storm = new Uint8Array(9)
  storm.set([0x5f, 0x33, 0x92], 0)
  storm.set([0x5f, 0x33, 0x92], 3)
  storm.set([0x5f, 0x33, 0x92], 6)
  f.push(storm)
  const frames = f.drain()
  assert.equal(frames.length, 3)
  assert.ok(frames.every((x) => x.head === 0x5f && x.checksumOk))
})

test('5f: short variant followed by another frame head does not over-consume', () => {
  const f = new Framer()
  // 5f 33 92 then a 5b gate push (5b 01 5c) — the 5-byte candidate must not swallow the 5b
  f.push(Uint8Array.of(0x5f, 0x33, 0x92, 0x5b, 0x01, 0x5c))
  const frames = f.drain()
  assert.equal(frames.length, 2)
  assert.equal(frames[0]!.bytes.length, 3)
  assert.equal(frames[1]!.head, 0x5b)
})
