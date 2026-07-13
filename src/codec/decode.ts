// Register decoders: a complete frame's payload → a typed value (ARCHITECTURE codec layer).
// Pure functions over bytes, no state. Offsets are evidence-grounded (COMMAND_REFERENCE +
// settings-offsets.json); the connect→state replay test pins them against a real startup.

import { settingsForBlock } from './settings-table'
import { CTCSS_TONES } from './tone-tables'

const isPrintable = (b: number): boolean => b >= 0x20 && b <= 0x7e

/** Null-terminated printable-ASCII string from `bytes[off, off+maxLen)`, trimmed. */
export function asciiZ(bytes: Uint8Array, off: number, maxLen: number): string {
  let s = ''
  for (let i = off; i < off + maxLen && i < bytes.length; i += 1) {
    const b = bytes[i]!
    if (b === 0) break
    if (isPrintable(b)) s += String.fromCharCode(b)
  }
  return s.trim()
}

/** `n` bytes from `off` as 2·n big-endian BCD digits → integer, or null if a nibble isn't 0-9. */
export function bcd(bytes: Uint8Array, off: number, n: number): number | null {
  let v = 0
  for (let i = 0; i < n; i += 1) {
    const b = bytes[off + i]
    if (b === undefined) return null
    const hi = b >> 4
    const lo = b & 0x0f
    if (hi > 9 || lo > 9) return null
    v = v * 100 + hi * 10 + lo
  }
  return v
}

/** AnyTone channel frequency: 8-digit BCD in 10 Hz units → MHz (null if empty/invalid). */
export function freqMHz(bytes: Uint8Array, off: number): number | null {
  const n = bcd(bytes, off, 4)
  if (n === null || n === 0) return null
  return n / 1e5
}

/** `04 02` — firmware / model string. */
export function decodeFirmware(frame: Uint8Array): string {
  return asciiZ(frame, 2, 28)
}

export interface Clock {
  readonly hour: number
  readonly minute: number
  readonly second: number
  /** Calendar date, when the frame carries it (bytes 6-9); null on the short form. */
  readonly year: number | null
  readonly month: number | null
  readonly day: number | null
}

/** `04 51` — real-time clock (binary h/m/s at bytes 2-4; date at 6-9: year LE16 @6-7, month @8,
 * day @9 — PoC-confirmed). The radio runs on UTC. */
export function decodeClock(frame: Uint8Array): Clock | null {
  if (frame.length < 5) return null
  const hour = frame[2]!
  const minute = frame[3]!
  const second = frame[4]!
  if (hour > 23 || minute > 59 || second > 59) return null
  let year: number | null = null
  let month: number | null = null
  let day: number | null = null
  if (frame.length >= 10) {
    const y = frame[6]! | (frame[7]! << 8)
    const m = frame[8]!
    const d = frame[9]!
    // Tight plausible window — the radio's UNSET clock reports an implausible default (a 2070
    // date appears in the corpus); treat anything outside a realistic range as "no date".
    if (y >= 2020 && y < 2060 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      year = y
      month = m
      day = d
    }
  }
  return { hour, minute, second, year, month, day }
}

export type ChannelMode = 'vfo' | 'memory'
export type ChannelType = 'analog' | 'digital' | 'a+d-tx-a' | 'd+a-tx-d'
export type TxPower = 'low' | 'mid' | 'high' | 'turbo'

export type ToneKind = 'off' | 'ctcss' | 'dcs'
export interface Tone {
  readonly kind: ToneKind
  readonly display: string
  /** 1-based CTCSS index (kind 'ctcss'), else null — lets the editor preselect. */
  readonly ctcssIndex: number | null
  /** DCS code as a decimal label (kind 'dcs'), else null. */
  readonly dcsCode: number | null
}
export type SquelchMode = 'sq' | 'cdt' | 'tone' | 'c&t' | 'c|t'
export type OptionalSignal = 'off' | 'dtmf' | '2tone' | '5tone'
export type BusyLock = 'off' | 'cdt' | 'free'
export type TxInterrupt = 'off' | 'low' | 'high'
export type CallType = 'group' | 'private' | 'all'

/** The DMR contact a digital channel transmits to. */
export interface Contact {
  readonly callType: CallType
  readonly talkgroup: number | null
  readonly name: string
}

/** The working channel's configuration, read back from the live bitfields in the channel block.
 * The 72-byte compact and full 118/121-byte records share the core config offsets; deeper fields
 * decode only when the frame is long enough. Analog fields are null on a digital-only channel and
 * vice-versa. */
export interface ChannelConfig {
  readonly type: ChannelType
  readonly power: TxPower
  readonly bandwidthKHz: number // 12.5 (narrow) or 25 (wide)
  readonly reverse: boolean
  readonly txProhibit: boolean
  readonly talkaround: boolean
  // analog
  readonly rxTone: Tone | null
  readonly txTone: Tone | null
  readonly squelchMode: SquelchMode | null
  readonly optionalSignal: OptionalSignal | null
  readonly compander: boolean | null
  readonly scrambler: number | null // 0 = off, 1-11 = scrambler mode
  readonly busyLock: BusyLock | null
  // digital (DMR)
  readonly colorCode: number | null
  readonly timeSlot: number | null // 1 or 2
  readonly txInterrupt: TxInterrupt | null
  readonly aprsReceive: boolean | null
  readonly smsForbid: boolean | null
  readonly dataAckForbid: boolean | null
  readonly dmrMode: DmrMode | null
  readonly contact: Contact | null
}

export type DmrMode = 'simplex' | 'repeater' | 'double-slot' | 'double-slot-d'

const SQUELCH_MODES: readonly SquelchMode[] = ['sq', 'cdt', 'tone', 'c&t', 'c|t']
const OPTIONAL_SIGNALS: readonly OptionalSignal[] = ['off', 'dtmf', '2tone', '5tone']
const BUSY_LOCKS: readonly BusyLock[] = ['off', 'cdt', 'free']
const TX_INTERRUPTS: readonly TxInterrupt[] = ['off', 'low', 'high']

/** A tone from its type byte (0 off / 1 CTCSS / 2 DCS) + its CTCSS index and DCS raw word. */
function decodeTone(typeRaw: number, ctcssIndex: number, dcsRaw: number): Tone {
  if (typeRaw === 1) {
    const hz = ctcssIndex >= 1 && ctcssIndex <= CTCSS_TONES.length ? CTCSS_TONES[ctcssIndex - 1]! : null
    return { kind: 'ctcss', display: hz != null ? hz.toFixed(1) : 'CTCSS', ctcssIndex: ctcssIndex || null, dcsCode: null }
  }
  if (typeRaw === 2) {
    // The radio stores the DCS word in octal; its decimal label is that octal read back as decimal.
    const code = dcsRaw ? Number(dcsRaw.toString(8)) : null
    return { kind: 'dcs', display: code ? `D${String(code).padStart(3, '0')}` : 'DCS', ctcssIndex: null, dcsCode: code }
  }
  return { kind: 'off', display: 'Off', ctcssIndex: null, dcsCode: null }
}

export interface Channel {
  readonly freqMHz: number | null
  readonly txFreqMHz: number | null
  /** Absolute in-zone channel index (the step/select target); null on the compact poll form. */
  readonly position: number | null
  readonly name: string
  /** VFO vs memory. The radio names the working channel "Channel VFO A/B" while a side is in VFO
   * mode; otherwise it carries the memory channel's name. (No dedicated read-flag byte is known —
   * a future RE pass could pin one from VFO-vs-memory captures.) */
  readonly mode: ChannelMode | null
  readonly config: ChannelConfig | null
}

const VFO_NAME = /^Channel VFO [AB]$/i
const CHANNEL_TYPES: readonly ChannelType[] = ['analog', 'digital', 'a+d-tx-a', 'd+a-tx-d']
const TX_POWERS: readonly TxPower[] = ['low', 'mid', 'high', 'turbo']

/** byte 10: type (bits 0-1), TX power (2-3), bandwidth (bit 4: set=25K, clear=12.5K).
 * byte 11: RX tone type (0-1), TX tone type (2-3), reverse (4), TX-prohibit (5), talkaround (7).
 * tone values: TX CTCSS @12 / RX CTCSS @13 (index); TX DCS @14-15 / RX DCS @16-17 (LE word). */
function decodeChannelConfig(frame: Uint8Array): ChannelConfig | null {
  if (frame.length < 12) return null
  const b10 = frame[10]!
  const b11 = frame[11]!
  const type = CHANNEL_TYPES[b10 & 0x03]!
  // Analog component (FM / A+D) carries tone + squelch; digital component (DMR / A+D) carries
  // color code + slot. The full record is needed for the deeper offsets (byte 27+ / byte 34+).
  const hasAnalog = type !== 'digital'
  const hasDigital = type !== 'analog'
  const analog = hasAnalog && frame.length >= 61
  const digital = hasDigital && frame.length >= 64
  return {
    type,
    power: TX_POWERS[(b10 >> 2) & 0x03]!,
    bandwidthKHz: b10 & 0x10 ? 25 : 12.5,
    reverse: ((b11 >> 4) & 0x01) === 1,
    txProhibit: ((b11 >> 5) & 0x01) === 1,
    talkaround: ((b11 >> 7) & 0x01) === 1,
    rxTone: hasAnalog && frame.length >= 18 ? decodeTone(b11 & 0x03, frame[13]!, frame[16]! | (frame[17]! << 8)) : null,
    txTone: hasAnalog && frame.length >= 18 ? decodeTone((b11 >> 2) & 0x03, frame[12]!, frame[14]! | (frame[15]! << 8)) : null,
    squelchMode: analog ? SQUELCH_MODES[(frame[27]! >> 4) & 0x07] ?? null : null,
    optionalSignal: analog ? OPTIONAL_SIGNALS[(frame[28]! >> 4) & 0x03] ?? null : null,
    compander: analog ? ((frame[54]! >> 3) & 0x01) === 1 : null,
    scrambler: analog ? frame[60]! & 0x0f : null,
    busyLock: frame.length >= 61 ? BUSY_LOCKS[frame[28]! & 0x03] ?? null : null,
    colorCode: digital ? frame[34]! & 0x0f : null,
    timeSlot: digital ? (frame[35]! & 0x01) + 1 : null,
    txInterrupt: digital ? TX_INTERRUPTS[(frame[54]! >> 4) & 0x03] ?? null : null,
    aprsReceive: digital ? ((frame[35]! >> 5) & 0x01) === 1 : null,
    smsForbid: digital ? ((frame[63]! >> 2) & 0x01) === 1 : null,
    dataAckForbid: digital ? ((frame[63]! >> 3) & 0x01) === 1 : null,
    // DMR Mode = byte 54 bit 1 (0 = Repeater) + byte 35 bits 2-3 (slot variant when direct):
    // 0 Simplex / 1 Double Slot / 2 Double Slot(D). Matches the 2f 08 write frame (PROTOCOL RE).
    dmrMode: digital ? decodeDmrMode(frame) : null,
    contact: digital && frame.length >= 95 ? decodeContact(frame) : null,
  }
}

/** DMR Mode from byte 54 bit 1 (direct flag; 0 = Repeater) + byte 35 bits 2-3 (slot variant). */
function decodeDmrMode(frame: Uint8Array): DmrMode | null {
  if (frame.length < 55) return null
  const direct = (frame[54]! >> 1) & 0x01
  if (direct === 0) return 'repeater'
  const slot = (frame[35]! >> 2) & 0x03
  return slot === 0 ? 'simplex' : slot === 1 ? 'double-slot' : 'double-slot-d'
}

/** DMR contact (digital channel): call type @0x4a (1 group / 2 all-call / else private),
 * talkgroup BCD @75-78, contact name @79-94. */
function decodeContact(frame: Uint8Array): Contact {
  const t = frame[0x4a]
  return {
    callType: t === 1 ? 'group' : t === 2 ? 'all' : 'private',
    talkgroup: bcd(frame, 75, 4),
    name: asciiZ(frame, 79, 16),
  }
}

/** `04 2c`/`04 2d` — channel block A/B. freq @2 (BCD), name @37 (ASCII), live config @10-11.
 * Both the 72-byte compact form and the 118/121-byte full record share these offsets. */
export function decodeChannel(frame: Uint8Array): Channel {
  const name = asciiZ(frame, 37, 16)
  const mode: ChannelMode | null = VFO_NAME.test(name.trim()) ? 'vfo' : name ? 'memory' : null
  const rx = freqMHz(frame, 2)
  const position = frame.length >= 72 ? frame[71]! : null
  return { freqMHz: rx, txFreqMHz: decodeTxFreq(frame, rx), position, name, mode, config: decodeChannelConfig(frame) }
}

/** TX freq = RX + the SIGNED repeater shift. Direction = byte 10 bits 6-7 (0 simplex / 1 + / 2 −);
 * magnitude = BCD offset @6-9 (/1e5 → MHz). Out-of-range/unreadable offset → simplex (= RX). */
function decodeTxFreq(frame: Uint8Array, rxMHz: number | null): number | null {
  if (rxMHz == null || frame.length < 11) return null
  const dir = (frame[10]! >> 6) & 0x03
  if (dir === 0) return rxMHz
  const raw = bcd(frame, 6, 4)
  if (raw == null) return rxMHz
  const offset = raw / 1e5
  if (offset <= 0 || offset > 12) return rxMHz
  return Number((rxMHz + (dir === 2 ? -offset : offset)).toFixed(5))
}

/** `04 29`/`04 2a` — zone name A/B (ASCII @2). */
export function decodeZoneName(frame: Uint8Array): string {
  return asciiZ(frame, 2, 16)
}

/** `04 29`/`04 2a` — zone block. The 0-based zone index lives at byte 34 (the zone-select
 * target); null on the short form. */
export function decodeZoneNumber(frame: Uint8Array): number | null {
  return frame.length >= 35 ? frame[34]! : null
}

// NOTE: zone-block byte 35 is the zone's CURRENT/last in-zone channel position (restored on zone
// entry), NOT the channel count — corpus-falsified 2026-07-05 (it takes every value 0-14 within a
// single zone). An earlier "count = b35 + 1" reading was a coincidence of sampling while sitting
// on the last channel. The true per-zone channel count is decodeZoneChannelCount below.

/** `04 27 <zoneIndex>` reply — the zone's channel-index list: LE16 members from byte 3, terminated
 * by 0xffff. The channel COUNT is the number of members before the terminator. Reads any zone by
 * index without navigating (byte 2 of the request is the zone index). Live-verified 2026-07-05:
 * FAVORITES=15, HOTSPOT=7, etc. Returns null on a non-2c reply / short frame. */
export function decodeZoneChannelCount(frame: Uint8Array): number | null {
  if (frame.length < 5 || frame[1] !== 0x27) return null
  let n = 0
  for (let i = 3; i + 1 < frame.length - 1; i += 2) {
    if ((frame[i]! | (frame[i + 1]! << 8)) === 0xffff) break
    n += 1
  }
  return n
}

export interface Identity {
  readonly dmrId: number
  readonly callsign: string
}

/** `04 32` — radio identity: DMR id (BCD @2), callsign (ASCII @7). */
export function decodeIdentity(frame: Uint8Array): Identity {
  return { dmrId: bcd(frame, 2, 4) ?? 0, callsign: asciiZ(frame, 7, 16) }
}

export interface Smeter {
  /** RSSI of the selected side (0 idle … 4 full — the radio's own 4-bar meter, uncalibrated;
   * corpus-verified range 0-4). */
  readonly selectedRssi: number
  /** RSSI of the other side. */
  readonly otherRssi: number
  /** Squelch open (RX audio passing) on the selected side. */
  readonly selectedOpen: boolean
  /** Squelch open on the other side. */
  readonly otherOpen: boolean
  /** The radio is TRANSMITTING (its own truth — covers PTT from the radio/head too). */
  readonly transmitting: boolean
  /** A native scan is RUNNING (the radio's own truth — covers scans started on the radio's front
   * panel, and scans already running when we connect: the startup `04 5a` read carries it). */
  readonly scanning: boolean
  /** Scan parked on a channel (byte 3 bit 0x20) — spans lock + the dropout-delay DWELL. */
  readonly parked: boolean
}

// byte 7 of the 5a push is a radio-state bitfield. Live-pinned (Sitting 1, 2026-07-03): 0x86 and
// 0x87 bracket every transmission (from ~500ms after key to ~350ms after unkey); 0x89/0x8a are
// idle. The corpus also shows 0x85/0x88/0x8b only in PTT-bearing sessions but those are NOT yet
// pinned to a phase — decode conservatively: only the two proven values read as TX, unknown
// values read as idle (never a false TX indication).
const TX_STATE_VALUES: ReadonlySet<number> = new Set([0x86, 0x87])

// byte 5 of the 5a push is a per-side squelch-open bitmask, RELATIVE to the selected side (same
// framing as the RSSI bytes). Bit 1 = selected side open, bit 2 = other side open — confirmed live
// on BOTH analog and DMR. Bit 0 is a DMR-only timeslot/sync flag (NOT squelch), so mask it off.
const OPEN_SELECTED = 0x02
const OPEN_OTHER = 0x04

// byte 12 of the 5a push: NATIVE-SCAN-RUNNING flag. Corpus-pinned 2026-07-10: 0x02 for 43,396 of
// 43,412 frames inside 57 48 scan windows (the 16 stragglers are command→ack edges), 0x00 for
// 26,316 of 26,334 outside, and 0x00 across all 2,141 status frames of the eleven pre-scan-era
// captures (channel nav / PTT / DMR — no false positives). 36 of 37 start/stop transitions flip on
// the very next push after the 03 57 ack. This is how the BT-01 knows a scan is already running
// when it connects — the startup `04 5a` read carries it (@13 there).
const SCANNING = 0x02
// `5a` byte 3 bit 0x20 — scan PARKED on a channel (live-pinned 2026-07-13, locks 07:04/07:08):
// sets when the hop stops on a carrier (even ~0.5 s BEFORE the audio gate opens — the pre-open
// check), holds through the signal AND the post-signal dropout-delay window, and clears at the
// exact hop resume (measured 3.03 s / 3.08 s after gate close vs the list's configured 3.1 s).
const PARKED = 0x20

/** `5a` async push (16 bytes) — RX level + squelch state RELATIVE to the selected side. Offsets are
 * the `04 5a` read form shifted down by 1 (no `04` prefix): selected RSSI @1, other @2, open mask
 * @5, scan flag @12. The reducer maps selected/other → a/b via state.selectedSide. */
export function decodeSmeter(frame: Uint8Array): Smeter | null {
  if (frame.length < 14) return null
  const mask = frame[5]!
  return {
    selectedRssi: frame[1]!,
    otherRssi: frame[2]!,
    selectedOpen: (mask & OPEN_SELECTED) !== 0,
    otherOpen: (mask & OPEN_OTHER) !== 0,
    transmitting: TX_STATE_VALUES.has(frame[7]!),
    scanning: (frame[12]! & SCANNING) !== 0,
    parked: (frame[3]! & PARKED) !== 0,
  }
}

/** `5b <open> <ck>` async push — the AUDIO gate: decoded/squelched voice is flowing to the
 * speaker/BT path. Live-QSO-pinned 2026-07-13: on DMR it opens ~150 ms AFTER the 58/59 call
 * presentation (vocoder spin-up) and closes at end of voice — hang time keeps the slot busy for
 * another ~1.2 s (5e stays RX) until the 5c teardown, so this is audio truth, not channel-busy
 * and not squelch (per-side squelch bits ride 5a). */
export function decodeAudioGate(frame: Uint8Array): boolean {
  return (frame[1] ?? 0) !== 0
}

export interface DmrActivity {
  /** DMR link active — byte1: 1 = RX call, 2 = TX call (0 = idle → returns null). */
  readonly direction: 'rx' | 'tx'
  /** Color code (0-15), only trustworthy on a voice frame; null otherwise. */
  readonly colorCode: number | null
  /** Time slot 1 or 2 (byte12 0/1 +1), voice frame only. */
  readonly slot: number | null
  /** Caller/source DMR id (BCD @8-11), voice frame only. */
  readonly source: number | null
  /** Destination: talkgroup (group call) or target unit (private), BCD @13-16. */
  readonly dest: number | null
  /** Group vs private: a group call carries the TG in BOTH slots (src == dst); a private call is
   * unit→unit (src != dst). null until a voice frame lands. */
  readonly private: boolean | null
}

// `5e` async link-state push (18 bytes). byte1: 00 idle / 01 RX / 02 TX. CC @7, src BCD @8-11,
// slot @12, dest BCD @13-16. Group vs private falls out of src==dst (PoC 2026-06-22: group 67498
// had src==dst; PARROT private had src != dst). The `04 5e` read form is this shifted up by 1.
// Returns null when idle (byte1 == 0).
//
// IDENTITY GATING — wire-pinned 2026-07-10: identity is trusted when the frame CARRIES it (dest
// BCD decodes nonzero — a real call always has a destination). The old rule required byte 2's
// 0x40 "voice frame" bit, derived from the June corpus where identityless control frames were
// 0x21 and voice was 0x61 — but the live radio emits identity-BEARING frames with byte 2 of
// 0x20/0x22/0x24 (no 0x40) alongside 0x60/0x64, so whole calls decoded nothing when the 0x40
// variants never happened to appear (the every-other-call TS/CC/TG dropout, and the recorder
// mislabeling a DMR transmission with the selected analog channel). Zero-identity control frames
// still decode to nulls naturally (BCD 0 → null), which also keeps their byte-7 LC/reason code
// from being misread as a color code.
export function decodeDmr(frame: Uint8Array): DmrActivity | null {
  if (frame.length < 18) return null
  const status = frame[1]!
  if (status === 0) return null
  const src = bcd(frame, 8, 4)
  const dest = bcd(frame, 13, 4)
  const hasIdentity = dest != null && dest !== 0
  const cc = frame[7]!
  const slotBit = frame[12]!
  return {
    direction: status === 2 ? 'tx' : 'rx',
    colorCode: hasIdentity && cc <= 15 ? cc : null,
    slot: hasIdentity && slotBit <= 1 ? slotBit + 1 : null,
    source: hasIdentity && src ? src : null,
    dest: hasIdentity ? dest : null,
    private: hasIdentity && src ? src !== dest : null,
  }
}

export interface LastCall {
  /** Destination — talkgroup or private target id. */
  readonly dest: number | null
  /** The radio's contact-list name for the destination (e.g. "RMHAM RM WIDE"), when known. */
  readonly destName: string
  /** The talker/caller DMR id. */
  readonly callerId: number | null
  /** The radio's name for the caller (contact list / talker alias), when known. */
  readonly callerName: string
}

/** `04 59` — the radio's PERSISTED last-call record (59 B): destination BCD @3-6 + its contact
 * name @7-22, caller BCD @25-28 + caller name @29-44. Corpus-pinned 2026-07-10 (20 distinct
 * frames: TG 700 "RMHAM RM WIDE", caller 310997 "PARROT", 3223039 "JOE PRIVATE", …). Survives
 * across connects, so it enriches an ONGOING call at startup with the talker id + alias that
 * otherwise only arrive on later 58 pushes. Name fields carry stale buffer residue past the
 * NUL terminator — asciiZ's stop-at-NUL is required, not cosmetic. */
export function decodeLastCall(frame: Uint8Array): LastCall | null {
  if (frame.length < 45) return null
  return {
    dest: bcd(frame, 3, 4) || null,
    destName: asciiZ(frame, 7, 16),
    callerId: bcd(frame, 25, 4) || null,
    callerName: asciiZ(frame, 29, 16),
  }
}

/** `58` talker-info push — the caller ALIAS the radio carries for the active DMR id: byte1 context
 * (00 RX talker / 81 TX talker), DMR id BCD @6-9, 16-char ASCII alias @10-25. */
export function decodeDmrAlias(frame: Uint8Array): { id: number | null; alias: string } | null {
  if (frame.length < 26) return null
  return { id: bcd(frame, 6, 4) || null, alias: asciiZ(frame, 10, 16) }
}

/** `04 4b <idx>` scan-list directory entry: 135B populated (16-char ASCII name @15), or 18B for an
 * empty slot. Returns the list name, or null for an empty/short slot. Live-verified Sitting 2.
 *
 * ALSO decodes `04 4a` — the working channel's ASSIGNED scan-list record (same 135B layout,
 * name @17; zero/ff-filled when the channel has none). Corpus-pinned 2026-07-10: tracks the
 * working channel ("GMRS" on GMRS channels, "SHORT FAVORITES" on the ham ones), and during a
 * running scan it is the list BEING SCANNED (a panel scan runs the channel's assigned list) —
 * the BT-01 reads it at startup, which is how it names a scan already in progress. */
export function decodeScanListName(frame: Uint8Array): string | null {
  // The 04 4b directory entry mirrors the 04 4a zone-directory layout: a 16-byte ASCII list name
  // at offset 17 (then LE16 member indices from 34). Live-validated 2026-06-22 (FAVORITES decoded
  // to the exact member set the follow-up 04 2e name lookups resolved). A short frame (< 33) is a
  // defined-but-empty slot; a 0xff-filled name field is an unused slot — both → null.
  if (frame.length < 33) return null
  if (frame[17] === 0xff) return null
  const name = asciiZ(frame, 17, 16)
  return name || null
}

/** `04 27 <zone>` member list → the zone's global channel indices (LE16 from byte 3, 0xffff-
 * terminated), in in-zone scroll order (position 0..N-1). The count is `.length`. */
export function decodeZoneChannelMembers(frame: Uint8Array): number[] {
  if (frame.length < 5 || frame[1] !== 0x27) return []
  const out: number[] = []
  for (let i = 3; i + 1 < frame.length - 1; i += 2) {
    const v = frame[i]! | (frame[i + 1]! << 8)
    if (v === 0xffff) break
    out.push(v)
  }
  return out
}

/** `04 2e <hi> <lo>` channel-name-by-global-index reply (20B) → the channel name (ASCII @2-17). */
export function decodeChannelName(frame: Uint8Array): string {
  return asciiZ(frame, 2, 16)
}

/** `04 2b <idx>` zone-directory browse reply → the 32-byte ASCII zone name @offset 2, or null for
 * an empty/short slot. Live-decoded 2026-06-19 (BT-01 "Zones → Edit Chan"). */
export function decodeZoneBrowseName(frame: Uint8Array): string | null {
  if (frame.length < 4 || frame[1] !== 0x2b) return null
  // Name spans offset 2..(len-1), capped at 32 bytes; the final byte is the checksum, so exclude it
  // (a short empty-slot frame then yields no printable chars → null).
  const end = Math.min(frame.length - 1, 2 + 32)
  const name = asciiZ(frame, 2, Math.max(0, end - 2))
  return name || null
}

/** `04 05`/`04 06`/`04 09` — settings block → labelled values, via the offset map.
 * Each byte is decoded to its option label, or the raw index when no label is defined. */
export function decodeSettingsBlock(frame: Uint8Array, block: string): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const s of settingsForBlock(block)) {
    const raw = frame[s.payloadOffset]
    if (raw === undefined) continue
    out[s.name] = s.options[raw] ?? raw
  }
  return out
}

/** The radio's ACTIVE side, read from the `04 05` settings block (byte 37: 0 = A, 1 = B). This is
 * the authoritative source — the 5a smeter is reported relative to it. null on a short/odd frame
 * (leaves the prior value in place). */
export function decodeSelectedSide(frame: Uint8Array): 'a' | 'b' | null {
  if (frame.length < 38) return null
  const b = frame[37]!
  return b === 0 ? 'a' : b === 1 ? 'b' : null
}
