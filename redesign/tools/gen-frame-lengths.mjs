#!/usr/bin/env node
// Generate the canonical frame-length table from the capture corpus.
//
// Reads RX frames from NDJSON wire logs, checksum-validates each, and aggregates
// the observed length(s) per frame TYPE — head byte for status/ack pushes,
// (0x04 + register byte) for register reads. Emits a data file the codec imports
// for deterministic framing (LINK_PROTOCOL §2): a fixed register read is framed by
// its known length; a `variable` register (the browse family) carries a small
// length-set and is framed by the checksum + next-head rule instead.
//
// The table is structural only (opcodes + lengths) — no payload content — so it is
// safe to check in even though the source captures are personal/gitignored.
//
// Usage:  node gen-frame-lengths.mjs [capture.ndjson ...]
//   default input: <repo>/captures/wire.ndjson

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const rel = p => p.replace(repoRoot + '/', '')
const inputs = process.argv.slice(2).map(p => resolve(p))
if (inputs.length === 0) inputs.push(resolve(repoRoot, 'captures/wire.ndjson'))
const OUT = resolve(here, '../data/frame-lengths.json')

// 8-bit additive checksum: last byte == sum of all prior bytes, mod 256.
function checksumOk(bytes) {
  if (bytes.length < 2) return false
  let sum = 0
  for (let i = 0; i < bytes.length - 1; i += 1) sum = (sum + bytes[i]) & 0xff
  return sum === bytes[bytes.length - 1]
}

const fixedByHead = {} // head(hex) -> { dist:{len:count}, samples, badChecksum }
const reads04 = {}     // reg(hex)  -> same
let lines = 0, rxFrames = 0, badChecksum = 0

const bucket = (map, key) => (map[key] ??= { dist: {}, samples: 0, badChecksum: 0 })

for (const file of inputs) {
  let text
  try { text = readFileSync(file, 'utf8') }
  catch (e) { console.error(`skip ${rel(file)}: ${e.message}`); continue }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    lines += 1
    if (rec.dir !== 'rx') continue // framing is an RX concern; we generate our own TX
    const hex = (rec.hex || '').trim()
    if (!hex) continue
    const bytes = hex.split(/\s+/).map(h => parseInt(h, 16))
    if (bytes.length < 2 || bytes.some(Number.isNaN)) continue
    rxFrames += 1
    const ok = checksumOk(bytes)
    if (!ok) badChecksum += 1
    const b = bytes[0] === 0x04
      ? bucket(reads04, bytes[1].toString(16).padStart(2, '0'))
      : bucket(fixedByHead, bytes[0].toString(16).padStart(2, '0'))
    b.samples += 1
    if (!ok) { b.badChecksum += 1; continue } // never let a mis-framed length into the table
    b.dist[bytes.length] = (b.dist[bytes.length] || 0) + 1
  }
}

// A length counts as "real" only with >=2 samples — a lone occurrence is a mis-frame.
function finalize(map) {
  const out = {}
  for (const key of Object.keys(map).sort()) {
    const e = map[key]
    const byCount = Object.entries(e.dist).map(([l, c]) => [Number(l), c]).sort((a, b) => b[1] - a[1])
    const validSamples = byCount.reduce((s, [, c]) => s + c, 0)
    const significant = byCount.filter(([, c]) => c >= 2).map(([l]) => l).sort((a, b) => a - b)
    const lengths = significant.length ? significant : byCount.map(([l]) => l).sort((a, b) => a - b)
    out[key] = {
      lengths,
      variable: lengths.length > 1,
      primaryLength: byCount[0]?.[0] ?? null,
      distribution: Object.fromEntries(byCount.sort((a, b) => a[0] - b[0])),
      validSamples,
      badChecksum: e.badChecksum,
    }
  }
  return out
}

const result = {
  generatedAt: new Date().toISOString(),
  generatedFrom: inputs.map(rel),
  note: 'Per-frame-TYPE length table from the capture corpus (RX frames, checksum-validated). '
    + 'fixedByHead = status/ack push head byte → length. reads04 = 0x04 register read → length. '
    + 'variable:true = a small length-set (browse family) framed by checksum+next-head, NOT a fixed length. '
    + 'Structural only — regenerate with redesign/tools/gen-frame-lengths.mjs.',
  totals: { lines, rxFrames, badChecksum },
  fixedByHead: finalize(fixedByHead),
  reads04: finalize(reads04),
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n')

// ── human-readable report ────────────────────────────────────────────────────
console.log(`inputs : ${result.generatedFrom.join(', ')}`)
console.log(`frames : ${lines} lines · ${rxFrames} rx · ${badChecksum} bad-checksum\n`)
console.log('FIXED status/ack (head → length):')
for (const [h, e] of Object.entries(result.fixedByHead))
  console.log(`  ${h} : ${e.lengths.join('/')}  (n=${e.validSamples}${e.variable ? ' ⚠ MULTI' : ''}${e.badChecksum ? ` bad=${e.badChecksum}` : ''})`)
console.log('\n04 register reads (reg → length):')
const variable = []
for (const [r, e] of Object.entries(result.reads04)) {
  if (e.variable) variable.push(r)
  console.log(`  04 ${r} : ${e.lengths.join('/').padEnd(10)} (n=${e.validSamples})${e.variable ? '  ◀ VARIABLE (browse)' : ''}`)
}
console.log(`\nfixed registers (table-able): ${Object.keys(result.reads04).length - variable.length}`)
console.log(`variable registers (checksum+next-head): ${variable.length ? variable.map(r => '04 ' + r).join(', ') : 'none'}`)
console.log(`\nwrote ${rel(OUT)}`)
