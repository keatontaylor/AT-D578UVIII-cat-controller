import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { DEFAULT_WEBRTC_OPUS_OPTIONS, normalizeWebRtcOpusOptions, type WebRtcOpusOptions } from '../../utils/webrtc-sdp'

export interface AudioConfig {
  enabled: boolean
  transport: string
  engine: string
  backend: string
  input: string
  output: string
  txBackend: string
  txOutput: string
  txChannels: string
  txSampleRate: string
  channels: string
  bitrate: string
  sampleRate: string
  filter: string
  gain: string
  limiter: boolean
  limit: string
  queueSize: string
  macosBufferSize: string
  squelchGate: boolean
  squelchPollMs: number
  squelchRampMs: number
  webrtcOpus: WebRtcOpusOptions
  ffmpegPath: string
  swiftPath: string
  macosCapturePath: string
}

export interface AudioStatus {
  enabled: boolean
  transport: string
  engine: string
  backend: string
  input: string
  output: string
  txBackend: string
  txOutput: string
  txChannels: string
  txSampleRate: string
  channels: string
  bitrate: string
  sampleRate: string
  filter: string
  gain: string
  limiter: boolean
  limit: string
  macosBufferSize: string
  squelchGate: boolean
  squelchPollMs: number
  squelchRampMs: number
  webrtcOpus: WebRtcOpusOptions
  available: boolean
  contentType: string
  message: string | null
}

export interface AudioStreamOptions {
  format: 'mp3' | 'pcm'
  sampleRate?: string
  channels?: string
}

export interface AudioRecordingOptions {
  side: 'main' | 'sub'
  outputPath: string
  sampleRate?: string
}

export interface ActiveAudioProfile {
  transport?: string
  engine?: string
  backend?: string
  input?: string
  output?: string
  rxChannels?: string
  channels?: string
  txBackend?: string
  txOutput?: string
  txChannels?: string
  txSampleRate?: string
  sampleRate?: string
  gain?: string
  filter?: string
  highpass?: string
  squelchGate?: boolean
}

export interface AudioRecordingEncoderOptions {
  outputPath: string
  sampleRate?: string
}

export function getAudioConfig(profile: ActiveAudioProfile | null = null): AudioConfig {
  const engine = profile?.engine || process.env.CAT_AUDIO_ENGINE || 'bluealsa'
  const backend = profile?.backend || process.env.CAT_AUDIO_BACKEND || defaultBackend(engine)
  const input = profile?.input || process.env.CAT_AUDIO_INPUT || defaultInput(backend)
  const output = profile?.output || process.env.CAT_AUDIO_OUTPUT || defaultOutput(backend, input)
  const txBackend = profile?.txBackend || process.env.CAT_AUDIO_TX_BACKEND || process.env.CAT_AUDIO_BACKEND || backend
  const txOutput = profile?.txOutput || process.env.CAT_AUDIO_TX_OUTPUT || process.env.CAT_AUDIO_OUTPUT || defaultTxOutput(txBackend, input, output)
  const sampleRate = profile?.sampleRate || process.env.CAT_AUDIO_SAMPLE_RATE || '8000'
  const gain = profile?.gain || process.env.CAT_AUDIO_GAIN || '1.0'
  const limiter = process.env.CAT_AUDIO_LIMITER !== '0'
  const limit = process.env.CAT_AUDIO_LIMIT || '0.85'
  const filter = process.env.CAT_AUDIO_FILTER ?? profile?.filter ?? defaultFilter(gain, limiter, limit, profile?.highpass)

  return {
    enabled: process.env.CAT_AUDIO_ENABLED !== '0',
    transport: profile?.transport || 'bt',
    engine,
    backend,
    input,
    output,
    txBackend,
    txOutput,
    txChannels: profile?.txChannels || process.env.CAT_AUDIO_TX_CHANNELS || '1',
    txSampleRate: profile?.txSampleRate || process.env.CAT_AUDIO_TX_SAMPLE_RATE || sampleRate,
    channels: profile?.rxChannels || profile?.channels || process.env.CAT_AUDIO_RX_CHANNELS || process.env.CAT_AUDIO_CHANNELS || '1',
    bitrate: process.env.CAT_AUDIO_BITRATE || '64k',
    sampleRate,
    filter,
    gain,
    limiter,
    limit,
    queueSize: process.env.CAT_AUDIO_QUEUE_SIZE || '256',
    macosBufferSize: process.env.CAT_AUDIO_MACOS_BUFFER_SIZE || '256',
    squelchGate: profile?.squelchGate ?? process.env.CAT_AUDIO_SQUELCH_GATE === '1',
    squelchPollMs: envInt('CAT_AUDIO_SQUELCH_POLL_MS', 150),
    squelchRampMs: envInt('CAT_AUDIO_SQUELCH_RAMP_MS', 12),
    webrtcOpus: getWebRtcOpusOptions(),
    ffmpegPath: process.env.CAT_FFMPEG_PATH || ffmpegStatic || 'ffmpeg',
    swiftPath: process.env.CAT_SWIFT_PATH || 'swift',
    macosCapturePath: process.env.CAT_AUDIO_MACOS_CAPTURE_PATH || resolve(process.cwd(), 'scripts/audio-capture-macos.swift'),
  }
}

export async function getActiveAudioConfig(serialServerUrl?: string): Promise<AudioConfig> {
  return getAudioConfig(await getActiveAudioProfile(serialServerUrl))
}

export async function getAudioStatus(config = getAudioConfig()): Promise<AudioStatus> {
  const publicConfig = {
    enabled: config.enabled,
    transport: config.transport,
    engine: config.engine,
    backend: config.backend,
    input: config.input,
    output: config.output,
    txBackend: config.txBackend,
    txOutput: config.txOutput,
    txChannels: config.txChannels,
    txSampleRate: config.txSampleRate,
    channels: config.channels,
    bitrate: config.bitrate,
    sampleRate: config.sampleRate,
    filter: config.filter,
    gain: config.gain,
    limiter: config.limiter,
    limit: config.limit,
    macosBufferSize: config.macosBufferSize,
    squelchGate: config.squelchGate,
    squelchPollMs: config.squelchPollMs,
    squelchRampMs: config.squelchRampMs,
    webrtcOpus: config.webrtcOpus,
  }

  if (!config.enabled) {
    return {
      ...publicConfig,
      available: false,
      contentType: 'application/octet-stream',
      message: 'Audio streaming is disabled. Set CAT_AUDIO_ENABLED=1 on the radio host.',
    }
  }

  const availability = config.engine === 'macos'
    ? await verifyMacosCapture(config)
    : config.engine === 'bluealsa'
      ? await verifyBlueAlsa()
      : await verifyFfmpeg(config.ffmpegPath)

  return {
    ...publicConfig,
    available: availability.ok,
    contentType: 'application/octet-stream',
    message: availability.ok ? null : availability.message,
  }
}

async function getActiveAudioProfile(serialServerUrl?: string): Promise<ActiveAudioProfile | null> {
  if (!serialServerUrl) return null
  try {
    const response = await fetch(new URL('/raw/status', serialServerUrl))
    if (!response.ok) return null
    const status = await response.json() as { audio?: ActiveAudioProfile }
    return status?.audio ?? null
  } catch {
    return null
  }
}

export function buildAudioProcess(config: AudioConfig, options: AudioStreamOptions = { format: 'pcm' }): { command: string; args: string[] } {
  if (config.engine === 'bluealsa') {
    if (options.format !== 'pcm') throw new Error('BlueALSA audio engine only supports PCM capture')
    return {
      command: process.execPath,
      args: [
        resolve(process.cwd(), 'scripts/bluealsa-capture.mjs'),
        '--addr', process.env.ANYTONE_BT_ADDR || 'AA:BB:CC:DD:EE:FF',
        '--pcm', config.input,
      ],
    }
  }

  if (config.engine === 'macos') {
    if (options.format !== 'pcm') throw new Error('macOS audio engine only supports PCM streaming')
    const sampleRate = options.sampleRate || config.sampleRate
    const channels = options.channels || config.channels
    return {
      command: config.swiftPath,
      args: [
        config.macosCapturePath,
        '--sample-rate', sampleRate,
        '--channels', channels,
        '--buffer-size', config.macosBufferSize,
      ],
    }
  }

  return {
    command: config.ffmpegPath,
    args: buildFfmpegAudioArgs(config, options),
  }
}

export function buildAudioRecordingProcess(config: AudioConfig, options: AudioRecordingOptions): { command: string; args: string[] } {
  if (config.engine === 'macos') throw new Error('Squelch recording requires the ffmpeg audio engine')

  const sampleRate = options.sampleRate || config.sampleRate
  const channelCount = Math.max(1, Number.parseInt(config.channels, 10) || 1)
  const sideChannel = receiveAudioChannelIndex(
    options.side === 'main'
      ? process.env.CAT_AUDIO_MAIN_CHANNEL || 'left'
      : process.env.CAT_AUDIO_SUB_CHANNEL || 'right',
    channelCount,
  )
  const filters = [`pan=mono|c0=c${sideChannel}`]
  if (config.filter) filters.push(config.filter)

  return {
    command: config.ffmpegPath,
    args: [
      '-hide_banner',
      '-y',
      '-loglevel', process.env.CAT_AUDIO_DEBUG === '1' ? 'info' : 'warning',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-flush_packets', '1',
      ...inputArgs(config),
      '-vn',
      '-ac', config.channels,
      '-ar', sampleRate,
      '-af', filters.join(','),
      '-codec:a', 'libmp3lame',
      '-b:a', config.bitrate,
      '-f', 'mp3',
      options.outputPath,
    ],
  }
}

export function buildAudioRecordingEncoderProcess(config: AudioConfig, options: AudioRecordingEncoderOptions): { command: string; args: string[] } {
  const sampleRate = options.sampleRate || config.sampleRate

  return {
    command: config.ffmpegPath,
    args: [
      '-hide_banner',
      '-y',
      '-loglevel', process.env.CAT_AUDIO_DEBUG === '1' ? 'info' : 'warning',
      // Raw s16le from a pipe needs no probing; skip the ~5s analyzeduration
      // buffer so recordings start promptly.
      '-probesize', '32',
      '-analyzeduration', '0',
      '-f', 's16le',
      '-ar', sampleRate,
      '-ac', '1',
      '-i', 'pipe:0',
      '-vn',
      '-codec:a', 'libmp3lame',
      '-b:a', config.bitrate,
      '-f', 'mp3',
      options.outputPath,
    ],
  }
}

export function buildFfmpegAudioArgs(config: AudioConfig, options: AudioStreamOptions = { format: 'pcm' }): string[] {
  const sampleRate = options.sampleRate || config.sampleRate
  const channels = options.channels || config.channels
  const outputArgs = options.format === 'mp3'
    ? ['-codec:a', 'libmp3lame', '-b:a', config.bitrate, '-f', 'mp3']
    : ['-codec:a', 'pcm_s16le', '-f', 's16le']

  return [
    '-hide_banner',
    '-loglevel', process.env.CAT_AUDIO_DEBUG === '1' ? 'info' : 'warning',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-flush_packets', '1',
    ...inputArgs(config),
    '-vn',
    '-ac', channels,
    '-ar', sampleRate,
    ...filterArgs(config, channels),
    ...outputArgs,
    'pipe:1',
  ]
}

export function getAudioContentType(format: AudioStreamOptions['format'], sampleRate: string, channels = '1'): string {
  if (format === 'mp3') return 'audio/mpeg'
  return `application/octet-stream; rate=${sampleRate}; channels=${channels}; format=s16le`
}

function defaultBackend(engine = process.env.CAT_AUDIO_ENGINE || 'bluealsa'): string {
  if (engine === 'bluealsa') return 'bluealsa'
  if (process.platform === 'darwin') return 'avfoundation'
  if (process.platform === 'win32') return 'wasapi'
  return 'alsa'
}

function defaultInput(backend: string): string {
  if (backend === 'bluealsa') return process.env.ANYTONE_BLUEALSA_PCM || '/org/bluealsa/hci0/dev_AA_BB_CC_DD_EE_FF/hfphf/source'
  if (backend === 'avfoundation') return ':0'
  return 'default'
}

function defaultOutput(backend: string, input: string): string {
  if (backend === 'bluealsa') return input.replace(/\/source$/, '/sink')
  return input || 'default'
}

function defaultTxOutput(backend: string, input: string, output: string): string {
  if (backend === 'bluealsa') return input.replace(/\/source$/, '/sink')
  return output || input || 'default'
}

function envInt(name: string, defaultValue: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.round(value) : defaultValue
}

function envOptionalInt(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
}

function getWebRtcOpusOptions(): WebRtcOpusOptions {
  return normalizeWebRtcOpusOptions({
    maxAverageBitrate: envOptionalInt('CAT_AUDIO_WEBRTC_OPUS_BITRATE'),
    maxPlaybackRate: envOptionalInt('CAT_AUDIO_WEBRTC_OPUS_MAX_PLAYBACK_RATE'),
    stereo: envFlag('CAT_AUDIO_WEBRTC_OPUS_STEREO', DEFAULT_WEBRTC_OPUS_OPTIONS.stereo),
    spropStereo: envFlag('CAT_AUDIO_WEBRTC_OPUS_SPROP_STEREO', DEFAULT_WEBRTC_OPUS_OPTIONS.spropStereo),
    useinbandfec: envFlag('CAT_AUDIO_WEBRTC_OPUS_FEC', DEFAULT_WEBRTC_OPUS_OPTIONS.useinbandfec),
    usedtx: envFlag('CAT_AUDIO_WEBRTC_OPUS_DTX', DEFAULT_WEBRTC_OPUS_OPTIONS.usedtx),
    ptime: envOptionalInt('CAT_AUDIO_WEBRTC_OPUS_PTIME'),
    maxptime: envOptionalInt('CAT_AUDIO_WEBRTC_OPUS_MAX_PTIME'),
  })
}

function defaultFilter(gain: string, limiter: boolean, limit: string, highpass?: string): string {
  const filters: string[] = []
  if (highpass && highpass !== '0') filters.push(`highpass=f=${highpass}`)
  filters.push(`volume=${gain}`)
  if (limiter) filters.push(`alimiter=limit=${limit}:level=false`)
  filters.push('aresample=async=1:first_pts=0')
  return filters.join(',')
}

function inputArgs(config: AudioConfig): string[] {
  const backend = config.backend.toLowerCase()
  const queueArgs = ['-thread_queue_size', config.queueSize]

  if (backend === 'avfoundation') {
    const input = config.input.startsWith(':') ? config.input : `:${config.input}`
    return [...queueArgs, '-f', 'avfoundation', '-i', input]
  }

  if (backend === 'dshow') {
    const input = config.input.startsWith('audio=') ? config.input : `audio=${config.input}`
    return [...queueArgs, '-f', 'dshow', '-i', input]
  }

  if (['alsa', 'pulse', 'wasapi'].includes(backend)) {
    return [...queueArgs, '-f', backend, '-i', config.input]
  }

  return [...queueArgs, '-f', backend, '-i', config.input]
}

function filterArgs(config: AudioConfig, outputChannels = config.channels): string[] {
  const filters: string[] = []
  if (Number(outputChannels) === 1) filters.push('pan=mono|c0=c0')
  if (config.filter) filters.push(config.filter)
  return filters.length ? ['-af', filters.join(',')] : []
}

function receiveAudioChannelIndex(value: string, channels: number) {
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'left' || normalized === 'main-left' || normalized === 'sub-left') return 0
  if (normalized === 'right' || normalized === 'main-right' || normalized === 'sub-right') return Math.min(1, channels - 1)
  const numeric = Number.parseInt(normalized, 10)
  if (Number.isFinite(numeric)) return Math.max(0, Math.min(channels - 1, numeric))
  return 0
}

function verifyFfmpeg(ffmpegPath: string): Promise<{ ok: boolean; message: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-version'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ ok: false, message: 'Timed out while checking ffmpeg.' })
    }, 3000)

    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ ok: false, message: `Cannot start ffmpeg: ${err.message}` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ ok: code === 0, message: code === 0 ? null : stderr || `ffmpeg exited with code ${code}` })
    })
  })
}

async function verifyBlueAlsa(): Promise<{ ok: boolean; message: string | null }> {
  const checks = await Promise.all([
    verifyCommand(process.env.ANYTONE_BLUEALSA_COMMAND || 'bluealsa', ['--version']),
    verifyCommand(process.env.ANYTONE_BLUEALSA_CLI_COMMAND || 'bluealsa-cli', ['--version']),
    verifyCommand(process.env.ANYTONE_BLUETOOTHCTL_COMMAND || 'bluetoothctl', ['--version']),
  ])
  const failed = checks.find(check => !check.ok)
  return failed ?? { ok: true, message: null }
}

function verifyCommand(command: string, args: string[]): Promise<{ ok: boolean; message: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ ok: false, message: `Timed out while checking ${command}.` })
    }, 3000)

    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ ok: false, message: `Cannot start ${command}: ${err.message}` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ ok: code === 0, message: code === 0 ? null : stderr || `${command} exited with code ${code}` })
    })
  })
}

async function verifyMacosCapture(config: AudioConfig): Promise<{ ok: boolean; message: string | null }> {
  if (process.platform !== 'darwin') {
    return { ok: false, message: 'CAT_AUDIO_ENGINE=macos is only available on macOS.' }
  }
  if (!existsSync(config.macosCapturePath)) {
    return { ok: false, message: `macOS capture helper not found: ${config.macosCapturePath}` }
  }
  return await verifySwift(config.swiftPath)
}

function verifySwift(swiftPath: string): Promise<{ ok: boolean; message: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(swiftPath, ['--version'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ ok: false, message: 'Timed out while checking swift.' })
    }, 3000)

    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ ok: false, message: `Cannot start swift: ${err.message}` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ ok: code === 0, message: code === 0 ? null : stderr || `swift exited with code ${code}` })
    })
  })
}
