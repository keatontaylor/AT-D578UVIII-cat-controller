// Scenario: the PTT FAILSAFE — the safety-critical path. A key-down is retryable but tightly
// BOUNDED (KEY_MAX_ATTEMPTS = 3; the radio's busy-gate drops 0x56 mid-RX and the real BT-01
// retransmits too) — an ARQ retransmit only re-sends an UNACKED command, and a release during
// the retry window is stored as intent and honored on the ack. Exhaustion triggers an automatic
// release. The release IS retransmitted with the full budget (~timeoutMs × maxAttempts — 10 s in
// production, 3 s in this rig), and when even that goes unanswered the controller severs
// Bluetooth entirely: the radio treats remote-control deactivation as PTT release. The error
// must persist so a client that loads the page LATER still sees it (it rides state.snapshot).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rig } from './sim/harness'
import { FullRig, MirrorClient } from './sim/full-rig'

test('normal key/unkey: acked both ways, no failsafe involvement', async (t) => {
  const rig = await Rig.create(t)
  rig.session.key()
  await rig.advance(50)
  assert.equal(rig.state.ptt, 'keyed')
  rig.session.unkey()
  await rig.advance(50)
  assert.equal(rig.state.ptt, 'idle')
  assert.deepEqual(rig.pttFailsafes, [])
  rig.assertClean()
})

test('unacked RELEASE: retransmitted until exhausted, then the failsafe fires', async (t) => {
  const rig = await Rig.create(t)
  rig.session.key()
  await rig.advance(50)
  assert.equal(rig.state.ptt, 'keyed')

  rig.sim.ignoreNext(0x56, 10) // the radio goes deaf to PTT — release + every retransmit vanish
  const writesBefore = rig.sim.writes.length
  rig.session.unkey()
  await rig.advance(4000) // ride out timeoutMs(1000) × maxAttempts(3)

  const unkeys = rig.sim.writes.slice(writesBefore).filter((w) => w[0] === 0x56 && w[1] === 0x00)
  assert.equal(unkeys.length, 3, 'the release was retransmitted to the attempt limit')
  assert.equal(rig.state.ptt, 'fault', 'never reports released when the radio may still transmit')
  assert.deepEqual(rig.pttFailsafes, ['the radio did not acknowledge PTT release'])
  rig.assertClean({ allowFailures: true })
})

test('busy-gate drop: a swallowed key-down is retransmitted and the retry KEYS', async (t) => {
  const rig = await Rig.create(t)
  rig.sim.ignoreNext(0x56, 1) // the firmware busy-gate eats exactly the first key-down
  const writesBefore = rig.sim.writes.length
  rig.session.key()
  await rig.advance(1500) // past one timeout — the bounded retransmit goes out and acks

  const keys = rig.sim.writes.slice(writesBefore).filter((w) => w[0] === 0x56 && w[1] === 0x01)
  assert.equal(keys.length, 2, 'one drop + one retransmit')
  assert.equal(rig.state.ptt, 'keyed', 'the retry punched through the busy-gate')
  assert.deepEqual(rig.pttFailsafes, [])
  rig.session.unkey()
  await rig.advance(100)
  assert.equal(rig.state.ptt, 'idle')
  rig.assertClean({ allowFailures: true })
})

test('unacked KEY-DOWN: bounded attempts exhaust, automatic release recovers to idle', async (t) => {
  const rig = await Rig.create(t)
  rig.sim.ignoreNext(0x56, 3) // every key-down attempt vanishes; the radio hears the release
  const writesBefore = rig.sim.writes.length
  rig.session.key()
  await rig.advance(4000) // 3 attempts × 1 s → exhausted → the automatic release goes out and acks

  const keys = rig.sim.writes.slice(writesBefore).filter((w) => w[0] === 0x56 && w[1] === 0x01)
  const unkeys = rig.sim.writes.slice(writesBefore).filter((w) => w[0] === 0x56 && w[1] === 0x00)
  assert.equal(keys.length, 3, 'exactly KEY_MAX_ATTEMPTS key-down sends, never more')
  assert.equal(unkeys.length, 1, 'the failsafe release was sent automatically')
  assert.equal(rig.state.ptt, 'idle', 'released cleanly once the radio acked the release')
  assert.deepEqual(rig.pttFailsafes, [], 'no teardown needed — the release worked')
  rig.assertClean({ allowFailures: true })
})

test('release during the retry window: stored as intent, honored on the late ack', async (t) => {
  const rig = await Rig.create(t)
  rig.sim.ignoreNext(0x56, 1) // first key-down eaten → the ack arrives only for the retry
  rig.session.key()
  await rig.advance(200)
  rig.session.unkey() // operator lets go while the key-down is still unacked
  assert.equal(rig.state.ptt, 'keying', 'intent stored, no premature state change')
  await rig.advance(1500) // retransmit → ack → the stored release fires immediately
  assert.equal(rig.state.ptt, 'idle', 'the transmitter never outlives the button press')
  rig.assertClean({ allowFailures: true })
})

test('radio fully deaf to PTT: key-down exhausts, release exhausts, failsafe escalates', async (t) => {
  const rig = await Rig.create(t)
  rig.sim.ignoreNext(0x56, 10) // deaf to everything PTT
  rig.session.key()
  await rig.advance(8000) // key attempts (3 s) + release retransmits (3 s) + margin
  assert.equal(rig.state.ptt, 'fault')
  assert.deepEqual(rig.pttFailsafes, ['the radio did not acknowledge PTT release'])
  rig.assertClean({ allowFailures: true })
})

test('manual retry from fault: unkey() works again and can recover without teardown', async (t) => {
  const rig = await Rig.create(t)
  rig.session.key()
  await rig.advance(50)
  rig.sim.ignoreNext(0x56, 3) // this release exhausts → fault
  rig.session.unkey()
  await rig.advance(4000)
  assert.equal(rig.state.ptt, 'fault')

  rig.session.unkey() // the operator (or UI) tries again — the radio is listening now
  await rig.advance(100)
  assert.equal(rig.state.ptt, 'idle', 'fault is recoverable when the radio comes back')
  rig.assertClean({ allowFailures: true })
})

// ── the full loop: controller teardown + the persistent, snapshot-borne error ──

test('failsafe end-to-end: Bluetooth is severed, no auto-reconnect, the error reaches a LATE client', async (t) => {
  const rig = await FullRig.create(t, { reconnect: true })
  rig.controller.key()
  await rig.advance(50)
  assert.equal(rig.client.radio.ptt, 'keyed')

  rig.sim.ignoreNext(0x56, 10)
  rig.controller.unkey()
  await rig.advance(5000) // exhaust the release retries → failsafe teardown

  assert.equal(rig.client.connection, 'disconnected', 'Bluetooth was severed like a user disconnect')
  assert.match(rig.client.error ?? '', /PTT failsafe/, 'the client is told WHY')
  assert.match(rig.client.error ?? '', /stop transmitting/, 'and what the teardown was for')

  // NO silent reconnect into a radio that just ignored a release
  await rig.advance(10_000)
  assert.equal(rig.client.connection, 'disconnected', 'reconnect intent was cancelled')

  // a browser tab opened AFTER the event still sees it — the error rides the state.snapshot
  const late = new MirrorClient()
  const unsub = rig.broadcaster.subscribe((m) => late.onMessage(m))
  assert.match(late.state?.error ?? '', /PTT failsafe/, 'late-joining client sees the failsafe error')
  unsub()
  rig.assertClean()
})
