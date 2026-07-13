// RX/TX tone (CTCSS/DCS) write frames for the working channel (2f family). Ported from the PoC:
//   RX tone (RCDT) = 2f 16 · TX tone (TCDT) = 2f 02
// over the structured template `2f <sub> <type> <b3> <b4> 00 00 <b7> 00 00 00 05*4 06*4 07*4`:
//   type 0 Off / 1 CTCSS / 2 DCS-normal / 3 DCS-inverted; b7 = 0x02 only for Off.
//   CTCSS: b3 = 1-based CTCSS index. DCS: b3:b4 = 16-bit of the code read as octal.
// CTCSS + DCS-normal are byte-exact from BT-01 relay captures (2026-06-20); DCS-inverted /
// codes > 0o377 follow the same encoding (pending more captures). Acked `03 2f`. Pure; no I/O.

import { CTCSS_TONES, DCS_CODES } from './tone-tables'

export type ToneField = 'rx' | 'tx'
export type ToneType = 'off' | 'ctc' | 'dcs'

const SUBCMD: Record<ToneField, number> = { rx: 0x16, tx: 0x02 }

function toneFrameRaw(subcmd: number, type: number, b3: number, b4: number): Uint8Array {
  const b7 = type === 0 ? 0x02 : 0x00
  return Uint8Array.of(0x2f, subcmd & 0xff, type & 0xff, b3 & 0xff, b4 & 0xff, 0x00, 0x00, b7, 0x00, 0x00, 0x00, 0x05, 0x05, 0x05, 0x05, 0x06, 0x06, 0x06, 0x06, 0x07, 0x07, 0x07, 0x07)
}

/** Build the tone write for a side's working channel. `value` is the 1-based CTCSS index (ctc) or
 * the DCS decimal code (dcs); ignored for off. Throws on an out-of-range index/code. */
export function channelToneWrite(field: ToneField, type: ToneType, value = 0, inverted = false): Uint8Array {
  const sub = SUBCMD[field]
  if (type === 'off') return toneFrameRaw(sub, 0, 0, 0)
  if (type === 'ctc') {
    const idx = Number(value) | 0
    if (idx < 1 || idx > CTCSS_TONES.length) throw new Error(`invalid CTCSS index ${value}`)
    return toneFrameRaw(sub, 1, idx, 0)
  }
  const code = Number(value) | 0
  if (!DCS_CODES.includes(code)) throw new Error(`invalid DCS code ${value}`)
  const raw = parseInt(String(code), 8) // the label is octal; the radio stores that value
  return toneFrameRaw(sub, inverted ? 3 : 2, (raw >> 8) & 0xff, raw & 0xff)
}

/** Badge-friendly display for a tone selection (matches the decoded Tone.display). */
export function toneLabel(type: ToneType, value = 0): string {
  if (type === 'off') return 'Off'
  if (type === 'ctc') {
    const hz = CTCSS_TONES[value - 1]
    return hz != null ? hz.toFixed(1) : String(value)
  }
  return `D${String(value).padStart(3, '0')}`
}
