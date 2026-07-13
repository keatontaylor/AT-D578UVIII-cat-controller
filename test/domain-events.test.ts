// The domain-event reducer contract: ONE event in, ONE new state out — every mutation
// (inbound frame or write lifecycle) flows through applyEvent, so a logical mutation can never
// straddle two broadcast patches (the stale-flash class of bug is structurally impossible).
// No-op events return the SAME reference, which the Session uses to skip the broadcast.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEvent } from '../src/domain/reduce'
import { initialState, type RadioState } from '../src/domain/state'
import { bytesToHexStr, hexStrToBytes, readField } from '../src/codec/record'
import { hexToBytes } from './capture'

const frame = (hex: string) => {
  const bytes = hexToBytes(hex)
  return { head: bytes[0]!, reg: bytes[0] === 0x04 ? bytes[1]! : undefined, bytes, checksumOk: true }
}

const channelFrame = () => {
  const bytes = new Uint8Array(121)
  bytes[0] = 0x04
  bytes[1] = 0x2c
  bytes[2] = 0x14
  bytes[3] = 0x65
  bytes[4] = 0x00
  bytes[5] = 0x00
  bytes[6] = 0x00
  bytes[7] = 0x06
  bytes[8] = 0x00
  bytes[9] = 0x00
  bytes[10] = 0x00
  bytes[11] = 0x00
  let sum = 0
  for (let i = 0; i < bytes.length - 1; i += 1) sum = (sum + bytes[i]!) & 0xff
  bytes[bytes.length - 1] = sum
  return { head: 0x04, reg: 0x2c, bytes, checksumOk: true }
}

test('setting: pending → acked applies value AND clears the overlay in one reduction', () => {
  let s = applyEvent(initialState(), { kind: 'setting', phase: 'pending', name: 'key_tone', desired: 'L1' })
  assert.deepEqual(s.pendingSettings['key_tone'], { desired: 'L1', phase: 'pending' })
  assert.equal(s.settings['key_tone'], undefined, 'reported untouched while pending')

  s = applyEvent(s, { kind: 'setting', phase: 'acked', name: 'key_tone', desired: 'L1' })
  assert.equal(s.settings['key_tone'], 'L1')
  assert.equal(s.pendingSettings['key_tone'], undefined, 'overlay cleared in the SAME state')
})

test('setting: failed flips the overlay, reported stays authoritative', () => {
  let s = applyEvent(initialState(), { kind: 'setting', phase: 'pending', name: 'scan_mode', desired: 'SE' })
  s = applyEvent(s, { kind: 'setting', phase: 'failed', name: 'scan_mode', desired: 'SE' })
  assert.deepEqual(s.pendingSettings['scan_mode'], { desired: 'SE', phase: 'failed' })
  assert.equal(s.settings['scan_mode'], undefined)
})

test('channelSetting: acked without a channel block still clears the overlay', () => {
  let s = applyEvent(initialState(), { kind: 'channelSetting', phase: 'pending', side: 'a', key: 'txPower', desired: 'High' })
  assert.deepEqual(s.sides.a.pendingChannel['txPower'], { desired: 'High', phase: 'pending' })

  s = applyEvent(s, { kind: 'channelSetting', phase: 'acked', side: 'a', key: 'txPower', desired: 'High' })
  assert.equal(s.sides.a.pendingChannel['txPower'], undefined)
  assert.equal(s.sides.a.channel, null)
})

test('channelSetting: acked updates channelRaw so later echo-back writes are not stale', () => {
  let s = applyEvent(initialState(), { kind: 'frame', frame: channelFrame() })
  s = applyEvent(s, { kind: 'channelSetting', phase: 'acked', side: 'a', key: 'txPower', desired: 'High' })
  const raw = hexStrToBytes(s.sides.a.channelRaw!)
  assert.equal(readField('channel', raw, 'txPower'), 2)
  assert.equal(s.sides.a.channel?.power, 'high')
})

test('channelSetting: acked reprojects decoded channel fields from the mutated raw record', () => {
  let s = applyEvent(initialState(), { kind: 'frame', frame: channelFrame() })
  assert.equal(s.sides.a.channel?.bandwidthKHz, 12.5)

  s = applyEvent(s, { kind: 'channelSetting', phase: 'acked', side: 'a', key: 'bandwidth', desired: 'Wide' })

  const raw = hexStrToBytes(s.sides.a.channelRaw!)
  assert.equal(readField('channel', raw, 'bandwidth'), 1)
  assert.equal(s.sides.a.channel?.bandwidthKHz, 25)
  assert.equal(s.sides.a.pendingChannel['bandwidth'], undefined)
})

test('channelTone: acked without a channel block still settles the overlay (no stuck spinner)', () => {
  let s = applyEvent(initialState(), { kind: 'channelTone', phase: 'pending', side: 'a', field: 'rx', type: 'ctc', value: 13, desired: '100.0' })
  s = applyEvent(s, { kind: 'channelTone', phase: 'acked', side: 'a', field: 'rx', type: 'ctc', value: 13, desired: '100.0' })
  assert.deepEqual(s.sides.a.pendingChannel, {})
  assert.equal(s.sides.a.channel, null, 'no config to update — overlay still cleared')
})

test('channelTone: acked updates channelRaw tone fields', () => {
  let s = applyEvent(initialState(), { kind: 'frame', frame: channelFrame() })
  s = applyEvent(s, { kind: 'channelTone', phase: 'acked', side: 'a', field: 'rx', type: 'ctc', value: 13, desired: '100.0' })
  const raw = hexStrToBytes(s.sides.a.channelRaw!)
  assert.equal(readField('channel', raw, 'rxToneType'), 1)
  assert.equal(readField('channel', raw, 'rxCtcssIndex'), 13)
})

test('channelFrequency: RX ack retunes and carries the repeater shift into TX', () => {
  let s: RadioState = initialState()
  s = { ...s, sides: { ...s.sides, a: { ...s.sides.a, freqMHz: 146.5, txFreqMHz: 147.1 } } }
  s = applyEvent(s, { kind: 'channelFrequency', phase: 'pending', side: 'a', field: 'rx', mhz: 145.31, desired: '145.31000' })
  s = applyEvent(s, { kind: 'channelFrequency', phase: 'acked', side: 'a', field: 'rx', mhz: 145.31, desired: '145.31000' })
  assert.equal(s.sides.a.freqMHz, 145.31)
  assert.equal(s.sides.a.txFreqMHz, 145.91, '+0.6 shift preserved')
  assert.deepEqual(s.sides.a.pendingChannel, {})
})

test('channelFrequency: ACKs update raw frequency fields', () => {
  let s = applyEvent(initialState(), { kind: 'frame', frame: channelFrame() })
  s = applyEvent(s, { kind: 'channelFrequency', phase: 'acked', side: 'a', field: 'rx', mhz: 145.31, desired: '145.31000' })
  assert.equal(readField('channel', hexStrToBytes(s.sides.a.channelRaw!), 'rxFreq'), 14531000)

  s = applyEvent(s, { kind: 'channelFrequency', phase: 'acked', side: 'a', field: 'tx', mhz: 146.52, desired: '146.52000' })
  const raw = hexStrToBytes(s.sides.a.channelRaw!)
  assert.equal(readField('channel', raw, 'shiftDir'), 1)
  assert.equal(readField('channel', raw, 'txOffset'), 121000)
})

test('sideSelect: pending → acked flips selectedSide; failed reverts pending only', () => {
  let s = applyEvent(initialState(), { kind: 'sideSelect', phase: 'pending', side: 'b' })
  assert.equal(s.pendingSide, 'b')
  assert.equal(s.selectedSide, 'a')

  const acked = applyEvent(s, { kind: 'sideSelect', phase: 'acked', side: 'b' })
  assert.equal(acked.selectedSide, 'b')
  assert.equal(acked.pendingSide, null)

  const failed = applyEvent(s, { kind: 'sideSelect', phase: 'failed', side: 'b' })
  assert.equal(failed.selectedSide, 'a', 'never moved')
  assert.equal(failed.pendingSide, null)
})

test('no-op events return the SAME reference (dispatch skips the broadcast)', () => {
  const s = initialState()
  assert.equal(applyEvent(s, { kind: 'ptt', phase: 'idle' }), s, 'ptt already idle')
  assert.equal(applyEvent(s, { kind: 'sideSelect', phase: 'failed', side: 'b' }), s, 'nothing pending to revert')
  const withCount = applyEvent(s, { kind: 'channelCount', side: 'a', count: 15 })
  assert.notEqual(withCount, s)
  assert.equal(applyEvent(withCount, { kind: 'channelCount', side: 'a', count: 15 }), withCount, 'same count')
})

test('frame events delegate to the frame reducer (one entry point for everything)', () => {
  const s = applyEvent(initialState(), { kind: 'frame', frame: frame('5b 01 5c') })
  assert.equal(s.audioGate, true)
})
