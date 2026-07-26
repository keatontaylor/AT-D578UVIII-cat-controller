// Learned per-channel interest for transcription priority — NOTHING hardcoded: a fresh install
// starts flat and engagement shapes it, so any radio's programming works. Signals are explicit
// user actions (PTT, forced transcription, playback); clip VOLUME deliberately never feeds the
// score — busy scanner channels must not self-promote (activity is the queue's fallback ordering,
// not interest). Scores decay exponentially so a quiet month forgets gracefully.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'

export type EngagementKind = 'ptt' | 'force' | 'play'

const WEIGHT: Record<EngagementKind, number> = { ptt: 5, force: 4, play: 1 }
const HALF_LIFE_MS = 14 * 24 * 3600_000
const MAX_AGE_MS = 90 * 24 * 3600_000

interface Event {
  readonly kind: EngagementKind
  readonly channel: string
  readonly at: number
}

export class InterestLearner {
  private events: Event[] = []

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    if (existsSync(path)) {
      try {
        this.events = (JSON.parse(readFileSync(path, 'utf8')) as { events?: Event[] }).events ?? []
      } catch { /* corrupt state file → start flat */ }
    }
  }

  record(kind: EngagementKind, channel: string): void {
    if (!channel) return
    this.events.push({ kind, channel, at: this.now() })
    this.prune()
    this.persist()
  }

  /** Decayed interest score for a channel; 0 = never engaged. */
  scoreOf(channel: string): number {
    const now = this.now()
    let score = 0
    for (const e of this.events) {
      if (e.channel !== channel) continue
      score += WEIGHT[e.kind] * Math.pow(2, -(now - e.at) / HALF_LIFE_MS)
    }
    return score
  }

  private prune(): void {
    const cutoff = this.now() - MAX_AGE_MS
    if (this.events.length > 2000 || (this.events[0] && this.events[0].at < cutoff)) {
      this.events = this.events.filter((e) => e.at >= cutoff).slice(-2000)
    }
  }

  private persist(): void {
    try {
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify({ events: this.events }))
      renameSync(tmp, this.path)
    } catch { /* persistence is best-effort; scores rebuild from future events */ }
  }
}
