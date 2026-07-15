// lockScreenLines — the Media Session title/artist, CAR RULE first: many car head units show
// only the title, so it is self-sufficient in every state — the identity of what you're hearing
// (channel on analog, caller on DMR), always led by the owning side (`A ·`). The artist is
// whatever the title demoted (freq/zone/tuple), or the other side when nothing was. The RX side
// is the recorder's FIRST-RX-WINS holder-latch attribution (activeReceive), so the lock screen
// and the clip labels can never disagree. Scan info shows ONLY while the position is unknown.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lockScreenLines, lockScreenSummary } from '../src/domain/view'
import { initialState } from '../src/domain/state'
import type { RadioState } from '../src/domain/state'
import type { ChannelConfig } from '../src/codec/decode'

const analog = { type: 'analog', colorCode: null, timeSlot: null, contact: null } as unknown as ChannelConfig
const dmrCh = (colorCode: number, timeSlot: number, talkgroup: number | null): ChannelConfig =>
  ({ type: 'digital', colorCode, timeSlot, contact: talkgroup == null ? null : { talkgroup } } as unknown as ChannelConfig)

function state(over: (s: RadioState) => void): RadioState {
  const s = initialState()
  s.sides.a.channelName = 'BCSO SOUTH'
  s.sides.a.zoneName = 'SHERIF RX'
  s.sides.a.freqMHz = 159.27
  s.sides.a.channel = analog
  s.sides.b.channelName = 'JOENX'
  s.sides.b.zoneName = 'HOTSPOT'
  s.sides.b.freqMHz = 449.7
  s.sides.b.channel = dmrCh(1, 1, 700)
  over(s)
  return s
}

const rxCall = (over: Partial<NonNullable<RadioState['dmr']>> = {}): NonNullable<RadioState['dmr']> => ({
  direction: 'rx', colorCode: 1, slot: 1, source: 3223436, dest: 700, private: false,
  alias: null, callerId: null, callsign: null, name: null, location: null,
  presented: true, audioRouted: true, side: 'b', noLock: false, ...over,
})

test('idle: side-led selected/other lines, no mode trivia', () => {
  const { title, artist } = lockScreenLines(state((st) => (st.selectedSide = 'a')))
  assert.equal(title, 'A · BCSO SOUTH · 159.270')
  assert.equal(artist, 'B · JOENX · 449.700')
})

// ── analog RX promotion: first RX wins, freq demotes to the artist ─────────────

test('analog RX: named channel is the whole title; artist = zone + demoted freq', () => {
  const s = state((st) => {
    st.selectedSide = 'b'
    st.signal.aOpen = true
    st.signal.holder = 'a'
  })
  const { title, artist } = lockScreenLines(s)
  assert.equal(title, 'RX · A · BCSO SOUTH')
  assert.equal(artist, 'SHERIF RX · 159.270')
})

test('holder latch: first RX keeps the title through an overlap', () => {
  const s = state((st) => {
    st.selectedSide = 'b'
    st.sides.b.channel = analog // two analog sides, both open — the latch decides
    st.signal.aOpen = true
    st.signal.bOpen = true
    st.signal.holder = 'a' // A opened first
  })
  assert.equal(lockScreenLines(s).title, 'RX · A · BCSO SOUTH')
})

test('holder tail: the title holds while audio still flows past the holder\'s squelch close', () => {
  const s = state((st) => {
    st.selectedSide = 'b'
    st.audioGate = true // 5b still open (tail)
    st.signal.aOpen = false
    st.signal.holder = 'a'
  })
  assert.equal(lockScreenLines(s).title, 'RX · A · BCSO SOUTH')
})

test('no RX promotion while transmitting', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.ptt = 'keyed'
    st.audioGate = true
  })
  assert.equal(lockScreenLines(s).title, 'A · BCSO SOUTH · 159.270', 'own TX never reads as RX')
})

test('a muted decode-only DMR call never lights the RX title (no gate, no open bit)', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.dmr = rxCall({ dest: 31088, presented: false, audioRouted: false, noLock: true })
  })
  const { title } = lockScreenLines(s)
  assert.equal(title, 'A · BCSO SOUTH · 159.270', 'the lock screen is an audio surface — muted calls stay off it')
})

// ── DMR promotions: caller identity on top, TG always on the title ─────────────

test('identified caller: side · callsign · first name · location · TG; artist = channel + tuple', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.audioGate = true
    st.signal.holder = 'b'
    st.dmr = rxCall({ callerId: 3223436, callsign: 'KF0WWS', name: 'Keaton Taylor', location: 'Parker, CO' })
  })
  const { title, artist } = lockScreenLines(s)
  assert.equal(title, 'B · KF0WWS · Keaton · Parker, CO · TG 700')
  assert.equal(artist, 'JOENX · TS1 CC1')
})

test('identified caller with sparse DB row: parts render as available', () => {
  const s = state((st) => {
    st.audioGate = true
    st.signal.holder = 'b'
    st.dmr = rxCall({ callsign: 'KF0WWS' })
  })
  assert.equal(lockScreenLines(s).title, 'B · KF0WWS · TG 700')
})

test('presented call, no DB identity: RX title keeps the live TG; artist = zone + tuple', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.audioGate = true
    st.signal.holder = 'b'
    st.dmr = rxCall()
  })
  const { title, artist } = lockScreenLines(s)
  assert.equal(title, 'RX · B · JOENX · TG 700')
  assert.equal(artist, 'HOTSPOT · TS1 CC1')
})

test('private call renders PRIV, not TG', () => {
  const s = state((st) => {
    st.audioGate = true
    st.signal.holder = 'b'
    st.dmr = rxCall({ private: true, dest: 3223436, callsign: 'KF0WWS', name: 'Keaton Taylor' })
  })
  assert.equal(lockScreenLines(s).title, 'B · KF0WWS · Keaton · PRIV 3223436')
})

// ── scan honesty: status only while the position is unknown ────────────────────

test('scan hopping: the scan status IS the line — no stale channel values', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.scan = { active: true, listName: 'SHERIF RX', locked: false, paused: false, pausedChannel: null, parked: false, lockedChannel: null, lastLock: null }
  })
  assert.equal(lockScreenSummary(s, 'a'), 'A · SCANNING · SHERIF RX')
})

test('scan stop with signal, lock-follow read NOT landed: ACQUIRING, never the previous channel', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.signal.aOpen = true
    st.signal.holder = 'a'
    st.scan = { active: true, listName: 'SHERIF RX', locked: true, paused: false, pausedChannel: null, parked: true, lockedChannel: null, lastLock: null }
  })
  const { title, artist } = lockScreenLines(s)
  assert.equal(title, 'RX · A · ACQUIRING · SHERIF RX')
  assert.equal(artist, 'B · JOENX · 449.700', 'nothing demoted — the other side keeps the artist')
})

test('scan locked with the read landed: plain RX title; the artist says LOCKED · list', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.signal.aOpen = true
    st.signal.holder = 'a'
    st.scan = { active: true, listName: 'SHORT FAVORITES', locked: true, paused: false, pausedChannel: null, parked: true, lockedChannel: 'BCSO SOUTH', lastLock: null }
  })
  const { title, artist } = lockScreenLines(s)
  assert.equal(title, 'RX · A · BCSO SOUTH', 'no LOCK suffix — a landed stop is just a channel')
  assert.equal(artist, 'LOCKED · SHORT FAVORITES')
})

test('RX on the non-scanning side during a scan: promoted title, aux artist for that side', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.sides.b.channel = analog
    st.signal.bOpen = true
    st.signal.holder = 'b'
    st.scan = { active: true, listName: 'SHERIF RX', locked: false, paused: true, pausedChannel: null, parked: false, lockedChannel: null, lastLock: null }
  })
  const { title, artist } = lockScreenLines(s)
  assert.equal(title, 'RX · B · JOENX')
  assert.equal(artist, 'HOTSPOT · 449.700')
})
