// Length-by-type table (LINK_PROTOCOL §2). Inbound frames carry no length field, so the
// framer resolves each frame's length from its TYPE: head byte for status/ack pushes, or
// (0x04 + register) for register reads. Generated from the capture corpus by
// redesign/tools/gen-frame-lengths.mjs — this module is just the typed loader + lookups.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

interface RawEntry {
  lengths: number[]
  variable: boolean
  primaryLength: number | null
  distribution: Record<string, number>
  validSamples: number
  badChecksum: number
}
interface RawTable {
  fixedByHead: Record<string, RawEntry>
  reads04: Record<string, RawEntry>
}

const here = dirname(fileURLToPath(import.meta.url))
const TABLE_PATH = resolve(here, '../../data/frame-lengths.json')
const table = JSON.parse(readFileSync(TABLE_PATH, 'utf8')) as RawTable

/** A resolved frame length, or `'variable'` for register reads whose length-set is framed by
 * checksum + next-head rather than a single fixed length). */
export type FrameLength = number | 'variable'

/** The register-read head byte. */
export const READ_HEAD = 0x04

export const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

const headEntry = (head: number): RawEntry | undefined => table.fixedByHead[hex2(head)]
const regEntry = (reg: number): RawEntry | undefined => table.reads04[hex2(reg)]

/** Length for a status/ack push head, `'variable'`, or undefined if the type is unknown
 * (never seen in the corpus → a framing desync, not a valid frame). */
export function lengthForHead(head: number): FrameLength | undefined {
  const e = headEntry(head)
  if (!e) return undefined
  return e.variable ? 'variable' : (e.primaryLength ?? undefined)
}

/** Length for an `04 <reg>` read, `'variable'` for known multi-length reads, or undefined if unknown. */
export function lengthForRead(reg: number): FrameLength | undefined {
  const e = regEntry(reg)
  if (!e) return undefined
  return e.variable ? 'variable' : (e.primaryLength ?? undefined)
}

/** Candidate lengths (ascending) for a variable register — the small length-set the
 * framer disambiguates by checksum + next-head. */
export function candidateLengths(reg: number): number[] {
  const e = regEntry(reg)
  return e ? [...e.lengths].sort((a, b) => a - b) : []
}

/** Candidate lengths (ascending) for a variable status-push HEAD (e.g. the sub-typed `5f`:
 * `5f 33 <ck>` = 3 bytes, `5f 34 02 00 <ck>` = 5). Disambiguated like variable registers. */
export function candidateHeadLengths(head: number): number[] {
  const e = headEntry(head)
  return e ? [...e.lengths].sort((a, b) => a - b) : []
}

/** The set of byte values that can legitimately begin an inbound frame — used to confirm a
 * variable-length boundary (the byte after a candidate frame should look like a new head). */
export const inboundHeads: ReadonlySet<number> = new Set<number>([
  READ_HEAD,
  ...Object.keys(table.fixedByHead).map((h) => parseInt(h, 16)),
])

export function defaultPlausibleHead(b: number): boolean {
  return inboundHeads.has(b)
}
