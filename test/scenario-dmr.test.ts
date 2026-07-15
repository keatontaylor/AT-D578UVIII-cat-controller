// Scenario: DMR mixed into the two-side world — call-side attribution, the identity latch, caller
// enrichment, manual dial, and above all the RECORDER's metadata when DMR and analog interleave.
// Full production stack against the SimRadio; the recorder runs with the exact main.ts wiring
// (activeReceive over live session state).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeReceive } from '../src/domain/receive'
import { resolveDmrSide } from '../src/domain/dmr-side'
import { Rig } from './sim/harness'
import { smeterPush, squelchPush } from './sim/frames'

/** Park MIDSOUTH (DMR cc10/ts2/TG43114) on side B, then select analog side A. */
async function midsouthOnB(rig: Rig): Promise<void> {
  rig.session.selectChannel('b', 2)
  await rig.advance(1500)
  rig.session.chooseSide('a')
  await rig.advance(1500)
  assert.equal(rig.state.selectedSide, 'a')
  assert.equal(rig.state.sides.b.channel?.type, 'digital')
}

const MIDSOUTH_CALL = { direction: 'rx' as const, colorCode: 10, slot: 2 as const, source: 3223436, dest: 43114, side: 'b' as const }

test('a DMR call matching side B lands on B while analog A is selected', async (t) => {
  const rig = await Rig.create(t)
  await midsouthOnB(rig)

  rig.sim.startDmrCall({ ...MIDSOUTH_CALL, alias: 'PARROT' })
  await rig.advance(300)

  const s = rig.state
  assert.ok(s.dmr, 'call live')
  assert.equal(s.dmr!.colorCode, 10)
  assert.equal(s.dmr!.slot, 2)
  assert.equal(s.dmr!.dest, 43114)
  assert.equal(s.dmr!.alias, 'PARROT')
  assert.equal(s.audioGate, true, 'the 5b gate opened for the call')
  // the tuple resolves the call to side B — the exact rule the UI meter/badge and recorder share
  assert.equal(resolveDmrSide(s.dmr!, s.sides.a.channel, s.sides.b.channel, s.selectedSide), 'b')
  const recv = activeReceive(s, s.audioGate)
  assert.equal(recv.side, 'b')
  assert.equal(recv.channelName, 'MIDSOUTH')
  assert.equal(recv.mode, 'DMR')
  assert.equal(recv.talkgroup, 43114)

  rig.sim.endDmrCall()
  await rig.advance(100)
  assert.equal(rig.state.dmr, null, 'idle push clears the call')
  assert.equal(rig.state.audioGate, false)
  rig.expectConsistent()
  rig.assertClean()
})

test('the identity latch holds through interleaved control frames — no badge flap', async (t) => {
  const rig = await Rig.create(t)
  await midsouthOnB(rig)
  rig.sim.startDmrCall(MIDSOUTH_CALL)
  const from = rig.states.length
  await rig.advance(600) // ~10 frames, every 3rd a control frame with no identity fields
  for (let i = from; i < rig.states.length; i += 1) {
    const d = rig.states[i]!.dmr
    if (!d) continue // (none expected — but the assert below catches it)
    assert.equal(d.dest, 43114, `emission ${i + 1}: dest dropped by a control frame`)
    assert.equal(d.colorCode, 10, `emission ${i + 1}: colorCode dropped`)
    assert.equal(d.slot, 2, `emission ${i + 1}: slot dropped`)
  }
  assert.ok(rig.states.slice(from).every((s) => s.dmr !== null), 'the call never blinked out mid-stream')
  rig.sim.endDmrCall()
  await rig.advance(100)
  rig.assertClean()
})

test('caller-id enrichment: 58 push → RadioID lookup → dmr.callsign; stale ids ignored', async (t) => {
  const rig = await Rig.create(t, {
    resolveCaller: (id) =>
      id === 3223436 ? { callsign: 'W1ABC', name: 'John Smith', location: 'Boston, MA' } : null,
  })
  await midsouthOnB(rig)
  rig.sim.startDmrCall({ ...MIDSOUTH_CALL, alias: 'PARROT' })
  await rig.advance(300)
  assert.equal(rig.state.dmr?.callerId, 3223436)
  assert.equal(rig.state.dmr?.callsign, 'W1ABC')
  assert.equal(rig.state.dmr?.location, 'Boston, MA')
  rig.sim.endDmrCall()
  await rig.advance(100)
  rig.assertClean()
})

test('recorder: a DMR call on non-selected B is recorded as B/MIDSOUTH with the live TG', async (t) => {
  const rig = await Rig.create(t, { recorder: true })
  await midsouthOnB(rig)

  rig.sim.startDmrCall(MIDSOUTH_CALL)
  await rig.feedAudio(1200) // > minDurationMs with the gate open
  rig.sim.endDmrCall()
  await rig.feedAudio(800) // tail (600 ms) closes the clip

  const clips = await rig.clips(1)
  assert.equal(clips.length, 1)
  assert.equal(clips[0]!.side, 'b', 'attributed to the RECEIVING side, not the selected one')
  assert.equal(clips[0]!.channelName, 'MIDSOUTH')
  assert.equal(clips[0]!.mode, 'DMR')
  assert.equal(clips[0]!.talkgroup, 43114, 'the LIVE talkgroup, for monitor-mode lanes')
  rig.assertClean()
})

test('recorder monitor mode: two calls on different TGs → two clips keyed by their own TG', async (t) => {
  const rig = await Rig.create(t, { recorder: true })
  await midsouthOnB(rig)

  rig.sim.startDmrCall(MIDSOUTH_CALL) // TG 43114 — the programmed contact
  await rig.feedAudio(1200)
  rig.sim.endDmrCall()
  await rig.feedAudio(800)

  rig.sim.startDmrCall({ ...MIDSOUTH_CALL, dest: 5042450, source: 5042450 }) // monitored TG
  await rig.feedAudio(1200)
  rig.sim.endDmrCall()
  await rig.feedAudio(800)

  const clips = await rig.clips(2)
  assert.equal(clips.length, 2)
  assert.equal(clips[0]!.talkgroup, 43114)
  assert.equal(clips[1]!.talkgroup, 5042450, 'the monitored TG, not the programmed contact')
  assert.equal(clips[1]!.side, 'b', 'lone-DMR-side fallback still lands on B')
  rig.assertClean()
})

test('recorder: an analog clip survives a side swap mid-clip with its metadata intact', async (t) => {
  const rig = await Rig.create(t, { recorder: true })
  rig.sim.setCarrier('a', 3) // analog RX on selected side A
  await rig.feedAudio(500) // clip opens attributed to A / LOCAL FM

  rig.session.chooseSide('b') // operator swaps mid-recording
  await rig.feedAudio(1000) // clip continues through the swap + settle window
  rig.sim.clearCarrier('a')
  await rig.feedAudio(800)

  const clips = await rig.clips(1)
  assert.equal(clips.length, 1)
  assert.equal(clips[0]!.side, 'a', 'the swap must not re-attribute the clip')
  assert.equal(clips[0]!.channelName, 'LOCAL FM')
  assert.equal(clips[0]!.mode, 'FM')
  rig.assertClean()
})

test('recorder: clip attribution is correct even when the gate opens BEFORE the first 5e decodes', async (t) => {
  // The 5b gate and the first 5e voice frame race on the real wire: the clip can open while the
  // state still says "selected analog side A". The late-fill must re-attribute the WHOLE identity
  // (side + channel + mode + TG) once the call resolves — a clip claiming side=a/MIDSOUTH is the
  // inconsistent-metadata bug.
  const rig = await Rig.create(t, { recorder: true })
  await midsouthOnB(rig)

  rig.sim.startDmrCall(MIDSOUTH_CALL)
  // the sim emits 5b before the first 5e (like the radio can) — the clip opens on the next audio
  // frame either way; feed through the call and close it
  await rig.feedAudio(1200)
  rig.sim.endDmrCall()
  await rig.feedAudio(800)

  const clips = await rig.clips(1)
  assert.equal(clips.length, 1)
  assert.equal(clips[0]!.channelName, 'MIDSOUTH')
  assert.equal(clips[0]!.talkgroup, 43114)
  assert.equal(clips[0]!.mode, 'DMR')
  assert.equal(clips[0]!.side, 'b', 'side must be re-attributed WITH the channel identity')
  rig.assertClean()
})

// ── connecting MID-CALL: the persisted 04 59 last-call record (corpus-pinned 2026-07-10) ──

test('connecting mid-call: the startup reads deliver the FULL caller immediately', async (t) => {
  const rig = await Rig.create(t, {
    resolveCaller: (id) => (id === 3223436 ? { callsign: 'W1ABC', name: 'John Smith', location: 'Boston, MA' } : null),
    preConnect: (sim) => {
      sim.slot.b = { zone: 0, pos: 2 } // MIDSOUTH parked on B before we ever connect
      // present:false — the call started before we connected, so the host never RECEIVED the
      // 58/59 call-start pushes; presentation must come from the 04 5e read, the caller from 04 59
      sim.startDmrCall({ ...MIDSOUTH_CALL, present: false })
    },
  })
  const d = rig.state.dmr
  assert.ok(d, 'the 04 5e read carried the ongoing call')
  assert.equal(d!.direction, 'rx')
  assert.equal(d!.dest, 43114)
  assert.equal(d!.colorCode, 10)
  // the 04 59 read supplied what normally waits for a 58 push:
  assert.equal(d!.callerId, 3223436, 'talker id from the persisted last-call record')
  assert.equal(d!.callsign, 'W1ABC', 'RadioID enrichment ran off the 59-provided id')
  assert.equal(d!.location, 'Boston, MA')
  rig.assertClean()
})

test('the last-call record NEVER paints a phantom call on an idle radio', async (t) => {
  const rig = await Rig.create(t, {
    preConnect: (sim) => {
      sim.lastCall = { dest: 43114, callerId: 3223436, callerName: 'PARROT' } // yesterday's call
    },
  })
  assert.equal(rig.state.dmr, null, 'no live call → the stale record stays invisible')
  rig.assertClean()
})

test('a STALE last-call record (different dest) cannot paint the live call', async (t) => {
  const rig = await Rig.create(t, {
    preConnect: (sim) => {
      sim.slot.b = { zone: 0, pos: 2 }
      sim.startDmrCall({ ...MIDSOUTH_CALL, present: false }) // started before connect (see above)
      sim.lastCall = { dest: 999999, callerId: 1111111, callerName: 'STALE' } // record from another call
    },
  })
  assert.ok(rig.state.dmr, 'live call landed')
  assert.equal(rig.state.dmr!.callerId, null, 'mismatched dest → the record is not trusted')
  assert.equal(rig.state.dmr!.alias, null)
  rig.assertClean()
})

test('recorder: the 5e-dropout call (gate opens, NO 5e decode) still lands on the DMR side', async (t) => {
  // Live-observed 2026-07-10: some DMR calls arrive with no usable 5e voice frame — the dmr slice
  // never locks. The UI hiding TS/CC/TG is CORRECT (nothing decoded), but the clip used to fall
  // back to the selected ANALOG channel ("COLCON DENVER" labeling a TG 5031320 transmission).
  // With the gate open and no analog squelch open, the audio can only be the lone DMR side.
  const rig = await Rig.create(t, { recorder: true })
  await midsouthOnB(rig)

  rig.sim.injectPush(squelchPush(true)) // the audio gate opens… and the 5e stream never decodes
  await rig.feedAudio(1200)
  rig.sim.injectPush(squelchPush(false))
  await rig.feedAudio(800)

  const clips = await rig.clips(1)
  assert.equal(clips.length, 1)
  assert.equal(clips[0]!.side, 'b', 'inferred: no analog squelch open → the DMR side')
  assert.equal(clips[0]!.channelName, 'MIDSOUTH', 'the DMR channel, not the selected analog one')
  assert.equal(clips[0]!.mode, 'DMR')
  assert.equal(clips[0]!.talkgroup, null, 'no decode → no TG claimed')
  rig.assertClean()
})

test('recorder: an ANALOG clip survives the end-of-RX 5a/5b close race (no PARROT relabel)', async (t) => {
  // Live-observed 2026-07-10: at end of an analog RX the radio drops the per-side 5a squelch a
  // beat BEFORE the 5b gate closes. In that window "gate open + no analog squelch" makes the
  // digital-audio inference point at the DMR side — the closing analog clip was being SAVED
  // under the DMR channel's name. A side re-attribution now needs evidence, not the inference.
  const rig = await Rig.create(t, { recorder: true })
  await midsouthOnB(rig) // analog LOCAL FM selected on A; MIDSOUTH (DMR) parked on B

  rig.sim.setCarrier('a', 3) // analog RX on A → clip opens attributed A / LOCAL FM
  await rig.feedAudio(1200)

  // end-of-RX race: the 5a per-side squelch closes FIRST (gate 5b still open for a few frames)…
  rig.sim.injectPush(smeterPush({ selectedRssi: 0, otherRssi: 0, selectedOpen: false, otherOpen: false }))
  await rig.feedAudio(200) // frames flow through the inference window
  // …then the gate closes
  rig.sim.injectPush(squelchPush(false))
  rig.sim.rf.a = { rssi: 0, open: false } // keep the sim's ground truth honest
  await rig.feedAudio(800) // tail closes the clip

  const clips = await rig.clips(1)
  assert.equal(clips.length, 1)
  assert.equal(clips[0]!.side, 'a', 'the transient inference must not overturn the attribution')
  assert.equal(clips[0]!.channelName, 'LOCAL FM', 'saved under the analog channel it recorded')
  assert.equal(clips[0]!.mode, 'FM')
  rig.assertClean()
})

test('recorder: a hangtime 5e burst mid-analog-clip cannot re-label an evidence-opened clip', async (t) => {
  // The second relabel path the wire capture exposed: 5e status=01 frames with FULL identity
  // arrive around the other side's calls (hangtime/signaling) — since the byte-2 decode fix they
  // now populate the dmr slice. That is a 'dmr'-sourced attribution, but a clip that OPENED on an
  // open analog squelch keeps its side: its audio started analog, and no mid-clip event changes
  // what was recorded.
  const rig = await Rig.create(t, { recorder: true })
  await midsouthOnB(rig) // analog LOCAL FM selected on A; MIDSOUTH (DMR) on B

  rig.sim.setCarrier('a', 3) // analog RX → clip opens evidence-backed ('analog', side A)
  await rig.feedAudio(600)
  rig.sim.startDmrCall(MIDSOUTH_CALL) // the other side's DMR link comes up mid-clip
  await rig.feedAudio(600)
  rig.sim.endDmrCall()
  await rig.feedAudio(300)
  rig.sim.clearCarrier('a')
  await rig.feedAudio(800)

  const clips = await rig.clips(1)
  assert.equal(clips.length, 1)
  assert.equal(clips[0]!.side, 'a', 'the analog attribution held against the DMR-side event')
  assert.equal(clips[0]!.channelName, 'LOCAL FM')
  assert.equal(clips[0]!.mode, 'FM')
  rig.assertClean()
})

test('manual dial: PTT on a DMR channel keys the dialed target end-to-end', async (t) => {
  const rig = await Rig.create(t)
  rig.session.selectChannel('a', 2) // MIDSOUTH on the selected side
  await rig.advance(200)
  rig.session.setManualDial('a', 5042450, 'group')
  rig.session.key()
  await rig.advance(200)
  assert.equal(rig.state.ptt, 'keyed')
  assert.equal(rig.state.dmr?.direction, 'tx')
  assert.equal(rig.state.dmr?.dest, 5042450, 'the radio transmits to the DIALED target')
  rig.session.unkey()
  await rig.advance(200)
  // RELEASE DRAIN: the unkey is acked but the radio is still transmitting the DMR terminator
  // (~0.5 s) — the phase must HOLD 'unkeying' (yellow), never flash back to a confirmed-red idle+
  // leftover state, until the radio's own end-of-call clears it.
  assert.equal(rig.state.ptt, 'unkeying', 'releasing holds while the terminator transmits')
  assert.equal(rig.state.dmr?.direction, 'tx')
  await rig.advance(600)
  assert.equal(rig.state.ptt, 'idle')
  assert.equal(rig.state.dmr, null)
  rig.expectConsistent()
  rig.assertClean()
})

test('release drain cap: a lost end-of-call push cannot wedge the releasing state', async (t) => {
  const rig = await Rig.create(t)
  rig.session.selectChannel('a', 2)
  await rig.advance(200)
  rig.sim.dmrTxTailMs = 60_000 // the 5e dir=00 never (usefully) arrives
  rig.session.key()
  await rig.advance(200)
  assert.equal(rig.state.ptt, 'keyed')
  rig.session.unkey()
  await rig.advance(200)
  assert.equal(rig.state.ptt, 'unkeying', 'draining on the stale TX call state')
  await rig.advance(2000) // PTT_DRAIN_CAP_MS
  assert.equal(rig.state.ptt, 'idle', 'the cap releases the phase — the unkey WAS acked')
  await rig.advance(60_000) // let the sim finally end the call; nothing should blow up
  assert.equal(rig.state.dmr, null)
  rig.assertClean()
})

test('recorder: no clip opens from a TX (the gate stays closed while transmitting)', async (t) => {
  const rig = await Rig.create(t, { recorder: true })
  rig.session.key()
  await rig.feedAudio(1500)
  rig.session.unkey()
  await rig.feedAudio(800)
  assert.deepEqual(await rig.clips(), [], 'TX must not be recorded as RX')
  rig.assertClean()
})

test('5c hang-time teardown clears the call (the authoritative end)', async (t) => {
  const rig = await Rig.create(t)
  await midsouthOnB(rig)
  rig.sim.startDmrCall({ ...MIDSOUTH_CALL, alias: 'PARROT' })
  await rig.advance(300)
  assert.ok(rig.state.dmr, 'call up')
  assert.equal(rig.state.dmr!.presented, true, '58 presented it')
  rig.sim.endDmrCall() // 5e idle + gate close + the 5c teardown
  await rig.advance(200)
  assert.equal(rig.state.dmr, null, 'teardown cleared the slice')
  rig.assertClean()
})

test('raw 59 push presents the call and supplies the caller id (58 lost)', async (t) => {
  const rig = await Rig.create(t)
  await midsouthOnB(rig)
  // voice frames only — no 58 (garbled off the wire); then the 59 push arrives
  const { dmrVoicePush, lastCallPush } = await import('./sim/frames')
  rig.sim.injectPush(dmrVoicePush(MIDSOUTH_CALL))
  await rig.advance(100)
  assert.equal(rig.state.dmr!.presented, false, 'unpresented decode')
  rig.sim.injectPush(lastCallPush({ dest: 43114, callerId: 3223436 }))
  await rig.advance(100)
  assert.equal(rig.state.dmr!.presented, true, 'the 59 push presents')
  assert.equal(rig.state.dmr!.callerId, 3223436, 'caller id from the 59 push')
  rig.assertClean()
})

// ── scan-engine 5e SAMPLES (wire-pinned 2026-07-11, captures 20:27–20:37): while scanning, the
// radio pushes fully identified 5e frames for DMR traffic it merely hops across — never unmuted,
// no 58/59, no gate. Those must render as NOTHING and never touch the recorder. ──

test('a phantom DMR tuple (no audio gate) renders no live call and steals no attribution', async (t) => {
  const rig = await Rig.create(t, { recorder: true })
  rig.session.selectChannel('b', 2) // MIDSOUTH (DMR) on B
  await rig.advance(1500)
  rig.session.chooseSide('a') // analog LOCAL FM selected on A
  await rig.advance(1500)

  // analog RX on A opens a clip attributed to A
  rig.sim.setCarrier('a', 3)
  await rig.feedAudio(1200)

  // mid-clip, scan-sample-style 5e frames arrive for the DMR side — identity but NO gate evidence
  const { dmrVoicePush } = await import('./sim/frames')
  rig.sim.injectPush(dmrVoicePush({ direction: 'rx', colorCode: 10, slot: 2, source: 43114, dest: 43114 }))
  await rig.feedAudio(600)
  assert.ok(rig.state.dmr, 'the tuple decoded into state (wire truth is recorded)')

  rig.sim.clearCarrier('a')
  await rig.feedAudio(800)
  const clips = await rig.clips(1)
  assert.equal(clips.length, 1, 'exactly the analog clip — the phantom opened nothing')
  assert.equal(clips[0]!.side, 'a', 'attribution stayed with the audible analog side')
  assert.equal(clips[0]!.channelName, 'LOCAL FM')
  rig.assertClean()
})
