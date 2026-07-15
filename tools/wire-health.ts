// Wire-health report over NDJSON capture files — the soak-comparison tool for the
// sub-channel corruption hypothesis: does dual receive (sub_channel ON) correlate with
// more garbled replies and ARQ retransmits? The radio juggles which-side-is-which
// internally (BT audio routing, DMR attribution, per-side event generation); with the
// second receiver off its event stream is single-sourced — if the garble / retransmit
// rate drops in sub-off soaks, the contention lives in the radio's own scheduler
// (BT-01 firmware RE: SysTick request flags gated on radio readiness).
//
// Uses the REAL codec Framer over the raw RX byte stream, so fragmentation/coalescing
// across RFCOMM chunks is handled exactly as the live link does — a reported incident
// is a genuine framing anomaly, not a split long reply. Metrics per capture:
//   subCh      sub_channel from the 04 05 settings block (byte 38: 00 off / 01 on)
//   frames     RX frames the framer reconstructed
//   pushPerS   unsolicited load (5a/5b/5c/5e/58/59) per second
//   incidents  framer desyncs (garbled/unknown bytes discarded, then re-aligned)
//   badSum     reconstructed frames whose checksum failed
//   retx       identical TX command re-sent within the ARQ window (~1.5s)
//
// Usage:  node --import tsx tools/wire-health.ts captures/v2-wire-*.ndjson

import { readFileSync } from 'node:fs'
import { Framer, FramingError } from '../src/codec/framing'

const RETRANSMIT_WINDOW_MS = 1500 // ARQ timeout ~1s + slack
const PUSH_HEADS = new Set([0x5a, 0x5b, 0x5c, 0x5e, 0x58, 0x59])

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node --import tsx tools/wire-health.ts <capture.ndjson> [...]')
  process.exit(1)
}

interface Row { [k: string]: string | number }
const rows: Row[] = []

for (const file of files) {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    console.error(`skip ${file}: ${(e as Error).message}`)
    continue
  }

  const framer = new Framer()
  let firstTs: number | null = null
  let lastTs = 0
  let frames = 0
  let badSum = 0
  let incidents = 0
  let pushes = 0
  let tx = 0
  let retransmits = 0
  let subChannel = '?'
  let lastTx: { hex: string; t: number } | null = null

  const drain = (): void => {
    for (;;) {
      try {
        const f = framer.next()
        if (f === null) return
        frames += 1
        if (!f.checksumOk) badSum += 1
        if (PUSH_HEADS.has(f.head)) pushes += 1
        if (f.head === 0x04 && f.reg === 0x05 && f.bytes.length > 38) {
          subChannel = f.bytes[38] === 0 ? 'off' : f.bytes[38] === 1 ? 'on' : `0x${f.bytes[38]!.toString(16)}`
        }
      } catch (e) {
        if (!(e instanceof FramingError)) throw e
        incidents += 1
        framer.discardPending()
      }
    }
  }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec: { ts: string; dir: string; hex: string }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const t = Date.parse(rec.ts)
    if (firstTs === null) firstTs = t
    lastTs = t
    const bytes = Uint8Array.from((rec.hex || '').split(/\s+/).map((h) => parseInt(h, 16)))
    if (bytes.length === 0 || bytes.some(Number.isNaN)) continue

    if (rec.dir === 'tx') {
      tx += 1
      // `03 <op>` frames are our ACKs of the radio's pushes — identical consecutive acks are a
      // healthy push stream (every 5e gets one), not ARQ retransmits. Only command frames count.
      if (bytes[0] !== 0x03) {
        if (lastTx && lastTx.hex === rec.hex && t - lastTx.t <= RETRANSMIT_WINDOW_MS) retransmits += 1
        lastTx = { hex: rec.hex, t }
      }
      continue
    }
    framer.push(bytes)
    drain()
  }

  const spanS = firstTs !== null ? (lastTs - firstTs) / 1000 : 0
  rows.push({
    file: file.replace(/^.*\//, ''),
    subCh: subChannel,
    spanMin: (spanS / 60).toFixed(1),
    frames,
    pushPerS: spanS > 0 ? (pushes / spanS).toFixed(2) : '0',
    incidents,
    badSum,
    per10k: frames > 0 ? (((incidents + badSum) / frames) * 10000).toFixed(1) : '0',
    tx,
    retx: retransmits,
    retxPerMin: spanS > 0 ? ((retransmits / spanS) * 60).toFixed(2) : '0',
  })
}

const cols = ['file', 'subCh', 'spanMin', 'frames', 'pushPerS', 'incidents', 'badSum', 'per10k', 'tx', 'retx', 'retxPerMin']
const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)))
console.log(cols.map((c, i) => c.padEnd(widths[i]!)).join('  '))
for (const r of rows) console.log(cols.map((c, i) => String(r[c]).padEnd(widths[i]!)).join('  '))
