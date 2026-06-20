import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { tuneOpusSessionDescription } from '../../utils/webrtc-sdp'
import { getAudioConfig, type AudioConfig } from './audio'
import { RX_AUDIO_CHANNEL_COUNT, RX_AUDIO_SAMPLE_RATE, subscribeRxAudioCapture } from './rx-audio-capture'
import {
  activeReceiveAudioChannel,
  applyReceiveSquelchGate,
  createReceiveSquelchFollower,
  defaultReceiveSquelchState,
  receiveAudioChannelIndex,
  receiveSquelchTargets,
  type ReceiveSquelchState,
} from './rx-squelch'

const require = createRequire(import.meta.url)
const wrtc: any = require('@roamhq/wrtc')

interface WebRtcSession {
  id: string
  audioConfig: AudioConfig
  pc: any
  audioSource: any
  audioTrack: any
  audioCaptureStop: (() => void) | null
  txSink: any | null
  txOutputProcess: ReturnType<typeof spawn> | null
  txSinkProcess: ReturnType<typeof spawn> | null
  txFrames: number
  txBytes: number
  txPeak: number
  txResampledFrames: number
  txDroppedFrames: number
  txGatedFrames: number
  txFirstFrameAt: number | null
  txLastFrameAt: number | null
  txOutputStartedAt: number | null
  txOutputError: string | null
  closeTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
  squelchFollower: { stop: () => void } | null
  rxSquelchState: ReceiveSquelchState
  rxSquelchEnabled: boolean
  rxSquelchGains: number[]
  rxSquelchStep: number
  rxSampleRate: number
  rxChannelCount: number
  rxInputChannelCount: number
  rxOutputChannelCount: number
  rxMix: WebRtcRxMix
}

export interface WebRtcRxMix {
  mainGain: number
  subGain: number
  mainMuted: boolean
  subMuted: boolean
}

interface OfferBody {
  type: 'offer'
  sdp: string
}

const TX_INPUT_SAMPLE_RATE = Number(process.env.CAT_AUDIO_TX_INPUT_SAMPLE_RATE) || 48000
// One 10ms mono s16 frame at the pinned TX input rate.
const TX_FRAME_BYTES = (TX_INPUT_SAMPLE_RATE / 100) * 2

// The radio mutes its HFP source while transmitting, so TX recordings cannot
// come from the radio capture. Publish the normalized browser-mic PCM here so
// the recordings manager can use it as the TX clip source.
export const WEBRTC_TX_MIC_SAMPLE_RATE = TX_INPUT_SAMPLE_RATE
type TxMicListener = (frame: Buffer) => void
const txMicListeners = globalThis.__anytoneTxMicListeners ||= new Set<TxMicListener>()

// PTT gate: only feed the HFP TX sink while keyed. Feeding it continuously (the
// old behavior) let the bluealsa/SCO buffer accumulate multiple seconds of
// latency. SCO stays up via the RX capture, so resuming on PTT is immediate.
// Driven by /api/command (TX1/TX0). Disable with CAT_AUDIO_TX_PTT_GATE=0.
const TX_PTT_GATE = !['0', 'false', 'no', 'off'].includes((process.env.CAT_AUDIO_TX_PTT_GATE || '1').toLowerCase())
const txPttState = globalThis.__anytoneTxPttState ||= { active: false }

declare global {
  // eslint-disable-next-line no-var
  var __anytoneTxMicListeners: Set<TxMicListener> | undefined
  // eslint-disable-next-line no-var
  var __anytoneTxPttState: { active: boolean } | undefined
}

export function setWebRtcTxPttActive(on: boolean) {
  const active = !!on
  txPttState.active = active
  if (TX_PTT_GATE && !active) {
    for (const session of sessions.values()) stopTxOutput(session)
  }
}

export function subscribeWebRtcTxMicAudio(listener: TxMicListener) {
  txMicListeners.add(listener)
  return () => { txMicListeners.delete(listener) }
}
const RX_OUTPUT_CHANNEL_COUNT = 1
const BITS_PER_SAMPLE = 16
const DEFAULT_ICE_DISCONNECT_GRACE_MS = 30000
const DEFAULT_RX_MIX: WebRtcRxMix = {
  mainGain: 1,
  subGain: 1,
  mainMuted: false,
  subMuted: false,
}

const sessions = globalThis.__anytoneWebRtcAudioSessions ||= new Map<string, WebRtcSession>()
const expectedTxOutputStops = new WeakSet<object>()
const expectedTxSinkStops = new WeakSet<object>()

declare global {
  // eslint-disable-next-line no-var
  var __anytoneWebRtcAudioSessions: Map<string, WebRtcSession> | undefined
}

export async function createWebRtcAudioSession(offer: OfferBody, config = getAudioConfig()) {
  if (!config.enabled) throw new Error('Audio streaming is disabled. Set CAT_AUDIO_ENABLED=1 on the radio host.')
  const rxSampleRate = normalizeSessionSampleRate(config)
  const rxInputChannelCount = normalizeSessionChannels(config)

  const pc = new wrtc.RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  })
  const audioSource = new wrtc.nonstandard.RTCAudioSource()
  const audioTrack = audioSource.createTrack()
  const id = randomUUID()
  const session: WebRtcSession = {
    id,
    audioConfig: config,
    pc,
    audioSource,
    audioTrack,
    audioCaptureStop: null,
    txSink: null,
    txOutputProcess: null,
    txSinkProcess: null,
    txFrames: 0,
    txBytes: 0,
    txPeak: 0,
    txResampledFrames: 0,
    txDroppedFrames: 0,
    txGatedFrames: 0,
    txFirstFrameAt: null,
    txLastFrameAt: null,
    txOutputStartedAt: null,
    txOutputError: null,
    closeTimer: null,
    closed: false,
    squelchFollower: null,
    rxSquelchState: defaultReceiveSquelchState(),
    rxSquelchEnabled: config.squelchGate,
    rxSquelchGains: [1],
    rxSquelchStep: 0.02,
    rxSampleRate,
    rxChannelCount: RX_OUTPUT_CHANNEL_COUNT,
    rxInputChannelCount,
    rxOutputChannelCount: RX_OUTPUT_CHANNEL_COUNT,
    rxMix: { ...DEFAULT_RX_MIX },
  }

  for (const existingId of sessions.keys()) closeWebRtcAudioSession(existingId)
  sessions.set(id, session)
  pc.addTrack(audioTrack)

  pc.ontrack = (event: any) => {
    if (event.track?.kind === 'audio') startTxPlayback(session, event.track)
  }

  pc.onconnectionstatechange = () => updateWebRtcSessionCloseTimer(session)
  pc.oniceconnectionstatechange = () => updateWebRtcSessionCloseTimer(session)

  await pc.setRemoteDescription(offer)
  const answer = tuneOpusSessionDescription(await pc.createAnswer(), config.webrtcOpus)
  await pc.setLocalDescription(answer)
  await waitForIceGathering(pc)
  startAudioCapture(session)
  startRxSquelch(session)

  return {
    sessionId: id,
    answer: pc.localDescription,
  }
}

export async function renegotiateWebRtcAudioSession(id: string, offer: OfferBody) {
  const session = sessions.get(id)
  if (!session || session.closed) throw new Error('WebRTC audio session not found')

  clearWebRtcSessionCloseTimer(session)
  await session.pc.setRemoteDescription(offer)
  const answer = tuneOpusSessionDescription(await session.pc.createAnswer(), session.audioConfig.webrtcOpus)
  await session.pc.setLocalDescription(answer)
  await waitForIceGathering(session.pc)
  updateWebRtcSessionCloseTimer(session)

  return {
    sessionId: id,
    answer: session.pc.localDescription,
  }
}

export function closeWebRtcAudioSession(id: string) {
  const session = sessions.get(id)
  if (!session || session.closed) return false
  session.closed = true
  sessions.delete(id)

  clearWebRtcSessionCloseTimer(session)
  session.audioCaptureStop?.()
  session.audioCaptureStop = null
  try { session.txSink?.stop() } catch {}
  session.txSink = null
  session.squelchFollower?.stop()
  session.squelchFollower = null
  stopTxOutput(session)
  try { session.audioTrack.stop() } catch {}
  try { session.pc.close() } catch {}
  return true
}

export function closeAllWebRtcAudioSessions() {
  let closed = 0
  for (const id of Array.from(sessions.keys())) {
    if (closeWebRtcAudioSession(id)) closed += 1
  }
  return closed
}

function updateWebRtcSessionCloseTimer(session: WebRtcSession) {
  if (session.closed) return

  const connectionState = session.pc.connectionState
  const iceConnectionState = session.pc.iceConnectionState
  if (connectionState === 'closed' || iceConnectionState === 'closed') {
    closeWebRtcAudioSession(session.id)
    return
  }

  if (
    connectionState === 'disconnected' ||
    connectionState === 'failed' ||
    iceConnectionState === 'disconnected' ||
    iceConnectionState === 'failed'
  ) {
    scheduleWebRtcSessionClose(session)
    return
  }

  clearWebRtcSessionCloseTimer(session)
}

function scheduleWebRtcSessionClose(session: WebRtcSession) {
  if (session.closeTimer) return
  session.closeTimer = setTimeout(() => {
    session.closeTimer = null
    closeWebRtcAudioSession(session.id)
  }, webRtcIceDisconnectGraceMs())
}

function clearWebRtcSessionCloseTimer(session: WebRtcSession) {
  if (!session.closeTimer) return
  clearTimeout(session.closeTimer)
  session.closeTimer = null
}

function webRtcIceDisconnectGraceMs() {
  const value = Number(process.env.CAT_AUDIO_WEBRTC_DISCONNECT_GRACE_MS ?? process.env.CAT_WEBRTC_DISCONNECT_GRACE_MS)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ICE_DISCONNECT_GRACE_MS
  return Math.round(value)
}

function normalizeSessionSampleRate(config: AudioConfig) {
  const value = Number(config.sampleRate)
  return Number.isFinite(value) ? Math.max(8000, Math.min(96000, Math.round(value))) : RX_AUDIO_SAMPLE_RATE
}

function normalizeSessionChannels(config: AudioConfig) {
  const value = Number(config.channels)
  return Number.isFinite(value) ? Math.max(1, Math.min(8, Math.round(value))) : RX_AUDIO_CHANNEL_COUNT
}

export function setWebRtcAudioRxMix(id: string, mix: Partial<WebRtcRxMix>) {
  const session = sessions.get(id)
  if (!session || session.closed) throw new Error('WebRTC audio session not found')

  session.rxMix = normalizeRxMix({ ...session.rxMix, ...mix })
  return {
    ok: true,
    rxMix: session.rxMix,
  }
}

export function getWebRtcAudioSessionStatus() {
  return {
    sessions: Array.from(sessions.values()).map(session => ({
      id: session.id,
      connectionState: session.pc.connectionState,
      iceConnectionState: session.pc.iceConnectionState,
      txFrames: session.txFrames,
      txBytes: session.txBytes,
      txPeak: session.txPeak,
      txResampledFrames: session.txResampledFrames,
      txDroppedFrames: session.txDroppedFrames,
      txGatedFrames: session.txGatedFrames,
      txSinkActive: !!session.txSink,
      txFirstFrameAt: session.txFirstFrameAt,
      txLastFrameAt: session.txLastFrameAt,
      txOutputActive: !!session.txOutputProcess && !session.txOutputProcess.killed,
      txOutputStartedAt: session.txOutputStartedAt,
      txOutputError: session.txOutputError,
      rxChannelCount: session.rxChannelCount,
      rxInputChannelCount: session.rxInputChannelCount,
      rxOutputChannelCount: session.rxOutputChannelCount,
      rxActiveChannel: activeReceiveAudioChannel(session.rxSquelchState, session.rxInputChannelCount),
      rxMix: session.rxMix,
      rxSquelchEnabled: session.rxSquelchEnabled,
      rxSquelch: session.rxSquelchState,
      rxSquelchTargets: receiveSquelchTargets(session.rxSquelchState, session.rxInputChannelCount),
      rxSquelchGains: session.rxSquelchGains,
      audio: {
        transport: session.audioConfig.transport,
        engine: session.audioConfig.engine,
        backend: session.audioConfig.backend,
        input: session.audioConfig.input,
        txBackend: session.audioConfig.txBackend,
        txOutput: session.audioConfig.txOutput,
      },
    })),
  }
}

function startAudioCapture(session: WebRtcSession) {
  const config = session.audioConfig
  const sampleRate = session.rxSampleRate
  const inputChannelCount = session.rxInputChannelCount
  const outputChannelCount = RX_OUTPUT_CHANNEL_COUNT
  session.rxInputChannelCount = inputChannelCount
  session.rxOutputChannelCount = outputChannelCount
  session.rxChannelCount = outputChannelCount
  session.rxSquelchGains = new Array(inputChannelCount).fill(1)
  session.rxSquelchStep = 1 / Math.max(1, Math.round(sampleRate * (config.squelchRampMs / 1000)))

  try {
    session.audioCaptureStop = subscribeRxAudioCapture(
      { sampleRate, channels: inputChannelCount, config },
      {
        onFrame: (frame) => {
          if (session.closed) return
          const squelchedFrame = Buffer.from(frame.data)
          applyRxSquelch(session, squelchedFrame, inputChannelCount)
          const monoFrame = mixRxMonoFrame(session, squelchedFrame, inputChannelCount)
          session.audioSource.onData({
            samples: bufferToInt16(monoFrame),
            sampleRate: frame.sampleRate,
            bitsPerSample: BITS_PER_SAMPLE,
            channelCount: outputChannelCount,
            numberOfFrames: frame.numberOfFrames,
          })
        },
        onError: message => {
          if (!session.closed) console.error('[webrtc-audio] RX audio capture error:', message)
        },
        onClose: message => {
          if (!session.closed) {
            console.error('[webrtc-audio] RX audio capture ended:', message)
            closeWebRtcAudioSession(session.id)
          }
        },
      },
    )
  } catch (err: any) {
    closeWebRtcAudioSession(session.id)
    throw err
  }
}

function startTxPlayback(session: WebRtcSession, track: any) {
  try { session.txSink?.stop() } catch {}
  session.txSink = new wrtc.nonstandard.RTCAudioSink(track)

  session.txSink.ondata = (data: any) => {
    if (session.closed) return
    let buffer = audioDataToMono16Buffer(data.samples, data.channelCount || 1)
    const peak = peakInt16(data.samples)
    session.txFrames++
    session.txBytes += buffer.length
    session.txPeak = Math.max(session.txPeak, peak)
    session.txFirstFrameAt ||= Date.now()
    session.txLastFrameAt = Date.now()
    // RTCAudioSink delivers 10ms frames but intermittently switches sample rate
    // (e.g. 160-sample 16 kHz frames between 480-sample 48 kHz ones). ffmpeg is
    // told the stream is a constant 48 kHz, so any odd-sized frame would play at
    // the wrong speed and garble the TX audio — stretch each one to 10ms @ 48 kHz.
    if (buffer.length !== TX_FRAME_BYTES && buffer.length >= 2) {
      buffer = stretchMono16(buffer, TX_FRAME_BYTES / 2)
      session.txResampledFrames++
    }
    for (const listener of txMicListeners) {
      try { listener(buffer) } catch {}
    }
    // PTT gate: while unkeyed, don't open or feed the sink, so BlueALSA/ffmpeg
    // cannot carry stale buffered state into the next key-up.
    if (TX_PTT_GATE && !txPttState.active) {
      session.txGatedFrames = (session.txGatedFrames || 0) + 1
      return
    }

    const output = ensureTxOutputProcess(session, TX_INPUT_SAMPLE_RATE)
    if (!output?.stdin?.writable) return

    // Drop frames instead of queueing when downstream stalls: a backlog here
    // never drains (real-time in, real-time out) and becomes permanent
    // PTT-to-RF latency. 200ms of 48kHz mono s16 ≈ 19200 bytes.
    if (output.stdin.writableLength > 19200) {
      session.txDroppedFrames++
      return
    }

    output.stdin.write(buffer)
  }
}

function ensureTxOutputProcess(session: WebRtcSession, sampleRate: number) {
  if (session.txOutputProcess && !session.txOutputProcess.killed) return session.txOutputProcess

  const config = session.audioConfig
  const backend = config.txBackend || (config.engine === 'bluealsa' ? 'bluealsa' : 'alsa')
  const output = config.txOutput || (backend === 'bluealsa' ? config.input.replace(/\/source$/, '/sink') : config.output || config.input || 'default')
  const outputChannels = config.txChannels || '1'
  const outputSampleRate = config.txSampleRate || String(session.rxSampleRate)
  // Browser mics run hot into the radio's narrowband mic input; scale down to
  // avoid overmodulation. Tune with CAT_AUDIO_TX_GAIN (1.0 = unity).
  const txGain = process.env.CAT_AUDIO_TX_GAIN || '0.7'
  // BlueALSA HFP sink: ffmpeg resamples mic PCM to the radio's 8 kHz mono
  // stream on stdout, and `bluealsa-cli open <sink>` plays stdin to the radio.
  const ffmpegOutput = backend === 'bluealsa'
    ? ['-af', `volume=${txGain}`, '-ar', outputSampleRate, '-ac', outputChannels, '-f', 's16le', 'pipe:1']
    : ['-af', `volume=${txGain}`, '-ar', outputSampleRate, '-ac', outputChannels, '-f', backend, output]
  const audioProcess = spawn(config.ffmpegPath, [
    '-hide_banner',
    '-loglevel', process.env.CAT_AUDIO_DEBUG === '1' ? 'info' : 'warning',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    // Without these, ffmpeg buffers ~5s of mic audio probing the pipe before
    // the first output byte (analyzeduration default) — measured as a constant
    // ~4.3s PTT-to-RF delay. Raw s16le needs no probing.
    '-probesize', '32',
    '-analyzeduration', '0',
    '-f', 's16le',
    '-ar', String(sampleRate),
    '-ac', '1',
    '-i', 'pipe:0',
    '-flush_packets', '1',
    ...ffmpegOutput,
  ], { stdio: ['pipe', backend === 'bluealsa' ? 'pipe' : 'ignore', 'pipe'] })

  if (backend === 'bluealsa') {
    // Target the app's isolated BlueALSA instance (org.bluealsa.<suffix>) via -B.
    const bluealsaDbus = process.env.ANYTONE_BLUEALSA_DBUS ?? 'anytone'
    const cliPre = bluealsaDbus ? ['-B', bluealsaDbus] : []
    const sinkProcess = spawn(process.env.ANYTONE_BLUEALSA_CLI_COMMAND || 'bluealsa-cli', [...cliPre, 'open', output], { stdio: ['pipe', 'ignore', 'pipe'] })
    session.txSinkProcess = sinkProcess
    audioProcess.stdout!.pipe(sinkProcess.stdin!)
    let sinkStderr = ''
    sinkProcess.stderr!.on('data', chunk => {
      sinkStderr += chunk.toString()
      if (sinkStderr.length > 4000) sinkStderr = sinkStderr.slice(-4000)
      if (process.env.CAT_AUDIO_DEBUG === '1') process.stderr.write(chunk)
    })
    sinkProcess.on('error', err => {
      session.txOutputError = `bluealsa-cli: ${err.message}`
      console.error('[webrtc-audio] Cannot start BlueALSA TX sink:', err.message)
    })
    sinkProcess.on('close', code => {
      const expected = expectedTxSinkStops.has(sinkProcess)
      expectedTxSinkStops.delete(sinkProcess)
      if (session.txSinkProcess === sinkProcess) session.txSinkProcess = null
      if (!expected && !session.closed && code !== 0) {
        session.txOutputError = sinkStderr.trim() || `bluealsa-cli exited (code ${code})`
        console.error('[webrtc-audio] BlueALSA TX sink exited:', session.txOutputError)
      }
    })
  }

  session.txOutputProcess = audioProcess
  session.txOutputStartedAt = Date.now()
  session.txOutputError = null
  let stderr = ''

  audioProcess.stderr?.on('data', chunk => {
    stderr += chunk.toString()
    if (stderr.length > 4000) stderr = stderr.slice(-4000)
    if (process.env.CAT_AUDIO_DEBUG === '1') process.stderr.write(chunk)
  })

  audioProcess.on('error', err => {
    session.txOutputError = err.message
    console.error('[webrtc-audio] Cannot start TX audio output:', err.message)
  })

  audioProcess.on('close', code => {
    const expected = expectedTxOutputStops.has(audioProcess)
    expectedTxOutputStops.delete(audioProcess)
    if (session.txOutputProcess === audioProcess) session.txOutputProcess = null
    if (!expected && !session.closed && code !== 0) {
      session.txOutputError = stderr.trim() || `code ${code}`
      console.error('[webrtc-audio] TX audio output exited:', session.txOutputError)
    }
  })

  return audioProcess
}

function stopTxOutput(session: WebRtcSession) {
  const output = session.txOutputProcess
  const sink = session.txSinkProcess
  session.txOutputProcess = null
  session.txSinkProcess = null
  if (sink) {
    expectedTxSinkStops.add(sink)
    setTimeout(() => {
      if (!sink.killed) sink.kill('SIGTERM')
    }, 400)
  }
  if (!output) return
  expectedTxOutputStops.add(output)
  try { output.stdin?.end() } catch {}
  setTimeout(() => {
    if (!output.killed) output.kill('SIGTERM')
  }, 250)
}

function startRxSquelch(session: WebRtcSession) {
  // The same follower supplies txVfo for active-channel selection; squelch gating is optional.
  const serialServerUrl = process.env.NUXT_SERIAL_SERVER_URL || 'http://127.0.0.1:3001'
  session.squelchFollower = createReceiveSquelchFollower({
    serialServerUrl,
    onUpdate: (state) => {
      session.rxSquelchState = state
    },
  })
}

function applyRxSquelch(session: WebRtcSession, frame: Buffer, channelCount: number) {
  if (!session.rxSquelchEnabled) return
  applyReceiveSquelchGate(frame, session.rxSquelchState, channelCount, session.rxSquelchGains, session.rxSquelchStep)
}

function mixRxMonoFrame(session: WebRtcSession, frame: Buffer, channelCount: number) {
  if (channelCount <= 1) return Buffer.from(frame)

  const mainChannel = receiveAudioChannelIndex(process.env.CAT_AUDIO_MAIN_CHANNEL || 'left', channelCount)
  const subChannel = receiveAudioChannelIndex(process.env.CAT_AUDIO_SUB_CHANNEL || 'right', channelCount)
  const mainGain = session.rxMix.mainMuted ? 0 : session.rxMix.mainGain
  const subGain = session.rxMix.subMuted ? 0 : session.rxMix.subGain
  const frames = Math.floor(frame.length / (channelCount * 2))
  const output = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i += 1) {
    const mainSample = frame.readInt16LE((i * channelCount + mainChannel) * 2)
    const subSample = frame.readInt16LE((i * channelCount + subChannel) * 2)
    const mixed = mainSample * mainGain + subSample * subGain
    output.writeInt16LE(clampInt16(Math.round(mixed)), i * 2)
  }
  return output
}

function normalizeRxMix(mix: Partial<WebRtcRxMix>): WebRtcRxMix {
  return {
    mainGain: normalizeGain(mix.mainGain, DEFAULT_RX_MIX.mainGain),
    subGain: normalizeGain(mix.subGain, DEFAULT_RX_MIX.subGain),
    mainMuted: mix.mainMuted === true,
    subMuted: mix.subMuted === true,
  }
}

function normalizeGain(value: unknown, fallback: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(1, number))
}

function clampInt16(value: number) {
  return Math.max(-32768, Math.min(32767, value))
}

function audioDataToMono16Buffer(samples: Int16Array, channelCount: number) {
  if (channelCount <= 1) return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)

  const frames = Math.floor(samples.length / channelCount)
  const inputChannel = dominantAudioChannel(samples, channelCount, frames)
  const buffer = Buffer.alloc(frames * 2)
  for (let frame = 0; frame < frames; frame++) {
    buffer.writeInt16LE(samples[frame * channelCount + inputChannel] || 0, frame * 2)
  }
  return buffer
}

// Linear-interpolation resample of a mono s16 buffer to a fixed sample count.
// Used to normalize RTCAudioSink's occasional off-rate frames to 10ms @ 48 kHz;
// interpolation images land above 8 kHz and are removed by the ffmpeg downsample.
function stretchMono16(buffer: Buffer, outSamples: number) {
  const inSamples = buffer.length / 2
  const out = Buffer.alloc(outSamples * 2)
  if (inSamples === 1) {
    const v = buffer.readInt16LE(0)
    for (let i = 0; i < outSamples; i++) out.writeInt16LE(v, i * 2)
    return out
  }
  const step = (inSamples - 1) / (outSamples - 1)
  for (let i = 0; i < outSamples; i++) {
    const pos = i * step
    const base = Math.min(Math.floor(pos), inSamples - 2)
    const frac = pos - base
    const a = buffer.readInt16LE(base * 2)
    const b = buffer.readInt16LE((base + 1) * 2)
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2)
  }
  return out
}

function dominantAudioChannel(samples: Int16Array, channelCount: number, frames: number) {
  let bestChannel = 0
  let bestPeak = 0

  for (let channel = 0; channel < channelCount; channel += 1) {
    let peak = 0
    for (let frame = 0; frame < frames; frame += 1) {
      const value = Math.abs(samples[frame * channelCount + channel] || 0)
      if (value > peak) peak = value
    }
    if (peak > bestPeak) {
      bestPeak = peak
      bestChannel = channel
    }
  }

  return bestChannel
}

function peakInt16(samples: Int16Array) {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i] || 0)
    if (value > peak) peak = value
  }
  return peak
}

function bufferToInt16(buffer: Buffer) {
  const samples = new Int16Array(buffer.length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(i * 2)
  return samples
}

function waitForIceGathering(pc: any) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(done, 2000)
    function done() {
      clearTimeout(timeout)
      pc.removeEventListener?.('icegatheringstatechange', check)
      resolve()
    }
    function check() {
      if (pc.iceGatheringState === 'complete') done()
    }
    pc.addEventListener?.('icegatheringstatechange', check)
    pc.onicegatheringstatechange = check
  })
}
