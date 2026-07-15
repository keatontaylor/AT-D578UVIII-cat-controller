// resolveDmrSide — map a live DMR call (CC/slot/TG, no side field) to the physical side whose
// programmed channel matches, so the caller badge/meter land on the DMR channel, not the selected.
// Pure tuple match: color code + time slot + talkgroup vs each side's programmed channel.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDmrSide } from '../src/domain/dmr-side'
import type { ChannelConfig } from '../src/codec/decode'

const analog = { type: 'analog', colorCode: null, timeSlot: null, contact: null } as unknown as ChannelConfig
const dmr = (colorCode: number, timeSlot: number, talkgroup: number | null): ChannelConfig =>
  ({ type: 'digital', colorCode, timeSlot, contact: talkgroup == null ? null : { talkgroup } } as unknown as ChannelConfig)

test('only one side DMR → that side, regardless of the selected side', () => {
  assert.equal(resolveDmrSide({ colorCode: 1, slot: 1, dest: 3100 }, analog, dmr(1, 1, 3100), 'a'), 'b')
  assert.equal(resolveDmrSide({ colorCode: 1, slot: 1, dest: 3100 }, dmr(1, 1, 3100), analog, 'b'), 'a')
})

test('both DMR → the side whose CC/slot/TG matches the call', () => {
  const a = dmr(1, 1, 3100)
  const b = dmr(5, 2, 9990)
  assert.equal(resolveDmrSide({ colorCode: 5, slot: 2, dest: 9990 }, a, b, 'a'), 'b')
  assert.equal(resolveDmrSide({ colorCode: 1, slot: 1, dest: 3100 }, a, b, 'b'), 'a')
})

test('both DMR, TG disambiguates when CC/slot collide', () => {
  const a = dmr(1, 1, 3100)
  const b = dmr(1, 1, 91) // same CC+slot, different TG
  assert.equal(resolveDmrSide({ colorCode: 1, slot: 1, dest: 91 }, a, b, 'a'), 'b')
})

test('both DMR, no discriminating match (or a tie) → the active side', () => {
  const a = dmr(1, 1, 3100)
  const b = dmr(1, 1, 3100) // identical config → tie
  assert.equal(resolveDmrSide({ colorCode: 1, slot: 1, dest: 3100 }, a, b, 'b'), 'b')
  // a call matching neither → active side
  assert.equal(resolveDmrSide({ colorCode: 7, slot: 2, dest: 5 }, a, b, 'a'), 'a')
})

test('neither side DMR → selected side (defensive)', () => {
  assert.equal(resolveDmrSide({ colorCode: 1, slot: 1, dest: 3100 }, analog, analog, 'b'), 'b')
})

test('per-side manual dial breaks a tie between two identical DMR channels', () => {
  const a = dmr(1, 1, 3100)
  const b = dmr(1, 1, 3100) // identical programmed config — the tuple can't discriminate
  const call = { colorCode: 1, slot: 1, dest: 720 }
  // no dials → tie → falls to the selected side (the ambiguous default)
  assert.equal(resolveDmrSide(call, a, b, 'a'), 'a')
  // dial 720 on B → B wins even though A is selected: solid data for the side match
  assert.equal(resolveDmrSide(call, a, b, 'a', null, 720), 'b')
  // dial 720 on A → A wins
  assert.equal(resolveDmrSide(call, a, b, 'b', 720, null), 'a')
  // both dialed, only B matches the call's dest → B
  assert.equal(resolveDmrSide(call, a, b, 'a', 700, 720), 'b')
})
