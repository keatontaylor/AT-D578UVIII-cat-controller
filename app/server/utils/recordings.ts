import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { buildAudioRecordingEncoderProcess, getAudioConfig } from './audio'
import { RX_AUDIO_CHANNEL_COUNT, RX_AUDIO_SAMPLE_RATE, subscribeRxAudioCapture, type RxAudioFrame } from './rx-audio-capture'
import { WEBRTC_TX_MIC_SAMPLE_RATE, subscribeWebRtcTxMicAudio } from './webrtc-audio'
import {
  applyReceiveSquelchGate,
  createReceiveSquelchFollower,
  defaultReceiveSquelchState,
  receiveAudioChannelIndex,
  squelchOpenForStatus,
  type ReceiveSquelchState,
} from './rx-squelch'
import { readScanGroups } from './scan-groups'

export interface RecordingSettings {
  enabled: boolean
  tailMs: number
  minDurationMs: number
}

export interface RecordingClip {
  id: string
  kind: 'rx' | 'tx'
  side: 'main' | 'sub'
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  fileName: string
  relativePath: string
  contentType: string
  bytes: number | null
  laneKey: string
  laneLabel: string
  freq: number | null
  mode: string | null
  vfoMode: string | null
  memoryChannel: string | null
  memoryTag: string | null
  scanGroupNames: string[]
  rxMode: string | null
  txVfo: 0 | 1 | null
  meter: number | null
  squelch: number | null
  error: string | null
}

type ActiveRecordingKey = 'main' | 'sub' | 'tx'

interface ActiveRecording {
  key: ActiveRecordingKey
  clip: RecordingClip
  process: ChildProcess
  closeTimer: ReturnType<typeof setTimeout> | null
  killTimer: ReturnType<typeof setTimeout> | null
  forceFinishTimer: ReturnType<typeof setTimeout> | null
  stopRequestedAt: number | null
  finished: boolean
  sampleRate: number
  audioBytesWritten: number
}

interface RecordingsConfig {
  clips: RecordingClip[]
}

interface RecordingsQuery {
  from?: number
  to?: number
}

// Capture and TX-mic PCM are both signed 16-bit mono once written to ffmpeg.
const BYTES_PER_SAMPLE = 2

const DEFAULT_SETTINGS: RecordingSettings = {
  enabled: false,
  tailMs: 250,
  minDurationMs: 700,
}

function recordingsRoot(): string {
  if (process.env.CAT_RECORDINGS_PATH) return resolve(process.env.CAT_RECORDINGS_PATH)
  const dataDir = process.env.CAT_DATA_PATH || resolve(process.cwd(), '.data')
  return resolve(dataDir, 'recordings')
}

function indexPath() {
  return resolve(recordingsRoot(), 'index.json')
}

function settingsPath() {
  return resolve(recordingsRoot(), 'settings.json')
}

function dayPath(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function normalizeClip(value: any): RecordingClip | null {
  const id = String(value?.id ?? '').trim()
  const fileName = String(value?.fileName ?? '').trim()
  const relativePath = String(value?.relativePath ?? '').trim()
  if (!id || !fileName || !relativePath) return null

  return {
    id,
    kind: value?.kind === 'tx' ? 'tx' : 'rx',
    side: value?.side === 'sub' ? 'sub' : 'main',
    startedAt: Number(value?.startedAt) || Date.now(),
    endedAt: value?.endedAt == null ? null : Number(value.endedAt),
    durationMs: value?.durationMs == null ? null : Number(value.durationMs),
    fileName,
    relativePath,
    contentType: String(value?.contentType || 'audio/mpeg'),
    bytes: value?.bytes == null ? null : Number(value.bytes),
    laneKey: String(value?.laneKey || 'unknown'),
    laneLabel: String(value?.laneLabel || 'Unknown'),
    freq: value?.freq == null ? null : Number(value.freq),
    mode: value?.mode == null ? null : String(value.mode),
    vfoMode: value?.vfoMode == null ? null : String(value.vfoMode),
    memoryChannel: value?.memoryChannel == null ? null : String(value.memoryChannel),
    memoryTag: value?.memoryTag == null ? null : String(value.memoryTag),
    scanGroupNames: Array.isArray(value?.scanGroupNames) ? value.scanGroupNames.map(String) : [],
    rxMode: value?.rxMode == null ? null : String(value.rxMode),
    txVfo: value?.txVfo === 1 ? 1 : value?.txVfo === 0 ? 0 : null,
    meter: value?.meter == null ? null : Number(value.meter),
    squelch: value?.squelch == null ? null : Number(value.squelch),
    error: value?.error == null ? null : String(value.error),
  }
}

function normalizeTailMs(value: unknown) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_SETTINGS.tailMs
  return Math.max(0, Math.round(number))
}

class RecordingsManager {
  private serialServerUrl: string
  private initialized = false
  private settings: RecordingSettings = { ...DEFAULT_SETTINGS }
  private clips: RecordingClip[] = []
  private active = new Map<ActiveRecordingKey, ActiveRecording>()
  private stopped = false
  private squelchFollower: { stop: () => void } | null = null
  private captureStop: (() => void) | null = null
  private captureAudioKey: string | null = null
  private txMicStop: (() => void) | null = null
  private captureSampleRate = RX_AUDIO_SAMPLE_RATE
  private captureChannelCount = RX_AUDIO_CHANNEL_COUNT
  private recordingSquelchState: ReceiveSquelchState = defaultReceiveSquelchState()
  private recordingSquelchEnabled = false
  private recordingSquelchGains = new Array(RX_AUDIO_CHANNEL_COUNT).fill(1)
  private recordingSquelchStep = 1
  private statusQueue: Promise<void> = Promise.resolve()
  private indexSaveQueue: Promise<void> = Promise.resolve()
  private latestStatus: any = null
  private lastError: string | null = null

  constructor(serialServerUrl: string) {
    this.serialServerUrl = serialServerUrl
  }

  async init() {
    if (this.initialized) return
    this.initialized = true
    await mkdir(recordingsRoot(), { recursive: true })
    await Promise.all([this.loadSettings(), this.loadIndex()])
    if (this.settings.enabled) this.startFollower()
  }

  status() {
    if (!this.settings.enabled && this.active.size > 0) this.stopAllActive()
    return {
      settings: this.settings,
      active: Array.from(this.active.values()).map(item => item.clip),
      lastError: this.lastError,
    }
  }

  async setEnabled(enabled: boolean) {
    await this.init()
    this.settings = { ...this.settings, enabled }
    await this.saveSettings()
    if (enabled) this.startFollower()
    else this.stopFollower()
    return this.status()
  }

  async updateSettings(patch: Partial<RecordingSettings>) {
    await this.init()
    if (patch.enabled !== undefined) return this.setEnabled(patch.enabled)
    if (patch.tailMs !== undefined) this.settings.tailMs = Math.max(0, Number(patch.tailMs) || 0)
    if (patch.minDurationMs !== undefined) this.settings.minDurationMs = Math.max(0, Number(patch.minDurationMs) || 0)
    await this.saveSettings()
    return this.status()
  }

  async query(query: RecordingsQuery = {}) {
    await this.init()
    const from = query.from ?? 0
    const to = query.to ?? Number.MAX_SAFE_INTEGER
    const clips = this.clips
      .filter(clip => clip.startedAt <= to && (clip.endedAt ?? Date.now()) >= from)
      .sort((a, b) => a.startedAt - b.startedAt)
    return { clips, status: this.status() }
  }

  async audioPath(id: string) {
    await this.init()
    const clip = this.clips.find(item => item.id === id)
    if (!clip) return null
    return { clip, path: resolve(recordingsRoot(), clip.relativePath) }
  }

  async audioStream(id: string) {
    const item = await this.audioPath(id)
    if (!item) return null
    return { clip: item.clip, stream: createReadStream(item.path) }
  }

  async delete(id: string) {
    await this.init()
    const active = Array.from(this.active.values()).find(item => item.clip.id === id)
    if (active) this.stopActive(active.key)
    const clip = this.clips.find(item => item.id === id)
    this.clips = this.clips.filter(item => item.id !== id)
    if (clip) await unlink(resolve(recordingsRoot(), clip.relativePath)).catch(() => {})
    await this.saveIndex()
    return this.query()
  }

  private async loadSettings() {
    try {
      const raw = await readFile(settingsPath(), 'utf-8')
      const parsed = JSON.parse(raw)
      const tailMs = normalizeTailMs(parsed?.tailMs)
      this.settings = {
        enabled: parsed?.enabled === true,
        tailMs,
        minDurationMs: Math.max(0, Number(parsed?.minDurationMs) || DEFAULT_SETTINGS.minDurationMs),
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err
      this.settings = { ...DEFAULT_SETTINGS }
    }
  }

  private async saveSettings() {
    await mkdir(dirname(settingsPath()), { recursive: true })
    await writeFile(settingsPath(), `${JSON.stringify(this.settings, null, 2)}\n`, 'utf-8')
  }

  private async loadIndex() {
    try {
      const raw = await readFile(indexPath(), 'utf-8')
      const parsed = JSON.parse(raw) as RecordingsConfig
      this.clips = Array.isArray(parsed?.clips)
        ? parsed.clips.map(normalizeClip).filter((clip): clip is RecordingClip => clip !== null)
        : []
      await this.recoverInterruptedClips()
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err
      this.clips = []
    }
  }

  private saveIndex() {
    this.indexSaveQueue = this.indexSaveQueue
      .catch(() => {})
      .then(() => this.writeIndex())
    return this.indexSaveQueue
  }

  private async writeIndex() {
    await mkdir(dirname(indexPath()), { recursive: true })
    const tmpPath = `${indexPath()}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
    await writeFile(tmpPath, `${JSON.stringify({ clips: this.clips }, null, 2)}\n`, 'utf-8')
    try {
      await rename(tmpPath, indexPath())
    } finally {
      await unlink(tmpPath).catch(() => {})
    }
  }

  private async recoverInterruptedClips() {
    let changed = false
    const recovered: RecordingClip[] = []
    for (const clip of this.clips) {
      if (clip.endedAt !== null) {
        recovered.push(clip)
        continue
      }

      const path = resolve(recordingsRoot(), clip.relativePath)
      const fileStat = await stat(path).catch(() => null)
      if (!fileStat?.size) {
        changed = true
        continue
      }

      const endedAt = Math.max(clip.startedAt, Math.round(fileStat.mtimeMs))
      clip.endedAt = endedAt
      clip.durationMs = Math.max(0, endedAt - clip.startedAt)
      clip.bytes = fileStat.size
      clip.error = clip.error ?? 'Recovered after recorder restart'
      recovered.push(clip)
      changed = true
    }

    if (changed) {
      this.clips = recovered
      await this.saveIndex()
    }
  }

  private startFollower() {
    if (this.squelchFollower) return
    this.stopped = false
    this.squelchFollower = createReceiveSquelchFollower({
      serialServerUrl: this.serialServerUrl,
      onUpdate: (squelch, status) => {
        this.recordingSquelchState = squelch
        if (!status) return
        this.latestStatus = status
        this.enqueueStatus(status, squelch)
      },
    })
  }

  private stopFollower() {
    this.stopped = true
    this.squelchFollower?.stop()
    this.squelchFollower = null
    for (const key of Array.from(this.active.keys())) this.stopActive(key)
    this.captureStop?.()
    this.captureStop = null
    this.captureAudioKey = null
    this.txMicStop?.()
    this.txMicStop = null
    this.recordingSquelchState = defaultReceiveSquelchState()
    this.recordingSquelchGains = new Array(this.captureChannelCount).fill(1)
  }

  private enqueueStatus(status: any, squelch: ReceiveSquelchState) {
    this.statusQueue = this.statusQueue
      .catch(() => {})
      .then(() => this.handleStatus(status, squelch))
      .catch((err: any) => {
        this.lastError = err?.message ?? 'Recording state update failed'
      })
  }

  private async handleStatus(status: any, squelch: ReceiveSquelchState = squelchOpenForStatus(status)) {
    if (this.stopped || !this.settings.enabled) {
      this.stopAllActive()
      return
    }

    if (!status?.connected) {
      this.deferStopClip('main')
      this.deferStopClip('sub')
      this.deferStopClip('tx')
      return
    }

    this.resetCaptureIfAudioChanged(status)

    if (status?.txState || status?.mox) {
      this.deferStopClip('main')
      this.deferStopClip('sub')
      await this.handleTx(status, squelch)
      return
    }

    this.deferStopClip('tx')

    // AnyTone HFP audio is mono, so channel routing cannot identify the active
    // receiver. Trigger clips from the decoded 5a per-side squelch bits instead.
    await this.handleSide('main', squelch.mainOpen, status, squelch.mainMeter, squelch.mainSquelch)
    await this.handleSide('sub', squelch.subOpen, status, squelch.subMeter, squelch.subSquelch)
  }

  private async handleSide(side: 'main' | 'sub', open: boolean, status: any, meter: number | null, squelch: number | null) {
    const active = this.active.get(side)
    if (active?.clip.kind === 'rx' && recordingSideChanged(active.clip, status)) {
      this.stopActive(side)
      return
    }
    if (open) {
      if (active?.closeTimer) {
        clearTimeout(active.closeTimer)
        active.closeTimer = null
        active.stopRequestedAt = null
      }
      if (!active && this.ensureCaptureSubscription()) await this.startClip(side, status, meter, squelch)
    } else {
      this.deferStopClip(side)
    }
  }

  private async handleTx(status: any, squelch: ReceiveSquelchState) {
    const side = status?.txVfo === 1 ? 'sub' : 'main'
    const active = this.active.get('tx')
    if (active?.clip.kind === 'tx' && (active.clip.side !== side || recordingSideChanged(active.clip, status))) {
      this.stopActive('tx')
      return
    }
    if (active?.closeTimer) {
      clearTimeout(active.closeTimer)
      active.closeTimer = null
      active.stopRequestedAt = null
    }

    if (!active) {
      // TX audio comes from the browser mic via WebRTC, not the radio capture:
      // the AnyTone mutes its HFP source while transmitting.
      this.ensureTxMicSubscription()
      const meter = side === 'main' ? squelch.mainMeter : squelch.subMeter
      const sql = side === 'main' ? squelch.mainSquelch : squelch.subSquelch
      await this.startClip(side, status, meter, sql, 'tx', 'tx', WEBRTC_TX_MIC_SAMPLE_RATE)
    }
  }

  private ensureTxMicSubscription() {
    if (this.txMicStop) return
    this.txMicStop = subscribeWebRtcTxMicAudio(frame => {
      const active = this.active.get('tx')
      if (!active || active.finished || !active.process.stdin?.writable) return
      active.process.stdin.write(frame)
      active.audioBytesWritten += frame.length
    })
  }

  private deferStopClip(key: ActiveRecordingKey) {
    const active = this.active.get(key)
    if (!active || active.closeTimer) return
    active.stopRequestedAt = Date.now()
    active.closeTimer = setTimeout(() => this.stopClip(key), this.settings.tailMs)
  }

  private resetCaptureIfAudioChanged(status: any) {
    if (!this.captureStop || !this.captureAudioKey) return
    const nextKey = audioConfigKey(getAudioConfig(status?.audio ?? null))
    if (nextKey === this.captureAudioKey) return
    this.captureStop()
    this.captureStop = null
    this.captureAudioKey = null
    this.recordingSquelchGains = new Array(this.captureChannelCount).fill(1)
  }

  private ensureCaptureSubscription() {
    if (this.captureStop) return true

    const config = getAudioConfig(this.latestStatus?.audio ?? null)
    if (!config.enabled) {
      this.lastError = 'Audio streaming is disabled. Set CAT_AUDIO_ENABLED=1 on the radio host.'
      return false
    }

    this.captureSampleRate = normalizeAudioInt(config.sampleRate, RX_AUDIO_SAMPLE_RATE, 8000, 96000)
    this.captureChannelCount = normalizeAudioInt(config.channels, RX_AUDIO_CHANNEL_COUNT, 1, 8)
    this.recordingSquelchEnabled = config.squelchGate
    this.recordingSquelchGains = new Array(this.captureChannelCount).fill(1)
    this.recordingSquelchStep = 1 / Math.max(1, Math.round(this.captureSampleRate * (config.squelchRampMs / 1000)))
    this.captureAudioKey = audioConfigKey(config)
    try {
      this.captureStop = subscribeRxAudioCapture(
        { sampleRate: this.captureSampleRate, channels: this.captureChannelCount, config },
        {
          onFrame: frame => this.writeAudioFrame(frame),
          onError: message => {
            this.lastError = message
          },
          onClose: message => {
            this.captureStop = null
            this.captureAudioKey = null
            this.lastError = message
            this.stopClip('main')
            this.stopClip('sub')
            this.stopClip('tx')
          },
        },
      )
      return true
    } catch (err: any) {
      this.captureAudioKey = null
      this.lastError = err?.message ?? 'Cannot start recording audio capture'
      return false
    }
  }

  private writeAudioFrame(frame: RxAudioFrame) {
    if (this.active.size === 0) return

    const input = Buffer.from(frame.data)
    let squelchedInput: Buffer | null = null

    for (const active of this.active.values()) {
      if (active.finished || !active.process.stdin?.writable) continue
      // TX clips are fed from the browser mic stream (ensureTxMicSubscription);
      // the radio capture is muted during TX and would only write silence.
      if (active.clip.kind === 'tx') continue

      const source = squelchedInput ??= this.squelchedAudioFrame(input, frame.channelCount)
      const channel = receiveAudioChannelIndex(
        active.clip.side === 'main'
          ? process.env.CAT_AUDIO_MAIN_CHANNEL || 'left'
          : process.env.CAT_AUDIO_SUB_CHANNEL || 'right',
        frame.channelCount,
      )
      const mono = selectMonoChannel(source, frame.channelCount, channel)
      active.process.stdin.write(mono)
      active.audioBytesWritten += mono.length
    }
  }

  private squelchedAudioFrame(input: Buffer, channelCount: number) {
    if (!this.recordingSquelchEnabled) return input
    if (channelCount <= 1) return input
    const output = Buffer.from(input)
    applyReceiveSquelchGate(output, this.recordingSquelchState, channelCount, this.recordingSquelchGains, this.recordingSquelchStep)
    return output
  }

  private async startClip(
    side: 'main' | 'sub',
    status: any,
    meter: number | null,
    squelch: number | null,
    kind: 'rx' | 'tx' = 'rx',
    key: ActiveRecordingKey = side,
    sampleRate = this.captureSampleRate,
  ) {
    const config = getAudioConfig(this.latestStatus?.audio ?? null)
    if (!config.enabled) return

    const startedAt = Date.now()
    const id = `${startedAt}-${kind}-${side}-${randomUUID().slice(0, 8)}`
    const relativePath = join(dayPath(startedAt), `${id}.mp3`)
    const outputPath = resolve(recordingsRoot(), relativePath)
    await mkdir(dirname(outputPath), { recursive: true })

    const clip = await this.buildClip(id, kind, side, startedAt, relativePath, status, meter, squelch)
    const processConfig = buildAudioRecordingEncoderProcess(config, { outputPath, sampleRate: String(sampleRate) })
    const child = spawn(processConfig.command, processConfig.args, { stdio: ['pipe', 'ignore', 'pipe'] })
    const active: ActiveRecording = { key, clip, process: child, closeTimer: null, killTimer: null, forceFinishTimer: null, stopRequestedAt: null, finished: false, sampleRate, audioBytesWritten: 0 }
    this.active.set(key, active)
    this.clips.push(clip)
    await this.saveIndex()

    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
      if (process.env.CAT_AUDIO_DEBUG === '1') process.stderr.write(chunk)
    })
    child.on('error', err => {
      clip.error = err.message
      this.lastError = err.message
      void this.finishClip(active)
    })
    child.on('close', code => {
      if (code !== 0 && !active.stopRequestedAt && !clip.error) clip.error = stderr.trim() || `ffmpeg exited with code ${code}`
      void this.finishClip(active)
    })
  }

  private async buildClip(
    id: string,
    kind: 'rx' | 'tx',
    side: 'main' | 'sub',
    startedAt: number,
    relativePath: string,
    status: any,
    meter: number | null,
    squelch: number | null,
  ): Promise<RecordingClip> {
    const prefix = side === 'main' ? 'main' : 'sub'
    const freq = status?.[`${prefix}Freq`] ?? null
    const mode = status?.[`${prefix}Mode`] ?? null
    const vfoMode = status?.[`${prefix}VfoMode`] ?? null
    const memoryChannel = status?.[`${prefix}MemoryChannel`] ?? null
    const memoryTag = status?.[`${prefix}MemoryTag`] ?? null
    const mhz = typeof freq === 'number' ? (freq / 1_000_000).toFixed(3) : null
    const laneKey = memoryChannel ? `mem:${memoryChannel}` : `${side}:${freq ?? 'unknown'}:${mode ?? 'unknown'}`
    const laneLabel = memoryChannel
      ? [`MEM ${memoryChannel}`, memoryTag].filter(Boolean).join(' ')
      : [side.toUpperCase(), mhz, mode].filter(Boolean).join(' ')
    const scanGroupNames = await this.scanGroupNamesForChannel(memoryChannel, status)

    return {
      id,
      kind,
      side,
      startedAt,
      endedAt: null,
      durationMs: null,
      fileName: `${id}.mp3`,
      relativePath,
      contentType: 'audio/mpeg',
      bytes: null,
      laneKey,
      laneLabel,
      freq,
      mode,
      vfoMode,
      memoryChannel,
      memoryTag,
      scanGroupNames,
      rxMode: status?.rxMode ?? null,
      txVfo: status?.txVfo === 1 ? 1 : status?.txVfo === 0 ? 0 : null,
      meter,
      squelch,
      error: null,
    }
  }

  private async scanGroupNamesForChannel(channel: string | null, status: any) {
    if (!channel) return []
    const pseudoScanChannels = Array.isArray(status?.pseudoScanChannels) ? status.pseudoScanChannels : []
    if (status?.pseudoScanActive && pseudoScanChannels.length > 0 && !pseudoScanChannels.includes(channel)) return []
    try {
      const { groups } = await readScanGroups()
      return groups.filter(group => group.channels.includes(channel)).map(group => group.name)
    } catch {
      return []
    }
  }

  private stopClip(key: ActiveRecordingKey) {
    return this.stopActive(key)
  }

  private stopAllActive() {
    for (const key of Array.from(this.active.keys())) this.stopActive(key)
  }

  private stopActive(key: ActiveRecordingKey) {
    const active = this.active.get(key)
    if (!active || active.finished) return
    if (active.closeTimer) clearTimeout(active.closeTimer)
    active.closeTimer = null
    active.stopRequestedAt = active.stopRequestedAt ?? Date.now()
    try { active.process.stdin?.end() } catch {}
    active.killTimer ??= setTimeout(() => {
      if (!active.finished) try { active.process.kill('SIGTERM') } catch {}
    }, 1500)
    active.forceFinishTimer ??= setTimeout(() => {
      if (active.finished) return
      try { active.process.kill('SIGKILL') } catch {}
      active.clip.error = active.clip.error ?? 'Recorder process did not exit cleanly'
      void this.finishClip(active)
    }, 5000)
    return true
  }

  private async finishClip(active: ActiveRecording) {
    if (active.finished) return
    active.finished = true
    if (active.closeTimer) clearTimeout(active.closeTimer)
    if (active.killTimer) clearTimeout(active.killTimer)
    if (active.forceFinishTimer) clearTimeout(active.forceFinishTimer)
    active.closeTimer = null
    active.killTimer = null
    active.forceFinishTimer = null
    if (this.active.get(active.key)?.clip.id === active.clip.id) this.active.delete(active.key)
    const endedAt = active.stopRequestedAt ?? Date.now()
    active.clip.endedAt = endedAt
    active.clip.durationMs = Math.max(0, endedAt - active.clip.startedAt)
    const path = resolve(recordingsRoot(), active.clip.relativePath)
    const fileStat = await stat(path).catch(() => null)
    active.clip.bytes = fileStat?.size ?? null
    // durationMs above is wall-clock (squelch-open span). If the audio capture
    // stalled while the squelch bit stayed open, ffmpeg still emits a tiny
    // header-only mp3 (bytes > 0) that plays as 0 seconds. Require that we
    // actually wrote enough PCM to cover at least half the minimum duration,
    // so empty/near-empty clips are dropped instead of cluttering the timeline.
    const minAudioBytes = Math.floor((this.settings.minDurationMs / 1000) * active.sampleRate * BYTES_PER_SAMPLE * 0.5)
    const hasAudio = active.audioBytesWritten >= Math.max(1, minAudioBytes)
    if ((active.clip.durationMs ?? 0) < this.settings.minDurationMs || !active.clip.bytes || !hasAudio) {
      this.clips = this.clips.filter(clip => clip.id !== active.clip.id)
      await unlink(path).catch(() => {})
    }
    await this.saveIndex()
  }
}

function selectMonoChannel(input: Buffer, inputChannels: number, channel: number) {
  if (inputChannels <= 1) return Buffer.from(input)

  const frames = Math.floor(input.length / (inputChannels * 2))
  const output = Buffer.alloc(frames * 2)
  for (let frame = 0; frame < frames; frame += 1) {
    output.writeInt16LE(input.readInt16LE((frame * inputChannels + channel) * 2), frame * 2)
  }
  return output
}

function audioConfigKey(config: ReturnType<typeof getAudioConfig>) {
  return `${config.transport}/${config.engine}/${config.backend}/${config.input}/${config.channels}/${config.sampleRate}`
}

function normalizeAudioInt(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

function recordingSideChanged(clip: RecordingClip, status: any) {
  const prefix = clip.side === 'main' ? 'main' : 'sub'
  const currentFreq = nullableNumber(status?.[`${prefix}Freq`])
  const currentMode = nullableString(status?.[`${prefix}Mode`])
  const currentVfoMode = nullableString(status?.[`${prefix}VfoMode`])
  const currentMemoryChannel = nullableString(status?.[`${prefix}MemoryChannel`])

  return differsWhenKnown(clip.freq, currentFreq)
    || differsWhenKnown(clip.mode, currentMode)
    || differsWhenKnown(clip.vfoMode, currentVfoMode)
    || differsWhenKnown(clip.memoryChannel, currentMemoryChannel)
}

function differsWhenKnown(a: string | number | null, b: string | number | null) {
  return a !== null && b !== null && String(a) !== String(b)
}

function nullableString(value: unknown) {
  return value === null || value === undefined || value === '' ? null : String(value)
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

declare global {
  // eslint-disable-next-line no-var
  var __anytoneRecordingsManager: RecordingsManager | undefined
}

export async function getRecordingsManager(serialServerUrl: string) {
  if (!globalThis.__anytoneRecordingsManager) {
    globalThis.__anytoneRecordingsManager = new RecordingsManager(serialServerUrl)
  }
  await globalThis.__anytoneRecordingsManager.init()
  return globalThis.__anytoneRecordingsManager
}
