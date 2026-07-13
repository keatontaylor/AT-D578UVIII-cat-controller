// Scenario: the FRONTEND pipeline — SimRadio → controller → StateBroadcaster → JSON wire →
// MirrorClient (useRadio's exact patch handling) → vfoView (the components' exact derivations).
// Every assertion here reads the CLIENT's state, not the server's: it proves what the browser
// would hold and render, with the mirror-equality contract checked on every single patch.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FullRig, MirrorClient } from './sim/full-rig'
import { dmrControlPush, dmrIdlePush, dmrVoicePush, squelchPush } from './sim/frames'
import { settingByName } from '../src/codec/settings-table'

const MIDSOUTH_CALL = { direction: 'rx' as const, colorCode: 10, slot: 2 as const, source: 3223436, dest: 43114, side: 'b' as const }

/** Park MIDSOUTH (DMR) on side B, select analog A — through the controller like the UI would. */
async function midsouthOnB(rig: FullRig): Promise<void> {
  rig.controller.selectChannel('b', 2)
  await rig.advance(1500)
  rig.controller.chooseSide('a')
  await rig.advance(1500)
  assert.equal(rig.client.radio.selectedSide, 'a')
  assert.equal(rig.client.radio.sides.b.channelName, 'MIDSOUTH')
}

test('connect: the client converges on the server state through snapshot + patches', async (t) => {
  const rig = await FullRig.create(t)
  assert.equal(rig.client.connection, 'connected')
  assert.equal(rig.client.radio.firmware, 'SIM_D578_V1')
  assert.ok(rig.mirror.patches > 10, `hydration flowed as patches (got ${rig.mirror.patches})`)
  const { a, b } = rig.cards
  assert.equal(a.channelName, 'LOCAL FM')
  assert.equal(a.selected, true)
  assert.equal(b.selectable, true)
  assert.equal(a.typeLabel, 'FM')
  rig.expectClientConsistent()
  rig.assertClean()
})

test('a late-joining client gets a snapshot identical to the incremental client', async (t) => {
  const rig = await FullRig.create(t)
  rig.sim.setCarrier('a', 3)
  rig.controller.chooseSide('b')
  await rig.advance(1500)
  // a second browser tab opens mid-session: its snapshot must equal the patched-up mirror
  const late = new MirrorClient()
  const unsub = rig.broadcaster.subscribe((m) => late.onMessage(m))
  assert.deepEqual(late.state, rig.mirror.state, 'late joiner sees exactly the incremental state')
  unsub()
  rig.assertClean()
})

test('pre-lock DMR renders NOTHING; the first voice frame lights exactly the matching card', async (t) => {
  const rig = await FullRig.create(t)
  await midsouthOnB(rig)

  // control frames only — the call is up but the tuple hasn't decoded (no lock yet)
  rig.sim.injectPush(squelchPush(true))
  rig.sim.injectPush(dmrControlPush('rx'))
  await rig.advance(50)
  assert.ok(rig.client.radio.dmr, 'client knows a call is up')
  {
    const { a, b } = rig.cards
    assert.equal(a.dmrLive, null, 'pre-lock: no badge on A')
    assert.equal(b.dmrLive, null, 'pre-lock: no badge on B')
    assert.equal(b.smeter, 0, 'pre-lock: no DMR meter')
    assert.equal(b.indicator, null, 'pre-lock: no RX icon')
  }

  // the tuple decodes → everything lights on the MATCHING card (B), nothing on A. A GROUP call
  // carries the TG in both src and dest slots (the wire's group/private discriminator).
  rig.sim.startDmrCall({ ...MIDSOUTH_CALL, source: 43114 })
  await rig.advance(100)
  {
    const { a, b } = rig.cards
    assert.equal(b.dmrLive?.label, 'TS2 · CC10 · TG 43114', 'the exact badge text the PoC renders')
    assert.equal(b.dmrLive?.direction, 'rx')
    assert.equal(b.smeter, 4, 'DMR full bars on the call side')
    assert.equal(b.indicator, 'RX')
    assert.equal(a.dmrLive, null)
    assert.equal(a.smeter, 0, 'analog side shows its own (quiet) meter')
    assert.equal(a.indicator, null)
  }

  rig.sim.endDmrCall()
  await rig.advance(100)
  const { b } = rig.cards
  assert.equal(b.dmrLive, null, 'badge clears with the call')
  assert.equal(b.indicator, null)
  rig.assertClean()
})

test('caller-id renders once resolved: callsign · name · location on the call card', async (t) => {
  const rig = await FullRig.create(t, {
    resolveCaller: (id) => (id === 3223436 ? { callsign: 'W1ABC', name: 'John Smith', location: 'Boston, MA' } : null),
  })
  await midsouthOnB(rig)
  rig.sim.startDmrCall({ ...MIDSOUTH_CALL, alias: 'PARROT' })
  await rig.advance(200)
  const { a, b } = rig.cards
  assert.equal(b.dmrCaller, 'W1ABC · John Smith · Boston, MA')
  assert.equal(a.dmrCaller, null)
  rig.sim.endDmrCall()
  await rig.advance(100)
  rig.assertClean()
})

test('scan rendering: SCAN → LOCK → PAUSE badges, memory display, side-switch lockout', async (t) => {
  const rig = await FullRig.create(t)
  rig.controller.startScan('a', 0, 'FIRE')
  await rig.advance(100)
  {
    const { a, b } = rig.cards
    assert.equal(a.scanBadge?.label, 'SCAN · FIRE')
    assert.equal(a.memoryDisplay, 'Scanning…')
    assert.equal(b.scanBadge, null, 'badge only on the scanning card')
    assert.equal(b.selectable, false, 'side switching locked out during a scan')
  }

  rig.sim.scanLand(1, 0, 3)
  await rig.advance(1200) // through the confirm window → locked
  {
    const { a } = rig.cards
    assert.equal(a.scanBadge?.label, 'LOCK · FIRE')
    assert.equal(a.scanBadge?.locked, true)
    assert.equal(a.memoryDisplay, 'GMRS 17', 'locked channel replaces Scanning…')
    assert.equal(a.indicator, 'RX')
  }

  rig.sim.scanResume()
  await rig.advance(100)
  rig.sim.setCarrier('b', 2) // the OTHER side receives → the radio holds the scan
  await rig.advance(100)
  {
    const { a, b } = rig.cards
    assert.equal(a.scanBadge?.label, 'PAUSE · FIRE')
    assert.equal(a.memoryDisplay, 'Scanning…', 'stays Scanning… through a pause — only a LOCK moves it')
    assert.equal(b.indicator, 'RX', 'the pausing side shows its RX')
  }
  rig.sim.clearCarrier('b')

  rig.controller.stopScan()
  await rig.advance(100)
  {
    const { a, b } = rig.cards
    assert.equal(a.scanBadge, null)
    assert.equal(a.memoryDisplay, 'LOCAL FM', 'restore read re-synced the display')
    assert.equal(b.selectable, true, 'side switching unlocked')
  }
  rig.expectClientConsistent()
  rig.assertClean()
})

test('connecting mid-call renders the live call + caller card immediately', async (t) => {
  const rig = await FullRig.create(t, {
    resolveCaller: (id) => (id === 3223436 ? { callsign: 'W1ABC', name: 'John Smith', location: 'Boston, MA' } : null),
    preConnect: (sim) => {
      sim.slot.b = { zone: 0, pos: 2 } // MIDSOUTH on B
      sim.startDmrCall(MIDSOUTH_CALL)
    },
  })
  const { a, b } = rig.cards
  assert.equal(b.dmrLive?.label, 'TS2 · CC10 · PRIV 3223436', 'call badge lit at connect (private: src≠dest)')
  assert.equal(b.dmrCaller, 'W1ABC · John Smith · Boston, MA', 'caller card lit from the 04 59 record — no 58 push yet')
  assert.equal(b.indicator, 'RX')
  assert.equal(a.dmrLive, null)
  rig.assertClean()
})

test('connecting to a radio that is ALREADY scanning renders the scan immediately', async (t) => {
  // The live-reported bug: scanning started on the radio, then the app connects — the frontend
  // showed no scan. The startup 04 5a read carries the flag (byte 13); it must reach the browser.
  const rig = await FullRig.create(t, { preConnect: (sim) => sim.panelScan(true) })
  await rig.advance(100) // the discovery 04 4a read names the list
  const { a, b } = rig.cards
  assert.equal(rig.client.radio.scan.active, true, 'the client knows about the pre-existing scan')
  assert.equal(a.scanBadge?.label, 'SCAN · FIRE', 'badge names the list from the 04 4a record')
  assert.equal(a.memoryDisplay, 'Scanning…')
  assert.equal(b.selectable, false, 'side switching locked out')
  rig.assertClean()
})

test('TX rendering: keyed side shows TX (never RX), meter zeroed; releases cleanly', async (t) => {
  const rig = await FullRig.create(t)
  rig.sim.setCarrier('a', 3) // receiving while we key — TX must win the indicator
  await rig.advance(50)
  assert.equal(rig.cards.a.indicator, 'RX')

  rig.controller.key()
  await rig.advance(50)
  {
    const { a, b } = rig.cards
    assert.equal(a.indicator, 'TX')
    assert.equal(a.smeter, 0, 'no RX meter while transmitting')
    assert.equal(b.indicator, null)
  }
  rig.controller.unkey()
  await rig.advance(50)
  assert.equal(rig.cards.a.indicator, 'RX', 'back to the live RX truth')
  rig.assertClean()
})

test('PTT truth contract (UI_PROTOCOL §6): nothing renders TX before the radio ACKs; releasing holds TX until confirmed', async (t) => {
  const rig = await FullRig.create(t)

  // key with the ACK swallowed — the pill must render PENDING (yellow), never a confirmed TX
  rig.sim.ignoreNext(0x56, 1)
  rig.controller.key()
  await rig.advance(400) // inside the ack-timeout window
  {
    const { a } = rig.cards
    assert.equal(a.txState, 'pending', 'unacked key renders pending')
    assert.notEqual(a.indicator, 'TX', 'never a confirmed TX without the ack')
  }
  // the key-down is retryable (bounded): the retransmit lands while the button is STILL held,
  // so the TX honestly confirms — busy-gate recovery, not a phantom key
  await rig.advance(2500)
  assert.equal(rig.cards.a.txState, 'confirmed', 'the bounded retry landed with the button still held')
  assert.equal(rig.client.radio.ptt, 'keyed')
  rig.controller.unkey()
  await rig.advance(100)
  assert.equal(rig.cards.a.txState, null)
  assert.equal(rig.client.radio.ptt, 'idle')

  // a normal key confirms only AFTER the ack round-trips
  rig.controller.key()
  await rig.advance(100)
  assert.equal(rig.cards.a.txState, 'confirmed')
  assert.equal(rig.cards.a.indicator, 'TX')

  // release with the ack swallowed: STILL TX (releasing) — the radio transmits until it confirms
  rig.sim.ignoreNext(0x56, 1)
  rig.controller.unkey()
  await rig.advance(400)
  {
    const { a } = rig.cards
    assert.equal(a.txState, 'releasing', 'unconfirmed release renders releasing')
    assert.equal(a.indicator, 'TX', 'the radio is still transmitting until the release ack')
  }
  await rig.advance(1500) // the ARQ retransmit lands → acked → idle
  assert.equal(rig.cards.a.txState, null)
  assert.equal(rig.client.radio.ptt, 'idle')
  rig.assertClean()
})

test('write overlays round-trip the patch pipeline (the renull skip-path contract)', async (t) => {
  const rig = await FullRig.create(t)
  // a menu-settings write: pendingSettings key appears on the client, then is DELETED on the ack
  // (a genuine record-map deletion — the skip-path side of renullAfterPatch)
  rig.sim.ignoreNext(0x08, 1) // hold the ack one ARQ round so the pending phase is observable
  rig.controller.setSetting('key_tone', 1)
  await rig.advance(100)
  assert.equal(rig.client.radio.pendingSettings['key_tone']?.phase, 'pending', 'overlay reached the client')
  await rig.advance(1200) // retransmit → ack
  assert.equal(rig.client.radio.pendingSettings['key_tone'], undefined, 'overlay deletion propagated')
  const expected = settingByName('key_tone')!.options[1]
  assert.equal(rig.client.radio.settings['key_tone'], expected, 'the acked value landed')

  // a per-channel write overlay (sides.*.pendingChannel — the other skip path)
  rig.controller.setChannelSetting('a', 'txPower', 'Low')
  await rig.advance(200)
  assert.equal(rig.client.radio.sides.a.pendingChannel['txPower'], undefined, 'channel overlay cleared on ack')
  rig.expectClientConsistent()
  rig.assertClean()
})

test('link drop + auto-reconnect: the client rides disconnected → connected with truth intact', async (t) => {
  const rig = await FullRig.create(t, { reconnect: true })
  rig.controller.selectChannel('a', 1) // move somewhere non-default first
  await rig.advance(1500)
  assert.equal(rig.client.radio.sides.a.channelName, 'RPT ALPHA')

  rig.sim.dropLink()
  await rig.advance(100)
  assert.equal(rig.client.connection, 'disconnected')
  assert.equal(rig.client.error, 'radio link dropped')

  await rig.advance(3000) // backoff fires → reconnect → re-enumeration
  assert.equal(rig.client.connection, 'connected', 'auto-reconnect landed')
  assert.ok(rig.connects >= 2, 'a fresh transport was opened')
  assert.equal(rig.client.radio.sides.a.channelName, 'RPT ALPHA', 'the radio kept its channel through the drop')
  rig.expectClientConsistent()
  rig.assertClean()
})

test('phantom 5e (no gate) renders NO live call on any card; corroboration lights it', async (t) => {
  const rig = await FullRig.create(t)
  await midsouthOnB(rig)

  // fully identified 5e frames with NO audio-gate evidence — the scan-sample signature
  rig.sim.injectPush(dmrVoicePush({ direction: 'rx', colorCode: 10, slot: 2, source: 43114, dest: 43114 }))
  await rig.advance(100)
  {
    const { a, b } = rig.cards
    assert.ok(rig.client.radio.dmr, 'the tuple reached the client state')
    assert.equal(b.dmrLive, null, 'no badge without audio')
    assert.equal(b.smeter, 0, 'no meter without audio')
    assert.equal(b.indicator, null, 'no RX icon without audio')
    assert.equal(a.dmrLive, null)
  }

  // the gate corroborates → the SAME tuple now renders as a live call on the matching card
  rig.sim.injectPush(squelchPush(true))
  await rig.advance(50)
  assert.equal(rig.cards.b.dmrLive?.label, 'TS2 · CC10 · TG 43114', 'corroborated call lights the badge')
  assert.equal(rig.cards.b.indicator, 'RX')

  rig.sim.injectPush(squelchPush(false))
  rig.sim.injectPush(dmrIdlePush())
  await rig.advance(100)
  rig.assertClean()
})
