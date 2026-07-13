import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHANNEL_SETTINGS, channelSettingWrite, channelSettingsForType } from '../src/codec/channel-settings'
import { WRITE_TAIL } from '../src/codec/commands'
import { decodeChannel, decodeZoneChannelCount } from '../src/codec/decode'
import { Session } from '../src/services/session'
import type { RadioState } from '../src/domain/state'
import type { Transport } from '../src/transport/types'
import { bytesToHex, hexToBytes } from './capture'

const flushPromises = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
}

// ── write builder (2f family) ──────────────────────────────────────────────────
test('channelSettingWrite builds 2f <subcmd> <index> + the menu tail', () => {
  const f = channelSettingWrite('txPower', 'High') // TX Power write 0x18, High = index 2
  assert.equal(f[0], 0x2f)
  assert.equal(f[1], 0x18)
  assert.equal(f[2], 2)
  assert.deepEqual([...f.slice(3)], [...WRITE_TAIL])
})

test('channelSettingWrite accepts a raw index and a label equivalently', () => {
  assert.deepEqual(channelSettingWrite('bandwidth', 'Wide'), channelSettingWrite('bandwidth', 1))
})

test('DMR Mode is a structured 2f 08 frame (value in bytes 3-4)', () => {
  assert.equal(bytesToHex(channelSettingWrite('dmrMode', 'Repeater')).slice(0, 14), '2f 08 00 00 00') // (b3,b4)=(0,0)
  assert.equal(bytesToHex(channelSettingWrite('dmrMode', 'Double Slot')).slice(0, 14), '2f 08 00 01 01') // (1,1)
})

test('channelSettingWrite rejects an unknown key or option', () => {
  assert.throws(() => channelSettingWrite('nope', 0), /unknown channel setting/)
  assert.throws(() => channelSettingWrite('txPower', 'Plaid'), /unknown option/)
})

test('mode filter hides analog-only on digital channels and vice-versa', () => {
  const analog = channelSettingsForType('analog').map((s) => s.key)
  const digital = channelSettingsForType('digital').map((s) => s.key)
  assert.ok(analog.includes('squelchMode') && !analog.includes('colorCode'))
  assert.ok(digital.includes('colorCode') && !digital.includes('squelchMode'))
  // type/power/etc apply to both
  assert.ok(analog.includes('txPower') && digital.includes('txPower'))
})

test('every channel setting carries a description (shown in the editor)', () => {
  assert.ok(CHANNEL_SETTINGS.every((s) => s.description.length > 0))
})

// ── DMR Mode decode (byte 54 bit1 + byte 35 bits 2-3) ──────────────────────────
function digitalChannel(patch: (b: Uint8Array) => void): ReturnType<typeof decodeChannel> {
  const b = new Uint8Array(121)
  b[0] = 0x04
  b[1] = 0x2d
  b[10] = 0x01 // type = digital
  patch(b)
  return decodeChannel(b)
}
test('decodeChannel reads DMR Mode from the config bitfields', () => {
  assert.equal(digitalChannel(() => {}).config?.dmrMode, 'repeater') // byte54 bit1 = 0
  assert.equal(digitalChannel((b) => (b[54] = 0x02)).config?.dmrMode, 'simplex') // direct, slot 0
  assert.equal(digitalChannel((b) => { b[54] = 0x02; b[35] = 0x04 }).config?.dmrMode, 'double-slot') // direct, slot 1
})

// ── TX repeater shift (byte 10 bits 6-7: 0 simplex / 1 + / 2 −, offset BCD @6-9) ─
test('decodeChannel applies the repeater-shift direction to txFreqMHz', () => {
  const mk = (dirBits: number): ReturnType<typeof decodeChannel> => {
    const b = new Uint8Array(121)
    b[0] = 0x04
    b[1] = 0x2c
    b.set([0x14, 0x65, 0x00, 0x00], 2) // RX 146.50000 MHz (BCD Hz/10)
    b.set([0x00, 0x06, 0x00, 0x00], 6) // offset 0.6 MHz (BCD)
    b[10] = dirBits << 6
    return decodeChannel(b)
  }
  assert.equal(mk(0).txFreqMHz, 146.5, 'simplex → TX = RX')
  assert.equal(mk(1).txFreqMHz, 147.1, '+ shift adds the offset')
  assert.equal(mk(2).txFreqMHz, 145.9, '− shift subtracts the offset')
})

// ── channel count from the 04 27 member list (live-verified FAVORITES=15, HOTSPOT=7) ─
test('decodeZoneChannelCount counts 04 27 LE16 members before the 0xffff terminator', () => {
  const mk = (members: number[]): Uint8Array => {
    const b = new Uint8Array(104)
    b[0] = 0x04; b[1] = 0x27; b[2] = 0x00 // head + page
    let i = 3
    for (const m of members) { b[i] = m & 0xff; b[i + 1] = (m >> 8) & 0xff; i += 2 }
    b[i] = 0xff; b[i + 1] = 0xff // terminator
    return b
  }
  // FAVORITES: 15 members (the real indices from wire.ndjson zone 0)
  assert.equal(decodeZoneChannelCount(mk([78, 76, 49, 44, 37, 39, 81, 61, 65, 63, 1, 89, 91, 93, 94])), 15)
  assert.equal(decodeZoneChannelCount(mk([1, 2, 3, 4, 5, 6, 7])), 7) // HOTSPOT
  assert.equal(decodeZoneChannelCount(mk([])), 0)
  assert.equal(decodeZoneChannelCount(new Uint8Array([0x04, 0x2c, 0, 0])), null, 'wrong register → null')
})

// ── session: pending → ack → re-read, and failure ──────────────────────────────
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
    if (!this.autoAck) return
    if (bytes[0] === 0x08) this.handler(hexToBytes('03 08 00 00 0b'))
    if (bytes[0] === 0x04 && bytes[1] === 0x5a) this.handler(hexToBytes('04 5a 00 00 08 40 00 ff 8a 00 00 00 00 00 00 00 2f'))
    if (bytes[0] === 0x04 && bytes[1] === 0x5e) this.handler(hexToBytes('04 5e 00 60 02 00 00 00 07 00 00 00 00 00 00 00 00 00 cb'))
    if (bytes[0] === 0x04 && bytes[1] === 0x29) this.handler(hexToBytes('04 29 46 41 56 4f 52 49 54 45 53 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 e0'))
    if (bytes[0] === 0x04 && bytes[1] === 0x2a) this.handler(hexToBytes('04 2a 46 41 56 4f 52 49 54 45 53 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 e1'))
    if (bytes[0] === 0x2f) this.handler(hexToBytes('03 2f 00 00 32'))
    if (bytes[0] === 0x57) this.handler(hexToBytes('03 57 3d 00 97'))
  }
}

test('setChannelSetting: pending → ack applies optimistically and does NOT re-read', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  tp.handler(channelBlockReply())

  s.setChannelSetting('a', 'txPower', 'High') // side a is already selected → no side-select
  assert.deepEqual(s.state.sides.a.pendingChannel['txPower'], { desired: 'High', phase: 'pending' })
  assert.equal(tp.writes[0], `2f 18 02 ${bytesToHex(WRITE_TAIL)}`)

  tp.handler(hexToBytes('03 2f 00 00 32')) // radio acks
  assert.equal(s.state.sides.a.pendingChannel['txPower'], undefined, 'pending cleared on ack')
  assert.equal(s.state.sides.a.channel?.power, 'high', 'decoded channel projection applied optimistically')
  // CRITICAL (anti-corruption): the radio ACKs a write a beat before it commits, so we must NOT
  // read the channel block back inside that window — the BT-01 firmware never does.
  assert.ok(!tp.writes.some((w) => w.startsWith('04 2c')), 'no post-write re-read')
})

test('2f ack lands the value + pending-clear in ONE emission (no stale flash between patches)', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const states: RadioState[] = []
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0, {
    onState: (st) => states.push(st),
  })
  tp.handler(channelBlockReply())
  assert.equal(s.state.sides.a.channel?.power, 'low')
  states.length = 0

  s.setChannelSetting('a', 'txPower', 'High')
  tp.handler(hexToBytes('03 2f 00 00 32')) // radio acks

  assert.equal(s.state.sides.a.channel?.power, 'high')
  // Every broadcast state is a client render: none may show the overlay cleared while the value
  // is still the old one — that intermediate state is exactly what flashed stale in the UI.
  for (const st of states) {
    if (!st.sides.a.pendingChannel['txPower']) {
      assert.equal(st.sides.a.channel?.power, 'high', 'pending cleared but stale value emitted')
    }
  }
})

// The backend contract behind the UI rule that a dormant (sub-off) side stays SELECTABLE: the
// radio's 08 19 side swap is valid regardless of the sub_channel (single-receive) setting, and the
// session must never gate it on that setting.
test('side-select proceeds when sub_channel is off (A/B swap independent of sub power)', async () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.state.settings['sub_channel'] = 'off'
  s.chooseSide('b')
  await flushPromises()
  assert.ok(tp.writes[0]!.startsWith('08 19 01'), 'the 08 19 select goes out')
  assert.equal(s.state.selectedSide, 'b', 'the ack lands the swap')
})

test('setChannelSetting: a failed write marks the overlay failed', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const clock = { t: 0 }
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 1, gapMs: 0 }, () => clock.t)

  s.setChannelSetting('a', 'bandwidth', 'Wide')
  clock.t = 1000
  s.tick() // times out → failed
  assert.deepEqual(s.state.sides.a.pendingChannel['bandwidth'], { desired: 'Wide', phase: 'failed' })
})

test('ANTI-CORRUPTION: a 2f channel write is NEVER retransmitted (PoC bug: dup write races commit)', () => {
  const tp = new FakeTransport()
  tp.autoAck = false // never acks → force the timeout/retransmit path
  const clock = { t: 0 }
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 5, gapMs: 0 }, () => clock.t)
  s.setChannelSetting('a', 'txPower', 'High')
  const writesBefore = tp.writes.length
  for (let i = 1; i <= 5; i++) {
    clock.t = i * 1000
    s.tick()
  }
  const twoF = tp.writes.filter((w) => w.startsWith('2f 18'))
  assert.equal(twoF.length, 1, '2f write must go out exactly once, never re-sent on timeout')
  assert.equal(tp.writes.length, writesBefore, 'nothing else queued behind it')
})

test('setChannelSetting on the non-selected side waits for the side-select ack', async () => {
  const tp = new FakeTransport() // auto-acks 08 + 2f
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.setChannelSetting('b', 'colorCode', '5') // side a active → must switch to b first
  await flushPromises()
  assert.ok(tp.writes[0]!.startsWith('08 19 01'), 'side-select B precedes the channel write')
  assert.ok(tp.writes.some((w) => w.startsWith('2f 21 05')), 'color code 5 via 2f 21')
  assert.ok(!tp.writes.some((w) => w.startsWith('04 5a') || w.startsWith('04 5e')), 'no refresh reads — sides are known')
})

test('setChannelSetting on the non-selected side does not write if side-select fails', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const clock = { t: 0 }
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 1, gapMs: 0 }, () => clock.t)
  s.setChannelSetting('b', 'colorCode', '5')
  assert.ok(tp.writes[0]!.startsWith('08 19 01'))
  clock.t = 1000
  s.tick()
  assert.ok(!tp.writes.some((w) => w.startsWith('2f 21')), 'dependent 2f write is cancelled')
  assert.deepEqual(s.state.sides.b.pendingChannel, {}, 'no pending overlay is left behind')
})

test('setVfoMode re-reads the target channel block after the 57 3d ack', async () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.setVfoMode('a', true)
  await Promise.resolve()
  assert.ok(tp.writes[0]!.startsWith('57 3d 01'))
  assert.ok(tp.writes.some((w) => w.startsWith('04 2c')), 'VFO/MEM ack is followed by a channel A read')
})

// Channel stepping: with the zone's channel count known (zone-block byte 35, Sitting-1 pin) the
// wrap happens host-side; without it we fall back to the radio's own 0xf9 sentinel (confirmed
// radio-side the same sitting: target 0xf9 → last channel).
function setBcd4MHz(bytes: Uint8Array, offset: number, mhz: number): void {
  const digits = String(Math.round(mhz * 100000)).padStart(8, '0')
  for (let i = 0; i < 4; i += 1) {
    bytes[offset + i] = (Number(digits[i * 2]) << 4) | Number(digits[i * 2 + 1])
  }
}

/** A minimal valid 72-byte `04 2c` channel-block reply — resolves the in-flight select so the
 * one-in-flight link releases the next command (the radio answers a select with this block). */
function channelBlockReply(opts: { rxMHz?: number; txMHz?: number } = {}): Uint8Array {
  const b = new Uint8Array(72)
  b[0] = 0x04
  b[1] = 0x2c
  if (opts.rxMHz != null) setBcd4MHz(b, 2, opts.rxMHz)
  if (opts.rxMHz != null && opts.txMHz != null) {
    const diff = Number((opts.txMHz - opts.rxMHz).toFixed(5))
    b[10] = (b[10]! & 0x3f) | ((diff > 0 ? 1 : diff < 0 ? 2 : 0) << 6)
    if (diff !== 0) setBcd4MHz(b, 6, Math.abs(diff))
  }
  let sum = 0
  for (let i = 0; i < 71; i += 1) sum = (sum + b[i]!) & 0xff
  b[71] = sum
  return b
}

// Channel stepping never caps host-side: the radio owns the wrap. Down from 0 uses the 0xf9
// "last channel" sentinel; up just increments (the radio bounds it). Byte 35 of the zone block is
// the CURRENT position, not a channel count, so we must not gate on it (regression 2026-07-05:
// treating b35 as a count locked stepping to the cursor's position).
test('stepChannel: down from 0 uses the 0xf9 sentinel, up increments (radio owns the wrap)', () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.state.sides.a.channelPosition = 0
  s.stepChannel('a', -1)
  assert.ok(tp.writes[0]!.startsWith('04 2c 01 55 f9 00'), 'radio resolves the wrap sentinel')
  tp.handler(channelBlockReply())

  s.state.sides.a.channelPosition = 7
  s.stepChannel('a', 1)
  assert.ok(tp.writes[1]!.startsWith('04 2c 01 55 08 01'), 'plain increment, no host-side cap')
})

test('stepChannel keeps climbing past a low cursor when the count is unknown', () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  // Regression guard (2026-07-05): a cursor at position 2 with no known count must NOT cap at 3.
  s.state.sides.a.channelPosition = 2
  s.stepChannel('a', 1)
  assert.ok(tp.writes[0]!.startsWith('04 2c 01 55 03 01'), 'steps to position 3, not wrapped to 0')
})

test('stepChannel wraps host-side using the REAL channel count (04 27 member count)', () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.state.sides.a.channelCount = 15 // FAVORITES, from the 04 27 member list
  s.state.sides.a.channelPosition = 2
  s.stepChannel('a', 1)
  assert.ok(tp.writes[0]!.startsWith('04 2c 01 55 03 01'), 'mid-zone: plain increment (no false cap)')
  tp.handler(channelBlockReply())

  s.state.sides.a.channelCount = 15
  s.state.sides.a.channelPosition = 14
  s.stepChannel('a', 1)
  assert.ok(tp.writes[1]!.startsWith('04 2c 01 55 00 01'), 'up from the last channel wraps to 0')
  tp.handler(channelBlockReply())

  s.state.sides.a.channelCount = 15
  s.state.sides.a.channelPosition = 0
  s.stepChannel('a', -1)
  assert.ok(tp.writes[2]!.startsWith('04 2c 01 55 0e 00'), 'down from 0 wraps to count-1 (14)')
})

test('stepZone requires a known zone count and wraps within bounds', () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.state.sides.a.zoneNumber = 0
  assert.throws(() => s.stepZone('a', -1), /zone count unknown/)
  assert.equal(tp.writes.length, 0, 'unknown count must not send an out-of-range 08 39')

  s.state.sides.a.zoneCount = 3
  s.stepZone('a', -1)
  assert.ok(tp.writes[0]!.startsWith('08 39 02'), 'down from 0 wraps to last known zone')
  assert.ok(tp.writes.some((w) => w.startsWith('04 29')), 'zone read follows the ack')
  assert.ok(tp.writes.some((w) => w.startsWith('04 2c')), 'channel read follows the ack')
})

test('stepZone up from the last known zone wraps to zero', () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.state.sides.a.zoneNumber = 2
  s.state.sides.a.zoneCount = 3
  s.stepZone('a', 1)
  assert.ok(tp.writes[0]!.startsWith('08 39 00'))
})

// ── Working-frequency writes (2f 03 RX / 2f 04 TX) ──────────────────────────────
test('setFrequency: RX write is pending → ack applies MHz + shift optimistically in ONE emission', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const states: RadioState[] = []
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0, {
    onState: (st) => states.push(st),
  })
  tp.handler(channelBlockReply({ rxMHz: 146.5, txMHz: 147.1 })) // seed the raw 04 2c record the RX write echoes
  states.length = 0 // only inspect emissions from the write itself (setup mutated in place)

  s.setFrequency('a', 'rx', 145_310_000)
  assert.deepEqual(s.state.sides.a.pendingChannel['rxFreq'], { desired: '145.31000', phase: 'pending' })
  assert.ok(tp.writes[0]!.startsWith('2f 03 00 14 53 10 00'), 'echo-back 2f 03 BCD frame')

  tp.handler(hexToBytes('03 2f 00 00 32')) // ack
  assert.equal(s.state.sides.a.pendingChannel['rxFreq'], undefined)
  assert.equal(s.state.sides.a.freqMHz, 145.31)
  assert.equal(s.state.sides.a.txFreqMHz, 145.91, 'TX display carries the +0.6 shift')
  assert.ok(!tp.writes.some((w) => w.startsWith('04 2c')), 'no post-write re-read')
  for (const st of states) {
    if (!st.sides.a.pendingChannel['rxFreq']) {
      assert.equal(st.sides.a.freqMHz, 145.31, 'pending cleared but stale frequency emitted')
    }
  }
})

test('setFrequency: TX write updates only txFreqMHz; timeout marks the overlay failed', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const clock = { t: 0 }
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 1, gapMs: 0 }, () => clock.t)
  tp.handler(channelBlockReply({ rxMHz: 446.0 })) // seed the raw record (needed for the RX write below)

  s.setFrequency('a', 'tx', 446_006_250)
  assert.ok(tp.writes[0]!.startsWith('2f 04 00'), 'BE32 2f 04 frame')
  tp.handler(hexToBytes('03 2f 00 00 32'))
  assert.equal(s.state.sides.a.txFreqMHz, 446.00625)
  assert.equal(s.state.sides.a.freqMHz, 446.0, 'RX untouched by a TX write')

  s.setFrequency('a', 'rx', 145_310_000)
  clock.t = 1000
  s.tick() // times out
  assert.deepEqual(s.state.sides.a.pendingChannel['rxFreq'], { desired: '145.31000', phase: 'failed' })
})

test('setFrequency rejects an out-of-range value before any state change', () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  assert.throws(() => s.setFrequency('a', 'rx', 50_000), /out of range/)
  assert.equal(tp.writes.length, 0)
  assert.deepEqual(s.state.sides.a.pendingChannel, {})
})

// ── RX/TX tone writes (2f 16 / 2f 02, structured template) ──────────────────────
import { channelToneWrite, toneLabel } from '../src/codec/tones'

test('channelToneWrite builds the structured tone template (CTCSS / off / DCS)', () => {
  // CTCSS: type 1, b3 = 1-based index. 100.0 Hz = index 13.
  const rxCtc = channelToneWrite('rx', 'ctc', 13)
  assert.equal(bytesToHex(rxCtc).slice(0, 23), '2f 16 01 0d 00 00 00 00')
  // TX uses subcmd 02
  assert.equal(channelToneWrite('tx', 'ctc', 13)[1], 0x02)
  // Off: type 0, b7 = 02
  const off = channelToneWrite('rx', 'off')
  assert.equal(bytesToHex(off).slice(0, 23), '2f 16 00 00 00 00 00 02')
  // DCS D023 normal: type 2, b3:b4 = 16-bit of 0o23 = 0x0013
  const dcs = channelToneWrite('rx', 'dcs', 23)
  assert.equal(bytesToHex(dcs).slice(0, 14), '2f 16 02 00 13')
  // DCS inverted: type 3
  assert.equal(channelToneWrite('rx', 'dcs', 23, true)[2], 3)
  // shared fixed tail
  assert.equal(bytesToHex(rxCtc).slice(24), '00 00 00 05 05 05 05 06 06 06 06 07 07 07 07')
})

test('channelToneWrite validates its inputs', () => {
  assert.throws(() => channelToneWrite('rx', 'ctc', 0), /invalid CTCSS index/)
  assert.throws(() => channelToneWrite('rx', 'ctc', 51), /invalid CTCSS index/)
  assert.throws(() => channelToneWrite('tx', 'dcs', 24), /invalid DCS code/)
})

test('toneLabel matches the decoded display form', () => {
  assert.equal(toneLabel('off'), 'Off')
  assert.equal(toneLabel('ctc', 13), '100.0')
  assert.equal(toneLabel('dcs', 23), 'D023')
})

test('tone ack lands the new tone + pending-clear in ONE emission (no stale flash)', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const states: RadioState[] = []
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0, {
    onState: (st) => states.push(st),
  })
  s.state.sides.a.channel = {
    type: 'analog', power: 'high', bandwidthKHz: 25, reverse: false, txProhibit: false,
    talkaround: false, rxTone: { kind: 'off', display: 'Off', ctcssIndex: null, dcsCode: null },
    txTone: null, squelchMode: null, optionalSignal: null, compander: null, scrambler: null,
    busyLock: null, colorCode: null, timeSlot: null, txInterrupt: null, aprsReceive: null,
    smsForbid: null, dataAckForbid: null, dmrMode: null, contact: null,
  }

  s.setChannelTone('a', 'rx', 'ctc', 13)
  tp.handler(hexToBytes('03 2f 00 00 32')) // ack

  assert.equal(s.state.sides.a.channel?.rxTone?.display, '100.0')
  for (const st of states) {
    if (!st.sides.a.pendingChannel['rxTone']) {
      assert.equal(st.sides.a.channel?.rxTone?.display, '100.0', 'pending cleared but stale tone emitted')
    }
  }
})

test('tone ack with no channel block read yet still clears the pending overlay', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.setChannelTone('a', 'rx', 'ctc', 13) // sides.a.channel is still null
  tp.handler(hexToBytes('03 2f 00 00 32'))
  assert.deepEqual(s.state.sides.a.pendingChannel, {}, 'no stuck spinner when the config is unknown')
})

test('setChannelTone: pending → ack applies optimistically (no re-read); failure marks failed', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const clock = { t: 0 }
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 1, gapMs: 0 }, () => clock.t)

  s.setChannelTone('a', 'rx', 'ctc', 13)
  assert.deepEqual(s.state.sides.a.pendingChannel['rxTone'], { desired: '100.0', phase: 'pending' })
  assert.ok(tp.writes[0]!.startsWith('2f 16 01 0d'))

  tp.handler(hexToBytes('03 2f 00 00 32')) // ack
  assert.equal(s.state.sides.a.pendingChannel['rxTone'], undefined)
  assert.ok(!tp.writes.some((w) => w.startsWith('04 2c')), 'no post-write re-read')

  s.setChannelTone('a', 'tx', 'dcs', 23, true)
  clock.t = 1000
  s.tick() // the tone write times out → failed (no re-read consuming a slot anymore)
  assert.deepEqual(s.state.sides.a.pendingChannel['txTone'], { desired: 'D023', phase: 'failed' })
})
