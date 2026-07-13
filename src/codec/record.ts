// Record codec: read/write NAMED FIELDS of raw radio records (channel block, zone block…),
// driven by data/record-maps.json — THE single source of offset knowledge, shared with the
// frame-map docs generator. This is the write-context machinery for the record-canonical state
// model: the raw record is canonical, decoded values are projections, and a mutation splices a
// known field into the bytes while every unmapped offset is preserved verbatim (proved by the
// byte-identity golden-master in test/record.test.ts). Unknown field keys are refused — we can
// only mutate what we've pinned.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export type RecordKind = 'channel' | 'zone'

interface FieldDef {
  readonly key: string
  readonly offset: number
  readonly len?: number
  readonly codec: 'u8' | 'le16' | 'bcd' | 'asciiz' | 'bits'
  readonly bits?: [number, number]
  readonly desc: string
}
interface RecordDef {
  readonly frame: string
  readonly lengths: number[]
  readonly fullFrom: number
  readonly fields: FieldDef[]
}
interface MapsFile {
  readonly records: Record<string, RecordDef>
}

const here = dirname(fileURLToPath(import.meta.url))
const MAPS = JSON.parse(readFileSync(resolve(here, '../../data/record-maps.json'), 'utf8')) as MapsFile

/** Field definitions for a record kind (also consumed reflectively by tests/docs). */
export function recordFields(kind: RecordKind): readonly FieldDef[] {
  return MAPS.records[kind]!.fields
}

function fieldDef(kind: RecordKind, key: string): FieldDef {
  const def = MAPS.records[kind]!.fields.find((f) => f.key === key)
  if (!def) throw new Error(`unknown ${kind}-record field: ${key} (only mapped fields are accessible)`)
  return def
}

function fieldEnd(def: FieldDef): number {
  return def.offset + (def.len ?? 1)
}

/** Read a named field from a raw record. Strings for asciiz, numbers otherwise (bcd fields read
 * the packed digits as a number — unit conversion is the caller's business). Returns null when
 * the record is too short to carry the field (compact forms). */
export function readField(kind: RecordKind, raw: Uint8Array, key: string): number | string | null {
  const def = fieldDef(kind, key)
  if (raw.length - 1 < fieldEnd(def)) return null // -1: never read into the trailing checksum
  switch (def.codec) {
    case 'u8':
      return raw[def.offset]!
    case 'le16':
      return raw[def.offset]! | (raw[def.offset + 1]! << 8)
    case 'bcd': {
      let v = 0
      for (let i = 0; i < def.len!; i += 1) {
        const b = raw[def.offset + i]!
        const hi = b >> 4
        const lo = b & 0x0f
        if (hi > 9 || lo > 9) return null
        v = v * 100 + hi * 10 + lo
      }
      return v
    }
    case 'asciiz': {
      // RAW fidelity: everything up to the null, INCLUDING non-printables (e.g. 0xff fill in
      // erased records) — so write-back-of-read is byte-identical. Human-facing printable
      // filtering is the projection layer's job (decode.ts asciiZ), not the record codec's.
      let s = ''
      for (let i = 0; i < def.len!; i += 1) {
        const b = raw[def.offset + i]!
        if (b === 0) break
        s += String.fromCharCode(b)
      }
      return s
    }
    case 'bits': {
      const [lo, hi] = def.bits!
      const mask = (1 << (hi - lo + 1)) - 1
      return (raw[def.offset]! >> lo) & mask
    }
  }
}

/** Return a COPY of `raw` with the named field set to `value`; every other byte (including all
 * unmapped offsets) is preserved verbatim, and the trailing additive checksum is recomputed.
 * Throws on an unknown key, a too-short record, or a value that doesn't fit the field. */
export function writeField(kind: RecordKind, raw: Uint8Array, key: string, value: number | string): Uint8Array {
  const def = fieldDef(kind, key)
  if (raw.length - 1 < fieldEnd(def)) {
    throw new Error(`${kind} record too short (${raw.length}) for field ${key} @${def.offset}`)
  }
  const out = raw.slice()
  switch (def.codec) {
    case 'u8': {
      const v = Number(value)
      if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`${key}: ${value} out of u8 range`)
      out[def.offset] = v
      break
    }
    case 'le16': {
      const v = Number(value)
      if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error(`${key}: ${value} out of le16 range`)
      out[def.offset] = v & 0xff
      out[def.offset + 1] = (v >> 8) & 0xff
      break
    }
    case 'bcd': {
      const v = Number(value)
      const max = 10 ** (def.len! * 2) - 1
      if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${key}: ${value} out of BCD range (0-${max})`)
      const digits = String(v).padStart(def.len! * 2, '0')
      for (let i = 0; i < def.len!; i += 1) {
        out[def.offset + i] = (Number(digits[i * 2]) << 4) | Number(digits[i * 2 + 1])
      }
      break
    }
    case 'asciiz': {
      const s = String(value)
      if (s.length > def.len!) throw new Error(`${key}: "${s}" longer than ${def.len} bytes`)
      // Corpus-faithful: the radio null-TERMINATES but does NOT zero the tail (records carry
      // residue from previous longer names after the null). Write chars + one terminator and
      // preserve the remaining tail bytes verbatim — mutate the minimum.
      for (let i = 0; i < s.length; i += 1) out[def.offset + i] = s.charCodeAt(i)
      if (s.length < def.len!) out[def.offset + s.length] = 0
      break
    }
    case 'bits': {
      const [lo, hi] = def.bits!
      const width = hi - lo + 1
      const max = (1 << width) - 1
      const v = Number(value)
      if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${key}: ${value} out of ${width}-bit range`)
      const mask = max << lo
      out[def.offset] = (out[def.offset]! & ~mask) | (v << lo)
      break
    }
  }
  // Our stored records are inbound frames — keep the trailing additive checksum consistent.
  let sum = 0
  for (let i = 0; i < out.length - 1; i += 1) sum = (sum + out[i]!) & 0xff
  out[out.length - 1] = sum
  return out
}

// ── hex ↔ bytes (the raw record travels in RadioState as a hex string — JSON-safe) ──
export function bytesToHexStr(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
export function hexStrToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('invalid hex string')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
