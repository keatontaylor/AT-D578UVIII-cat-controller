// Wire-frame BUILDERS for the radio simulator — the encode side the real radio implements.
// Every frame is emitted at its corpus length (data/frame-lengths.json) with a valid trailing
// checksum, so it passes through the REAL Framer + decoders unmodified. Offsets mirror
// src/codec/decode.ts exactly (the decoders are the evidence-grounded spec; these builders are
// their inverse). Pure functions over bytes — no state.

import { additiveSum } from '../../src/codec/checksum'

/** Seal a frame: write the additive checksum into the final byte and return it. */
export function sealed(bytes: Uint8Array): Uint8Array {
  bytes[bytes.length - 1] = additiveSum(bytes, 0, bytes.length - 1)
  return bytes
}

function putAscii(b: Uint8Array, off: number, text: string, maxLen: number): void {
  for (let i = 0; i < text.length && i < maxLen; i += 1) b[off + i] = text.charCodeAt(i)
}

/** 8-digit big-endian BCD of `value` into 4 bytes at `off` (freqs are 10 Hz units, TGs plain). */
function putBcd4(b: Uint8Array, off: number, value: number): void {
  const digits = String(Math.round(value)).padStart(8, '0')
  for (let i = 0; i < 4; i += 1) b[off + i] = (Number(digits[i * 2]) << 4) | Number(digits[i * 2 + 1])
}

/** 5-byte command ack: `03 <op> 00 00 <ck>`. */
export function ack(op: number): Uint8Array {
  return sealed(Uint8Array.of(0x03, op & 0xff, 0x00, 0x00, 0x00))
}

// ── channel model the sim's codeplug uses ─────────────────────────────────────

export interface SimTone {
  readonly type: 'off' | 'ctcss' | 'dcs'
  /** 1-based CTCSS index, or the DCS code as its decimal label (e.g. 23 for D023). */
  readonly value?: number
}

export interface SimChannel {
  readonly name: string
  readonly rxMHz: number
  /** Repeater shift in MHz (signed); 0 = simplex. */
  readonly shiftMHz?: number
  readonly type: 'analog' | 'digital'
  readonly power?: 'low' | 'mid' | 'high' | 'turbo'
  readonly rxTone?: SimTone
  readonly txTone?: SimTone
  // digital
  readonly colorCode?: number
  readonly timeSlot?: 1 | 2
  readonly contact?: { callType: 'group' | 'private' | 'all'; talkgroup: number; name: string }
}

const POWER_INDEX = { low: 0, mid: 1, high: 2, turbo: 3 } as const

function toneTypeRaw(t: SimTone | undefined): number {
  return t?.type === 'ctcss' ? 1 : t?.type === 'dcs' ? 2 : 0
}

/** `04 2c`/`04 2d` full channel record (118 B for A / 121 B for B — the corpus lengths).
 * Inverse of decodeChannel/decodeChannelConfig: freq BCD @2, offset BCD @6-9, type/power/bw/shift
 * @10, tone types + flags @11, tone values @12-17, CC @34, slot @35, name @37, DMR-direct @54,
 * position @71, contact @74-94. */
export function channelBlock(side: 'a' | 'b', ch: SimChannel, position: number): Uint8Array {
  const b = new Uint8Array(side === 'a' ? 118 : 121)
  b[0] = 0x04
  b[1] = side === 'a' ? 0x2c : 0x2d
  putBcd4(b, 2, ch.rxMHz * 1e5)
  const shift = ch.shiftMHz ?? 0
  const shiftDir = shift > 0 ? 1 : shift < 0 ? 2 : 0
  if (shiftDir !== 0) putBcd4(b, 6, Math.abs(shift) * 1e5)
  const typeBits = ch.type === 'digital' ? 1 : 0
  b[10] = typeBits | (POWER_INDEX[ch.power ?? 'high'] << 2) | 0x10 /* 25 kHz */ | (shiftDir << 6)
  b[11] = toneTypeRaw(ch.rxTone) | (toneTypeRaw(ch.txTone) << 2)
  if (ch.txTone?.type === 'ctcss') b[12] = ch.txTone.value ?? 0
  if (ch.rxTone?.type === 'ctcss') b[13] = ch.rxTone.value ?? 0
  if (ch.txTone?.type === 'dcs') {
    const raw = parseInt(String(ch.txTone.value ?? 0), 8)
    b[14] = raw & 0xff
    b[15] = (raw >> 8) & 0xff
  }
  if (ch.rxTone?.type === 'dcs') {
    const raw = parseInt(String(ch.rxTone.value ?? 0), 8)
    b[16] = raw & 0xff
    b[17] = (raw >> 8) & 0xff
  }
  if (ch.type === 'digital') {
    b[34] = (ch.colorCode ?? 1) & 0x0f
    b[35] = ((ch.timeSlot ?? 1) - 1) & 0x01
    b[54] = 0x00 // repeater mode (direct bit clear)
    if (ch.contact) {
      b[0x4a] = ch.contact.callType === 'group' ? 1 : ch.contact.callType === 'all' ? 2 : 0
      putBcd4(b, 75, ch.contact.talkgroup)
      putAscii(b, 79, ch.contact.name, 16)
    }
  }
  putAscii(b, 37, ch.name, 16)
  b[71] = position & 0xff
  return sealed(b)
}

/** `04 29`/`04 2a` zone block (37 B): name @2, 0-based zone index @34. */
export function zoneBlock(side: 'a' | 'b', name: string, zoneIndex: number): Uint8Array {
  const b = new Uint8Array(37)
  b[0] = 0x04
  b[1] = side === 'a' ? 0x29 : 0x2a
  putAscii(b, 2, name, 16)
  b[34] = zoneIndex & 0xff
  return sealed(b)
}

/** `04 05` settings block (99 B) — zeros decode to each setting's option[0]; the radio's ACTIVE
 * side lives at byte 37 (0 = A / 1 = B), the authoritative 5a frame-of-reference source. */
export function settingsBlock05(selectedSide: 'a' | 'b'): Uint8Array {
  const b = new Uint8Array(99)
  b[0] = 0x04
  b[1] = 0x05
  b[37] = selectedSide === 'b' ? 1 : 0
  return sealed(b)
}

/** `04 06` (99 B) / `04 09` (141 B) settings blocks — zeroed payloads (option[0] everywhere). */
export function settingsBlock(reg: 0x06 | 0x09): Uint8Array {
  const b = new Uint8Array(reg === 0x09 ? 141 : 99)
  b[0] = 0x04
  b[1] = reg
  return sealed(b)
}

/** `04 1b` (60 B): the codeplug's zone count @36. */
export function zoneCountBlock(count: number): Uint8Array {
  const b = new Uint8Array(60)
  b[0] = 0x04
  b[1] = 0x1b
  b[36] = count & 0xff
  return sealed(b)
}

/** `04 27 <zone>` member list (104 B): LE16 global channel indices from byte 3, 0xffff-terminated. */
export function zoneMembersBlock(zoneIndex: number, members: readonly number[]): Uint8Array {
  const b = new Uint8Array(104)
  b[0] = 0x04
  b[1] = 0x27
  b[2] = zoneIndex & 0xff
  let off = 3
  for (const m of members.slice(0, 49)) {
    b[off] = m & 0xff
    b[off + 1] = (m >> 8) & 0xff
    off += 2
  }
  b[off] = 0xff
  b[off + 1] = 0xff
  return sealed(b)
}

/** `04 2e` channel-name-by-global-index reply (20 B): ASCII @2. */
export function channelNameBlock(name: string): Uint8Array {
  const b = new Uint8Array(20)
  b[0] = 0x04
  b[1] = 0x2e
  putAscii(b, 2, name, 16)
  return sealed(b)
}

/** `04 2b <idx>` zone-directory browse reply (35 B): 32-byte ASCII name @2 (blank slot → zeros). */
export function zoneBrowseBlock(index: number, name: string | null): Uint8Array {
  const b = new Uint8Array(35)
  b[0] = 0x04
  b[1] = 0x2b
  void index // the reply does not echo the index; the request/response pairing attributes it
  if (name) putAscii(b, 2, name, 32)
  return sealed(b)
}

/** `04 4b <idx>` scan-list directory entry: 135 B populated (name @17) / 18 B empty slot.
 * `reg` 0x4a builds the working channel's ASSIGNED-list record instead (same layout; its empty
 * form stays 135 B with a zeroed name — pass '' — since 4a is a fixed-length register). */
export function scanListBlock(index: number, name: string | null, reg: 0x4a | 0x4b = 0x4b): Uint8Array {
  const b = new Uint8Array(name === null ? 18 : 135)
  b[0] = 0x04
  b[1] = reg
  b[2] = index & 0xff
  if (name !== null) putAscii(b, 17, name, 16)
  return sealed(b)
}

/** `04 02` firmware/model string (33 B). */
export function firmwareBlock(version: string): Uint8Array {
  const b = new Uint8Array(33)
  b[0] = 0x04
  b[1] = 0x02
  putAscii(b, 2, version, 28)
  return sealed(b)
}

/** `04 32` identity (35 B): DMR id BCD @2, callsign @7. */
export function identityBlock(dmrId: number, callsign: string): Uint8Array {
  const b = new Uint8Array(35)
  b[0] = 0x04
  b[1] = 0x32
  putBcd4(b, 2, dmrId)
  putAscii(b, 7, callsign, 16)
  return sealed(b)
}

/** `04 51` clock (12 B): binary h/m/s @2-4, year LE16 @6-7, month @8, day @9. */
export function clockBlock(hour: number, minute: number, second: number): Uint8Array {
  const b = new Uint8Array(12)
  b[0] = 0x04
  b[1] = 0x51
  b[2] = hour
  b[3] = minute
  b[4] = second
  b[6] = 2026 & 0xff
  b[7] = 2026 >> 8
  b[8] = 7
  b[9] = 10
  return sealed(b)
}

/** Opaque enumeration registers the reducer ignores (`04 4d` 29 B / `04 4e` 7 B). */
export function opaqueBlock(reg: 0x4d | 0x4e): Uint8Array {
  const b = new Uint8Array(reg === 0x4d ? 29 : 7)
  b[0] = 0x04
  b[1] = reg
  return sealed(b)
}

// ── live pushes (side-RELATIVE, exactly like the radio) ───────────────────────

export interface SmeterFields {
  readonly selectedRssi: number
  readonly otherRssi: number
  readonly selectedOpen: boolean
  readonly otherOpen: boolean
  readonly transmitting?: boolean
  /** Native scan running (byte 12 = 0x02) — the radio's own scan truth, corpus-pinned. */
  readonly scanning?: boolean
}

/** `5a` async smeter push (16 B): selected RSSI @1, other @2, open mask @5 (bit1 selected /
 * bit2 other), radio-state byte @7 (0x86 = TX, 0x89 = idle — the live-pinned values), native-scan
 * flag @12 (0x02 while a scan runs). */
export function smeterPush(f: SmeterFields): Uint8Array {
  const b = new Uint8Array(16)
  b[0] = 0x5a
  b[1] = f.selectedRssi & 0xff
  b[2] = f.otherRssi & 0xff
  b[5] = (f.selectedOpen ? 0x02 : 0) | (f.otherOpen ? 0x04 : 0)
  b[7] = f.transmitting ? 0x86 : 0x89
  b[12] = f.scanning ? 0x02 : 0x00
  return sealed(b)
}

/** `04 5a` read reply (17 B) — the push layout shifted by the `04` prefix. */
export function smeterRead(f: SmeterFields): Uint8Array {
  const b = new Uint8Array(17)
  b[0] = 0x04
  b.set(smeterPush(f).subarray(0, 15), 1)
  return sealed(b)
}

/** `5b <open>` global squelch-gate push (3 B). */
export function squelchPush(open: boolean): Uint8Array {
  return sealed(Uint8Array.of(0x5b, open ? 1 : 0, 0))
}

/** `04 5b` read reply (4 B). */
export function squelchRead(open: boolean): Uint8Array {
  return sealed(Uint8Array.of(0x04, 0x5b, open ? 1 : 0, 0))
}

export interface DmrCallFields {
  readonly direction: 'rx' | 'tx'
  readonly colorCode: number
  readonly slot: 1 | 2
  readonly source: number
  readonly dest: number
}

/** `5e` DMR link-state push (18 B), VOICE frame: status @1, 0x61 @2, CC @7, src BCD @8-11,
 * slot @12, dest BCD @13-16. A group call carries the TG in BOTH src and dest. */
export function dmrVoicePush(f: DmrCallFields): Uint8Array {
  const b = new Uint8Array(18)
  b[0] = 0x5e
  b[1] = f.direction === 'tx' ? 2 : 1
  b[2] = 0x61
  b[7] = f.colorCode & 0x0f
  putBcd4(b, 8, f.source)
  b[12] = f.slot - 1
  putBcd4(b, 13, f.dest)
  return sealed(b)
}

/** `5e` CONTROL frame (0x21 — no trustworthy identity fields): exercises the reducer's latch. */
export function dmrControlPush(direction: 'rx' | 'tx'): Uint8Array {
  const b = new Uint8Array(18)
  b[0] = 0x5e
  b[1] = direction === 'tx' ? 2 : 1
  b[2] = 0x21
  b[7] = 0x2a // an LC/reason code the decoder must NOT read as a color code
  return sealed(b)
}

/** `5e` idle push — the explicit end-of-call (status 0). */
export function dmrIdlePush(): Uint8Array {
  const b = new Uint8Array(18)
  b[0] = 0x5e
  b[2] = 0x21
  return sealed(b)
}

/** `04 5e` read reply (19 B) — idle unless a call is passed. */
export function dmrRead(f: DmrCallFields | null): Uint8Array {
  const b = new Uint8Array(19)
  b[0] = 0x04
  const push = f ? dmrVoicePush(f) : dmrIdlePush()
  b.set(push.subarray(0, 17), 1)
  return sealed(b)
}

/** `58` talker-info push (112 B): DMR id BCD @6-9, 16-char alias @10-25. */
export function aliasPush(id: number, alias: string): Uint8Array {
  const b = new Uint8Array(112)
  b[0] = 0x58
  putBcd4(b, 6, id)
  putAscii(b, 10, alias, 16)
  return sealed(b)
}

export interface SimLastCall {
  readonly dest: number
  readonly destName?: string
  readonly callerId: number
  readonly callerName?: string
}

/** `04 59` persisted last-call record (59 B): dest BCD @3-6 + name @7-22, caller BCD @25-28 +
 * name @29-44. Null → the cleared (all-zero) record of a radio that has heard no call. */
export function lastCallBlock(f: SimLastCall | null): Uint8Array {
  const b = new Uint8Array(59)
  b[0] = 0x04
  b[1] = 0x59
  if (f) {
    putBcd4(b, 3, f.dest)
    putAscii(b, 7, f.destName ?? '', 16)
    putBcd4(b, 25, f.callerId)
    putAscii(b, 29, f.callerName ?? '', 16)
  }
  return sealed(b)
}
