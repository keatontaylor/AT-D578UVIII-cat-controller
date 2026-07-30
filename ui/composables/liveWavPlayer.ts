// Gapless live-clip playback engine. The <audio> element can't follow a growing WAV without
// re-downloading the whole snapshot and swapping src (audible seam + megabytes per cycle — the
// field complaint this replaces). This engine instead polls the live route with RANGE requests
// for ONLY the bytes it hasn't seen (~2s of 8k/16-bit PCM ≈ 32 KB), decodes them directly
// (format is ours: mono 16-bit little-endian), and schedules AudioBufferSourceNodes back to
// back — seamless across poll boundaries AND across quiet stretches (no data = silence until
// the next bytes arrive; scheduling simply continues). When the clip finalizes the route 404s,
// the engine stops, and the caller swaps to the canonical file in the normal player.
export interface LiveWavPlayer {
  /** Seconds of audio fetched so far (the scrubber max). */
  readonly durationS: () => number
  /** Current playhead in seconds. */
  readonly positionS: () => number
  readonly playing: () => boolean
  /** Clip finalized server-side (route 404) — caller should hand off to the saved file. */
  readonly ended: () => boolean
  play(fromS?: number): void
  pause(): void
  seek(toS: number): void
  stop(): void
}

const SAMPLE_RATE = 8000
const BYTES_PER_S = SAMPLE_RATE * 2
const POLL_MS = 1500

export function createLiveWavPlayer(url: string, onUpdate: () => void): LiveWavPlayer {
  const ctx = new AudioContext()
  const chunks: Float32Array[] = [] // decoded PCM in arrival order (contiguous stream)
  let totalSamples = 0
  let bytesSeen = 44 // skip the WAV header on the first fetch
  let isPlaying = false
  let isEnded = false
  let stopped = false
  // scheduling state: sample index of the next unscheduled sample + its ctx-clock start time
  let schedSample = 0
  let schedTime = 0
  let baseSample = 0 // playhead anchor: stream sample corresponding to baseTime
  let baseTime = 0
  const active = new Set<AudioBufferSourceNode>()
  let pollTimer: number | undefined

  function decode(buf: ArrayBuffer): void {
    const n = Math.floor(buf.byteLength / 2)
    if (n <= 0) return
    const view = new DataView(buf)
    const f = new Float32Array(n)
    for (let i = 0; i < n; i++) f[i] = view.getInt16(i * 2, true) / 32768
    chunks.push(f)
    totalSamples += n
  }

  async function poll(): Promise<void> {
    if (stopped) return
    try {
      const res = await fetch(url, { headers: { range: `bytes=${bytesSeen}-` }, cache: 'no-store' })
      if (res.status === 404) {
        isEnded = true
        onUpdate()
        return // stop polling; caller hands off to the saved file
      }
      if (res.status === 206 || res.status === 200) {
        const buf = await res.arrayBuffer()
        if (res.status === 200) {
          // full body (server ignored the range) — keep only what we haven't seen
          decode(buf.slice(bytesSeen))
          bytesSeen = Math.max(bytesSeen, buf.byteLength)
        } else if (buf.byteLength > 0) {
          decode(buf)
          bytesSeen += buf.byteLength
        }
        if (isPlaying) scheduleNew()
        onUpdate()
      }
      // 416 = no new bytes yet — just poll again
    } catch { /* transient network — next poll retries */ }
    if (!stopped && !isEnded) pollTimer = window.setTimeout(() => void poll(), POLL_MS)
  }

  function sampleAt(startSample: number, endSample: number): Float32Array {
    const out = new Float32Array(endSample - startSample)
    let pos = 0
    let written = 0
    for (const c of chunks) {
      const cStart = pos
      const cEnd = pos + c.length
      if (cEnd > startSample && cStart < endSample) {
        const from = Math.max(0, startSample - cStart)
        const to = Math.min(c.length, endSample - cStart)
        out.set(c.subarray(from, to), cStart + from - startSample)
        written += to - from
      }
      pos = cEnd
      if (pos >= endSample) break
    }
    return written > 0 ? out : out
  }

  /** Schedule every fetched-but-unscheduled sample as one buffer node at the running edge. */
  function scheduleNew(): void {
    if (schedSample >= totalSamples) return
    const pcm = sampleAt(schedSample, totalSamples)
    const buf = ctx.createBuffer(1, pcm.length, SAMPLE_RATE)
    buf.getChannelData(0).set(pcm)
    const node = ctx.createBufferSource()
    node.buffer = buf
    node.connect(ctx.destination)
    const at = Math.max(ctx.currentTime + 0.05, schedTime)
    node.start(at)
    active.add(node)
    node.onended = (): void => { active.delete(node) }
    schedTime = at + pcm.length / SAMPLE_RATE
    schedSample = totalSamples
  }

  function clearScheduled(): void {
    for (const n of active) {
      try { n.stop() } catch { /* already stopped */ }
    }
    active.clear()
  }

  return {
    durationS: () => totalSamples / SAMPLE_RATE,
    positionS: () => {
      if (!isPlaying) return baseSample / SAMPLE_RATE
      const s = baseSample + (ctx.currentTime - baseTime) * SAMPLE_RATE
      return Math.min(s, totalSamples) / SAMPLE_RATE
    },
    playing: () => isPlaying,
    ended: () => isEnded,
    play(fromS?: number): void {
      void ctx.resume() // iOS: the click that got us here is the required gesture
      clearScheduled()
      const from = Math.max(0, Math.min(fromS ?? baseSample / SAMPLE_RATE, totalSamples / SAMPLE_RATE))
      baseSample = Math.floor(from * SAMPLE_RATE)
      baseTime = ctx.currentTime + 0.05
      schedSample = baseSample
      schedTime = baseTime
      isPlaying = true
      scheduleNew()
      if (pollTimer === undefined && !isEnded) void poll()
      onUpdate()
    },
    pause(): void {
      baseSample = Math.floor(this.positionS() * SAMPLE_RATE)
      isPlaying = false
      clearScheduled()
      onUpdate()
    },
    seek(toS: number): void {
      const wasPlaying = isPlaying
      baseSample = Math.floor(Math.max(0, Math.min(toS, totalSamples / SAMPLE_RATE)) * SAMPLE_RATE)
      if (wasPlaying) this.play(baseSample / SAMPLE_RATE)
      else onUpdate()
    },
    stop(): void {
      stopped = true
      isPlaying = false
      window.clearTimeout(pollTimer)
      clearScheduled()
      void ctx.close()
    },
  }
}
