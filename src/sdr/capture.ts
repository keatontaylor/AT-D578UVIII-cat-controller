// SDR squelch-gated clip capture → the recordings pipeline. Stdin is 16-bit LE mono PCM at
// 8 kHz from `rtl_fm -l <squelch>` (matching the recorder's native format), and rtl_fm emits
// bytes ONLY while its carrier squelch is open — so clip boundaries are data-flow boundaries:
// first bytes after a gap open a clip, TAIL_MS without bytes closes it.
//
// File discipline (the recorder's orphan sweep DELETES bare WAVs it doesn't recognize): clips
// grow in <recordings>/.sdr-live/ (a dotted subdir the recorder never lists), and finalize
// writes the metadata JSON into recordings/ FIRST, then renames the WAV beside it — the clip is
// never visible without its sidecar. Ids carry an '-sdr' suffix (the '-tx' pattern) so they can
// never collide with radio-recorded clips. The main process ingests via its periodic rescan.
import { createWriteStream, mkdirSync, renameSync, writeFileSync, openSync, writeSync, closeSync, rmSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { wavHeader } from '../audio/recorder'

const RATE = 8000
const BYTES_PER_MS = (RATE * 2) / 1000
const CFG = {
  dir: process.env['ANYTONE_SDR_RECORDINGS'] ?? join(process.env['HOME'] ?? '', 'anytone', 'recordings'),
  channelName: process.env['ANYTONE_SDR_CHANNEL'] ?? 'SDR',
  freqMHz: Number(process.env['ANYTONE_SDR_FREQ'] ?? 0) || null,
  tailMs: Number(process.env['ANYTONE_SDR_TAIL_MS'] ?? 700),
  minMs: Number(process.env['ANYTONE_SDR_MIN_MS'] ?? 1500),
  maxMs: Number(process.env['ANYTONE_SDR_MAX_MS'] ?? 15 * 60_000), // hard cap: a stuck carrier can't grow one clip forever
}

// CTCSS removal — two stages, because field measurement humbled the first attempt: a single
// 2nd-order HPF at 250 Hz only cuts ~11 dB at 136.5 Hz and the PL tone stayed audible.
// (1) a NOTCH at the channel's exact CTCSS frequency (ANYTONE_SDR_NOTCH_HZ, default the
// measured 136.5; Q=8 → ~2s settle, >30 dB at the tone, voice untouched), and (2) a 4th-order
// Butterworth HPF at 250 Hz (two cascaded biquads) for general sub-voice rumble. States reset
// per clip. Set either env to 0 to disable that stage.
const HPF_HZ = Number(process.env['ANYTONE_SDR_HPF_HZ'] ?? 250)
const NOTCH_HZ = Number(process.env['ANYTONE_SDR_NOTCH_HZ'] ?? 136.5)
interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number; z1: number; z2: number }
function hpBiquad(fc: number): Biquad {
  const K = Math.tan(Math.PI * fc / RATE)
  const norm = 1 / (1 + Math.SQRT2 * K + K * K)
  return { b0: norm, b1: -2 * norm, b2: norm, a1: 2 * (K * K - 1) * norm, a2: (1 - Math.SQRT2 * K + K * K) * norm, z1: 0, z2: 0 }
}
function notchBiquad(f0: number, q: number): Biquad {
  const w = 2 * Math.PI * f0 / RATE
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha
  return { b0: 1 / a0, b1: -2 * Math.cos(w) / a0, b2: 1 / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - alpha) / a0, z1: 0, z2: 0 }
}
function makeSections(): Biquad[] {
  const out: Biquad[] = []
  if (NOTCH_HZ) out.push(notchBiquad(NOTCH_HZ, 8))
  if (HPF_HZ) out.push(hpBiquad(HPF_HZ), hpBiquad(HPF_HZ))
  return out
}
let sections = makeSections()
export function filterChunk(chunk: Buffer, secs: Biquad[] = sections): Buffer {
  if (!secs.length) return chunk
  const out = Buffer.alloc(chunk.length)
  const n = Math.floor(chunk.length / 2)
  for (let i = 0; i < n; i++) {
    let v = chunk.readInt16LE(i * 2)
    for (const s of secs) {
      const y = s.b0 * v + s.z1
      s.z1 = s.b1 * v - s.a1 * y + s.z2
      s.z2 = s.b2 * v - s.a2 * y
      v = y
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2)
  }
  return out
}

const liveDir = join(CFG.dir, '.sdr-live')
mkdirSync(liveDir, { recursive: true })

interface OpenClip { id: string; startedAt: number; tmp: string; stream: WriteStream; bytes: number }
let clip: OpenClip | null = null
let lastDataAt = 0
const log = (m: string): void => console.log(`[sdr] ${m}`)

function openClip(): void {
  const startedAt = Date.now()
  const id = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-sdr`
  const tmp = join(liveDir, `${id}.wav`)
  const stream = createWriteStream(tmp)
  stream.write(wavHeader(0)) // placeholder; patched at finalize
  clip = { id, startedAt, tmp, stream, bytes: 0 }
  sections = makeSections() // fresh filter state per clip
  log(`squelch open → ${id}`)
}

function closeClip(): void {
  if (!clip) return
  const c = clip
  clip = null
  const durationMs = Math.round(c.bytes / BYTES_PER_MS)
  c.stream.end(() => {
    try {
      if (durationMs < CFG.minMs) {
        rmSync(c.tmp, { force: true })
        log(`blip discarded (${durationMs}ms)`)
        return
      }
      // patch the header with the real data size
      const fd = openSync(c.tmp, 'r+')
      writeSync(fd, wavHeader(c.bytes), 0, 44, 0)
      closeSync(fd)
      // JSON FIRST (orphan-sweep safety), then the WAV beside it — same filesystem, atomic renames
      const meta = {
        id: c.id, startedAt: c.startedAt, durationMs, side: null,
        channelName: CFG.channelName, freqMHz: CFG.freqMHz, mode: 'FM',
        talkgroup: null, talkgroupName: null, direction: 'rx',
      }
      const metaTmp = join(liveDir, `${c.id}.json`)
      writeFileSync(metaTmp, JSON.stringify(meta))
      renameSync(metaTmp, join(CFG.dir, `${c.id}.json`))
      renameSync(c.tmp, join(CFG.dir, `${c.id}.wav`))
      log(`saved ${c.id} (${(durationMs / 1000).toFixed(1)}s)`)
    } catch (e) {
      log(`finalize failed for ${c.id}: ${(e as Error).message}`)
    }
  })
}

process.stdin.on('data', (raw: Buffer) => {
  lastDataAt = Date.now()
  if (!clip) openClip()
  const chunk = filterChunk(raw)
  clip!.stream.write(chunk)
  clip!.bytes += chunk.length
  if (clip!.bytes / BYTES_PER_MS >= CFG.maxMs) {
    log('max clip length reached — rotating')
    closeClip() // next chunk opens a fresh clip
  }
})

setInterval(() => {
  if (clip && Date.now() - lastDataAt > CFG.tailMs) closeClip()
}, 100)

function shutdown(): void {
  closeClip()
  setTimeout(() => process.exit(0), 300) // let the finalize I/O land
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.stdin.on('end', shutdown)

log(`capturing ${CFG.channelName}${CFG.freqMHz ? ` @ ${CFG.freqMHz} MHz` : ''} → ${CFG.dir} (tail ${CFG.tailMs}ms, min ${CFG.minMs}ms)`)
