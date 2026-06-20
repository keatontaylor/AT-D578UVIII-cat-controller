// Raw Bluetooth RFCOMM socket transport, exposing the small slice of the
// node-serialport interface that anytone-server.mjs uses (isOpen / open /
// write / drain / close / 'data' / 'error' / 'close').
//
// WHY THIS EXISTS: the default transport binds /dev/rfcommN (a kernel TTY) and
// opens it with serialport. The TTY line discipline is a byte stream — it can
// merge or split our writes across RFCOMM packets and flattens the inbound
// packet boundaries. RFCOMM is itself a length-framed protocol, and the real
// BT-01 emits exactly one protocol frame per RFCOMM packet, giving the radio a
// clean boundary to parse. By talking RFCOMM directly (one write() => one
// send() => one RFCOMM packet) we reproduce that 1:1 framing and — hypothesis —
// avoid the frame-sync desync that the TTY path suffers over long sessions.
//
// Node has no built-in AF_BLUETOOTH support, so the socket and its I/O are done
// via libc FFI (koffi). We do NOT hand the fd to net.Socket: libuv's
// uv_guess_handle can't classify a Bluetooth socket ("Unsupported fd type:
// UNKNOWN"). Instead we drive a small non-blocking read poll on a timer — which
// is fine because our protocol is low-rate request/response and the read side
// upstream already polls at 15ms granularity.
import koffi from 'koffi'
import { EventEmitter } from 'node:events'

// Linux ABI constants.
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
const READ_POLL_MS = 8

const libc = koffi.load('libc.so.6')
const c_socket = libc.func('int socket(int domain, int type, int protocol)')
const c_connect = libc.func('int connect(int fd, void *addr, unsigned int len)')
const c_close = libc.func('int close(int fd)')
const c_fcntl = libc.func('int fcntl(int fd, int cmd, int arg)')
const c_getsockopt = libc.func('int getsockopt(int fd, int level, int optname, void *optval, void *optlen)')
const c_poll = libc.func('int poll(void *fds, unsigned long nfds, int timeout)')
const c_read = libc.func('long read(int fd, void *buf, size_t count)')
const c_write = libc.func('long write(int fd, void *buf, size_t count)')

// struct sockaddr_rc { sa_family_t rc_family; bdaddr_t rc_bdaddr; uint8_t rc_channel; }
// = uint16 family + 6-byte address (little-endian / reversed) + uint8 channel,
// padded to 10 bytes.
function sockaddrRc(mac, channel) {
  const buf = Buffer.alloc(10)
  buf.writeUInt16LE(AF_BLUETOOTH, 0)
  const octets = mac.split(':').map(h => parseInt(h, 16))
  if (octets.length !== 6 || octets.some(n => Number.isNaN(n))) throw new Error(`invalid BT MAC: ${mac}`)
  for (let i = 0; i < 6; i += 1) buf[2 + i] = octets[5 - i] // bdaddr is reversed
  buf[8] = channel & 0xff
  return buf
}

// Blocking-with-timeout RFCOMM connect. Returns a connected non-blocking fd, or
// throws. Always closes the fd on failure so we never leak a descriptor.
function connectRfcommFd(mac, channel, timeoutMs) {
  const fd = c_socket(AF_BLUETOOTH, SOCK_STREAM, BTPROTO_RFCOMM)
  if (fd < 0) throw new Error(`socket(AF_BLUETOOTH) failed (errno ${koffi.errno()})`)
  try {
    const flags = c_fcntl(fd, F_GETFL, 0)
    c_fcntl(fd, F_SETFL, flags | O_NONBLOCK)

    const addr = sockaddrRc(mac, channel)
    const rc = c_connect(fd, addr, addr.length)
    if (rc !== 0) {
      const err = koffi.errno()
      if (err !== EINPROGRESS) throw new Error(`connect(${mac} ch${channel}) failed (errno ${err})`)
      // Non-blocking connect in progress — wait for writability.
      const pollfd = Buffer.alloc(8)
      pollfd.writeInt32LE(fd, 0)
      pollfd.writeInt16LE(POLLOUT, 4)
      const n = c_poll(pollfd, 1, timeoutMs)
      if (n === 0) throw new Error(`connect(${mac} ch${channel}) timed out after ${timeoutMs}ms`)
      if (n < 0) throw new Error(`poll() failed (errno ${koffi.errno()})`)
      // Connection result is in SO_ERROR.
      const optval = Buffer.alloc(4)
      const optlen = Buffer.alloc(4)
      optlen.writeUInt32LE(4, 0)
      c_getsockopt(fd, SOL_SOCKET, SO_ERROR, optval, optlen)
      const soErr = optval.readUInt32LE(0)
      if (soErr !== 0) throw new Error(`connect(${mac} ch${channel}) failed (SO_ERROR ${soErr})`)
    }
    return fd
  } catch (err) {
    c_close(fd)
    throw err
  }
}

export class RfcommSocket extends EventEmitter {
  constructor(mac, channel, { connectTimeoutMs = 12000 } = {}) {
    super()
    this.mac = mac
    this.channel = channel
    this.connectTimeoutMs = connectTimeoutMs
    this.fd = -1
    this._open = false
    this._readTimer = null
    this._readBuf = Buffer.allocUnsafe(READ_BUF_SIZE)
  }

  get isOpen() {
    return this._open && this.fd >= 0
  }

  // Mirrors serialport's open(cb): connect, then start the non-blocking read poll.
  open(cb) {
    try {
      this.fd = connectRfcommFd(this.mac, this.channel, this.connectTimeoutMs)
    } catch (err) {
      if (cb) return cb(err)
      throw err
    }
    this._open = true
    this._readTimer = setInterval(() => this._pump(), READ_POLL_MS)
    if (this._readTimer.unref) this._readTimer.unref()
    if (cb) cb(null)
  }

  // Drain whatever the kernel has for us this tick; emit it as 'data'. EAGAIN
  // (no data) is the common case and a no-op. EOF (0) or a hard error closes.
  _pump() {
    if (!this.isOpen) return
    for (;;) {
      const n = Number(c_read(this.fd, this._readBuf, READ_BUF_SIZE))
      if (n > 0) {
        this.emit('data', Buffer.from(this._readBuf.subarray(0, n)))
        if (n < READ_BUF_SIZE) break // drained for now
        continue // buffer was full — read again
      }
      if (n === 0) { this._fail(null); return } // peer closed
      const err = koffi.errno()
      if (err === EAGAIN) break // nothing to read right now
      this._fail(new Error(`read() failed (errno ${err})`))
      return
    }
  }

  // One write() => one send() => one RFCOMM packet. Frames are tiny (<=35 bytes)
  // and we await each before the next, so a single non-blocking write completes
  // in one call; EAGAIN is retried briefly rather than splitting the packet.
  write(buf, cb) {
    if (!this.isOpen) {
      const err = new Error('RFCOMM socket is not open')
      if (cb) return cb(err)
      throw err
    }
    let attempts = 0
    for (;;) {
      const n = Number(c_write(this.fd, buf, buf.length))
      if (n === buf.length) { if (cb) cb(null); return }
      if (n >= 0) { // partial write (not expected for our tiny frames)
        buf = buf.subarray(n)
        continue
      }
      const err = koffi.errno()
      if (err === EAGAIN && attempts++ < 50) continue // socket buffer momentarily full
      const e = new Error(`write() failed (errno ${err})`)
      if (cb) return cb(e)
      throw e
    }
  }

  // The write above is synchronous-complete, so there is nothing extra to drain.
  drain(cb) {
    if (cb) cb(null)
  }

  close(cb) {
    this._teardown()
    if (cb) cb(null)
  }

  _fail(err) {
    const wasOpen = this._open
    this._teardown()
    if (err) this.emit('error', err)
    if (wasOpen) this.emit('close')
  }

  _teardown() {
    this._open = false
    if (this._readTimer) { clearInterval(this._readTimer); this._readTimer = null }
    if (this.fd >= 0) { try { c_close(this.fd) } catch { /* ignore */ } this.fd = -1 }
  }
}
