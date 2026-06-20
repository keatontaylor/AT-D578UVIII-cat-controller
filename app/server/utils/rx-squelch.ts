export interface ReceiveSquelchState {
  open: boolean
  digital: boolean
  modes: string[]
  mainOpen: boolean
  subOpen: boolean
  mainDigital: boolean
  subDigital: boolean
  mainMeter: number | null
  subMeter: number | null
  mainSquelch: number | null
  subSquelch: number | null
  rxMode: 'single' | 'dual'
  txVfo: 0 | 1 | null
  updatedAt: number | null
  error: string | null
}

interface ReceiveSquelchFollowerOptions {
  serialServerUrl: string
  onUpdate: (state: ReceiveSquelchState, status: any) => void
}

const DEFAULT_DIGITAL_MODES = new Set(['C4FM-DN', 'C4FM-VW'])

export function isDigitalAudioMode(mode: string | null | undefined) {
  if (!mode) return false
  const configured = process.env.CAT_AUDIO_DIGITAL_MODES
  const modes = configured
    ? new Set(configured.split(',').map(value => value.trim()).filter(Boolean))
    : DEFAULT_DIGITAL_MODES
  return modes.has(mode)
}

export function receiveModesFromStatus(status: any): string[] {
  if (status?.rxMode === 'single') {
    const mode = status?.txVfo === 1 ? status?.subMode : status?.mainMode
    return mode ? [mode] : []
  }

  return [status?.mainMode, status?.subMode].filter(Boolean)
}

export function squelchOpenForStatus(status: any): ReceiveSquelchState {
  const modes = receiveModesFromStatus(status)
  const mainDigital = isDigitalAudioMode(status?.mainMode)
  const subDigital = isDigitalAudioMode(status?.subMode)
  const busyOpen = status?.radioInfo?.squelchOpen !== false
  const rxMode = status?.rxMode === 'single' ? 'single' : 'dual'
  const txVfo = status?.txVfo === 1 ? 1 : status?.txVfo === 0 ? 0 : null
  const mainMeter = statusNumber(status?.mainSmeter)
  const subMeter = statusNumber(status?.subSmeter)
  const mainSquelch = statusNumber(status?.sqMain)
  const subSquelch = statusNumber(status?.sqSub)
  const mainOpen = squelchOpenFromMeter(mainMeter, mainSquelch, busyOpen)
  const subOpen = squelchOpenFromMeter(subMeter, subSquelch, busyOpen)

  const digital = modes.some(isDigitalAudioMode)
  const open = mainOpen || subOpen

  return {
    open,
    digital,
    modes,
    mainOpen,
    subOpen,
    mainDigital,
    subDigital,
    mainMeter,
    subMeter,
    mainSquelch,
    subSquelch,
    rxMode,
    txVfo,
    updatedAt: Date.now(),
    error: null,
  }
}

export function defaultReceiveSquelchState(): ReceiveSquelchState {
  return {
    open: true,
    digital: false,
    modes: [],
    mainOpen: true,
    subOpen: true,
    mainDigital: false,
    subDigital: false,
    mainMeter: null,
    subMeter: null,
    mainSquelch: null,
    subSquelch: null,
    rxMode: 'dual',
    txVfo: null,
    updatedAt: null,
    error: null,
  }
}

export function receiveSquelchTargets(state: ReceiveSquelchState, channelCount: number) {
  // AnyTone HFP audio is mono: whichever receiver opens is mixed into the same
  // channel, so gating by selected TX/RX side would mute valid dual-watch audio.
  if (channelCount <= 1) return [state.open ? 1 : 0]

  const targets = new Array(channelCount).fill(state.open ? 1 : 0)
  const mainChannel = receiveAudioChannelIndex(process.env.CAT_AUDIO_MAIN_CHANNEL || 'left', channelCount)
  const subChannel = receiveAudioChannelIndex(process.env.CAT_AUDIO_SUB_CHANNEL || 'right', channelCount)
  targets[mainChannel] = state.mainOpen ? 1 : 0
  targets[subChannel] = state.subOpen ? 1 : 0
  return targets
}

export function applyReceiveSquelchGate(frame: Buffer, state: ReceiveSquelchState, channelCount: number, gains: number[], step: number) {
  const frameBytes = channelCount * 2
  if (gains.length !== channelCount) gains.splice(0, gains.length, ...new Array(channelCount).fill(1))
  const targets = receiveSquelchTargets(state, channelCount)

  for (let offset = 0; offset < frame.length; offset += frameBytes) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const target = targets[channel] ?? targets[0] ?? 1
      if (gains[channel] < target) gains[channel] = Math.min(target, gains[channel] + step)
      else if (gains[channel] > target) gains[channel] = Math.max(target, gains[channel] - step)

      if (gains[channel] < 0.999) {
        const sampleOffset = offset + channel * 2
        const sample = frame.readInt16LE(sampleOffset)
        frame.writeInt16LE(Math.round(sample * gains[channel]), sampleOffset)
      }
    }
  }
}

export function activeReceiveAudioChannel(state: ReceiveSquelchState, channelCount: number) {
  if (channelCount <= 1) return 0
  const channel = state.txVfo === 1
    ? process.env.CAT_AUDIO_SUB_CHANNEL || 'right'
    : process.env.CAT_AUDIO_MAIN_CHANNEL || 'left'
  return receiveAudioChannelIndex(channel, channelCount)
}

export function activeReceiveOpen(state: ReceiveSquelchState) {
  return state.txVfo === 1 ? state.subOpen : state.mainOpen
}

export function receiveAudioChannelIndex(value: string, channelCount: number) {
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'left' || normalized === 'main-left' || normalized === 'sub-left') return 0
  if (normalized === 'right' || normalized === 'main-right' || normalized === 'sub-right') return Math.min(1, channelCount - 1)
  const numeric = Number.parseInt(normalized, 10)
  if (Number.isFinite(numeric)) return Math.max(0, Math.min(channelCount - 1, numeric))
  return 0
}

function squelchOpenFromMeter(meter: number | null, squelch: number | null, fallbackOpen: boolean) {
  if (meter === null) return fallbackOpen
  // AnyTone meters are derived from the 5a per-side squelch: 0 when closed,
  // positive when open. So when the squelch threshold is unknown (e.g. the
  // settings block couldn't be read), meter>0 is the authoritative open test —
  // never fall back to "always open" or recordings run nonstop.
  if (squelch === null) return meter > 0
  return meter >= squelch
}

function statusNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function createReceiveSquelchFollower(options: ReceiveSquelchFollowerOptions) {
  let stopped = false
  let controller: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let state: ReceiveSquelchState = defaultReceiveSquelchState()

  const connect = async () => {
    if (stopped) return
    let fullState: any = null
    try {
      controller = new AbortController()
      const response = await fetch(`${options.serialServerUrl}/events`, {
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status}`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!stopped) {
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
              state = squelchOpenForStatus(fullState)
              options.onUpdate(state, fullState)
            } catch { /* skip malformed SSE data */ }
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return
      state = {
        ...state,
        open: true,
        mainOpen: true,
        subOpen: true,
        updatedAt: Date.now(),
        error: err.message ?? 'SSE connection error',
      }
      options.onUpdate(state, fullState)
    }

    if (!stopped) reconnectTimer = setTimeout(connect, 3000)
  }

  void connect()

  return {
    getState: () => state,
    stop: () => {
      stopped = true
      if (controller) controller.abort()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
    },
  }
}
