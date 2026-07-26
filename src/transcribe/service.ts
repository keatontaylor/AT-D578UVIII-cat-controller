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
import { buildPrompt, isPromptEcho, transcribe as groqTranscribe, chatComplete, GroqQuotaError, type GroqResult } from './groq'
import { InterestLearner, type EngagementKind } from './learner'
import { recurrenceScore, scoreBatch, type ChatClient, type ImportanceTier, type ScoreInput } from './importance'

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
  status: 'done' | 'skipped' | 'failed'
  reason?: string
  model?: string
  text?: string
  segments?: { startMs: number; endMs: number; text: string }[]
  flags?: string[]
  avgLogprob?: number | null
  trim?: { startMs: number; endMs: number; speechMs: number }
  billedS?: number
  transcribedAt?: string
  /** Importance (stage 2) — added after scoring; absent = not yet scored, 0 = routine. */
  importance?: ImportanceTier
  importanceReason?: string
  /** Neutral one-line "what happened" description (every scored clip). */
  summary?: string
  /** LLM-cleaned transcript (formatting, phonetics→callsigns, lingo) — `text` above stays the
   * verbatim Whisper output; the UI prefers cleanText when present. */
  cleanText?: string
}

export interface TranscriberEvent {
  readonly id: string
  readonly status: TranscriptStatus
  /** Set when the event is an importance-score update (status stays 'done'). */
  readonly importance?: ImportanceTier
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
  /** Estimated chat tokens spent today (importance/cleanup batches; chars/4 heuristic). */
  chatDay?: string
  chatTokens?: number
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
// Importance scoring + text cleanup (stage 2): ONE batched call over the Groq CHAT endpoint
// (separate quota from Whisper) returns tier/reason AND a cleaned transcript for selected clips.
// Cleanup roughly doubles output tokens, so it is SELECTIVE (length/duration floor) and the
// binding free-tier constraint becomes tokens-per-day — tracked with an estimated budget; under
// pressure cleanup is stripped BEFORE scoring is sacrificed (triage is the mission, pretty text
// is the enhancement). Model env-overridable; on non-quota failure one retry on the fallback.
const IMPORTANCE = {
  model: process.env['ANYTONE_IMPORTANCE_MODEL'] ?? 'openai/gpt-oss-120b',
  fallbackModel: process.env['ANYTONE_IMPORTANCE_FALLBACK'] ?? 'llama-3.1-8b-instant',
  batchSize: 15,
  batchWindowMs: 5 * 60_000, // score after 15 clips OR 5 minutes, whichever first
  recurrenceLookback: 40, // prior same-channel transcripts compared for the scheduled-preamble flag
  enabled: process.env['ANYTONE_IMPORTANCE'] !== '0',
  cleanMinChars: 80, // selective cleanup floor: short blurts don't need pretty formatting
  cleanMinDurationMs: 8_000,
  dailyTokenCap: Number(process.env['ANYTONE_IMPORTANCE_DAILY_TOKENS'] ?? 150_000), // est., margin under free TPD
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
  /** Importance scorer chat client; default = Groq chat. Null-returning key disables scoring. */
  readonly chatClient?: ChatClient
  /** Reads the user-editable importance guidance; default = data/importance-guidance.md. */
  readonly guidanceFn?: () => string
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

const GUIDANCE_PATH = new URL('../../data/importance-guidance.md', import.meta.url)
const GUIDANCE_FALLBACK =
  'Important: severe weather reports, public-safety/emergency traffic, real net activations, ' +
  'unusual activity on a quiet channel. Not important: routine nets and their scripted preambles ' +
  '(even when they mention emergencies), ragchews, radio checks, drills announced as drills. ' +
  'Tiers: 0 routine, 1 notable, 2 important, 3 urgent. When unsure, pick the lower tier.'
function defaultGuidance(): string {
  try {
    return readFileSync(GUIDANCE_PATH, 'utf8')
  } catch {
    return GUIDANCE_FALLBACK
  }
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
  private readonly chat: ChatClient | null
  private readonly guidanceFn: () => string
  /** Ids awaiting importance scoring (transcript done), flushed in batches. */
  private readonly scoreQueue: string[] = []
  private scoreDeferUntil = 0
  private oldestScoreAt = 0
  private scoring = false
  /** Rolling buffer of recently-transcribed clips (newest first, capped) — supplies the score
   * inputs' channel/time and the per-channel recurrence history. In-memory: recurrence detection
   * spans the current session (sessions run for days), not restarts. */
  private readonly recentDone: { id: string; channel: string; startedAt: number; text: string; talkgroupName?: string }[] = []

  constructor(private readonly deps: TranscriberDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
    this.doTranscribe = deps.transcribeFn ?? groqTranscribe
    this.keyFn = deps.keyFn ?? defaultKey
    this.model = deps.model ?? DEFAULTS.model
    this.guidanceFn = deps.guidanceFn ?? defaultGuidance
    this.chat = deps.chatClient ?? (IMPORTANCE.enabled ? this.makeGroqChat() : null)
    this.learner = new InterestLearner(join(deps.dir, 'transcribe-learner.json'), this.now)
    this.loadState()
    if (deps.startTimer !== false) {
      this.timer = setInterval(() => void this.tick(), DEFAULTS.tickMs)
      this.timer.unref?.()
    }
  }

  private makeGroqChat(model = IMPORTANCE.model): ChatClient {
    return {
      complete: (system, user) => {
        const key = this.keyFn()
        if (!key) throw new Error('no key')
        return chatComplete(system, user, { key, model })
      },
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

  /** One scheduling step: transcribe the best queued clip, and flush the importance-score batch
   * when it's full or the batch window has elapsed. Public for tests. */
  async tick(): Promise<void> {
    await this.maybeScore()
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

  // ── importance scoring (stage 2, batched) ─────────────────────────────────────
  private enqueueScore(id: string): void {
    if (!this.chat) return
    if (this.scoreQueue.length === 0) this.oldestScoreAt = this.now()
    this.scoreQueue.push(id)
  }

  private async maybeScore(): Promise<void> {
    if (this.scoring || !this.chat || this.scoreQueue.length === 0) return
    if (this.now() < this.scoreDeferUntil) return
    const full = this.scoreQueue.length >= IMPORTANCE.batchSize
    const windowUp = this.now() - this.oldestScoreAt >= IMPORTANCE.batchWindowMs
    if (!full && !windowUp) return
    const batch = this.scoreQueue.splice(0, IMPORTANCE.batchSize)
    if (this.scoreQueue.length) this.oldestScoreAt = this.now()
    this.scoring = true
    try {
      await this.scoreBatchNow(batch)
    } finally {
      this.scoring = false
    }
  }

  /** Score (and selectively clean) a batch of transcribed clips; patch sidecars in place. */
  private async scoreBatchNow(ids: string[]): Promise<void> {
    let inputs: ScoreInput[] = []
    for (const id of ids) {
      const rec = this.recentDone.find((r) => r.id === id)
      const side = this.sidecar(id)
      if (!rec || !side || side.status !== 'done' || !side.text) continue
      const priors = this.recentDone.filter((r) => r.channel === rec.channel && r.id !== id).slice(0, IMPORTANCE.recurrenceLookback).map((r) => r.text)
      const durationMs = (side.trim?.endMs ?? 0) - (side.trim?.startMs ?? 0)
      inputs.push({
        id,
        channel: rec.channel,
        startedAt: rec.startedAt,
        durationMs,
        text: side.text,
        recurrence: recurrenceScore(side.text, priors),
        clean: side.text.length >= IMPORTANCE.cleanMinChars && durationMs >= IMPORTANCE.cleanMinDurationMs,
        ...(rec.talkgroupName ? { hints: `talkgroup: ${rec.talkgroupName}` } : {}),
      })
    }
    if (inputs.length === 0) return
    // Token-budget degradation: cleanup output ≈ the transcript itself; when today's estimated
    // chat-token spend is over the cap, strip cleanup — scoring output is tiny and always fits.
    const estTokens = Math.ceil((this.guidanceFn().length + inputs.reduce((a, i) => a + i.text.length * (i.clean ? 2 : 1), 0)) / 4) + 500 + inputs.length * 25 /* summaries */
    this.rollChat()
    if ((this.state.chatTokens ?? 0) + estTokens > IMPORTANCE.dailyTokenCap && inputs.some((i) => i.clean)) {
      inputs = inputs.map((i) => ({ ...i, clean: false }))
      this.log('transcriber: chat token budget low — scoring without cleanup this batch')
    }
    let scores
    try {
      scores = await scoreBatch(this.chat!, this.guidanceFn(), inputs)
    } catch (e) {
      if (e instanceof GroqQuotaError) {
        this.scoreQueue.unshift(...ids) // re-queue whole batch; retry after cooldown
        this.scoreDeferUntil = this.now() + Math.max(30, e.retryAfterS) * 1000
        this.log(`transcriber: importance 429 — deferring batch (${new Date(this.scoreDeferUntil).toISOString()})`)
        return
      }
      // Primary model hiccup (bad output, 5xx, retired model): one retry on the fallback,
      // scoring-only — triage survives even when the good model is unavailable.
      this.log(`transcriber: importance scoring failed on ${IMPORTANCE.model}: ${(e as Error).message} — retrying on ${IMPORTANCE.fallbackModel}`)
      try {
        scores = await scoreBatch(this.deps.chatClient ?? this.makeGroqChat(IMPORTANCE.fallbackModel), this.guidanceFn(), inputs.map((i) => ({ ...i, clean: false })))
      } catch (e2) {
        this.log(`transcriber: importance fallback failed: ${(e2 as Error).message}`)
        return // unscored clips stay tier-absent (routine); no retry storm
      }
    }
    this.spendChat(estTokens)
    for (const input of inputs) {
      const s = scores.get(input.id) ?? { id: input.id, tier: 0 as ImportanceTier, reason: '' }
      const side = this.sidecar(input.id)
      if (!side) continue
      side.importance = s.tier
      side.importanceReason = s.reason
      if (s.summary) side.summary = s.summary
      if (s.cleanText) side.cleanText = s.cleanText
      this.writeSidecar(input.id, side)
      this.emit({ id: input.id, status: side.status, importance: s.tier })
    }
    const notable = inputs.filter((i) => (scores.get(i.id)?.tier ?? 0) >= 2).length
    const cleaned = inputs.filter((i) => scores.get(i.id)?.cleanText).length
    this.log(`transcriber: scored ${inputs.length} clip(s)${cleaned ? `, cleaned ${cleaned}` : ''}${notable ? `, ${notable} important+` : ''}`)
  }

  private rollChat(): void {
    if (this.state.chatDay !== this.dayKey()) {
      this.state.chatDay = this.dayKey()
      this.state.chatTokens = 0
    }
  }
  private spendChat(tokens: number): void {
    this.rollChat()
    this.state.chatTokens = (this.state.chatTokens ?? 0) + tokens
    this.persistState()
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
    // Record for scoring context BEFORE finishing (recurrence history + score inputs).
    this.recentDone.unshift({ id: clip.id, channel: clip.channelName ?? '', startedAt: clip.startedAt, text: result.text, ...(clip.talkgroupName ? { talkgroupName: clip.talkgroupName } : {}) })
    if (this.recentDone.length > 500) this.recentDone.length = 500
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
    this.enqueueScore(clip.id)
    this.log(`transcriber: ${clip.id} done (${billedS.toFixed(1)}s billed, ${result.apiMs}ms${flags.length ? `, ${flags.join(',')}` : ''})`)
  }

  private writeSidecar(id: string, sidecar: TranscriptSidecar): void {
    const path = join(this.deps.dir, `${id}.transcript.json`)
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(sidecar))
      renameSync(`${path}.tmp`, path)
    } catch (e) {
      this.log(`transcriber: sidecar write failed for ${id}: ${(e as Error).message}`)
    }
    this.sidecarCache.set(id, sidecar)
  }

  private finish(id: string, sidecar: TranscriptSidecar): void {
    this.writeSidecar(id, sidecar)
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

  /** Per-clip status + importance tier for merging into recordings.list — scans the dir once.
   * Only tier ≥1 is included (0/absent = routine, the UI default). */
  statuses(): Record<string, { status: TranscriptStatus; importance?: ImportanceTier }> {
    const out: Record<string, { status: TranscriptStatus; importance?: ImportanceTier }> = {}
    try {
      for (const f of readdirSync(this.deps.dir)) {
        if (!f.endsWith('.transcript.json')) continue
        const id = f.slice(0, -'.transcript.json'.length)
        const s = this.sidecar(id)
        if (s) out[id] = { status: s.status, ...(s.importance ? { importance: s.importance } : {}) }
      }
    } catch { /* dir unreadable → statuses from queue only */ }
    for (const [id, item] of this.queue) out[id] = { status: item.deferred && this.now() < this.resumeAt ? 'deferred' : 'queued' }
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
