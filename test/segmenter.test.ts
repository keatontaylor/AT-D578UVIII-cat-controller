// ClipSegmenter — the pure heart of the squelch-triggered recorder. Frame-driven boundaries:
// open on squelch, append + tail, close after tail, drop sub-minimum clips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClipSegmenter } from '../src/audio/clip-segmenter'

const CFG = { frameMs: 10, tailMs: 50, minDurationMs: 100 } // 10ms frames, 50ms tail, 100ms min
const F = Buffer.alloc(160) // one 10 ms frame (unused bytes; segmenter only counts)

/** Drive `n` frames at a squelch state, collecting events. */
function drive(seg: ClipSegmenter, states: boolean[]): string[] {
  const out: string[] = []
  for (const open of states) {
    for (const e of seg.feed(F, open)) {
      out.push(e.kind === 'close' ? `close:${e.keep ? 'keep' : 'drop'}:${e.durationMs}` : e.kind)
    }
  }
  return out
}

test('opens on squelch, appends, closes after the tail; keeps a long-enough clip', () => {
  const seg = new ClipSegmenter(CFG)
  // 15 open frames (150 ms voiced) then 5 closed (50 ms = tail) → close+keep
  const events = drive(seg, [...Array(15).fill(true), ...Array(5).fill(false)])
  assert.equal(events[0], 'open')
  assert.equal(events.filter((e) => e === 'append').length, 20, 'all frames appended (incl. tail)')
  assert.equal(events.at(-1), 'close:keep:200', '150 ms voiced + 50 ms tail = 200 ms, kept')
})

test('a squelch blip shorter than the minimum is dropped', () => {
  const seg = new ClipSegmenter(CFG)
  // 3 open (30 ms voiced) + 5 closed (tail) → voiced 30 ms < 100 ms min → drop
  const events = drive(seg, [...Array(3).fill(true), ...Array(5).fill(false)])
  assert.equal(events.at(-1), 'close:drop:80')
})

test('a brief squelch dip within the tail does not split the clip', () => {
  const seg = new ClipSegmenter(CFG)
  // open 12, closed 3 (30ms < 50ms tail), open 12 again, closed 5 (tail) → ONE clip
  const events = drive(seg, [
    ...Array(12).fill(true),
    ...Array(3).fill(false),
    ...Array(12).fill(true),
    ...Array(5).fill(false),
  ])
  assert.equal(events.filter((e) => e === 'open').length, 1, 'single clip across the dip')
  assert.equal(events.filter((e) => e.startsWith('close')).length, 1)
})

test('flush closes an in-progress clip (stop/disable mid-recording)', () => {
  const seg = new ClipSegmenter(CFG)
  drive(seg, Array(15).fill(true)) // still recording (no tail yet)
  const closed = seg.flush()
  assert.equal(closed?.kind, 'close')
  assert.equal(closed?.keep, true)
  assert.equal(seg.flush(), null, 'nothing open now')
})

test('silence-only never opens a clip', () => {
  const seg = new ClipSegmenter(CFG)
  assert.deepEqual(drive(seg, Array(50).fill(false)), [])
})

// ── WAV header (pure) ────────────────────────────────────────────────────────────
import { wavHeader } from '../src/audio/recorder'

test('wavHeader is a valid 44-byte RIFF/WAVE PCM header with the right sizes', () => {
  const h = wavHeader(16000) // 1 s of 8kHz mono S16
  assert.equal(h.length, 44)
  assert.equal(h.toString('ascii', 0, 4), 'RIFF')
  assert.equal(h.readUInt32LE(4), 36 + 16000, 'RIFF size = 36 + data')
  assert.equal(h.toString('ascii', 8, 12), 'WAVE')
  assert.equal(h.readUInt16LE(20), 1, 'PCM')
  assert.equal(h.readUInt16LE(22), 1, 'mono')
  assert.equal(h.readUInt32LE(24), 8000, '8 kHz')
  assert.equal(h.readUInt32LE(28), 16000, 'byte rate = 8000*1*2')
  assert.equal(h.readUInt16LE(34), 16, 'bits/sample')
  assert.equal(h.toString('ascii', 36, 40), 'data')
  assert.equal(h.readUInt32LE(40), 16000, 'data size')
})

// ── mic-TX downsampler (pure) ────────────────────────────────────────────────────
import { downsampleTo8k } from '../src/audio/rtc'

test('downsampleTo8k decimates 48k→8k and passes 8k through', () => {
  // 48 samples at 48k → 8 samples at 8k (every 6th).
  const in48 = Int16Array.from({ length: 48 }, (_, i) => i * 100)
  const out = downsampleTo8k(in48, 48000)
  assert.equal(out.length, 8 * 2, '8 samples out')
  assert.equal(out.readInt16LE(0), 0)
  assert.equal(out.readInt16LE(2), 600, 'second output = input sample 6')
  // already-8k is untouched
  const in8 = Int16Array.from([1, 2, 3])
  const same = downsampleTo8k(in8, 8000)
  assert.equal(same.readInt16LE(2), 2)
})
