// Squelch-triggered recorder (F4.3) — headless: subscribes to the shared RX capture, segments
// clips with the pure ClipSegmenter, and writes each kept clip to disk as a WAV + JSON sidecar.
// Runs with no browser attached. The clip BOUNDARY logic is pure/tested (clip-segmenter); this
// module is the I/O around it (subprocess subscription, WAV framing, disk). Live-audio dependent.

import { createWriteStream, mkdirSync, promises as fsp, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { ClipSegmenter, type SegmenterConfig } from './clip-segmenter'
import { RX_CHANNELS, RX_SAMPLE_RATE } from './rx-capture'

/** The recorder's only dependency on the audio capture: a 10 ms PCM frame subscription.
 * RxCapture satisfies it structurally; the integration harness substitutes a scripted source. */
export interface FrameSource {
  subscribe(onFrame: (frame: Buffer) => void): Promise<() => void>
}

/** Per-clip metadata written alongside the WAV; also what recordings.list returns. */
export interface ClipMeta {
  readonly id: string
  readonly startedAt: number
  readonly durationMs: number
  readonly side: 'a' | 'b' | null
  readonly channelName: string | null
  readonly freqMHz: number | null
  /** Display mode of the receiving channel (FM / DMR / A+D / D+A) — for lane coloring/filtering. */
  readonly mode: string | null
  /** LIVE DMR talkgroup received during the clip, when known — the timeline keys DMR lanes by this
   * so digital-monitor traffic on different TGs lands on separate lines. Null for analog. */
  readonly talkgroup: number | null
  /** What this clip captured: 'rx' = radio squelch audio; 'tx' = the OPERATOR's transmission
   * (the browser mic, tapped post-downsample/post-gain — exactly what went to the radio). */
  readonly direction: 'rx' | 'tx'
}

/** A clip currently being written — everything but the (unknown) duration. */
export type LiveClip = Omit<ClipMeta, 'durationMs'>

/** What the recorder needs from the live radio state at clip-open (for metadata). `side`/`channel`
 * must be the ACTUAL receiving side (see domain/receive.ts), not just the selected one. `source`
 * says HOW the side was attributed — mid-clip side re-attribution requires evidence ('dmr' or
 * 'analog'), never a default ('inferred'/'selected'), so end-of-RX transients can't relabel a
 * clip. Omitted (the TX recorder's context) → treated as evidence. */
export type RadioContext = () => {
  squelchOpen: boolean
  side: 'a' | 'b'
  /** FALSE while the attributed channel identity is known-stale (mid-scan, lock-follow read not
   * landed): the `opened` announcement is HELD until it resolves (or the fallback timer fires) so
   * the live timeline never shows a recording under the WRONG channel. Recording itself is never
   * delayed — only the announcement. Absent = resolved (the TX recorder). */
  identityResolved?: boolean
  source?: 'dmr' | 'analog' | 'inferred' | 'selected'
  /** Raw per-side squelch bits (RX recorder only) — lets the dual-RX split test whether the
   * CLIP's attributed side is still receiving, not just where the current audio points. */
  aOpen?: boolean
  bOpen?: boolean
  channelName: string
  freqMHz: number | null
  mode: string | null
  talkgroup: number | null
}

/** Pushed to subscribers (→ every /ws client) so the timeline updates live with no polling.
 * `opened` announces a recording IN PROGRESS (the timeline draws it growing toward "now");
 * it always ends in exactly one of `saved` (kept) or `discarded` (a blip under minDurationMs). */
export type RecorderEvent =
  | { type: 'opened'; clip: LiveClip }
  | { type: 'saved'; clip: ClipMeta }
  | { type: 'discarded'; id: string }
  | { type: 'removed'; id: string }
  | { type: 'status'; status: { enabled: boolean; tailMs: number; minDurationMs: number } }

const DEFAULTS: SegmenterConfig = { frameMs: 10, tailMs: 600, minDurationMs: 800 }
/** Held-announcement cap: the scan lock-follow read resolves in ~1 RTT (ACK'd + retransmitted);
 * if it hasn't after this long, announce with what we have — a live recording must never stay
 * invisible because a read is struggling. */
const ANNOUNCE_FALLBACK_MS = 2500

/** 44-byte canonical WAV header for `dataBytes` of PCM S16LE. PURE — unit-tested. */
export function wavHeader(dataBytes: number, sampleRate = RX_SAMPLE_RATE, channels = RX_CHANNELS): Buffer {
  const h = Buffer.alloc(44)
  const byteRate = sampleRate * channels * 2
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16) // fmt chunk size
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(byteRate, 28)
  h.writeUInt16LE(channels * 2, 32) // block align
  h.writeUInt16LE(16, 34) // bits/sample
  h.write('data', 36)
  h.writeUInt32LE(dataBytes, 40)
  return h
}

/** If an open clip sees no PCM for this long, the capture died (radio disconnect / stream end) —
 * force-close it so neither the server nor any client is stuck with a phantom "live" recording. */
const STALL_MS = 15_000

export class Recorder {
  private enabled = false
  private cfg: SegmenterConfig = DEFAULTS
  private unsubscribe: (() => void) | null = null
  private segmenter: ClipSegmenter | null = null
  private lastFrameAt = 0
  private stallTimer: ReturnType<typeof setInterval> | null = null
  // The clip currently being written: its WAV stream, byte count, path, open-time metadata, and
  // HOW the open-time side was attributed (the side re-attribution policy keys off it).
  private clip: {
    id: string
    stream: WriteStream
    wav: string
    bytes: number
    meta: Omit<ClipMeta, 'durationMs'>
    openSource: 'dmr' | 'analog' | 'inferred' | 'selected' | undefined
    /** The single `opened` announcement went out (held while identity is unresolved). */
    announced: boolean
    announceTimer?: ReturnType<typeof setTimeout> | undefined
    /** Last time the clip's OWN side showed receive evidence — drives the dual-RX split. */
    sideActiveAt: number
  } | null = null
  private readonly listeners = new Set<(e: RecorderEvent) => void>()

  /** Subscribe to recorder events (saved clip / removed / status). Returns an unsubscribe. The
   * /ws server relays these to every client so the timeline stays live without polling. */
  subscribe(cb: (e: RecorderEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  private emit(e: RecorderEvent): void {
    for (const cb of this.listeners) cb(e)
  }

  private readonly stallMs: number
  private readonly stallCheckMs: number

  constructor(
    private readonly capture: FrameSource,
    private readonly dir: string,
    private readonly context: RadioContext,
    private readonly log: (m: string) => void = () => {},
    /** 'tx' = this instance records the operator's transmissions (mic tap); ids get a '-tx'
     * suffix so an RX and a TX clip opening in the same millisecond can't collide on disk. */
    private readonly direction: 'rx' | 'tx' = 'rx',
    opts: { stallMs?: number; stallCheckMs?: number } = {},
  ) {
    this.stallMs = opts.stallMs ?? STALL_MS
    this.stallCheckMs = opts.stallCheckMs ?? 5_000
    mkdirSync(dir, { recursive: true })
  }

  get status(): { enabled: boolean; tailMs: number; minDurationMs: number } {
    return { enabled: this.enabled, tailMs: this.cfg.tailMs, minDurationMs: this.cfg.minDurationMs }
  }

  /** The clip currently being written (metadata sans duration), or null — lets a client that
   * (re)connects mid-recording hydrate its live state instead of relying on missed pushes.
   * A clip whose announcement is still HELD (identity unresolved) is invisible here too — the
   * hydration path must not leak the wrong-channel label the push path is holding back. */
  get live(): LiveClip | null {
    return this.clip?.announced ? this.clip.meta : null
  }

  /** Remove orphaned WAVs (no sidecar): a clip that was open when the process died left a
   * placeholder-headered, unlisted file. Run before recording starts (no clip is open then). */
  private async sweepOrphans(): Promise<void> {
    const files = await fsp.readdir(this.dir).catch(() => [] as string[])
    const sidecars = new Set(files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)))
    for (const f of files) {
      if (!f.endsWith('.wav') || sidecars.has(f.slice(0, -4))) continue
      await fsp.rm(join(this.dir, f), { force: true }).catch(() => {})
      this.log(`recorder: swept orphaned ${f} (no sidecar — process died mid-clip)`)
    }
  }

  /** Close a clip whose PCM went away (radio disconnect kills the capture — the segmenter never
   * sees closing frames, so without this the clip stays "live" forever, server AND clients). */
  private checkStall(): void {
    if (!this.clip || Date.now() - this.lastFrameAt < this.stallMs) return
    this.log('recorder: audio stream stalled with a clip open — force-closing it')
    const close = this.segmenter?.flush()
    if (close?.kind === 'close') void this.finishClip(close.keep, close.durationMs)
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) return
    this.enabled = enabled
    this.emit({ type: 'status', status: this.status })
    if (enabled) {
      await this.sweepOrphans()
      this.segmenter = new ClipSegmenter(this.cfg)
      this.lastFrameAt = Date.now()
      this.stallTimer = setInterval(() => this.checkStall(), this.stallCheckMs)
      this.stallTimer.unref?.()
      this.unsubscribe = await this.capture.subscribe((frame) => this.onFrame(frame))
      this.log('recorder: enabled')
    } else {
      this.unsubscribe?.()
      this.unsubscribe = null
      if (this.stallTimer) {
        clearInterval(this.stallTimer)
        this.stallTimer = null
      }
      const close = this.segmenter?.flush()
      if (close?.kind === 'close') void this.finishClip(close.keep, close.durationMs)
      this.segmenter = null
      this.log('recorder: disabled')
    }
  }

  private onFrame(frame: Buffer): void {
    if (!this.segmenter) return
    this.lastFrameAt = Date.now()
    const ctx = this.context()
    for (const e of this.segmenter.feed(frame, ctx.squelchOpen)) {
      if (e.kind === 'open') this.openClip(ctx)
      else if (e.kind === 'append') this.appendFrame(e.frame)
      else void this.finishClip(e.keep, e.durationMs)
    }
    // DUAL-RX SPLIT: both sides receiving, the clip's side stops, the OTHER side holds the gate
    // open — the global gate never closes, so without this the segmenter fuses two different
    // sides' transmissions into one clip labeled with the first winner. When the clip's own side
    // has shown no evidence for tailMs (the same window that bridges its own squelch bounces)
    // while the audio is evidence-attributed to a DIFFERENT side, the attributed transmission is
    // over: close this clip and let the next frame open a fresh one for the new side. This is a
    // SPLIT, never a relabel — the no-overturn policy below stands.
    {
      const c0 = this.clip
      if (c0 && ctx.squelchOpen) {
        const sideBit = c0.meta.side === 'a' ? ctx.aOpen === true : ctx.bOpen === true
        const sideActive = sideBit || (ctx.source === 'dmr' && ctx.side === c0.meta.side)
        if (sideActive) {
          c0.sideActiveAt = Date.now()
        } else if (
          (ctx.source === 'analog' || ctx.source === 'dmr') &&
          ctx.side !== c0.meta.side &&
          Date.now() - c0.sideActiveAt >= this.cfg.tailMs
        ) {
          const ev = this.segmenter.flush()
          if (ev?.kind === 'close') void this.finishClip(ev.keep, ev.durationMs)
        }
      }
    }
    // Late-fill / refresh metadata that resolves a beat after the clip opens: the DMR talkgroup
    // (decoded after the audio gate opens) and the SCAN-LOCKED channel (the 04 2c/2d 01 read lands
    // ~1s in, so the clip opened on a stale channel name). ONLY while the gate is still open —
    // attribution is trustworthy exactly as long as audio is flowing. Once squelch closes (the
    // trailing tail), activeReceive falls back to the selected side, and refreshing then CLOBBERS
    // the clip's identity with an unrelated channel (a DMR clip on the non-selected side was being
    // rewritten to the selected analog channel during the 600 ms tail). The side moves WITH the
    // channel identity — they are one attribution, never mixed.
    //
    // SIDE RE-ATTRIBUTION POLICY (wire-pinned 2026-07-11): a clip that OPENED evidence-backed
    // ('dmr' tuple / 'analog' open squelch) keeps its side, PERIOD — its first frames ARE that
    // side's audio, and nothing mid-clip changes what was recorded. Only a clip that opened on a
    // DEFAULT ('inferred'/'selected' — e.g. the gate racing ahead of the first 5e decode) may be
    // UPGRADED once evidence arrives. This closes both observed relabel paths: the end-of-RX
    // 24 ms 5a-before-5b window (inference pointed at the DMR side while the gate drained), and
    // hangtime 5e bursts from the other side's last call (status=01 with full identity → a 'dmr'
    // attribution while the audio is analog).
    const c = this.clip
    if (c && ctx.squelchOpen) {
      const m = c.meta
      const sideChange = ctx.side !== m.side
      const ctxEvidence = ctx.source === undefined || ctx.source === 'dmr' || ctx.source === 'analog'
      const openedOnDefault = c.openSource === 'inferred' || c.openSource === 'selected'
      if (!sideChange || (ctxEvidence && openedOnDefault)) {
        const name = ctx.channelName || null
        const tgChanged = m.talkgroup == null && ctx.talkgroup != null
        const chanChanged = name != null && name !== m.channelName
        if (tgChanged || chanChanged) {
          c.meta = {
            ...m,
            side: ctx.side,
            channelName: name ?? m.channelName,
            freqMHz: ctx.freqMHz ?? m.freqMHz,
            mode: ctx.mode ?? m.mode,
            talkgroup: ctx.talkgroup ?? m.talkgroup,
          }
          // an applied side upgrade makes the clip evidence-attributed — no further overturns
          if (sideChange) c.openSource = ctx.source
        }
      }
    }
    // A held announcement goes out the moment identity resolves — the late-fill above has just
    // re-stamped the metadata from the same context, so the live block appears with the RIGHT
    // channel (the whole point of holding it).
    if (c && !c.announced && ctx.identityResolved !== false) this.announce(c)
  }

  private openClip(ctx: ReturnType<RadioContext>): void {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}${this.direction === 'tx' ? '-tx' : ''}`
    const wav = join(this.dir, `${id}.wav`)
    const stream = createWriteStream(wav)
    stream.write(wavHeader(0)) // placeholder header; patched on finish
    this.clip = {
      id,
      stream,
      wav,
      bytes: 0,
      meta: {
        id,
        startedAt: Date.now(),
        side: ctx.side,
        channelName: ctx.channelName || null,
        freqMHz: ctx.freqMHz,
        mode: ctx.mode,
        talkgroup: ctx.talkgroup,
        direction: this.direction,
      },
      openSource: ctx.source,
      sideActiveAt: Date.now(),
      announced: false,
    }
    if (ctx.identityResolved === false) {
      // Identity is known-stale (scan lock read in flight): HOLD the live announcement — the
      // late-fill below re-stamps the metadata when the read lands and we announce then, with
      // the RIGHT channel. The read is ACK'd + retransmitted, so this resolves in ~1 RTT; the
      // fallback keeps the indicator honest if the link is exceptionally unhealthy.
      const clip = this.clip
      clip.announceTimer = setTimeout(() => this.announce(clip), ANNOUNCE_FALLBACK_MS)
      ;(clip.announceTimer as { unref?: () => void }).unref?.()
    } else {
      this.announce(this.clip)
    }
  }

  /** Emit the (single) `opened` announcement for a clip with its CURRENT metadata. */
  private announce(clip: NonNullable<Recorder['clip']>): void {
    if (clip.announced) return
    clip.announced = true
    if (clip.announceTimer) {
      clearTimeout(clip.announceTimer)
      clip.announceTimer = undefined
    }
    this.emit({ type: 'opened', clip: clip.meta })
  }

  private appendFrame(frame: Buffer): void {
    if (!this.clip) return
    this.clip.stream.write(frame)
    this.clip.bytes += frame.length
  }

  private async finishClip(keep: boolean, durationMs: number): Promise<void> {
    const clip = this.clip
    this.clip = null
    if (!clip) return
    // A still-held announcement dies with the clip: the saved event (with FINAL metadata) is the
    // first the timeline hears of it — never a wrong-channel live block, never a stale opened.
    if (clip.announceTimer) {
      clearTimeout(clip.announceTimer)
      clip.announceTimer = undefined
    }
    await new Promise<void>((resolve) => clip.stream.end(resolve))
    if (!keep) {
      await fsp.rm(clip.wav, { force: true }).catch(() => {})
      if (clip.announced) this.emit({ type: 'discarded', id: clip.id }) // the live block must leave the timeline
      return
    }
    // Patch the RIFF/data sizes now that the length is known, and write the JSON sidecar.
    try {
      const fd = await fsp.open(clip.wav, 'r+')
      await fd.write(wavHeader(clip.bytes), 0, 44, 0)
      await fd.close()
      const meta: ClipMeta = { ...clip.meta, durationMs }
      await fsp.writeFile(join(this.dir, `${clip.id}.json`), JSON.stringify(meta))
      this.log(`recorder: saved ${clip.id} (${durationMs}ms, ${clip.bytes}B)`)
      this.emit({ type: 'saved', clip: meta })
    } catch (e) {
      this.log(`recorder: finalize failed for ${clip.id}: ${(e as Error).message}`)
    }
  }

  /** List saved clips (newest first) from the sidecar JSONs. */
  async list(): Promise<ClipMeta[]> {
    const files = await fsp.readdir(this.dir).catch(() => [] as string[])
    const metas: ClipMeta[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const meta = JSON.parse(await fsp.readFile(join(this.dir, f), 'utf8')) as ClipMeta
        // sidecars written before the TX feature lack `direction` — they are all RX
        metas.push(meta.direction ? meta : { ...meta, direction: 'rx' })
      } catch {
        /* skip a partial/corrupt sidecar */
      }
    }
    return metas.sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Absolute path of a clip's WAV for HTTP serving (null if the id is unknown/unsafe). */
  wavPath(id: string): string | null {
    if (!/^[\w:-]+$/.test(id)) return null // no traversal
    return join(this.dir, `${id}.wav`)
  }

  async remove(id: string): Promise<void> {
    if (!/^[\w:-]+$/.test(id)) return
    await Promise.all([
      fsp.rm(join(this.dir, `${id}.wav`), { force: true }),
      fsp.rm(join(this.dir, `${id}.json`), { force: true }),
    ])
    this.emit({ type: 'removed', id })
  }
}
