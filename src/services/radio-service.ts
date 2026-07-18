// RadioController — the top-level façade for the USER-DRIVEN connection flow. The backend is
// passive: it never auto-discovers or auto-connects. The UI drives scan → pair → pick → connect
// → disconnect; this object exposes exactly that, owns the transport+Session lifecycle for the
// life of one connection, and publishes a single AppState (connection status + the RadioState)
// for the broadcaster to fan out.
//
// Depends on narrow interfaces (RadioManager = what BtManager provides; AudioLink; a transport
// factory) so the whole lifecycle is unit-testable with fakes.

import type { AudioLink } from '../audio/types'
import type { RadioCandidate } from '../bluetooth/radio-select'
import type { AdapterInfo } from '../bluetooth/types'
import { initialState, type RadioState, type SideKey } from '../domain/state'
import type { Command, LinkConfig } from '../link/link'
import type { Transport } from '../transport/types'
import { ensureRadioReady, type ConnectableBt } from './connect'
import { Session, type ConnectOptions, type SessionEvents, type SessionPhase } from './session'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The slice of Session the controller drives — injectable so the lifecycle is testable
 * without re-driving the enumeration (covered by connect-session.test). */
export interface SessionLike {
  connect(opts?: ConnectOptions): Promise<void>
  close(): void
  key(): void
  unkey(immediate?: boolean): void
  noteTxMicActive?(active: boolean): void
  noteTxAudioFrame?(): void
  setSetting(name: string, value: string | number): void
  chooseSide(side: SideKey): void
  setVfoMode(side: SideKey, vfo: boolean): void
  stepChannel(side: SideKey, dir: 1 | -1): void
  stepZone(side: SideKey, dir: 1 | -1): void
  setChannelSetting(side: SideKey, key: string, value: string | number): void
  setChannelTone(side: SideKey, field: 'rx' | 'tx', type: 'off' | 'ctc' | 'dcs', value: number, inverted: boolean): void
  setFrequency(side: SideKey, field: 'rx' | 'tx', hz: number): void
  setVolume(side: SideKey, level: number): void
  listScanLists(force?: boolean): Promise<{ index: number; name: string }[]>
  startScan(side: SideKey, listIndex: number | null, listName: string | null): void
  stopScan(): void
  listChannels(side: SideKey): Promise<{ position: number; name: string }[]>
  selectChannel(side: SideKey, position: number): void
  listZones(force?: boolean): Promise<{ index: number; name: string }[]>
  listZoneChannels(zoneIndex: number, force?: boolean): Promise<{ position: number; name: string }[]>
  selectZoneChannel(side: SideKey, zoneIndex: number, position: number): void
  setManualDial(side: SideKey, target: number, callType: 'group' | 'private'): void
  clearManualDial(side: SideKey): void
  readonly metrics: { retransmits: number }
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'disconnecting'

/** Startup progress, shown while `connection === 'connecting'` (null otherwise). 'bluetooth' is the
 * link/pairing step the controller owns; the rest are the Session's enumeration steps. */
export type ConnectPhase = 'bluetooth' | SessionPhase

/** Link-health counters (NF5.1 observability) — the footer's R/F/I readout. */
export interface LinkMetrics {
  /** Commands re-sent after a timeout. */
  readonly retransmits: number
  /** Commands the ARQ gave up on (timeout + unsafe / out of attempts). */
  readonly failed: number
  /** Inbound packets discarded as unparseable (ARQ recovers reads; a burst is an RE signal). */
  readonly framingIncidents: number
}

/** One noteworthy link event, kept (bounded) for the footer's link-stats dialog. */
export interface LinkEvent {
  /** Wall-clock ISO timestamp (report is meant to be pasted elsewhere — absolute time). */
  readonly at: string
  readonly kind: 'retransmit' | 'failed' | 'framing'
  /** Human name of the command (op + register, e.g. "read 04 2c" / "COM MODE"). */
  readonly command?: string
  /** First bytes of the frame as hex, for wire-level correlation. */
  readonly frame?: string
  /** Retransmits: the attempt number this re-send was. */
  readonly attempt?: number
  /** Failures: why the ARQ gave up. */
  readonly reason?: string
  /** Framing incidents: the framer's diagnostic. */
  readonly detail?: string
}

/** The link-stats report served by `link.stats` — self-contained JSON for pasting into an issue. */
/** The diagnostics wire capture available for download (populated by the API layer, not the
 * engine — the pure engine never touches the filesystem). Null when wire logging is off or no
 * capture exists yet for this session. */
export interface WireCaptureInfo {
  readonly filename: string
  readonly sizeBytes: number
}

export interface LinkReport {
  readonly generatedAt: string
  readonly connection: ConnectionStatus
  readonly address: string | null
  readonly sessionStartedAt: string | null
  readonly metrics: LinkMetrics
  readonly linkConfig: LinkConfig
  readonly events: readonly LinkEvent[]
  /** Set by the API layer (see ServerDeps.wireCapture) — the current session's downloadable wire
   * capture, or null when logging is off / nothing captured yet. Absent from the raw engine report. */
  readonly wireCapture?: WireCaptureInfo | null
}

const LINK_EVENT_CAP = 200

/** Wire-protocol op → human name (for the link report; unknown ops render as hex). */
function describeCommand(command: Command): string {
  const op = command.op
  const hex = (n: number): string => n.toString(16).padStart(2, '0')
  if (op === 0x01) return 'COM MODE handshake'
  if (op === 0x04) return `read 04 ${command.reg != null ? hex(command.reg) : '??'}`
  if (op === 0x08) return `menu write 08 ${hex(command.frame[1] ?? 0)}`
  if (op === 0x2f) return `channel write 2f ${hex(command.frame[1] ?? 0)}`
  if (op === 0x56) return 'PTT / key 56'
  if (op === 0x57) return `feature write 57 ${hex(command.frame[1] ?? 0)}`
  if (op === 0x64) return 'COM CHECK END'
  return `op ${hex(op)}`
}

const frameHex = (frame: Uint8Array): string =>
  [...frame.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join(' ') + (frame.length > 12 ? ' …' : '')

export interface AppState {
  readonly connection: ConnectionStatus
  readonly address: string | null
  readonly error: string | null
  readonly phase: ConnectPhase | null
  readonly radio: RadioState
  readonly metrics: LinkMetrics
  /** FALSE while the RX audio capture (bluealsa/SCO path) has died unexpectedly and is being
   * auto-restarted — the UI banners it so dead capture is distinguishable from a quiet channel. */
  readonly rxAudioAlive: boolean
}

/** What the controller needs from the Bluetooth manager (BtManager satisfies this). */
export interface RadioManager extends ConnectableBt {
  scanForRadios(opts?: { timeoutMs?: number }): Promise<RadioCandidate[]>
  pairAddress(address: string): Promise<string>
  listRadios(): Promise<RadioCandidate[]>
  adapterInfo(): Promise<AdapterInfo>
  setTarget(address: string): void
  disconnectAcl(): Promise<void>
  forget(address: string): Promise<void>
}

export interface RadioControllerDeps {
  readonly bt: RadioManager
  readonly audio: AudioLink
  /** Create (and open) the byte transport for a connection. */
  readonly createTransport: (address: string, channel: number) => Transport
  readonly linkConfig: LinkConfig
  readonly now: () => number
  /** Default/fallback SPP RFCOMM channel when discovery yields nothing. */
  readonly channel?: number
  /** Resolve the SPP RFCOMM channel for an address (e.g. via SDP). Falls back to `channel` on
   * null/throw. Omitted → always use `channel`. */
  readonly resolveChannel?: (address: string) => Promise<number | null>
  /** Overall connect deadline; the in-flight connect aborts if exceeded (default 60s). */
  readonly connectDeadlineMs?: number
  /** Attempts at opening the control socket before giving up (default 3). The radio's SPP
   * service refuses connections for a few seconds after power-on even though pairing/HFP already
   * succeed — retrying here turns "SO_ERROR 111" into a working connect. */
  readonly transportAttempts?: number
  /** Delay between control-socket attempts (default 2000 ms). */
  readonly transportRetryMs?: number
  /** Diagnostics sink (framing incidents etc.); defaults to silent. */
  readonly log?: (message: string) => void
  /** Per-connect enumeration tuning passed to Session.connect(). */
  readonly connectOptions?: ConnectOptions
  /** Auto-reconnect on an unexpected drop (F1.3), with capped backoff. Off by default (tests);
   * production enables it. Cleared by an explicit disconnect(). */
  readonly reconnect?: boolean
  /** First reconnect backoff (ms, doubles per attempt up to reconnectMaxMs). Default 1000. */
  readonly reconnectBaseMs?: number
  /** Reconnect backoff ceiling (ms). Default 30000. */
  readonly reconnectMaxMs?: number
  /** Session factory (defaults to the real Session); injected in tests. */
  readonly createSession?: (
    transport: Transport,
    cfg: LinkConfig,
    now: () => number,
    events: SessionEvents,
  ) => SessionLike
  /** Resolve a DMR caller id → RadioID operator details (callsign/name/location). Injected so the
   * pure engine never touches the filesystem; wired to the RadioID DB in main.ts. */
  readonly resolveCaller?: (id: number) => { callsign: string | null; name: string | null; location: string | null } | null
}

export class RadioController {
  private status: ConnectionStatus = 'disconnected'
  private address: string | null = null
  private error: string | null = null
  private phase: ConnectPhase | null = null
  private radio: RadioState = initialState()
  /** Link-health counters accumulated across the current connection (reset on teardown). */
  private failed = 0
  private framingIncidents = 0
  /** Bounded per-event history behind the counters (the footer's link-stats dialog). */
  private linkEvents: LinkEvent[] = []
  private sessionStartedAt: number | null = null
  private session: SessionLike | null = null
  private transport: Transport | null = null
  private readonly listeners = new Set<(s: AppState) => void>()
  private readonly createSession: NonNullable<RadioControllerDeps['createSession']>
  /** Aborts the in-flight connect (deadline or an explicit disconnect); null when not connecting. */
  private connectCtl: AbortController | null = null
  /** The most recent teardown, so a following connect waits it out instead of racing its ACL drop. */
  private pendingTeardown: Promise<void> = Promise.resolve()
  /** Monotonic token invalidating late async continuations from an abandoned connect. */
  private generation = 0
  /** Auto-reconnect: the address to re-establish to (set on a successful connect, cleared by an
   * explicit disconnect); the pending backoff timer; and the attempt count for backoff growth. */
  private reconnectTarget: string | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0

  constructor(private readonly deps: RadioControllerDeps) {
    this.createSession = deps.createSession ?? ((t, c, n, e) => new Session(t, c, n, e))
  }

  get appState(): AppState {
    return {
      connection: this.status,
      address: this.address,
      error: this.error,
      phase: this.phase,
      radio: this.radio,
      metrics: { retransmits: this.session?.metrics.retransmits ?? 0, failed: this.failed, framingIncidents: this.framingIncidents },
      rxAudioAlive: this.rxAudioAlive,
    }
  }

  private rxAudioAlive = true
  /** RX capture liveness (wired from RxCapture.onAliveChange in main.ts) → AppState → UI banner. */
  setRxAudioAlive(alive: boolean): void {
    if (alive === this.rxAudioAlive) return
    this.rxAudioAlive = alive
    this.emit()
  }

  private recordLinkEvent(event: LinkEvent): void {
    this.linkEvents.push(event)
    if (this.linkEvents.length > LINK_EVENT_CAP) this.linkEvents.splice(0, this.linkEvents.length - LINK_EVENT_CAP)
  }

  /** Self-contained link diagnostics (served by `link.stats`; formatted for pasting elsewhere). */
  linkReport(): LinkReport {
    return {
      generatedAt: new Date(this.deps.now()).toISOString(),
      connection: this.status,
      address: this.address,
      sessionStartedAt: this.sessionStartedAt ? new Date(this.sessionStartedAt).toISOString() : null,
      metrics: this.appState.metrics,
      linkConfig: this.deps.linkConfig,
      events: [...this.linkEvents],
    }
  }

  private setPhase(phase: ConnectPhase | null): void {
    if (phase === this.phase) return
    this.phase = phase
    this.emit()
  }

  /** Subscribe to AppState changes; returns an unsubscribe fn. */
  onChange(fn: (s: AppState) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private emit(): void {
    const s = this.appState
    for (const fn of this.listeners) fn(s)
  }

  // ── discovery / pairing (request/response; no connection needed) ─────────────
  // Discovery (inquiry) and pair/forget starve the baseband and can stutter or drop a live SPP/HFP
  // link, so they are only allowed while fully disconnected. listRadios/adapterInfo are read-only
  // (no inquiry) and stay available.
  private requireIdle(op: string): void {
    if (this.status !== 'disconnected') throw new Error(`cannot ${op} while ${this.status}`)
  }
  scan(opts?: { timeoutMs?: number }): Promise<RadioCandidate[]> {
    this.requireIdle('scan')
    return this.deps.bt.scanForRadios(opts)
  }
  pair(address: string): Promise<string> {
    this.requireIdle('pair')
    return this.deps.bt.pairAddress(address)
  }
  forget(address: string): Promise<void> {
    this.requireIdle('forget')
    return this.deps.bt.forget(address)
  }
  listRadios(): Promise<RadioCandidate[]> {
    return this.deps.bt.listRadios()
  }
  adapterInfo(): Promise<AdapterInfo> {
    return this.deps.bt.adapterInfo()
  }

  // ── connection lifecycle (user-driven) ──────────────────────────────────────
  async connect(address: string): Promise<void> {
    await this.pendingTeardown // never overlap a prior teardown's ACL drop with a fresh connect
    if (this.status !== 'disconnected') throw new Error(`cannot connect while ${this.status}`)
    const generation = ++this.generation

    const deadlineMs = this.deps.connectDeadlineMs ?? 60000
    const ctl = new AbortController()
    this.connectCtl = ctl
    const timer = setTimeout(() => ctl.abort(new Error(`connect timed out after ${deadlineMs}ms`)), deadlineMs)
    const { signal } = ctl
    // Reject the moment the connect is aborted (deadline or an explicit disconnect) — raced against
    // each phase so a hung BlueZ/HFP call is actually interrupted, not just checked between phases.
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, aborted])

    this.error = null
    this.setStatus('connecting', address)
    this.setPhase('bluetooth')
    try {
      this.deps.bt.setTarget(address)
      await race(ensureRadioReady(this.deps.bt, this.deps.audio, { signal }))
      this.assertCurrent(generation, signal)
      const channel = await race(this.resolveChannel(address))
      this.assertCurrent(generation, signal)

      const transport = await race(this.openTransport(address, channel, signal))
      this.transport = transport
      this.assertCurrent(generation, signal)
      transport.onClose(() => this.onDrop())
      this.sessionStartedAt = this.deps.now()
      const session = this.createSession(transport, this.deps.linkConfig, this.deps.now, {
        ...(this.deps.resolveCaller ? { resolveCaller: this.deps.resolveCaller } : {}),
        onState: (st) => {
          this.radio = st
          this.emit()
        },
        onPhase: (p: SessionPhase) => this.setPhase(p),
        onFramingIncident: (detail) => {
          this.framingIncidents += 1
          this.recordLinkEvent({ at: new Date(this.deps.now()).toISOString(), kind: 'framing', detail })
          this.deps.log?.(`framing: ${detail}`)
          this.emit() // surface the metric bump on the state stream
        },
        // A command the ARQ gave up on is the earliest sign of a degrading link — it must be
        // visible in a long-run log even though the UI may show nothing (e.g. a refresh read).
        onFailed: (command, reason) => {
          this.failed += 1
          this.recordLinkEvent({
            at: new Date(this.deps.now()).toISOString(),
            kind: 'failed',
            command: describeCommand(command),
            frame: frameHex(command.frame),
            reason,
          })
          this.deps.log?.(`command 0x${command.op.toString(16)} failed (${reason})`)
          this.emit()
        },
        onRetransmit: (command, attempt) => {
          this.recordLinkEvent({
            at: new Date(this.deps.now()).toISOString(),
            kind: 'retransmit',
            command: describeCommand(command),
            frame: frameHex(command.frame),
            attempt,
          })
        },
        onPttFailsafe: (detail) => void this.pttFailsafe(detail),
        // Radio-pushed notifications (5f family) surface on the same dismissible banner as other
        // operational errors — a remote operator must know their TX never woke the repeater.
        onRadioNotice: (text) => {
          this.error = text
          this.deps.log?.(`radio notice: ${text}`)
          this.emit()
        },
      })
      this.session = session
      await race(session.connect(this.deps.connectOptions))
      this.assertCurrent(generation, signal)
      this.setPhase(null)
      this.setStatus('connected', address)
      // Arm auto-reconnect for this address (a later unexpected drop re-establishes it).
      this.reconnectTarget = address
      this.reconnectAttempt = 0
      this.deps.log?.(`connected ${address} (SPP channel ${channel})`)
    } catch (e) {
      await (this.pendingTeardown = this.teardown())
      // Surface the abort reason (deadline / disconnect) rather than the raw AbortError.
      this.error = signal.aborted ? errMsg(signal.reason) : errMsg(e)
      this.setStatus('disconnected', null)
      this.deps.log?.(`connect ${address} failed: ${this.error}`)
      throw e
    } finally {
      clearTimeout(timer)
      this.connectCtl = null
    }
  }

  async disconnect(): Promise<void> {
    this.cancelReconnect() // an explicit disconnect ends the reconnect intent
    // Interrupt an in-flight connect: abort it and let its own catch unwind the teardown.
    if (this.status === 'connecting' && this.connectCtl) {
      this.generation += 1
      this.connectCtl.abort(new Error('disconnect requested'))
      await this.pendingTeardown
      return
    }
    if (this.status === 'disconnected' || this.status === 'disconnecting') return
    // DISCONNECTING is a real, user-visible phase: the teardown (session close, SPP socket, BT
    // ACL drop) takes seconds, and reporting 'disconnected' only when it's DONE lets the UI grey
    // out the last-known state instead of lying that the link is already down. It also makes
    // onDrop (fired by our own transport close) a no-op via its 'connected'-only guard, and
    // blocks a concurrent connect() until the teardown finished.
    this.setStatus('disconnecting', this.address)
    await (this.pendingTeardown = this.teardown())
    this.error = null
    this.setStatus('disconnected', null)
    this.deps.log?.('disconnected (requested)')
  }

  private cancelReconnect(): void {
    this.reconnectTarget = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /** Open the SPP control socket with a bounded retry. A radio fresh off power-on (or with its
   * BT stack still settling) REFUSES the first attempt(s) — ECONNREFUSED / "SO_ERROR 111" — and
   * accepts a couple of seconds later, so a single try punished the user for the radio's boot
   * time. Abort-aware between attempts (the connect deadline / an explicit disconnect stops the
   * retries); the LAST error is the one surfaced when every attempt fails. */
  private async openTransport(address: string, channel: number, signal: AbortSignal): Promise<Transport> {
    const attempts = Math.max(1, this.deps.transportAttempts ?? 3)
    const retryMs = this.deps.transportRetryMs ?? 2000
    let lastErr: unknown = new Error('control socket never attempted')
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted'))
      try {
        const transport = this.deps.createTransport(address, channel)
        if (signal.aborted) {
          // aborted while the socket was being established — never leak a connected fd
          try {
            transport.close()
          } catch {
            /* ignore */
          }
          throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted'))
        }
        if (attempt > 1) this.deps.log?.(`control socket connected on attempt ${attempt}/${attempts}`)
        return transport
      } catch (e) {
        if (signal.aborted) throw e
        lastErr = e
        this.deps.log?.(`control socket attempt ${attempt}/${attempts} failed: ${errMsg(e)}`)
        if (attempt < attempts) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              signal.removeEventListener('abort', onAbort)
              resolve()
            }, retryMs)
            const onAbort = (): void => {
              clearTimeout(timer)
              resolve() // the aborted check at the top of the next iteration surfaces the reason
            }
            signal.addEventListener('abort', onAbort, { once: true })
          })
        }
      }
    }
    throw lastErr
  }

  /** Resolve the SPP RFCOMM channel for this connect, falling back to the configured default. */
  private async resolveChannel(address: string): Promise<number> {
    const fallback = this.deps.channel ?? 2
    if (!this.deps.resolveChannel) return fallback
    try {
      const ch = await this.deps.resolveChannel(address)
      return ch && ch >= 1 && ch <= 30 ? ch : fallback
    } catch {
      return fallback
    }
  }

  // ── live ops (require an active connection) ──────────────────────────────────
  key(): void {
    this.requireSession().key()
  }
  /** `immediate` (deadman / socket loss) bypasses the TX audio drain — see Session.unkey. */
  unkey(immediate = false): void {
    this.requireSession().unkey(immediate)
  }
  /** TX mic stream attached/detached (rtc.mic) — arms the session's keyed-but-silent guard. */
  setTxMicActive(active: boolean): void {
    this.session?.noteTxMicActive?.(active)
  }
  /** Every downsampled TX mic frame (audio-bridge tee) — pipe-latency probe + guard liveness. */
  noteTxAudioFrame(): void {
    this.session?.noteTxAudioFrame?.()
  }
  setSetting(name: string, value: string | number): void {
    this.requireSession().setSetting(name, value)
  }
  chooseSide(side: SideKey): void {
    this.requireSession().chooseSide(side)
  }
  setVfoMode(side: SideKey, vfo: boolean): void {
    this.requireSession().setVfoMode(side, vfo)
  }
  stepChannel(side: SideKey, dir: 1 | -1): void {
    this.requireSession().stepChannel(side, dir)
  }
  stepZone(side: SideKey, dir: 1 | -1): void {
    this.requireSession().stepZone(side, dir)
  }
  setChannelSetting(side: SideKey, key: string, value: string | number): void {
    this.requireSession().setChannelSetting(side, key, value)
  }
  setChannelTone(side: SideKey, field: 'rx' | 'tx', type: 'off' | 'ctc' | 'dcs', value: number, inverted: boolean): void {
    this.requireSession().setChannelTone(side, field, type, value, inverted)
  }
  setFrequency(side: SideKey, field: 'rx' | 'tx', hz: number): void {
    this.requireSession().setFrequency(side, field, hz)
  }

  setVolume(side: SideKey, level: number): void {
    this.requireSession().setVolume(side, level)
  }
  listScanLists(force?: boolean): Promise<{ index: number; name: string }[]> {
    return this.requireSession().listScanLists(force)
  }
  startScan(side: SideKey, listIndex: number | null, listName: string | null): void {
    this.requireSession().startScan(side, listIndex, listName)
  }
  stopScan(): void {
    this.requireSession().stopScan()
  }
  listChannels(side: SideKey): Promise<{ position: number; name: string }[]> {
    return this.requireSession().listChannels(side)
  }
  selectChannel(side: SideKey, position: number): void {
    this.requireSession().selectChannel(side, position)
  }
  listZones(force?: boolean): Promise<{ index: number; name: string }[]> {
    return this.requireSession().listZones(force)
  }
  listZoneChannels(zoneIndex: number, force?: boolean): Promise<{ position: number; name: string }[]> {
    return this.requireSession().listZoneChannels(zoneIndex, force)
  }
  selectZoneChannel(side: SideKey, zoneIndex: number, position: number): void {
    this.requireSession().selectZoneChannel(side, zoneIndex, position)
  }
  setManualDial(side: SideKey, target: number, callType: 'group' | 'private'): void {
    this.requireSession().setManualDial(side, target, callType)
  }
  clearManualDial(side: SideKey): void {
    this.requireSession().clearManualDial(side)
  }

  private requireSession(): SessionLike {
    if (this.status !== 'connected' || !this.session) throw new Error('not connected')
    return this.session
  }

  /** SAFETY NOTE from the UI deadman: PTT was force-released because the transmitting page went
   * silent (connection lost / tab frozen) — record WHY on AppState.error so it rides every
   * state.snapshot; a client loading the page later still sees it (until dismissed / next connect). */
  notePttDeadman(detail: string): void {
    this.error = `PTT was force-released: ${detail}.`
    this.deps.log?.(`PTT DEADMAN: ${detail}`)
    this.emit()
  }

  /** Clear the persistent error banner (the UI's ✕). */
  clearError(): void {
    if (this.error === null) return
    this.error = null
    this.emit()
  }

  private setStatus(status: ConnectionStatus, address: string | null): void {
    this.status = status
    this.address = address
    if (status !== 'connecting') this.phase = null // phase only meaningful mid-connect
    this.emit()
  }

  private assertCurrent(generation: number, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted'))
    if (generation !== this.generation) throw new Error('connect superseded')
  }

  /** SAFETY: the radio stopped acknowledging PTT and ~10 s of release retransmits went
   * unanswered. Sever Bluetooth entirely — the radio ends PTT when remote control deactivates —
   * exactly as if the user hit Disconnect: the reconnect intent is cancelled (never silently
   * re-establish into a radio that just ignored a release), and the error PERSISTS on AppState so
   * every websocket client — including one that loads the page later — sees it in its
   * state.snapshot until the next connect clears it. */
  private async pttFailsafe(detail: string): Promise<void> {
    if (this.status !== 'connected') return
    this.deps.log?.(`PTT FAILSAFE: ${detail} — severing Bluetooth to force the transmitter to release`)
    this.cancelReconnect()
    await (this.pendingTeardown = this.teardown())
    this.error =
      `PTT failsafe: ${detail}. Bluetooth was disconnected to force the radio to stop transmitting — ` +
      'verify the radio is no longer keyed, then reconnect.'
    this.setStatus('disconnected', null)
  }

  /** Unexpected transport close while up → drop to disconnected. Records the teardown promise so a
   * reconnect awaits the ACL drop instead of racing it, then (if the reconnect policy is on and we
   * weren't deliberately disconnected) schedules a capped-backoff re-establish (F1.3). */
  private onDrop(): void {
    // 'disconnecting' = OUR teardown closed the transport — the explicit disconnect() owns the
    // status transition and there's nothing unexpected to report or reconnect to.
    if (this.status === 'disconnected' || this.status === 'disconnecting') return
    this.pendingTeardown = this.teardown()
    this.error = 'radio link dropped'
    this.setStatus('disconnected', null)
    this.deps.log?.('radio link dropped — disconnected (unexpected transport close)')
    if (this.deps.reconnect && this.reconnectTarget) this.scheduleReconnect()
  }

  /** Schedule the next reconnect attempt with capped exponential backoff. Idempotent (one timer). */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.reconnectTarget) return
    const base = this.deps.reconnectBaseMs ?? 1000
    const max = this.deps.reconnectMaxMs ?? 30000
    const delay = Math.min(base * 2 ** this.reconnectAttempt, max)
    this.reconnectAttempt += 1
    this.deps.log?.(`reconnect scheduled in ${delay}ms (attempt ${this.reconnectAttempt})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.attemptReconnect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private async attemptReconnect(): Promise<void> {
    const target = this.reconnectTarget
    if (!target || this.status !== 'disconnected') return // disconnected by the user, or already up
    await this.pendingTeardown // never race the prior ACL drop
    if (this.reconnectTarget !== target || this.status !== 'disconnected') return
    try {
      await this.connect(target) // success resets reconnectAttempt + re-arms reconnectTarget
    } catch {
      // connect() already tore down + set disconnected; keep trying while the intent stands.
      if (this.reconnectTarget === target) this.scheduleReconnect()
    }
  }

  private async teardown(): Promise<void> {
    this.session?.close()
    this.session = null
    try {
      this.transport?.close()
    } catch {
      /* ignore */
    }
    this.transport = null
    this.radio = initialState()
    this.failed = 0
    this.framingIncidents = 0
    this.linkEvents = []
    this.sessionStartedAt = null
    try {
      await this.deps.bt.disconnectAcl()
    } catch {
      /* best effort */
    }
  }
}
