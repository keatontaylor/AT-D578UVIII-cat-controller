// PTT lifecycle state machine (UI_PROTOCOL PTT color contract, LINK_PROTOCOL §6). A pure
// transition function over five phases. Unlike the rest of RadioState, PTT is driven by
// local intent + command outcomes (not radio frames) — but the transitions are still pure
// and centralized here. Safety-critical rule: an unkey FAILURE goes to `fault`, never `idle`
// (we must never report "released" when the radio may still be transmitting).

export const PTT_PHASES = ['idle', 'keying', 'keyed', 'unkeying', 'fault'] as const
export type PttPhase = (typeof PTT_PHASES)[number]

/** key/unkey = local intent; acked/failed = the command outcome. */
export type PttEvent = 'key' | 'unkey' | 'acked' | 'failed'

export function nextPttPhase(phase: PttPhase, event: PttEvent): PttPhase {
  switch (event) {
    case 'key':
      return phase === 'idle' || phase === 'fault' ? 'keying' : phase
    case 'unkey':
      // A release may be attempted from `fault` too — that is the FAILSAFE path (a key-down whose
      // ack never came leaves the TX state unknown; the recovery is to keep trying to release).
      return phase === 'keyed' || phase === 'fault' ? 'unkeying' : phase
    case 'acked':
      if (phase === 'keying') return 'keyed'
      if (phase === 'unkeying') return 'idle'
      return phase
    case 'failed':
      return phase === 'keying' || phase === 'unkeying' ? 'fault' : phase
  }
}
