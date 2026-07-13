// activeReceive — attribute the current audio to the RIGHT side/channel so the recorder doesn't
// mis-mark a DMR call on the non-selected side. Same DMR-match rules as the UI meter/badge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeReceive } from '../src/domain/receive'
import { initialState } from '../src/domain/state'
import type { RadioState } from '../src/domain/state'
import type { ChannelConfig } from '../src/codec/decode'

const analog = { type: 'analog', colorCode: null, timeSlot: null, contact: null } as unknown as ChannelConfig
const dmr = (colorCode: number, timeSlot: number, talkgroup: number | null): ChannelConfig =>
  ({ type: 'digital', colorCode, timeSlot, contact: talkgroup == null ? null : { talkgroup } } as unknown as ChannelConfig)

function state(over: (s: RadioState) => void): RadioState {
  const s = initialState()
  s.sides.a.channelName = 'MAIN CH'
  s.sides.a.freqMHz = 146.52
  s.sides.b.channelName = 'SUB CH'
  s.sides.b.freqMHz = 441.0
  over(s)
  return s
}

test('DMR RX call on the NON-selected side attributes the clip to the DMR side', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.sides.a.channel = analog
    st.sides.b.channel = dmr(1, 1, 3100)
    st.dmr = {
      direction: 'rx', colorCode: 1, slot: 1, source: 3100, dest: 3100, private: false,
      alias: null, callerId: null, callsign: null, name: null, location: null,
    }
  })
  const r = activeReceive(s, true)
  assert.equal(r.side, 'b')
  assert.equal(r.channelName, 'SUB CH')
  assert.equal(r.mode, 'DMR')
  assert.equal(r.talkgroup, 3100, 'live received TG captured for lane keying')
})

test('analog audio attributes to the open analog side (not just the selected one)', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.sides.a.channel = analog
    st.sides.b.channel = analog
    st.signal.aOpen = false
    st.signal.bOpen = true
  })
  const r = activeReceive(s, true)
  assert.equal(r.side, 'b')
  assert.equal(r.channelName, 'SUB CH')
  assert.equal(r.mode, 'FM')
})

test('no DMR call and nothing open → the selected side; open passes through', () => {
  const s = state((st) => {
    st.selectedSide = 'a'
    st.sides.a.channel = analog
    st.sides.b.channel = analog
  })
  assert.equal(activeReceive(s, false).side, 'a')
  assert.equal(activeReceive(s, false).open, false)
  assert.equal(activeReceive(s, true).open, true)
})

// ── digital-audio inference: the live-observed 5e dropout (2026-07-10) ──────────

test('gate open + NO analog squelch + lone DMR side → the audio can only be that DMR side', () => {
  // The real bug: a DMR call whose 5e stream never decoded (dmr slice null) got recorded under
  // the SELECTED analog channel. With the gate open and no analog side open, analog is excluded.
  const s = state((st) => {
    st.selectedSide = 'a'
    st.sides.a.channel = analog
    st.sides.b.channel = dmr(9, 2, 5031320)
    st.dmr = null // the 5e stream never delivered a usable frame
    st.signal.aOpen = false
    st.signal.bOpen = false
  })
  const r = activeReceive(s, true)
  assert.equal(r.side, 'b', 'attributed to the lone DMR side, not the selected analog one')
  assert.equal(r.channelName, 'SUB CH')
  assert.equal(r.mode, 'DMR')
  assert.equal(r.talkgroup, null, 'no decode → no TG claimed')
})

test('the inference stays put with two DMR sides (ambiguous) or gate closed', () => {
  const two = state((st) => {
    st.selectedSide = 'a'
    st.sides.a.channel = dmr(1, 1, 111)
    st.sides.b.channel = dmr(2, 2, 222)
  })
  assert.equal(activeReceive(two, true).side, 'a', 'two DMR sides → ambiguous → selected side')
  const closed = state((st) => {
    st.selectedSide = 'a'
    st.sides.a.channel = analog
    st.sides.b.channel = dmr(1, 1, 111)
  })
  assert.equal(activeReceive(closed, false).side, 'a', 'gate closed → nothing to infer')
})

test('an OPEN analog side still wins over the inference (analog audio is analog)', () => {
  const s = state((st) => {
    st.selectedSide = 'b'
    st.sides.a.channel = analog
    st.sides.b.channel = dmr(1, 1, 111)
    st.signal.aOpen = true
  })
  assert.equal(activeReceive(s, true).side, 'a', 'the open analog side is the source')
})

test('source reports HOW the side was attributed (the re-attribution policy key)', () => {
  const dmrCall = state((st) => {
    st.selectedSide = 'a'
    st.sides.a.channel = analog
    st.sides.b.channel = dmr(1, 1, 3100)
    st.squelchOpen = true // gate corroborates the call (audio is really flowing)
    st.dmr = {
      direction: 'rx', colorCode: 1, slot: 1, source: 3100, dest: 3100, private: false,
      alias: null, callerId: null, callsign: null, name: null, location: null,
    }
  })
  assert.equal(activeReceive(dmrCall, true).source, 'dmr')

  // The SAME tuple with NO gate evidence is a scan-engine sample (wire-pinned 2026-07-11:
  // identified 5e frames for channels the scan merely hops across) — it must NOT attribute.
  const phantom = state((st) => {
    st.selectedSide = 'a'
    st.sides.a.channel = analog
    st.sides.b.channel = dmr(1, 1, 3100)
    st.dmr = dmrCall.dmr
  })
  assert.notEqual(activeReceive(phantom, true).source, 'dmr', 'an uncorroborated tuple attributes nothing')

  const analogOpen = state((st) => {
    st.sides.a.channel = analog
    st.sides.b.channel = analog
    st.signal.aOpen = true
  })
  assert.equal(activeReceive(analogOpen, true).source, 'analog')

  const inferred = state((st) => {
    st.sides.a.channel = analog
    st.sides.b.channel = dmr(9, 2, 5031320)
  })
  assert.equal(activeReceive(inferred, true).source, 'inferred')

  const fallback = state((st) => {
    st.sides.a.channel = analog
    st.sides.b.channel = analog
  })
  assert.equal(activeReceive(fallback, true).source, 'selected')
  assert.equal(activeReceive(fallback, false).source, 'selected')
})
