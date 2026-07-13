import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pttKey, pttUnkey, settingWrite } from '../src/codec/commands'
import { nextPttPhase } from '../src/domain/ptt'
import { Session } from '../src/services/session'
import type { Transport } from '../src/transport/types'
import { bytesToHex, hexToBytes } from './capture'

// ── pure lifecycle machine ─────────────────────────────────────────────────
test('PTT happy path: idle → keying → keyed → unkeying → idle', () => {
  assert.equal(nextPttPhase('idle', 'key'), 'keying')
  assert.equal(nextPttPhase('keying', 'acked'), 'keyed')
  assert.equal(nextPttPhase('keyed', 'unkey'), 'unkeying')
  assert.equal(nextPttPhase('unkeying', 'acked'), 'idle')
})

test('PTT failures go to fault; an unkey failure must NEVER reach idle', () => {
  assert.equal(nextPttPhase('keying', 'failed'), 'fault')
  assert.equal(nextPttPhase('unkeying', 'failed'), 'fault') // not idle — safety-critical
  assert.equal(nextPttPhase('fault', 'key'), 'keying') // can re-key out of fault
})

test('PTT ignores invalid intents', () => {
  assert.equal(nextPttPhase('idle', 'unkey'), 'idle')
  assert.equal(nextPttPhase('keyed', 'key'), 'keyed')
  assert.equal(nextPttPhase('keying', 'key'), 'keying')
})

// ── command encoders (no checksum on outbound) ──────────────────────────────
test('PTT encoders produce the exact captured bytes', () => {
  assert.equal(bytesToHex(pttKey()), '56 01 00 01' + ' 00'.repeat(19))
  assert.equal(bytesToHex(pttUnkey()), '56 00 00 01' + ' 00'.repeat(19))
  assert.equal(pttKey().length, 23)
})

test('settingWrite builds 08 <op> <val> + fixed tail (matches captured 08 04 01)', () => {
  assert.equal(
    bytesToHex(settingWrite('key_tone', 'L1')),
    '08 04 01 88 1f 00 20 71 02 00 08 51 06 00 08 45 04 00 08 4d 06 00 08',
  )
  assert.equal(settingWrite('key_tone', 1)[2], 1) // raw index accepted
  assert.equal(settingWrite('talk_permit', 'both')[2], 3) // option label → index
  assert.throws(() => settingWrite('key_tone', 'bogus'))
  assert.throws(() => settingWrite('no_such_setting', 0))
})

// ── Session integration over a fake transport ───────────────────────────────
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
    if (this.autoAck && bytes[0] === 0x56) this.handler(hexToBytes('03 56 00 00 59'))
  }
}

function session(tp: FakeTransport, clock: { t: number }) {
  return new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => clock.t)
}

test('key → keyed and unkey → idle through the Session (acked)', () => {
  const tp = new FakeTransport()
  const s = session(tp, { t: 0 })
  assert.equal(s.state.ptt, 'idle')
  s.key()
  assert.equal(s.state.ptt, 'keyed') // submit→write→auto-ack→resolve, all synchronous
  assert.equal(tp.writes[0], '56 01 00 01' + ' 00'.repeat(19))
  s.unkey()
  assert.equal(s.state.ptt, 'idle')
})

test('key shows keying until the ack arrives', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const s = session(tp, { t: 0 })
  s.key()
  assert.equal(s.state.ptt, 'keying')
  tp.handler(hexToBytes('03 56 00 00 59'))
  assert.equal(s.state.ptt, 'keyed')
})

test('a dropped key-down is retransmitted (busy-gate recovery) and the late ack keys', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const clock = { t: 0 }
  const s = session(tp, clock)
  s.key()
  assert.equal(s.state.ptt, 'keying')
  assert.equal(tp.writes.length, 1)
  clock.t = 1000
  s.tick() // first send swallowed by the radio's mid-RX busy-gate → bounded retransmit
  assert.equal(tp.writes.length, 2, 'key-down retransmitted')
  assert.ok(tp.writes[1]!.startsWith('56 01'))
  tp.handler(hexToBytes('03 56 00 00 59')) // the retransmit lands
  assert.equal(s.state.ptt, 'keyed')
})

test('key-down exhausts its bounded attempts → the failsafe RELEASE goes out', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const clock = { t: 0 }
  const s = session(tp, clock)
  s.key()
  clock.t = 1000
  s.tick() // attempt 2
  clock.t = 2000
  s.tick() // attempt 3 (KEY_MAX_ATTEMPTS)
  clock.t = 3000
  s.tick() // exhausted → failsafe release
  assert.equal(s.state.ptt, 'unkeying', 'TX state unknown → force a release')
  const keys = tp.writes.filter((w) => w.startsWith('56 01'))
  const releases = tp.writes.filter((w) => w.startsWith('56 00'))
  assert.equal(keys.length, 3, 'exactly KEY_MAX_ATTEMPTS key-down sends')
  assert.equal(releases.length, 1, 'then the automatic release')
})

test('release during the key-down retry window is honored the moment the ack lands', () => {
  const tp = new FakeTransport()
  tp.autoAck = false
  const clock = { t: 0 }
  const s = session(tp, clock)
  s.key()
  s.unkey() // operator lets go while the key-down is still unacked → stored as intent
  assert.equal(s.state.ptt, 'keying', 'no premature state change')
  clock.t = 1000
  s.tick() // retransmit
  tp.handler(hexToBytes('03 56 00 00 59')) // key-down finally acks…
  // …and the stored release goes out immediately — the radio must not stay keyed
  assert.equal(s.state.ptt, 'unkeying')
  assert.ok(tp.writes[tp.writes.length - 1]!.startsWith('56 00'), 'release followed the ack')
  tp.handler(hexToBytes('03 56 00 00 59'))
  assert.equal(s.state.ptt, 'idle')
})

test('unkey is a no-op when not keyed', () => {
  const tp = new FakeTransport()
  const s = session(tp, { t: 0 })
  s.unkey()
  assert.equal(s.state.ptt, 'idle')
  assert.equal(tp.writes.length, 0)
})
