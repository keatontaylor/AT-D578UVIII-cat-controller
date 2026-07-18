// Entry point — the single un-bundled Node process: wires the engine and serves the SPA + /ws.
// PASSIVE: never auto-discovers or auto-connects; the UI drives scan → pair → connect.
//
//   npm run dev      DEV=1 → Vite middleware + HMR (single process)
//   npm run build    vite build → dist/
//   npm start        serve dist/ + /ws

import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { StateBroadcaster } from './api/broadcast'
import { createServer } from './api/server'
import { resolveTls } from './api/tls'
import { BluealsaHfp } from './audio'
import { AudioBridge, wired48kTo8k, type IceServer } from './audio/rtc'
import { cloudflareTurn, staticIce } from './audio/ice'
import { Recorder } from './audio/recorder'
import { ScoKick } from './audio/sco-kick'
import { PacketService } from './packet/service'
import { createBtManager, resolveSppChannel } from './bluetooth'
import { RadioController } from './services/radio-service'
import { RadioIdDb } from './services/radioid'
import { activeReceive, audioGateOpen, modeLabel } from './domain/receive'
import { RfcommTransport } from './transport/rfcomm'
import { tapTransport } from './transport/tap'

const PORT = Number(process.env['ANYTONE_API_PORT'] ?? 3010)
const HOST = process.env['ANYTONE_API_HOST'] ?? '0.0.0.0'
const DEV = process.env['DEV'] === '1'
// URL sub-path the app is mounted under (behind nginx at ftx.invertedorigin.com/anytone-v2).
// Must match the Vite `base` the SPA was built with (vite.config.ts). Set '' to serve at root.
// Default mount = ROOT (served straight at http://<host>:PORT/). Set ANYTONE_BASE_PATH to a
// subpath when serving several apps behind one host; trailing slashes are stripped ('/' → '').
const BASE_PATH = (process.env['ANYTONE_BASE_PATH'] ?? '').replace(/\/+$/, '')
// Serve HTTPS directly (default ON) so a LAN-facing install grants the microphone (PTT voice)
// without an nginx dependency — self-signed once into <repo>/runtime/tls unless the operator
// supplies ANYTONE_TLS_CERT/_KEY. ANYTONE_TLS=0 for plain HTTP (localhost dev, or behind a
// TLS-terminating proxy). null → HTTP.
const TLS = resolveTls({
  enabled: !['0', 'false', 'off', 'no'].includes((process.env['ANYTONE_TLS'] ?? '1').toLowerCase()),
  certPath: process.env['ANYTONE_TLS_CERT'],
  keyPath: process.env['ANYTONE_TLS_KEY'],
  dir: process.env['ANYTONE_TLS_DIR'] ?? fileURLToPath(new URL('../runtime/tls', import.meta.url)),
  log: (m) => console.log(`[tls] ${m}`),
})
const ADDRESS = process.env['ANYTONE_BT_ADDR']
const CHANNEL = Number(process.env['ANYTONE_SPP_CHANNEL'] ?? 2)

// RadioID.net DMR user DB for caller-id (callsign/name/location). Loaded once in the background —
// a miss (no CSV) just means live calls show the id/alias without operator details.
const radioid = new RadioIdDb()
const RADIOID_CSV = process.env['ANYTONE_RADIOID_CSV'] ?? fileURLToPath(new URL('../data/radioid_user.csv', import.meta.url))
void radioid
  .load(RADIOID_CSV)
  .then((n) => console.log(`[radioid] ${n ? `loaded ${n} operators` : `no DB at ${RADIOID_CSV}`}`))
  .catch((e) => console.log(`[radioid] load failed: ${(e as Error).message}`))

const audioLink = new BluealsaHfp((m) => console.log(`[audio] ${m}`))
// The current session's wire-capture file (set per connect in createTransport; null when logging
// is disabled). Exposed to the server for the link-stats download.
let currentWirePath: string | null = null
const controller = new RadioController({
  resolveCaller: (id) => radioid.lookup(id),
  bt: createBtManager({ ...(ADDRESS ? { address: ADDRESS } : {}), log: (m) => console.log(`[bt] ${m}`) }),
  audio: audioLink,
  createTransport: (addr, ch) => {
    const t = new RfcommTransport(addr, ch)
    t.connect()
    // NDJSON wire capture per connect (diagnostics; relay-capture schema), downloadable from the
    // link-stats dialog so users can hand a maintainer a capture. ON BY DEFAULT — the download is
    // meaningless otherwise. ANYTONE_WIRE_LOG: '0'/'off' disables; '1' or unset → <repo>/captures
    // (repo-relative like RECORDINGS_DIR, so it lands inside any install dir); any other value is
    // the target directory.
    const wireLog = process.env['ANYTONE_WIRE_LOG']
    if (wireLog === '0' || wireLog === 'off') {
      currentWirePath = null
      return t
    }
    const dir = !wireLog || wireLog === '1' ? fileURLToPath(new URL('../captures', import.meta.url)) : wireLog
    // Retention: keep the newest 20 captures. Default-on + per-connect files with no cleanup
    // would grow without bound on a long-lived install. Timestamped names sort chronologically.
    try {
      for (const f of readdirSync(dir).filter((f) => f.startsWith('v2-wire-') && f.endsWith('.ndjson')).sort().slice(0, -20)) {
        unlinkSync(`${dir}/${f}`)
      }
    } catch { /* dir may not exist yet — tapTransport creates it */ }
    const path = `${dir}/v2-wire-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`
    currentWirePath = path
    console.log(`[link] wire tap → ${path}`)
    return tapTransport(t, path)
  },
  // gapMs 35: the real BT-01 never sends two commands closer than ~33-35ms (firmware SysTick
  // software-timer floor). rxQuietMs 30: never begin a transmit while the radio is mid-frame / just
  // transmitted — reads and writes share opcodes (04 2c read vs write), so a byte collision with
  // the radio's TX can misframe a read into a codeplug write. Both measured across all captures.
  linkConfig: { timeoutMs: 1000, maxAttempts: 10, gapMs: 35, rxQuietMs: 30 },
  // F1.3: re-establish the control link on an unexpected drop, capped-backoff, indefinitely.
  reconnect: true,
  now: () => Date.now(),
  channel: CHANNEL,
  // Prefer the SPP channel from the device's SDP record; the controller falls back to CHANNEL.
  resolveChannel: async (addr) => {
    const ch = await resolveSppChannel(addr)
    console.log(`[bt] SPP channel ${ch === null ? `not resolved via SDP — using ${CHANNEL}` : `${ch} (SDP)`}`)
    return ch
  },
  log: (m) => console.log(`[link] ${m}`),
})

const broadcaster = new StateBroadcaster(controller.appState)
controller.onChange((s) => broadcaster.publish(s))

// Runtime config: UI-adjustable knobs that must survive restarts (currently just the mic gain).
// The env vars remain the DEFAULTS; a UI change wins once made.
const CONFIG_FILE = process.env['ANYTONE_CONFIG_FILE'] ?? fileURLToPath(new URL('../runtime-config.json', import.meta.url))
const runtimeCfg: { txGain?: number } = (() => {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { txGain?: number }
  } catch {
    return {}
  }
})()
const saveRuntimeCfg = (): void => {
  writeFile(CONFIG_FILE, `${JSON.stringify(runtimeCfg, null, 2)}\n`).catch((e: Error) =>
    console.log(`[cfg] save failed: ${e.message}`),
  )
}

// Mic-TX gain: browser mics run hot into the radio's narrowband mic input and overmodulate at
// unity, so attenuate. 0.6 default (PoC uses 0.7); boot default via ANYTONE_AUDIO_TX_GAIN,
// overridden by a persisted UI adjustment (rtc.setGain), and adjustable live from the UI.
const TX_GAIN = Number(runtimeCfg.txGain ?? process.env['ANYTONE_AUDIO_TX_GAIN'] ?? 0.6)

// ICE servers for WebRTC (ANYTONE_ICE_SERVERS): unset → a public STUN default so remote
// (cellular/NATed) clients can reach the audio; 'off' → LAN-only host candidates; otherwise a
// JSON array of RTCIceServer objects. Served to the browser via rtc.config so both peers use
// the same set.
function parseIceServers(raw: string | undefined): IceServer[] {
  const DEFAULT = [{ urls: 'stun:stun.l.google.com:19302' }]
  if (raw === undefined) return DEFAULT
  if (raw.trim() === '' || raw.trim().toLowerCase() === 'off') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as IceServer[]
  } catch {
    /* fall through to the warning */
  }
  console.warn('[rtc] ANYTONE_ICE_SERVERS is not a JSON array — using the default STUN server')
  return DEFAULT
}
const ICE_SERVERS = parseIceServers(process.env['ANYTONE_ICE_SERVERS'])

// Cloudflare TURN (ANYTONE_CF_TURN_KEY_ID + ANYTONE_CF_TURN_API_TOKEN): when set, short-lived
// relay credentials are minted on demand (cached to their TTL) and REPLACE the static list —
// Cloudflare's response carries its own STUN too. STUN-only hole punching fails on symmetric
// CGNAT (T-Mobile's NAT64); the relay is the fallback ICE reaches for when direct pairs fail.
// The static/env list above remains the outage fallback.
const CF_TURN_KEY_ID = process.env['ANYTONE_CF_TURN_KEY_ID']
const CF_TURN_API_TOKEN = process.env['ANYTONE_CF_TURN_API_TOKEN']
const iceProvider =
  CF_TURN_KEY_ID && CF_TURN_API_TOKEN
    ? cloudflareTurn({
        keyId: CF_TURN_KEY_ID,
        apiToken: CF_TURN_API_TOKEN,
        ttlSeconds: Number(process.env['ANYTONE_CF_TURN_TTL'] ?? 86400),
        fallback: ICE_SERVERS,
        log: (m) => console.log(`[rtc] ${m}`),
      })
    : staticIce(ICE_SERVERS)

// Wired RX audio (ANYTONE_RX_ALSA=<alsa capture device>, e.g. the Digirig on the radio's rear
// speaker jack): replaces the BlueALSA HFP capture with a 48 kHz arecord, FIR-decimated
// in-process to the pipeline's 8 kHz — no CVSD, no BT-chip AGC, no radio NR on the audio.
// Bluetooth keeps doing control, PTT and mic TX. Level staging: the jack follows the volume
// knob; trim with `amixer -c <card> sset Mic <n> Capture` (AGC off).
const RX_ALSA = process.env['ANYTONE_RX_ALSA']

// WebRTC RX audio: the wired ALSA device when configured, else the radio's HFP source PCM.
const audio = new AudioBridge(
  () => {
    if (RX_ALSA) {
      return { command: 'arecord', args: ['-q', '-D', RX_ALSA, '-f', 'S16_LE', '-r', '48000', '-c', '1', '-t', 'raw'] }
    }
    const addr = controller.appState.address
    if (!addr) throw new Error('no radio connected')
    return audioLink.captureCommand(audioLink.pcmPath(addr, null))
  },
  (m) => console.log(`[rtc] ${m}`),
  // Mic TX sink: the connected radio's HFP sink, or null when nothing's connected.
  () => {
    const addr = controller.appState.address
    return addr ? audioLink.playCommand(audioLink.pcmSinkPath(addr, null)) : null
  },
  Number.isFinite(TX_GAIN) && TX_GAIN > 0 ? TX_GAIN : 0.6,
  iceProvider,
  // ANYTONE_RTC_FORCE_RELAY=1 → every audio path (even LAN) rides the TURN relay: both peers get
  // iceTransportPolicy 'relay', so no host/STUN candidates exist. Requires working TURN minting.
  process.env['ANYTONE_RTC_FORCE_RELAY'] === '1',
  RX_ALSA ? wired48kTo8k() : undefined,
)
// RX capture liveness → AppState.rxAudioAlive → UI banner ("capture down" vs quiet channel).
audio.capture.onAliveChange = (alive) => controller.setRxAudioAlive(alive)
// TX real-stream evidence → the session's pipe-latency probe (release drain) + keyed-silence
// guard. RTP packet counts, NOT the frame tee: wrtc's NetEq synthesizes decode-cadence frames
// continuously even with no sender track (live-diagnosed 2026-07-18 — the tee flattened the
// drain to its 300 ms floor and made the guard unfireable). Polled only while PTT is active.
let txRtpPoll: ReturnType<typeof setInterval> | null = null
// Server-driven mic-sink close: the browser stops its stream AT release, but the sink stays open
// through the release drain (buffered tail → radio); close when ptt actually returns to rest.
controller.onChange((s) => {
  const pttActive = s.radio.ptt === 'keying' || s.radio.ptt === 'keyed' || s.radio.ptt === 'unkeying'
  if (pttActive && !txRtpPoll) {
    txRtpPoll = setInterval(() => {
      void audio.txPacketsReceived().then((n) => {
        if (n != null) controller.noteTxRtpPackets(n)
      })
    }, 200)
    txRtpPoll.unref?.()
  } else if (!pttActive && txRtpPoll) {
    clearInterval(txRtpPoll)
    txRtpPoll = null
  }
  if (s.radio.ptt === 'idle' || s.radio.ptt === 'fault') {
    audio.closeMicSinks()
    // Clear the mic-attached LEVEL at rest: the browser re-asserts it per press (rtc.mic
    // active on every attach) but deliberately never sends inactive at release (the sink must
    // outlive its stream for the drain). Without this reset, a PACKET keyup after any browser
    // PTT use would inherit a stale mic-expected flag → the silence guard would kill direwolf's
    // transmission at 2.5 s (audit 2026-07-18).
    controller.setTxMicActive(false)
  }
})

// Headless squelch-triggered recorder (F4.3): shares the RX capture; records the selected side's
// clips to disk with metadata. Off until enabled from the UI.
const RECORDINGS_DIR = process.env['ANYTONE_RECORDINGS_DIR'] ?? fileURLToPath(new URL('../recordings', import.meta.url))
const recorder = new Recorder(
  audio.capture,
  RECORDINGS_DIR,
  () => {
    const rs = controller.appState.radio
    // Attribute the clip to the ACTUAL receiving side (DMR-matched or open analog side), not the
    // selected one — otherwise a DMR call on the non-selected side is mis-marked.
    // the DERIVED gate (5b OR per-side 5a): a scan-held DMR call on the other side never raises
    // 5b (wire-pinned 2026-07-11) — raw 5b here silently stopped recording exactly those calls
    const recv = activeReceive(rs, audioGateOpen(rs))
    return {
      squelchOpen: recv.open,
      side: recv.side,
      source: recv.source,
      aOpen: recv.aOpen,
      bOpen: recv.bOpen,
      channelName: recv.channelName,
      freqMHz: recv.freqMHz,
      identityResolved: recv.identityResolved,
      mode: recv.mode,
      talkgroup: recv.talkgroup,
      talkgroupName: recv.talkgroupName,
    }
  },
  (m) => console.log(`[rec] ${m}`),
)

// UI PTT deadman: keyed with no `ptt.hold` beacon for this long → force-release (see server.ts).
const PTT_DEADMAN_MS = Number(process.env['ANYTONE_PTT_DEADMAN_MS'] ?? 4000)

// TX recorder: the operator's own transmissions, tapped from the WebRTC mic path at the exact
// point the audio goes to the radio (post-downsample, post-gain). Gate = OUR PTT lifecycle
// (frames flow whenever a peer's mic is armed — silence while unkeyed closes the clip's tail).
// Same directory as the RX recorder, so list/delete/playback need nothing new.
const txRecorder = new Recorder(
  audio.txSource,
  RECORDINGS_DIR,
  () => {
    const rs = controller.appState.radio
    const side = rs.selectedSide
    const s = rs.sides[side]
    const keyed = rs.ptt === 'keying' || rs.ptt === 'keyed' || rs.ptt === 'unkeying'
    // The TG we're transmitting TO: the manual-dial override, the live TX call's dest, else the
    // channel's programmed contact (DMR channels only).
    const talkgroup =
      rs.manualDial[side]?.target ??
      (rs.dmr?.direction === 'tx' ? rs.dmr.dest : null) ??
      (s.channel && s.channel.type !== 'analog' ? s.channel.contact?.talkgroup ?? null : null)
    // Its name: the channel's programmed contact name, but only when we're keying THAT contact
    // (no manual dial to a different target) — a dial has no name to show.
    const talkgroupName =
      rs.manualDial[side] == null && s.channel && s.channel.type !== 'analog' && s.channel.contact?.talkgroup === talkgroup
        ? s.channel.contact?.name || null
        : null
    return {
      squelchOpen: keyed,
      side,
      channelName: s.channelName,
      freqMHz: s.txFreqMHz ?? s.freqMHz,
      mode: modeLabel(s.channel),
      talkgroup,
      talkgroupName,
    }
  },
  (m) => console.log(`[rec-tx] ${m}`),
  'tx',
)

// Recorders are ON by default (ANYTONE_RECORDER_AUTOSTART=0 opts out). The TX recorder's source
// is in-memory (the WebRTC mic tee) so it arms once at boot; the RX capture only exists once a
// radio is CONNECTED (HFP PCM), so the squelch recorder is (re)armed on every connected
// transition — the disable→enable cycle also restarts the shared capture process a disconnect
// killed, and flushes any clip the drop left open. The UI toggle still works; it just starts on.
const RECORDER_AUTOSTART = process.env['ANYTONE_RECORDER_AUTOSTART'] !== '0'
if (RECORDER_AUTOSTART) {
  void txRecorder.setEnabled(true).catch((e) => console.log(`[rec-tx] autostart failed: ${(e as Error).message}`))
  let lastConn = ''
  let arming = false
  controller.onChange((s) => {
    const was = lastConn
    lastConn = s.connection
    if (s.connection !== 'connected' || was === 'connected' || arming) return
    arming = true
    void (async () => {
      try {
        if (recorder.status.enabled) await recorder.setEnabled(false) // resubscribe → capture restart
        await recorder.setEnabled(true)
        console.log('[rec] armed (autostart on connect)')
      } catch (e) {
        console.log(`[rec] autostart failed: ${(e as Error).message}`)
      } finally {
        arming = false
      }
    })()
  })
}


// SCO kick experiment (ANYTONE_SCO_KICK=1): at audio-gate open, acquire the HFP sink from OUR
// side so eSCO comes up ~1.6 s before the radio's own call choreography would bring it up —
// testing whether the radio sources audio early for an accessory that asks (see sco-kick.ts).
if (process.env['ANYTONE_SCO_KICK'] === '1') {
  const scoKick = new ScoKick(
    () => {
      const addr = controller.appState.address
      return addr ? audioLink.playCommand(audioLink.pcmSinkPath(addr, null)) : null
    },
    (m) => console.log(`[sco-kick] ${m}`),
  )
  controller.onChange((s) => {
    scoKick.update({
      gateOpen: audioGateOpen(s.radio),
      pttBusy: s.radio.ptt !== 'idle',
      connected: s.connection === 'connected',
    })
  })
  console.log('[sco-kick] experiment enabled — HF-initiated eSCO at audio-gate open')
}

// Packet TNC (direwolf bridge): RX audio tees to direwolf over UDP, direwolf's TX audio returns
// via the snd-aloop loopback into the same HFP sink the browser mic uses, and its PTT drives our
// ACK-confirmed key path through a local rigctl shim. Exposes KISS :8001 + AGW :8000 to the LAN
// while enabled (from the UI's Packet TNC card); zero footprint while off.
const packet = new PacketService(
  audio.capture,
  () => {
    const addr = controller.appState.address
    return addr ? audioLink.playCommand(audioLink.pcmSinkPath(addr, null)) : null
  },
  {
    key: () => controller.key(),
    unkey: (immediate = false) => controller.unkey(immediate),
    pttPhase: () => controller.appState.radio.ptt,
    txRefusal: () => {
      const s = controller.appState
      if (s.connection !== 'connected') return 'radio not connected'
      const side = s.radio.sides[s.radio.selectedSide]
      if (side.channel && side.channel.type !== 'analog') return 'selected channel is digital — packet needs an analog channel'
      return null
    },
    // Radio-truth carrier detect for the pre-key channel-clear wait (either side's squelch open
    // or the audio gate up = the radio is busy receiving and will drop a keydown).
    rxBusy: () => {
      const rs = controller.appState.radio
      return rs.signal.aOpen || rs.signal.bOpen || audioGateOpen(rs)
    },
  },
  {
    callsign: process.env['ANYTONE_PACKET_CALLSIGN'] ?? 'N0CALL',
    kissPort: Number(process.env['ANYTONE_PACKET_KISS_PORT'] ?? 8001),
    agwPort: Number(process.env['ANYTONE_PACKET_AGW_PORT'] ?? 8000),
    udpPort: Number(process.env['ANYTONE_PACKET_UDP_PORT'] ?? 7355),
    rigctlPort: Number(process.env['ANYTONE_PACKET_RIGCTL_PORT'] ?? 4532),
    playbackDevice: process.env['ANYTONE_PACKET_PLAY_DEV'] ?? 'plughw:CARD=Loopback,DEV=0',
    captureDevice: process.env['ANYTONE_PACKET_CAP_DEV'] ?? 'plughw:CARD=Loopback,DEV=1',
    // Short path (repo root) — direwolf truncates config paths around ~100 chars.
    confPath: fileURLToPath(new URL('../direwolf.conf', import.meta.url)),
    mdnsName: process.env['ANYTONE_PACKET_MDNS_NAME'] ?? 'AnyTone D578 TNC',
    // Wired modem audio (OPT-IN): a private 48 kHz capture on this device instead of the shared
    // 8 kHz BT/CVSD tap. Default off — BT-only is the supported setup; the wired path needs a
    // USB card on the rear jack (and dsnoop if the app's RX capture shares the same card).
    rxDevice: process.env['ANYTONE_PACKET_RX_ALSA'] || null,
    // ×10 ms. Long TXDELAY on purpose: keying rides BT ACK + SCO TX spin-up (see PacketOptions).
    txDelay: Number(process.env['ANYTONE_PACKET_TXDELAY'] ?? 70),
    txTail: Number(process.env['ANYTONE_PACKET_TXTAIL'] ?? 5),
  },
  (m) => console.log(`[packet] ${m}`),
)

const app = await createServer(
  {
    controller,
    broadcaster,
    audio,
    recorder,
    txRecorder,
    packet,
    saveTxGain: (gain) => {
      runtimeCfg.txGain = gain
      saveRuntimeCfg()
    },
    wireCapture: () => currentWirePath,
  },
  DEV
    ? { viteRoot: fileURLToPath(new URL('../ui', import.meta.url)), basePath: BASE_PATH, pttDeadmanMs: PTT_DEADMAN_MS, ...(TLS ? { https: TLS } : {}) }
    : { staticDir: fileURLToPath(new URL('../dist', import.meta.url)), basePath: BASE_PATH, pttDeadmanMs: PTT_DEADMAN_MS, ...(TLS ? { https: TLS } : {}) },
)

await app.listen({ port: PORT, host: HOST })
const scheme = TLS ? 'https' : 'http'
console.log(`[anytone-v2] ${DEV ? 'dev (Vite HMR)' : 'serving SPA'} on ${scheme}://${HOST}:${PORT}${BASE_PATH}/ — passive; drive connect from the UI`)
if (TLS) console.log('[anytone-v2] TLS on (self-signed unless ANYTONE_TLS_CERT/_KEY set) — browsers will warn once on the cert; accept it to allow the microphone (PTT)')

async function shutdown(): Promise<void> {
  // Finalize any in-flight clip FIRST (saved/discarded pushed, sidecar written) — a restart must
  // never strand an orphan WAV or leave clients holding a phantom "live" recording.
  await Promise.all([recorder.setEnabled(false), txRecorder.setEnabled(false)]).catch(() => {})
  await packet.disable().catch(() => {})
  await controller.disconnect().catch(() => {})
  await app.close().catch(() => {})
  process.exit(0)
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
