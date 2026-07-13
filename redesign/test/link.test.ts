import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DecodedFrame } from '../src/codec/framing'
import { LinkLayer, type Command, type FailReason, type LinkConfig } from '../src/link/link'
import { bytesToHex, hexToBytes } from './capture'

function toFrame(hex: string): DecodedFrame {
  const bytes = hexToBytes(hex)
  return { head: bytes[0]!, reg: bytes[0] === 0x04 ? bytes[1]! : undefined, bytes, checksumOk: true }
}

function badChecksum(hex: string): DecodedFrame {
  return { ...toFrame(hex), checksumOk: false }
}

function harness(cfg: Partial<LinkConfig> = {}) {
  const clock = { t: 0 }
  const writes: string[] = []
  const inbound: DecodedFrame[] = []
  const resolved: Command[] = []
  const failed: { command: Command; reason: FailReason }[] = []
  const retransmitted: { command: Command; attempt: number }[] = []
  const incidents: { message: string; discarded: string }[] = []
  const link = new LinkLayer(
    { timeoutMs: 1000, maxAttempts: 3, gapMs: 0, ...cfg },
    {
      write: (b) => writes.push(bytesToHex(b)),
      inbound: (f) => inbound.push(f),
      resolved: (c) => resolved.push(c),
      failed: (c, reason) => failed.push({ command: c, reason }),
      retransmitted: (c, attempt) => retransmitted.push({ command: c, attempt }),
      framingIncident: (e, discarded) => incidents.push({ message: e.message, discarded: bytesToHex(discarded) }),
    },
    () => clock.t,
  )
  return { clock, writes, inbound, resolved, failed, retransmitted, incidents, link }
}

// real frames
const SETTINGS_READ = '04 05 00 00 00 00'
const SETTINGS_RESP = '04 05' + ' 00'.repeat(96) + ' 02' // 99 bytes, content irrelevant here
const KEY_TONE_WRITE = '08 04 01 88 1f 00 20 71 02 00 08 51 06 00 08 45 04 00 08 4d 06 00 08'
const KEY_TONE_ACK = '03 08 00 00 0b'
const DMR_5E = '5e 01 64 22 02 01 00 01 05 05 96 50 01 05 05 96 50 ca'
const SMETER_5A = '5a 04 00 2a 40 02 ff 8a 00 00 00 00 00 01 00 54'
const SQUELCH_5B = '5b 01 5c'

test('required push (5e) is acked with the 4-byte form and forwarded', () => {
  const h = harness()
  h.link.receive(toFrame(DMR_5E))
  assert.deepEqual(h.writes, ['03 5e 00 00'])
  assert.equal(h.inbound.length, 1)
})

test('free pushes (5a/5b) are forwarded, never acked', () => {
  const h = harness()
  h.link.receive(toFrame(SMETER_5A))
  h.link.receive(toFrame(SQUELCH_5B))
  assert.equal(h.writes.length, 0)
  assert.equal(h.inbound.length, 2)
})

test('read command resolves on its data response (and the response reaches the reducer)', () => {
  const h = harness()
  const cmd = h.link.submit(hexToBytes(SETTINGS_READ))
  assert.deepEqual(h.writes, [SETTINGS_READ])
  h.link.receive(toFrame(SETTINGS_RESP))
  assert.equal(h.resolved.length, 1)
  assert.equal(h.resolved[0], cmd)
  assert.equal(h.inbound.length, 1) // read response forwarded to domain
})

test('bad-checksum frames are dropped before state dispatch or command resolution', () => {
  const h = harness()
  h.link.submit(hexToBytes(SETTINGS_READ))
  h.link.receive(badChecksum(SETTINGS_RESP))
  h.link.receive(badChecksum(SQUELCH_5B))
  h.link.receive(badChecksum(DMR_5E))
  assert.equal(h.resolved.length, 0)
  assert.equal(h.inbound.length, 0)
  assert.equal(h.writes.length, 1, 'bad push is not acked')
  assert.equal(h.link.busy, true)
})

test('write command resolves on its 03 ack (which is not forwarded as data)', () => {
  const h = harness()
  h.link.submit(hexToBytes(KEY_TONE_WRITE))
  h.link.receive(toFrame(KEY_TONE_ACK))
  assert.equal(h.resolved.length, 1)
  assert.equal(h.inbound.length, 0)
})

test('one command in flight: the second waits for the first to resolve', () => {
  const h = harness()
  h.link.submit(hexToBytes(SETTINGS_READ))
  h.link.submit(hexToBytes('04 06 00 00 00 00'))
  assert.equal(h.writes.length, 1) // only the first
  h.link.receive(toFrame(SETTINGS_RESP))
  assert.equal(h.writes.length, 2) // second sent on resolve
})

test('a mismatched ack resolves nothing', () => {
  const h = harness()
  h.link.submit(hexToBytes(KEY_TONE_WRITE)) // op 0x08
  h.link.receive(toFrame('03 5a 00 00 5d')) // ack for 0x5a
  assert.equal(h.resolved.length, 0)
  assert.equal(h.link.busy, true) // command still outstanding
})

test('inter-frame gap holds the next write until the gap elapses', () => {
  const h = harness({ gapMs: 50 })
  h.link.submit(hexToBytes(SETTINGS_READ)) // write @ t=0
  h.link.receive(toFrame(SETTINGS_RESP)) // resolves @ t=0
  h.link.submit(hexToBytes('04 06 00 00 00 00')) // queued; gap not yet elapsed
  assert.equal(h.writes.length, 1)
  h.clock.t = 50
  h.link.tick()
  assert.equal(h.writes.length, 2) // gap elapsed → sent
})

test('a safe command (read) retransmits on timeout, then fails exhausted', () => {
  const h = harness({ timeoutMs: 1000, maxAttempts: 3 })
  h.link.submit(hexToBytes(SETTINGS_READ)) // attempt 1 @ t=0
  h.clock.t = 1000
  h.link.tick() // attempt 2
  h.clock.t = 2000
  h.link.tick() // attempt 3
  assert.equal(h.writes.length, 3)
  h.clock.t = 3000
  h.link.tick() // exhausted
  assert.equal(h.writes.length, 3)
  assert.equal(h.failed.length, 1)
  assert.equal(h.failed[0]!.reason, 'exhausted')
})

test('each retransmit reports the command + attempt through the retransmitted port', () => {
  const h = harness({ timeoutMs: 1000, maxAttempts: 3 })
  h.link.submit(hexToBytes(SETTINGS_READ))
  h.clock.t = 1000
  h.link.tick() // attempt 2
  h.clock.t = 2000
  h.link.tick() // attempt 3
  assert.equal(h.retransmitted.length, 2)
  assert.deepEqual(h.retransmitted.map((r) => r.attempt), [2, 3])
  assert.equal(h.retransmitted[0]!.command.op, 0x04)
  // the failure is NOT double-reported as a retransmit
  h.clock.t = 3000
  h.link.tick()
  assert.equal(h.retransmitted.length, 2)
  assert.equal(h.failed.length, 1)
})

test('an 08 write is retransmit-safe by default; a 2f write is not', () => {
  const safe = harness()
  safe.link.submit(hexToBytes(KEY_TONE_WRITE)) // 0x08
  safe.clock.t = 1000
  safe.link.tick()
  assert.equal(safe.writes.length, 2, '08 retransmits')

  const unsafe = harness()
  unsafe.link.submit(hexToBytes('2f 2b 00 00 00 00')) // 0x2f channel write
  unsafe.clock.t = 1000
  unsafe.link.tick()
  assert.equal(unsafe.writes.length, 1, '2f does not retransmit')
  assert.equal(unsafe.failed[0]!.reason, 'not-retryable')
})

test('PTT unkey (explicit unsafe) is never retransmitted', () => {
  const h = harness()
  const unkey = '56 00 00 01' + ' 00'.repeat(19)
  h.link.submit(hexToBytes(unkey), { retransmitSafe: false })
  h.clock.t = 1000
  h.link.tick()
  assert.equal(h.writes.length, 1)
  assert.equal(h.failed[0]!.reason, 'not-retryable')
})

test('acking a push does not disturb an in-flight command', () => {
  const h = harness()
  h.link.submit(hexToBytes(KEY_TONE_WRITE)) // in flight, op 0x08
  h.link.receive(toFrame(DMR_5E)) // a push arrives mid-command
  assert.deepEqual(h.writes, [KEY_TONE_WRITE, '03 5e 00 00']) // ack interleaved
  assert.equal(h.resolved.length, 0)
  h.link.receive(toFrame(KEY_TONE_ACK)) // the command's ack still resolves it
  assert.equal(h.resolved.length, 1)
})

test('receiveBytes frames a coalesced stream then dispatches (push gets acked)', () => {
  const h = harness()
  const stream = hexToBytes(DMR_5E + ' ' + SQUELCH_5B)
  h.link.receiveBytes(stream)
  assert.deepEqual(h.writes, ['03 5e 00 00']) // only the 5e required an ack
  assert.equal(h.inbound.length, 2) // both forwarded
})

// ── framing-incident containment (corpus-verified radio garble) ────────────────
// The one malformation observed in ~36k real frames (captures/wire.ndjson line 45108): mid
// name-browse the radio answered `04 2e 00 57` with a checksum-VALID 9-byte garble — register
// byte zeroed, payload a stale fragment ("MIDSOU") of the previous reply. The PoC recovered by
// retransmitting the read; these tests pin that exact behavior end-to-end in the redesign link.
const BROWSE_READ_57 = '04 2e 00 57 04 00'
const GARBLED_REPLY = '04 00 4d 49 44 53 4f 55 d5' // real bytes, checksum d5 validates
const CLEAN_REPLY_JOENX = '04 2e 4a 4f 45 4e 58 00 00 00 00 00 00 00 00 00 00 00 00 b6' // 20 bytes

test('REGRESSION: the real corpus garble is discarded and the read recovers via ARQ retransmit', () => {
  const h = harness()
  const cmd = h.link.submit(hexToBytes(BROWSE_READ_57))
  assert.deepEqual(h.writes, [BROWSE_READ_57])

  h.link.receiveBytes(hexToBytes(GARBLED_REPLY)) // must not throw
  assert.equal(h.incidents.length, 1)
  assert.match(h.incidents[0]!.message, /unknown 04 register 0x00/)
  assert.equal(h.incidents[0]!.discarded, GARBLED_REPLY)
  assert.equal(h.inbound.length, 0, 'the garble must not reach the reducer')
  assert.equal(h.resolved.length, 0, 'the read is still in flight')

  h.clock.t = 1000 // read timeout → retransmit (04 reads are retransmit-safe)
  h.link.tick()
  assert.deepEqual(h.writes, [BROWSE_READ_57, BROWSE_READ_57])

  h.link.receiveBytes(hexToBytes(CLEAN_REPLY_JOENX)) // the radio's actual retry answer
  assert.equal(h.resolved.length, 1)
  assert.equal(h.resolved[0], cmd)
  assert.equal(h.inbound.length, 1)
})

test('frames decoded before a garble in the same chunk still dispatch', () => {
  const h = harness()
  h.link.submit(hexToBytes(KEY_TONE_WRITE))
  h.link.receiveBytes(hexToBytes(KEY_TONE_ACK + ' ' + GARBLED_REPLY)) // ack coalesced with garbage
  assert.equal(h.resolved.length, 1, 'the ack before the garble must still resolve the command')
  assert.equal(h.incidents.length, 1)
})

// ── RX-quiet TX gate: don't transmit while the radio is mid-frame / just transmitted ──────────
// Reads and writes share opcodes (04 2c read vs 04 2c write), so a byte-level collision with the
// radio's transmission can misframe a read INTO a codeplug write. The gate holds our first byte
// off the wire until the RX line is quiet + at a frame boundary (bounded so a chatty radio can't
// starve the queue).
test('a queued command waits for the RX-quiet window before it is sent', () => {
  const h = harness({ gapMs: 0, rxQuietMs: 30 })
  h.link.receiveBytes(hexToBytes(SQUELCH_5B)) // radio just transmitted a push @ t=0
  h.link.submit(hexToBytes(SETTINGS_READ)) // queued, but RX isn't quiet yet
  assert.equal(h.writes.length, 0, 'held: radio transmitted <30ms ago')

  h.clock.t = 20
  h.link.tick()
  assert.equal(h.writes.length, 0, 'still held at 20ms')

  h.clock.t = 30 // RX quiet for 30ms → boundary
  h.link.tick()
  assert.deepEqual(h.writes, [SETTINGS_READ], 'sent once the window elapses')
})

test('a partial inbound frame blocks TX until it completes (never transmit mid-frame)', () => {
  const h = harness({ gapMs: 0, rxQuietMs: 30 })
  const full = hexToBytes(SMETER_5A) // a 16-byte 5a
  h.link.receiveBytes(full.slice(0, 8)) // only half arrives @ t=0 → partial frame buffered
  h.clock.t = 100 // well past the quiet window...
  h.link.submit(hexToBytes(SETTINGS_READ))
  h.link.tick()
  assert.equal(h.writes.length, 0, 'held: a partial frame is still buffered')

  h.link.receiveBytes(full.slice(8)) // rest arrives @ t=100 → frame completes, boundary reached
  h.clock.t = 130
  h.link.tick()
  assert.deepEqual(h.writes, [SETTINGS_READ], 'sent after the frame completes + quiet window')
})

test('the RX-quiet gate is bounded — a chatty radio cannot starve the queue forever', () => {
  const h = harness({ gapMs: 0, rxQuietMs: 30 })
  h.link.submit(hexToBytes(SETTINGS_READ))
  for (let t = 0; t <= 500; t += 20) {
    h.clock.t = t
    h.link.receiveBytes(hexToBytes(SQUELCH_5B)) // radio never goes quiet for 30ms
    h.link.tick()
  }
  assert.equal(h.writes.length, 1, 'forced out within the bounded max-hold despite continuous RX')
})

test('the stream re-aligns after a discarded garble (next packet parses normally)', () => {
  const h = harness()
  h.link.receiveBytes(hexToBytes(GARBLED_REPLY))
  h.link.receiveBytes(hexToBytes(DMR_5E)) // next packet: a required push
  assert.deepEqual(h.writes, ['03 5e 00 00']) // acked normally — no lingering desync
  assert.equal(h.inbound.length, 1)
})
