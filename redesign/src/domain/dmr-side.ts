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
 * TG is weighted highest (it's the most specific). Returns a comparable number. A tuple match, not
 * a heuristic — if the call's CC/slot/TG don't line up with a side's programmed channel, the caller
 * should check the codeplug (an off-list TG on the contact is a programming issue, not ours). */
function score(dmr: DmrMatchKeys, c: ChannelConfig): number {
  let s = 0
  if (dmr.colorCode != null && c.colorCode != null) s += c.colorCode === dmr.colorCode ? 1 : -1
  if (dmr.slot != null && c.timeSlot != null) s += c.timeSlot === dmr.slot ? 1 : -1
  const tg = c.contact?.talkgroup ?? null
  if (dmr.dest != null && tg != null) s += tg === dmr.dest ? 2 : -2
  return s
}

export function resolveDmrSide(
  dmr: DmrMatchKeys,
  aConfig: ChannelConfig | null,
  bConfig: ChannelConfig | null,
  selectedSide: SideKey,
): SideKey {
  const aDmr = isDmr(aConfig)
  const bDmr = isDmr(bConfig)
  if (!aDmr && !bDmr) return selectedSide

  const aScore = aDmr ? score(dmr, aConfig) : Number.NEGATIVE_INFINITY
  const bScore = bDmr ? score(dmr, bConfig) : Number.NEGATIVE_INFINITY

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
