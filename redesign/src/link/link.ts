// The link state machine (ARCHITECTURE link layer, LINK_PROTOCOL §3-7). One cohesive
// machine over a small mutable state, with clearly separated concerns:
//   • inflight — the single outstanding command (stop-and-wait ARQ)
//   • writer   — serialize outbound + a permanent inter-frame gap
//   • arq      — retransmit-on-timeout, retransmit-safety, max attempts
//   • demux    — route inbound frames: ack→inflight, required-push→ack+forward, data→forward
//
// Synchronous and clock-injected so it is fully replay-testable: drive it with submit() /
// receive() / tick() and a fake clock, and assert the writes, acks, and resolutions.

import { Framer, FramingError, type DecodedFrame } from '../codec/framing'
import { READ_HEAD } from '../codec/frame-table'
import { pushAck } from './ack'
import { defaultRetransmitSafe, isFreePush, requiresAck } from './classify'

const ACK_HEAD = 0x03

export type Expect = 'ack' | 'read'
export type FailReason = 'exhausted' | 'not-retryable'

export interface Command {
  /** The exact bytes to put on the wire. */
  readonly frame: Uint8Array
  /** Head byte — the op the radio echoes in its ACK (`03 <op> …`). */
  readonly op: number
  /** How this command is acknowledged: a 5-byte `03` ack, or its `04 <reg>` data response. */
  readonly expect: Expect
  /** For reads, the register whose response resolves the command. */
  readonly reg: number | undefined
  /** Whether a timed-out command may be safely re-sent. */
  readonly retransmitSafe: boolean
  /** Per-command attempt cap (min with LinkConfig.maxAttempts). The PTT key-down uses this:
   * retryable — the radio's busy-gate drops 0x56 mid-RX — but far more bounded than a read. */
  readonly maxAttempts: number | undefined
}

export interface LinkConfig {
  /** Time to wait for a response before retransmit / fail (~1s). */
  readonly timeoutMs: number
  /** Max sends of one command before giving up (initial + retransmits). */
  readonly maxAttempts: number
  /** Minimum spacing between outbound frames. */
  readonly gapMs: number
  /** Quiet-RX window before a transmit: don't start sending until the radio has been silent this
   * long (and no partial frame is buffered). Reads and writes share opcodes (04 2c read vs 04 2c
   * write), so a byte-level collision with the radio's transmission can misframe a read INTO a
   * write and corrupt the codeplug — this keeps our first byte off the wire while the radio is
   * mid-frame. Omit / 0 disables the gate; main.ts sets ~30ms (the BT-01's measured floor). */
  readonly rxQuietMs?: number
}

const DEFAULT_RX_QUIET_MS = 0 // opt-in: main.ts sets the real value; unset = gate off (tests)
// Ceiling on how long the RX-quiet gate may hold a command, so a continuously-streaming radio
// (heavy DMR) can't starve our queue indefinitely. The residual collision risk of sending during a
// never-quiet stream is irreducible (and the radio's checksum-reject + our retransmit recover it).
const MAX_RX_HOLD_MS = 400

export interface LinkPorts {
  /** Put bytes on the transport. */
  write(bytes: Uint8Array): void
  /** Every inbound DATA frame (read responses + pushes) → domain reducer. */
  inbound(frame: DecodedFrame): void
  /** A submitted command completed (got its ack / data response). */
  resolved(command: Command, response: DecodedFrame): void
  /** A submitted command gave up (timed out and was unsafe / out of attempts). */
  failed(command: Command, reason: FailReason): void
  /** A command was re-sent after a timeout (attempt = the new attempt number). Observability
   * only — the retransmit already happened; this just lets the app record WHICH command. */
  retransmitted?(command: Command, attempt: number): void
  /** An inbound packet could not be framed (rare radio garble — e.g. a browse reply with a
   * zeroed register + stale payload, corpus-observed ~1 in 36k). The bytes were discarded;
   * an affected in-flight read recovers via the normal ARQ retransmit. Diagnostics only. */
  framingIncident?(error: FramingError, discarded: Uint8Array): void
}

interface InFlight {
  command: Command
  attempts: number
  sentAt: number
}

export interface SubmitOptions {
  readonly retransmitSafe?: boolean
  /** Cap this command's total sends below LinkConfig.maxAttempts (see Command.maxAttempts). */
  readonly maxAttempts?: number
}

export function makeCommand(frame: Uint8Array, opts: SubmitOptions = {}): Command {
  const op = frame[0] ?? 0
  const expect: Expect = op === READ_HEAD ? 'read' : 'ack'
  return {
    frame,
    op,
    expect,
    reg: op === READ_HEAD ? frame[1] : undefined,
    retransmitSafe: opts.retransmitSafe ?? defaultRetransmitSafe(op),
    maxAttempts: opts.maxAttempts,
  }
}

export class LinkLayer {
  private readonly queue: Command[] = []
  private flight: InFlight | null = null
  private lastWriteAt = Number.NEGATIVE_INFINITY
  private lastRecvAt = Number.NEGATIVE_INFINITY
  private rxHoldSince = Number.NEGATIVE_INFINITY
  private readonly framer = new Framer()
  /** Count of retransmits (a command re-sent after a timeout) — link-health observability. */
  private retransmitCount = 0
  get retransmits(): number {
    return this.retransmitCount
  }

  constructor(
    private readonly cfg: LinkConfig,
    private readonly ports: LinkPorts,
    private readonly now: () => number,
  ) {}

  /** Whether a command is currently awaiting its response. */
  get busy(): boolean {
    return this.flight !== null
  }

  /** Queue a command. Returns the Command so the caller can correlate resolved/failed. */
  submit(frame: Uint8Array, opts: SubmitOptions = {}): Command {
    const command = makeCommand(frame, opts)
    this.queue.push(command)
    this.pump()
    return command
  }

  /** Fire-and-forget write, bypassing the in-flight tracker — for wake/keepalive prods that
   * we don't gate on a response. Use only while idle (e.g. the pre-handshake wake phase). */
  sendRaw(bytes: Uint8Array): void {
    this.lastWriteAt = this.now()
    this.ports.write(bytes)
  }

  /** Feed raw inbound bytes from the transport (framed internally). Frame-at-a-time so an
   * unparseable packet is contained: frames decoded before it still dispatch, the garble is
   * discarded (reported via framingIncident), and the stream re-aligns at the next packet —
   * never an exception out of the transport's read loop, never a link reset. */
  receiveBytes(chunk: Uint8Array): void {
    this.lastRecvAt = this.now() // the radio is transmitting right now — feeds the RX-quiet TX gate
    this.framer.push(chunk)
    for (;;) {
      let frame: DecodedFrame | null
      try {
        frame = this.framer.next()
      } catch (e) {
        if (!(e instanceof FramingError)) throw e
        this.ports.framingIncident?.(e, this.framer.discardPending())
        continue // buffer is now empty; next() returns null and the loop exits
      }
      if (!frame) return
      this.receive(frame)
    }
  }

  /** Dispatch one decoded inbound frame. */
  receive(frame: DecodedFrame): void {
    // Radio→host frames end in an additive checksum. A fixed-length frame can still be decoded with
    // a bad checksum; never let that mutate state or satisfy an in-flight command.
    if (!frame.checksumOk) return
    const head = frame.head
    if (requiresAck(head)) {
      this.emitAck(head)
      this.ports.inbound(frame)
      return
    }
    if (isFreePush(head)) {
      this.ports.inbound(frame)
      return
    }
    if (head === ACK_HEAD) {
      this.onCommandAck(frame)
      return
    }
    if (head === READ_HEAD) {
      this.onReadResponse(frame)
      return
    }
    // unknown-but-framed inbound: forward defensively, don't let it touch flow control
    this.ports.inbound(frame)
  }

  /** Drive timeouts and re-pump the queue; call periodically. */
  tick(): void {
    if (this.flight && this.now() - this.flight.sentAt >= this.cfg.timeoutMs) {
      this.onTimeout(this.flight)
    }
    this.pump()
  }

  // ── writer + inflight ──────────────────────────────────────────────────────
  private pump(): void {
    if (this.flight || this.queue.length === 0) return
    if (this.now() - this.lastWriteAt < this.cfg.gapMs) return // hold OUR inter-frame gap
    if (!this.rxSettled()) return // don't transmit while the RADIO is mid-frame / just transmitted
    const command = this.queue.shift()
    if (command) this.send(command, 1)
  }

  /** Whether the RX side is at a clean boundary to transmit into: the radio has been quiet for
   * rxQuietMs AND no partial frame is buffered. Bounded — if held longer than MAX_RX_HOLD_MS
   * (a continuously-streaming radio), allow the send anyway so the queue can't starve. */
  private rxSettled(): boolean {
    const now = this.now()
    const quietMs = this.cfg.rxQuietMs ?? DEFAULT_RX_QUIET_MS
    if (now - this.lastRecvAt >= quietMs && !this.framer.hasPartialFrame) {
      this.rxHoldSince = Number.NEGATIVE_INFINITY
      return true
    }
    if (this.rxHoldSince === Number.NEGATIVE_INFINITY) this.rxHoldSince = now
    if (now - this.rxHoldSince >= MAX_RX_HOLD_MS) {
      this.rxHoldSince = Number.NEGATIVE_INFINITY
      return true
    }
    return false
  }

  private send(command: Command, attempts: number): void {
    // Record in-flight BEFORE the bytes leave: a fast (or synchronous) response must find the
    // command already tracked, or its ack/data would be dropped as stray.
    const now = this.now()
    this.flight = { command, attempts, sentAt: now }
    this.lastWriteAt = now
    this.ports.write(command.frame)
  }

  // ── arq ────────────────────────────────────────────────────────────────────
  private onTimeout(flight: InFlight): void {
    const cap = Math.min(this.cfg.maxAttempts, flight.command.maxAttempts ?? this.cfg.maxAttempts)
    if (flight.command.retransmitSafe && flight.attempts < cap) {
      this.retransmitCount += 1
      this.ports.retransmitted?.(flight.command, flight.attempts + 1)
      this.send(flight.command, flight.attempts + 1)
      return
    }
    this.flight = null
    this.ports.failed(flight.command, flight.command.retransmitSafe ? 'exhausted' : 'not-retryable')
  }

  // ── demux ──────────────────────────────────────────────────────────────────
  private onCommandAck(frame: DecodedFrame): void {
    const flight = this.flight
    const ackedOp = frame.bytes[1]
    if (flight && flight.command.expect === 'ack' && ackedOp === flight.command.op) {
      this.flight = null
      this.ports.resolved(flight.command, frame)
      this.pump()
    }
    // a stray / mismatched ack resolves nothing
  }

  private onReadResponse(frame: DecodedFrame): void {
    this.ports.inbound(frame) // data always reaches the reducer, solicited or not
    const flight = this.flight
    if (flight && flight.command.expect === 'read' && frame.reg === flight.command.reg) {
      this.flight = null
      this.ports.resolved(flight.command, frame)
      this.pump()
    }
  }

  private emitAck(op: number): void {
    // Out-of-band priority write — sent immediately to clear the wedge, but it occupies the
    // wire, so the next command still honours the inter-frame gap after it.
    this.ports.write(pushAck(op))
    this.lastWriteAt = this.now()
  }
}
