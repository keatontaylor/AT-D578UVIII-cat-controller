// The one client-side data layer: a single /ws JSON-RPC connection that maintains the
// authoritative AppState (snapshot on connect, then RFC 7396 patches) and exposes typed commands.
// Components render off `state`; there is no second copy of truth. No REST/SSE.

import { ref } from 'vue'
import { APP_STATE_RENULL_SKIP_PATHS, applyStatePatch, renullAfterPatch } from '../../src/api/merge-patch'
import type { AppState, LinkReport } from '../../src/services/radio-service'

export type { LinkReport }
import type { RadioCandidate } from '../../src/bluetooth/radio-select'
import type { AdapterInfo } from '../../src/bluetooth/types'

const state = ref<AppState | null>(null)
const online = ref(false)
// ── Reconnect grace: a dropped socket keeps the last-known UI rendered (dimmed, inert) for this
// long before the full "reconnecting" placeholder takes over. Transient drops — a phone tab
// resuming, a WiFi blip, an nginx reload — reconnect on the 1 s retry loop and never tear down
// the layout. Purely cosmetic buffering: interactions are locked out and the reconnect snapshot
// replaces state wholesale, so nothing stale can be acted on or survive the reopen.
const RECONNECT_GRACE_MS = 5000
const graceExpired = ref(false)
let graceTimer: ReturnType<typeof setTimeout> | null = null

// ── Squelch recordings: a live list kept current by server pushes (recordings.saved / .removed /
// .status), hydrated once from recordings.list on open. No polling, no manual refresh. ──
export interface RecordingClip {
  id: string
  startedAt: number
  durationMs: number
  side: string | null
  channelName: string | null
  freqMHz: number | null
  mode: string | null
  talkgroup: number | null
  /** 'rx' = radio squelch audio; 'tx' = the operator's own transmission (mic tap). */
  direction?: 'rx' | 'tx'
}
/** A recording IN PROGRESS (recordings.opened) — drawn growing toward "now" until it resolves
 * into saved (→ recordings list) or discarded (a blip). */
export type LiveRecording = Omit<RecordingClip, 'durationMs'>
const recordings = ref<RecordingClip[]>([])
const liveRecordings = ref<LiveRecording[]>([])
const recorderStatus = ref<{ enabled: boolean; tailMs: number; minDurationMs: number }>({
  enabled: false,
  tailMs: 0,
  minDurationMs: 0,
})

// Shared discovery/pairing state — one list for the header dropdown AND the pairing panel.
// Transient UI (not radio truth): who's around to connect to, not the radio's own state.
const radios = ref<RadioCandidate[]>([])
const adapter = ref<AdapterInfo | null>(null)
const scanning = ref(false)

let socket: WebSocket | null = null
let nextId = 1
let hasOpened = false
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
const outbox: string[] = []
const MUTATING_METHODS = new Set([
  'bt.scan', 'bt.pair', 'bt.forget', 'connect', 'disconnect', 'setting.set', 'ptt.key', 'ptt.unkey',
  'ptt.hold', 'side.select', 'vfo.setMode', 'channel.step', 'zone.step', 'channel.setting', 'channel.tone',
  'channel.frequency', 'channel.volume', 'scan.start', 'scan.stop', 'channel.select', 'channel.selectIn', 'dmr.dial',
  'recordings.setEnabled', 'recordings.delete', 'rtc.offer', 'rtc.ice', 'rtc.stop', 'rtc.mic', 'rtc.setGain',
  'packet.setEnabled',
])

// ── Packet TNC (direwolf bridge): status pushed on every change, hydrated per (re)connect. ──
export interface PacketStatus {
  enabled: boolean
  running: boolean
  ptt: boolean
  decodes: number
  lastHeard: string | null
  audioLevel: number | null
  kissPort: number
  agwPort: number
  error: string | null
}
const packetStatus = ref<PacketStatus | null>(null)

// ── PTT hold beacon (the deadman's heartbeat) ────────────────────────────────
// While the PTT button is physically held, prove once a second that this page's JS is still
// alive and holding. If the beacons stop — connection lost, tab frozen/suspended, JS crashed —
// the server force-releases after its deadman window (~4 s). Fire-and-forget notifications:
// they pipeline regardless of RTT, so high-latency links are fine; only a real outage trips it.
const HOLD_BEACON_MS = 1000
let holdTimer: ReturnType<typeof setInterval> | null = null
function startHoldBeacon(): void {
  stopHoldBeacon()
  holdTimer = setInterval(() => notify('ptt.hold', {}), HOLD_BEACON_MS)
}
function stopHoldBeacon(): void {
  if (holdTimer) {
    clearInterval(holdTimer)
    holdTimer = null
  }
}

interface RpcMessage {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: string }
}

function parseMessage(data: string): RpcMessage | null {
  try {
    const parsed = JSON.parse(data) as unknown
    return parsed && typeof parsed === 'object' ? parsed as RpcMessage : null
  } catch {
    return null
  }
}

function send(frame: string): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(frame)
  else outbox.push(frame)
}

function ensureSocket(): void {
  if (socket) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // BASE_URL is Vite's mount prefix (e.g. '/anytone-v2/'), so the socket lands on the app's own
  // /ws under the reverse proxy, not the domain root.
  const ws = new WebSocket(`${proto}://${location.host}${import.meta.env.BASE_URL}ws`)
  socket = ws
  ws.onopen = () => {
    online.value = true
    hasOpened = true
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
    graceExpired.value = false
    for (const frame of outbox.splice(0)) ws.send(frame)
    // A (re)connect mid-recording missed the `opened` push — re-hydrate the live + saved lists
    // (only once the panel has hydrated at least once; before that, mount does it).
    if (recHydrated) void hydrateRecordings().catch(() => {})
    // Packet TNC state is server-side truth (it survives page reloads) — hydrate every (re)open.
    void rpc<PacketStatus>('packet.status').then((s) => (packetStatus.value = s)).catch(() => {})
  }
  ws.onclose = () => {
    online.value = false
    socket = null
    // Grace only when there's a last-known UI to keep showing (never on first load), and the
    // timer never re-arms while an expired grace is still standing.
    if (state.value !== null && !graceExpired.value && !graceTimer) {
      graceTimer = setTimeout(() => {
        graceTimer = null
        graceExpired.value = true
      }, RECONNECT_GRACE_MS)
    }
    stopHoldBeacon() // the server's deadman releases PTT; beaconing a dead socket helps no one
    liveRecordings.value = [] // pushed state we can no longer trust; re-hydrated on reconnect
    // In-flight requests can never get a response now — reject them so callers surface the loss
    // instead of hanging (a stuck connect spinner after a server restart). Queued-but-unsent
    // frames are dropped too: replaying commands against a restarted server is not what the
    // user asked for.
    const dropped = [...pending.values()]
    pending.clear()
    outbox.length = 0
    for (const p of dropped) p.reject(new Error('connection lost'))
    setTimeout(ensureSocket, 1000)
  }
  ws.onmessage = (ev: MessageEvent<string>) => {
    const m = parseMessage(ev.data)
    if (!m) return
    if (m.method === 'state.snapshot') state.value = m.params as AppState
    else if (m.method === 'state.patch') {
      if (!state.value) return
      // RFC 7396 encodes value→null as a deletion; restore those fixed fields as literal nulls so
      // the state keeps matching the AppState type. The record maps (settings + per-side channel
      // values/overlays) are genuine key deletions and must NOT be re-nulled — the canonical skip
      // list is shared with the integration mirror client (APP_STATE_RENULL_SKIP_PATHS).
      const patched = applyStatePatch(state.value, m.params)
      state.value = renullAfterPatch(state.value, patched, APP_STATE_RENULL_SKIP_PATHS) as AppState
    }
    else if (m.method === 'recordings.opened') {
      const clip = (m.params as { clip: LiveRecording }).clip
      liveRecordings.value = [clip, ...liveRecordings.value.filter((c) => c.id !== clip.id)]
    }
    else if (m.method === 'recordings.saved') {
      const clip = (m.params as { clip: RecordingClip }).clip
      liveRecordings.value = liveRecordings.value.filter((c) => c.id !== clip.id)
      recordings.value = [clip, ...recordings.value.filter((c) => c.id !== clip.id)].sort((a, b) => b.startedAt - a.startedAt)
    }
    else if (m.method === 'recordings.discarded') {
      const id = (m.params as { id: string }).id
      liveRecordings.value = liveRecordings.value.filter((c) => c.id !== id)
    }
    else if (m.method === 'recordings.removed') {
      const id = (m.params as { id: string }).id
      recordings.value = recordings.value.filter((c) => c.id !== id)
    }
    else if (m.method === 'recordings.status') {
      recorderStatus.value = (m.params as { status: typeof recorderStatus.value }).status
    }
    else if (m.method === 'packet.status') packetStatus.value = m.params as PacketStatus
    else if (m.method === 'rtc.ice' && audioPc) void audioPc.addIceCandidate(m.params as RTCIceCandidateInit).catch(() => {})
    else if (m.id != null && pending.has(m.id)) {
      const p = pending.get(m.id)!
      pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message ?? 'request failed'))
      else p.resolve(m.result)
    }
  }
}

function rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  ensureSocket()
  if (MUTATING_METHODS.has(method) && hasOpened && (!socket || socket.readyState !== WebSocket.OPEN)) {
    return Promise.reject(new Error('connection offline'))
  }
  return new Promise<T>((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

/** Fire-and-forget (no response expected) — for trickle-ICE candidates. */
function notify(method: string, params: unknown): void {
  ensureSocket()
  if (MUTATING_METHODS.has(method) && hasOpened && (!socket || socket.readyState !== WebSocket.OPEN)) return
  send(JSON.stringify({ jsonrpc: '2.0', method, params }))
}

// ── WebRTC audio: browser offers a SENDRECV peer — RX is the server's radio track, and the send
// side is reserved for the mic so it can be enabled LATER via replaceTrack (no renegotiation). The
// mic is armed independently (enableMic); audio only reaches the radio while keyed (server gates on
// rtc.mic, paired with ptt.key/unkey). ──
let audioPc: RTCPeerConnection | null = null
let micTrack: MediaStreamTrack | null = null
let micSender: RTCRtpSender | null = null

async function startAudio(el: HTMLAudioElement): Promise<void> {
  await stopAudio()
  // The server owns the ICE config (ANYTONE_ICE_SERVERS) — STUN/TURN is what lets a remote
  // (cellular/NATed) client connect; on failure fall back to LAN-only host candidates.
  const { iceServers, iceTransportPolicy } = await rpc<{ iceServers: RTCIceServer[]; iceTransportPolicy?: RTCIceTransportPolicy }>(
    'rtc.config',
  ).catch(() => ({ iceServers: [] as RTCIceServer[], iceTransportPolicy: undefined }))
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: iceTransportPolicy ?? 'all' })
  audioPc = pc
  micTrack = null
  // A sendrecv transceiver: RX plays through its receiver (ontrack); the sender stays empty until
  // enableMic() attaches the mic via replaceTrack — so no getUserMedia prompt just to listen.
  micSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender
  try {
    const playable = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('audio track did not arrive')), 5000)
      const fail = (message: string): void => {
        window.clearTimeout(timer)
        reject(new Error(message))
      }
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
          fail(`audio peer ${pc.connectionState}`)
        }
      }
      pc.ontrack = (e) => {
        if (audioPc !== pc) return
        el.srcObject = e.streams[0] ?? new MediaStream([e.track])
        void el.play()
          .then(() => {
            window.clearTimeout(timer)
            resolve()
          })
          .catch((err: unknown) => {
            window.clearTimeout(timer)
            reject(err instanceof Error ? err : new Error(String(err)))
          })
      }
    })
    pc.onicecandidate = (e) => {
      if (e.candidate) notify('rtc.ice', e.candidate.toJSON())
    }
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const answer = await rpc<RTCSessionDescriptionInit>('rtc.offer', { type: offer.type, sdp: offer.sdp })
    if (audioPc === pc) await pc.setRemoteDescription(answer)
    await playable
  } catch (e) {
    if (audioPc === pc) {
      audioPc = null
      micSender = null
    }
    pc.close()
    await rpc('rtc.stop').catch(() => {})
    throw e
  }
}

async function stopAudio(): Promise<void> {
  const pc = audioPc
  if (!pc) return
  audioPc = null
  micTrack?.stop()
  micTrack = null
  micSender = null
  pc.close()
  await rpc('rtc.stop').catch(() => {})
}

/** Arm the mic independently of listening: prompt for the browser mic and attach it to the existing
 * sendrecv sender (no renegotiation). Explicit constraints (mono + browser AGC/NS/EC, like the PoC);
 * server-side ANYTONE_AUDIO_TX_GAIN then attenuates for the radio's narrowband input. Throws with a
 * clear reason (insecure origin / denied) so the UI can explain. */
async function enableMic(): Promise<void> {
  if (!audioPc || !micSender) throw new Error('enable audio first')
  if (micTrack) return
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    throw new Error('Microphone needs a secure origin — open the app on the device itself or over HTTPS')
  }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot capture the microphone')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: { ideal: 1, max: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  micTrack = stream.getAudioTracks()[0] ?? null
  if (!micTrack) throw new Error('No microphone track was provided')
  micTrack.enabled = false // silent until keyed
  await micSender.replaceTrack(micTrack)
}

/** Release the mic (detach + stop) while keeping RX audio. */
async function disableMic(): Promise<void> {
  if (!micTrack) return
  micTrack.enabled = false
  notify('rtc.mic', { active: false })
  await micSender?.replaceTrack(null).catch(() => {})
  micTrack.stop()
  micTrack = null
}

/** True when the mic is armed (TX available). */
function hasMic(): boolean {
  return micTrack != null
}

/** Key the radio AND open the mic → radio path (enable the mic track + tell the server to pipe it).
 * Paired: unkeyMic reverses both. Safe to call without a mic (falls back to plain key). */
async function keyMic(): Promise<void> {
  if (micTrack) {
    micTrack.enabled = true
    notify('rtc.mic', { active: true })
  }
  startHoldBeacon() // before the key round-trips, so beacons flow even on a slow link
  try {
    await rpc('ptt.key')
  } catch (e) {
    stopHoldBeacon()
    throw e
  }
}
async function unkeyMic(): Promise<void> {
  stopHoldBeacon()
  await rpc('ptt.unkey')
  if (micTrack) {
    micTrack.enabled = false
    notify('rtc.mic', { active: false })
  }
}

/** A sane WebRTC stats snapshot for the diagnostics popup — the connection/ICE state plus the
 * selected candidate pair, inbound (RX) and outbound (TX) audio counters. Null when no peer. */
export interface RtcStats {
  connectionState: string
  iceConnectionState: string
  collectedAt: number
  pair: {
    rttMs: number | null
    protocol?: string
    bytesSent?: number
    bytesReceived?: number
    /** The browser's winning candidate: type (host/srflx/relay), endpoint, and — when STUN/TURN
     * produced it — the ICE server URL it came from (how you tell WHICH server got used). */
    local: { type?: string; address?: string; port?: number; url?: string; relayProtocol?: string } | null
    /** The server side of the pair as the browser sees it (relay type = the Pi went via TURN). */
    remote: { type?: string; address?: string; port?: number } | null
  } | null
  inbound: { packets?: number; lost?: number; jitterMs: number | null; bytes?: number; codec?: string; concealedSamples?: number; concealmentEvents?: number; jitterBufferMs?: number | null } | null
  outbound: { packets?: number; bytes?: number; codec?: string } | null
  remote: { rttMs: number | null; lost?: number; jitterMs: number | null } | null
}
async function getRtcStats(): Promise<RtcStats | null> {
  const pc = audioPc
  if (!pc) return null
  const items = [...(await pc.getStats()).values()] as Record<string, unknown>[]
  const byId = (id: unknown): Record<string, unknown> | undefined => items.find((i) => i['id'] === id)
  const codecName = (r?: Record<string, unknown>): string | undefined => {
    const c = r && byId(r['codecId'])
    const mime = c?.['mimeType'] as string | undefined
    return mime?.split('/')[1]
  }
  const pair = items.find((i) => i['type'] === 'candidate-pair' && (i['state'] === 'succeeded' || i['nominated']))
  const local = pair && byId(pair['localCandidateId'])
  const remote = pair && byId(pair['remoteCandidateId'])
  const inbound = items.find((i) => i['type'] === 'inbound-rtp' && i['kind'] === 'audio')
  const outbound = items.find((i) => i['type'] === 'outbound-rtp' && i['kind'] === 'audio')
  const remoteIn = items.find((i) => i['type'] === 'remote-inbound-rtp' && i['kind'] === 'audio')
  const ms = (s: unknown): number | null => (typeof s === 'number' ? Math.round(s * 1000 * 10) / 10 : null)
  return {
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    collectedAt: Date.now(),
    pair: pair
      ? {
          rttMs: ms(pair['currentRoundTripTime']),
          protocol: local?.['protocol'] as string | undefined,
          bytesSent: pair['bytesSent'] as number | undefined,
          bytesReceived: pair['bytesReceived'] as number | undefined,
          local: local
            ? {
                type: local['candidateType'] as string | undefined,
                address: (local['address'] ?? local['ip']) as string | undefined,
                port: local['port'] as number | undefined,
                url: local['url'] as string | undefined,
                relayProtocol: local['relayProtocol'] as string | undefined,
              }
            : null,
          remote: remote
            ? {
                type: remote['candidateType'] as string | undefined,
                address: (remote['address'] ?? remote['ip']) as string | undefined,
                port: remote['port'] as number | undefined,
              }
            : null,
        }
      : null,
    inbound: inbound
      ? {
          packets: inbound['packetsReceived'] as number,
          lost: inbound['packetsLost'] as number,
          jitterMs: ms(inbound['jitter']),
          bytes: inbound['bytesReceived'] as number,
          codec: codecName(inbound),
          // concealment = NetEq faking samples on underrun/loss — the direct measure of "pops"
          concealedSamples: inbound['concealedSamples'] as number | undefined,
          concealmentEvents: inbound['concealmentEvents'] as number | undefined,
          jitterBufferMs:
            typeof inbound['jitterBufferDelay'] === 'number' && typeof inbound['jitterBufferEmittedCount'] === 'number' && (inbound['jitterBufferEmittedCount'] as number) > 0
              ? Math.round(((inbound['jitterBufferDelay'] as number) / (inbound['jitterBufferEmittedCount'] as number)) * 1000)
              : null,
        }
      : null,
    outbound: outbound
      ? { packets: outbound['packetsSent'] as number, bytes: outbound['bytesSent'] as number, codec: codecName(outbound) }
      : null,
    remote: remoteIn ? { rttMs: ms(remoteIn['roundTripTime']), lost: remoteIn['packetsLost'] as number, jitterMs: ms(remoteIn['jitter']) } : null,
  }
}

// Recordings hydrate: status + saved list + IN-PROGRESS clips (a client that connects
// mid-recording missed the `opened` push). Called on panel mount and on every ws reconnect.
let recHydrated = false
async function hydrateRecordings(): Promise<void> {
  const [status, list, live] = await Promise.all([
    rpc<{ enabled: boolean; tailMs: number; minDurationMs: number }>('recordings.status'),
    rpc<RecordingClip[]>('recordings.list'),
    rpc<LiveRecording[]>('recordings.live').catch(() => [] as LiveRecording[]),
  ])
  recorderStatus.value = status
  recordings.value = [...list].sort((a, b) => b.startedAt - a.startedAt)
  liveRecordings.value = live
  recHydrated = true
}

// Dedupe concurrent refreshes: the header dropdown and the pairing panel both ask on mount (they
// share this singleton), so without this bt.list/bt.adapter would each fire twice on the idle screen.
let refreshInFlight: Promise<void> | null = null
function refreshRadios(): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const [list, adp] = await Promise.all([
        rpc<RadioCandidate[]>('bt.list'),
        rpc<AdapterInfo>('bt.adapter').catch(() => null),
      ])
      radios.value = list
      if (adp) adapter.value = adp
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}
async function runScan(): Promise<void> {
  if (scanning.value) return
  scanning.value = true
  try {
    radios.value = await rpc<RadioCandidate[]>('bt.scan')
    adapter.value = await rpc<AdapterInfo>('bt.adapter').catch(() => adapter.value)
  } finally {
    scanning.value = false
  }
}

export function useRadio() {
  ensureSocket()
  return {
    state,
    online,
    graceExpired,
    radios,
    adapter,
    scanning,
    refreshRadios,
    scan: runScan,
    pair: async (address: string) => {
      await rpc('bt.pair', { address })
      await refreshRadios()
    },
    forget: async (address: string) => {
      await rpc('bt.forget', { address })
      await refreshRadios()
    },
    connect: (address: string) => rpc<AppState>('connect', { address }),
    disconnect: () => rpc<AppState>('disconnect'),
    linkStats: () => rpc<LinkReport>('link.stats'),
    setSetting: (name: string, value: string | number) => rpc('setting.set', { name, value }),
    catalogue: () =>
      rpc<{ name: string; options: string[] | null; description: string; menu: string }[]>('settings.catalogue'),
    channelCatalogue: () =>
      rpc<{ key: string; label: string; options: string[]; description: string; modes: string | null }[]>(
        'channelSettings.catalogue',
      ),
    setChannelSetting: (side: 'a' | 'b', key: string, value: string | number) =>
      rpc('channel.setting', { side, key, value }),
    setChannelTone: (side: 'a' | 'b', field: 'rx' | 'tx', type: 'off' | 'ctc' | 'dcs', value: number, inverted: boolean) =>
      rpc('channel.tone', { side, field, type, value, inverted }),
    setFrequency: (side: 'a' | 'b', field: 'rx' | 'tx', hz: number) =>
      rpc('channel.frequency', { side, field, hz }),
    setVolume: (side: 'a' | 'b', level: number) => rpc('channel.volume', { side, level }),
    scanLists: (force = false) => rpc<{ index: number; name: string }[]>('scan.lists', { force }),
    startScan: (side: 'a' | 'b', listIndex: number | null, listName: string | null) =>
      rpc('scan.start', { side, listIndex, listName }),
    stopScan: () => rpc('scan.stop'),
    zoneChannels: (side: 'a' | 'b') => rpc<{ position: number; name: string }[]>('zone.channels', { side }),
    selectChannel: (side: 'a' | 'b', position: number) => rpc('channel.select', { side, position }),
    zones: (force = false) => rpc<{ index: number; name: string }[]>('zone.list', { force }),
    zoneChannelsIn: (zoneIndex: number, force = false) =>
      rpc<{ position: number; name: string }[]>('zone.channelsIn', { zoneIndex, force }),
    selectZoneChannel: (side: 'a' | 'b', zoneIndex: number, position: number) =>
      rpc('channel.selectIn', { side, zoneIndex, position }),
    setManualDial: (side: 'a' | 'b', target: number, callType: 'group' | 'private') => rpc('dmr.dial', { side, target, callType }),
    clearManualDial: (side: 'a' | 'b') => rpc('dmr.dial', { side, target: null }),
    // Live recordings state (pushed) + a one-shot hydrate on panel open (re-run on reconnect).
    recordings,
    liveRecordings,
    recorderStatus,
    loadRecordings: hydrateRecordings,
    recordingsSetEnabled: (enabled: boolean) => rpc<{ enabled: boolean }>('recordings.setEnabled', { enabled }),
    recordingsDelete: (id: string) => rpc('recordings.delete', { id }),
    // Packet TNC (direwolf): pushed status + the enable/disable switch.
    packetStatus,
    packetSetEnabled: (enabled: boolean) => rpc<PacketStatus>('packet.setEnabled', { enabled }),
    key: () => {
      startHoldBeacon()
      return rpc('ptt.key').catch((e: unknown) => {
        stopHoldBeacon()
        throw e
      })
    },
    unkey: () => {
      stopHoldBeacon()
      return rpc('ptt.unkey')
    },
    dismissError: () => rpc('error.dismiss'),
    keyMic,
    unkeyMic,
    hasMic,
    enableMic,
    disableMic,
    getRtcStats,
    // Mic→radio gain: runtime-adjustable (applies to the next mic frame) + server-persisted.
    getTxGain: () => rpc<{ gain: number }>('rtc.gain'),
    setTxGain: (gain: number) => rpc<{ gain: number }>('rtc.setGain', { gain }),
    chooseSide: (side: 'a' | 'b') => rpc('side.select', { side }),
    setVfoMode: (side: 'a' | 'b', vfo: boolean) => rpc('vfo.setMode', { side, vfo }),
    channelStep: (side: 'a' | 'b', dir: 1 | -1) => rpc('channel.step', { side, dir }),
    zoneStep: (side: 'a' | 'b', dir: 1 | -1) => rpc('zone.step', { side, dir }),
    startAudio,
    stopAudio,
  }
}
