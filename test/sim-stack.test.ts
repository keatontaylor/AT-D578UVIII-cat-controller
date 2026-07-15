// Sim-stack self-test: the SimRadio must speak the wire protocol well enough that the REAL
// production stack (framer → link/ARQ → session → reducer) connects against it and lands on the
// sim's ground truth — zero framing incidents, nothing left in flight. This is the foundation the
// scenario suites (scenario-*.test.ts) stand on: if this fails, their findings mean nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Framer } from '../src/codec/framing'
import { decodeChannel, decodeDmr, decodeSmeter } from '../src/codec/decode'
import { Rig, defaultPlug } from './sim/harness'
import {
  aliasPush,
  channelBlock,
  dmrVoicePush,
  scanListBlock,
  settingsBlock05,
  smeterPush,
  zoneBlock,
  zoneCountBlock,
} from './sim/frames'

// ── frame builders round-trip through the REAL framer + decoders ──────────────

test('every builder frame passes the real framer with a valid checksum', () => {
  const frames = [
    channelBlock('a', { name: 'LOCAL FM', rxMHz: 146.52, type: 'analog' }, 0),
    channelBlock('b', defaultPlug().zones[0]!.channels[2]!, 2),
    zoneBlock('a', 'FAVORITES', 0),
    settingsBlock05('b'),
    zoneCountBlock(2),
    scanListBlock(0, 'FIRE'),
    scanListBlock(3, null),
    smeterPush({ selectedRssi: 3, otherRssi: 0, selectedOpen: true, otherOpen: false }),
    dmrVoicePush({ direction: 'rx', colorCode: 10, slot: 2, source: 3223436, dest: 43114 }),
    aliasPush(3223436, 'PARROT'),
  ]
  const framer = new Framer()
  for (const f of frames) framer.push(f)
  const out = framer.drain()
  assert.equal(out.length, frames.length, 'every frame delimited')
  assert.equal(framer.pending.length, 0, 'no unconsumed tail')
  for (const f of out) assert.equal(f.checksumOk, true, `checksum on head 0x${f.head.toString(16)}`)
})

test('channelBlock round-trips through decodeChannel (analog + DMR)', () => {
  const dmr = decodeChannel(channelBlock('a', defaultPlug().zones[0]!.channels[2]!, 2))
  assert.equal(dmr.name, 'MIDSOUTH')
  assert.equal(dmr.freqMHz, 444.7)
  assert.equal(dmr.txFreqMHz, 449.7)
  assert.equal(dmr.position, 2)
  assert.equal(dmr.config?.type, 'digital')
  assert.equal(dmr.config?.colorCode, 10)
  assert.equal(dmr.config?.timeSlot, 2)
  assert.equal(dmr.config?.contact?.talkgroup, 43114)
  assert.equal(dmr.config?.contact?.callType, 'group')

  const fm = decodeChannel(channelBlock('b', { name: 'RPT ALPHA', rxMHz: 147.06, shiftMHz: -0.6, type: 'analog' }, 1))
  assert.equal(fm.name, 'RPT ALPHA')
  assert.equal(fm.freqMHz, 147.06)
  assert.equal(fm.txFreqMHz, 146.46)
  assert.equal(fm.config?.type, 'analog')
  assert.equal(fm.config?.colorCode, null)
})

test('smeter and DMR pushes round-trip through their decoders', () => {
  const s = decodeSmeter(smeterPush({ selectedRssi: 4, otherRssi: 2, selectedOpen: true, otherOpen: false, transmitting: true }))
  assert.deepEqual(s, { selectedRssi: 4, otherRssi: 2, selectedOpen: true, otherOpen: false, transmitting: true, scanning: false, parked: false, focusSide: 'a' })
  const scanning = decodeSmeter(smeterPush({ selectedRssi: 0, otherRssi: 0, selectedOpen: false, otherOpen: false, scanning: true }))
  assert.equal(scanning?.scanning, true, 'the byte-12 scan flag round-trips')
  const parked = decodeSmeter(smeterPush({ selectedRssi: 0, otherRssi: 0, selectedOpen: false, otherOpen: false, scanning: true, parked: true }))
  assert.equal(parked?.parked, true, 'the byte-3 park bit round-trips')
  const d = decodeDmr(dmrVoicePush({ direction: 'rx', colorCode: 10, slot: 2, source: 3223436, dest: 43114 }))
  assert.equal(d?.direction, 'rx')
  assert.equal(d?.colorCode, 10)
  assert.equal(d?.slot, 2)
  assert.equal(d?.source, 3223436)
  assert.equal(d?.dest, 43114)
  assert.equal(d?.private, true) // src != dest
})

// ── full connect through the real stack ───────────────────────────────────────

test('connect() against the sim hydrates a consistent RadioState', async (t) => {
  const rig = await Rig.create(t)
  const s = rig.state
  assert.equal(s.firmware, 'SIM_D578_V1')
  assert.equal(s.selectedSide, 'a')
  assert.equal(s.sides.a.channelName, 'LOCAL FM')
  assert.equal(s.sides.b.channelName, 'LOCAL FM')
  assert.equal(s.sides.a.freqMHz, 146.52)
  assert.equal(s.sides.a.zoneName, 'FAVORITES')
  assert.equal(s.sides.a.zoneCount, 2, 'zone count from 04 1b')
  assert.equal(s.sides.a.channelCount, 4, 'channel count from 04 27')
  assert.equal(s.clock?.hour, 12)
  assert.equal(s.dmr, null)
  assert.equal(s.audioGate, false)
  assert.equal(rig.session.busy, false, 'nothing left in flight')
  rig.expectConsistent()
  rig.assertClean()
})

test('directory enumerations work against the sim (zones / channels / scan lists)', async (t) => {
  const rig = await Rig.create(t)
  const zones = await rig.session.listZones()
  assert.deepEqual(zones, [
    { index: 0, name: 'FAVORITES' },
    { index: 1, name: 'GMRS' },
  ])
  const channels = await rig.session.listZoneChannels(1)
  assert.deepEqual(channels, [
    { position: 0, name: 'GMRS 17' },
    { position: 1, name: 'GMRS 19' },
  ])
  const lists = await rig.session.listScanLists()
  assert.deepEqual(lists, [
    { index: 0, name: 'FIRE' },
    { index: 1, name: 'WX' },
  ])
  rig.assertClean()
})

test('channel and zone steps land on the sim ground truth', async (t) => {
  const rig = await Rig.create(t)
  rig.session.stepChannel('a', 1)
  await rig.advance(50)
  assert.equal(rig.state.sides.a.channelName, 'RPT ALPHA')
  assert.equal(rig.state.sides.a.channelPosition, 1)

  rig.session.stepZone('a', 1)
  await rig.advance(100)
  assert.equal(rig.state.sides.a.zoneName, 'GMRS')
  assert.equal(rig.state.sides.a.channelName, 'GMRS 17')
  assert.equal(rig.state.sides.a.channelCount, 2, 'channel count refreshed for the new zone')

  rig.expectConsistent()
  rig.assertClean()
})

test('an unanswered command exhausts ARQ and reports a failure, not a hang', async (t) => {
  const rig = await Rig.create(t)
  rig.sim.ignoreNext(0x08, 3) // drop the write AND its retransmits (maxAttempts 3)
  rig.session.setSetting('key_tone', 1)
  await rig.advance(3500)
  assert.equal(rig.failures.length, 1, 'the write failed after exhausting attempts')
  assert.match(rig.failures[0]!, /^0x8 exhausted/)
  assert.equal(rig.state.pendingSettings['key_tone']?.phase, 'failed', 'overlay marks the failure')
  assert.equal(rig.session.busy, false)
  rig.assertClean({ allowFailures: true })
})
