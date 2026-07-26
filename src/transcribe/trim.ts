// Speech-energy analysis + trim for recorder WAVs (8 kHz / 16-bit / mono PCM) — pure, no I/O.
// Purpose: (1) skip clips with no real speech BEFORE spending transcription budget (kerchunks,
// squelch tails, standalone idents — also the clips Whisper hallucinates on), and (2) trim the
// leading/trailing silence off the UPLOAD copy so dead air never counts against the audio-seconds
// quota. The archived WAV is never modified; trim offsets are recorded so transcript segment
// timestamps map back onto the original clip timeline.

/** Windowed speech-energy profile of a clip. All times in ms of the ORIGINAL clip. */
export interface SpeechProfile {
  readonly durationMs: number
  /** Total duration of speech-energy windows. */
  readonly speechMs: number
  /** First/last speech window (null when no speech found). */
  readonly firstMs: number | null
  readonly lastMs: number | null
}

const WINDOW_MS = 20
/** A window counts as speech when its RMS exceeds noise-floor × this factor AND an absolute floor
 * (surprisingly quiet squelch tails still carry hiss above a pure-zero floor). */
const SNR_FACTOR = 3
const ABS_FLOOR = 120 // int16 RMS — well below any intelligible voice, above line hiss

interface Pcm {
  readonly samples: Int16Array
  readonly sampleRate: number
}

/** Parse the recorder's standard 44-byte-header WAV. Throws on anything else — the recorder is
 * the only producer, so a surprise here is a bug, not an input to tolerate. */
export function parseWav(buf: Buffer): Pcm {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  const channels = buf.readUInt16LE(22)
  const sampleRate = buf.readUInt32LE(24)
  const bits = buf.readUInt16LE(34)
  if (channels !== 1 || bits !== 16) throw new Error(`unexpected WAV format: ${channels}ch/${bits}bit`)
  const data = buf.subarray(44)
  return { samples: new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2)), sampleRate }
}

export function analyzeSpeech(pcm: Pcm): SpeechProfile {
  const win = Math.max(1, Math.round((pcm.sampleRate * WINDOW_MS) / 1000))
  const n = Math.floor(pcm.samples.length / win)
  const durationMs = (pcm.samples.length / pcm.sampleRate) * 1000
  if (n === 0) return { durationMs, speechMs: 0, firstMs: null, lastMs: null }
  const rms = new Float64Array(n)
  for (let w = 0; w < n; w++) {
    let acc = 0
    const base = w * win
    for (let i = 0; i < win; i++) {
      const s = pcm.samples[base + i]!
      acc += s * s
    }
    rms[w] = Math.sqrt(acc / win)
  }
  // Noise floor = 10th-percentile window RMS. Squelch-gated clips essentially always contain
  // SOME silence (the recorder's tail window at minimum) so a low percentile finds it; a clip
  // where even the floor rivals the peaks is wall-to-wall speech — fall back to the absolute
  // floor rather than let the adaptive threshold classify uniform voice as noise.
  const sorted = Array.from(rms).sort((a, b) => a - b)
  const floor = sorted[Math.floor(n * 0.1)]!
  const p90 = sorted[Math.floor(n * 0.9)]!
  let thresh = Math.max(floor * SNR_FACTOR, ABS_FLOOR)
  if (thresh > p90) thresh = Math.max(ABS_FLOOR, p90 / 2)
  let speech = 0
  let first: number | null = null
  let last: number | null = null
  for (let w = 0; w < n; w++) {
    if (rms[w]! >= thresh) {
      speech++
      if (first === null) first = w
      last = w
    }
  }
  return {
    durationMs,
    speechMs: speech * WINDOW_MS,
    firstMs: first === null ? null : first * WINDOW_MS,
    lastMs: last === null ? null : (last + 1) * WINDOW_MS,
  }
}

/** Cut [startMs, endMs) out of the original WAV as a standalone upload WAV. */
export function sliceWav(buf: Buffer, startMs: number, endMs: number): Buffer {
  const pcm = parseWav(buf)
  const s0 = Math.max(0, Math.floor((startMs / 1000) * pcm.sampleRate))
  const s1 = Math.min(pcm.samples.length, Math.ceil((endMs / 1000) * pcm.sampleRate))
  const bytes = Math.max(0, (s1 - s0) * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + bytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(pcm.sampleRate, 24)
  header.writeUInt32LE(pcm.sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(bytes, 40)
  const data = Buffer.from(pcm.samples.buffer, pcm.samples.byteOffset + s0 * 2, bytes)
  return Buffer.concat([header, data])
}

/** Trim plan for a clip: pad the speech span so soft onsets survive. */
export function trimPlan(profile: SpeechProfile, padMs = 250): { startMs: number; endMs: number } | null {
  if (profile.firstMs === null || profile.lastMs === null) return null
  return {
    startMs: Math.max(0, profile.firstMs - padMs),
    endMs: Math.min(profile.durationMs, profile.lastMs + padMs),
  }
}
