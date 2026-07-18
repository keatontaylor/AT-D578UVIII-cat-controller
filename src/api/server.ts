// The single-process HTTP server (Fastify). Serves the SPA and hosts the /ws JSON-RPC bridge in
// one un-bundled Node process — the engine loads native modules (koffi/dbus) normally, no
// tracing/bundling. Official Fastify plugins only:
//   • @fastify/websocket — the /ws bridge → the pure dispatch() + StateBroadcaster
//   • @fastify/static    — serve the built SPA (production)
//   • @fastify/middie    — mount Vite's dev middleware for single-process HMR (development)

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { z } from 'zod'
import { createReadStream, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AppState, RadioController, WireCaptureInfo } from '../services/radio-service'
import type { AudioBridge, RtcAudioSession } from '../audio/rtc'
import type { Recorder } from '../audio/recorder'
import type { PacketService } from '../packet/service'
import type { StateBroadcaster } from './broadcast'
import { fail, idOf, notify, ok, RpcErrorCode, RpcRequest } from './jsonrpc'
import { HEARTBEAT_MS, makeHeartbeat } from './heartbeat'
import { dispatch } from './router'

/** Metadata for the current wire capture (name + size), or null when there's no readable file —
 * synchronous because it augments the link.stats response inline. */
function wireCaptureInfo(path: string | null): WireCaptureInfo | null {
  if (!path) return null
  try {
    return { filename: basename(path), sizeBytes: statSync(path).size }
  } catch {
    return null // logging enabled but the file isn't there yet / was removed
  }
}

const RtcOfferParams = z.object({ type: z.literal('offer'), sdp: z.string().min(1).max(1_000_000) })
const RtcIceParams = z.object({
  candidate: z.string(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
  usernameFragment: z.string().optional(),
})

export interface ServerDeps {
  controller: RadioController
  /** The /ws state payload — the authoritative AppState (snapshot + RFC 7396 patches). */
  broadcaster: StateBroadcaster<AppState>
  /** WebRTC audio bridge (RX). Omitted → rtc.* methods report unavailable. */
  audio?: AudioBridge
  /** Headless squelch recorder. Omitted → recordings.* report unavailable, no /recordings route. */
  recorder?: Recorder
  /** TX (operator transmission) recorder — same directory as `recorder`, so list/delete/WAV
   * serving go through `recorder`; this one only needs its events relayed + enable mirrored. */
  txRecorder?: Recorder
  /** Persist a runtime mic-gain change (rtc.setGain) so it survives restarts. */
  saveTxGain?: (gain: number) => void
  /** Packet TNC (direwolf bridge). Omitted → packet.* methods report unavailable. */
  packet?: PacketService
  /** Current session's diagnostics wire capture — absolute path, or null when logging is off /
   * nothing captured yet. Surfaced in link.stats (wireCapture metadata) and downloadable at
   * `${base}/wire/current` so users can hand a capture to a maintainer for debugging. */
  wireCapture?: () => string | null
}

export interface ServerOptions {
  /** Production: directory of the built SPA to serve. */
  staticDir?: string
  /** Development: project root containing the Vite app (ui/) — enables middleware + HMR. */
  viteRoot?: string
  /** WebSocket ping interval (ms); defaults to HEARTBEAT_MS. */
  heartbeatMs?: number
  /** PTT deadman window (ms, default 4000): keyed with no `ptt.hold` beacon from the keying
   * socket for this long → force-release. Beacons pipeline (1/s regardless of RTT), so this is a
   * THROUGHPUT requirement, not a latency one — only a genuine multi-second outage trips it. */
  pttDeadmanMs?: number
  /** URL sub-path the app is mounted under (e.g. `/anytone-v2` behind nginx). Everything —
   * the SPA assets, `/ws`, `/recordings` — is served under this prefix, so the app works
   * identically when hit directly (`:8080/anytone-v2/`) or proxied. Empty → mounted at root. */
  basePath?: string
  /** TLS: PEM key+cert to serve HTTPS directly (self-signed by default — see resolveTls in
   * main.ts). Omit for plain HTTP (dev on localhost, or behind a TLS-terminating proxy like
   * nginx). Browsers only grant microphone access on a secure origin, so a LAN-facing install
   * needs this (or a proxy) for PTT voice. */
  https?: { key: Buffer; cert: Buffer }
}

export async function createServer(deps: ServerDeps, opts: ServerOptions = {}): Promise<FastifyInstance> {
  // With `https` set, Fastify infers a TLS server type; the whole app uses only the base
  // FastifyInstance surface (register/get/listen/.server.address), so normalize the type here.
  // Two concrete calls (not a union arg) keep each Fastify overload happy.
  const app = (opts.https
    ? Fastify({ logger: false, https: opts.https })
    : Fastify({ logger: false })) as unknown as FastifyInstance
  await app.register(fastifyWebsocket)

  // Normalized mount prefix: no trailing slash ('' at root, '/anytone-v2' under nginx). The SPA is
  // built with Vite base=`${base}/`, so its asset/ws/recordings URLs all carry this prefix.
  const base = (opts.basePath ?? '').replace(/\/+$/, '')

  // ── PTT DEADMAN (the UI as a hold-to-talk deadman switch) ────────────────────
  // The transmitter must NEVER stay keyed because the release command couldn't reach us. While
  // the PTT button is physically held, the page beacons `ptt.hold` every second; keyed with no
  // beacon for pttDeadmanMs — or the keying socket closing — force-releases through the normal
  // unkey path (which carries the radio-side ARQ/BT-teardown failsafe). Scoped to the OWNING
  // socket, so another viewer's flaky connection can never release someone else's transmission.
  // The reason persists on AppState.error (rides every state.snapshot → a page loaded later
  // still sees why TX dropped). The beacon proves the page's JS is alive — a frozen mobile tab
  // keeps answering transport pings but stops beaconing, which is exactly the deadman condition.
  const deadmanMs = opts.pttDeadmanMs ?? 4000
  const ptt: { owner: unknown; lastHoldAt: number } = { owner: null, lastHoldAt: 0 }
  const releasePtt = (why: string): void => {
    ptt.owner = null
    const phase = deps.controller.appState.radio.ptt
    if (phase !== 'keying' && phase !== 'keyed') return // nothing keyed — nothing to force
    try {
      deps.controller.unkey(true) // immediate: safety release NEVER waits for the audio drain
      deps.controller.notePttDeadman(why)
    } catch {
      /* not connected — nothing transmitting through us */
    }
  }
  const deadmanTimer = setInterval(
    () => {
      if (ptt.owner !== null && Date.now() - ptt.lastHoldAt > deadmanMs) {
        releasePtt('the transmitting page went silent mid-PTT (connection lost or tab frozen)')
      }
    },
    Math.max(25, Math.min(1000, Math.floor(deadmanMs / 4))),
  )
  deadmanTimer.unref?.()
  app.addHook('onClose', async () => clearInterval(deadmanTimer))

  // /ws — one socket per client: snapshot + RFC 7396 patches out; JSON-RPC in.
  app.get(`${base}/ws`, { websocket: true }, (socket) => {
    const send = (message: unknown): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
    }
    const unsubscribe = deps.broadcaster.subscribe(send)
    // Relay recorder events (opened / saved / discarded / removed / status) to this client so the
    // recordings timeline updates live with no polling. The TX recorder shares the same event
    // channel — its clips carry direction:'tx'. One subscription each per socket; dropped on close.
    const unsubscribeRec = deps.recorder?.subscribe((e) => send(notify(`recordings.${e.type}`, e)))
    const unsubscribeTx = deps.txRecorder?.subscribe((e) => e.type !== 'status' && send(notify(`recordings.${e.type}`, e)))
    // Packet TNC status pushes (enable/disable, direwolf health, PTT, decode counters).
    const unsubscribePkt = deps.packet?.subscribe((s) => send(notify('packet.status', s)))

    // Transport keepalive: ping every interval; a socket that missed the previous pong is reaped
    // (defeats proxy idle-timeouts + prevents leaked subscriptions from unclean disconnects).
    const hb = makeHeartbeat(socket)
    socket.on('pong', hb.pong)
    const heartbeat = setInterval(() => hb.tick(), opts.heartbeatMs ?? HEARTBEAT_MS)
    heartbeat.unref?.()
    // Per-socket WebRTC audio peer, created lazily on the first rtc.offer. Signaling (offer/answer/
    // ice) is socket-aware so it lives here, not in the pure dispatch(); state RPC stays pure.
    // A PROMISE, not the session: creation awaits ICE credentials (TURN minting), and trickle
    // candidates can arrive in that window — chaining on the promise preserves their order.
    let rtc: Promise<RtcAudioSession> | null = null
    const handleRtc = (raw: unknown): void => {
      const parsed = RpcRequest.safeParse(raw)
      if (!parsed.success) {
        send(fail(idOf(raw), RpcErrorCode.InvalidRequest, 'invalid request'))
        return
      }
      const req = parsed.data
      const id = idOf(req)
      if (!deps.audio) {
        if (id !== null) send(fail(id, RpcErrorCode.InvalidRequest, 'audio not available'))
        return
      }
      if (req.method === 'rtc.offer') {
        const params = RtcOfferParams.safeParse(req.params)
        if (!params.success) {
          if (id !== null) send(fail(id, RpcErrorCode.InvalidParams, 'invalid params', params.error.issues))
          return
        }
        rtc ??= deps.audio.createSession((candidate) => send(notify('rtc.ice', candidate)))
        void rtc
          .then((s) => s.offer(params.data))
          .then((answer) => id !== null && send(ok(id, answer)))
          .catch((e: Error) => id !== null && send(fail(id, RpcErrorCode.InternalError, e.message)))
      } else if (req.method === 'rtc.ice') {
        const params = RtcIceParams.safeParse(req.params)
        if (!params.success) {
          if (id !== null) send(fail(id, RpcErrorCode.InvalidParams, 'invalid params', params.error.issues))
          return
        }
        if (!rtc) {
          if (id !== null) send(fail(id, RpcErrorCode.InvalidRequest, 'rtc session not started'))
          return
        }
        void rtc.then((s) => s.addIce(params.data)).catch(() => {})
        if (id !== null) send(ok(id, {}))
      } else if (req.method === 'rtc.mic') {
        // Mic-TX gate OPEN: the browser attached its per-press mic stream. The CLOSE side is
        // server-driven (main.ts closes sinks when ptt returns to idle/fault) so the release
        // drain can keep feeding in-flight audio after the browser stopped its stream; an
        // explicit {active:false} (mic disarm) still closes immediately.
        const params = z.object({ active: z.boolean() }).safeParse(req.params)
        if (!params.success) {
          if (id !== null) send(fail(id, RpcErrorCode.InvalidParams, 'invalid params'))
          return
        }
        void rtc?.then((s) => s.setMicActive(params.data.active)).catch(() => {})
        deps.controller.setTxMicActive?.(params.data.active)
        if (id !== null) send(ok(id, {}))
      } else if (req.method === 'rtc.config') {
        // The ICE servers the browser must use — the server is the single source of truth
        // (env-configured STUN or minted TURN credentials), so both peers gather the same set.
        // iceTransportPolicy 'relay' (ANYTONE_RTC_FORCE_RELAY) forces every path through TURN.
        const policy = deps.audio.relayOnly ? 'relay' : 'all'
        if (id !== null) {
          void deps.audio
            .iceServers()
            .then((iceServers) => send(ok(id, { iceServers, iceTransportPolicy: policy })))
            .catch(() => send(ok(id, { iceServers: [], iceTransportPolicy: policy })))
        }
      } else if (req.method === 'rtc.gain') {
        // the runtime mic→radio gain (env ANYTONE_AUDIO_TX_GAIN is only the boot default)
        if (id !== null) send(ok(id, { gain: deps.audio.txGain }))
      } else if (req.method === 'rtc.setGain') {
        const params = z.object({ gain: z.number().min(0.05).max(2) }).safeParse(req.params)
        if (!params.success) {
          if (id !== null) send(fail(id, RpcErrorCode.InvalidParams, 'gain must be a number in [0.05, 2]'))
          return
        }
        const applied = deps.audio.setTxGain(params.data.gain)
        deps.saveTxGain?.(applied)
        if (id !== null) send(ok(id, { gain: applied }))
      } else if (req.method === 'rtc.stop') {
        void rtc?.then((s) => s.close()).catch(() => {})
        rtc = null
        if (id !== null) send(ok(id, {}))
      } else if (id !== null) {
        send(fail(id, RpcErrorCode.MethodNotFound, `method not found: ${req.method}`))
      }
    }

    // recordings.* — headless recorder control + clip browse (clip audio is served over HTTP).
    const handleRecordings = async (raw: unknown): Promise<void> => {
      const parsed = RpcRequest.safeParse(raw)
      if (!parsed.success) return
      const req = parsed.data
      const id = idOf(req)
      const rec = deps.recorder
      if (!rec) {
        if (id !== null) send(fail(id, RpcErrorCode.InvalidRequest, 'recording not available'))
        return
      }
      try {
        if (req.method === 'recordings.status') {
          if (id !== null) send(ok(id, rec.status))
        } else if (req.method === 'recordings.live') {
          // recordings IN PROGRESS right now (both recorders) — hydrates a client that
          // (re)connected mid-recording, since it missed the `opened` push
          if (id !== null) send(ok(id, [rec.live, deps.txRecorder?.live ?? null].filter((c) => c !== null)))
        } else if (req.method === 'recordings.setEnabled') {
          const p = z.object({ enabled: z.boolean() }).parse(req.params)
          await rec.setEnabled(p.enabled)
          await deps.txRecorder?.setEnabled(p.enabled) // TX recording rides the same switch
          if (id !== null) send(ok(id, rec.status))
        } else if (req.method === 'recordings.list') {
          if (id !== null) send(ok(id, await rec.list()))
        } else if (req.method === 'recordings.delete') {
          const p = z.object({ id: z.string() }).parse(req.params)
          await rec.remove(p.id)
          if (id !== null) send(ok(id, {}))
        } else if (id !== null) {
          send(fail(id, RpcErrorCode.MethodNotFound, `method not found: ${req.method}`))
        }
      } catch (e) {
        if (id !== null) send(fail(id, RpcErrorCode.InternalError, (e as Error).message))
      }
    }

    // packet.* — TNC control + status (side-channel like recordings; not radio state).
    const handlePacket = async (raw: unknown): Promise<void> => {
      const parsed = RpcRequest.safeParse(raw)
      if (!parsed.success) return
      const req = parsed.data
      const id = idOf(req)
      const pkt = deps.packet
      if (!pkt) {
        if (id !== null) send(fail(id, RpcErrorCode.InvalidRequest, 'packet TNC not available'))
        return
      }
      try {
        if (req.method === 'packet.status') {
          if (id !== null) send(ok(id, pkt.status))
        } else if (req.method === 'packet.setEnabled') {
          const p = z.object({ enabled: z.boolean() }).parse(req.params)
          const status = await (p.enabled ? pkt.enable() : pkt.disable())
          if (id !== null) send(ok(id, status))
        } else if (id !== null) {
          send(fail(id, RpcErrorCode.MethodNotFound, `method not found: ${req.method}`))
        }
      } catch (e) {
        if (id !== null) send(fail(id, RpcErrorCode.InternalError, (e as Error).message))
      }
    }

    const cleanup = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
      unsubscribeRec?.()
      unsubscribeTx?.()
      unsubscribePkt?.()
      void rtc?.then((s) => s.close()).catch(() => {})
      rtc = null
      // deadman: the socket that keyed the radio is gone — it can never send the release
      if (ptt.owner === socket) releasePtt('the transmitting page disconnected mid-PTT')
    }

    socket.on('message', (data: Buffer) => {
      let raw: unknown
      try {
        raw = JSON.parse(data.toString())
      } catch {
        send(fail(null, RpcErrorCode.ParseError, 'parse error'))
        return
      }
      const method = (raw as { method?: string }).method
      // PTT deadman bookkeeping: `ptt.hold` is the hold beacon (a notification — no response);
      // key/unkey claim/release deadman ownership on their way to the normal dispatch.
      if (method === 'ptt.hold') {
        if (ptt.owner === socket) ptt.lastHoldAt = Date.now()
        return
      }
      // PTT arbitration: while the packet TNC (direwolf) holds the transmitter, a browser PTT
      // must neither key over it nor RELEASE it mid-frame (unkey routes to the same radio).
      if ((method === 'ptt.key' || method === 'ptt.unkey') && deps.packet?.keyed) {
        send(fail(idOf(raw), RpcErrorCode.InvalidRequest, 'PTT is held by the packet TNC'))
        return
      }
      if (method === 'ptt.key') {
        ptt.owner = socket
        ptt.lastHoldAt = Date.now()
      } else if (method === 'ptt.unkey') {
        ptt.owner = null
      }
      if (typeof method === 'string' && method.startsWith('packet.')) {
        void handlePacket(raw)
        return
      }
      if (typeof method === 'string' && method.startsWith('rtc.')) {
        handleRtc(raw)
        return
      }
      if (typeof method === 'string' && method.startsWith('recordings.')) {
        void handleRecordings(raw)
        return
      }
      void dispatch(deps.controller, raw).then((response) => {
        // Augment link.stats at the API boundary with the downloadable wire capture — the pure
        // engine report is filesystem-free, so the wire path is injected here, never in dispatch().
        if (response && method === 'link.stats' && 'result' in response && response.result && typeof response.result === 'object') {
          ;(response.result as { wireCapture: unknown }).wireCapture = wireCaptureInfo(deps.wireCapture?.() ?? null)
        }
        if (response) send(response)
      })
    })
    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })

  // Download the current session's wire capture (link-stats dialog "Download" button). The path
  // is server-owned (never client input) so there's no traversal surface; served as an attachment
  // with the capture's own filename. 404 when logging is off or nothing's captured yet.
  if (deps.wireCapture) {
    const getWire = deps.wireCapture
    app.get(`${base}/wire/current`, async (_req, reply) => {
      const path = getWire()
      const info = wireCaptureInfo(path)
      if (!path || !info) return reply.code(404).send('no wire capture available')
      return reply
        .header('Content-Type', 'application/x-ndjson')
        .header('Content-Length', info.sizeBytes)
        .header('Content-Disposition', `attachment; filename="${info.filename}"`)
        .send(createReadStream(path))
    })
  }

  // Serve recorded clips as WAV downloads/playback sources (path-traversal guarded by wavPath).
  // Range support is REQUIRED: Safari/iOS <audio> refuses to play a source that doesn't advertise
  // Accept-Ranges + honour Range with a 206 (it shows a playback error instead) — the chunked,
  // Content-Length-less stream we sent before was exactly that failure.
  if (deps.recorder) {
    const rec = deps.recorder
    app.get(`${base}/recordings/:file`, async (req, reply) => {
      const file = (req.params as { file: string }).file.replace(/\.wav$/, '')
      const path = rec.wavPath(file)
      if (!path) return reply.code(400).send('bad id')
      let size: number
      try {
        size = (await stat(path)).size
      } catch {
        return reply.code(404).send('not found')
      }
      reply.header('Accept-Ranges', 'bytes').type('audio/wav')
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
      if (range) {
        let start = range[1] ? parseInt(range[1], 10) : 0
        let end = range[2] ? parseInt(range[2], 10) : size - 1
        if (Number.isNaN(start)) start = 0
        if (Number.isNaN(end) || end >= size) end = size - 1
        if (start > end || start >= size) {
          return reply.code(416).header('Content-Range', `bytes */${size}`).send()
        }
        return reply
          .code(206)
          .header('Content-Range', `bytes ${start}-${end}/${size}`)
          .header('Content-Length', end - start + 1)
          .send(createReadStream(path, { start, end }))
      }
      return reply.header('Content-Length', size).send(createReadStream(path))
    })
  }

  if (opts.viteRoot) {
    await registerViteDev(app, opts.viteRoot, base)
  } else if (opts.staticDir) {
    // Assets live under the mount prefix (`${base}/assets/…`) to match the Vite base the SPA was
    // built with; `prefix: '/'` when mounted at root.
    await app.register(fastifyStatic, { root: opts.staticDir, prefix: `${base}/`, wildcard: false })
    // SPA history fallback: any non-asset path serves the app shell.
    app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'))
  }

  return app
}

// Single-process dev: Vite in middleware mode (assets + HMR) behind Fastify, with an index.html
// catch-all. Vite is a dev-only dependency, imported dynamically so production never needs it.
async function registerViteDev(app: FastifyInstance, root: string, base: string): Promise<void> {
  const { createServer: createViteServer } = await import('vite')
  const vue = (await import('@vitejs/plugin-vue')).default
  const middie = (await import('@fastify/middie')).default
  await app.register(middie)
  const vite = await createViteServer({
    root,
    base: `${base}/`,
    appType: 'custom',
    plugins: [vue()],
    server: { middlewareMode: true },
  })
  app.use(vite.middlewares)
  app.get('/*', async (req, reply) => {
    const template = await readFile(join(root, 'index.html'), 'utf8')
    const html = await vite.transformIndexHtml(req.url, template)
    reply.type('text/html').send(html)
  })
}
