// Golden-master replay: concatenate every rx frame from a real capture into one
// boundaryless byte stream (as the RFCOMM socket delivers it) and assert the framer
// reconstructs the exact original frame boundaries — regardless of how the stream is
// chunked. This validates framing against the entire real corpus, not a hand-built fixture.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Framer, type DecodedFrame } from '../src/codec/framing'
import { bytesToHex, concatAll, loadCapture } from './capture'

// A redesign-OWNED frozen fixture (a clean, lossless relay capture), committed so the live PoC
// capture process can't clobber it. Smaller than the original live corpus but exercises the same
// variable-length framing + both squelch/smeter states.
const WIRE = resolve(dirname(fileURLToPath(import.meta.url)), '../captures/wire.ndjson')

function frameStream(stream: Uint8Array, chunk: number): DecodedFrame[] {
  const f = new Framer()
  const out: DecodedFrame[] = []
  for (let i = 0; i < stream.length; i += chunk) {
    f.push(stream.subarray(i, Math.min(i + chunk, stream.length)))
    for (const fr of f.drain()) out.push(fr)
  }
  assert.equal(f.pending.length, 0, `unconsumed tail: ${bytesToHex(f.pending)}`)
  return out
}

const rx = loadCapture(WIRE).filter((f) => f.dir === 'rx')

test('the fixture yields a substantial rx corpus', () => {
  assert.ok(rx.length > 400, `expected >400 rx frames, got ${rx.length}`)
})

test('reconstructs every rx frame boundary from a boundaryless stream', () => {
  const stream = concatAll(rx.map((f) => f.bytes))
  const framed = frameStream(stream, stream.length)
  assert.equal(framed.length, rx.length, 'frame count mismatch')
  for (let i = 0; i < rx.length; i += 1) {
    assert.deepEqual(Array.from(framed[i]!.bytes), Array.from(rx[i]!.bytes), `frame ${i}`)
  }
})

test('every reconstructed frame is checksum-valid', () => {
  const stream = concatAll(rx.map((f) => f.bytes))
  const bad = frameStream(stream, stream.length).filter((f) => !f.checksumOk)
  assert.equal(bad.length, 0, `${bad.length} bad-checksum frames`)
})

test('framing is invariant to chunk boundaries (byte-by-byte and odd sizes)', () => {
  const subset = rx.slice(0, 1500)
  const stream = concatAll(subset.map((f) => f.bytes))
  const expected = subset.map((f) => Array.from(f.bytes))
  for (const chunk of [1, 7, 64, stream.length]) {
    const framed = frameStream(stream, chunk)
    assert.equal(framed.length, subset.length, `count @chunk=${chunk}`)
    for (let i = 0; i < subset.length; i += 1) {
      assert.deepEqual(Array.from(framed[i]!.bytes), expected[i]!, `frame ${i} @chunk=${chunk}`)
    }
  }
})
