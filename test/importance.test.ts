// Importance scoring: local recurrence detection, prompt/parse robustness, and the batched
// scorer wired through a fake chat client. Also the Transcriber's batch lifecycle (window/size
// flush, 429 deferral, sidecar patch + push).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  textSimilarity, recurrenceScore, parseScores, buildUserPrompt, scoreBatch,
  type ChatClient, type ScoreInput,
} from '../src/transcribe/importance'
import { Transcriber, type TranscribableClip, type TranscriptSidecar } from '../src/transcribe/service'
import { analyzeSpeech, parseWav } from '../src/transcribe/trim'
import { wavHeader } from '../src/audio/recorder'

const reply = (content: string) => ({ content, totalTokens: null, remainingTokens: null })

const RATE = 8000
function speechWav(seconds = 4): Buffer {
  const n = Math.round(seconds * RATE)
  const pcm = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 700 * i) / RATE) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / RATE))), i * 2)
  }
  return Buffer.concat([wavHeader(pcm.length), pcm])
}

test('recurrence: near-identical scripts match, distinct traffic does not', () => {
  const preamble = 'This is the nightly Colorado Connection net we practice copying information to report an emergency to 911'
  const preamble2 = 'This is the nightly Colorado Connection net, we practice copying the information to report an emergency to 9 1 1'
  const ragchew = 'Yeah I finally got that new antenna up on the tower this weekend works great'
  assert.ok(textSimilarity(preamble, preamble2) > 0.4, 'same script across two recordings')
  assert.ok(textSimilarity(preamble, ragchew) < 0.05, 'different content')
  assert.ok(recurrenceScore(preamble2, [ragchew, preamble]) > 0.4)
  assert.equal(recurrenceScore(ragchew, [preamble, preamble2]), 0)
})

test('parseScores: tolerates fences/prose, drops unknown ids and bad tiers, keeps cleanText', () => {
  const ids = ['a', 'b', 'c']
  const raw = 'Here you go:\n```json\n{"scores":[{"id":"a","tier":3,"reason":"mayday in progress","summary":"Firefighter mayday during structure fire","cleanText":"Mayday, mayday, firefighter down."},{"id":"b","tier":9,"reason":"bad"},{"id":"zzz","tier":2,"reason":"unknown"},{"id":"c","tier":0,"reason":"routine"}]}\n```'
  const m = parseScores(raw, ids)
  assert.equal(m.get('a')!.tier, 3)
  assert.equal(m.get('a')!.reason, 'mayday in progress')
  assert.equal(m.get('a')!.summary, 'Firefighter mayday during structure fire')
  assert.equal(m.get('a')!.cleanText, 'Mayday, mayday, firefighter down.')
  assert.equal(m.get('c')!.cleanText, undefined, 'no cleanText when model omits it')
  assert.equal(m.has('b'), false, 'tier 9 rejected')
  assert.equal(m.has('zzz'), false, 'unknown id rejected')
  assert.equal(m.get('c')!.tier, 0)
  assert.equal(parseScores('not json at all', ids).size, 0)
})

test('buildUserPrompt: embeds guidance + clip context incl. recurrence', () => {
  const clips: ScoreInput[] = [{ id: 'x', channel: 'COLCON', startedAt: 0, durationMs: 4000, text: 'test', recurrence: 0.9 }]
  const p = buildUserPrompt('MY GUIDANCE HERE', clips)
  assert.ok(p.includes('MY GUIDANCE HERE'))
  assert.ok(p.includes('"recurrence":0.9'))
  assert.ok(p.includes('COLCON'))
})

test('scoreBatch: maps model output back onto clip ids', async () => {
  const chat: ChatClient = {
    complete: async () => reply(JSON.stringify({ scores: [{ id: 'c1', tier: 2, reason: 'funnel cloud reported' }, { id: 'c2', tier: 0, reason: 'radio check' }] })),
  }
  const out = await scoreBatch(chat, 'g', [
    { id: 'c1', channel: 'A', startedAt: 0, durationMs: 5000, text: 'funnel cloud on the ground', recurrence: 0 },
    { id: 'c2', channel: 'A', startedAt: 0, durationMs: 3000, text: 'radio check', recurrence: 0 },
  ])
  assert.equal(out.scores.get('c1')!.tier, 2)
  assert.equal(out.scores.get('c2')!.tier, 0)
})

// ── Transcriber batch lifecycle ───────────────────────────────────────────────
function rig(chat: ChatClient) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-'))
  const clock = { t: Date.UTC(2026, 6, 26, 12, 0, 0) }
  const events: { id: string; status: string; importance?: number }[] = []
  const svc = new Transcriber({
    dir, recorderEnabled: () => true, now: () => clock.t, keyFn: () => 'k', startTimer: false,
    guidanceFn: () => 'test guidance',
    chatClient: chat,
    transcribeFn: async () => ({
      text: 'This is K0BUL with a funnel cloud report near Longmont, wall cloud rotating to the northeast, requesting SKYWARN net control acknowledge.',
      segments: [{ startS: 0.2, endS: 3, text: 'This is K0BUL with a funnel cloud report near Longmont.' }],
      avgLogprob: -0.2, maxNoSpeechProb: 0.05, apiMs: 100,
    }),
  })
  svc.subscribe((e) => events.push(e))
  return { svc, dir, clock, events }
}
function saveClip(svc: Transcriber, dir: string, id: string, seconds = 4): TranscribableClip {
  const wav = speechWav(seconds)
  writeFileSync(join(dir, `${id}.wav`), wav)
  const clip = { id, startedAt: 1, durationMs: analyzeSpeech(parseWav(wav)).durationMs, channelName: 'COLCON DENVER' }
  svc.onClipSaved(clip)
  return clip
}

test('transcriber: batch flushes on window elapse and patches sidecar + pushes tier', async () => {
  let batchIds: string[] = []
  const { svc, dir, clock, events } = rig({
    complete: async (_s, user) => {
      batchIds = (JSON.parse(user.split('CLIPS TO SCORE (JSON):\n')[1]!) as { id: string }[]).map((c) => c.id)
      return reply(JSON.stringify({ scores: batchIds.map((id) => ({ id, tier: 2, reason: 'weather report' })) }))
    },
  })
  saveClip(svc, dir, 'w1')
  await svc.tick() // transcribe → enqueues for scoring
  assert.equal(svc.transcript('w1')!.status, 'done')
  assert.equal(svc.transcript('w1')!.importance, undefined, 'not scored before the batch window')
  clock.t += 6 * 60_000 // past the 5-min batch window
  await svc.tick() // flush the score batch
  const side = svc.transcript('w1') as TranscriptSidecar
  assert.equal(side.importance, 2)
  assert.equal(side.importanceReason, 'weather report')
  assert.ok(events.some((e) => e.id === 'w1' && e.importance === 2), 'tier pushed to clients')
  // the persisted sidecar carries it too
  assert.equal((JSON.parse(readFileSync(join(dir, 'w1.transcript.json'), 'utf8')) as TranscriptSidecar).importance, 2)
})

test('transcriber: primary 429 fails over to the fallback IN THE SAME FLUSH (scoring-only)', async () => {
  const { GroqQuotaError } = await import('../src/transcribe/groq')
  let calls = 0
  let fallbackSawClean: boolean | null = null
  const { svc, dir, clock } = rig({
    complete: async (_s, user) => {
      calls++
      if (calls === 1) throw new GroqQuotaError(600) // primary: daily pool drained
      const items = JSON.parse(user.split('CLIPS TO SCORE (JSON):\n')[1]!) as { id: string; clean: boolean }[]
      fallbackSawClean = items.some((i) => i.clean)
      return reply(JSON.stringify({ scores: items.map((i) => ({ id: i.id, tier: 1, reason: 'notable' })) }))
    },
  })
  saveClip(svc, dir, 's1', 10)
  await svc.tick()
  clock.t += 25_000
  await svc.tick() // primary 429 → immediate fallback → scored, no stall
  assert.equal(calls, 2, 'fallback called in the same flush')
  assert.equal(svc.transcript('s1')!.importance, 1, 'scored via fallback')
  assert.equal(fallbackSawClean, false, 'cleanup stripped on the fallback path')
  // during the starvation window the primary is not re-attempted
  saveClip(svc, dir, 's2', 10)
  await svc.tick()
  clock.t += 25_000
  await svc.tick()
  assert.equal(calls, 3, 'straight to fallback while primary starved (one call, not two)')
  assert.equal(svc.transcript('s2')!.importance, 1)
})

test('transcriber: BOTH models quota-limited → batch re-queued, retried later', async () => {
  const { GroqQuotaError } = await import('../src/transcribe/groq')
  let calls = 0
  const { svc, dir, clock } = rig({
    complete: async () => {
      calls++
      if (calls <= 2) throw new GroqQuotaError(60) // primary AND fallback both dry
      return reply(JSON.stringify({ scores: [{ id: 'q1', tier: 0, reason: 'r' }] }))
    },
  })
  saveClip(svc, dir, 'q1')
  await svc.tick()
  clock.t += 25_000
  await svc.tick() // primary 429 → fallback 429 → deferred
  assert.equal(calls, 2)
  assert.equal(svc.transcript('q1')!.importance, undefined, 'unscored but retained in the queue')
  clock.t += 120_000 // past the fallback cooldown (primary still starved → fallback again)
  await svc.tick()
  assert.equal(svc.transcript('q1')!.importance, 0, 'scored once quota returns')
})

test('transcriber: cleanup requested for long clips, cleanText persisted + verbatim kept', async () => {
  let sawClean = false
  const { svc, dir, clock } = rig({
    complete: async (_s, user) => {
      const items = JSON.parse(user.split('CLIPS TO SCORE (JSON):\n')[1]!) as { id: string; clean: boolean }[]
      sawClean = items.some((i) => i.clean)
      return reply(JSON.stringify({ scores: items.map((i) => ({ id: i.id, tier: 0, reason: 'ragchew', summary: 'Weather report ragchew', cleanText: 'This is K0BUL with a funnel cloud report near Longmont.' })) }))
    },
  })
  saveClip(svc, dir, 'short1', 4) // under the 8s clean floor
  await svc.tick()
  clock.t += 6 * 60_000
  await svc.tick()
  assert.equal(sawClean, false, 'short clip not marked for cleanup')

  saveClip(svc, dir, 'long1', 10) // over the floor → cleanup requested
  await svc.tick()
  clock.t += 6 * 60_000
  await svc.tick()
  assert.equal(sawClean, true, 'long clip marked for cleanup')
  const side = svc.transcript('long1') as TranscriptSidecar
  assert.ok(side.text && side.text.includes('funnel'), 'verbatim Whisper text preserved')
  assert.equal(side.cleanText, 'This is K0BUL with a funnel cloud report near Longmont.', 'cleanText persisted alongside verbatim')
  assert.equal(side.summary, 'Weather report ragchew', 'summary persisted for a tier-0 clip')
})

test('transcriber: settle-based flush scores a lone clip in ~20s, not 5 minutes', async () => {
  const { svc, dir, clock } = rig({
    complete: async (_s, user) => {
      const items = JSON.parse(user.split('CLIPS TO SCORE (JSON):\n')[1]!) as { id: string }[]
      return reply(JSON.stringify({ scores: items.map((i) => ({ id: i.id, tier: 0, reason: 'r', summary: 's' })) }))
    },
  })
  saveClip(svc, dir, 'fast1')
  await svc.tick() // transcribe
  await svc.tick() // 0s since enqueue — no flush yet
  assert.equal(svc.transcript('fast1')!.importance, undefined, 'not scored immediately')
  clock.t += 5_000
  await svc.tick()
  assert.equal(svc.transcript('fast1')!.importance, undefined, 'not scored at +5s (still settling)')
  clock.t += 17_000 // +22s total > settleMs
  await svc.tick()
  assert.equal(svc.transcript('fast1')!.importance, 0, 'scored once the queue settled')
})

test('transcriber: minute token budget splits oversized batches across windows (429 guard)', async () => {
  const big = 'x'.repeat(15_000) // clipCost ≈ 7.5k tokens > the 6k/min cap
  const calls: number[] = []
  const { svc, dir, clock } = rig({
    complete: async (_s, user) => {
      const items = JSON.parse(user.split('CLIPS TO SCORE (JSON):\n')[1]!) as { id: string }[]
      calls.push(items.length)
      return reply(JSON.stringify({ scores: items.map((i) => ({ id: i.id, tier: 0, reason: 'r' })) }))
    },
  })
  // override the fake transcription to return an enormous text
  ;(svc as unknown as { doTranscribe: unknown }).doTranscribe = async () => ({
    text: big, segments: [], avgLogprob: -0.1, maxNoSpeechProb: 0.01, apiMs: 1,
  })
  saveClip(svc, dir, 'big1', 10)
  await svc.tick()
  saveClip(svc, dir, 'big2', 10)
  await svc.tick()
  clock.t += 25_000 // settled
  await svc.tick() // flush #1 — only big1 fits (oversized single allowed on a fresh window)
  assert.deepEqual(calls, [1], 'first batch limited to one oversized clip')
  assert.equal(svc.transcript('big1')!.importance, 0)
  assert.equal(svc.statusOf('big2'), 'done', 'big2 transcribed but unscored')
  assert.equal(svc.transcript('big2')!.importance, undefined, 'big2 waiting on the minute window')
  await svc.tick() // same minute — still paced
  assert.deepEqual(calls, [1])
  clock.t += 62_000 // minute window rolls
  await svc.tick()
  assert.deepEqual(calls, [1, 1], 'second clip scored in the next minute window')
  assert.equal(svc.transcript('big2')!.importance, 0)
})

test('transcriber: REAL usage + groq bucket headers drive the pacer, not estimates', async () => {
  let calls = 0
  const { svc, dir, clock } = rig({
    complete: async (_s, user) => {
      const items = JSON.parse(user.split('CLIPS TO SCORE (JSON):\n')[1]!) as { id: string }[]
      calls++
      // report HUGE real usage (reasoning tokens) + a nearly-dry bucket — far above any estimate
      return {
        content: JSON.stringify({ scores: items.map((i) => ({ id: i.id, tier: 0, reason: 'r' })) }),
        totalTokens: 5_900,
        remainingTokens: 900,
      }
    },
  })
  saveClip(svc, dir, 'u1')
  await svc.tick()
  clock.t += 25_000
  await svc.tick() // flush #1: real usage 5,900 tokens recorded from the API response
  assert.equal(calls, 1)
  saveClip(svc, dir, 'u2') // arrives AFTER the heavy call
  await svc.tick()
  clock.t += 21_000 // settled — but the minute window still holds 5,900 REAL tokens
  await svc.tick()
  assert.equal(calls, 1, 'real usage blocks a second call in the same minute')
  clock.t += 45_000 // first call ages out of the 60s window
  await svc.tick()
  assert.equal(calls, 2, 'resumes in the next window')
  assert.equal(svc.transcript('u2')!.importance, 0)
})

test('transcriber: recurring preamble carries a high recurrence flag to the model', async () => {
  let seenRecurrence = -1
  const { svc, dir, clock } = rig({
    complete: async (_s, user) => {
      const items = JSON.parse(user.split('CLIPS TO SCORE (JSON):\n')[1]!) as { id: string; recurrence: number }[]
      const p = items.find((i) => i.id === 'p2')
      if (p) seenRecurrence = p.recurrence
      return reply(JSON.stringify({ scores: items.map((i) => ({ id: i.id, tier: 0, reason: 'scheduled net preamble' })) }))
    },
  })
  // two near-identical preambles on the same channel
  const preambleWav = speechWav()
  for (const id of ['p1', 'p2']) {
    writeFileSync(join(dir, `${id}.wav`), preambleWav)
    svc.onClipSaved({ id, startedAt: 1, durationMs: analyzeSpeech(parseWav(preambleWav)).durationMs, channelName: 'COLCON DENVER' })
    await svc.tick()
  }
  clock.t += 6 * 60_000
  await svc.tick()
  await svc.tick()
  assert.ok(seenRecurrence > 0.9, `p2 should match p1 (recurrence=${seenRecurrence})`)
})
