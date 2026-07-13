// The inbound framer (ARCHITECTURE codec layer, LINK_PROTOCOL §2).
//
// The transport is a BYTE STREAM (RFCOMM SOCK_STREAM) — the kernel exposes no packet
// boundaries — so this layer reconstructs frames itself. Each frame's length comes from its
// TYPE (frame-table). Fixed-length types take exactly N bytes; variable `04` register reads
// (`04 2c/2d`, `04 4b`) are disambiguated by a valid trailing checksum AND a plausible next-head.
// Partial input is buffered; coalesced input is split. Pure + stateful only over its own byte
// buffer — no I/O, fully replay-testable.

import { checksumOk } from './checksum'
import {
  candidateHeadLengths,
  candidateLengths,
  defaultPlausibleHead,
  hex2,
  lengthForHead,
  lengthForRead,
  READ_HEAD,
} from './frame-table'

export class FramingError extends Error {
  readonly head: number
  readonly buffer: Uint8Array
  constructor(message: string, head: number, buffer: Uint8Array) {
    super(message)
    this.name = 'FramingError'
    this.head = head
    this.buffer = buffer
  }
}

export interface DecodedFrame {
  /** First byte — the frame type. */
  readonly head: number
  /** Register byte for `04 <reg>` reads, else undefined. */
  readonly reg: number | undefined
  /** The complete frame including its trailing checksum byte. */
  readonly bytes: Uint8Array
  /** Whether the trailing checksum validates (always true for a clean stream). */
  readonly checksumOk: boolean
}

export interface FramerOptions {
  /** Override the "could this byte start a frame?" test (variable-boundary confirmation). */
  readonly plausibleHead?: (b: number) => boolean
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice()
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export class Framer {
  private buf: Uint8Array = new Uint8Array(0)
  private readonly plausibleHead: (b: number) => boolean

  constructor(opts: FramerOptions = {}) {
    this.plausibleHead = opts.plausibleHead ?? defaultPlausibleHead
  }

  /** Append received bytes. */
  push(chunk: Uint8Array): void {
    this.buf = concat(this.buf, chunk)
  }

  /** Extract the next complete frame, or null when more bytes are needed. Throws FramingError
   * when the buffered bytes cannot be a frame we know (the buffer is left untouched so the
   * caller can inspect/discard it — see discardPending). */
  next(): DecodedFrame | null {
    const len = this.nextLength()
    if (len === null) return null
    const bytes = this.buf.slice(0, len)
    this.buf = this.buf.slice(len)
    return {
      head: bytes[0]!,
      reg: bytes[0] === READ_HEAD ? bytes[1]! : undefined,
      bytes,
      checksumOk: checksumOk(bytes, 0, len),
    }
  }

  /** Emit every complete frame currently buffered; a partial trailing frame stays buffered. */
  drain(): DecodedFrame[] {
    const out: DecodedFrame[] = []
    for (let f = this.next(); f !== null; f = this.next()) out.push(f)
    return out
  }

  /** Drop the buffered bytes (an unparseable frame) and return them for diagnostics. The radio
   * sends one frame per RFCOMM packet, so after discarding a bad packet the stream re-aligns at
   * the next chunk — corpus-verified (the one observed garble was a single self-delimited packet). */
  discardPending(): Uint8Array {
    const dropped = this.buf
    this.buf = new Uint8Array(0)
    return dropped
  }

  /** Bytes not yet consumed into a frame (a partial frame in flight). */
  get pending(): Uint8Array {
    return this.buf.slice()
  }

  /** True when bytes are buffered but not yet a complete frame — i.e. the caller drained all
   * complete frames (receiveBytes/drain loop to null) and what remains is a frame still arriving.
   * Cheap (no copy); used by the link layer to avoid transmitting mid-frame. */
  get hasPartialFrame(): boolean {
    return this.buf.length > 0
  }

  /** Length of the frame at the head of the buffer, or null if more bytes are needed. */
  private nextLength(): number | null {
    const buf = this.buf
    if (buf.length < 1) return null
    const head = buf[0]!

    if (head === READ_HEAD) {
      if (buf.length < 2) return null
      const reg = buf[1]!
      const spec = lengthForRead(reg)
      if (spec === undefined) {
        throw new FramingError(`unknown 04 register 0x${hex2(reg)}`, head, this.peek())
      }
      if (spec === 'variable') return this.variableLength(reg)
      return buf.length >= spec ? spec : null
    }

    const spec = lengthForHead(head)
    if (spec === undefined) {
      throw new FramingError(`unknown frame head 0x${hex2(head)}`, head, this.peek())
    }
    if (spec === 'variable') {
      // Sub-typed push (e.g. 5f): same checksum + next-head disambiguation as variable reads.
      return this.resolveVariable(candidateHeadLengths(head), head, `head ${hex2(head)}`)
    }
    return buf.length >= spec ? spec : null
  }

  /** Resolve a variable-length register frame to the LARGEST candidate length whose checksum
   * validates and is followed by a plausible head (or the buffer end).
   *
   * Largest-first matters: a big correct additive checksum is far stronger evidence than a small
   * COINCIDENTAL one. Ascending order truncated a 135-byte `04 4b` reply whose first 18 bytes
   * happened to checksum (a specific scan-list slot) down to 18 — orphaning 117 bytes that then
   * failed to frame → a framing incident on every scan-list enumeration. Trying 135 first accepts
   * the whole frame. If nothing validates but the buffer is still shorter than the largest
   * candidate, we may just be mid-frame ⇒ wait for more bytes; only a full buffer with no valid
   * interpretation is a real garble. */
  private variableLength(reg: number): number | null {
    return this.resolveVariable(candidateLengths(reg), READ_HEAD, `04 ${hex2(reg)}`)
  }

  /** Shared candidate resolution for variable-length frames (register reads AND sub-typed
   * heads): largest validating candidate wins; shorter-than-largest buffer may be mid-frame. */
  private resolveVariable(cands: number[], head: number, what: string): number | null {
    const buf = this.buf
    for (let i = cands.length - 1; i >= 0; i -= 1) {
      const len = cands[i]!
      if (buf.length < len) continue
      if (checksumOk(buf, 0, len) && (buf.length === len || this.plausibleHead(buf[len]!))) {
        return len
      }
    }
    if (buf.length < (cands[cands.length - 1] ?? 0)) return null
    throw new FramingError(`no candidate length validated for ${what}`, head, this.peek())
  }

  private peek(): Uint8Array {
    return this.buf.slice(0, Math.min(this.buf.length, 8))
  }
}
