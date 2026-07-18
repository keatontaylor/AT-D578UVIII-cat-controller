// Session — the orchestrator that wires the stack together (ARCHITECTURE services layer):
// transport bytes → link (framing/ARQ/demux) → reducer → the one RadioState. Holds the
// authoritative state, exposes command submission, and forwards lifecycle events. Depends
// downward only (transport/link/domain); knows nothing of api/ui.

import { setTimeout as delay } from 'node:timers/promises'
import {
  channelSelect,
  comCheckEnd,
  comMode,
  manualDialPtt,
  pttKey,
  pttUnkey,
  readChannelName,
  readRegister,
  readZoneName,
  readScanList,
  readZoneChannels,
  rxFrequencyWrite,
  scanSelect,
  scanStartStop,
  selectSide as selectSideCmd,
  settingWrite,
  txFrequencyWrite,
  vfoMemoryMode,
  wake,
  zoneSelect,
  volumeWrite,
} from '../codec/commands'
import { CHANNEL_SETTINGS_BY_KEY, channelSettingWrite } from '../codec/channel-settings'
import { channelToneWrite, toneLabel, type ToneField, type ToneType } from '../codec/tones'
import type { DecodedFrame } from '../codec/framing'
import { settingByName } from '../codec/settings-table'
import { nextPttPhase } from '../domain/ptt'
import { decodeChannelName, decodeScanListName, decodeZoneBrowseName, decodeZoneChannelCount, decodeZoneChannelMembers } from '../codec/decode'
import { hexStrToBytes } from '../codec/record'
import { applyEvent, type DomainEvent } from '../domain/reduce'
import { activeReceive, audioGateOpen } from '../domain/receive'
import { isTransmitting } from '../domain/view'
import { initialState, type RadioState, type SideKey } from '../domain/state'
import { LinkLayer, type Command, type FailReason, type LinkConfig, type SubmitOptions } from '../link/link'
import type { Transport } from '../transport/types'

/** Canonical startup enumeration (mode 0x07): firmware, settings 05/06/09, zone count (1b),
 * zones, channels, status, clock, signal/DMR snapshots — the reads that populate a full
 * RadioState. 0x59 (the persisted last-call record) is read AFTER 0x5e deliberately: its
 * reducer case enriches the dmr slice the 5e read just populated (an ongoing call at connect
 * gets its talker id + alias immediately, not on the next 58 push). */
export const ENUMERATION_REGISTERS: readonly number[] = [
  0x02, 0x05, 0x06, 0x09, 0x1b, 0x29, 0x2a, 0x2c, 0x2d, 0x4d, 0x4e, 0x51, 0x5a, 0x5b, 0x5e, 0x59,
]

export interface ConnectOptions {
  readonly enumeration?: readonly number[]
  readonly readMode?: number
  readonly wakeCount?: number
  readonly wakeDelayMs?: number
  /** How many times to attempt the required HANDSHAKE before giving up (default 2). The first
   * COM_MODE probe is flaky by design (the radio is waking), so one clean retry recovers most
   * failures; exhausting them throws a StartupError the controller surfaces to the user. */
  readonly startupAttempts?: number
}

/** The required startup handshake failed after all attempts — the radio never entered COM mode
 * (no response to COM_MODE and no reply to the firmware proof read). Thrown by connect() so the
 * controller can surface a clean, retryable error instead of reporting a hollow "connected" whose
 * enumeration silently got nothing. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StartupError'
  }
}

/** The firmware-id register — read as the handshake PROOF: a reply confirms the radio is in COM
 * mode (and populates identity); repeated timeout means it never entered it. */
const HANDSHAKE_PROOF_REGISTER = 0x02
/** Bounded attempts for the proof read: comMode is one-shot (not retransmit-safe), so this read
 * is the gate's real cost — keep it short (~a few seconds) so a retry stays within the deadline. */
const HANDSHAKE_PROOF_ATTEMPTS = 3

/** Coarse startup steps the Session reports during connect(), for UI progress display. */
export type SessionPhase = 'handshake' | 'info' | 'settings' | 'channels' | 'status'

export interface SessionEvents {
  /** Fired after every state mutation. */
  onState?(state: RadioState): void
  /** Startup progress step (during connect()). */
  onPhase?(phase: SessionPhase): void
  /** A submitted command completed. */
  onResolved?(command: Command, response: DecodedFrame): void
  /** A submitted command gave up. */
  onFailed?(command: Command, reason: FailReason): void
  /** A command was re-sent after a timeout (observability — which frames needed the ARQ). */
  onRetransmit?(command: Command, attempt: number): void
  /** An inbound packet was discarded as unparseable (diagnostics; ARQ handles recovery). */
  onFramingIncident?(detail: string): void
  /** A user-facing notification pushed by the radio (the 5f family — the same popups the
   * BT-01 head displays, e.g. "repeater not found" after an unanswered DMR wake-up). */
  onRadioNotice?(text: string): void
  /** SAFETY: the radio stopped acknowledging PTT and every release attempt (~10 s of unkey
   * retransmits) went unanswered. The listener must tear the Bluetooth link down entirely — the
   * radio treats remote-control deactivation as PTT release, so a dead link is the one remaining
   * way to guarantee the transmitter stops. */
  onPttFailsafe?(detail: string): void
  /** Resolve a DMR caller id → RadioID.net operator details (callsign/name/location), or null.
   * Injected (the CSV lives server-side) so the reducer stays pure — the session feeds the result
   * back through a `dmrCaller` domain event. */
  resolveCaller?(id: number): { callsign: string | null; name: string | null; location: string | null } | null
}

/** Which startup step an enumeration register belongs to (drives connect progress). */
function phaseForRegister(reg: number): SessionPhase {
  if (reg === 0x05 || reg === 0x06 || reg === 0x09 || reg === 0x1b) return 'settings'
  if (reg === 0x29 || reg === 0x2a || reg === 0x2c || reg === 0x2d) return 'channels'
  if (reg === 0x02) return 'info'
  return 'status'
}

/** PTT command head — the only op `key`/`unkey` submit, so any 56 outcome is a PTT outcome. */
const PTT_OP = 0x56
/** Key-down attempt cap: initial send + 2 retransmits (~2 s at the production 1 s timeout) —
 * enough to punch through the radio's mid-RX busy-gate, far short of a read's 10 attempts. */
const KEY_MAX_ATTEMPTS = 3
/** Release-drain hard cap: even a TURN-bloated pipe never holds the transmitter past this after
 * release (parrot-measured pipe latency: LAN 0.4–0.7 s, TURN 1.5–3 s). */
const TX_DRAIN_CAP_MS = 3000
/** Drain END detection: the browser stops its track AT release, so the RTP counter freezes once
 * the last in-flight audio has arrived — frozen for this long = the tail is fully drained.
 * (Two 200 ms poll periods; parrot-measured 2026-07-18: a key-time point measurement under-drained
 * long overs by 360–420 ms because the pipe DRIFTS during a transmission.) */
const TX_DRAIN_QUIET_MS = 400
/** Keyed with a mic EXPECTED but no TX audio arriving for this long → the audio path died
 * (never a quiet operator — the browser streams comfort noise while capturing): force-release
 * rather than transmit dead air. */
const TX_SILENCE_GUARD_MS = 2500
/** Settings-write head. */
const SETTING_OP = 0x08
/** Per-channel setting-write head (2f family). */
const CHANNEL_OP = 0x2f
/** How long the squelch must stay open during a scan before we treat it as a real lock (not a
 * mid-hop graze) and read the locked channel. Matches the BT-01's ~1s dwell confirm. */
const SCAN_LOCK_CONFIRM_MS = 1000
/** Cap on the post-unkey RELEASE DRAIN (hold `unkeying` until the radio's own TX indications
 * clear — the DMR terminator runs ~0.5 s past the ack, wire-measured 451/625 ms 2026-07-13). If
 * the end-of-call push never arrives (5e decode dropout), go idle anyway: the release WAS acked,
 * and a stale dmr slice must not wedge the yellow state. */
const PTT_DRAIN_CAP_MS = 2000

export class Session {
  private current: RadioState = initialState()
  private readonly link: LinkLayer
  // Every menu write shares the 0x08 head and a generic `03 08` ack (no sub-op), so setting writes,
  // side-select (08 19) and zone-select (08 39) are correlated by Command IDENTITY — each carries
  // an apply-outcome closure keyed by its Command. (Counting acks mis-attributed one op's ack to
  // another still-queued op.)
  private readonly pending08 = new Map<Command, (event: 'acked' | 'failed') => void>()
  // An 0x08 outcome that arrived before its map entry existed — i.e. the ack resolved synchronously
  // inside link.submit() (fake transports do this). Claimed by submit08 on return.
  private sync08: { command: Command; event: 'acked' | 'failed' } | null = null
  // Same correlation for per-channel setting writes (0x2f family, acked `03 2f`).
  private readonly pending2f = new Map<Command, (event: 'acked' | 'failed') => void>()
  private sync2f: { command: Command; event: 'acked' | 'failed' } | null = null
  /** The operator released while the key-down was still unacked — release as soon as it lands. */
  private releaseAfterKey = false
  // Promise-completion for submitAndWait. `settled` catches a command that resolves
  // synchronously inside link.submit() before the waiter is registered.
  private readonly waiters = new Map<Command, { resolve: (f: DecodedFrame) => void; reject: (e: Error) => void }>()
  private readonly settled = new Map<Command, { response: DecodedFrame | null; error: Error | null }>()
  private sideReady: { side: SideKey; promise: Promise<void> } | null = null
  // 5a data (push AND `04 5a` read) is selected-side-RELATIVE. Sitting-1 measurement
  // (2026-07-03, 17 swaps): after the 08 19 ack the radio SUSPENDS pushes for ~900ms and
  // resumes already in the new frame of reference — it never emits ambiguous pushes; only
  // reads inside ~1s return stale (old-reference) data. We issue no post-swap reads, so this
  // hold mainly covers pre-swap pushes still in flight at the flip; 1000ms brackets the
  // measured pause with margin at negligible cost (the meter freezes on known truth).
  private suppress5aUntil = 0
  private static readonly SIDE_SETTLE_MS = 1000
  private ticker: ReturnType<typeof setInterval> | null = null
  private liveReadMode = 0x07

  constructor(
    transport: Transport,
    cfg: LinkConfig,
    private readonly now: () => number,
    private readonly events: SessionEvents = {},
  ) {
    this.link = new LinkLayer(
      cfg,
      {
        write: (bytes) => transport.write(bytes),
        inbound: (frame) => this.apply(frame),
        resolved: (command, response) => {
          this.settleWaiter(command, response, null)
          this.onPttOutcome(command, 'acked')
          this.on08Outcome(command, 'acked')
          this.on2fOutcome(command, 'acked')
          this.events.onResolved?.(command, response)
        },
        failed: (command, reason) => {
          this.settleWaiter(command, null, new Error(`command 0x${command.op.toString(16)} ${reason}`))
          this.onPttOutcome(command, 'failed')
          this.on08Outcome(command, 'failed')
          this.on2fOutcome(command, 'failed')
          this.events.onFailed?.(command, reason)
        },
        retransmitted: (command, attempt) => this.events.onRetransmit?.(command, attempt),
        framingIncident: (error, discarded) => this.onFramingIncident(error.message, discarded, now()),
      },
      now,
    )
    transport.onData((chunk) => this.link.receiveBytes(chunk))
  }

  // Recent framing-incident timestamps — a tripwire, not a trigger. One garble per ~36k frames is
  // the corpus-measured radio hiccup; a rapid burst is something new (e.g. an unknown push the
  // radio keeps re-sending because it wants an ack we don't know about) and deserves a loud log
  // with the bytes so it becomes an RE target. We never reset the link over it.
  private framingIncidentsAt: number[] = []
  private static readonly INCIDENT_WINDOW_MS = 10_000
  private static readonly INCIDENT_BURST = 3

  private onFramingIncident(message: string, discarded: Uint8Array, at: number): void {
    const hex = Array.from(discarded, (b) => b.toString(16).padStart(2, '0')).join(' ')
    this.framingIncidentsAt = this.framingIncidentsAt.filter((t) => at - t < Session.INCIDENT_WINDOW_MS)
    this.framingIncidentsAt.push(at)
    const burst = this.framingIncidentsAt.length >= Session.INCIDENT_BURST
    this.events.onFramingIncident?.(
      burst
        ? `REPEATED framing incidents (${this.framingIncidentsAt.length} in ${Session.INCIDENT_WINDOW_MS / 1000}s) — ` +
          `possible unknown radio push needing an ack; capture for RE: ${message}; discarded [${hex}]`
        : `discarded unparseable packet (${message}) [${hex}] — ARQ will retransmit any affected read`,
    )
  }

  /** The current authoritative state. */
  /** Link-health counters read by the controller for the metrics slice. */
  get metrics(): { retransmits: number } {
    return { retransmits: this.link.retransmits }
  }

  get state(): RadioState {
    return this.current
  }

  /** Whether a command is currently in flight. */
  get busy(): boolean {
    return this.link.busy
  }

  /** Queue a command (read or write) for the radio. */
  submit(frame: Uint8Array, opts?: SubmitOptions): Command {
    return this.link.submit(frame, opts)
  }

  /** Submit a command and resolve when it completes (or reject when it gives up / the session
   * closes). Rejects immediately on a closed session so callers (e.g. an abandoned connect()
   * enumeration after teardown) unwind instead of awaiting forever. */
  submitAndWait(frame: Uint8Array, opts?: SubmitOptions): Promise<DecodedFrame> {
    if (this.closed) return Promise.reject(new Error('session closed'))
    return new Promise<DecodedFrame>((resolve, reject) => {
      const command = this.link.submit(frame, opts)
      const pre = this.settled.get(command) // resolved synchronously inside submit()?
      if (pre) {
        this.settled.delete(command)
        if (pre.error) reject(pre.error)
        else resolve(pre.response!)
        return
      }
      this.waiters.set(command, { resolve, reject })
    })
  }

  /** Run the startup sequence against the radio: (GATED) wake → COM_MODE → firmware-proof read,
   * then (best-effort) the enumeration reads → COM_CHECK_END (enable the push stream). Builds a
   * full RadioState. The HANDSHAKE is a hard gate — it retries and, on exhaustion, throws a
   * StartupError so we never proceed into a hollow connect; the enumeration stays best-effort (a
   * missed settings/channel read degrades the display but doesn't invalidate the link). Starts
   * the ARQ ticker. */
  async connect(opts: ConnectOptions = {}): Promise<void> {
    this.startTicker()
    const mode = opts.readMode ?? 0x07
    this.liveReadMode = mode
    const maxAttempts = Math.max(1, opts.startupAttempts ?? 2)

    // HANDSHAKE GATE (required, retried): without COM mode nothing downstream is valid, so a
    // failure here aborts the connect rather than enumerating into emptiness. The first COM_MODE
    // probe is flaky by design (radio waking) — a fresh wake+probe usually lands, so retry the
    // whole handshake before surfacing the error.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.handshake(opts, mode)
        break
      } catch (e) {
        if (e instanceof StartupError && !this.closed && attempt < maxAttempts) continue
        throw e
      }
    }

    // ENUMERATION (best-effort): the firmware register was already read as the handshake proof.
    let phase: SessionPhase = 'info'
    for (const reg of opts.enumeration ?? ENUMERATION_REGISTERS) {
      if (reg === HANDSHAKE_PROOF_REGISTER) continue
      const p = phaseForRegister(reg)
      if (p !== phase) this.events.onPhase?.((phase = p))
      await this.submitAndWait(readRegister(reg, mode)).catch(() => undefined)
    }
    await this.submitAndWait(comCheckEnd()).catch(() => undefined)
    // The zone reads (04 29/2a) set each side's zoneNumber; fetch each side's channel count from
    // that zone's 04 27 member list (any zone by index, no navigation). Fire-and-forget — this is
    // enrichment, not part of the connect gate (stepChannel falls back to the radio's own wrap
    // until the count lands).
    for (const side of ['a', 'b'] as SideKey[]) {
      const zone = this.current.sides[side].zoneNumber
      if (zone != null) void this.readChannelCount(side, zone)
    }
  }

  /** The REQUIRED handshake: wake pulses → COM_MODE ×2 → prove COM mode by reading the firmware
   * id. COM_MODE (0x01) is not retransmit-safe (one shot each; the first is flaky by design), so
   * the bounded firmware read is the real proof — a reply means we're in COM mode (and populates
   * identity); repeated timeout means the radio never entered it → StartupError. Re-fires the
   * 'handshake' phase each call, so a retry visibly bounces the connect stepper back. */
  private async handshake(opts: ConnectOptions, mode: number): Promise<void> {
    this.events.onPhase?.('handshake')
    const wakeDelayMs = opts.wakeDelayMs ?? 120
    for (let i = 0; i < (opts.wakeCount ?? 3); i += 1) {
      this.sendRaw(wake())
      if (wakeDelayMs > 0) await delay(wakeDelayMs)
    }
    await this.submitAndWait(comMode()).catch(() => undefined)
    await this.submitAndWait(comMode()).catch(() => undefined)
    this.events.onPhase?.('info')
    const proven = await this.submitAndWait(readRegister(HANDSHAKE_PROOF_REGISTER, mode), {
      maxAttempts: HANDSHAKE_PROOF_ATTEMPTS,
    })
      .then(() => true)
      .catch(() => false)
    if (!proven) throw new StartupError('the radio did not enter COM mode — check it is on and in range, then try again')
  }

  /** Read a zone's channel count (04 27 member list) and store it on `side`. submitAndWait
   * guarantees we get the reply to THIS request, so the (self-anonymous) 04 27 reply is correctly
   * attributed. Best-effort — a miss just leaves channelCount as-is. */
  private async readChannelCount(side: SideKey, zoneIndex: number): Promise<void> {
    const reply = await this.submitAndWait(readZoneChannels(zoneIndex)).catch(() => null)
    if (!reply) return
    const count = decodeZoneChannelCount(reply.bytes)
    if (count != null && count > 0) this.dispatch({ kind: 'channelCount', side, count })
  }

  // ── update contract (mimics the BT-01) ───────────────────────────────────────
  // WRITES TAKE THE RADIO'S ACK AS GOSPEL. A `03 <op>` ack means the change happened; we update
  // RadioState optimistically and DO NOT issue a confirming re-read (settings via the device
  // shadow, side-select via selectedSide, etc.). The BT-01 does the same — its side-swap capture
  // shows `08 19` → ack → poll of 04 5a/04 5e (live status) only, never the channel block.
  //
  // NO POLLING, NO REFRESH. The smeter/link status streams to us as 5a/5e pushes; the idle wire
  // carries only our push-acks. Every state mutation is either pushed by the radio or the direct
  // result of a user action (a channel step returns the new block; a zone step / channel-setting
  // write re-reads once on its ack; a side swap / menu write is optimistic, ACK = gospel).

  /** Drive ARQ timeouts + queue pumping; call periodically (or rely on the internal ticker). */
  tick(): void {
    this.link.tick()
  }

  /** Start the internal ARQ ticker (idempotent). connect() starts it automatically. */
  startTicker(intervalMs = 50): void {
    if (this.ticker) return
    this.ticker = setInterval(() => this.tick(), intervalMs)
    this.ticker.unref?.()
  }

  private closed = false

  /** Stop the internal ticker and reject outstanding waiters — a torn-down session must never
   * leave a submitAndWait (e.g. mid-enumeration) awaiting forever. */
  close(): void {
    this.closed = true
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    if (this.dmrLockTimer !== null) {
      clearTimeout(this.dmrLockTimer)
      this.dmrLockTimer = null
    }
    if (this.txDrainTimer) {
      clearInterval(this.txDrainTimer)
      this.txDrainTimer = null
    }
    this.disarmSilenceGuard()
    const err = new Error('session closed')
    for (const w of this.waiters.values()) w.reject(err)
    this.waiters.clear()
    this.settled.clear()
  }

  private settleWaiter(command: Command, response: DecodedFrame | null, error: Error | null): void {
    const w = this.waiters.get(command)
    if (w) {
      this.waiters.delete(command)
      if (error) w.reject(error)
      else w.resolve(response!)
      return
    }
    // Resolved before submitAndWait could register (synchronously inside submit()). The entry is
    // only claimable on the submit caller's own stack, so drop it on the next microtask — plain
    // submit() commands (side-select, one-shot reads) must not accumulate here.
    this.settled.set(command, { response, error })
    queueMicrotask(() => this.settled.delete(command))
  }

  /** Fire-and-forget write (wake/keepalive prods), bypassing the in-flight tracker. */
  sendRaw(bytes: Uint8Array): void {
    this.link.sendRaw(bytes)
  }

  /** The PTT key/unkey frame for the current context: the manual-dial DMR frame when a dial target
   * is set on a DMR channel, else the plain frame. Manual dial + release must be a matched pair
   * (same tail), so we key off the SAME manualDial value for both. */
  private pttFrameFor(on: boolean): Uint8Array {
    const side = this.current.selectedSide
    const dial = this.current.manualDial[side] // PTT uses the SELECTED side's dial
    const isDigital = this.current.sides[side].channel?.type !== 'analog'
    if (dial && isDigital) return manualDialPtt(on, side, dial.target, dial.callType)
    return on ? pttKey() : pttUnkey()
  }

  /** Key the transmitter (no-op unless idle/fault). The key-down is RETRYABLE but tightly
   * BOUNDED (KEY_MAX_ATTEMPTS): the radio's firmware busy-gate silently drops 0x56 while mid-RX
   * (wire-diagnosed 2026-07-12), and the real BT-01 retransmits its key-downs too (~1 s timeout,
   * MITM-measured). This is safe because the ARQ only re-sends an UNACKED command — an acked
   * key-down is never re-sent — and a release during the retry window is captured as intent
   * (releaseAfterKey) and honored the moment the outcome lands. Exhaustion still triggers the
   * failsafe release in onPttOutcome (TX state unknown ⇒ force a release). */
  key(): void {
    // Re-key DURING the drain window: the finger is back down while the previous release is
    // still draining buffered audio — cancel the pending release and keep transmitting (the two
    // overs merge, which is what the radio would do on a fast double-tap anyway).
    if (this.txDrainTimer) {
      clearInterval(this.txDrainTimer)
      this.txDrainTimer = null
      return
    }
    if (this.current.ptt !== 'idle' && this.current.ptt !== 'fault') return
    this.releaseAfterKey = false
    // Per-keyup reset — but micAt SURVIVES an already-attached mic (capture-first ordering:
    // the rtc.mic notify precedes ptt.key), and the guard re-arms (its interval self-disarms
    // on any pre-key idle tick).
    this.txAudio = { keyAt: this.now(), firstFrameAt: null, lastFrameAt: null, micAt: this.txMicAttached ? this.now() : null }
    if (this.txMicAttached) this.armSilenceGuard()
    this.dispatch({ kind: 'ptt', phase: 'keying' })
    this.link.submit(this.pttFrameFor(true), { retransmitSafe: true, maxAttempts: KEY_MAX_ATTEMPTS })
  }

  // ── TX audio drain (release) + keyed-but-silent guard ────────────────────────
  // Parrot-measured 2026-07-18: the browser→backend audio pipe runs 0.4–0.7 s behind on LAN and
  // 1.5–3 s over TURN — releasing at "I finished speaking" guillotines everything still in
  // flight. With PRESS-GATED capture the pipe latency is measurable per keyup (first TX frame
  // arrival − key intent), so the release is delayed by exactly that (+margin, hard-capped) while
  // the in-flight tail drains to the radio. Safety paths (deadman, socket loss, failsafe) call
  // unkey(true) and bypass the drain entirely.
  private txAudio: { keyAt: number; firstFrameAt: number | null; lastFrameAt: number | null; micAt: number | null } = {
    keyAt: 0,
    firstFrameAt: null,
    lastFrameAt: null,
    micAt: null,
  }
  private txDrainTimer: ReturnType<typeof setInterval> | null = null
  private txSilenceGuard: ReturnType<typeof setInterval> | null = null

  /** A TX mic stream attached (rtc.mic active) / detached for this keyup — arms the silence
   * guard: keyed while a mic is EXPECTED but no audio arrives for TX_SILENCE_GUARD_MS means the
   * audio path died (RTP loss, tab frozen with the socket alive) → force-release rather than
   * transmit dead air. A keyup with no mic (kerchunk / analog, mic never armed) is never guarded. */
  /** LEVEL state: a mic stream is currently attached (rtc.mic active). Survives key()'s
   * per-keyup txAudio reset — CRITICAL under capture-first ordering, where the rtc.mic notify
   * arrives BEFORE ptt.key (live bug 2026-07-18: key() wiped micAt → hasDrainableAudio false →
   * the drain never armed and releases were immediate; run data showed 56 00 landing before the
   * last audio had even arrived). */
  private txMicAttached = false

  noteTxMicActive(active: boolean): void {
    this.txMicAttached = active
    if (!active) {
      this.txAudio.micAt = null
      return
    }
    this.txAudio.micAt = this.now()
    this.armSilenceGuard()
  }

  private armSilenceGuard(): void {
    if (this.txSilenceGuard) return
    this.txSilenceGuard = setInterval(() => {
      const ptt = this.current.ptt
      if (ptt !== 'keyed' && ptt !== 'keying') {
        this.disarmSilenceGuard()
        return
      }
      if (this.txDrainTimer) return // already releasing
      const { micAt, lastFrameAt } = this.txAudio
      if (micAt === null) return // mic disarmed mid-key — no stream expected anymore
      const base = Math.max(micAt, lastFrameAt ?? micAt)
      if (this.now() - base > TX_SILENCE_GUARD_MS) {
        this.events.onPttFailsafe?.('no TX audio while keyed — auto-released (audio path lost)')
        this.unkey(true) // immediate: there is no audio to drain
      }
    }, 500)
    this.txSilenceGuard.unref?.()
  }

  /** Real TX audio evidence — the pipe-latency probe and the silence guard's liveness signal. */
  noteTxAudioFrame(): void {
    const now = this.now()
    this.txAudio.firstFrameAt ??= now
    this.txAudio.lastFrameAt = now
  }

  /** RTP-truth feed (main.ts polls AudioBridge.txPacketsReceived while PTT is active): the
   * packet counter ADVANCING is real browser-stream arrival. The frame tee cannot be used for
   * this — wrtc's NetEq synthesizes decode-cadence frames continuously even with no sender
   * track, which flattened the drain to its floor and made the silence guard unfireable. A
   * counter going BACKWARD (new session / renegotiation) just re-baselines. */
  private txRtpPrev: number | null = null
  noteTxRtpPackets(packets: number): void {
    if (this.txRtpPrev !== null && packets > this.txRtpPrev) this.noteTxAudioFrame()
    this.txRtpPrev = packets
  }

  private disarmSilenceGuard(): void {
    if (this.txSilenceGuard) {
      clearInterval(this.txSilenceGuard)
      this.txSilenceGuard = null
    }
  }

  /** Whether release should DRAIN at all: only when a mic stream attached AND real audio
   * actually arrived this keyup (otherwise there is nothing buffered — release must not lag). */
  private hasDrainableAudio(): boolean {
    return this.txAudio.micAt !== null && this.txAudio.firstFrameAt !== null
  }

  /** Release the transmitter (from keyed, or from fault — the manual failsafe retry). The unkey
   * IS retransmit-safe: releasing twice is harmless, staying keyed is not, so the ARQ retries it
   * for ~timeoutMs×maxAttempts (≈10 s in production) before onPttOutcome escalates to the
   * Bluetooth-teardown failsafe.
   *
   * `immediate` (deadman / socket loss / failsafe / silence guard) bypasses the audio drain —
   * the drain is a courtesy on the happy path ONLY; safety always releases now. */
  unkey(immediate = false): void {
    if (this.current.ptt === 'keying') {
      // Released while the key-down is still unacked (possibly mid-retransmit). We can't unsend
      // it — record the intent; onPttOutcome releases immediately on ack (and a failure's
      // failsafe release IS the release). Without this, a late-acked key-down would leave the
      // transmitter keyed with the operator's finger already off the button.
      this.releaseAfterKey = true
      return
    }
    if (this.current.ptt !== 'keyed' && this.current.ptt !== 'fault') return
    if (immediate) {
      if (this.txDrainTimer) {
        clearInterval(this.txDrainTimer)
        this.txDrainTimer = null
      }
      this.submitRelease()
      return
    }
    if (this.txDrainTimer) return // release already pending
    if (this.hasDrainableAudio() && this.current.ptt === 'keyed') {
      // Drain-until-stream-end: keep feeding until the RTP counter has been FROZEN for
      // TX_DRAIN_QUIET_MS (the browser stopped its track at release — frozen means the last
      // in-flight audio arrived), hard-capped at TX_DRAIN_CAP_MS from the release intent.
      const releasedAt = this.now()
      this.txDrainTimer = setInterval(() => {
        // Quiet is measured from the LATER of last-packet / release — a minimum 400 ms drain
        // even when the counter looks stale at release (poll granularity), ending 400 ms after
        // the last real packet otherwise.
        const last = this.txAudio.lastFrameAt ?? releasedAt
        const quiet = this.now() - Math.max(last, releasedAt) >= TX_DRAIN_QUIET_MS
        const capped = this.now() - releasedAt >= TX_DRAIN_CAP_MS
        if (quiet || capped) {
          if (this.txDrainTimer) {
            clearInterval(this.txDrainTimer)
            this.txDrainTimer = null
          }
          this.submitRelease()
        }
      }, 100)
      this.txDrainTimer.unref?.()
      return
    }
    this.submitRelease()
  }

  private submitRelease(): void {
    if (this.current.ptt !== 'keyed' && this.current.ptt !== 'fault') return
    this.disarmSilenceGuard()
    this.dispatch({ kind: 'ptt', phase: 'unkeying' })
    this.link.submit(this.pttFrameFor(false), { retransmitSafe: true })
  }

  /** Set a SIDE's sticky manual-dial override (local — no radio write; shapes that side's next DMR
   * PTT and gives resolveDmrSide a per-side TG to match). Throws on an invalid target first. */
  setManualDial(side: SideKey, target: number, callType: 'group' | 'private'): void {
    if (!Number.isInteger(target) || target <= 0 || target > 0xffffff) {
      throw new Error(`manual-dial target ${target} out of 24-bit range`)
    }
    this.dispatch({ kind: 'manualDial', side, dial: { target, callType } })
  }

  /** Clear a SIDE's manual-dial override — that side's next PTT uses its channel contact again. */
  clearManualDial(side: SideKey): void {
    this.dispatch({ kind: 'manualDial', side, dial: null })
  }

  /** Submit an 0x08 menu write (setting / side-select / zone-select) and run `apply` with its
   * outcome, correlated by Command identity. `apply` handles a synchronous resolution (ack inside
   * submit) too. */
  private submit08(frame: Uint8Array, apply: (event: 'acked' | 'failed') => void, opts?: SubmitOptions): Command {
    this.sync08 = null
    const command = this.link.submit(frame, opts)
    const sync = this.takeSync08() // set if the ack resolved synchronously inside submit()
    if (sync !== null && sync.command === command) apply(sync.event)
    else this.pending08.set(command, apply)
    return command
  }

  private takeSync08(): { command: Command; event: 'acked' | 'failed' } | null {
    const sync = this.sync08
    this.sync08 = null
    return sync
  }

  private on08Outcome(command: Command, event: 'acked' | 'failed'): void {
    if (command.op !== SETTING_OP) return // 0x08 is the only correlated head
    const apply = this.pending08.get(command)
    if (!apply) {
      this.sync08 = { command, event } // resolved before submit08 registered it (claimed there)
      return
    }
    this.pending08.delete(command)
    apply(event)
  }

  /** submit08's twin for the 0x2f per-channel write family (acked `03 2f`). */
  private submit2f(frame: Uint8Array, apply: (event: 'acked' | 'failed') => void, opts?: SubmitOptions): Command {
    this.sync2f = null
    const command = this.link.submit(frame, opts)
    const sync = this.takeSync2f()
    if (sync !== null && sync.command === command) apply(sync.event)
    else this.pending2f.set(command, apply)
    return command
  }

  private takeSync2f(): { command: Command; event: 'acked' | 'failed' } | null {
    const sync = this.sync2f
    this.sync2f = null
    return sync
  }

  private on2fOutcome(command: Command, event: 'acked' | 'failed'): void {
    if (command.op !== CHANNEL_OP) return
    const apply = this.pending2f.get(command)
    if (!apply) {
      this.sync2f = { command, event }
      return
    }
    this.pending2f.delete(command)
    apply(event)
  }

  /** Select side A/B as the radio's active side (08 19). Does NOT flip selectedSide optimistically:
   * we mark `pendingSide` and only move `selectedSide` when the radio acks (or a 05 read-back
   * confirms). Captured BT-01 flow after the ack is a status refresh (04 5a, 04 5e); dependent
   * side-scoped writes use ensureSideReady() so they queue behind that refresh and never run if the
   * side-select fails. */
  chooseSide(side: SideKey): void {
    void this.ensureSideReady(side).catch(() => undefined)
  }

  private ensureSideReady(side: SideKey): Promise<void> {
    if (this.current.selectedSide === side && this.current.pendingSide === null) return Promise.resolve()
    if (this.sideReady?.side === side) return this.sideReady.promise
    if (this.current.pendingSide && this.current.pendingSide !== side) {
      return Promise.reject(new Error(`side select already pending: ${this.current.pendingSide}`))
    }

    this.dispatch({ kind: 'sideSelect', phase: 'pending', side })
    // Hold the meter from submission: 5a frames near the swap are reference-ambiguous.
    this.suppress5aUntil = this.now() + Session.SIDE_SETTLE_MS
    const base = new Promise<void>((resolve, reject) => {
      this.submit08(selectSideCmd(side), (event) => {
        if (event !== 'acked') {
          this.dispatch({ kind: 'sideSelect', phase: 'failed', side }) // revert; selectedSide never moved
          this.suppress5aUntil = 0 // no swap happened — pushes are trustworthy again
          reject(new Error(`side select ${side} failed`))
          return
        }
        // ACK = gospel for the swap itself (the design's write discipline). The 5a STATUS
        // engine settles later (see suppress5aUntil) — no refresh read is issued: a swap
        // changes nothing physical, both sides' signal is already in state, and a read inside
        // the settle window returns old-reference data anyway (relay-measured).
        this.dispatch({ kind: 'sideSelect', phase: 'acked', side })
        this.suppress5aUntil = this.now() + Session.SIDE_SETTLE_MS // restart from the ack
        resolve()
      })
    })
    const tracked = base.finally(() => {
      if (this.sideReady?.promise === tracked) this.sideReady = null
    })
    this.sideReady = { side, promise: tracked }
    return tracked
  }

  private withSide(side: SideKey, run: () => void, fail?: () => void): void {
    if (this.current.selectedSide === side && this.current.pendingSide === null) {
      run()
      return
    }
    void this.ensureSideReady(side).then(run, () => fail?.())
  }

  /** Toggle VFO vs memory mode on a side (57 3d). Selects the side first if needed. Retransmit-
   * safe: it carries the ABSOLUTE target mode (not a toggle), so a re-send just re-applies the
   * same state — a lost ack auto-retries instead of leaving the button a silent no-op. This is NOT
   * a `2f` channel-record write, so the anti-corruption reason `2f` stays unsafe doesn't apply. */
  setVfoMode(side: SideKey, vfo: boolean): void {
    this.withSide(side, () => {
      void this.submitAndWait(vfoMemoryMode(vfo), { retransmitSafe: true })
        .then(() => this.link.submit(readRegister(side === 'b' ? 0x2d : 0x2c, this.liveReadMode)))
        .catch(() => undefined)
    })
  }

  /** Step a side's channel up/down (04 2c/2d 01 55). Absolute-target select (idempotent), so the
   * radio's reply (the new channel block) lands through the reducer. Needs a prior channel read.
   * Wraps host-side with the zone's real channel count (04 27 member count); falls back to the
   * radio's own wrap when the count is unknown (down → 0xf9 sentinel, up → increment). */
  stepChannel(side: SideKey, dir: 1 | -1): void {
    const cur = this.current.sides[side].channelPosition
    if (cur == null) throw new Error('channel position unknown — read the channel first')
    const count = this.current.sides[side].channelCount
    const target =
      dir < 0
        ? cur === 0
          ? count != null ? count - 1 : 0xf9
          : cur - 1
        : count != null && cur + 1 >= count
          ? 0
          : (cur + 1) & 0xff
    this.withSide(side, () => this.link.submit(channelSelect(side, target, dir)))
  }

  /** Step a side's zone up/down (08 39 <idx>). The `03 08` ack is gospel that the zone changed,
   * but a new zone loads a different channel that the ack doesn't carry — so we read the new zone
   * name + channel ONCE (not a poll). Needs a prior zone read for the current index. */
  stepZone(side: SideKey, dir: 1 | -1): void {
    const cur = this.current.sides[side].zoneNumber
    if (cur == null) throw new Error('zone index unknown — read the zone first')
    const count = this.current.sides[side].zoneCount
    if (count == null) throw new Error('zone count unknown — enumerate zones before stepping')
    const target = dir < 0 ? (cur === 0 ? count - 1 : cur - 1) : cur + 1 >= count ? 0 : cur + 1
    this.withSide(side, () => {
      // Zone-select shares the 0x08 head; route it through submit08. The follow-up reads carry the
      // new zone/channel and are queued only after the radio acks the zone write.
      this.submit08(zoneSelect(target), (event) => {
        if (event !== 'acked') return
        this.link.submit(readRegister(side === 'b' ? 0x2a : 0x29, this.liveReadMode))
        this.link.submit(readRegister(side === 'b' ? 0x2d : 0x2c, this.liveReadMode))
        // New zone → new channel count; refresh it (04 27 for the target zone index).
        void this.readChannelCount(side, target)
      })
    })
  }

  // Directory caches — the codeplug is static while connected, so enumerate once and reuse until
  // the user forces a refresh (or the session ends). Cleared together on a forced zone refresh.
  private scanListCache: { index: number; name: string }[] | null = null
  private zoneListCache: { index: number; name: string }[] | null = null
  private readonly zoneChannelsCache = new Map<number, { position: number; name: string }[]>()

  // Scan-lock follow: the radio does NOT push the channel it's scanning; to show the LOCKED channel
  // we read `04 2c/2d 01` once, but ONLY on a confirmed lock (squelch held open ≥ SCAN_LOCK_CONFIRM_MS,
  // not a mid-hop graze). A REAL timer, armed on the squelch-open edge, fires the read independent of
  // further frames — the radio is quiet on a locked scan channel, so a frame-driven confirm would
  // only trip on the next event (usually the idle transition = the lock showing right as it drops).
  private scanSide: SideKey | null = null
  private scanLockRead = false
  private scanPaused = false
  private scanLockTimer: ReturnType<typeof setTimeout> | null = null
  private scanPauseTimer: ReturnType<typeof setTimeout> | null = null

  /** Enumerate EVERY zone (04 2b directory) — name per 0-based index, stopping at the first empty
   * name or a wrap back to zone 0's name. Non-destructive (no 08 39 navigation). Request/response,
   * off the state stream. Cached until `force`. Feeds the "go anywhere" picker. */
  async listZones(force = false, max = 250): Promise<{ index: number; name: string }[]> {
    if (!force && this.zoneListCache) return this.zoneListCache
    if (force) this.zoneChannelsCache.clear() // a zone re-read invalidates per-zone channel lists
    // Prefer the known zone count (04 1b b36) as the bound so we never read a nonexistent slot —
    // an out-of-range 04 2b has no defined frame length and would stall the framer. The blank/wrap
    // guards are a defensive fallback when the count isn't known yet.
    const count = this.current.sides[this.current.selectedSide].zoneCount
    const limit = count != null ? Math.min(count, max) : max
    const out: { index: number; name: string }[] = []
    for (let i = 0; i < limit; i += 1) {
      const reply = await this.submitAndWait(readZoneName(i)).catch(() => null)
      const name = reply ? decodeZoneBrowseName(reply.bytes) : null
      if (!name) break
      if (out.length && name === out[0]!.name) break // wrapped past the last real zone
      out.push({ index: i, name })
    }
    this.zoneListCache = out
    return out
  }

  /** Read a zone's channels (04 27 members → 04 2e names) by 0-based zone index, WITHOUT navigating
   * to it. Positions are in-zone scroll order (the channel-select target). */
  private async readZoneChannelNames(zoneIndex: number): Promise<{ position: number; name: string }[]> {
    const members = await this.submitAndWait(readZoneChannels(zoneIndex))
      .then((r) => decodeZoneChannelMembers(r.bytes))
      .catch(() => [] as number[])
    const out: { position: number; name: string }[] = []
    for (let position = 0; position < members.length; position += 1) {
      const reply = await this.submitAndWait(readChannelName(members[position]!)).catch(() => null)
      out.push({ position, name: (reply && decodeChannelName(reply.bytes)) || `CH ${position + 1}` })
    }
    return out
  }

  /** List a side's CURRENT-zone channels for the picker. Request/response, off the state stream. */
  listChannels(side: SideKey): Promise<{ position: number; name: string }[]> {
    const zone = this.current.sides[side].zoneNumber
    if (zone == null) return Promise.resolve([])
    return this.readZoneChannelNames(zone)
  }

  /** List an ARBITRARY zone's channels (04 27 <zoneIndex>) for the "go anywhere" picker. Cached
   * per zone until `force`. */
  async listZoneChannels(zoneIndex: number, force = false): Promise<{ position: number; name: string }[]> {
    if (!force) {
      const cached = this.zoneChannelsCache.get(zoneIndex)
      if (cached) return cached
    }
    const channels = await this.readZoneChannelNames(zoneIndex)
    this.zoneChannelsCache.set(zoneIndex, channels)
    return channels
  }

  /** Jump a side directly to an in-zone channel position (absolute 04 2c/2d 01 55 select). The
   * radio's reply (the new channel block) lands through the reducer. */
  selectChannel(side: SideKey, position: number): void {
    this.withSide(side, () => this.link.submit(channelSelect(side, position & 0xff, 1)))
  }

  /** "Go anywhere": jump a side to a channel in ANY zone. Selects the side, switches the zone
   * (08 39 <zoneIndex>), then on the ack selects the channel position and reads back the new zone
   * name + channel count. Mirrors the BT-01's zone→channel jump. */
  selectZoneChannel(side: SideKey, zoneIndex: number, position: number): void {
    this.withSide(side, () => {
      this.submit08(zoneSelect(zoneIndex), (event) => {
        if (event !== 'acked') return
        this.link.submit(channelSelect(side, position & 0xff, 1))
        this.link.submit(readRegister(side === 'b' ? 0x2a : 0x29, this.liveReadMode))
        void this.readChannelCount(side, zoneIndex)
      })
    })
  }

  /** Enumerate the radio's native scan lists (04 4b directory) — request/response, off the state
   * stream (catalogue metadata, like settings.catalogue). Reads indices from 0 until a run of
   * empty slots. Cached until `force`. */
  async listScanLists(force = false, max = 32, emptyStop = 3): Promise<{ index: number; name: string }[]> {
    if (!force && this.scanListCache) return this.scanListCache
    const out: { index: number; name: string }[] = []
    let empties = 0
    for (let i = 0; i < max && empties < emptyStop; i += 1) {
      const reply = await this.submitAndWait(readScanList(i)).catch(() => null)
      const name = reply ? decodeScanListName(reply.bytes) : null
      if (name) {
        out.push({ index: i, name })
        empties = 0
      } else {
        empties += 1
      }
    }
    this.scanListCache = out
    return out
  }

  /** Start native scan on `side` (optionally switching the active scan list first). ACK = gospel:
   * scan.active flips on the 57 48 ack. The locked channel arrives via the normal channel block. */
  startScan(side: SideKey, listIndex: number | null, listName: string | null): void {
    this.withSide(side, () => {
      const start = (): void => {
        void this.submitAndWait(scanStartStop(true), { retransmitSafe: false })
          .then(() => {
            this.clearScanFollow()
            this.scanSide = side
            this.dispatch({ kind: 'scan', active: true, listName })
          })
          .catch(() => undefined)
      }
      if (listIndex == null) {
        start()
        return
      }
      // Change the active list first (2f 2b, acked 03 2f), then start on it.
      this.submit2f(scanSelect(listIndex), (event) => {
        if (event === 'acked') start()
      })
    })
  }

  /** Stop native scan (57 48 00). scan.active clears on the ack. Then restore the display by reading
   * the scan side's LIVE `04 2c/2d 01` register — NOT the base `…07`, which is stale post-scan (it
   * holds the scan working slot). Mirrors the BT-01's stop sequence. */
  stopScan(): void {
    // Tear the follow down + capture the side ONLY on the confirmed stop. Clearing on SEND was a
    // bug: a failed first stop (57 48 is not retransmit-safe) nulled scanSide, so a retry captured
    // side=null and skipped the channel-restore read — the side was left on the stale scan-cursor
    // channel instead of its real current one (live 2026-07-14 02:51: RMRL BROOMFIELD shown for a
    // channel that was actually COLCON DENVER). scanSide stays valid across the failed attempt.
    // Retransmit-safe: a scan STOP is idempotent (stopping an already-stopped scan just re-acks),
    // so a lost ack auto-retries instead of silently leaving the scan running — the radio's own
    // scan-flag keeps the title honest meanwhile (same idempotent-release logic as unkey). START
    // stays non-retransmit-safe: a failed start is self-evident (the scan simply doesn't begin).
    void this.submitAndWait(scanStartStop(false), { retransmitSafe: true })
      .then(() => {
        const side = this.scanSide ?? this.current.selectedSide
        this.clearScanFollow()
        this.dispatch({ kind: 'scan', active: false, listName: null })
        this.link.submit(readRegister(side === 'b' ? 0x2d : 0x2c, 0x01))
      })
      .catch(() => undefined)
  }

  private clearScanFollow(): void {
    if (this.scanLockTimer) {
      clearTimeout(this.scanLockTimer)
      this.scanLockTimer = null
    }
    if (this.scanPauseTimer) {
      clearTimeout(this.scanPauseTimer)
      this.scanPauseTimer = null
    }
    this.scanSide = null
    this.scanLockRead = false
    if (this.scanPaused) {
      this.scanPaused = false
      this.dispatch({ kind: 'scanPause', paused: false })
    }
  }

  /** Called after every inbound frame while a scan runs. The lock/pause is attributed to a SIDE:
   * `activeReceive` resolves which side the current audio belongs to, so RX on the NON-scanning side
   * pauses the scan (the radio holds it — only one side scans) instead of falsely locking. When the
   * SCANNING side receives, a real confirm timer fires the lock read once it holds open past the
   * window (the radio sends no frames on a locked scan channel, so a frame-driven confirm can't). */
  /** PER-SIDE receive evidence for the scan state machine: the side's own 5a squelch bit (honest
   * for DMR sides too), a corroborated DMR call resolved to it, or the single-winner attribution
   * landing on it (covers the lone-DMR 5b inference). PAUSE and LOCK derive from their OWN sides
   * independently — they CO-EXIST when both sides receive (the other side holds the scan while
   * the parked channel itself locks), which a single-winner attribution structurally cannot say. */
  private sideReceiving(side: SideKey): boolean {
    const rs = this.current
    const bit = side === 'a' ? rs.signal.aOpen : rs.signal.bOpen
    if (bit) return true
    // Accept every attribution EXCEPT the lone-DMR INFERENCE. During an analog tail the per-side
    // 5a bit closes a beat before the 5b gate; in that gap activeReceive infers the lone DMR side
    // (gate open, no analog squelch) — which would spuriously flip PAUSE for a mixed FM/DMR pair
    // (wire-observed 2026-07-11 22:27:37: bOpen false + the 5b audio gate still open → false pause blip).
    // 'selected' stays IN: it attributes to the scanning side, the only evidence when the radio
    // reports a lock via 5b alone (no per-side 5a bit) — needed for the lock to arm.
    const recv = activeReceive(rs, audioGateOpen(rs))
    return recv.open && recv.side === side && recv.source !== 'inferred'
  }

  private scanFollow(): void {
    if (this.scanSide == null) return
    const scanSide = this.scanSide
    const otherSide: SideKey = scanSide === 'a' ? 'b' : 'a'

    // The radio pauses (parks) the scan while the OTHER side is receiving — regardless of what
    // the parked channel itself is doing. It ALSO parks while WE transmit (PTT keys the current
    // channel mid-scan): treating that as the same pause is what fires the pause-confirm read
    // and names the channel the operator is transmitting on — without it the card sat on the
    // sweeping placeholder for the whole keyup (live bug 2026-07-15). isTransmitting = CONFIRMED
    // TX only, so an unacked key-down request can't park the display.
    this.setScanPaused(this.sideReceiving(otherSide) || isTransmitting(this.current))

    if (this.sideReceiving(scanSide)) {
      if (this.scanLockRead && !this.current.scan.locked) {
        // Re-key while still PARKED (dropout window or other-side pause): the radio re-opens the
        // same channel without hopping — relock immediately, no confirm window. lockedChannel
        // is kept (no placeholder flash) but we re-read anyway: if a fast hop slipped between 5a
        // pushes the reply reconciles the name ~1 RTT later.
        this.dispatch({ kind: 'scanRelock' })
        this.scanLockRead = true
        this.link.submit(readRegister(this.scanSide === 'b' ? 0x2d : 0x2c, 0x01))
      } else if (!this.scanLockRead && this.scanLockTimer == null) {
        this.scanLockTimer = setTimeout(() => {
          this.scanLockTimer = null
          if (this.scanSide != null && this.sideReceiving(this.scanSide) && !this.scanLockRead) {
            // Confirmed lock on the SCANNING side: read the channel (reply flows through the reducer
            // → the card shows it) and flip scan.locked. One read per lock until the squelch closes.
            // This read supersedes a pending pause read — same register, no doubling.
            if (this.scanPauseTimer) {
              clearTimeout(this.scanPauseTimer)
              this.scanPauseTimer = null
            }
            this.scanLockRead = true
            // LOCK first, then the read: the reply's channel block names scan.lockedChannel,
            // which only reconciles while locked — a (sim-)synchronous reply arriving inside
            // submit() must already see the locked state, or the freshness marker never fills.
            this.dispatch({ kind: 'scanLock', locked: true })
            this.link.submit(readRegister(this.scanSide === 'b' ? 0x2d : 0x2c, 0x01))
          }
        }, SCAN_LOCK_CONFIRM_MS)
        this.scanLockTimer.unref?.()
      }
    } else if (this.scanLockTimer || this.scanLockRead) {
      // Scan side no longer receiving → cancel a pending arm + drop the lock, ready for the next.
      if (this.scanLockTimer) {
        clearTimeout(this.scanLockTimer)
        this.scanLockTimer = null
      }
      if (this.scanLockRead) {
        if (this.current.scan.parked || this.scanPaused) {
          // Signal gone but the scan is still HELD: the radio's park bit (dropout delay), or an
          // active PAUSE — the park bit is NOT reliable while the other side receives (wire
          // 2026-07-13 22:32), but a paused scan cannot have hopped, so the pause is hold
          // evidence in its own right. The channel data stays current (still sitting on it);
          // scanLockRead stays armed so a re-key relocks and the true release below resumes.
          this.dispatch({ kind: 'scanHold' })
        } else {
          // Park lifted (or the fixture predates the byte-3 bit): the hop resumed.
          this.scanLockRead = false
          this.dispatch({ kind: 'scanResume' })
          // Resume while the pause still holds: the scan stays parked by the OTHER side —
          // refresh the parked-channel read so pausedChannel is named even when the pause
          // predates the lock (its original confirm read may never have fired).
          if (this.scanPaused && this.scanPauseTimer == null) this.armScanPauseRead()
        }
      }
    }
  }

  private setScanPaused(paused: boolean): void {
    if (paused === this.scanPaused) return
    this.scanPaused = paused
    this.dispatch({ kind: 'scanPause', paused })
    // The radio PARKS a paused scan on the last-scanned channel — which one is invisible until
    // read (it never pushes mid-scan channels). Confirm the pause held for the same window the
    // lock uses, then read the scanning side's LIVE register: the reply flows through the
    // reducer, names scan.pausedChannel, and keeps the recorder's attribution correct if the
    // parked channel itself starts receiving next.
    if (paused && this.scanPauseTimer == null) {
      this.armScanPauseRead()
    } else if (!paused && this.scanPauseTimer) {
      clearTimeout(this.scanPauseTimer)
      this.scanPauseTimer = null
    }
  }

  private armScanPauseRead(): void {
    this.scanPauseTimer = setTimeout(() => {
      this.scanPauseTimer = null
      // Skip when a lock read already fired: it hits the SAME live register (the parked channel
      // IS the locked channel), and doubled reads in the radio's busy window get dropped →
      // needless ARQ retransmits (wire-observed 2026-07-11 21:05/21:08).
      if (this.scanPaused && this.scanSide != null && !this.scanLockRead) {
        this.link.submit(readRegister(this.scanSide === 'b' ? 0x2d : 0x2c, 0x01))
      }
    }, SCAN_LOCK_CONFIRM_MS)
    this.scanPauseTimer.unref?.()
  }

  // WRITE-BACK IS OPTIMISTIC, NEVER AN IMMEDIATE RE-READ. Firmware RE of the real BT-01 shows it
  // NEVER reads the channel block back after a 2f write, and the radio's own firmware ACKs a write
  // ~a beat BEFORE it commits it — so an immediate `04 2c/2d` read lands inside the commit window
  // and can race the record write (the corpus MIDSOUTH garble is exactly this kind of read racing a
  // commit). So on ack we apply the change optimistically to the displayed value and issue NO
  // read; the next natural channel read (step / zone change / reconnect) reconciles it.

  /** Write a per-channel setting on a side (2f family): switch to the side if needed, mark it
   * pending, and on the `03 2f` ack apply the value optimistically (one reduction — the reducer's
   * acked case applies value + clears the overlay atomically). Throws (before any state change)
   * on an unknown key/option. */
  setChannelSetting(side: SideKey, key: string, value: string | number): void {
    const def = CHANNEL_SETTINGS_BY_KEY[key]
    if (!def) throw new Error(`unknown channel setting: ${key}`)
    const frame = channelSettingWrite(key, value) // validates the option; throws before state change
    const index = typeof value === 'number' ? value : def.options.indexOf(value)
    const desired = String(def.options[index] ?? value)
    this.withSide(side, () => {
      this.dispatch({ kind: 'channelSetting', phase: 'pending', side, key, desired })
      this.submit2f(frame, (event) => {
        this.dispatch({ kind: 'channelSetting', phase: event === 'acked' ? 'acked' : 'failed', side, key, desired })
      })
    })
  }

  /** Write an RX/TX tone (CTCSS/DCS) on a side's working channel (2f 16 / 2f 02). Same optimistic
   * ack workflow as setChannelSetting; the overlay lives under `rxTone`/`txTone`. */
  setChannelTone(side: SideKey, field: ToneField, type: ToneType, value = 0, inverted = false): void {
    const frame = channelToneWrite(field, type, value, inverted) // validates; throws before state change
    const desired = toneLabel(type, value)
    this.withSide(side, () => {
      this.dispatch({ kind: 'channelTone', phase: 'pending', side, field, type, value, desired })
      this.submit2f(frame, (event) => {
        this.dispatch({ kind: 'channelTone', phase: event === 'acked' ? 'acked' : 'failed', side, field, type, value, desired })
      })
    })
  }

  /** Write a side's working RX/TX frequency (2f 03 / 2f 04, both live-validated). Same
   * select-side-then-write + pending-overlay + optimistic-on-ack workflow as the other 2f writes
   * (no re-read). The frame does NOT carry the side — the radio's selected side receives the
   * write, which is exactly what withSide() guarantees. */
  setFrequency(side: SideKey, field: 'rx' | 'tx', hz: number): void {
    // RX write echoes the side's live channel record (Sitting-2 pin) — the raw record lives in
    // the STATE (record-canonical); refuse if we haven't read it yet rather than corrupt the
    // channel with a stale tail. TX write uses a fixed template.
    const raw = this.current.sides[side].channelRaw
    const frame =
      field === 'rx'
        ? rxFrequencyWrite(hz, raw ? hexStrToBytes(raw) : new Uint8Array(0))
        : txFrequencyWrite(hz) // validates; throws before state change
    const mhz = Number((Math.round(hz) / 1e6).toFixed(5))
    const desired = mhz.toFixed(5)
    this.withSide(side, () => {
      this.dispatch({ kind: 'channelFrequency', phase: 'pending', side, field, mhz, desired })
      this.submit2f(frame, (event) => {
        this.dispatch({ kind: 'channelFrequency', phase: event === 'acked' ? 'acked' : 'failed', side, field, mhz, desired })
      })
    })
  }

  /** Volume knob for one side (`08 4a` — selected-side scoped, so withSide swaps first).
   * Write-only on the wire: the ACKed level becomes the state (no read-back exists).
   * NO UI currently: BT audio does NOT track the knob, so the slider did nothing audible while
   * listening over Bluetooth (removed 2026-07-12). The op matters again for wired (rear-jack)
   * capture, where the knob IS the input level — see the dual-interface plan. */
  setVolume(side: SideKey, level: number): void {
    const frame = volumeWrite(level) // validates; throws before any state change
    this.withSide(side, () => {
      this.submit08(frame, (event) => {
        if (event === 'acked') this.dispatch({ kind: 'volume', side, level })
      })
    })
  }

  private onPttOutcome(command: Command, event: 'acked' | 'failed'): void {
    // Order-independent: the ack can resolve synchronously inside submit(); we key off the op.
    if (command.op !== PTT_OP) return
    this.cancelPttDrain() // any fresh PTT outcome supersedes a pending drain
    // RELEASE DRAIN: the unkey ACK confirms the radio ACCEPTED the release — not that RF is
    // down. On DMR the radio keeps transmitting the call terminator ~0.5 s past the ack
    // (wire-measured 2026-07-13), during which the 5e TX call state still reads "transmitting";
    // flipping to idle here made the view re-derive confirmed-RED from that leftover (the
    // yellow→red→green flash). Hold `unkeying` — 'releasing' literally means "unkey sent, radio
    // still transmitting" — until the radio's own TX indications clear (checkPttDrain, driven by
    // the same frames that carry the end-of-call), capped so a lost end push can't wedge it.
    if (event === 'acked' && command.frame[1] === 0x00 && this.radioStillTransmitting()) {
      this.pttDrainTimer = setTimeout(() => {
        this.pttDrainTimer = null
        this.dispatch({ kind: 'ptt', phase: nextPttPhase(this.current.ptt, 'acked') })
        this.scanFollow() // TX ended → release a PTT-held scan pause
      }, PTT_DRAIN_CAP_MS)
      this.pttDrainTimer.unref?.()
      return
    }
    this.dispatch({ kind: 'ptt', phase: nextPttPhase(this.current.ptt, event) })
    // PTT state changes park/release the scan (see scanFollow's pause driver) but don't ride the
    // frame path — re-evaluate here so a keyup mid-scan engages the pause (and its confirm read,
    // which names the TX channel) on the ACK, not a push later.
    this.scanFollow()
    if (event !== 'failed') {
      // Key-down confirmed but the operator ALREADY released during the retry window → honor the
      // stored intent right away (the transmitter must never outlive the button press).
      if (command.frame[1] === 0x01 && this.releaseAfterKey) {
        this.releaseAfterKey = false
        this.unkey()
      }
      return
    }
    this.releaseAfterKey = false // a failed key-down falls through to the failsafe release below
    // SAFETY ESCALATION. frame[1] tells key-down (01) from release (00) apart:
    //  • an unacknowledged KEY-DOWN leaves the TX state unknown (the radio may have keyed and the
    //    ack got lost) — immediately begin the failsafe release, which the ARQ retries ~10 s;
    //  • an exhausted RELEASE means ~10 s of unkey retransmits went unanswered — the last resort
    //    is severing Bluetooth entirely (the radio ends PTT when remote control deactivates).
    if (command.frame[1] === 0x01) {
      this.dispatch({ kind: 'ptt', phase: 'unkeying' })
      this.link.submit(this.pttFrameFor(false), { retransmitSafe: true })
    } else {
      this.events.onPttFailsafe?.('the radio did not acknowledge PTT release')
    }
  }

  /** Write a menu setting (device shadow): record a desired value, optimistically confirm on
   * the radio's ack (ACK = receipt; a later read-back stays authoritative). Throws on an
   * unknown setting / option. */
  setSetting(name: string, value: string | number): void {
    const frame = settingWrite(name, value) // validates; throws before any state change
    const desired = this.normalizeSetting(name, value)
    this.dispatch({ kind: 'setting', phase: 'pending', name, desired })
    this.submit08(frame, (event) => {
      this.dispatch({ kind: 'setting', phase: event === 'acked' ? 'acked' : 'failed', name, desired })
    }) // 08 → retransmit-safe
  }

  /** Normalize a written value to the reported (option-label) form for comparison. */
  private normalizeSetting(name: string, value: string | number): string | number {
    if (typeof value === 'string') return value
    return settingByName(name)?.options[value] ?? value
  }

  /** THE single mutation gate: every state change — inbound frame or write lifecycle — enters
   * the pure reducer through here, so one event is one reduction is one broadcast patch. A no-op
   * reduction (same reference back) is not broadcast. */
  private dispatch(event: DomainEvent): void {
    const next = applyEvent(this.current, event)
    if (next === this.current) return
    this.current = next
    // Every state change re-evaluates the 59 lock window (arm/cancel) — scan flips and lock
    // events arrive through here, not only the frame path. Self-guarding: the timer's own
    // dmrNoLock event flips the wanted-condition off, so no re-arm loop.
    this.watchDmrLock()
    this.events.onState?.(this.current)
  }

  // 5f = radio UI notifications (the popups the BT-01 head shows). Sub-code in byte 1. The
  // radio retransmits until acked, so a burst of identical frames can land before our first ack
  // does — dedupe within a short window. Unknown sub-codes are acked (link layer) but not
  // surfaced; the wire log keeps the sample for RE.
  private lastNotice: { code: number; at: number } = { code: -1, at: 0 }

  private onRadioNotice(frame: DecodedFrame): void {
    const code = frame.bytes[1] ?? -1
    if (code === this.lastNotice.code && this.now() - this.lastNotice.at < 10_000) return
    this.lastNotice = { code, at: this.now() }
    // 0x33: live-correlated 2026-07-12 — appears right after a DMR PTT release when the radio
    // shows "repeater not found" (the repeater/hotspot did not answer the DMR wake-up call).
    if (code === 0x33) {
      this.events.onRadioNotice?.('Radio: repeater not found — the DMR repeater/hotspot did not respond to the transmission.')
    }
    // 0x34: corpus-correlated (16 samples) — follows a DMR call END (5e 00 …) that carried a
    // private call to our ID with no answer from us; constant payload 02 00 (type flag, not a
    // count). Best interpretation: the radio's missed-call popup.
    if (code === 0x34) {
      this.events.onRadioNotice?.('Radio: missed call — an incoming DMR call ended unanswered.')
    }
  }

  /** True while the radio's OWN state says it is transmitting: the 5a byte-7 flag, or a live DMR
   * TX call (the 5e stream spans the post-unkey terminator). The ptt phase is deliberately NOT
   * consulted — this is the radio-truth side of the release drain. */
  private radioStillTransmitting(): boolean {
    const rs = this.current
    return rs.transmitting || rs.dmr?.direction === 'tx'
  }

  private pttDrainTimer: ReturnType<typeof setTimeout> | null = null
  private cancelPttDrain(): void {
    if (this.pttDrainTimer) {
      clearTimeout(this.pttDrainTimer)
      this.pttDrainTimer = null
    }
  }

  /** Complete the release drain the moment the radio's TX indications clear (called from the
   * frame path — the 5e dir=00 / 5c / 5a frames that clear them are what drives it). */
  private checkPttDrain(): void {
    if (this.pttDrainTimer === null || this.radioStillTransmitting()) return
    this.cancelPttDrain()
    this.dispatch({ kind: 'ptt', phase: nextPttPhase(this.current.ptt, 'acked') })
    this.scanFollow() // TX ended → release a PTT-held scan pause (runs after the frame path's own follow)
  }

  private apply(frame: DecodedFrame): void {
    // 5a data near a side swap (push OR read) may be in either side's frame of reference —
    // hold the last known per-side signal through the settle window (see suppress5aUntil).
    if (
      (frame.head === 0x5a || (frame.head === 0x04 && frame.reg === 0x5a)) &&
      this.now() < this.suppress5aUntil
    ) {
      return
    }
    if (frame.head === 0x5f) {
      this.onRadioNotice(frame)
      return
    }
    const scanWasActive = this.current.scan.active
    this.dispatch({ kind: 'frame', frame })
    if (this.current.scan.active !== scanWasActive) this.onScanActiveChanged(this.current.scan.active)
    this.enrichDmrCaller()
    this.scanFollow()
    this.checkPttDrain()
  }

  // ── the 59 LOCK WINDOW ──────────────────────────────────────────────────────
  // "Did the 59 come?" is a TIME question, not a frame-count one: an audible call's 59 (the
  // radio's call-log write — sent only for calls it routes) lands within ~0.5 s of the call's
  // first 5e (wire-measured), while the muted 5e stream is far too sparse for counting frames to
  // bound the wait (2-4 frames per transmission, multi-second gaps — live 2026-07-14). So the
  // session arms a timer when an unlocked RX slice appears; if it expires the radio is NOT
  // taking the call and the `dmrNoLock` event drives the NO MATCH pill. A lock/clear/scan
  // cancels; the reducer's dmrRemnant carries the verdict across a conversation's idles.
  private static readonly DMR_LOCK_WINDOW_MS = 2000
  private dmrLockTimer: ReturnType<typeof setTimeout> | null = null

  private watchDmrLock(): void {
    const d = this.current.dmr
    const wanted = d !== null && d.direction === 'rx' && !d.presented && !d.noLock && !this.current.scan.active
    if (!wanted) {
      if (this.dmrLockTimer !== null) {
        clearTimeout(this.dmrLockTimer)
        this.dmrLockTimer = null
      }
      return
    }
    if (this.dmrLockTimer !== null) return // window already running for this call
    this.dmrLockTimer = setTimeout(() => {
      this.dmrLockTimer = null
      this.dispatch({ kind: 'dmrNoLock' })
    }, Session.DMR_LOCK_WINDOW_MS)
  }

  /** The radio's own scan truth (5a byte 12) flipped scan.active in the reducer — reconcile the
   * scan-follow machinery. A scan WE didn't start (radio front panel, or already running at
   * connect — the startup 04 5a read) still gets the full lock-follow: the radio scans its
   * selected side, so that's the side to watch. Its NAME comes from one `04 4a` read — the
   * working channel's assigned scan-list record, which is the list a panel scan runs (the
   * BT-01's own startup does the same read). A radio-side stop tears the follow down. */
  private onScanActiveChanged(active: boolean): void {
    if (active) {
      if (this.scanSide === null) {
        this.scanSide = this.current.selectedSide
        if (this.current.scan.listName === null) this.link.submit(readRegister(0x4a, this.liveReadMode))
      }
    } else if (this.scanSide !== null) {
      this.clearScanFollow()
    }
  }

  private lastResolvedCaller: number | null = null
  /** After a frame lands, if the DMR talker id changed (58 push), resolve its RadioID caller-id
   * and feed it back as a `dmrCaller` event. Deduped so the several-per-second 58s look up once. */
  private enrichDmrCaller(): void {
    const dmr = this.current.dmr
    if (!dmr || dmr.callerId == null) {
      this.lastResolvedCaller = null
      return
    }
    if (dmr.callerId === this.lastResolvedCaller) return
    this.lastResolvedCaller = dmr.callerId
    const info = this.events.resolveCaller?.(dmr.callerId) ?? null
    this.dispatch({
      kind: 'dmrCaller',
      callerId: dmr.callerId,
      callsign: info?.callsign ?? null,
      name: info?.name ?? null,
      location: info?.location ?? null,
    })
  }
}
