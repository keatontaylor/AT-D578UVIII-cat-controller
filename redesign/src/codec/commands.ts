// Command encoders: build the exact outbound bytes (ARCHITECTURE codec layer, encode side).
// Outbound commands carry NO checksum — they are fixed-format, parsed by opcode + length
// (the additive checksum is an RX-only concern). Pure; no I/O.

import { settingByName } from './settings-table'
export { WRITE_TAIL } from './write-tail'
import { WRITE_TAIL } from './write-tail'

function ascii(prefix: number, text: string): Uint8Array {
  const body = Buffer.from(text, 'ascii')
  const f = new Uint8Array(1 + body.length)
  f[0] = prefix
  f.set(body, 1)
  return f
}

/** Wake / keepalive (`61`). Sent a few times to rouse the radio's SPP session before the
 * handshake; the radio acks it with `03 61 00 00`. */
export function wake(): Uint8Array {
  return Uint8Array.of(0x61)
}

/** Handshake: enter COM mode (`01` + "D578UV COM MODE"). */
export function comMode(): Uint8Array {
  return ascii(0x01, 'D578UV COM MODE')
}

/** Handshake terminator that starts streaming (`64` + "COM CHECK END"). */
export function comCheckEnd(): Uint8Array {
  return ascii(0x64, 'COM CHECK END')
}

/** Register read request: `04 <reg> <mode> 00 00 00`. */
export function readRegister(reg: number, mode = 0x00): Uint8Array {
  return Uint8Array.of(0x04, reg & 0xff, mode & 0xff, 0x00, 0x00, 0x00)
}

/** Read a zone's channel-index list (`04 27 <zoneIndex> <page> 00 00`) — byte 2 is the 0-based
 * zone index, so this reads ANY zone's members without navigating to it. The reply's member count
 * is that zone's channel count (see decodeZoneChannelCount). Page 0 covers ≤50 channels. */
export function readZoneChannels(zoneIndex: number, page = 0): Uint8Array {
  return Uint8Array.of(0x04, 0x27, zoneIndex & 0xff, page & 0xff, 0x00, 0x00)
}

/** Read a zone's NAME by 0-based index (`04 2b <idx> 00 02 00`) → 32-byte ASCII name reply. This
 * is the zone directory; walking it 0..N enumerates every zone without navigating (no 08 39). */
export function readZoneName(index: number): Uint8Array {
  return Uint8Array.of(0x04, 0x2b, index & 0xff, 0x00, 0x02, 0x00)
}

const PTT_LEN = 23

function pttFrame(keyState: number): Uint8Array {
  const f = new Uint8Array(PTT_LEN) // 56 <keyState> 00 01 then zeros
  f[0] = 0x56
  f[1] = keyState
  f[2] = 0x00
  f[3] = 0x01
  return f
}

/** Volume knob (SELECTED side) — `08 4a <level>` + a constant tail, byte-exact from a BT-01
 * relay capture (2026-07-12, volume knob turned on the head): each detent sends the absolute
 * level. Per-side by convention: the BT-01 selects the side first, then adjusts. The captured
 * session spans levels 0x05–0x0d; the encoder allows 0–31 (the radio clamps its own ceiling). */
const VOLUME_TAIL = [
  0x88, 0x1f, 0x00, 0x20, 0x71, 0x02, 0x00, 0x08, 0x51, 0x06, 0x00, 0x08, 0x45, 0x04, 0x00, 0x08,
  0x4d, 0x06, 0x00, 0x08,
] as const

export const VOLUME_MAX = 31

export function volumeWrite(level: number): Uint8Array {
  if (!Number.isInteger(level) || level < 0 || level > VOLUME_MAX) {
    throw new Error(`volume level must be an integer 0..${VOLUME_MAX} (got ${level})`)
  }
  return Uint8Array.from([0x08, 0x4a, level, ...VOLUME_TAIL])
}

/** PTT key-down (`56 01 00 01 …`). */
export function pttKey(): Uint8Array {
  return pttFrame(0x01)
}

/** PTT key-up / unkey (`56 00 00 01 …`). */
export function pttUnkey(): Uint8Array {
  return pttFrame(0x00)
}

/** Manual-dial DMR PTT (`56 <key> 00 <side> <setup> <callClass> 00 <target BE24> …`). The next PTT
 * calls a dialed target instead of the channel's programmed contact. Byte-validated against BT-01
 * relay captures (2026-06-18): `56 01 00 00 06 01 00 00 00 7b` = key side-A manual GROUP TG 123.
 *   frame[3] side (0=A/1=B); frame[4] 0x06 manual-dial setup on key / 0x00 on release;
 *   frame[5] call class (group 0x01 / private 0x00); frame[7..9] target as 24-bit BIG-ENDIAN. */
export function manualDialPtt(on: boolean, side: 'a' | 'b', target: number, callType: 'group' | 'private'): Uint8Array {
  if (!Number.isInteger(target) || target <= 0 || target > 0xffffff) {
    throw new Error(`manual-dial target ${target} out of 24-bit range`)
  }
  const f = new Uint8Array(PTT_LEN)
  f[0] = 0x56
  f[1] = on ? 0x01 : 0x00
  f[2] = 0x00
  f[3] = side === 'b' ? 0x01 : 0x00
  f[4] = on ? 0x06 : 0x00
  f[5] = callType === 'group' ? 0x01 : 0x00
  f[7] = (target >> 16) & 0xff
  f[8] = (target >> 8) & 0xff
  f[9] = target & 0xff
  return f
}

/** A menu write of the `08` family: `08 <op> <value>` + the 20-byte context tail. Side-select
 * (op 0x19), zone-select (op 0x39) and every settings write share this envelope. */
export function menuWrite(op: number, value: number): Uint8Array {
  const frame = new Uint8Array(3 + WRITE_TAIL.length)
  frame[0] = 0x08
  frame[1] = op & 0xff
  frame[2] = value & 0xff
  frame.set(WRITE_TAIL, 3)
  return frame
}

/** Build a menu setting write. `value` may be an option label or a raw 0-based index.
 * Throws on an unknown setting or unknown option. */
export function settingWrite(name: string, value: string | number): Uint8Array {
  const def = settingByName(name)
  if (!def) throw new Error(`unknown setting: ${name}`)
  const index = typeof value === 'number' ? value : def.options.indexOf(value)
  if (index < 0) throw new Error(`unknown option "${value}" for ${name}`)
  if (index > 0xff) throw new Error(`option index out of range for ${name}: ${index}`)
  return menuWrite(def.op, index)
}

/** Select side A/B as the radio's active side (`08 19 <00|01>`). Acked `03 08`. */
export function selectSide(side: 'a' | 'b'): Uint8Array {
  return menuWrite(0x19, side === 'b' ? 1 : 0)
}

/** Select a zone by 0-based index on the selected side (`08 39 <idx>`). Acked `03 08`. */
export function zoneSelect(index: number): Uint8Array {
  return menuWrite(0x39, Math.max(0, index))
}

/** Step/select an in-zone channel on a side: `04 2c/2d 01 55 <target> <dir>` (dir 1 up / 0 down).
 * `target` is the absolute in-zone index; 0xf9 = the radio's "wrap to last channel" sentinel.
 * The radio answers with the new channel block, which the reducer applies. */
export function channelSelect(side: 'a' | 'b', target: number, dir: 1 | -1): Uint8Array {
  return Uint8Array.of(0x04, side === 'b' ? 0x2d : 0x2c, 0x01, 0x55, target & 0xff, dir < 0 ? 0x00 : 0x01)
}

// ── Working-frequency writes (2f 03 RX / 2f 04 TX) ────────────────────────────
// Both write the SELECTED side's working channel, acked `03 2f` like the rest of the 2f family.

// RX-frequency write. Sitting-2 (2026-07-03) PROVED the 16-byte "tail" is NOT constant: it is a
// byte-exact ECHO of the working channel's own record — `2f 03 00 <new BCD4>` + block[6:22]
// (TX freq, byte-10 type/power/bw flags, tone region, …). The frame is literally the live
// channel block bytes [2:22] with [2:6] replaced by the new RX frequency. So we MUST rebuild it
// from the current record, not a captured constant — a stale tail would overwrite the channel's
// TX freq + type/power/bandwidth (codeplug corruption). The old hardcoded constant happened to
// match only the one June channel it was captured from.
const RX_FREQ_MIN_HZ = 100_000
const RX_FREQ_MAX_HZ = 999_999_990 // 8 BCD digits of Hz/10
/** Byte range of the working-channel record that the RX-freq write echoes after the new BCD. */
const RX_ECHO_START = 6
const RX_ECHO_END = 22

// TX-frequency write tail. UNLIKE RX, the value is a big-endian uint32 of Hz/10. Byte format
// decoded from BT-01 relay captures (2026-06-20); validated live via the PoC's TX-frequency set.
const TX_FREQ_TAIL = Uint8Array.from(Buffer.from('00000000050505059f80030800000000', 'hex'))
const TX_FREQ_MIN_HZ = 30_000
const TX_FREQ_MAX_HZ = 470_000_000

/** 4 BCD bytes (MSB first) of Hz/10 — 145.31 MHz → `14 53 10 00`. */
function bcd4FromHz(hz: number): Uint8Array {
  const units = Math.round(hz / 10)
  const digits = String(units).padStart(8, '0')
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i += 1) out[i] = (Number(digits[i * 2]) << 4) | Number(digits[i * 2 + 1])
  return out
}

function freqFrame(sub: number, value: Uint8Array, tail: Uint8Array): Uint8Array {
  const frame = new Uint8Array(3 + value.length + tail.length)
  frame[0] = 0x2f
  frame[1] = sub
  frame[2] = 0x00
  frame.set(value, 3)
  frame.set(tail, 3 + value.length)
  return frame
}

/** RX-frequency write (`2f 03 00 <BCD4 Hz/10>` + the live record's bytes [6:22]) — echo-back,
 * Sitting-2-pinned. `contextBlock` is the side's current raw `04 2c/2d` channel record; we splice
 * the new frequency in and echo the rest UNCHANGED so nothing else in the channel is disturbed.
 * Throws (before any state change) on an out-of-range frequency or a too-short/absent record —
 * we refuse to write rather than send a stale tail that would corrupt TX freq + flags. */
export function rxFrequencyWrite(hz: number, contextBlock: Uint8Array): Uint8Array {
  const f = Math.round(hz)
  if (!Number.isFinite(f) || f < RX_FREQ_MIN_HZ || f > RX_FREQ_MAX_HZ) {
    throw new Error(`RX frequency ${hz} Hz out of range (${RX_FREQ_MIN_HZ}–${RX_FREQ_MAX_HZ})`)
  }
  if (contextBlock.length < RX_ECHO_END) {
    throw new Error('RX frequency write needs the working-channel record (echo-back tail); read the channel first')
  }
  return freqFrame(0x03, bcd4FromHz(f), contextBlock.subarray(RX_ECHO_START, RX_ECHO_END))
}

/** TX-frequency write (`2f 04 00 <BE32 Hz/10>` + tail) — live-validated (via the PoC).
 * Same rounding/validation contract as rxFrequencyWrite. */
export function txFrequencyWrite(hz: number): Uint8Array {
  const f = Math.round(hz)
  if (!Number.isFinite(f) || f < TX_FREQ_MIN_HZ || f > TX_FREQ_MAX_HZ) {
    throw new Error(`TX frequency ${hz} Hz out of range (${TX_FREQ_MIN_HZ}–${TX_FREQ_MAX_HZ})`)
  }
  const units = Math.round(f / 10)
  const be = new Uint8Array(4)
  be[0] = (units >>> 24) & 0xff
  be[1] = (units >>> 16) & 0xff
  be[2] = (units >>> 8) & 0xff
  be[3] = units & 0xff
  return freqFrame(0x04, be, TX_FREQ_TAIL)
}

// The fixed context tail every `57 <sub> <val>` write carries (byte-identical across captures —
// VFO/memory 57 3d and scan start/stop 57 48 both use it). Frame = `57 <sub> <val>` + this tail.
const WRITE_TAIL_57 = Uint8Array.from(
  Buffer.from(
    '0000881f00207102000851060008450400084d06000859030008e10c000800000000000000000000000000000000870b00080d04000800000000d5090008f90b00088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b020008',
    'hex',
  ),
)

/** A `57 <sub> <val>` feature write on the selected side, acked `03 57 <sub>`. */
function write57(sub: number, val: number): Uint8Array {
  const frame = new Uint8Array(3 + WRITE_TAIL_57.length)
  frame[0] = 0x57
  frame[1] = sub & 0xff
  frame[2] = val & 0xff
  frame.set(WRITE_TAIL_57, 3)
  return frame
}

/** VFO/memory-mode write on the selected side (`57 3d <01 vfo|00 mem>`). Acked `03 57 3d`. */
export function vfoMemoryMode(vfo: boolean): Uint8Array {
  return write57(0x3d, vfo ? 0x01 : 0x00)
}

/** Start (`57 48 01`) / stop (`57 48 00`) native scan on the selected side. Acked `03 57 48`.
 * Live-validated Sitting 2 (2026-07-03). */
export function scanStartStop(on: boolean): Uint8Array {
  return write57(0x48, on ? 0x01 : 0x00)
}

/** Select the active scan list by index (`2f 2b <idx>` + menu tail). Acked `03 2f`. Only needed
 * to CHANGE list; starting on the current list needs just scanStartStop. Live-validated Sitting 2. */
export function scanSelect(listIndex: number): Uint8Array {
  const frame = new Uint8Array(3 + WRITE_TAIL.length)
  frame[0] = 0x2f
  frame[1] = 0x2b
  frame[2] = listIndex & 0xff
  frame.set(WRITE_TAIL, 3)
  return frame
}

/** Read a scan-list directory entry (`04 4b <idx> 02 03 00`). Reply: 135B populated / 18B empty. */
export function readScanList(index: number): Uint8Array {
  return Uint8Array.of(0x04, 0x4b, index & 0xff, 0x02, 0x03, 0x00)
}

/** Read a channel name by GLOBAL channel index (`04 2e <hi> <lo> 04 00`) → 20-byte name reply.
 * The global index is what the 04 27 zone member list stores. */
export function readChannelName(globalIndex: number): Uint8Array {
  return Uint8Array.of(0x04, 0x2e, (globalIndex >> 8) & 0xff, globalIndex & 0xff, 0x04, 0x00)
}
