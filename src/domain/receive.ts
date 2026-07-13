// Which side/channel is the radio actually RECEIVING on right now, and its mode. The single mono
// HFP stream can't tell us which side an open audio gate belongs to, so we infer it from state —
// the SAME rules the UI meter/RX icon use (see dmr-side.ts). Used by the squelch recorder to tag a
// clip with the correct channel instead of blindly using the selected side (which mis-marked a DMR
// call on the non-selected side).

import { resolveDmrSide } from './dmr-side'
import type { ChannelConfig } from '../codec/decode'
import type { RadioState, SideKey } from './state'

const MODE_LABEL: Record<string, string> = { analog: 'FM', digital: 'DMR', 'a+d-tx-a': 'A+D', 'd+a-tx-d': 'D+A' }
/** Display mode of a channel config (FM / DMR / A+D / D+A) — shared with the TX-recorder context. */
export const modeLabel = (c: ChannelConfig | null): string | null => (c ? MODE_LABEL[c.type] ?? c.type : null)
const isDmr = (c: ChannelConfig | null): boolean => !!c && c.type !== 'analog'

export interface ReceiveSnapshot {
  /** The effective audio gate (5b audio flowing, or a 5a squelch bit) — see audioGateOpen. */
  open: boolean
  /** The side the current audio is attributed to. */
  side: SideKey
  /** HOW the side was attributed — the recorder's re-attribution policy keys off this:
   *  'dmr' = a decoded call's tuple; 'analog' = that side's 5a squelch is open (both are
   *  EVIDENCE); 'inferred' = gate open with no analog squelch → the lone DMR side (a sound
   *  default at clip-open, but transient during the 5a-closes-before-5b end-of-RX race);
   *  'selected' = nothing known, fell back to the selected side. */
  source: 'dmr' | 'analog' | 'inferred' | 'selected'
  /** Raw per-side 5a squelch bits — SIDE-level evidence for consumers that must know whether a
   * specific side (e.g. a clip's attributed side) is still receiving, independent of which side
   * this snapshot attributes the audio to. Honest for DMR sides too (wire-pinned 2026-07-11). */
  aOpen: boolean
  bOpen: boolean
  channelName: string
  freqMHz: number | null
  /** Display mode of the attributed channel (FM / DMR / A+D / D+A). */
  mode: string | null
  /** LIVE DMR talkgroup/target being received (the call's dest), when this is a DMR RX call on a DMR
   * channel — null otherwise. In digital-monitor mode this differs from the channel's programmed
   * contact, so it's what the recorder keys lanes by (one lane per TG). */
  talkgroup: number | null
}

/** The EFFECTIVE audio gate: the radio's 5b AUDIO gate (decoded voice flowing to the speaker/BT
 * path — live-QSO-pinned 2026-07-13; not a squelch flag) OR either side's 5a squelch-open.
 * The 5a fallback is load-bearing: during a native scan, a DMR call on the NON-scanning side
 * never pushes 5b OPEN (only a redundant CLOSED at call end) — but its 5a per-side open bit +
 * RSSI DO stream (wire-pinned 2026-07-11). Gate-dependent logic (scan pause, the recorder) must
 * derive openness from both sources, or it goes blind exactly in that state. */
export function audioGateOpen(state: RadioState): boolean {
  return state.audioGate || state.signal.aOpen || state.signal.bOpen
}

/** Resolve the receiving side + channel for the current audio. `open` is the effective audio gate
 * (see audioGateOpen); the side is the DMR-matched side during a DMR RX call, else the open
 * side per the 5a bits, else the lone-DMR inference, else the selected side. */
export function activeReceive(state: RadioState, open: boolean): ReceiveSnapshot {
  const a = state.sides.a
  const b = state.sides.b
  const dmr = state.dmr

  let side: SideKey = state.selectedSide
  let source: ReceiveSnapshot['source'] = 'selected'
  // A DMR RX call attributes to the matched side (CC/slot/TG) — but ONLY when audibly
  // CORROBORATED: the global gate or the matched side's own squelch bit. While a scan runs the
  // scan engine pushes fully identified 5e frames for channels it merely SAMPLES (wire-pinned
  // 2026-07-11: no 58/59/5b/5a-open, no audio) — an uncorroborated tuple must not steal the
  // attribution from a genuinely receiving analog side (or open phantom clips).
  const dmrSide = dmr && dmr.direction === 'rx' ? resolveDmrSide(dmr, a.channel, b.channel, state.selectedSide) : null
  // Corroboration = the matched side's OWN squelch bit, or the global gate open while the OTHER
  // side isn't the one holding it (an analog carrier elsewhere opens 5b too — that must not
  // validate a phantom call on this side).
  const dmrOwnBit = dmrSide === 'a' ? state.signal.aOpen : state.signal.bOpen
  const dmrOtherBit = dmrSide === 'a' ? state.signal.bOpen : state.signal.aOpen
  const dmrCorroborated = dmrSide != null && (dmrOwnBit || (state.audioGate && !dmrOtherBit))
  if (dmrSide != null && dmrCorroborated) {
    side = dmrSide
    source = 'dmr'
  } else {
    // Per-side 5a "open" bits — wire-pinned 2026-07-11: the radio reports them for DMR sides too
    // (othOpen + RSSI streamed during a non-selected-side DMR call), so they are side EVIDENCE
    // regardless of mode. Prefer the selected side when it's the one open.
    const aOpen = state.signal.aOpen
    const bOpen = state.signal.bOpen
    if (state.selectedSide === 'a' && aOpen) [side, source] = ['a', 'analog']
    else if (state.selectedSide === 'b' && bOpen) [side, source] = ['b', 'analog']
    else if (aOpen) [side, source] = ['a', 'analog']
    else if (bOpen) [side, source] = ['b', 'analog']
    else if (open) {
      // DIGITAL-AUDIO INFERENCE: the gate is open but NO analog squelch is — the audio can only
      // be digital. This is the live-observed dropout where a DMR call arrives with no usable 5e
      // decode (no tuple → dmr slice never locks): without this, the clip/labeling fell back to
      // the SELECTED side and a DMR transmission got recorded under an analog channel name.
      // Attribute to the lone DMR side; two DMR sides (or none) stays on the selected side.
      // NOTE: this also fires transiently at end-of-RX (the radio closes the per-side 5a squelch
      // a beat BEFORE the 5b gate) — which is why it reports source 'inferred': consumers that
      // would OVERTURN an existing attribution must require evidence, not this default.
      const aDmr = isDmr(a.channel)
      const bDmr = isDmr(b.channel)
      if (aDmr !== bDmr) [side, source] = [aDmr ? 'a' : 'b', 'inferred']
    }
  }

  const s = state.sides[side]
  // The live received TG only when this is a DMR RX call landing on a DMR channel.
  const talkgroup = dmr && dmr.direction === 'rx' && isDmr(s.channel) ? dmr.dest : null
  return {
    open,
    side,
    source,
    aOpen: state.signal.aOpen,
    bOpen: state.signal.bOpen,
    channelName: s.channelName,
    freqMHz: s.freqMHz,
    mode: modeLabel(s.channel),
    talkgroup,
  }
}
