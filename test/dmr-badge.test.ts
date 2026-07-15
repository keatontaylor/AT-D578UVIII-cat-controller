// dmrLiveBadge: on RX the radio's 5e tuple is trusted; on TX it's INERT (wire+relay-proven
// 2026-07-14 — the 5e freezes at the LAST call and never refreshes during a keyup), so the TX
// badge must come from what we actually key: the manual dial, else the channel contact, with the
// channel's programmed CC/slot. Anchored to the live bug: a keyup on 31088 Colorado HD after a
// TG-700 RX showed "TG 700" (the stale 5e); it must show the channel's contact instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dmrLiveBadge } from '../src/domain/view'
import type { ChannelConfig } from '../src/codec/decode'

const CH = (colorCode: number, timeSlot: number, tg: number | null, callType: 'group' | 'private' = 'group'): ChannelConfig => ({
  type: 'digital', power: 'high', bandwidthKHz: 12.5, reverse: false, txProhibit: false, talkaround: false,
  rxTone: null, txTone: null, squelchMode: null, optionalSignal: null, compander: null, scrambler: null,
  busyLock: null, colorCode, timeSlot, txInterrupt: null, aprsReceive: null, smsForbid: null,
  dataAckForbid: null, dmrMode: 'repeater',
  contact: tg == null ? null : { callType, talkgroup: tg, name: 'CH CONTACT' },
})

// The radio's inert TX 5e — frozen at the previous call (CC7/TS1/TG700).
const staleTx = { direction: 'tx' as const, colorCode: 7, slot: 1, source: 700, dest: 700, private: false,
  presented: true, alias: null, callerId: null, callsign: null, name: null, location: null,
  audioRouted: true, side: 'a' as const, noLock: false }

test('RX badge trusts the 5e tuple (unchanged)', () => {
  const rx = { ...staleTx, direction: 'rx' as const, colorCode: 10, slot: 2, dest: 43114 }
  assert.deepEqual(dmrLiveBadge(rx, { channel: CH(1, 1, 9), dial: null }), { direction: 'rx', label: 'TS2 · CC10 · TG 43114' })
})

test('TX badge ignores the stale 5e, shows the channel contact + programmed CC/slot', () => {
  // channel 31088 Colorado HD: CC1/TS1/TG 31088 — the stale 5e says TG700 and must be overridden
  const badge = dmrLiveBadge(staleTx, { channel: CH(1, 1, 31088), dial: null })
  assert.deepEqual(badge, { direction: 'tx', label: 'TS1 · CC1 · TG 31088' })
})

test('TX badge with a manual dial shows the dialed target over the channel contact', () => {
  const badge = dmrLiveBadge(staleTx, { channel: CH(1, 1, 31088), dial: { target: 5004000, callType: 'group' } })
  assert.deepEqual(badge, { direction: 'tx', label: 'TS1 · CC1 · TG 5004000' })
})

test('TX badge respects a private dial (PRIV prefix)', () => {
  const badge = dmrLiveBadge(staleTx, { channel: CH(1, 2, 31088), dial: { target: 3223436, callType: 'private' } })
  assert.deepEqual(badge, { direction: 'tx', label: 'TS2 · CC1 · PRIV 3223436' })
})

test('TX badge with no known target still labels direction, never the stale 5e value', () => {
  const badge = dmrLiveBadge(staleTx, { channel: CH(3, 1, null), dial: null })
  assert.equal(badge?.label, 'TS1 · CC3', 'CC/slot only — no stale TG700 leaks through')
})

test('TX with no context at all falls back to the bare "TX" label (no 5e leak)', () => {
  assert.deepEqual(dmrLiveBadge(staleTx), { direction: 'tx', label: 'TX' })
})
