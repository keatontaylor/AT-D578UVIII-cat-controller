// RX audio capture: one `bluealsa-cli open <source>` process streams the radio's HFP PCM
// (8 kHz mono S16LE) to stdout; we reframe it into fixed 10 ms frames and release them to
// subscribers (each WebRTC peer). The process starts on the first subscriber and stops with the
// last — so nothing runs unless someone is listening.
//
// PACED DELIVERY (2026-07-11): the SCO pipe hands us audio in bursts (several 10 ms frames
// clumped, then a gap), but the Opus encoder consumes exactly one 10 ms frame per 10 ms of
// system time. Feeding it in bursts made its internal buffer periodically over/underrun — a
// steady click/crackle that robust receivers (Safari/CoreAudio) hid but a marginal one (in-car
// Chromium) surfaced. So the pipe read only ENQUEUES; a 10 ms timer drains one frame per tick
// and does the fan-out. That (a) feeds the encoder on the same clock it consumes at, and (b)
// moves the fan-out off the pipe-read callback, so no subscriber's inline work can stall a frame.
//
// No squelch follower: the radio itself mutes the SCO stream when squelched, so a closed squelch
// is just silence on the wire. We forward continuously and let the browser play through it.

import { spawn, type ChildProcess } from 'node:child_process'

export const RX_SAMPLE_RATE = 8000
export const RX_CHANNELS = 1
const BYTES_PER_SAMPLE = 2 // S16LE
/** 10 ms frame: 80 samples → 160 bytes (what RTCAudioSource expects, one ptime). */
export const RX_FRAME_SAMPLES = (RX_SAMPLE_RATE * 10) / 1000
const FRAME_BYTES = RX_FRAME_SAMPLES * BYTES_PER_SAMPLE
/** Drain cadence — one 10 ms frame per tick, matching the encoder's consumption rate. */
export const RX_FRAME_MS = 10
/** Prime the jitter buffer to this depth before releasing (≈20 ms) so burst timing can't underrun
 * a tick; re-primes after any underrun. Small: this is de-clumping, not latency hiding. */
const JITTER_TARGET_FRAMES = 2
/** Hard cap (≈250 ms). Only trips on a pathological backlog (event loop starved / source runaway);
 * drops the OLDEST frames — freshest audio wins for a live monitor. */
const JITTER_MAX_FRAMES = 25

export type CommandFactory = () => { command: string; args: readonly string[] }
export type FrameHandler = (frame: Buffer) => void

/** Reframe a byte stream into fixed-size frames: append `chunk` to `pending`, split off every whole
 * `frameBytes`, and return the emitted frames + the leftover. Pure, so it's unit-testable. */
export function reframe(pending: Buffer, chunk: Buffer, frameBytes: number): { frames: Buffer[]; rest: Buffer } {
  let buf = pending.length ? Buffer.concat([pending, chunk]) : chunk
  const frames: Buffer[] = []
  while (buf.length >= frameBytes) {
    frames.push(Buffer.from(buf.subarray(0, frameBytes)))
    buf = buf.subarray(frameBytes)
  }
  return { frames, rest: buf }
}

/** A primed jitter buffer: accepts frames in bursts, releases at most one per `drain()` so a
 * steady-cadence timer can pace delivery. Holds until primed to a target depth, then releases
 * steadily; on underrun it re-primes (a missing frame is better absorbed as a brief hold than a
 * skip). Bounded — overrun drops the oldest. Pure + timer-free, so the pacing policy is unit-tested
 * without real time. */
export class FrameQueue {
  private q: Buffer[] = []
  private primed = false
  constructor(
    private readonly targetDepth = JITTER_TARGET_FRAMES,
    private readonly maxDepth = JITTER_MAX_FRAMES,
  ) {}

  push(frame: Buffer): void {
    this.q.push(frame)
    if (this.q.length > this.maxDepth) this.q.splice(0, this.q.length - this.maxDepth)
    if (this.q.length >= this.targetDepth) this.primed = true
  }

  /** The frame to release this tick, or null while (re)priming or empty. */
  drain(): Buffer | null {
    if (!this.primed) return null
    const frame = this.q.shift() ?? null
    if (this.q.length === 0) this.primed = false // underran → refill before releasing again
    return frame
  }

  get depth(): number {
    return this.q.length
  }

  clear(): void {
    this.q = []
    this.primed = false
  }
}

export class RxCapture {
  private proc: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private pending: Buffer = Buffer.alloc(0)
  private readonly subscribers = new Set<FrameHandler>()
  private readonly queue = new FrameQueue()
  private pacer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly command: CommandFactory,
    private readonly log: (message: string) => void = () => {},
    /** Optional byte-stream transform applied to raw pipe chunks BEFORE reframing — e.g. FIR
     * decimation of a 48 kHz wired capture (Digirig) down to the pipeline's native 8 kHz. */
    private readonly transform: (chunk: Buffer) => Buffer = (chunk) => chunk,
  ) {}

  get active(): boolean {
    return this.proc !== null
  }

  /** Receive 10 ms PCM frames until the returned unsubscribe is called. */
  async subscribe(onFrame: FrameHandler): Promise<() => void> {
    this.subscribers.add(onFrame)
    try {
      if (!this.proc) await this.start()
      else if (this.starting) await this.starting
    } catch (e) {
      this.subscribers.delete(onFrame)
      if (this.subscribers.size === 0) this.stop()
      throw e
    }
    return () => {
      this.subscribers.delete(onFrame)
      if (this.subscribers.size === 0) this.stop()
    }
  }

  private async start(): Promise<void> {
    let command: string
    let args: readonly string[]
    try {
      ;({ command, args } = this.command())
    } catch (e) {
      throw new Error(`rx-capture: cannot start (${(e as Error).message})`)
    }
    this.log(`rx-capture: ${command} ${args.join(' ')}`)
    const proc = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc
    this.pending = Buffer.alloc(0)
    let spawned = false
    this.starting = new Promise<void>((resolve, reject) => {
      proc.once('spawn', () => {
        spawned = true
        resolve()
      })
      proc.once('error', (err) => reject(new Error(`rx-capture spawn error: ${err.message}`)))
      proc.once('close', (code) => {
        if (!spawned) reject(new Error(`rx-capture exited before start (${code})`))
      })
    }).finally(() => {
      if (this.proc === proc) this.starting = null
    })
    proc.stdout?.on('data', (chunk: Buffer) => this.onChunk(chunk))
    proc.stderr?.on('data', (chunk: Buffer) => this.log(`rx-capture stderr: ${chunk.toString().trim()}`))
    proc.on('close', (code) => {
      this.log(`rx-capture ended (${code})`)
      if (this.proc === proc) this.proc = null
    })
    proc.on('error', (err) => this.log(`rx-capture spawn error: ${err.message}`))
    this.startPacer()
    await this.starting
  }

  /** Pipe read: reframe and ENQUEUE only — never fan out here. The paced timer releases frames so
   * the encoder gets a steady 10 ms cadence regardless of how clumped the pipe delivery is. */
  private onChunk(chunk: Buffer): void {
    const { frames, rest } = reframe(this.pending, this.transform(chunk), FRAME_BYTES)
    this.pending = rest
    for (const frame of frames) this.queue.push(frame)
  }

  private startPacer(): void {
    if (this.pacer) return
    this.pacer = setInterval(() => {
      const frame = this.queue.drain()
      if (!frame) return // (re)priming or between bursts — the encoder coasts one tick
      for (const onFrame of this.subscribers) {
        try {
          onFrame(frame)
        } catch (e) {
          this.log(`rx-capture subscriber error: ${(e as Error).message}`)
        }
      }
    }, RX_FRAME_MS)
    this.pacer.unref?.() // never keep the process alive for the pacer
  }

  private stop(): void {
    if (this.pacer) {
      clearInterval(this.pacer)
      this.pacer = null
    }
    this.queue.clear()
    this.proc?.kill('SIGTERM')
    this.proc = null
    this.pending = Buffer.alloc(0)
  }
}
