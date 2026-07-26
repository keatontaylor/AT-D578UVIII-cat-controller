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

test('parseScores: tolerates fences/prose, drops unknown ids and bad tiers', () => {
  const ids = ['a', 'b', 'c']
  const raw = 'Here you go:\n```json\n{"scores":[{"id":"a","tier":3,"reason":"mayday in progress"},{"id":"b","tier":9,"reason":"bad"},{"id":"zzz","tier":2,"reason":"unknown"},{"id":"c","tier":0,"reason":"routine"}]}\n```'
  const m = parseScores(raw, ids)
  assert.equal(m.get('a')!.tier, 3)
  assert.equal(m.get('a')!.reason, 'mayday in progress')
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
    complete: async () => JSON.stringify({ scores: [{ id: 'c1', tier: 2, reason: 'funnel cloud reported' }, { id: 'c2', tier: 0, reason: 'radio check' }] }),
  }
  const out = await scoreBatch(chat, 'g', [
    { id: 'c1', channel: 'A', startedAt: 0, durationMs: 5000, text: 'funnel cloud on the ground', recurrence: 0 },
    { id: 'c2', channel: 'A', startedAt: 0, durationMs: 3000, text: 'radio check', recurrence: 0 },
  ])
  assert.equal(out.get('c1')!.tier, 2)
  assert.equal(out.get('c2')!.tier, 0)
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
      text: 'This is K0BUL with a funnel cloud report near Longmont.',
      segments: [{ startS: 0.2, endS: 3, text: 'This is K0BUL with a funnel cloud report near Longmont.' }],
      avgLogprob: -0.2, maxNoSpeechProb: 0.05, apiMs: 100,
    }),
  })
  svc.subscribe((e) => events.push(e))
  return { svc, dir, clock, events }
}
function saveClip(svc: Transcriber, dir: string, id: string): TranscribableClip {
  const wav = speechWav()
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
      return JSON.stringify({ scores: batchIds.map((id) => ({ id, tier: 2, reason: 'weather report' })) })
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

test('transcriber: importance 429 re-queues the batch, does not lose clips', async () => {
  const { GroqQuotaError } = await import('../src/transcribe/groq')
  let calls = 0
  const { svc, dir, clock } = rig({
    complete: async () => {
      calls++
      if (calls === 1) throw new GroqQuotaError(60)
      return JSON.stringify({ scores: [{ id: 's1', tier: 1, reason: 'notable' }] })
    },
  })
  saveClip(svc, dir, 's1')
  await svc.tick()
  clock.t += 6 * 60_000
  await svc.tick() // first score attempt → 429, deferred
  assert.equal(svc.transcript('s1')!.importance, undefined, 'not scored yet')
  clock.t += 120_000 // past the 429 cooldown
  await svc.tick() // retry succeeds
  assert.equal(svc.transcript('s1')!.importance, 1)
})

test('transcriber: recurring preamble carries a high recurrence flag to the model', async () => {
  let seenRecurrence = -1
  const { svc, dir, clock } = rig({
    complete: async (_s, user) => {
      const items = JSON.parse(user.split('CLIPS TO SCORE (JSON):\n')[1]!) as { id: string; recurrence: number }[]
      const p = items.find((i) => i.id === 'p2')
      if (p) seenRecurrence = p.recurrence
      return JSON.stringify({ scores: items.map((i) => ({ id: i.id, tier: 0, reason: 'scheduled net preamble' })) })
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
