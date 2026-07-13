// Frame classification for the link layer (LINK_PROTOCOL §4-7). Pure predicates over the
// head byte — what kind of inbound frame is this, and how must we treat it.

/** Pushes the radio sends that the head MUST acknowledge (else the 5e-wedge: the radio
 * re-sends every ~500ms and starves the 5a stream). We reply with a 4-byte push-ACK. */
const REQUIRES_ACK: ReadonlySet<number> = new Set([0x5e, 0x58, 0x59, 0x5c, 0x5f])

/** Free pushes — forwarded to the domain, never acknowledged. */
const FREE_PUSH: ReadonlySet<number> = new Set([0x5a, 0x5b])

/** Command heads we send that are acknowledged by a 5-byte `03 <op> …` (not a data read). */
const WRITE_HEADS: ReadonlySet<number> = new Set([0x08, 0x2f, 0x57, 0x56, 0x01, 0x61, 0x64])

export function requiresAck(head: number): boolean {
  return REQUIRES_ACK.has(head)
}

export function isFreePush(head: number): boolean {
  return FREE_PUSH.has(head)
}

export function isWriteHead(head: number): boolean {
  return WRITE_HEADS.has(head)
}

/** Default retransmit-safety by command type (LINK_PROTOCOL §5): reads are idempotent;
 * `08` absolute settings writes are idempotent (re-writing the same value is harmless);
 * everything else (channel writes `2f`, scan `57`, PTT `56`) is unsafe unless the caller
 * asserts otherwise. The session opts BOTH PTT directions in explicitly: the RELEASE with the
 * full attempt budget (releasing twice is harmless, staying keyed is not — the retries are the
 * first stage of the PTT failsafe), and the KEY-DOWN tightly capped (KEY_MAX_ATTEMPTS) with
 * release-during-retry captured as intent — the radio's busy-gate drops 0x56 mid-RX, and the
 * real BT-01 retransmits its key-downs too (~1 s, MITM-measured). A retransmit only ever
 * re-sends an UNACKED command, so an acked key-down can never re-key the radio. */
export function defaultRetransmitSafe(head: number): boolean {
  if (head === 0x04) return true
  if (head === 0x08) return true
  return false
}
