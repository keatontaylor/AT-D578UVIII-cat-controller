// Transcription side-process — a metadata ENHANCEMENT next to the recorder, never a dependency
// of it. Auto-enabled when recording is on AND a Groq key exists (env GROQ_API_KEY or
// ~/.groq_key); with no key everything just stays untranscribed. Owns its own files: one
// `<id>.transcript.json` sidecar per clip (atomic tmp+rename; the recorder's metadata is never
// touched), plus a small state file for the budget + enabled-since marker. Crash/boot recovery is
// the absence of a sidecar: clips saved since first-enable without one re-queue on start.
//
// Budgeting (free-tier aware, env-overridable): daily/hourly audio-second caps with safety
// margins, request caps, paced one-clip-per-tick. Exhaustion → clips park as `deferred` and drain
// when budget returns (quota resets daily) — nothing is dropped, only delayed. Priority is the
// LEARNED per-channel interest ([[learner]]), forced requests first; volume never promotes.

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeSpeech, parseWav, sliceWav, trimPlan } from './trim'
import { buildPrompt, isPromptEcho, transcribe as groqTranscribe, GroqQuotaError, type GroqResult } from './groq'
import { InterestLearner, type EngagementKind } from './learner'

export interface TranscribableClip {
  readonly id: string
  readonly startedAt: number
  readonly durationMs: number
  readonly channelName: string | null
  readonly talkgroupName?: string | null
  readonly direction?: string
}

export type TranscriptStatus = 'queued' | 'deferred' | 'done' | 'skipped' | 'failed'

/** The `<id>.transcript.json` sidecar. Segment times are ms into the ORIGINAL clip. */
export interface TranscriptSidecar {
  readonly v: 1
  readonly status: 'done' | 'skipped' | 'failed'
  readonly reason?: string
  readonly model?: string
  readonly text?: string
  readonly segments?: { startMs: number; endMs: number; text: string }[]
  readonly flags?: string[]
  readonly avgLogprob?: number | null
  readonly trim?: { startMs: number; endMs: number; speechMs: number }
  readonly billedS?: number
  readonly transcribedAt?: string
}

export interface TranscriberEvent {
  readonly id: string
  readonly status: TranscriptStatus
}

interface QueueItem {
  clip: TranscribableClip
  forced: boolean
  attempts: number
  deferred: boolean
}

interface PersistedState {
  enabledSince?: number
  day?: string
  daySec?: number
  dayReq?: number
  hour?: string
  hourSec?: number
}

const MIN_CLIP_MS = 3000 // kerchunk floor — bake-off-proven hallucination fodder, ~1% of audio
const MIN_SPEECH_MS = 1000 // post-VAD: less than this much speech energy → nothing to transcribe
const MAX_ATTEMPTS = 3
const DEFAULTS = {
  model: 'whisper-large-v3-turbo',
  dailySecCap: Number(process.env['ANYTONE_TRANSCRIBE_DAILY_S'] ?? 27_000), // free tier 28.8k − margin
  hourlySecCap: Number(process.env['ANYTONE_TRANSCRIBE_HOURLY_S'] ?? 6_800), // free tier 7.2k − margin
  dailyReqCap: Number(process.env['ANYTONE_TRANSCRIBE_DAILY_REQ'] ?? 1_800),
  tickMs: 4_000,
}

export interface TranscriberDeps {
  readonly dir: string
  readonly recorderEnabled: () => boolean
  readonly log?: (m: string) => void
  readonly now?: () => number
  /** Injectable for tests; default = the real Groq client. */
  readonly transcribeFn?: typeof groqTranscribe
  readonly keyFn?: () => string | null
  readonly model?: string
  readonly startTimer?: boolean
}

function defaultKey(): string | null {
  const env = process.env['GROQ_API_KEY']
  if (env) return env
  try {
    const p = join(process.env['HOME'] ?? '', '.groq_key')
    if (existsSync(p)) return readFileSync(p, 'utf8').trim() || null
  } catch { /* unreadable = absent */ }
  return null
}

export class Transcriber {
  private readonly queue = new Map<string, QueueItem>()
  private readonly sidecarCache = new Map<string, TranscriptSidecar | null>()
  private readonly listeners = new Set<(e: TranscriberEvent) => void>()
  readonly learner: InterestLearner
  private state: PersistedState = {}
  private busy = false
  private resumeAt = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number
  private readonly log: (m: string) => void
  private readonly doTranscribe: typeof groqTranscribe
  private readonly keyFn: () => string | null
  private readonly model: string

  constructor(private readonly deps: TranscriberDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
    this.doTranscribe = deps.transcribeFn ?? groqTranscribe
    this.keyFn = deps.keyFn ?? defaultKey
    this.model = deps.model ?? DEFAULTS.model
    this.learner = new InterestLearner(join(deps.dir, 'transcribe-learner.json'), this.now)
    this.loadState()
    if (deps.startTimer !== false) {
      this.timer = setInterval(() => void this.tick(), DEFAULTS.tickMs)
      this.timer.unref?.()
    }
  }

  /** ON = recording on + key present (+ no kill switch). Checked live so key/recorder changes
   * take effect without restart. */
  get enabled(): boolean {
    if (process.env['ANYTONE_TRANSCRIBE'] === '0') return false
    return this.deps.recorderEnabled() && this.keyFn() !== null
  }

  subscribe(cb: (e: TranscriberEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(e: TranscriberEvent): void {
    for (const cb of this.listeners) cb(e)
  }

  /** New clip from the recorder — evaluate + queue. */
  onClipSaved(clip: TranscribableClip): void {
    if (!this.enabled) return
    if (clip.direction === 'tx') return
    if (clip.durationMs < MIN_CLIP_MS) return // derived skip — no sidecar file needed
    this.markEnabledSince()
    this.queue.set(clip.id, { clip, forced: false, attempts: 0, deferred: false })
    this.emit({ id: clip.id, status: 'queued' })
  }

  /** User override: jump the queue (and re-run even if a sidecar exists). Also an engagement
   * signal — forcing a channel's clip teaches priority. */
  transcribeNow(clip: TranscribableClip): void {
    this.markEnabledSince()
    this.sidecarCache.delete(clip.id)
    this.queue.set(clip.id, { clip, forced: true, attempts: 0, deferred: false })
    this.learner.record('force', clip.channelName ?? '')
    this.emit({ id: clip.id, status: 'queued' })
    void this.tick()
  }

  noteEngagement(kind: EngagementKind, channel: string): void {
    this.learner.record(kind, channel)
  }

  statusOf(id: string): TranscriptStatus | null {
    const q = this.queue.get(id)
    if (q) return q.deferred && this.now() < this.resumeAt ? 'deferred' : 'queued'
    const side = this.sidecar(id)
    return side ? side.status : null
  }

  transcript(id: string): TranscriptSidecar | null {
    return this.sidecar(id)
  }

  /** Boot rescan: clips saved since first-enable that never got a sidecar re-queue. Bounded by
   * the enabledSince marker so enabling the feature never surprise-backfills the whole archive. */
  rescan(clips: TranscribableClip[]): void {
    if (!this.enabled || this.state.enabledSince === undefined) return
    let queued = 0
    for (const clip of clips) {
      if (clip.direction === 'tx' || clip.durationMs < MIN_CLIP_MS) continue
      if (clip.startedAt < this.state.enabledSince) continue
      if (this.queue.has(clip.id) || this.sidecar(clip.id)) continue
      this.queue.set(clip.id, { clip, forced: false, attempts: 0, deferred: false })
      queued++
    }
    if (queued) this.log(`transcriber: rescan queued ${queued} clip(s)`)
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One scheduling step: pick the best queued item and process it. Public for tests. */
  async tick(): Promise<void> {
    if (this.busy || !this.enabled || this.queue.size === 0) return
    if (this.now() < this.resumeAt) return
    const item = this.pick()
    if (!item) return
    this.busy = true
    try {
      await this.process(item)
    } finally {
      this.busy = false
    }
  }

  private pick(): QueueItem | null {
    let best: QueueItem | null = null
    let bestKey: [number, number, number] | null = null
    for (const item of this.queue.values()) {
      if (item.deferred && this.now() < this.resumeAt) continue
      const key: [number, number, number] = [
        item.forced ? 1 : 0,
        this.learner.scoreOf(item.clip.channelName ?? ''),
        item.clip.startedAt,
      ]
      if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))) {
        best = item
        bestKey = key
      }
    }
    return best
  }

  private async process(item: QueueItem): Promise<void> {
    const { clip } = item
    let wav: Buffer
    try {
      wav = readFileSync(join(this.deps.dir, `${clip.id}.wav`))
    } catch {
      this.queue.delete(clip.id) // clip deleted from under us — drop silently
      return
    }
    let profile
    try {
      profile = analyzeSpeech(parseWav(wav))
    } catch (e) {
      this.finish(clip.id, { v: 1, status: 'failed', reason: `unreadable wav: ${(e as Error).message}` })
      return
    }
    if (profile.speechMs < MIN_SPEECH_MS && !item.forced) {
      this.finish(clip.id, {
        v: 1, status: 'skipped', reason: 'no-speech',
        trim: { startMs: 0, endMs: profile.durationMs, speechMs: profile.speechMs },
      })
      return
    }
    const plan = trimPlan(profile) ?? { startMs: 0, endMs: profile.durationMs }
    const billedS = (plan.endMs - plan.startMs) / 1000
    if (!this.budgetAllows(billedS)) {
      if (!item.deferred) {
        item.deferred = true
        this.emit({ id: clip.id, status: 'deferred' })
        // one shared resume point: the next UTC hour (hourly window) — the tick re-evaluates
        this.resumeAt = this.nextHourStart()
        this.log(`transcriber: budget exhausted — deferring (resume ${new Date(this.resumeAt).toISOString()})`)
      }
      return
    }
    const key = this.keyFn()
    if (!key) return
    let result: GroqResult
    try {
      result = await this.doTranscribe(sliceWav(wav, plan.startMs, plan.endMs), {
        key,
        model: this.model,
        prompt: buildPrompt(clip.channelName || null, clip.talkgroupName ?? null),
      })
    } catch (e) {
      if (e instanceof GroqQuotaError) {
        item.deferred = true
        this.resumeAt = this.now() + Math.max(30, e.retryAfterS) * 1000
        this.emit({ id: clip.id, status: 'deferred' })
        this.log(`transcriber: 429 — resuming ${new Date(this.resumeAt).toISOString()}`)
        return
      }
      item.attempts++
      if (item.attempts >= MAX_ATTEMPTS) {
        this.finish(clip.id, { v: 1, status: 'failed', reason: (e as Error).message.slice(0, 200) })
      }
      return
    }
    this.spend(billedS)
    const prompt = buildPrompt(clip.channelName || null, clip.talkgroupName ?? null)
    const flags: string[] = []
    if (result.avgLogprob !== null && result.avgLogprob < -0.7) flags.push('low-confidence')
    if (result.maxNoSpeechProb !== null && result.maxNoSpeechProb > 0.5) flags.push('maybe-noise')
    if (!result.text || isPromptEcho(result.text, prompt)) {
      this.finish(clip.id, {
        v: 1, status: 'skipped', reason: result.text ? 'prompt-echo' : 'empty',
        model: this.model, billedS,
        trim: { startMs: plan.startMs, endMs: plan.endMs, speechMs: profile.speechMs },
      })
      return
    }
    this.finish(clip.id, {
      v: 1,
      status: 'done',
      model: this.model,
      text: result.text,
      segments: result.segments.map((s) => ({
        startMs: Math.round(plan.startMs + s.startS * 1000),
        endMs: Math.round(plan.startMs + s.endS * 1000),
        text: s.text,
      })),
      flags,
      avgLogprob: result.avgLogprob,
      trim: { startMs: plan.startMs, endMs: plan.endMs, speechMs: profile.speechMs },
      billedS,
      transcribedAt: new Date(this.now()).toISOString(),
    })
    this.log(`transcriber: ${clip.id} done (${billedS.toFixed(1)}s billed, ${result.apiMs}ms${flags.length ? `, ${flags.join(',')}` : ''})`)
  }

  private finish(id: string, sidecar: TranscriptSidecar): void {
    const path = join(this.deps.dir, `${id}.transcript.json`)
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(sidecar))
      renameSync(`${path}.tmp`, path)
    } catch (e) {
      this.log(`transcriber: sidecar write failed for ${id}: ${(e as Error).message}`)
    }
    this.sidecarCache.set(id, sidecar)
    this.queue.delete(id)
    this.emit({ id, status: sidecar.status })
  }

  private sidecar(id: string): TranscriptSidecar | null {
    const cached = this.sidecarCache.get(id)
    if (cached !== undefined) return cached
    let side: TranscriptSidecar | null = null
    try {
      const p = join(this.deps.dir, `${id}.transcript.json`)
      if (existsSync(p)) side = JSON.parse(readFileSync(p, 'utf8')) as TranscriptSidecar
    } catch { /* unreadable sidecar = none */ }
    this.sidecarCache.set(id, side)
    return side
  }

  /** All known sidecar statuses (for merging into recordings.list) — scans the dir once. */
  statuses(): Record<string, TranscriptStatus> {
    const out: Record<string, TranscriptStatus> = {}
    try {
      for (const f of readdirSync(this.deps.dir)) {
        if (!f.endsWith('.transcript.json')) continue
        const id = f.slice(0, -'.transcript.json'.length)
        const s = this.sidecar(id)
        if (s) out[id] = s.status
      }
    } catch { /* dir unreadable → statuses from queue only */ }
    for (const [id, item] of this.queue) out[id] = item.deferred && this.now() < this.resumeAt ? 'deferred' : 'queued'
    return out
  }

  // ── budget ──────────────────────────────────────────────────────────────────
  private dayKey(): string {
    return new Date(this.now()).toISOString().slice(0, 10)
  }
  private hourKey(): string {
    return new Date(this.now()).toISOString().slice(0, 13)
  }
  private nextHourStart(): number {
    const t = this.now()
    return t - (t % 3600_000) + 3600_000
  }
  private roll(): void {
    if (this.state.day !== this.dayKey()) {
      this.state.day = this.dayKey()
      this.state.daySec = 0
      this.state.dayReq = 0
    }
    if (this.state.hour !== this.hourKey()) {
      this.state.hour = this.hourKey()
      this.state.hourSec = 0
    }
  }
  private budgetAllows(sec: number): boolean {
    this.roll()
    return (
      (this.state.daySec ?? 0) + sec <= DEFAULTS.dailySecCap &&
      (this.state.hourSec ?? 0) + sec <= DEFAULTS.hourlySecCap &&
      (this.state.dayReq ?? 0) + 1 <= DEFAULTS.dailyReqCap
    )
  }
  private spend(sec: number): void {
    this.roll()
    this.state.daySec = (this.state.daySec ?? 0) + sec
    this.state.hourSec = (this.state.hourSec ?? 0) + sec
    this.state.dayReq = (this.state.dayReq ?? 0) + 1
    this.persistState()
  }

  private markEnabledSince(): void {
    if (this.state.enabledSince === undefined) {
      this.state.enabledSince = this.now()
      this.persistState()
    }
  }
  private get statePath(): string {
    return join(this.deps.dir, 'transcribe-state.json')
  }
  private loadState(): void {
    try {
      if (existsSync(this.statePath)) this.state = JSON.parse(readFileSync(this.statePath, 'utf8')) as PersistedState
    } catch { /* corrupt → fresh */ }
  }
  private persistState(): void {
    try {
      writeFileSync(`${this.statePath}.tmp`, JSON.stringify(this.state))
      renameSync(`${this.statePath}.tmp`, this.statePath)
    } catch { /* best-effort */ }
  }
}
