// Per-channel setting registry (ARCHITECTURE codec layer). Ported in full from the PoC's
// CHANNEL_SETTINGS table — the BT-01 channel editor's dialect. Unlike the 08 menu settings, these
// actuate the SELECTED SIDE's working channel via the 2f opcode family: `2f <subcmd> <value>` + the
// same 20-byte menu tail, acked by `03 2f`. Confirmed from BT-01 channel-edit relay captures
// (2026-06-20). DMR Mode (2f 08) is structured (value in bytes 3-4 over a fixed template).
//
// Each entry maps to a decoded ChannelConfig field so the editor shows the live value and offers
// the option list; `read` returns the current option LABEL (or null when the field doesn't apply
// to this channel's mode, which also hides it). Pure; no I/O.

import { WRITE_TAIL } from './write-tail'
import type { ChannelConfig } from './decode'

export type ChannelMode = 'analog' | 'digital'

export interface ChannelSettingDef {
  /** Stable key (also the ChannelConfig field where they align). */
  readonly key: string
  readonly label: string
  readonly description: string
  /** The `2f <write>` sub-opcode. */
  readonly write: number
  /** Display labels; the index is the raw value written. */
  readonly options: readonly string[]
  /** Restrict to analog- or digital-only channels; omit = both. */
  readonly modes?: ChannelMode
  /** Current option label from a decoded ChannelConfig, or null when not applicable. */
  readonly read: (c: ChannelConfig) => string | null
}

const onOff = (v: boolean | null): string | null => (v == null ? null : v ? 'On' : 'Off')

const TYPE_L = { analog: 'Analog', digital: 'Digital', 'a+d-tx-a': 'A+D TX-A', 'd+a-tx-d': 'D+A TX-D' } as const
const POWER_L = { low: 'Low', mid: 'Medium', high: 'High', turbo: 'Turbo' } as const
const SQUELCH_L = { sq: 'SQ', cdt: 'CDT', tone: 'TONE', 'c&t': 'C&T', 'c|t': 'C|T' } as const
const OPT_L = { off: 'Off', dtmf: 'DTMF', '2tone': '2TONE', '5tone': '5TONE' } as const
const BUSY_L = { off: 'Off', cdt: 'Different CDT', free: 'Channel Free' } as const
const TXINT_L = { off: 'Off', low: 'Low Priority', high: 'High Priority' } as const
const DMR_L = { simplex: 'Simplex', repeater: 'Repeater', 'double-slot': 'Double Slot', 'double-slot-d': 'Double Slot (D)' } as const

const SCRAMBLER_OPTS = ['Off', '3.3k', '3.2k', '3.1k', '3.0k', '2.9k', '2.8k', '2.7k', '2.6k', '2.5k', '4.095k', '3.458k']

export const CHANNEL_SETTINGS: readonly ChannelSettingDef[] = [
  { key: 'channelType', label: 'Channel Type', write: 0x01, options: ['Analog', 'Digital', 'A+D TX-A', 'D+A TX-D'],
    description: 'Modulation for this channel: analog FM, digital DMR, or a mixed A+D combination.',
    read: (c) => TYPE_L[c.type] },
  { key: 'txPower', label: 'TX Power', write: 0x18, options: ['Low', 'Medium', 'High', 'Turbo'],
    description: 'Transmit power level for this channel.',
    read: (c) => POWER_L[c.power] },
  { key: 'bandwidth', label: 'Bandwidth', write: 0x1c, options: ['Narrow', 'Wide'], modes: 'analog',
    description: 'Channel spacing: Narrow (12.5 kHz) or Wide (25 kHz).',
    read: (c) => (c.bandwidthKHz === 25 ? 'Wide' : 'Narrow') },
  { key: 'squelchMode', label: 'Squelch Mode', write: 0x1b, options: ['SQ', 'CDT', 'TONE', 'C&T', 'C|T'], modes: 'analog',
    description: 'What opens squelch: carrier (SQ), DCS (CDT), CTCSS (TONE), or their and/or combinations.',
    read: (c) => (c.squelchMode ? SQUELCH_L[c.squelchMode] : null) },
  { key: 'optionalSignal', label: 'Optional Signal', write: 0x09, options: ['Off', 'DTMF', '2TONE', '5TONE'], modes: 'analog',
    description: 'Selective-calling signalling used on this analog channel.',
    read: (c) => (c.optionalSignal ? OPT_L[c.optionalSignal] : null) },
  { key: 'colorCode', label: 'Color Code', write: 0x21, options: Array.from({ length: 16 }, (_, i) => String(i)), modes: 'digital',
    description: 'DMR color code (0-15) — must match the repeater/talkgroup to access it.',
    read: (c) => (c.colorCode == null ? null : String(c.colorCode)) },
  { key: 'timeSlot', label: 'Time Slot', write: 0x15, options: ['TS1', 'TS2'], modes: 'digital',
    description: 'DMR TDMA timeslot used for transmit.',
    read: (c) => (c.timeSlot == null ? null : c.timeSlot === 1 ? 'TS1' : 'TS2') },
  { key: 'txInterrupt', label: 'TX Interrupt', write: 0x0f, options: ['Off', 'Low Priority', 'High Priority'], modes: 'digital',
    description: 'Whether this channel can interrupt an ongoing DMR transmission, and at what priority.',
    read: (c) => (c.txInterrupt ? TXINT_L[c.txInterrupt] : null) },
  { key: 'dmrMode', label: 'DMR Mode', write: 0x08, options: ['Simplex', 'Repeater', 'Double Slot', 'Double Slot (D)'], modes: 'digital',
    description: 'DMR channel topology: direct simplex, repeater, or dual-slot direct modes.',
    read: (c) => (c.dmrMode ? DMR_L[c.dmrMode] : null) },
  { key: 'busyLock', label: 'Busy Lock', write: 0x1f, options: ['Off', 'Different CDT', 'Channel Free'],
    description: 'Inhibit transmit when the channel is busy (or busy with a different tone/code).',
    read: (c) => (c.busyLock ? BUSY_L[c.busyLock] : null) },
  { key: 'scrambler', label: 'Scrambler', write: 0x11, options: SCRAMBLER_OPTS, modes: 'analog',
    description: 'Analog voice scrambler frequency (off or one of the inversion points).',
    read: (c) => (c.scrambler == null ? null : SCRAMBLER_OPTS[c.scrambler] ?? String(c.scrambler)) },
  { key: 'reverse', label: 'Reverse', write: 0x1d, options: ['Off', 'On'], modes: 'analog',
    description: 'Swap RX and TX frequencies (transmit on the repeater output).',
    read: (c) => onOff(c.reverse) },
  { key: 'compander', label: 'Compander', write: 0x10, options: ['Off', 'On'], modes: 'analog',
    description: 'Analog audio compander (companding) for improved signal-to-noise.',
    read: (c) => onOff(c.compander) },
  { key: 'talkaround', label: 'Talkaround', write: 0x1e, options: ['Off', 'On'],
    description: 'Transmit on the RX frequency to talk directly, bypassing the repeater.',
    read: (c) => onOff(c.talkaround) },
  { key: 'txProhibit', label: 'TX Prohibit', write: 0x20, options: ['Off', 'On'],
    description: 'Block transmit on this channel (receive only).',
    read: (c) => onOff(c.txProhibit) },
  { key: 'smsForbid', label: 'SMS Forbid', write: 0x0d, options: ['Off', 'On'], modes: 'digital',
    description: 'Disallow DMR text messaging on this channel.',
    read: (c) => onOff(c.smsForbid) },
  { key: 'dataAckForbid', label: 'DataAck Forbid', write: 0x0c, options: ['Off', 'On'], modes: 'digital',
    description: 'Disable DMR data-acknowledgement responses on this channel.',
    read: (c) => onOff(c.dataAckForbid) },
  { key: 'aprsReceive', label: 'APRS Receive', write: 0x0b, options: ['Off', 'On'], modes: 'digital',
    description: 'Receive digital APRS position reports on this channel.',
    read: (c) => onOff(c.aprsReceive) },
]

export const CHANNEL_SETTINGS_BY_KEY: Readonly<Record<string, ChannelSettingDef>> = Object.fromEntries(
  CHANNEL_SETTINGS.map((s) => [s.key, s]),
)

// DMR Mode (2f 08) is structured — the option is encoded in bytes 3-4 over a fixed template, not as
// a plain <subcmd> <value>. Captured (b3,b4): Simplex (1,0) · Repeater (0,0) · Double Slot (1,1) ·
// Double Slot(D) (1,2). 2026-06-20 BT-01 relay.
const DMR_MODE_BYTES: Record<number, [number, number]> = { 0: [1, 0], 1: [0, 0], 2: [1, 1], 3: [1, 2] }
function dmrModeFrame(index: number): Uint8Array {
  const [b3, b4] = DMR_MODE_BYTES[index] ?? [0, 0]
  return Uint8Array.of(0x2f, 0x08, 0x00, b3, b4, 0x00, 0x00, 0x24, 0x00, 0x00, 0x00, 0x05, 0x05, 0x05, 0x05, 0x06, 0x06, 0x06, 0x06, 0x07, 0x07, 0x07, 0x07)
}

/** Build the write frame for a channel setting. `value` is an option label or a raw 0-based index.
 * Throws on an unknown key/option. Returns the exact bytes to put on the wire (acked `03 2f`). */
export function channelSettingWrite(key: string, value: string | number): Uint8Array {
  const def = CHANNEL_SETTINGS_BY_KEY[key]
  if (!def) throw new Error(`unknown channel setting: ${key}`)
  const index = typeof value === 'number' ? value : def.options.indexOf(value)
  if (index < 0 || index >= def.options.length) throw new Error(`unknown option "${value}" for ${key}`)
  if (key === 'dmrMode') return dmrModeFrame(index)
  const frame = new Uint8Array(3 + WRITE_TAIL.length)
  frame[0] = 0x2f
  frame[1] = def.write & 0xff
  frame[2] = index & 0xff
  frame.set(WRITE_TAIL, 3)
  return frame
}

/** The subset of settings applicable to a channel of the given decoded type (mode filter). */
export function channelSettingsForType(type: ChannelConfig['type']): readonly ChannelSettingDef[] {
  const hasAnalog = type !== 'digital'
  const hasDigital = type !== 'analog'
  return CHANNEL_SETTINGS.filter((s) =>
    s.modes === 'analog' ? hasAnalog : s.modes === 'digital' ? hasDigital : true,
  )
}
