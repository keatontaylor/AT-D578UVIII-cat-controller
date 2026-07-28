// Push notifications for important/urgent traffic — an outbound webhook fired when the
// importance scorer tiers a clip at or above the configured threshold. Two wire formats:
//
//  - `ntfy`: the ntfy.sh publish convention — POST to the topic URL, message in the body,
//    Title/Priority/Tags as headers. Works against ntfy.sh, a self-hosted ntfy, or anything
//    speaking that dialect (priority maps tier 3→5 "urgent", tier 2→4 "high").
//  - `json`: a generic JSON POST carrying the full event (tier, channel, summary, transcript
//    excerpt, clip id) — the shape Home Assistant webhook triggers consume as `trigger.json`,
//    and any generic webhook server can parse.
//
// Enabled solely by ANYTONE_NOTIFY_URL; format auto-detects (host contains "ntfy" → ntfy)
// with ANYTONE_NOTIFY_FORMAT override. Delivery is best-effort fire-and-forget: one retry
// after a short delay, then a log line — a down webhook server must never back-pressure the
// scoring pipeline. A sliding-hour cap guards against a misconfigured guidance file turning
// every clip urgent and flooding a phone.

export type NotifyFormat = 'ntfy' | 'json'

export interface ImportanceNotification {
  readonly clipId: string
  readonly tier: number
  readonly channel: string
  readonly talkgroup?: string | null
  readonly startedAt: number
  readonly reason?: string
  readonly summary?: string
  /** Best available transcript text (clean preferred); truncated before sending. */
  readonly text?: string
}

export interface NotifierConfig {
  readonly url: string | null
  readonly format?: NotifyFormat
  /** Minimum tier that pushes (2 = important+urgent, 3 = urgent only). */
  readonly minTier?: number
  /** Bearer token (ntfy access token, or any server expecting Authorization). */
  readonly token?: string | null
  /** The app's public base URL (e.g. https://host/anytone-v2/) — when set, each event carries a
   * click-through link that opens the UI and plays the clip (`?clip=<id>` deep link). */
  readonly publicUrl?: string | null
  readonly log?: (m: string) => void
  readonly now?: () => number
  readonly fetchFn?: typeof fetch
  readonly retryDelayMs?: number
}

const TEXT_LIMIT = 700
const HOURLY_CAP = 20 // flood guard, not a budget — legitimate emergencies never come this fast
const TIER_LABEL: Record<number, string> = { 2: 'important', 3: 'urgent' }

export function envNotifierConfig(env: NodeJS.ProcessEnv = process.env): NotifierConfig {
  const url = env['ANYTONE_NOTIFY_URL']?.trim() || null
  const fmt = env['ANYTONE_NOTIFY_FORMAT']
  return {
    url,
    ...(fmt === 'ntfy' || fmt === 'json' ? { format: fmt } : {}),
    minTier: Number(env['ANYTONE_NOTIFY_MIN_TIER'] ?? 2),
    token: env['ANYTONE_NOTIFY_TOKEN'] ?? null,
    publicUrl: env['ANYTONE_PUBLIC_URL']?.trim() || null,
  }
}

export class Notifier {
  private readonly sent: number[] = []
  private readonly log: (m: string) => void
  private readonly now: () => number
  private readonly fetchFn: typeof fetch
  readonly format: NotifyFormat
  readonly minTier: number

  constructor(private readonly cfg: NotifierConfig) {
    this.log = cfg.log ?? (() => {})
    this.now = cfg.now ?? Date.now
    this.fetchFn = cfg.fetchFn ?? fetch
    this.minTier = cfg.minTier ?? 2
    this.format = cfg.format ?? (cfg.url && /ntfy/i.test(new URL(cfg.url).host) ? 'ntfy' : 'json')
  }

  get enabled(): boolean {
    return this.cfg.url !== null
  }

  /** Fire-and-forget: filters by tier, never throws, never blocks the caller. */
  notify(n: ImportanceNotification): void {
    if (!this.cfg.url || n.tier < this.minTier) return
    const cutoff = this.now() - 3600_000
    while (this.sent.length && this.sent[0]! < cutoff) this.sent.shift()
    if (this.sent.length >= HOURLY_CAP) {
      this.log(`notify: hourly cap (${HOURLY_CAP}) hit — suppressed ${TIER_LABEL[n.tier] ?? n.tier} on ${n.channel}`)
      return
    }
    this.sent.push(this.now())
    void this.deliver(n).catch((e) => this.log(`notify: delivery failed: ${(e as Error).message}`))
  }

  private async deliver(n: ImportanceNotification): Promise<void> {
    const req = this.buildRequest(n)
    try {
      await this.post(req)
    } catch (e) {
      // one retry — webhook servers (and Pi wifi) hiccup; more than one retry is spam
      await new Promise((r) => setTimeout(r, this.cfg.retryDelayMs ?? 5_000))
      try {
        await this.post(req)
      } catch {
        throw e
      }
    }
  }

  private async post(req: { body: string; headers: Record<string, string> }): Promise<void> {
    const res = await this.fetchFn(this.cfg.url!, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`)
  }

  /** Click-through into the SPA: opens the recordings panel with the clip loaded + playing. */
  private clipLink(clipId: string): string | null {
    const base = this.cfg.publicUrl
    if (!base) return null
    return `${base.replace(/\/+$/, '')}/?clip=${encodeURIComponent(clipId)}`
  }

  private buildRequest(n: ImportanceNotification): { body: string; headers: Record<string, string> } {
    const label = TIER_LABEL[n.tier] ?? `tier ${n.tier}`
    const where = n.talkgroup ? `${n.channel} · ${n.talkgroup}` : n.channel
    const title = `${label.toUpperCase()} — ${where}`
    const message = n.summary || n.reason || n.text?.slice(0, 200) || 'flagged traffic'
    const text = n.text && n.text.length > TEXT_LIMIT ? `${n.text.slice(0, TEXT_LIMIT)}…` : n.text
    const url = this.clipLink(n.clipId)
    const auth: Record<string, string> = this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}
    if (this.format === 'ntfy') {
      return {
        body: text && text !== message ? `${message}\n\n${text}` : message,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          title,
          priority: n.tier >= 3 ? '5' : '4',
          tags: n.tier >= 3 ? 'rotating_light' : 'warning',
          ...(url ? { click: url } : {}),
          ...auth,
        },
      }
    }
    return {
      body: JSON.stringify({
        event: 'importance',
        tier: n.tier,
        tierLabel: label,
        title,
        message,
        channel: n.channel,
        talkgroup: n.talkgroup ?? null,
        clipId: n.clipId,
        startedAt: new Date(n.startedAt).toISOString(),
        reason: n.reason ?? null,
        summary: n.summary ?? null,
        transcript: text ?? null,
        url,
      }),
      headers: { 'content-type': 'application/json', ...auth },
    }
  }
}
