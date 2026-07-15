import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '../src/services/session'
import { RadioState } from '../src/domain/state'
import { allSettings } from '../src/codec/settings-table'
import { decodeSettingsBlock } from '../src/codec/decode'
import type { Transport } from '../src/transport/types'
import { bytesToHex, hexToBytes } from './capture'

class FakeTransport implements Transport {
  handler: (chunk: Uint8Array) => void = () => {}
  autoAck = true
  writes: string[] = []
  onData(h: (chunk: Uint8Array) => void): void {
    this.handler = h
  }
  onClose(): void {}
  close(): void {}
  write(bytes: Uint8Array): void {
    this.writes.push(bytesToHex(bytes))
    if (this.autoAck && bytes[0] === 0x08) this.handler(hexToBytes('03 08 00 00 0b'))
  }
}

function session(tp: FakeTransport, clock: { t: number }, maxAttempts = 3) {
  return new Session(tp, { timeoutMs: 1000, maxAttempts, gapMs: 0 }, () => clock.t)
}

test('setSetting confirms optimistically on the 08 ack', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const s = session(tp, { t: 0 })

  s.setSetting('key_tone', 'L1')
  assert.deepEqual(s.state.pendingSettings['key_tone'], { desired: 'L1', phase: 'pending' })
  assert.equal(tp.writes[0], '08 04 01 88 1f 00 20 71 02 00 08 51 06 00 08 45 04 00 08 4d 06 00 08')
  assert.equal(s.state.settings['key_tone'], undefined) // reported not yet changed

  tp.handler(hexToBytes('03 08 00 00 0b'))
  assert.equal(s.state.settings['key_tone'], 'L1') // confirmed → reported updated
  assert.equal(s.state.pendingSettings['key_tone'], undefined) // overlay cleared
})

test('a failed write marks the overlay failed and leaves reported untouched', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const clock = { t: 0 }
  const s = session(tp, clock, 1) // maxAttempts 1 → first timeout fails

  s.setSetting('scan_mode', 'SE')
  clock.t = 1000
  s.tick()
  assert.deepEqual(s.state.pendingSettings['scan_mode'], { desired: 'SE', phase: 'failed' })
  assert.equal(s.state.settings['scan_mode'], undefined)
})

test('two writes confirm in FIFO order (the generic 08 ack carries no sub-op)', () => {
  const tp = new FakeTransport() // auto-acks each 08 synchronously
  const s = session(tp, { t: 0 })
  s.setSetting('key_tone', 'L1')
  s.setSetting('talk_permit', 'both')
  assert.equal(s.state.settings['key_tone'], 'L1')
  assert.equal(s.state.settings['talk_permit'], 'both')
  assert.deepEqual(s.state.pendingSettings, {})
})

test('a numeric index is normalized to the option label', () => {
  const tp = new FakeTransport()
  const s = session(tp, { t: 0 })
  s.setSetting('analog_squelch_level', 5) // index 5 → 'L5'
  assert.equal(s.state.settings['analog_squelch_level'], 'L5')
})

test('an invalid setting throws and changes no state', () => {
  const tp = new FakeTransport()
  const s = session(tp, { t: 0 })
  assert.throws(() => s.setSetting('key_tone', 'nope'))
  assert.throws(() => s.setSetting('not_a_setting', 0))
  assert.deepEqual(s.state.pendingSettings, {})
  assert.equal(tp.writes.length, 0)
  assert.doesNotThrow(() => RadioState.parse(s.state))
})

// ── correlation by Command identity (regression) ───────────────────────────────
// Side-select (08 19) and zone-select (08 39) share the 0x08 head with setting writes. The old
// FIFO counted ANY 08 ack as a settings outcome, so a side-select's ack arriving first falsely
// confirmed a still-queued setting write (and its later real failure was silently dropped).

test('REGRESSION: a side-select ack does not confirm a pending setting write', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const s = session(tp, { t: 0 })

  s.chooseSide('b') // 08 19 -> in flight
  s.setSetting('key_tone', 'L1') // 08 write queued behind it
  tp.handler(hexToBytes('03 08 00 00 0b')) // the radio acks the SIDE-SELECT

  assert.equal(s.state.settings['key_tone'], undefined, 'must not be confirmed by the side-select ack')
  assert.deepEqual(s.state.pendingSettings['key_tone'], { desired: 'L1', phase: 'pending' })

  tp.handler(hexToBytes('03 08 00 00 0b')) // now the setting write's own ack
  assert.equal(s.state.settings['key_tone'], 'L1')
  assert.deepEqual(s.state.pendingSettings, {})
})

test('REGRESSION: a setting write that fails after an interleaved side-select is marked failed', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const clock = { t: 0 }
  const s = session(tp, clock, 1) // one attempt: first timeout fails

  s.chooseSide('b')
  s.setSetting('scan_mode', 'SE')
  tp.handler(hexToBytes('03 08 00 00 0b')) // side-select acked
  clock.t = 1000
  s.tick() // the setting write times out -> failed

  assert.equal(s.state.settings['scan_mode'], undefined)
  assert.deepEqual(s.state.pendingSettings['scan_mode'], { desired: 'SE', phase: 'failed' })
})

test('close() rejects outstanding submitAndWait waiters and refuses new ones', async () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const s = session(tp, { t: 0 })
  const inFlight = s.submitAndWait(hexToBytes('04 05 00 00 00 00'))
  s.close()
  await assert.rejects(() => inFlight, /session closed/)
  await assert.rejects(() => s.submitAndWait(hexToBytes('04 06 00 00 00 00')), /session closed/)
})

// ── side-select is pending-until-acked (moves selectedSide only on the 08 19 ack) ──────────────
test('chooseSide marks pendingSide and does NOT move selectedSide until the ack', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const s = session(tp, { t: 0 })
  assert.equal(s.state.selectedSide, 'a')

  s.chooseSide('b')
  assert.equal(s.state.pendingSide, 'b', 'switch is in flight')
  assert.equal(s.state.selectedSide, 'a', 'not moved yet — radio has not confirmed')
  assert.equal(tp.writes[0], '08 19 01 88 1f 00 20 71 02 00 08 51 06 00 08 45 04 00 08 4d 06 00 08')

  tp.handler(hexToBytes('03 08 00 00 0b')) // the radio acks the select
  assert.equal(s.state.selectedSide, 'b', 'now active — ACK is gospel for the swap')
  assert.equal(s.state.pendingSide, null, 'pending cleared')
  assert.equal(tp.writes.length, 1, 'no post-swap refresh reads — sides are already known')
})

// 5a data (push AND 04 5a read) is selected-side-RELATIVE, and the radio's 5a status engine
// settles its reference ~300-700ms AFTER the 08 19 ack (relay-measured) with no wire-observable
// commit marker. A swap changes nothing physical, so the Session HOLDS the last known per-side
// signal through a settle window and resumes on the first post-settle push.
test('side swap: 5a frames are held through the settle window, then live pushes resume', () => {
  const ck = (prefix: number[], len: number): Uint8Array => {
    const b = new Uint8Array(len)
    b.set(prefix, 0)
    let sum = 0
    for (let i = 0; i < len - 1; i += 1) sum = (sum + b[i]!) & 0xff
    b[len - 1] = sum
    return b
  }
  const tp = new FakeTransport()
  tp.autoAck = false
  const clock = { t: 0 }
  const s = session(tp, clock)

  // Steady state on side A: selected(A) RSSI 4 + squelch open, other(B) silent.
  tp.handler(ck([0x5a, 0x04, 0x00, 0x2a, 0x40, 0x02], 16))
  assert.deepEqual(s.state.signal, { aRssi: 4, bRssi: 0, aOpen: true, bOpen: false, holder: 'a', focus: 'b' })

  s.chooseSide('b')
  clock.t = 200
  tp.handler(hexToBytes('03 08 00 00 0b')) // ack → selectedSide flips; settle window restarts
  assert.equal(s.state.selectedSide, 'b')
  assert.equal(tp.writes.length, 1, 'no refresh reads issued — both sides are already known')

  // Old-reference frames inside the settle window — a push AND a (hypothetical) 04 5a read —
  // are held: the meter keeps showing the known physical truth.
  clock.t = 500
  tp.handler(ck([0x5a, 0x04, 0x00, 0x2a, 0x40, 0x02], 16))
  assert.deepEqual(s.state.signal, { aRssi: 4, bRssi: 0, aOpen: true, bOpen: false, holder: 'a', focus: 'b' }, 'push held')
  tp.handler(ck([0x04, 0x5a, 0x04, 0x00, 0x2a, 0x40, 0x02], 17))
  assert.deepEqual(s.state.signal, { aRssi: 4, bRssi: 0, aOpen: true, bOpen: false, holder: 'a', focus: 'b' }, 'read held')

  // Past the settle deadline (ack+1000ms) the engine reports in the NEW reference:
  // selected(B) 0, other(A) 4 + open — same physical truth, applied again.
  clock.t = 1201
  tp.handler(ck([0x5a, 0x00, 0x04, 0x2a, 0x40, 0x04], 16))
  assert.deepEqual(s.state.signal, { aRssi: 4, bRssi: 0, aOpen: true, bOpen: false, holder: 'a', focus: 'b' }, 'post-settle push applies')
  tp.handler(ck([0x5a, 0x02, 0x00, 0x2a, 0x40, 0x02], 16))
  assert.deepEqual(s.state.signal, { aRssi: 0, bRssi: 2, aOpen: false, bOpen: true, holder: 'b', focus: 'b' }, 'live meter resumes')
})

test('a failed side-select ends the 5a hold (meter must not freeze)', () => {
  const ck = (prefix: number[], len: number): Uint8Array => {
    const b = new Uint8Array(len)
    b.set(prefix, 0)
    let sum = 0
    for (let i = 0; i < len - 1; i += 1) sum = (sum + b[i]!) & 0xff
    b[len - 1] = sum
    return b
  }
  const tp = new FakeTransport()
  tp.autoAck = false
  const clock = { t: 0 }
  const s = session(tp, clock, 1)

  s.chooseSide('b')
  clock.t = 1000
  s.tick() // select times out → failed, no swap happened
  assert.equal(s.state.pendingSide, null)
  tp.handler(ck([0x5a, 0x03, 0x00, 0x2a, 0x40, 0x02], 16))
  assert.equal(s.state.signal.aRssi, 3, 'pushes apply again after the failed swap')
})

test('a failed side-select reverts (clears pending, keeps the real side)', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const clock = { t: 0 }
  const s = session(tp, clock, 1) // one attempt

  s.chooseSide('b')
  assert.equal(s.state.pendingSide, 'b')
  clock.t = 1000
  s.tick() // times out → failed
  assert.equal(s.state.pendingSide, null, 'pending cleared on failure')
  assert.equal(s.state.selectedSide, 'a', 'stayed on the real side')
})

test('chooseSide to the already-active side is a no-op', () => {
  const tp = new FakeTransport()
  const s = session(tp, { t: 0 })
  s.chooseSide('a') // already 'a'
  assert.equal(tp.writes.length, 0)
  assert.equal(s.state.pendingSide, null)
})

test('main_channel is no longer a settings row (unified into selectedSide)', () => {
  assert.equal(allSettings.find((x) => x.name === 'main_channel'), undefined)
})

// ── 5f radio notifications (the popups the BT-01 head shows) ────────────────

test('5f 33 push surfaces a "repeater not found" notice, acked, deduped across retries', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const clock = { t: 0 }
  const notices: string[] = []
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => clock.t, {
    onRadioNotice: (text) => notices.push(text),
  })
  void s

  // the radio retries until acked — a burst of identical frames lands before our ack takes hold
  tp.handler(hexToBytes('5f 33 92'))
  tp.handler(hexToBytes('5f 33 92'))
  tp.handler(hexToBytes('5f 33 92'))
  assert.equal(notices.length, 1, 'identical retries within the window collapse to one notice')
  assert.match(notices[0]!, /repeater not found/i)
  // every push still gets the required ack (else the radio never stops retrying)
  assert.equal(tp.writes.filter((w) => w === '03 5f 00 00').length, 3)

  // outside the dedupe window the notice may fire again (a NEW failed transmission)
  clock.t = 20_000
  tp.handler(hexToBytes('5f 33 92'))
  assert.equal(notices.length, 2)

  // 0x34 = missed call (corpus-correlated) — surfaced as its own notice
  tp.handler(hexToBytes('5f 34 02 00 95'))
  assert.equal(notices.length, 3)
  assert.match(notices[2]!, /missed call/i)
  assert.equal(tp.writes.filter((w) => w === '03 5f 00 00').length, 5)
})

// ── external audio jack (08 46, write-only) ────────────────────────────────

test('external_audio_jack writes 08 46 <0|1> byte-exact and confirms on ack', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const s = session(tp, { t: 0 })

  s.setSetting('external_audio_jack', 'on')
  assert.equal(tp.writes[0], '08 46 01 88 1f 00 20 71 02 00 08 51 06 00 08 45 04 00 08 4d 06 00 08')
  assert.deepEqual(s.state.pendingSettings['external_audio_jack'], { desired: 'on', phase: 'pending' })

  tp.handler(hexToBytes('03 08 00 00 0b'))
  assert.equal(s.state.settings['external_audio_jack'], 'on') // write-only → optimistic value persists
  assert.equal(s.state.pendingSettings['external_audio_jack'], undefined)

  s.setSetting('external_audio_jack', 'off')
  assert.equal(tp.writes[1], '08 46 00 88 1f 00 20 71 02 00 08 51 06 00 08 45 04 00 08 4d 06 00 08')
})

test('external_audio_jack reads back from settings block 06 byte 72', () => {
  // Found by diffing two full startup enumerations (BT-01 relay, 2026-07-12): the ONLY
  // functional byte that toggles with the jack is 04 06 offset 72 (01 = on, 00 = off).
  const block = new Uint8Array(99)
  block[0] = 0x04
  block[1] = 0x06
  block[72] = 1
  assert.equal(decodeSettingsBlock(block, '06')['external_audio_jack'], 'on')
  block[72] = 0
  assert.equal(decodeSettingsBlock(block, '06')['external_audio_jack'], 'off')
})
