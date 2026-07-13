// Native AF_BLUETOOTH RFCOMM transport (ARCHITECTURE transport layer; CONNECTION_AND_COMPONENTS).
// The one hardware-touching implementation of the Transport seam — ported from the proven PoC
// (app/rfcomm-socket.mjs).
//
// WHY a raw socket (not /dev/rfcommN + serialport): the kernel TTY line discipline merges/splits
// our writes across RFCOMM packets and flattens inbound packet boundaries. Talking RFCOMM
// directly gives one write() => one RFCOMM packet — the clean 1:1 framing the real BT-01 uses.
// Node has no AF_BLUETOOTH support and libuv can't classify a BT fd, so we use libc via koffi
// and a small non-blocking read poll (our protocol is low-rate request/response).

import koffi from 'koffi'
import type { Transport } from './types'

// Linux ABI constants
const AF_BLUETOOTH = 31
const SOCK_STREAM = 1
const BTPROTO_RFCOMM = 3
const F_GETFL = 3
const F_SETFL = 4
const O_NONBLOCK = 0o4000
const SOL_SOCKET = 1
const SO_ERROR = 4
const POLLOUT = 0x004
const EINPROGRESS = 115
const EAGAIN = 11 // == EWOULDBLOCK on Linux

const READ_BUF_SIZE = 8192

/** struct sockaddr_rc: uint16 family + 6-byte bdaddr (reversed) + uint8 channel, padded to 10.
 * Pure — no FFI — so it is unit-testable offline. */
export function sockaddrRc(mac: string, channel: number): Buffer {
  const buf = Buffer.alloc(10)
  buf.writeUInt16LE(AF_BLUETOOTH, 0)
  const octets = mac.split(':').map((h) => parseInt(h, 16))
  if (octets.length !== 6 || octets.some((n) => Number.isNaN(n))) {
    throw new Error(`invalid BT MAC: ${mac}`)
  }
  for (let i = 0; i < 6; i += 1) buf[2 + i] = octets[5 - i]! // bdaddr is reversed
  buf[8] = channel & 0xff
  return buf
}

// Lazily bound libc functions — so importing this module has no side effects (the pure
// sockaddrRc can be tested without loading FFI / requiring Linux).
interface Libc {
  socket: (domain: number, type: number, protocol: number) => number
  connect: (fd: number, addr: Buffer, len: number) => number
  close: (fd: number) => number
  fcntl: (fd: number, cmd: number, arg: number) => number
  getsockopt: (fd: number, level: number, opt: number, val: Buffer, len: Buffer) => number
  poll: (fds: Buffer, nfds: number, timeout: number) => number
  read: (fd: number, buf: Buffer, count: number) => number | bigint
  write: (fd: number, buf: Buffer, count: number) => number | bigint
}

let cached: Libc | null = null
function libc(): Libc {
  if (cached) return cached
  const lib = koffi.load('libc.so.6')
  cached = {
    socket: lib.func('int socket(int domain, int type, int protocol)') as Libc['socket'],
    connect: lib.func('int connect(int fd, void *addr, unsigned int len)') as Libc['connect'],
    close: lib.func('int close(int fd)') as Libc['close'],
    fcntl: lib.func('int fcntl(int fd, int cmd, int arg)') as Libc['fcntl'],
    getsockopt: lib.func('int getsockopt(int fd, int level, int optname, void *optval, void *optlen)') as Libc['getsockopt'],
    poll: lib.func('int poll(void *fds, unsigned long nfds, int timeout)') as Libc['poll'],
    read: lib.func('long read(int fd, void *buf, size_t count)') as Libc['read'],
    write: lib.func('long write(int fd, void *buf, size_t count)') as Libc['write'],
  }
  return cached
}

// What each RFCOMM connect errno MEANS for the operator — the raw "SO_ERROR 111" is useless to an
// end user. 111 in particular is the everyday case: the radio was just powered on and its SPP
// service isn't listening yet (pairing/ACL/HFP can already succeed while SPP still refuses).
const CONNECT_ERRNO_HINTS: Record<number, string> = {
  13: 'Bluetooth authentication failed — the radio may need to be re-paired',
  16: "The radio's Bluetooth is busy — another device or session may be connected",
  110: 'The radio did not respond to the connection attempt',
  111: 'The radio refused the connection — it is likely still booting, or its Bluetooth is not ready yet',
  112: 'The radio is unreachable — it looks powered off or out of range',
  113: 'The radio is unreachable — it looks powered off or out of range',
}

/** Human-first message for an RFCOMM connect failure (technical detail kept for the logs).
 * PURE — unit-tested offline. */
export function describeConnectFailure(mac: string, channel: number, errno: number): string {
  const tech = `connect ${mac} ch${channel}, errno ${errno}`
  const hint = CONNECT_ERRNO_HINTS[errno]
  return hint ? `${hint} (${tech})` : `Bluetooth connection failed (${tech})`
}

/** Blocking-with-timeout RFCOMM connect → a connected non-blocking fd, or throws. Always
 * closes the fd on failure so a descriptor is never leaked. */
function connectRfcommFd(mac: string, channel: number, timeoutMs: number): number {
  const c = libc()
  const fd = c.socket(AF_BLUETOOTH, SOCK_STREAM, BTPROTO_RFCOMM)
  if (fd < 0) throw new Error(`socket(AF_BLUETOOTH) failed (errno ${koffi.errno()})`)
  try {
    const flags = c.fcntl(fd, F_GETFL, 0)
    c.fcntl(fd, F_SETFL, flags | O_NONBLOCK)

    const addr = sockaddrRc(mac, channel)
    const rc = c.connect(fd, addr, addr.length)
    if (rc !== 0) {
      const e = koffi.errno()
      if (e !== EINPROGRESS) throw new Error(describeConnectFailure(mac, channel, e))
      const pollfd = Buffer.alloc(8)
      pollfd.writeInt32LE(fd, 0)
      pollfd.writeInt16LE(POLLOUT, 4)
      const n = c.poll(pollfd, 1, timeoutMs)
      if (n === 0) throw new Error(`The radio did not respond within ${timeoutMs}ms (connect ${mac} ch${channel})`)
      if (n < 0) throw new Error(`poll() failed (errno ${koffi.errno()})`)
      const optval = Buffer.alloc(4)
      const optlen = Buffer.alloc(4)
      optlen.writeUInt32LE(4, 0)
      c.getsockopt(fd, SOL_SOCKET, SO_ERROR, optval, optlen)
      const soErr = optval.readUInt32LE(0)
      if (soErr !== 0) throw new Error(describeConnectFailure(mac, channel, soErr))
    }
    return fd
  } catch (err) {
    c.close(fd)
    throw err
  }
}

export interface RfcommOptions {
  readonly connectTimeoutMs?: number
  readonly readPollMs?: number
  /** Log every TX/RX chunk as hex (diagnostics). */
  readonly debug?: boolean
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ')

export class RfcommTransport implements Transport {
  private fd = -1
  private open = false
  private readTimer: ReturnType<typeof setInterval> | null = null
  private readonly readBuf = Buffer.allocUnsafe(READ_BUF_SIZE)
  private dataHandler: (chunk: Uint8Array) => void = () => {}
  private closeHandler: () => void = () => {}
  private readonly connectTimeoutMs: number
  private readonly readPollMs: number
  private readonly debug: boolean

  constructor(
    private readonly mac: string,
    private readonly channel: number,
    opts: RfcommOptions = {},
  ) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 12000
    this.readPollMs = opts.readPollMs ?? 8
    this.debug = opts.debug ?? false
  }

  get isOpen(): boolean {
    return this.open && this.fd >= 0
  }

  /** Connect the socket and start the read poll. Register onData/onClose first (the Session
   * does this in its constructor). Throws on connect failure. */
  connect(): void {
    this.fd = connectRfcommFd(this.mac, this.channel, this.connectTimeoutMs)
    this.open = true
    this.readTimer = setInterval(() => this.pump(), this.readPollMs)
    this.readTimer.unref?.()
  }

  onData(handler: (chunk: Uint8Array) => void): void {
    this.dataHandler = handler
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }

  write(bytes: Uint8Array): void {
    if (!this.isOpen) throw new Error('RFCOMM socket is not open')
    if (this.debug) console.log(`TX [${bytes.length}] ${hex(bytes)}`)
    const c = libc()
    let buf = Buffer.from(bytes)
    let attempts = 0
    for (;;) {
      const n = Number(c.write(this.fd, buf, buf.length))
      if (n === buf.length) return
      if (n >= 0) {
        buf = buf.subarray(n) // partial write (not expected for our tiny frames)
        continue
      }
      const e = koffi.errno()
      if (e === EAGAIN && attempts++ < 50) continue // socket buffer momentarily full
      throw new Error(`write() failed (errno ${e})`)
    }
  }

  close(): void {
    this.teardown()
  }

  /** Drain whatever the kernel has this tick → onData. EAGAIN is the common no-op; EOF / hard
   * error tears down and fires onClose. */
  private pump(): void {
    if (!this.isOpen) return
    const c = libc()
    for (;;) {
      const n = Number(c.read(this.fd, this.readBuf, READ_BUF_SIZE))
      if (n > 0) {
        const chunk = Buffer.from(this.readBuf.subarray(0, n))
        if (this.debug) console.log(`RX [${n}] ${hex(chunk)}`)
        this.dataHandler(chunk)
        if (n < READ_BUF_SIZE) break
        continue
      }
      if (n === 0) return this.fail('peer closed the connection (EOF)') // must be visible in long-run logs
      const e = koffi.errno()
      if (e === EAGAIN) break // nothing to read right now
      return this.fail(`read() failed (errno ${e})`)
    }
  }

  private fail(reason?: string): void {
    const wasOpen = this.open
    if (reason) console.error(`[rfcomm] ${reason}`)
    this.teardown()
    if (wasOpen) this.closeHandler()
  }

  private teardown(): void {
    this.open = false
    if (this.readTimer) {
      clearInterval(this.readTimer)
      this.readTimer = null
    }
    if (this.fd >= 0) {
      try {
        libc().close(this.fd)
      } catch {
        /* ignore */
      }
      this.fd = -1
    }
  }
}
