// Transcription side-process: trim/speech analysis on synthetic PCM, the prompt-echo guard,
// learned priority ordering, sidecar lifecycle, and free-tier budget deferral. All offline —
// the Groq client is injected as a fake; WAVs are generated in a temp dir.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeSpeech, parseWav, sliceWav, trimPlan } from '../src/transcribe/trim'
import { buildPrompt, isPromptEcho, type GroqResult } from '../src/transcribe/groq'
import { InterestLearner } from '../src/transcribe/learner'
import { Transcriber, type TranscribableClip, type TranscriptSidecar } from '../src/transcribe/service'
import { wavHeader } from '../src/audio/recorder'

const RATE = 8000

/** Synthetic 8k/16-bit WAV: silence, then a loud 700 Hz burst, then silence. */
function makeWav(silence1S: number, speechS: number, silence2S: number): Buffer {
  const n = Math.round((silence1S + speechS + silence2S) * RATE)
  const pcm = Buffer.alloc(n * 2)
  const start = Math.round(silence1S * RATE)
  const end = Math.round((silence1S + speechS) * RATE)
  for (let i = 0; i < n; i++) {
    let v = 0
    if (i >= start && i < end) {
      // amplitude-modulated tone ≈ speech-band energy well above the noise floor
      v = Math.round(8000 * Math.sin((2 * Math.PI * 700 * i) / RATE) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / RATE)))
    } else {
      v = Math.round(30 * Math.sin((2 * Math.PI * 60 * i) / RATE)) // faint hum = noise floor
    }
    pcm.writeInt16LE(v, i * 2)
  }
  return Buffer.concat([wavHeader(pcm.length), pcm])
}

test('trim: finds the speech span and slices it (with silence-only rejection)', () => {
  const wav = makeWav(2, 3, 2)
  const profile = analyzeSpeech(parseWav(wav))
  assert.ok(profile.speechMs > 2500 && profile.speechMs < 3500, `speechMs=${profile.speechMs}`)
  assert.ok(profile.firstMs! > 1500 && profile.firstMs! < 2300, `firstMs=${profile.firstMs}`)
  assert.ok(profile.lastMs! > 4700 && profile.lastMs! < 5400, `lastMs=${profile.lastMs}`)
  const plan = trimPlan(profile)!
  const cut = sliceWav(wav, plan.startMs, plan.endMs)
  const cutProfile = analyzeSpeech(parseWav(cut))
  assert.ok(cutProfile.durationMs < 4200, 'trimmed clip drops most of the 4s of silence')
  assert.ok(cutProfile.speechMs > 2500, 'speech survives the trim')

  const quiet = analyzeSpeech(parseWav(makeWav(3, 0, 0)))
  assert.equal(quiet.firstMs, null)
  assert.equal(trimPlan(quiet), null)
})

test('prompt-echo guard: catches bias-prompt parroting, passes real transcripts', () => {
  const prompt = buildPrompt('COLCON DENVER', null)
  assert.ok(isPromptEcho('Channel COLCON DENVER.', prompt))
  assert.ok(isPromptEcho('COLCON DENVER', prompt))
  assert.ok(!isPromptEcho('This is the Colorado Connection net, K0BUL checking in.', prompt))
  assert.ok(!isPromptEcho('', prompt))
})

test('learner: engagement weights, decay, and persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stt-'))
  let now = 0
  const l = new InterestLearner(join(dir, 'learner.json'), () => now)
  l.record('play', 'METRO 600')
  l.record('ptt', 'COLCON DENVER')
  assert.ok(l.scoreOf('COLCON DENVER') > l.scoreOf('METRO 600'), 'ptt outweighs play')
  now = 14 * 24 * 3600_000 // one half-life later
  assert.ok(Math.abs(l.scoreOf('COLCON DENVER') - 2.5) < 0.01, 'decayed to half weight')
  const l2 = new InterestLearner(join(dir, 'learner.json'), () => now)
  assert.ok(l2.scoreOf('COLCON DENVER') > 0, 'events survive a restart')
})

interface Rig {
  svc: Transcriber
  dir: string
  calls: { prompt: string }[]
  events: { id: string; status: string }[]
  clock: { t: number }
}

function rig(opts: { result?: () => GroqResult; failWith?: Error } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'stt-'))
  const clock = { t: Date.UTC(2026, 6, 26, 12, 0, 0) }
  const calls: { prompt: string }[] = []
  const events: { id: string; status: string }[] = []
  const svc = new Transcriber({
    dir,
    recorderEnabled: () => true,
    now: () => clock.t,
    keyFn: () => 'test-key',
    startTimer: false,
    transcribeFn: async (_wav, o) => {
      calls.push({ prompt: o.prompt })
      if (opts.failWith) throw opts.failWith
      return opts.result?.() ?? {
        text: 'This is K0BUL, Tom in Colorado Springs.',
        segments: [{ startS: 0.5, endS: 2.5, text: 'This is K0BUL, Tom in Colorado Springs.' }],
        avgLogprob: -0.2,
        maxNoSpeechProb: 0.05,
        apiMs: 300,
      }
    },
  })
  svc.subscribe((e) => events.push(e))
  return { svc, dir, calls, events, clock }
}

function clip(dir: string, id: string, wav: Buffer, meta: Partial<TranscribableClip> = {}): TranscribableClip {
  writeFileSync(join(dir, `${id}.wav`), wav)
  return { id, startedAt: 1, durationMs: analyzeSpeech(parseWav(wav)).durationMs, channelName: 'COLCON DENVER', ...meta }
}

test('service: kerchunks and TX clips are never queued', () => {
  const { svc, dir } = rig()
  svc.onClipSaved(clip(dir, 'kerchunk', makeWav(0, 1, 0)))
  svc.onClipSaved({ ...clip(dir, 'tx-clip', makeWav(0, 5, 0)), direction: 'tx' })
  assert.equal(svc.statusOf('kerchunk'), null)
  assert.equal(svc.statusOf('tx-clip'), null)
})

test('service: no-speech clip → skipped sidecar, no API call', async () => {
  const { svc, dir, calls } = rig()
  svc.onClipSaved(clip(dir, 'noise', makeWav(4, 0, 0)))
  assert.equal(svc.statusOf('noise'), 'queued')
  await svc.tick()
  assert.equal(svc.statusOf('noise'), 'skipped')
  assert.equal(calls.length, 0)
  const side = JSON.parse(readFileSync(join(dir, 'noise.transcript.json'), 'utf8')) as TranscriptSidecar
  assert.equal(side.reason, 'no-speech')
})

test('service: speech clip → done sidecar with trim-offset segments + biased prompt', async () => {
  const { svc, dir, calls } = rig()
  svc.onClipSaved(clip(dir, 'good', makeWav(2, 4, 1), { talkgroupName: 'NXDN JOE' }))
  await svc.tick()
  assert.equal(svc.statusOf('good'), 'done')
  assert.ok(calls[0]!.prompt.includes('COLCON DENVER') && calls[0]!.prompt.includes('NXDN JOE'))
  const side = svc.transcript('good')!
  assert.equal(side.status, 'done')
  assert.ok(side.text!.includes('K0BUL'))
  // segment at 0.5s of the TRIMMED upload maps back near 2s of the original clip
  assert.ok(side.segments![0]!.startMs > 1900 && side.segments![0]!.startMs < 2600, `startMs=${side.segments![0]!.startMs}`)
  assert.ok(side.billedS! < 6, 'billed the trimmed length, not the full clip')
})

test('service: prompt echo → skipped, not shown as a transcript', async () => {
  const { svc, dir } = rig({
    result: () => ({ text: 'Channel COLCON DENVER.', segments: [], avgLogprob: null, maxNoSpeechProb: null, apiMs: 100 }),
  })
  svc.onClipSaved(clip(dir, 'echo', makeWav(0, 4, 0)))
  await svc.tick()
  assert.equal(svc.statusOf('echo'), 'skipped')
  assert.equal(svc.transcript('echo')!.reason, 'prompt-echo')
})

test('service: forced clips jump the queue; force teaches the learner', async () => {
  const { svc, dir, calls } = rig()
  const a = clip(dir, 'older', makeWav(0, 4, 0), { startedAt: 100, channelName: 'METRO 600' })
  const b = clip(dir, 'newer', makeWav(0, 4, 0), { startedAt: 200, channelName: 'LOOKOUT 675' })
  svc.onClipSaved(a)
  svc.onClipSaved(b)
  svc.transcribeNow(a) // forced → beats the newer clip despite lower recency
  calls.length = 0
  await svc.tick()
  assert.equal(svc.statusOf('older'), 'done')
  assert.equal(svc.statusOf('newer'), 'queued')
  assert.ok(svc.learner.scoreOf('METRO 600') > 0, 'force recorded as engagement')
})

test('service: quota exhaustion (429) defers instead of dropping', async () => {
  const { GroqQuotaError } = await import('../src/transcribe/groq')
  const q = rig({ failWith: new GroqQuotaError(120) })
  q.svc.onClipSaved(clip(q.dir, 'q1', makeWav(0, 4, 0)))
  await q.svc.tick()
  assert.equal(q.svc.statusOf('q1'), 'deferred', 'parked, not failed')
  await q.svc.tick() // retry-after not yet expired → no second API hit
  assert.equal(q.svc.statusOf('q1'), 'deferred')
  q.clock.t += 200_000 // past retry-after: still in the queue, eligible again
  assert.equal(q.svc.statusOf('q1'), 'queued')
})

test('service: rescan re-queues unsidecared clips after the enable marker', async () => {
  const { svc, dir } = rig()
  const c1 = clip(dir, 'seen', makeWav(0, 4, 0), { startedAt: 500 })
  svc.onClipSaved(c1) // sets enabledSince marker
  await svc.tick()
  assert.equal(svc.statusOf('seen'), 'done')
  // a clip that was saved while the process was down (after the marker) — no sidecar
  const c2 = clip(dir, 'missed', makeWav(0, 4, 0), { startedAt: Date.UTC(2026, 6, 26, 12, 30) })
  const svc2 = new Transcriber({
    dir, recorderEnabled: () => true, now: () => Date.UTC(2026, 6, 26, 13, 0), keyFn: () => 'k',
    startTimer: false, transcribeFn: async () => ({ text: 'x', segments: [], avgLogprob: null, maxNoSpeechProb: null, apiMs: 1 }),
  })
  svc2.rescan([c1, c2])
  assert.equal(svc2.statusOf('seen'), 'done', 'sidecared clip not re-queued')
  assert.equal(svc2.statusOf('missed'), 'queued', 'missed clip recovered')
  assert.ok(existsSync(join(dir, 'transcribe-state.json')))
})
