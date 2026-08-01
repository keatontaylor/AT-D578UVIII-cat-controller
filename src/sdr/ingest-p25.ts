// P25 per-call ingest: DSD-FME (trunking mode, -P -7 <stagedir>) drops one WAV per decoded call,
// named e.g. 20260731_223959_11861_P25_BEE07D1CD1D_1_12_GROUP_TGT_9165_SRC_309380.wav — already
// 8 kHz/mono/16-bit (our native format). This adapter turns each into a pipeline clip: parse the
// talkgroup + source-radio id + timestamp from the name, resolve the talkgroup to a human lane
// name via the DTRS lookup, and drop a WAV+JSON pair into the recordings dir (JSON first, so the
// recorder's orphan sweep never sees a bare WAV). The main app's 60 s rescan then transcribes,
// scores, alerts, and lanes it exactly like the VHF/radio clips.
//
// Encrypted talkgroups mute to a header-only file (DSD-FME emits no AES audio) — those are
// skipped by a minimum-size gate AND the lookup's enc flag. Files are processed only once they've
// been stable for STABLE_MS (DSD-FME finalizes on call-end, but we never want a half-written one).
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const CFG = {
  stageDir: process.env['ANYTONE_P25_STAGE'] ?? join(process.env['HOME'] ?? '', 'anytone', 'recordings', '.p25-live'),
  dir: process.env['ANYTONE_P25_RECORDINGS'] ?? join(process.env['HOME'] ?? '', 'anytone', 'recordings'),
  tgFile: process.env['ANYTONE_P25_TALKGROUPS'] ?? join(process.env['HOME'] ?? '', 'anytone', 'data', 'dtrs-talkgroups.json'),
  freqMHz: Number(process.env['ANYTONE_P25_FREQ'] ?? 0) || null, // site/system label freq (informational)
  minBytes: Number(process.env['ANYTONE_P25_MIN_BYTES'] ?? 8_000), // < this ≈ header-only (encrypted/blip); 8kB ≈ 0.5s voice
  scanMs: 3_000,
  stableMs: 3_000,
}

mkdirSync(CFG.stageDir, { recursive: true })
const log = (m: string): void => console.log(`[p25] ${m}`)

interface TgInfo { alpha: string; desc: string; tag: string; enc: boolean }
let talkgroups: Record<string, TgInfo> = {}
try {
  talkgroups = JSON.parse(readFileSync(CFG.tgFile, 'utf8')) as Record<string, TgInfo>
  log(`loaded ${Object.keys(talkgroups).length} talkgroup names`)
} catch {
  log(`no talkgroup lookup at ${CFG.tgFile} — lanes will be numeric TG ids`)
}

// 20260731_223959_11861_P25_<sys>_<rfss>_<site>_GROUP_TGT_<tg>_SRC_<src>.wav
const NAME_RE = /^(\d{8})_(\d{6})_\d+_P25_[0-9A-Fx]+_\d+_\d+_[A-Z]+_TGT_(\d+)_SRC_(\d+)\.wav$/

function parseStartMs(date: string, time: string): number {
  // DSD-FME stamps LOCAL time — build a Date in local zone
  const y = +date.slice(0, 4), mo = +date.slice(4, 6), d = +date.slice(6, 8)
  const h = +time.slice(0, 2), mi = +time.slice(2, 4), s = +time.slice(4, 6)
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

function ingestCall(file: string): void {
  const m = NAME_RE.exec(file)
  const path = join(CFG.stageDir, file)
  if (!m) { rmSync(path, { force: true }); return } // non-call artifact
  const [, date, time, tg, src] = m
  const size = statSync(path).size
  const tgInfo = talkgroups[tg!]
  // Skip encrypted (header-only file AND/OR flagged) — no audio to transcribe.
  if (size < CFG.minBytes || tgInfo?.enc) {
    rmSync(path, { force: true })
    return
  }
  const startedAt = parseStartMs(date!, time!)
  const durationMs = Math.round(((size - 44) / (8000 * 2)) * 1000)
  const id = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-p25-${tg}`
  const channelName = tgInfo ? tgInfo.alpha : `TG ${tg}`
  const meta = {
    id, startedAt, durationMs, side: null,
    channelName,
    freqMHz: CFG.freqMHz,
    mode: 'P25',
    talkgroup: Number(tg),
    talkgroupName: tgInfo ? tgInfo.alpha : null,
    direction: 'rx',
    // extras the scorer/UI can use — the DTRS category + source radio id + description
    ...(tgInfo ? { p25Tag: tgInfo.tag, p25Desc: tgInfo.desc } : {}),
    p25Src: Number(src),
  }
  try {
    // JSON first (orphan-sweep safety), then the WAV — same-dir renames are atomic.
    const metaTmp = join(CFG.stageDir, `${id}.json`)
    writeFileSync(metaTmp, JSON.stringify(meta))
    renameSync(metaTmp, join(CFG.dir, `${id}.json`))
    renameSync(path, join(CFG.dir, `${id}.wav`))
    log(`${channelName} (TG ${tg}) ${(durationMs / 1000).toFixed(1)}s → ${id}`)
  } catch (e) {
    log(`ingest failed for ${file}: ${(e as Error).message}`)
  }
}

function scan(): void {
  let files: string[]
  try { files = readdirSync(CFG.stageDir) } catch { return }
  const now = Date.now()
  for (const f of files) {
    if (!f.endsWith('.wav')) continue
    const path = join(CFG.stageDir, f)
    let st
    try { st = statSync(path) } catch { continue }
    if (now - st.mtimeMs < CFG.stableMs) continue // still being written / just finished
    ingestCall(f)
  }
}

log(`ingesting P25 per-call from ${CFG.stageDir} → ${CFG.dir}`)
setInterval(scan, CFG.scanMs)
