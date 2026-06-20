import { spawn } from 'node:child_process'
import { Transform } from 'node:stream'
import { buildAudioProcess, getActiveAudioConfig, getAudioContentType, type AudioConfig } from '../../utils/audio'
import { RX_AUDIO_CHANNEL_COUNT, RX_AUDIO_SAMPLE_RATE, subscribeRxAudioCapture } from '../../utils/rx-audio-capture'
import { closeAllWebRtcAudioSessions } from '../../utils/webrtc-audio'
import {
  activeReceiveAudioChannel,
  applyReceiveSquelchGate,
  createReceiveSquelchFollower,
  defaultReceiveSquelchState,
  receiveAudioChannelIndex,
  type ReceiveSquelchState,
  squelchOpenForStatus,
} from '../../utils/rx-squelch'

export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const config = await getActiveAudioConfig(serialServerUrl)

  if (!config.enabled) {
    throw createError({ statusCode: 503, message: 'Audio streaming is disabled. Set CAT_AUDIO_ENABLED=1 on the radio host.' })
  }

  const query = getQuery(event)
  const format = query.format === 'mp3' ? 'mp3' : 'pcm'
  const requestedSampleRate = Number(query.sampleRate || config.sampleRate)
  const sampleRate = Number.isFinite(requestedSampleRate)
    ? String(Math.min(96000, Math.max(8000, Math.round(requestedSampleRate))))
    : config.sampleRate
  const requestedChannels = Number(query.channels || 1)
  const channels = String(Number.isFinite(requestedChannels) && requestedChannels === 2 ? 2 : 1)
  const captureChannels = format === 'pcm' && channels === '1' ? '2' : channels
  const shouldSelectActiveMono = format === 'pcm' && channels === '1' && captureChannels !== channels
  const shouldTransformPcm = format === 'pcm' && (config.squelchGate || shouldSelectActiveMono)
  const res = event.node.res

  if (query.exclusive === '1') {
    closeAllWebRtcAudioSessions()
    await delay(350)
  }

  if (format === 'mp3') {
    return streamMp3FromSharedRxCapture(event, config, serialServerUrl, sampleRate, channels)
  }

  if (format === 'pcm') {
    return streamPcmFromSharedRxCapture(event, config, serialServerUrl, sampleRate, channels)
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let headersSent = false
    let stderr = ''
    let squelchState: ReceiveSquelchState = defaultReceiveSquelchState()
    let sseController: AbortController | null = null
    let audioProcessConfig: { command: string; args: string[] }

    try {
      audioProcessConfig = buildAudioProcess(config, { format, sampleRate, channels: captureChannels })
    } catch (err: any) {
      reject(createError({ statusCode: 400, message: err.message }))
      return
    }

    const audioProcess = spawn(audioProcessConfig.command, audioProcessConfig.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const outputStream = shouldTransformPcm
      ? audioProcess.stdout.pipe(createReceiveAudioTransform(
        () => squelchState,
        Number(sampleRate),
        Number(captureChannels),
        Number(channels),
        config.squelchRampMs,
        config.squelchGate,
      ))
      : audioProcess.stdout

    if (shouldTransformPcm) {
      sseController = new AbortController()
      const connectSse = async () => {
        let fullState: any = null
        try {
          const response = await fetch(`${serialServerUrl}/events`, {
            signal: sseController!.signal,
          })
          if (!response.ok || !response.body) return
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6))
                  if (data._delta) {
                    if (!fullState) continue
                    Object.assign(fullState!, data)
                    delete fullState!._delta
                  } else {
                    fullState = data
                  }
                  squelchState = squelchOpenForStatus(fullState)
                } catch { /* skip malformed SSE data */ }
              }
            }
          }
        } catch {
          squelchState = defaultReceiveSquelchState()
        }
      }
      void connectSse()
    }

    const finish = () => {
      if (settled) return
      if (sseController) sseController.abort()
      settled = true
      resolve()
    }

    const fail = (message: string) => {
      if (settled) return
      settled = true
      if (!headersSent && !res.headersSent) {
        reject(createError({ statusCode: 503, message }))
        return
      }
      if (!res.writableEnded) res.end()
      resolve()
    }

    const stop = () => {
      if (!audioProcess.killed) audioProcess.kill('SIGTERM')
      finish()
    }

    audioProcess.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
      if (process.env.CAT_AUDIO_DEBUG === '1') process.stderr.write(chunk)
    })

    outputStream.once('data', firstChunk => {
      headersSent = true
      res.writeHead(200, {
        'Content-Type': getAudioContentType(format, sampleRate, channels),
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(firstChunk)
      outputStream.pipe(res)
    })

    outputStream.on('error', err => fail(`Audio stream failed: ${err.message}`))

    audioProcess.on('error', err => fail(`Cannot start audio process: ${err.message}`))
    audioProcess.on('close', code => {
      if (code === 0 || headersSent) {
        if (!res.writableEnded) res.end()
        finish()
        return
      }
      fail(stderr.trim() || `ffmpeg exited with code ${code}`)
    })

    event.node.req.on('close', stop)
    res.on('close', stop)
  })
})

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeCaptureSampleRate(config: AudioConfig) {
  const value = Number(config.sampleRate)
  return Number.isFinite(value) ? Math.max(8000, Math.min(96000, Math.round(value))) : RX_AUDIO_SAMPLE_RATE
}

function normalizeCaptureChannels(config: AudioConfig) {
  const value = Number(config.channels)
  return Number.isFinite(value) ? Math.max(1, Math.min(8, Math.round(value))) : RX_AUDIO_CHANNEL_COUNT
}

function streamPcmFromSharedRxCapture(event: any, config: AudioConfig, serialServerUrl: string, sampleRate: string, channels: string) {
  const res = event.node.res
  const outputChannels = channels === '2' ? 2 : 1
  const captureSampleRate = normalizeCaptureSampleRate(config)
  const captureChannels = normalizeCaptureChannels(config)
  const outputSampleRate = Math.max(8000, Math.min(96000, Number(sampleRate) || captureSampleRate))
  const shouldResample = outputSampleRate !== captureSampleRate
  const squelchGains = new Array(captureChannels).fill(1)
  const squelchStep = 1 / Math.max(1, Math.round(captureSampleRate * (config.squelchRampMs / 1000)))

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let headersSent = false
    let stderr = ''
    let unsubscribe: (() => void) | null = null
    let squelchState = defaultReceiveSquelchState()
    let squelchFollower: { stop: () => void } | null = createReceiveSquelchFollower({
      serialServerUrl,
      onUpdate: (state) => {
        squelchState = state
      },
    })
    const resampler = shouldResample
      ? spawn(config.ffmpegPath, buildPcmEncoderArgs(config, String(captureSampleRate), String(outputSampleRate), String(outputChannels)), { stdio: ['pipe', 'pipe', 'pipe'] })
      : null

    const cleanup = () => {
      const stopCapture = unsubscribe
      unsubscribe = null
      stopCapture?.()
      const stopSquelch = squelchFollower
      squelchFollower = null
      stopSquelch?.stop()
      if (resampler && !resampler.killed) {
        try { resampler.stdin?.end() } catch {}
        setTimeout(() => {
          if (!resampler.killed) resampler.kill('SIGTERM')
        }, 250)
      }
    }

    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    const fail = (message: string) => {
      if (settled) return
      settled = true
      cleanup()
      if (!headersSent && !res.headersSent) {
        reject(createError({ statusCode: 503, message }))
        return
      }
      if (!res.writableEnded) res.end()
      resolve()
    }

    const sendHeaders = () => {
      if (settled || res.writableEnded || res.destroyed) return
      headersSent = true
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': getAudioContentType('pcm', String(outputSampleRate), String(outputChannels)),
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.flushHeaders?.()
      }
    }

    if (resampler) {
      resampler.stderr.on('data', chunk => {
        stderr += chunk.toString()
        if (stderr.length > 4000) stderr = stderr.slice(-4000)
        if (process.env.CAT_AUDIO_DEBUG === '1') process.stderr.write(chunk)
      })
      resampler.stdout.on('error', err => fail(`PCM stream failed: ${err.message}`))
      resampler.on('error', err => fail(`Cannot start PCM encoder: ${err.message}`))
      resampler.on('close', code => {
        if (settled) return
        if (code === 0 || headersSent) {
          if (!res.writableEnded) res.end()
          finish()
          return
        }
        fail(stderr.trim() || `PCM encoder exited with code ${code}`)
      })
    }

    try {
      unsubscribe = subscribeRxAudioCapture(
        { sampleRate: captureSampleRate, channels: captureChannels, config },
        {
          onFrame: (frame) => {
            if (settled) return
            const pcm = createPlaybackRxFrame(
              frame.data,
              frame.channelCount,
              outputChannels,
              squelchState,
              config.squelchGate,
              squelchGains,
              squelchStep,
            )
            if (resampler) {
              if (resampler.stdin?.writable) resampler.stdin.write(pcm)
            } else if (!res.writableEnded) {
              res.write(pcm)
            }
          },
          onError: message => fail(message),
          onClose: message => fail(message),
        },
      )
      sendHeaders()
      if (resampler) resampler.stdout.pipe(res)
    } catch (err: any) {
      fail(err?.message ?? 'Cannot start shared RX audio capture')
      return
    }

    event.node.req.on('close', finish)
    res.on('close', finish)
  })
}

function streamMp3FromSharedRxCapture(event: any, config: AudioConfig, serialServerUrl: string, sampleRate: string, channels: string) {
  const res = event.node.res
  const outputChannels = channels === '2' ? 2 : 1
  const captureSampleRate = normalizeCaptureSampleRate(config)
  const captureChannels = normalizeCaptureChannels(config)
  const squelchGains = new Array(captureChannels).fill(1)
  const squelchStep = 1 / Math.max(1, Math.round(captureSampleRate * (config.squelchRampMs / 1000)))

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let headersSent = false
    let stderr = ''
    let unsubscribe: (() => void) | null = null
    let squelchState = defaultReceiveSquelchState()
    let squelchFollower: { stop: () => void } | null = createReceiveSquelchFollower({
      serialServerUrl,
      onUpdate: (state) => {
        squelchState = state
      },
    })
    const encoder = spawn(config.ffmpegPath, buildMp3EncoderArgs(config, String(captureSampleRate), sampleRate, String(outputChannels)), { stdio: ['pipe', 'pipe', 'pipe'] })

    const cleanup = () => {
      const stopCapture = unsubscribe
      unsubscribe = null
      stopCapture?.()
      const stopSquelch = squelchFollower
      squelchFollower = null
      stopSquelch?.stop()
      if (!encoder.killed) {
        try { encoder.stdin?.end() } catch {}
        setTimeout(() => {
          if (!encoder.killed) encoder.kill('SIGTERM')
        }, 250)
      }
    }

    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    const fail = (message: string) => {
      if (settled) return
      settled = true
      cleanup()
      if (!headersSent && !res.headersSent) {
        reject(createError({ statusCode: 503, message }))
        return
      }
      if (!res.writableEnded) res.end()
      resolve()
    }

    encoder.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
      if (process.env.CAT_AUDIO_DEBUG === '1') process.stderr.write(chunk)
    })

    const sendHeaders = () => {
      if (settled || res.writableEnded || res.destroyed) return
      headersSent = true
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': getAudioContentType('mp3', sampleRate, String(outputChannels)),
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.flushHeaders?.()
      }
    }

    encoder.stdout.on('error', err => fail(`MP3 stream failed: ${err.message}`))
    encoder.on('error', err => fail(`Cannot start MP3 encoder: ${err.message}`))
    encoder.on('close', code => {
      if (settled) return
      if (code === 0 || headersSent) {
        if (!res.writableEnded) res.end()
        finish()
        return
      }
      fail(stderr.trim() || `MP3 encoder exited with code ${code}`)
    })

    try {
      unsubscribe = subscribeRxAudioCapture(
        { sampleRate: captureSampleRate, channels: captureChannels, config },
        {
          onFrame: (frame) => {
            if (settled || !encoder.stdin?.writable) return
            const pcm = createPlaybackRxFrame(
              frame.data,
              frame.channelCount,
              outputChannels,
              squelchState,
              config.squelchGate,
              squelchGains,
              squelchStep,
            )
            encoder.stdin.write(pcm)
          },
          onError: message => fail(message),
          onClose: message => fail(message),
        },
      )
      sendHeaders()
      encoder.stdout.pipe(res)
    } catch (err: any) {
      fail(err?.message ?? 'Cannot start shared RX audio capture')
      return
    }

    event.node.req.on('close', finish)
    res.on('close', finish)
  })
}

function buildMp3EncoderArgs(config: AudioConfig, inputSampleRate: string, outputSampleRate: string, channels: string) {
  return [
    '-hide_banner',
    '-loglevel', process.env.CAT_AUDIO_DEBUG === '1' ? 'info' : 'warning',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-flush_packets', '1',
    // Raw s16le from a pipe needs no probing; without these ffmpeg buffers ~5s
    // (analyzeduration default) before the first output byte, adding a constant
    // ~5s delay to live RX audio. Mirrors the TX path fix in webrtc-audio.ts.
    '-probesize', '32',
    '-analyzeduration', '0',
    '-f', 's16le',
    '-ar', inputSampleRate,
    '-ac', channels,
    '-i', 'pipe:0',
    '-vn',
    '-ar', outputSampleRate,
    '-af', 'aresample=async=1:first_pts=0',
    '-codec:a', 'libmp3lame',
    '-b:a', config.bitrate,
    '-write_xing', '0',
    '-id3v2_version', '0',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-flush_packets', '1',
    '-f', 'mp3',
    'pipe:1',
  ]
}

function buildPcmEncoderArgs(_config: AudioConfig, inputSampleRate: string, outputSampleRate: string, channels: string) {
  return [
    '-hide_banner',
    '-loglevel', process.env.CAT_AUDIO_DEBUG === '1' ? 'info' : 'warning',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-flush_packets', '1',
    // Raw s16le from a pipe needs no probing; without these ffmpeg buffers ~5s
    // (analyzeduration default) before the first output byte, adding a constant
    // ~5s delay to live RX audio. Mirrors the TX path fix in webrtc-audio.ts.
    '-probesize', '32',
    '-analyzeduration', '0',
    '-f', 's16le',
    '-ar', inputSampleRate,
    '-ac', channels,
    '-i', 'pipe:0',
    '-vn',
    '-ar', outputSampleRate,
    '-af', 'aresample=async=1:first_pts=0',
    '-codec:a', 'pcm_s16le',
    '-f', 's16le',
    'pipe:1',
  ]
}

function createPlaybackRxFrame(
  input: Buffer,
  inputChannels: number,
  outputChannels: number,
  state: ReceiveSquelchState,
  squelchEnabled: boolean,
  squelchGains: number[],
  squelchStep: number,
) {
  const frame = Buffer.from(input)
  if (squelchEnabled) applyReceiveSquelchGate(frame, state, inputChannels, squelchGains, squelchStep)
  if (outputChannels === 1 && inputChannels > 1) return mixReceiveMonoFrame(frame, inputChannels)
  return frame
}

function mixReceiveMonoFrame(input: Buffer, inputChannels: number) {
  if (inputChannels <= 1) return Buffer.from(input)

  const mainChannel = receiveAudioChannelIndex(process.env.CAT_AUDIO_MAIN_CHANNEL || 'left', inputChannels)
  const subChannel = receiveAudioChannelIndex(process.env.CAT_AUDIO_SUB_CHANNEL || 'right', inputChannels)
  const frames = Math.floor(input.length / (inputChannels * 2))
  const output = Buffer.alloc(frames * 2)
  for (let frame = 0; frame < frames; frame += 1) {
    const mainSample = input.readInt16LE((frame * inputChannels + mainChannel) * 2)
    const subSample = input.readInt16LE((frame * inputChannels + subChannel) * 2)
    output.writeInt16LE(clampInt16(mainSample + subSample), frame * 2)
  }
  return output
}

function clampInt16(value: number) {
  return Math.max(-32768, Math.min(32767, value))
}

function createReceiveAudioTransform(
  getState: () => ReceiveSquelchState,
  sampleRate: number,
  inputChannels: number,
  outputChannels: number,
  rampMs: number,
  squelchEnabled: boolean,
) {
  const rampSamples = Math.max(1, Math.round(sampleRate * (rampMs / 1000)))
  const step = 1 / rampSamples
  const gains = new Array(Math.max(1, outputChannels)).fill(1)
  let pending: Buffer | null = null

  return new Transform({
    transform(chunk, _encoding, callback) {
      let input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (pending) {
        input = Buffer.concat([pending, input])
        pending = null
      }
      const frameBytes = inputChannels * 2
      const remainder = input.length % frameBytes
      if (remainder !== 0) {
        pending = input.subarray(input.length - remainder)
        input = input.subarray(0, input.length - remainder)
      }

      const output = outputChannels === 1 && inputChannels > 1
        ? selectActiveRxMonoFrame(getState(), input, inputChannels)
        : Buffer.from(input)

      if (squelchEnabled) applySquelchGate(output, getState(), outputChannels, gains, step)
      if (outputChannels === inputChannels) swapStereoChannels(output, outputChannels)

      callback(null, output)
    },
    flush(callback) {
      pending = null
      callback()
    },
  })
}

function selectActiveRxMonoFrame(state: ReceiveSquelchState, input: Buffer, inputChannels: number) {
  const selectedChannel = activeReceiveAudioChannel(state, inputChannels)
  const frames = Math.floor(input.length / (inputChannels * 2))
  const output = Buffer.alloc(frames * 2)
  for (let frame = 0; frame < frames; frame += 1) {
    output.writeInt16LE(input.readInt16LE((frame * inputChannels + selectedChannel) * 2), frame * 2)
  }
  return output
}

function applySquelchGate(output: Buffer, state: ReceiveSquelchState, channels: number, gains: number[], step: number) {
  applyReceiveSquelchGate(output, state, channels, gains, step)
}

function swapStereoChannels(buffer: Buffer, channels: number) {
  if (channels !== 2) return

  for (let offset = 0; offset < buffer.length; offset += 4) {
    const left = buffer.readInt16LE(offset)
    const right = buffer.readInt16LE(offset + 2)
    buffer.writeInt16LE(right, offset)
    buffer.writeInt16LE(left, offset + 2)
  }
}
