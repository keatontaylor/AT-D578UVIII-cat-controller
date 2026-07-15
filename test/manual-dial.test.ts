// Manual DMR dial: the 56 extended-tail frame + the sticky override through the Session.
// Byte-validated against the BT-01 relay capture `56 01 00 00 06 01 00 00 00 7b` (key, side A,
// manual, GROUP, target 123).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { manualDialPtt } from '../src/codec/commands'
import { Session } from '../src/services/session'
import type { Transport } from '../src/transport/types'
import { bytesToHex } from './capture'
import type { ChannelConfig } from '../src/codec/decode'

const hex = (b: Uint8Array): string => bytesToHex(b).replace(/ /g, '')

test('manualDialPtt is byte-exact against the captured BT-01 frame', () => {
  // 56 01 00 00 06 01 00 00 00 7b + zeros(13) — key, side A, manual setup, group, target 123.
  assert.equal(hex(manualDialPtt(true, 'a', 123, 'group')).slice(0, 20), '5601000006010000007b')
  // release: frame[4] = 00, key byte 00, tail preserved.
  assert.equal(hex(manualDialPtt(false, 'a', 123, 'group')).slice(0, 20), '5600000000010000007b')
  // side B → frame[3]=01; private → frame[5]=00; big-endian target.
  assert.equal(hex(manualDialPtt(true, 'b', 3223436, 'private')).slice(0, 20), '56010001060000312f8c')
  assert.throws(() => manualDialPtt(true, 'a', 0, 'group'), /out of 24-bit range/)
})

const DIGITAL: ChannelConfig = {
  type: 'digital', power: 'high', bandwidthKHz: 12.5, reverse: false, txProhibit: false,
  talkaround: false, rxTone: null, txTone: null, squelchMode: null, optionalSignal: null,
  compander: null, scrambler: null, busyLock: null, colorCode: 1, timeSlot: 1, txInterrupt: null,
  aprsReceive: null, smsForbid: null, dataAckForbid: null, dmrMode: 'repeater', contact: null,
}

class FakeTransport implements Transport {
  handler: (chunk: Uint8Array) => void = () => {}
  writes: string[] = []
  onData(h: (chunk: Uint8Array) => void): void { this.handler = h }
  onClose(): void {}
  close(): void {}
  write(bytes: Uint8Array): void {
    this.writes.push(bytesToHex(bytes))
    if (bytes[0] === 0x56) this.handler(Uint8Array.from([0x03, 0x56, 0x00, 0x00, 0x59]))
  }
}

test('setManualDial stores the override in state (no radio write until PTT)', () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.setManualDial('a', 123, 'group')
  assert.deepEqual(s.state.manualDial.a, { target: 123, callType: 'group' })
  assert.equal(s.state.manualDial.b, null, 'the other side keeps its own (unset) dial')
  assert.equal(tp.writes.length, 0, 'dial is a local override — nothing sent yet')
  s.clearManualDial('a')
  assert.equal(s.state.manualDial.a, null)
})

test('each side keeps its own manual dial (both DMR)', () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.setManualDial('a', 700, 'group')
  s.setManualDial('b', 720, 'group')
  assert.deepEqual(s.state.manualDial.a, { target: 700, callType: 'group' })
  assert.deepEqual(s.state.manualDial.b, { target: 720, callType: 'group' })
  s.clearManualDial('a')
  assert.equal(s.state.manualDial.a, null)
  assert.deepEqual(s.state.manualDial.b, { target: 720, callType: 'group' }, 'clearing one leaves the other')
})

test('PTT on a DMR channel with a dial set sends the manual-dial frame; plain PTT otherwise', () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.state.sides.a.channel = DIGITAL
  s.setManualDial('a', 123, 'group')
  s.key()
  assert.ok(tp.writes[0]!.startsWith('56 01 00 00 06 01 00 00 00 7b'), 'manual-dial key frame')
  s.unkey()
  assert.ok(tp.writes[1]!.startsWith('56 00 00 00 00 01 00 00 00 7b'), 'manual-dial release frame')
})

test('manual dial is ignored on an analog channel (plain PTT)', () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.state.sides.a.channel = { ...DIGITAL, type: 'analog' }
  s.setManualDial('a', 123, 'group')
  s.key()
  assert.ok(tp.writes[0]!.startsWith('56 01 00 01'), 'plain analog PTT, dial ignored')
})
