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

// NO PRIMER — bake-off 2 verdict (2026-07-28, 5 clip types + 6 prompt candidates vs ground
// truth): the empty prompt beat every primer and every glossary/header/roster candidate on
// content fidelity and confidence, and primers actively INJECTED their fake callsigns into real
// transcripts on long noisy clips. Callsign formatting (KL-7GLK -> KL7GLK) is the cleanup
// stage's job. buildPrompt/scrub/echo plumbing stays so a primer can be re-tried cheaply — with
// an empty prompt the scrubber and echo guard are dormant no-ops.
export const PROMPT_BASE = ''

export function buildPrompt(_channelName: string | null, _talkgroupName: string | null): string {
  return PROMPT_BASE
}

/** Excise verbatim prompt bleed: any run of >=4 consecutive (normalized) words of the per-clip
 * bias prompt appearing inside a transcript — Whisper fills noisy gaps with primer phrases
 * (field: 147 archive sidecars). Deterministic; matched against the FULL built prompt because
 * the channel name is woven in and bleeds with it ("5-9 on COLCON DENVER"). */
export function scrubPromptBleed(text: string, prompt: string): { text: string; hits: number } {
  // number-word normalization: Whisper may render primer digits as words ("five nine" for 5-9)
  const NUM: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' }
  const canon = (w: string): string => NUM[w] ?? w
  const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim().split(/\s+/).filter(Boolean).map(canon)
  const P = words(prompt)
  const toks: { w: string; start: number; end: number }[] = []
  const re = /[a-zA-Z0-9']+/g
  let m
  while ((m = re.exec(text))) toks.push({ w: canon(m[0].toLowerCase()), start: m.index, end: m.index + m[0].length })
  const spans: { from: number; to: number }[] = []
  for (let i = 0; i < toks.length; i++) {
    let best = 0
    for (let p = 0; p < P.length; p++) {
      let k = 0
      while (p + k < P.length && i + k < toks.length && toks[i + k]!.w === P[p + k]) k++
      if (k > best) best = k
    }
    if (best >= 4) {
      spans.push({ from: toks[i]!.start, to: toks[i + best - 1]!.end })
      i += best - 1
    }
  }
  if (!spans.length) return { text, hits: 0 }
  let out = ''
  let pos = 0
  for (const s of spans) {
    out += text.slice(pos, s.from)
    pos = s.to
    while (pos < text.length && /[ ,.—-]/.test(text[pos]!)) pos++
  }
  out += text.slice(pos)
  return { text: out.replace(/[ \t]{2,}/g, ' ').replace(/ ([,.])/g, '$1').trim(), hits: spans.length }
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
