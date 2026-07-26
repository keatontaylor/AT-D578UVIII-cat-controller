// Importance scoring — stage 2 of the transcript pipeline. A cheap LOCAL recurrence flag (kills
// the scheduled-preamble false-positive class the keyword approach can't) + a BATCHED LLM
// adjudication over the Groq chat endpoint (same key as transcription; separate chat quota).
// Batching is both quota engineering (~40-75 req/day vs ~750 per-clip) and better judgment: the
// model sees a contiguous traffic window, so it reads conversations-across-overs and recurring
// announcements in context. Pure scoring logic + client here; the queue/lifecycle lives in the
// Transcriber ([[transcription-pipeline]]).

export type ImportanceTier = 0 | 1 | 2 | 3

export interface ScoreInput {
  readonly id: string
  readonly channel: string
  readonly startedAt: number
  readonly durationMs: number
  readonly text: string
  /** 0-1: max n-gram similarity to recent transcripts on the SAME channel (recurrence = preamble).
   * Computed locally, passed to the model as context so it can discount scheduled announcements. */
  readonly recurrence: number
}

export interface ScoreOutput {
  readonly id: string
  readonly tier: ImportanceTier
  readonly reason: string
}

export interface ChatClient {
  /** Return the model's raw text response to a JSON-forced prompt. */
  complete(system: string, user: string): Promise<string>
}

// ── local recurrence detection ────────────────────────────────────────────────
function shingles(text: string, k = 4): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i + k <= words.length; i++) out.add(words.slice(i, i + k).join(' '))
  if (out.size === 0 && words.length) out.add(words.join(' '))
  return out
}

/** Jaccard similarity of 4-word shingles — cheap, robust to small ASR differences between two
 * recordings of the same scripted announcement. */
export function textSimilarity(a: string, b: string): number {
  const sa = shingles(a)
  const sb = shingles(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const s of sa) if (sb.has(s)) inter++
  return inter / (sa.size + sb.size - inter)
}

/** Max similarity of `text` against prior transcripts from the same channel. */
export function recurrenceScore(text: string, priorSameChannel: string[]): number {
  let max = 0
  for (const p of priorSameChannel) {
    const s = textSimilarity(text, p)
    if (s > max) max = s
    if (max > 0.95) break
  }
  return max
}

// ── LLM adjudication ──────────────────────────────────────────────────────────
export const SYSTEM_PROMPT =
  'You triage amateur-radio voice transcripts for a hobbyist monitoring tool. For each clip, ' +
  'assign an importance tier 0-3 and a one-line reason (max ~12 words). Judge by the user guidance ' +
  'below. Transcripts are auto-generated and may contain errors; do not over-read garbled text. ' +
  'When uncertain between two tiers, choose the LOWER. A high "recurrence" value means the text ' +
  'closely matches earlier clips on that channel — almost always a scheduled/scripted announcement ' +
  '(e.g. a nightly net preamble) and should be tier 0 even if it mentions emergencies. ' +
  'Respond ONLY with a JSON object {"scores":[{"id","tier","reason"}...]} covering every clip id.'

export function buildUserPrompt(guidance: string, clips: ScoreInput[]): string {
  const items = clips.map((c) => ({
    id: c.id,
    channel: c.channel,
    time: new Date(c.startedAt).toISOString().slice(11, 16),
    durationS: Math.round(c.durationMs / 1000),
    recurrence: Number(c.recurrence.toFixed(2)),
    text: c.text.slice(0, 1500),
  }))
  return `USER GUIDANCE:\n${guidance}\n\nCLIPS TO SCORE (JSON):\n${JSON.stringify(items)}`
}

const TIERS: ReadonlySet<number> = new Set([0, 1, 2, 3])

/** Parse the model's JSON, tolerating code fences / prose wrapping, into id→score. Missing or
 * malformed entries are simply absent (caller treats absence as tier 0). */
export function parseScores(raw: string, ids: string[]): Map<string, ScoreOutput> {
  const out = new Map<string, ScoreOutput>()
  const idSet = new Set(ids)
  let json = raw.trim()
  const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) json = fence[1]!.trim()
  const braceStart = json.indexOf('{')
  const braceEnd = json.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) json = json.slice(braceStart, braceEnd + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return out
  }
  const scores = (parsed as { scores?: unknown }).scores
  if (!Array.isArray(scores)) return out
  for (const s of scores) {
    const o = s as { id?: unknown; tier?: unknown; reason?: unknown }
    if (typeof o.id !== 'string' || !idSet.has(o.id)) continue
    const tier = Number(o.tier)
    if (!TIERS.has(tier)) continue
    out.set(o.id, { id: o.id, tier: tier as ImportanceTier, reason: typeof o.reason === 'string' ? o.reason.slice(0, 120) : '' })
  }
  return out
}

export async function scoreBatch(
  chat: ChatClient,
  guidance: string,
  clips: ScoreInput[],
): Promise<Map<string, ScoreOutput>> {
  if (clips.length === 0) return new Map()
  const raw = await chat.complete(SYSTEM_PROMPT, buildUserPrompt(guidance, clips))
  return parseScores(raw, clips.map((c) => c.id))
}
