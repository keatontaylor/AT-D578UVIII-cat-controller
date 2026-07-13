// RX PCM reframing: a byte stream chunked arbitrarily by the pipe must come out as whole 10 ms
// frames (160 bytes) with no bytes lost or duplicated.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reframe, RxCapture } from '../src/audio/rx-capture'

test('reframe splits whole frames and carries the remainder', () => {
  const F = 160
  // 400 bytes arriving as 90 + 310 → two whole frames (320) + 80 leftover.
  const a = reframe(Buffer.alloc(0), Buffer.alloc(90, 1), F)
  assert.equal(a.frames.length, 0)
  assert.equal(a.rest.length, 90)
  const b = reframe(a.rest, Buffer.alloc(310, 2), F)
  assert.equal(b.frames.length, 2)
  assert.ok(b.frames.every((f) => f.length === F))
  assert.equal(b.rest.length, 80)
})

test('reframe reassembles across many tiny chunks without losing bytes', () => {
  const F = 160
  let pending: Buffer = Buffer.alloc(0)
  let total = 0
  // 1000 bytes fed one at a time → floor(1000/160)=6 frames, 40 leftover.
  for (let i = 0; i < 1000; i += 1) {
    const r = reframe(pending, Buffer.of(i & 0xff), F)
    pending = r.rest
    total += r.frames.length
  }
  assert.equal(total, 6)
  assert.equal(pending.length, 40)
})

test('an exact multiple leaves no remainder', () => {
  const r = reframe(Buffer.alloc(0), Buffer.alloc(320, 7), 160)
  assert.equal(r.frames.length, 2)
  assert.equal(r.rest.length, 0)
})

test('RxCapture subscribe rejects when the capture command cannot start', async () => {
  const capture = new RxCapture(() => {
    throw new Error('no pcm')
  })
  await assert.rejects(() => capture.subscribe(() => {}), /no pcm/)
  assert.equal(capture.active, false)
})

// ── FrameQueue: the pacing jitter buffer (de-clumps bursty pipe delivery) ──
import { FrameQueue } from '../src/audio/rx-capture'

const F = (n: number): Buffer => Buffer.alloc(160, n)

test('FrameQueue holds until primed, then releases one per drain', () => {
  const q = new FrameQueue(2, 25)
  q.push(F(1))
  assert.equal(q.drain(), null, 'below target → still priming')
  q.push(F(2)) // now depth 2 → primed
  assert.deepEqual(q.drain(), F(1), 'oldest first, in order')
  assert.deepEqual(q.drain(), F(2))
})

test('FrameQueue absorbs a burst and paces it out one at a time', () => {
  const q = new FrameQueue(2, 25)
  for (let i = 0; i < 5; i += 1) q.push(F(i)) // a clump of 5 arrives at once
  const out: number[] = []
  for (let i = 0; i < 5; i += 1) {
    const f = q.drain()
    if (f) out.push(f[0]!)
  }
  assert.deepEqual(out, [0, 1, 2, 3, 4], 'released in order, no loss, no duplication')
})

test('FrameQueue re-primes after underrun (a hold, never a skip mid-stream)', () => {
  const q = new FrameQueue(2, 25)
  q.push(F(1))
  q.push(F(2))
  assert.deepEqual(q.drain(), F(1))
  assert.deepEqual(q.drain(), F(2)) // drains to empty → un-primes
  assert.equal(q.drain(), null, 'empty → underrun, waits')
  q.push(F(3))
  assert.equal(q.drain(), null, 'one frame is below target → still re-priming')
  q.push(F(4))
  assert.deepEqual(q.drain(), F(3), 're-primed, resumes in order')
})

test('FrameQueue caps a runaway backlog by dropping the OLDEST (freshest wins)', () => {
  const q = new FrameQueue(2, 4)
  for (let i = 0; i < 10; i += 1) q.push(F(i)) // far past the cap of 4
  assert.equal(q.depth, 4, 'bounded')
  assert.deepEqual(q.drain(), F(6), 'kept the 4 freshest (6,7,8,9), dropped 0..5')
})

test('FrameQueue.clear resets depth and prime', () => {
  const q = new FrameQueue(2, 25)
  q.push(F(1))
  q.push(F(2))
  q.clear()
  assert.equal(q.depth, 0)
  assert.equal(q.drain(), null)
})
