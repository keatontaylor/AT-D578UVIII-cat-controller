// Capture loader for replay tests. Normalizes the two on-disk NDJSON schemas:
//   wire.ndjson : { dir: "rx"|"tx", hex, ... }
//   relay logs  : { dir: "R>H"|"H>R"|"LOCAL", hex, ... }
// rx = radio→host (what the inbound framer consumes); tx = host→radio.

import { readFileSync } from 'node:fs'

export type Direction = 'rx' | 'tx' | 'other'

export interface CaptureFrame {
  readonly dir: Direction
  readonly hex: string
  readonly bytes: Uint8Array
}

const RX = new Set(['rx', 'R>H'])
const TX = new Set(['tx', 'H>R'])

export function hexToBytes(hex: string): Uint8Array {
  const parts = hex.trim().split(/\s+/).filter(Boolean)
  const out = new Uint8Array(parts.length)
  for (let i = 0; i < parts.length; i += 1) out[i] = parseInt(parts[i]!, 16)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join(' ')
}

export function loadCapture(path: string): CaptureFrame[] {
  const out: CaptureFrame[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: { dir?: string; hex?: string }
    try {
      rec = JSON.parse(trimmed) as { dir?: string; hex?: string }
    } catch {
      continue
    }
    if (!rec.hex || !rec.dir) continue
    const dir: Direction = RX.has(rec.dir) ? 'rx' : TX.has(rec.dir) ? 'tx' : 'other'
    out.push({ dir, hex: rec.hex, bytes: hexToBytes(rec.hex) })
  }
  return out
}

export function concatAll(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}
