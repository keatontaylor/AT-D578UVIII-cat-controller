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
  /** Request a cleaned-up version of the text in the same call (selective — cleanup roughly
   * doubles output tokens, so short/low-value clips skip it to stay inside free-tier TPD). */
  readonly clean?: boolean
  /** Known metadata to cross-check cleanup against (e.g. the DMR talkgroup name). */
  readonly hints?: string
}

export interface ScoreOutput {
  readonly id: string
  readonly tier: ImportanceTier
  readonly reason: string
  /** Neutral ≤10-word description of what happened in the clip (every clip gets one). */
  readonly summary?: string
  /** Present when cleanup was requested and the model returned one. */
  readonly cleanText?: string
}

export interface ChatReply {
  readonly content: string
  readonly totalTokens: number | null
  readonly remainingTokens: number | null
}

export interface ChatClient {
  /** True → scoreBatch puts the guidance in the SYSTEM prompt (stable across calls, so providers
   * with prefix caching — Claude, ~5-min TTL — pay cache-read prices for the preamble) and sends
   * only the clips as the user message. */
  readonly guidanceInSystem?: boolean
  /** Return the model's response + real token accounting for a JSON-forced prompt. */
  complete(system: string, user: string): Promise<ChatReply>
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
  'For EVERY clip also return "summary": a neutral factual description of what happened, 10 words ' +
  'max, no editorializing (e.g. "Radio check on the Buckhorn repeater", "Two operators discussing ' +
  'antenna projects", "Net preamble and check-ins"). ' +
  'For clips marked "clean":true, ALSO return a cleaned transcript as "cleanText": fix punctuation, ' +
  'capitalization and paragraphing; resolve spoken ITU phonetics into callsigns (e.g. "kilo foxtrot ' +
  'zero whiskey whiskey sierra" -> "KF0WWS"); write ham lingo conventionally ("seventy-three" -> ' +
  '"73", "five nine" -> "5-9", QSL/QSO/QTH uppercase). When more than one speaker is audible ' +
  '(half-duplex turn-taking: "go ahead", replies, dispatch/unit exchanges), break cleanText into ' +
  'one line per transmission with a blank line between turns, and prefix each turn with the ' +
  "speaker's callsign or unit number and a colon when it is identifiable from the words themselves " +
  '("K0NR: ...", "Lincoln 58: ..."); leave the prefix off when the speaker is unclear — never ' +
  'guess an identity. Attribution conventions: a callsign at the END of a transmission is the ' +
  "SPEAKER's own signature (hams sign their own call last; an addressee is named first, as in " +
  '"W1AB this is K2CD" = K2CD speaking TO W1AB) — use signatures to assign turns. Speaker labels ' +
  'must be CALLSIGNS or unit numbers only, never first names — names stay inside the text. ' +
  'cleanText must span the ENTIRE transcript from its first word to its last: never drop, ' +
  'summarize, or truncate any passage. Be CONSERVATIVE: never invent or reword ' +
  'content, never turn garbled fragments into fluent sentences — leave unclear stretches as-is or ' +
  'mark them [unclear]. Preserve every factual detail verbatim. ' +
  'Respond ONLY with a JSON object {"scores":[{"id","tier","reason","summary","cleanText"?}...]} covering every clip id.'

/** Clips-only payload — for providers that carry the guidance in their (cache-eligible) system
 * prompt instead of re-sending it per call. */
export function buildClipsPrompt(clips: ScoreInput[]): string {
  const items = clips.map((c) => ({
    id: c.id,
    channel: c.channel,
    time: new Date(c.startedAt).toISOString().slice(11, 16),
    durationS: Math.round(c.durationMs / 1000),
    recurrence: Number(c.recurrence.toFixed(2)),
    clean: c.clean === true,
    ...(c.hints ? { hints: c.hints } : {}),
    text: c.text.slice(0, 1500),
  }))
  return `CLIPS TO SCORE (JSON):\n${JSON.stringify(items)}`
}

export function buildUserPrompt(guidance: string, clips: ScoreInput[]): string {
  return `USER GUIDANCE:\n${guidance}\n\n${buildClipsPrompt(clips)}`
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
    const o = s as { id?: unknown; tier?: unknown; reason?: unknown; summary?: unknown; cleanText?: unknown }
    if (typeof o.id !== 'string' || !idSet.has(o.id)) continue
    const tier = Number(o.tier)
    if (!TIERS.has(tier)) continue
    out.set(o.id, {
      id: o.id,
      tier: tier as ImportanceTier,
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 120) : '',
      ...(typeof o.summary === 'string' && o.summary.trim() ? { summary: o.summary.slice(0, 140) } : {}),
      ...(typeof o.cleanText === 'string' && o.cleanText.trim() ? { cleanText: o.cleanText.slice(0, 8000) } : {}),
    })
  }
  return out
}

export interface BatchResult {
  readonly scores: Map<string, ScoreOutput>
  /** Real token spend for this call (incl. reasoning tokens), null if the API omitted usage. */
  readonly totalTokens: number | null
  /** Groq's remaining-token-bucket header after this call, null if absent. */
  readonly remainingTokens: number | null
}

export async function scoreBatch(
  chat: ChatClient,
  guidance: string,
  clips: ScoreInput[],
): Promise<BatchResult> {
  if (clips.length === 0) return { scores: new Map(), totalTokens: null, remainingTokens: null }
  const reply = chat.guidanceInSystem
    ? await chat.complete(`${SYSTEM_PROMPT}\n\nUSER GUIDANCE:\n${guidance}`, buildClipsPrompt(clips))
    : await chat.complete(SYSTEM_PROMPT, buildUserPrompt(guidance, clips))
  return {
    scores: parseScores(reply.content, clips.map((c) => c.id)),
    totalTokens: reply.totalTokens,
    remainingTokens: reply.remainingTokens,
  }
}
