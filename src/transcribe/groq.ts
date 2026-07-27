// Groq Whisper client (OpenAI-compatible audio/transcriptions endpoint). Bake-off-derived
// settings (2026-07-26, 30-clip corpus test): temperature 0, verbose_json for per-segment
// confidence, ham-radio prompt biasing with the clip's channel/talkgroup. The PROMPT-ECHO guard
// exists because Whisper parrots the bias prompt back on no-speech audio (observed live:
// "Channel COLCON DENVER." transcripts on noise clips).

export interface GroqSegment {
  readonly startS: number
  readonly endS: number
  readonly text: string
}

export interface GroqResult {
  readonly text: string
  readonly segments: GroqSegment[]
  readonly avgLogprob: number | null
  readonly maxNoSpeechProb: number | null
  readonly apiMs: number
}

/** Thrown on 429 / daily-quota exhaustion — the caller defers rather than fails. */
export class GroqQuotaError extends Error {
  constructor(readonly retryAfterS: number) {
    super(`groq quota exhausted (retry after ${retryAfterS}s)`)
    this.name = 'GroqQuotaError'
  }
}

export interface GroqOptions {
  readonly key: string
  readonly model: string
  readonly prompt: string
  readonly fetchImpl?: typeof fetch
  readonly endpoint?: string
}

// Whisper treats the prompt as PRECEDING TRANSCRIPT, not instructions — it mimics what it sees.
// So this is a fake exchange written in the exact style we want out: callsign shapes (K0/W0/KF0
// prefixes), ham lingo as numerals ("73", "5-9"), local proper nouns, punctuation. ~60 tokens,
// leaving prompt budget for the per-clip channel/talkgroup context line.
export const PROMPT_BASE =
  "KF0WWS, this is K0NR, you're 5-9 into the Colorado Connection. QSL on the QTH, I'm simplex " +
  'from Longmont, 5 watts to a J-pole. 73 to you and the SKYWARN net, W0ABC clear on the repeater.'

export function buildPrompt(channelName: string | null, talkgroupName: string | null): string {
  const ctx = [
    channelName ? `Channel ${channelName}.` : null,
    talkgroupName && talkgroupName !== 'None' ? `Talkgroup ${talkgroupName}.` : null,
  ].filter(Boolean).join(' ')
  return ctx ? `${PROMPT_BASE} ${ctx}` : PROMPT_BASE
}

/** True when the transcript is (mostly) the bias prompt echoed back — a no-speech hallucination,
 * not a transcription. Compared on lowercased alphanumerics so punctuation differences don't hide
 * the echo. */
export function isPromptEcho(text: string, prompt: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const t = norm(text)
  if (!t) return false
  if (norm(prompt).includes(t)) return true
  // "Channel X." style echoes: a single short sentence that is a substring of the prompt context
  return t.split(' ').length <= 4 && norm(prompt).includes(t)
}

export async function transcribe(wav: Buffer, opts: GroqOptions): Promise<GroqResult> {
  const doFetch = opts.fetchImpl ?? fetch
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'clip.wav')
  form.append('model', opts.model)
  form.append('temperature', '0')
  form.append('language', 'en')
  form.append('response_format', 'verbose_json')
  form.append('prompt', opts.prompt)
  const t0 = Date.now()
  const res = await doFetch(opts.endpoint ?? 'https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.key}` },
    body: form,
    signal: AbortSignal.timeout(90_000), // a hung upload must never wedge the queue (busy flag)
  })
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'))
    throw new GroqQuotaError(Number.isFinite(ra) ? ra : 60)
  }
  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as {
    text?: string
    segments?: { start: number; end: number; text: string; avg_logprob: number; no_speech_prob: number }[]
  }
  const segs = body.segments ?? []
  return {
    text: (body.text ?? '').trim(),
    segments: segs.map((s) => ({ startS: s.start, endS: s.end, text: s.text.trim() })),
    avgLogprob: segs.length ? segs.reduce((a, s) => a + s.avg_logprob, 0) / segs.length : null,
    maxNoSpeechProb: segs.length ? Math.max(...segs.map((s) => s.no_speech_prob)) : null,
    apiMs: Date.now() - t0,
  }
}

// ── Chat completion (importance scoring) — same key/base, separate chat quota. ────────────────
export interface GroqChatOptions {
  readonly key: string
  readonly model: string
  /** For reasoning models (gpt-oss-*): cap deliberation — classification needs none, and hidden
   * reasoning tokens are what blew past our token estimates (the field-observed 429 storms). */
  readonly reasoningEffort?: 'low' | 'medium' | 'high'
  readonly fetchImpl?: typeof fetch
  readonly endpoint?: string
}

/** The reply plus the ACTUAL token accounting — estimates cannot see reasoning tokens, so the
 * caller's budgets must be fed from these, not from chars/4 guesses. */
export interface ChatReply {
  readonly content: string
  /** usage.total_tokens from the response body (real spend incl. reasoning), or null. */
  readonly totalTokens: number | null
  /** x-ratelimit-remaining-tokens header — Groq's own view of what's left in the bucket. */
  readonly remainingTokens: number | null
}

/** JSON-forced chat completion. Throws GroqQuotaError on 429 so the caller defers the batch. */
export async function chatComplete(system: string, user: string, opts: GroqChatOptions): Promise<ChatReply> {
  const doFetch = opts.fetchImpl ?? fetch
  const payload: Record<string, unknown> = {
    model: opts.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }
  if (opts.reasoningEffort) payload['reasoning_effort'] = opts.reasoningEffort
  let res = await doFetch(opts.endpoint ?? 'https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.key}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45_000),
  })
  if (res.status === 400 && opts.reasoningEffort) {
    // model/param mismatch (lineup rotates) — retry once without the reasoning knob
    const errText = await res.text()
    if (/reasoning/i.test(errText)) {
      delete payload['reasoning_effort']
      res = await doFetch(opts.endpoint ?? 'https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.key}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45_000),
      })
    } else {
      throw new Error(`groq chat 400: ${errText.slice(0, 200)}`)
    }
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'))
    throw new GroqQuotaError(Number.isFinite(ra) ? ra : 60)
  }
  if (!res.ok) throw new Error(`groq chat ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: { total_tokens?: number }
  }
  const remaining = Number(res.headers.get('x-ratelimit-remaining-tokens'))
  return {
    content: body.choices?.[0]?.message?.content ?? '',
    totalTokens: typeof body.usage?.total_tokens === 'number' ? body.usage.total_tokens : null,
    remainingTokens: Number.isFinite(remaining) ? remaining : null,
  }
}
