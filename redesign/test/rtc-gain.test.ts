// Mic-TX gain in downsampleTo8k: attenuate the browser mic before the radio's narrowband HFP sink
// so it doesn't overmodulate. Gain is applied with int16 clipping; unity is a no-op (identity).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { downsampleTo8k } from '../src/audio/rtc'

const toI16 = (buf: Buffer): number[] => {
  const out: number[] = []
  for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i))
  return out
}

test('unity gain is identity at 8k (unchanged behavior)', () => {
  const s = Int16Array.from([100, -200, 300, -400])
  assert.deepEqual(toI16(downsampleTo8k(s, 8000)), [100, -200, 300, -400])
})

test('gain attenuates each sample (0.6, rounded)', () => {
  const s = Int16Array.from([1000, -1000, 5000])
  assert.deepEqual(toI16(downsampleTo8k(s, 8000, 0.6)), [600, -600, 3000])
})

test('gain > 1 clips to the int16 range', () => {
  const s = Int16Array.from([30000, -30000])
  assert.deepEqual(toI16(downsampleTo8k(s, 8000, 2)), [32767, -32768])
})

test('decimates 48k → 8k (every 6th sample) with gain applied', () => {
  const s = Int16Array.from([1000, 1, 2, 3, 4, 5, 2000, 6, 7, 8, 9, 10]) // 12 @48k → 2 @8k
  assert.deepEqual(toI16(downsampleTo8k(s, 48000, 0.5)), [500, 1000])
})

// ── runtime-adjustable gain (AudioBridge.setTxGain → per-frame getter) ──────────
import { AudioBridge, TX_GAIN_MAX, TX_GAIN_MIN } from '../src/audio/rtc'

test('AudioBridge gain is mutable at runtime and clamped to sane bounds', () => {
  const bridge = new AudioBridge(() => ({ command: 'true', args: [] }))
  assert.equal(bridge.txGain, 1, 'default unity')
  assert.equal(bridge.setTxGain(0.6), 0.6)
  assert.equal(bridge.txGain, 0.6)
  assert.equal(bridge.setTxGain(99), TX_GAIN_MAX, 'clamped high')
  assert.equal(bridge.setTxGain(0), TX_GAIN_MIN, 'clamped low')
  assert.equal(bridge.setTxGain(Number.NaN), 1, 'garbage → unity')
})

test('the boot gain passes through the constructor (env default path)', () => {
  const bridge = new AudioBridge(() => ({ command: 'true', args: [] }), () => {}, () => null, 0.6)
  assert.equal(bridge.txGain, 0.6)
})

// ── TxProcessor: anti-aliased mic downsampling + soft-limited gain (the over-modulation fix) ──
import { TxProcessor, downsampleTo8k as naive, softClip } from '../src/audio/rtc'

const rms = (buf: Buffer): number => {
  let acc = 0
  for (let i = 0; i < buf.length; i += 2) acc += buf.readInt16LE(i) ** 2
  return Math.sqrt(acc / (buf.length / 2))
}
/** n samples of a sine at `hz` sampled at `rate`, amplitude in int16 units, phase-continuous via t0. */
const tone = (hz: number, rate: number, n: number, amp: number, t0 = 0): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * hz * (t0 + i)) / rate)))

test('TxProcessor kills fold-back: a 6 kHz tone (above the 4 kHz output Nyquist) is attenuated ≥30 dB', () => {
  const p = new TxProcessor()
  // feed several frames so the FIR history is warm; measure the last frame
  let out: Buffer = Buffer.alloc(0)
  for (let f = 0; f < 5; f += 1) out = p.process(tone(6000, 48000, 480, 20000, f * 480), 48000, 1)
  const aliased = rms(naive(tone(6000, 48000, 480, 20000, 4 * 480), 48000, 1))
  const filtered = rms(out)
  assert.ok(aliased > 10000, `naive decimation aliases the tone at nearly full level (rms ${aliased.toFixed(0)})`)
  assert.ok(filtered < aliased / 30, `filtered output is ≥30 dB down (rms ${filtered.toFixed(0)} vs ${aliased.toFixed(0)})`)
})

test('TxProcessor passes the voice band: a 1 kHz tone comes through within ~1 dB', () => {
  const p = new TxProcessor()
  let out: Buffer = Buffer.alloc(0)
  for (let f = 0; f < 5; f += 1) out = p.process(tone(1000, 48000, 480, 20000, f * 480), 48000, 1)
  const level = rms(out)
  const expected = 20000 / Math.SQRT2
  assert.ok(Math.abs(level - expected) / expected < 0.12, `passband preserved (rms ${level.toFixed(0)} ≈ ${expected.toFixed(0)})`)
})

test('TxProcessor is continuous across frame boundaries (no per-frame edge clicks)', () => {
  // one continuous 500 Hz tone split into 10 ms frames must produce no sample-to-sample jump
  // larger than the tone's own maximum slope (a boundary glitch would exceed it)
  const p = new TxProcessor()
  const frames: Buffer[] = []
  for (let f = 0; f < 6; f += 1) frames.push(p.process(tone(500, 48000, 480, 20000, f * 480), 48000, 1))
  const all = Buffer.concat(frames.slice(2)) // skip FIR warm-up
  const maxSlope = (2 * Math.PI * 500 * 20000) / 8000 // |d/dt| of the tone per output sample, with margin
  for (let i = 2; i < all.length - 2; i += 2) {
    const jump = Math.abs(all.readInt16LE(i) - all.readInt16LE(i - 2))
    assert.ok(jump < maxSlope * 1.5, `no boundary discontinuity (jump ${jump} at sample ${i / 2})`)
  }
})

test('softClip: linear below the knee, rounds peaks instead of squaring, never exceeds int16', () => {
  assert.equal(softClip(1000), 1000)
  assert.equal(softClip(-27000), -27000) // below 85% FS → untouched
  const hot = softClip(40000)
  assert.ok(hot > 27856 && hot <= 32767, `hot peak compressed into range (got ${hot})`)
  assert.equal(softClip(10_000_000), 32767, 'asymptote capped at full scale')
  assert.equal(softClip(-10_000_000), -32767)
})

test('TxProcessor applies gain (the mic attenuation) in the passband', () => {
  const p = new TxProcessor()
  let out: Buffer = Buffer.alloc(0)
  for (let f = 0; f < 5; f += 1) out = p.process(tone(1000, 48000, 480, 20000, f * 480), 48000, 0.5)
  const level = rms(out)
  const expected = (20000 * 0.5) / Math.SQRT2
  assert.ok(Math.abs(level - expected) / expected < 0.12, `gain 0.5 applied (rms ${level.toFixed(0)} ≈ ${expected.toFixed(0)})`)
})

test('TxProcessor at 8 kHz input is passthrough + soft-limited gain', () => {
  const p = new TxProcessor()
  const out = p.process(Int16Array.from([1000, -2000, 30000]), 8000, 1)
  assert.equal(out.readInt16LE(0), 1000)
  assert.equal(out.readInt16LE(2), -2000)
  assert.ok(out.readInt16LE(4) >= 27856 && out.readInt16LE(4) <= 32767, 'above-knee sample soft-limited')
})

import { wired48kTo8k } from '../src/audio/rtc'

test('wired48kTo8k: decimates a byte stream 6:1 with arbitrary chunk splits, tone preserved', () => {
  const t = wired48kTo8k()
  // one second of 1 kHz at 48 k, fed in awkward 1000-byte chunks (not 12-aligned)
  const samples = tone(1000, 48000, 48000, 16000)
  const bytes = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) bytes.writeInt16LE(samples[i]!, i * 2)
  let out: Buffer = Buffer.alloc(0)
  for (let off = 0; off < bytes.length; off += 1000) {
    out = Buffer.concat([out, t(bytes.subarray(off, Math.min(off + 1000, bytes.length)))])
  }
  // 6:1 by count (within one alignment group), and the tone survives at level
  assert.ok(Math.abs(out.length / 2 - 8000) <= 6, `got ${out.length / 2} samples for 8000 expected`)
  const level = rms(out.subarray(400)) // skip FIR warm-up
  const expected = 16000 / Math.SQRT2
  assert.ok(Math.abs(level - expected) / expected < 0.15, `tone rms ${level.toFixed(0)} vs ~${expected.toFixed(0)}`)
})

test('wired48kTo8k: fold-back above 4 kHz is filtered, not aliased', () => {
  const t = wired48kTo8k()
  const samples = tone(6000, 48000, 9600, 20000)
  const bytes = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) bytes.writeInt16LE(samples[i]!, i * 2)
  const out = t(bytes)
  const tail = out.subarray(out.length - 1600) // steady-state end
  assert.ok(rms(tail) < 700, `6 kHz content must be filtered out (rms ${rms(tail).toFixed(0)})`)
})
