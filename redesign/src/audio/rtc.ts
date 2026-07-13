// WebRTC audio bridge (RX): one libwebrtc peer per browser client (via @roamhq/wrtc), fed the
// shared RX capture as an RTCAudioSource track. Signaling rides the /ws JSON-RPC bus — the api
// layer hands us the offer and forwards our ICE candidates; audio/ stays free of api concerns.
//
// @roamhq/wrtc is a native CJS module (like koffi) — required, not import'd, and typed `any` at
// this boundary. RTCAudioSource.onData wants 10 ms S16 frames, exactly what RxCapture emits.

import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { RX_CHANNELS, RX_FRAME_SAMPLES, RX_SAMPLE_RATE, RxCapture, type CommandFactory } from './rx-capture'
import type { IceProvider, IceServer } from './ice'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wrtc: any = require('@roamhq/wrtc')

export type IceHandler = (candidate: unknown) => void

export type { IceServer, IceProvider } from './ice'
type Sdp = { type: string; sdp: string }

/** Factory for the mic-TX sink play command (STDIN accepts 8 kHz mono S16LE) — null when no radio
 * is connected (mic TX unavailable). */
export type SinkFactory = () => { command: string; args: readonly string[] } | null

/** Clamp bounds for the runtime-adjustable mic→radio gain. */
export const TX_GAIN_MIN = 0.05
export const TX_GAIN_MAX = 2
const clampGain = (g: number): number =>
  Number.isFinite(g) ? Math.min(TX_GAIN_MAX, Math.max(TX_GAIN_MIN, g)) : 1

/** Owns the shared RX capture and mints a peer session per client. */
export class AudioBridge {
  /** The shared RX capture — also fed to the headless Recorder so both share one bluealsa process. */
  readonly capture: RxCapture
  // TX tap: every session tees its downsampled+gained mic frames here — the EXACT bytes written
  // to the radio sink — so the TX recorder captures what actually transmitted, not the raw mic.
  private readonly txSubscribers = new Set<(frame: Buffer) => void>()
  // Mic-TX gain (× on the browser mic before the radio sink); < 1 attenuates to avoid
  // overmodulating the radio's narrowband mic input. MUTABLE at runtime: sessions read it
  // per-frame, so a UI adjustment applies to the very next mic frame — even mid-transmission.
  private gain: number

  constructor(
    command: CommandFactory,
    private readonly log: (m: string) => void = () => {},
    private readonly sink: SinkFactory = () => null,
    txGain = 1,
    /** ICE provider for every peer session (and, via `rtc.config`, for the browser). Static list
     * or minted TURN credentials — see src/audio/ice.ts. Default: none (LAN-only host candidates). */
    private readonly ice: IceProvider = () => Promise.resolve([]),
    /** Force EVERY audio path through the TURN relay (`iceTransportPolicy: 'relay'` on both
     * peers). No host/STUN candidates are even gathered, so direct/LAN paths are impossible —
     * and if relay credentials can't be minted there is NO fallback path at all. */
    readonly relayOnly: boolean = false,
    /** Optional raw-chunk transform for the RX capture (e.g. wired48kTo8k for a Digirig). */
    rxTransform?: (chunk: Buffer) => Buffer,
  ) {
    this.gain = clampGain(txGain)
    this.capture = rxTransform ? new RxCapture(command, log, rxTransform) : new RxCapture(command, log)
  }

  /** The current mic→radio gain. */
  get txGain(): number {
    return this.gain
  }

  /** Live-adjust the mic→radio gain (clamped to [TX_GAIN_MIN, TX_GAIN_MAX]); returns the value
   * actually applied. Takes effect on the next mic frame of every active session. */
  setTxGain(gain: number): number {
    this.gain = clampGain(gain)
    this.log(`mic TX gain → ${this.gain}`)
    return this.gain
  }

  /** FrameSource of the operator's TX audio (8 kHz mono S16LE, ~10 ms frames) — what the TX
   * Recorder subscribes to. Frames flow whenever a peer's mic sink has data (the mic track is
   * silence while unkeyed), so the recorder's own PTT gate decides clip boundaries. */
  readonly txSource = {
    subscribe: async (onFrame: (frame: Buffer) => void): Promise<() => void> => {
      this.txSubscribers.add(onFrame)
      return () => this.txSubscribers.delete(onFrame)
    },
  }

  private teeTx(frame: Buffer): void {
    for (const cb of this.txSubscribers) cb(frame)
  }

  /** The current ICE server set — what rtc.config hands to the browser. */
  iceServers(): Promise<readonly IceServer[]> {
    return this.ice()
  }

  async createSession(onIce: IceHandler): Promise<RtcAudioSession> {
    const ice = await this.ice().catch(() => [] as const)
    return new RtcAudioSession(this.capture, onIce, this.log, this.sink, () => this.gain, (f) => this.teeTx(f), ice, this.relayOnly)
  }
}

/** Downsample a mono S16 frame from `inRate` to 8 kHz by integer decimation, applying `gain`
 * (with int16 clipping). LEGACY — no anti-alias filter, so 4–24 kHz content folds into the voice
 * band; kept only as the stateless fallback (see TxProcessor, which replaced it on the mic path
 * after the fold-back was identified as the over-modulation source). */
export function downsampleTo8k(samples: Int16Array, inRate: number, gain = 1): Buffer {
  const scale = (v: number): number => {
    if (gain === 1) return v
    const s = Math.round(v * gain)
    return s > 32767 ? 32767 : s < -32768 ? -32768 : s
  }
  if (inRate <= RX_SAMPLE_RATE) {
    const b = Buffer.alloc(samples.length * 2)
    for (let i = 0; i < samples.length; i += 1) b.writeInt16LE(scale(samples[i]!), i * 2)
    return b
  }
  const step = inRate / RX_SAMPLE_RATE
  const outLen = Math.floor(samples.length / step)
  const b = Buffer.alloc(outLen * 2)
  for (let i = 0; i < outLen; i += 1) b.writeInt16LE(scale(samples[Math.floor(i * step)]!), i * 2)
  return b
}

// ── proper mic-TX processing: anti-aliased resample + soft-limited gain ─────────────────
//
// The naive decimation above FOLDS everything the mic captures between 4 kHz and 24 kHz
// (sibilance, breath, hiss) back into the 0–4 kHz voice band. That fold-back rides on top of the
// speech, raising the effective deviation into the radio — heard as over-modulation and grit in
// the TX audio even at reduced gain. The PoC avoided it by resampling through ffmpeg; this keeps
// the stream in-process instead: a windowed-sinc FIR low-pass (cutoff 3.4 kHz, Blackman window,
// ~−74 dB stopband) ahead of the decimation, with filter STATE carried across frames so there are
// no per-frame edge artifacts. ~5k multiply-adds per 10 ms frame — negligible.

const TX_LP_CUTOFF_HZ = 3400 // leave a transition band under the 4 kHz Nyquist of 8 kHz output
const TX_LP_TAPS = 63

/** Windowed-sinc low-pass FIR coefficients (Blackman), normalized to unity DC gain. */
export function designLowpass(numTaps: number, cutoffHz: number, sampleRate: number): Float32Array {
  const fc = cutoffHz / sampleRate
  const m = numTaps - 1
  const h = new Float32Array(numTaps)
  let sum = 0
  for (let i = 0; i < numTaps; i += 1) {
    const x = i - m / 2
    const sinc = x === 0 ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * x) / x
    const blackman = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / m) + 0.08 * Math.cos((4 * Math.PI * i) / m)
    h[i] = sinc * blackman
    sum += h[i]!
  }
  for (let i = 0; i < numTaps; i += 1) h[i]! /= sum
  return h
}

/** Soft-knee limiter: linear below 85 % full-scale, tanh compression above — hot peaks round
 * off instead of squaring (a hard int16 clip is added harmonic splatter → more over-deviation). */
export function softClip(v: number): number {
  const LIMIT = 32767
  const KNEE = 0.85 * LIMIT
  const a = Math.abs(v)
  if (a <= KNEE) return Math.round(v)
  const compressed = KNEE + (LIMIT - KNEE) * Math.tanh((a - KNEE) / (LIMIT - KNEE))
  return Math.sign(v) * Math.min(LIMIT, Math.round(compressed))
}

/** Stateful browser-mic → 8 kHz processor: per-input-rate FIR anti-alias low-pass (history kept
 * across frames), decimation, per-frame gain, soft-knee limiting. One instance per RTC session.
 * wrtc occasionally interleaves frames at a different rate (16 k among 48 k); filters and history
 * are kept per rate so a stray frame neither corrupts nor resets the dominant stream's state. */
export class TxProcessor {
  private readonly state = new Map<number, { coeffs: Float32Array; hist: Float32Array }>()

  process(samples: Int16Array, inRate: number, gain: number): Buffer {
    if (inRate <= RX_SAMPLE_RATE) {
      // at/below target rate: gain + limit only
      const b = Buffer.alloc(samples.length * 2)
      for (let i = 0; i < samples.length; i += 1) b.writeInt16LE(softClip(samples[i]! * gain), i * 2)
      return b
    }
    let st = this.state.get(inRate)
    if (!st) {
      st = { coeffs: designLowpass(TX_LP_TAPS, TX_LP_CUTOFF_HZ, inRate), hist: new Float32Array(TX_LP_TAPS - 1) }
      this.state.set(inRate, st)
    }
    const { coeffs, hist } = st
    const H = hist.length
    // contiguous [history | frame] so the FIR window can straddle the frame boundary
    const x = new Float32Array(H + samples.length)
    x.set(hist, 0)
    for (let i = 0; i < samples.length; i += 1) x[H + i] = samples[i]!
    // filter only at the decimation points (we discard the rest anyway)
    const step = inRate / RX_SAMPLE_RATE
    const outLen = Math.floor(samples.length / step)
    const b = Buffer.alloc(outLen * 2)
    for (let o = 0; o < outLen; o += 1) {
      const center = H + Math.floor(o * step) // filter output aligned to this input sample
      let acc = 0
      for (let t = 0; t < TX_LP_TAPS; t += 1) acc += coeffs[t]! * x[center - t]!
      b.writeInt16LE(softClip(acc * gain), o * 2)
    }
    hist.set(x.subarray(x.length - H)) // carry the tail into the next frame
    return b
  }
}

/** Byte-stream decimator for a WIRED 48 kHz RX capture (Digirig line audio → the pipeline's
 * native 8 kHz): anti-aliased via the same windowed-sinc FIR as the mic path, at unity gain.
 * Chunks are re-aligned to whole 6-sample decimation groups (12 bytes) across calls so the 6:1
 * phase never slips regardless of how the pipe splits the stream. */
export function wired48kTo8k(): (chunk: Buffer) => Buffer {
  const processor = new TxProcessor()
  const IN_RATE = 48000
  const ALIGN = 12 // 6 input samples (one output sample) × 2 bytes
  let carry: Buffer = Buffer.alloc(0)
  return (chunk: Buffer): Buffer => {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
    const whole = buf.length - (buf.length % ALIGN)
    carry = Buffer.from(buf.subarray(whole))
    if (whole === 0) return Buffer.alloc(0)
    const samples = new Int16Array(whole / 2)
    for (let i = 0; i < samples.length; i += 1) samples[i] = buf.readInt16LE(i * 2)
    return processor.process(samples, IN_RATE, 1)
  }
}

export class RtcAudioSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pc: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly source: any
  private unsubscribe: (() => void) | null = null
  private closed = false
  // Mic TX (browser → radio HFP sink): the inbound track's audio sink, the play subprocess, and
  // the PTT gate. Audio only flows to the radio while `micActive` (keyed) — otherwise dropped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private micSink: any = null
  private micProc: ChildProcess | null = null
  private micActive = false

  constructor(
    private readonly capture: RxCapture,
    onIce: IceHandler,
    private readonly log: (m: string) => void,
    private readonly sinkFactory: SinkFactory = () => null,
    /** Read per-frame so a runtime gain change applies immediately (see AudioBridge.setTxGain). */
    private readonly txGain: () => number = () => 1,
    /** Tee for the downsampled mic frames (→ the bridge's txSource → the TX recorder). */
    private readonly txTee: (frame: Buffer) => void = () => {},
    iceServers: readonly IceServer[] = [],
    relayOnly = false,
  ) {
    this.pc = new wrtc.RTCPeerConnection({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all' })
    this.source = new wrtc.nonstandard.RTCAudioSource()
    this.pc.addTrack(this.source.createTrack())
    this.pc.onicecandidate = (e: { candidate: unknown }) => {
      if (e.candidate) onIce(e.candidate)
    }
    // The browser's mic (sendrecv) arrives as an inbound track — wire it to the radio TX sink.
    this.pc.ontrack = (e: { track: { kind: string } }) => {
      if (e.track.kind === 'audio') this.attachMic(e.track)
    }
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState
      this.log(`rtc peer: ${st}`)
      if (st === 'failed' || st === 'closed' || st === 'disconnected') this.close()
    }
  }

  /** PTT gate for mic TX: open the radio sink + start piping mic audio while keyed; stop on unkey.
   * (The radio only transmits when keyed, so this also prevents feeding the sink off-air.) */
  setMicActive(active: boolean): void {
    if (active === this.micActive || this.closed) return
    this.micActive = active
    if (!active) {
      this.micProc?.kill('SIGTERM')
      this.micProc = null
      return
    }
    const cmd = this.sinkFactory()
    if (!cmd) {
      this.log('mic TX: no radio sink available')
      this.micActive = false
      return
    }
    this.micProc = spawn(cmd.command, [...cmd.args], { stdio: ['pipe', 'ignore', 'pipe'] })
    this.micProc.on('error', (err) => this.log(`mic TX sink error: ${err.message}`))
    this.log('mic TX: sink open')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly txProcessor = new TxProcessor()

  private attachMic(track: any): void {
    this.micSink?.stop?.()
    this.micSink = new wrtc.nonstandard.RTCAudioSink(track)
    this.micSink.ondata = (d: { samples: Int16Array; sampleRate: number }) => {
      // Tee whenever frames arrive (the browser sends silence while the mic track is disabled/
      // unkeyed) — the TX recorder's PTT gate decides clip boundaries and NEEDS the quiet frames
      // to close a clip's tail. Only forward to the RADIO while keyed.
      const frame = this.txProcessor.process(d.samples, d.sampleRate, this.txGain())
      this.txTee(frame)
      if (!this.micActive || !this.micProc?.stdin?.writable) return // drop unless keyed
      this.micProc.stdin.write(frame)
    }
  }

  /** Answer the client's offer + start streaming RX audio. Returns the local (answer) SDP. */
  async offer(sdp: Sdp): Promise<Sdp> {
    await this.pc.setRemoteDescription(sdp)
    this.unsubscribe?.() // renegotiation: release the prior subscription or the capture leaks
    this.unsubscribe = await this.capture.subscribe((frame) => this.feed(frame))
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    return this.pc.localDescription
  }

  async addIce(candidate: unknown): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate)
    } catch (e) {
      this.log(`rtc addIceCandidate failed: ${(e as Error).message}`)
    }
  }

  private feed(frame: Buffer): void {
    if (this.closed) return
    const samples = new Int16Array(RX_FRAME_SAMPLES)
    for (let i = 0; i < RX_FRAME_SAMPLES; i += 1) samples[i] = frame.readInt16LE(i * 2)
    this.source.onData({
      samples,
      sampleRate: RX_SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: RX_CHANNELS,
      numberOfFrames: RX_FRAME_SAMPLES,
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.micProc?.kill('SIGTERM')
    this.micProc = null
    try {
      this.micSink?.stop?.()
    } catch {
      /* already stopped */
    }
    try {
      this.pc.close()
    } catch {
      /* already closing */
    }
  }
}
