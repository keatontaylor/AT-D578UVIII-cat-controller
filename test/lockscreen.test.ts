// lockScreenLines — the Media Session title/artist. Three regimes, strongest first: caller-id
// promotion (presented RX DMR call names the caller), RX promotion (audio flowing → the
// FIRST-RX-WINS receiving side takes the title, attributed by the recorder's holder latch so
// the lock screen and the clip labels can never disagree), idle (selected/other). The scan
// widget honesty rides on lockScreenSummary: while the scan position is unknown the zone-line
// status IS the line — never the previous channel's stale values.

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
  s.sides.a.freqMHz = 159.27
  s.sides.a.channel = analog
  s.sides.b.channelName = 'JOENX'
  s.sides.b.freqMHz = 449.7
  s.sides.b.channel = dmrCh(1, 1, 700)
  over(s)
  return s
}

test('idle: selected side is the title, other side the artist', () => {
  const { title, artist } = lockScreenLines(state((st) => (st.selectedSide = 'a')))
  assert.equal(title, 'A BCSO SOUTH · 159.270 · FM')
  assert.equal(artist, 'B JOENX · 449.700 · DMR')
})

// ── RX promotion: analog, first RX wins ─────────────────────────────────────────

test('analog squelch on the NON-selected side promotes that side to the title (RX prefix)', () => {
  const s = state((st) => {
    st.selectedSide = 'b'
    st.signal.aOpen = true
    st.signal.holder = 'a'
  })
  const { title, artist } = lockScreenLines(s)
  assert.equal(title, 'RX · A BCSO SOUTH · 159.270 · FM')
  assert.equal(artist, 'B JOENX · 449.700 · DMR')
})

test('holder latch: first RX keeps the title through an overlap (second side opening does not steal it)', () => {
  const s = state((st) => {
    st.selectedSide = 'b'
    st.sides.b.channel = analog // two analog sides, both open — the latch decides
    st.signal.aOpen = true
    st.signal.bOpen = true
    st.signal.holder = 'a' // A opened first
  })
  assert.equal(lockScreenLines(s).title, 'RX · A BCSO SOUTH · 159.270 · FM')
})

test('holder tail: the title holds while the audio still flows past the holder\'s own squelch close', () => {
  const s = state((st) => {
    st.selectedSide = 'b'
    st.audioGate = true // 5b still open (tail)
    st.signal.aOpen = false
    st.signal.holder = 'a'
  })
  assert.equal(lockScreenLines(s).title, 'RX · A BCSO SOUTH · 159.270 · FM')
})

test('no RX promotion while transmitting', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.ptt = 'keyed'
    st.audioGate = true
  })
  assert.equal(lockScreenLines(s).title, 'A BCSO SOUTH · 159.270 · FM', 'own TX never reads as RX')
})

test('a muted decode-only DMR call never lights the RX title (no gate, no open bit)', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.dmr = {
      direction: 'rx', colorCode: 1, slot: 1, source: 3223436, dest: 31088, private: false,
      alias: null, callerId: null, callsign: null, name: null, location: null, presented: false,
      audioRouted: false, side: 'b', noLock: true,
    }
  })
  const { title } = lockScreenLines(s)
  assert.ok(!title.startsWith('RX ·'), 'the lock screen is an audio surface — muted calls stay off it')
})

// ── caller-id promotion stays on top ────────────────────────────────────────────

test('an identified presented RX DMR call takes the title over the RX prefix', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.audioGate = true
    st.signal.holder = 'b'
    st.dmr = {
      direction: 'rx', colorCode: 1, slot: 1, source: 3223436, dest: 700, private: false,
      alias: null, callerId: 3223436, callsign: 'KF0WWS', name: 'Keaton', location: null,
      presented: true, audioRouted: true, side: 'b', noLock: false,
    }
  })
  const { title, artist } = lockScreenLines(s)
  assert.ok(title.includes('KF0WWS'), `caller in the title: ${title}`)
  assert.ok(artist.startsWith('B JOENX'), 'call-side channel context as the artist')
})

// ── scan honesty on the widget ──────────────────────────────────────────────────

test('scan hopping: the scan status IS the line — no stale channel values', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.scan = { active: true, listName: 'SHERIF RX', locked: false, paused: false, pausedChannel: null, parked: false, lockedChannel: null, lastLock: null }
  })
  assert.equal(lockScreenSummary(s, 'a'), 'A · SCANNING · SHERIF RX')
})

test('scan stop with signal, lock-follow read NOT landed: ACQUIRING, never the previous channel + LOCK', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.signal.aOpen = true
    st.signal.holder = 'a'
    st.scan = { active: true, listName: 'SHERIF RX', locked: true, paused: false, pausedChannel: null, parked: true, lockedChannel: null, lastLock: null }
  })
  const { title } = lockScreenLines(s)
  assert.equal(title, 'RX · A · ACQUIRING · SHERIF RX')
})

test('scan locked with the read landed: RX + the locked channel with the LOCK badge', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.signal.aOpen = true
    st.signal.holder = 'a'
    st.scan = { active: true, listName: 'SHERIF RX', locked: true, paused: false, pausedChannel: null, parked: true, lockedChannel: 'BCSO SOUTH', lastLock: null }
  })
  assert.equal(lockScreenLines(s).title, 'RX · A BCSO SOUTH · 159.270 · FM · LOCK · SHERIF RX')
})

test('RX on the non-scanning side during a scan: promoted title, scanning side stays honest as the artist', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.sides.b.channel = analog
    st.signal.bOpen = true
    st.signal.holder = 'b'
    st.scan = { active: true, listName: 'SHERIF RX', locked: false, paused: true, pausedChannel: null, parked: false, lockedChannel: null, lastLock: null }
  })
  const { title, artist } = lockScreenLines(s)
  assert.equal(title, 'RX · B JOENX · 449.700 · FM')
  assert.equal(artist, 'A · WAITING · SHERIF RX')
})
