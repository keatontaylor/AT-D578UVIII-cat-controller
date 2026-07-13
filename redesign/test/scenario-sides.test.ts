// Scenario: the SIDE state machine under live traffic — the flip-flop/misattribution class of bug.
// Full production stack against the SimRadio (see test/sim/harness.ts). The sim reports 5a
// side-RELATIVE (like the hardware) and models the measured post-swap push suspension, so these
// tests prove the selectedSide/pendingSide lifecycle, the settle-window hold, and above all that
// PHYSICAL side attribution never wavers across a swap.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rig } from './sim/harness'

test('swap with steady RX: signal attribution NEVER flip-flops across the swap', async (t) => {
  const rig = await Rig.create(t)
  rig.sim.setCarrier('a', 3)
  await rig.advance(50)
  assert.equal(rig.state.signal.aOpen, true)
  assert.equal(rig.state.signal.aRssi, 3)
  const emissionsBefore = rig.states.length

  rig.session.chooseSide('b')
  await rig.advance(1500) // through the ack + BOTH settle windows (sim 900 ms, session 1000 ms)
  rig.sim.nudge() // the radio's next activity push — now in the NEW frame of reference
  await rig.flush()

  // The physical truth never changed: side A receiving, side B quiet. EVERY emission across the
  // swap must agree — one frame of B-attributed signal is the flip-flop bug.
  for (let i = emissionsBefore; i < rig.states.length; i += 1) {
    const s = rig.states[i]!
    assert.equal(s.signal.aOpen, true, `emission ${i + 1}: aOpen flapped during swap`)
    assert.equal(s.signal.bOpen, false, `emission ${i + 1}: bOpen flapped during swap`)
    assert.equal(s.signal.aRssi, 3, `emission ${i + 1}: aRssi flapped during swap`)
    assert.equal(s.signal.bRssi, 0, `emission ${i + 1}: bRssi flapped during swap`)
  }
  assert.equal(rig.state.selectedSide, 'b')
  assert.equal(rig.state.pendingSide, null)
  rig.expectConsistent()
  rig.assertClean()
})

test('swap lifecycle: pendingSide marks the flight, selectedSide moves only on the ack', async (t) => {
  const rig = await Rig.create(t)
  const before = rig.states.length
  rig.session.chooseSide('b')
  await rig.advance(50)

  // find the two lifecycle emissions: pending (selectedSide still a), then acked (b, pending null)
  const seq = rig.states.slice(before).map((s) => `${s.selectedSide}/${s.pendingSide ?? '-'}`)
  assert.ok(seq.includes('a/b'), `pending phase seen (got ${JSON.stringify(seq)})`)
  assert.ok(seq.includes('b/-'), `acked phase seen (got ${JSON.stringify(seq)})`)
  assert.ok(seq.indexOf('a/b') < seq.indexOf('b/-'), 'pending precedes acked')
  rig.assertClean()
})

test('the session issues NO status reads inside the post-swap settle window', async (t) => {
  const rig = await Rig.create(t)
  const writesBefore = rig.sim.writes.length
  rig.session.chooseSide('b')
  await rig.advance(1200)
  const postSwap = rig.sim.writes.slice(writesBefore)
  const statusReads = postSwap.filter((w) => w[0] === 0x04 && (w[1] === 0x5a || w[1] === 0x5e || w[1] === 0x2c || w[1] === 0x2d))
  assert.equal(statusReads.length, 0, 'a read inside the settle window returns stale-reference data')
  rig.assertClean()
})

test('failed swap: pendingSide reverts, selectedSide never moves, pushes flow again', async (t) => {
  const rig = await Rig.create(t)
  rig.sim.ignoreNext(0x08, 3) // the select AND its retransmits vanish
  rig.session.chooseSide('b')
  await rig.advance(100)
  assert.equal(rig.state.pendingSide, 'b', 'flight marked')
  await rig.advance(3500) // exhaust ARQ
  assert.equal(rig.state.pendingSide, null, 'reverted')
  assert.equal(rig.state.selectedSide, 'a', 'never moved')
  assert.equal(rig.sim.selectedSide, 'a', 'the radio never switched either')

  // no swap happened → 5a pushes must land immediately (the suppression hold was rolled back)
  rig.sim.setCarrier('b', 2)
  await rig.advance(20)
  assert.equal(rig.state.signal.bOpen, true, 'push after the failed swap lands')
  rig.expectConsistent()
  rig.assertClean({ allowFailures: true })
})

test('a second swap during a pending one is refused; the machine never wedges', async (t) => {
  const rig = await Rig.create(t)
  rig.sim.ignoreNext(0x08, 1) // delay the first ack by one ARQ round so the flight stays open
  rig.session.chooseSide('b')
  await rig.advance(100)
  assert.equal(rig.state.pendingSide, 'b')
  rig.session.chooseSide('a') // conflicting request mid-flight → rejected, not queued
  await rig.advance(2000) // first retransmit lands and acks
  assert.equal(rig.state.selectedSide, 'b', 'the original swap completed')
  assert.equal(rig.state.pendingSide, null)

  // the machine is healthy: a swap back works normally
  rig.session.chooseSide('a')
  await rig.advance(100)
  assert.equal(rig.state.selectedSide, 'a')
  rig.assertClean()
})

test('swap A→B→A round-trip lands on ground truth with per-side channels intact', async (t) => {
  const rig = await Rig.create(t)
  // put the sides on different channels first (select switches the radio side as it goes)
  rig.session.selectChannel('b', 2) // MIDSOUTH on B (switches to b)
  await rig.advance(1500)
  rig.session.chooseSide('a')
  await rig.advance(1500)
  assert.equal(rig.state.sides.a.channelName, 'LOCAL FM')
  assert.equal(rig.state.sides.b.channelName, 'MIDSOUTH')

  rig.session.chooseSide('b')
  await rig.advance(1500)
  rig.session.chooseSide('a')
  await rig.advance(1500)
  // the swap itself must not disturb per-side channel data — nothing physical changed
  assert.equal(rig.state.sides.a.channelName, 'LOCAL FM')
  assert.equal(rig.state.sides.b.channelName, 'MIDSOUTH')
  rig.expectConsistent()
  rig.assertClean()
})

test('analog PTT: key/unkey lifecycle drives ptt + transmitting and returns to idle', async (t) => {
  const rig = await Rig.create(t)
  rig.session.key()
  await rig.advance(50)
  assert.equal(rig.state.ptt, 'keyed')
  assert.equal(rig.state.transmitting, true, 'the 5a TX state byte landed')
  rig.session.unkey()
  await rig.advance(50)
  assert.equal(rig.state.ptt, 'idle')
  assert.equal(rig.state.transmitting, false)
  rig.expectConsistent()
  rig.assertClean()
})

// ── dual-side RX: overlapping transmissions on both sides (the fused-clip bug) ─────────

test('dual-RX split: B records first; when B ends while A still receives, the clip SPLITS — never one fused clip labeled B', async (t) => {
  const rig = await Rig.create(t, { recorder: true })
  rig.session.selectChannel('b', 1) // RPT ALPHA on B (A stays LOCAL FM, selected)
  await rig.advance(1500)

  // B keys up first — it wins the audio; the clip opens attributed to B
  rig.sim.setCarrier('b', 3)
  await rig.feedAudio(2000)

  // A joins — BOTH sides receiving; the radio keeps piping B (first winner). The gate never
  // closes through the whole sequence, which is exactly what fused the clips before the split.
  rig.sim.setCarrier('a', 2)
  await rig.feedAudio(1500)

  // B's chatter stops; A still has signal. The B transmission is OVER — the clip must close
  // here (split) instead of riding A's audio under B's name until A finally drops.
  rig.sim.clearCarrier('b')
  await rig.feedAudio(2500)

  rig.sim.clearCarrier('a')
  await rig.feedAudio(1000) // tail closes the second clip

  const clips = await rig.clips(2)
  assert.equal(clips.length, 2, 'two transmissions → two clips')
  const [first, second] = clips
  assert.equal(first!.side, 'b', 'the first clip is B (it keyed first)')
  assert.equal(first!.channelName, 'RPT ALPHA')
  assert.equal(second!.side, 'a', 'the continuation is its own clip, attributed to A')
  assert.equal(second!.channelName, 'LOCAL FM')
  assert.ok(first!.durationMs < 5000, `B's clip ends near B's carrier drop (got ${first!.durationMs}ms)`)
  assert.ok(second!.durationMs >= 1500, `A's clip covers A's remaining RX (got ${second!.durationMs}ms)`)
  rig.assertClean()
})

test('dual-RX bounce guard: a brief blip on the clip side while the other side is open does NOT split', async (t) => {
  const rig = await Rig.create(t, { recorder: true })
  rig.session.selectChannel('b', 1)
  await rig.advance(1500)

  rig.sim.setCarrier('b', 3)
  await rig.feedAudio(1500)
  rig.sim.setCarrier('a', 2) // both open
  await rig.feedAudio(500)

  rig.sim.clearCarrier('b') // B bounces for LESS than the tail window…
  await rig.feedAudio(300)
  rig.sim.setCarrier('b', 3) // …and comes right back (same conversation)
  await rig.feedAudio(1500)

  rig.sim.clearCarrier('b')
  rig.sim.clearCarrier('a')
  await rig.feedAudio(1000)

  const clips = await rig.clips(1)
  assert.equal(clips.length, 1, 'a sub-tail bounce bridges — one clip, no split')
  assert.equal(clips[0]!.side, 'b')
  assert.equal(clips[0]!.channelName, 'RPT ALPHA')
  rig.assertClean()
})
