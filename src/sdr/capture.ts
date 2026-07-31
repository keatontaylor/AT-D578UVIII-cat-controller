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

process.stdin.on('data', (chunk: Buffer) => {
  lastDataAt = Date.now()
  if (!clip) openClip()
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
