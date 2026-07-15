// Resolve which physical side (a/b) a live DMR call belongs to. The 5e/58 stream carries NO side
// field, so we match the call's identity (color code + time slot + destination talkgroup) against
// each side's programmed channel. Rules (user spec):
//   1. If a side's DMR channel matches the call's CC/slot/TG, that side wins (a mismatch on a known
//      field scores negative, so the WRONG side loses even when both are DMR).
//   2. Else if exactly one side is DMR, that side.
//   3. Else (both DMR, no discriminating match, or a tie) → the active/selected side.
// When neither side is DMR (shouldn't happen during a call) → the selected side.

import type { ChannelConfig } from '../codec/decode'
import type { SideKey } from './state'

export interface DmrMatchKeys {
  colorCode: number | null
  slot: number | null
  dest: number | null
}

const isDmr = (c: ChannelConfig | null): c is ChannelConfig => c != null && c.type !== 'analog'

/** Discrimination score: +credit for each known field that matches, −penalty for a known mismatch.
 * TG is weighted highest (it's the most specific). A per-side MANUAL-DIAL target, when set, is an
 * even STRONGER signal — the operator explicitly declaring "this side is on that TG right now" —
 * so a dial match outscores everything, breaking a tie between two DMR channels that share a
 * programmed contact (the "solid data for a side match" case). Returns a comparable number. */
function score(dmr: DmrMatchKeys, c: ChannelConfig, dialTarget: number | null): number {
  let s = 0
  if (dmr.colorCode != null && c.colorCode != null) s += c.colorCode === dmr.colorCode ? 1 : -1
  if (dmr.slot != null && c.timeSlot != null) s += c.timeSlot === dmr.slot ? 1 : -1
  const tg = c.contact?.talkgroup ?? null
  if (dmr.dest != null && tg != null) s += tg === dmr.dest ? 2 : -2
  // A dialed target matching the call's dest is decisive; a dial to a DIFFERENT TG is a strong
  // signal this side is NOT the one (only weighed when the call carries a dest to compare).
  if (dialTarget != null && dmr.dest != null) s += dialTarget === dmr.dest ? 4 : -3
  return s
}

export function resolveDmrSide(
  dmr: DmrMatchKeys,
  aConfig: ChannelConfig | null,
  bConfig: ChannelConfig | null,
  selectedSide: SideKey,
  aDial: number | null = null,
  bDial: number | null = null,
): SideKey {
  const aDmr = isDmr(aConfig)
  const bDmr = isDmr(bConfig)
  if (!aDmr && !bDmr) return selectedSide

  const aScore = aDmr ? score(dmr, aConfig, aDial) : Number.NEGATIVE_INFINITY
  const bScore = bDmr ? score(dmr, bConfig, bDial) : Number.NEGATIVE_INFINITY

  // 1. a positive, discriminating match wins (ambiguous tie falls through to the active side)
  if (aScore > 0 || bScore > 0) {
    if (aScore !== bScore) return aScore > bScore ? 'a' : 'b'
    return selectedSide
  }
  // 2. exactly one side is DMR
  if (aDmr && !bDmr) return 'a'
  if (bDmr && !aDmr) return 'b'
  // 3. both DMR, nothing discriminating → the active side
  return selectedSide
}

/** FIRST-WINS side attribution for a call at ONSET (latched thereafter — see dmr.side). Only one
 * DMR call decodes at a time (they never overlap), so the sideless 5e stream belongs to the DMR
 * side whose 5a CARRIER is open right now — the physical truth of where the signal landed, which
 * beats a tuple coincidence and even resolves a DigiMon-off non-matching call (whose tuple matches
 * neither channel). Ambiguous (both DMR sides carrier-open, or neither yet — the 5e beat the 5a) →
 * fall back to the identity/dial resolver. */
export function pickDmrSide(
  dmr: DmrMatchKeys,
  aConfig: ChannelConfig | null,
  bConfig: ChannelConfig | null,
  selectedSide: SideKey,
  aOpen: boolean,
  bOpen: boolean,
  aDial: number | null = null,
  bDial: number | null = null,
): SideKey {
  const aCarrier = isDmr(aConfig) && aOpen
  const bCarrier = isDmr(bConfig) && bOpen
  if (aCarrier && !bCarrier) return 'a'
  if (bCarrier && !aCarrier) return 'b'
  return resolveDmrSide(dmr, aConfig, bConfig, selectedSide, aDial, bDial)
}
