import { spawn } from 'node:child_process'
import { buildAudioProcess, getAudioConfig, type AudioConfig } from './audio'

export const RX_AUDIO_SAMPLE_RATE = envInt('CAT_AUDIO_CAPTURE_SAMPLE_RATE', envInt('CAT_AUDIO_SAMPLE_RATE', 8000))
export const RX_AUDIO_CHANNEL_COUNT = envInt('CAT_AUDIO_CAPTURE_CHANNELS', envInt('CAT_AUDIO_RX_CHANNELS', 1))
export const RX_AUDIO_FRAME_MS = 10

const BITS_PER_SAMPLE = 16

export interface RxAudioCaptureOptions {
  sampleRate?: number
  channels?: number
  config?: AudioConfig
}

export interface RxAudioFrame {
  data: Buffer
  sampleRate: number
  channelCount: number
  numberOfFrames: number
}

export interface RxAudioCaptureSubscriber {
  onFrame: (frame: RxAudioFrame) => void
  onError?: (message: string) => void
  onClose?: (message: string) => void
}

interface NormalizedRxAudioCaptureOptions {
  sampleRate: number
  channels: number
  frameSamples: number
  frameBytes: number
  key: string
  config: AudioConfig
}

interface InternalSubscriber extends RxAudioCaptureSubscriber {
  id: number
}

class RxAudioCaptureHub {
  private process: ReturnType<typeof spawn> | null = null
  private subscribers = new Map<number, InternalSubscriber>()
  private nextSubscriberId = 1
  private pending = Buffer.alloc(0)
  private options: NormalizedRxAudioCaptureOptions | null = null
  private stderr = ''
  private stopping = false

  subscribe(options: RxAudioCaptureOptions, subscriber: RxAudioCaptureSubscriber) {
    const normalized = normalizeOptions(options)
    if (this.options && this.options.key !== normalized.key) {
      throw new Error(`RX audio capture already running as ${this.options.key}`)
    }

    const id = this.nextSubscriberId++
    this.subscribers.set(id, { ...subscriber, id })

    try {
      this.start(normalized)
    } catch (err: any) {
      this.subscribers.delete(id)
      throw err
    }

    let active = true
    return () => {
      if (!active) return
      active = false
      this.subscribers.delete(id)
      if (this.subscribers.size === 0) this.stop()
    }
  }

  status() {
    return {
      active: !!this.process,
      subscribers: this.subscribers.size,
      sampleRate: this.options?.sampleRate ?? null,
      channels: this.options?.channels ?? null,
    }
  }

  private start(options: NormalizedRxAudioCaptureOptions) {
    if (this.process) return

    const config = options.config
    if (!config.enabled) throw new Error('Audio streaming is disabled. Set CAT_AUDIO_ENABLED=1 on the radio host.')

    const audioProcessConfig = buildAudioProcess(config, {
      format: 'pcm',
      sampleRate: String(options.sampleRate),
      channels: String(options.channels),
    })
    const child = spawn(audioProcessConfig.command, audioProcessConfig.args, { stdio: ['ignore', 'pipe', 'pipe'] })

    this.process = child
    this.options = options
    this.pending = Buffer.alloc(0)
    this.stderr = ''
    this.stopping = false

    child.stdout.on('data', chunk => this.handleChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    child.stderr.on('data', chunk => {
      this.stderr += chunk.toString()
      if (this.stderr.length > 4000) this.stderr = this.stderr.slice(-4000)
      if (process.env.CAT_AUDIO_DEBUG === '1') process.stderr.write(chunk)
    })
    child.on('error', err => this.notifyError(`Cannot start RX audio capture: ${err.message}`))
    child.on('close', code => {
      const expected = this.stopping
      const closedOptions = this.options
      const message = this.stderr.trim() || `RX audio capture exited with code ${code}`
      this.process = null
      this.options = null
      this.pending = Buffer.alloc(0)
      this.stderr = ''
      this.stopping = false
      if (expected) {
        if (this.subscribers.size > 0 && closedOptions) {
          try {
            this.start(closedOptions)
          } catch (err: any) {
            this.notifyError(err?.message ?? 'Cannot restart RX audio capture')
            this.closeSubscribers(err?.message ?? 'Cannot restart RX audio capture')
          }
        }
        return
      }
      this.closeSubscribers(code === 0 ? 'RX audio capture ended' : message)
    })
  }

  private stop() {
    if (!this.process || this.stopping) return
    this.stopping = true
    if (!this.process.killed) this.process.kill('SIGTERM')
  }

  private handleChunk(chunk: Buffer) {
    const options = this.options
    if (!options) return

    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk)
    while (this.pending.length >= options.frameBytes) {
      const frame = Buffer.from(this.pending.subarray(0, options.frameBytes))
      this.pending = this.pending.subarray(options.frameBytes)
      this.notifyFrame({
        data: frame,
        sampleRate: options.sampleRate,
        channelCount: options.channels,
        numberOfFrames: options.frameSamples,
      })
    }
  }

  private notifyFrame(frame: RxAudioFrame) {
    for (const subscriber of this.subscribers.values()) {
      try {
        subscriber.onFrame(frame)
      } catch (err: any) {
        subscriber.onError?.(err?.message ?? String(err))
      }
    }
  }

  private notifyError(message: string) {
    for (const subscriber of this.subscribers.values()) subscriber.onError?.(message)
  }

  private closeSubscribers(message: string) {
    const subscribers = Array.from(this.subscribers.values())
    this.subscribers.clear()
    for (const subscriber of subscribers) subscriber.onClose?.(message)
  }
}

function normalizeOptions(options: RxAudioCaptureOptions): NormalizedRxAudioCaptureOptions {
  const config = options.config ?? getAudioConfig()
  const sampleRate = normalizeInt(options.sampleRate, Number(config.sampleRate) || RX_AUDIO_SAMPLE_RATE, 8000, 96000)
  const channels = normalizeInt(options.channels, Number(config.channels) || RX_AUDIO_CHANNEL_COUNT, 1, 8)
  const frameSamples = Math.max(1, Math.round(sampleRate * (RX_AUDIO_FRAME_MS / 1000)))
  const frameBytes = frameSamples * channels * (BITS_PER_SAMPLE / 8)
  return {
    sampleRate,
    channels,
    frameSamples,
    frameBytes,
    key: `${sampleRate}/${channels}/${config.transport}/${config.engine}/${config.backend}/${config.input}`,
    config,
  }
}

function normalizeInt(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

function envInt(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}

declare global {
  // eslint-disable-next-line no-var
  var __anytoneRxAudioCaptureHub: RxAudioCaptureHub | undefined
}

const hub = globalThis.__anytoneRxAudioCaptureHub ||= new RxAudioCaptureHub()

export function subscribeRxAudioCapture(options: RxAudioCaptureOptions, subscriber: RxAudioCaptureSubscriber) {
  return hub.subscribe(options, subscriber)
}

export function getRxAudioCaptureStatus() {
  return hub.status()
}
