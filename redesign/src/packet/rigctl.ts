// Minimal hamlib NET-rigctl server: just enough protocol for direwolf's `PTT RIG 2 <host:port>`
// to key/unkey the radio through OUR PTT machinery (radio-ACK gated, RX-quiet TX gate, deadman).
//
// The command set and every reply below were captured from the REAL exchange: direwolf 1.7 /
// hamlib 4.6.2 netrigctl → rigctld -m 1 (dummy) through a logging proxy (2026-07-11). On open,
// hamlib sends \get_powerstat, \chk_vfo, \dump_state, then v / l KEYSPD / f / s / m probes —
// all before any PTT. Only `T <0|1>` does real work; everything else is replayed verbatim.
//
// The rigctl protocol is synchronous — direwolf BLOCKS on each reply. That's the safety property
// this design leans on: we reply to `T 1` only after the radio ACKs the keydown, so direwolf's
// TXDELAY (and therefore the packet audio) cannot start before the transmitter is confirmed up.
// A failed/refused key replies `RPRT -1` and direwolf abandons that transmission cleanly.

import net from 'node:net'

/** PTT backend the server drives. `key()` resolves once the radio CONFIRMED the keydown (reject =
 * refused/timeout → RPRT -1); `unkey()` resolves once released (after any audio drain). */
export interface RigctlPtt {
  key(): Promise<void>
  unkey(): Promise<void>
  readonly keyed: boolean
}

// Captured verbatim from `rigctld -m 1` (hamlib 4.6.2) — the dummy rig's dump_state, which the
// same hamlib's netrigctl client (inside direwolf) is known to parse. Do not hand-edit.
const DUMP_STATE = `1
1
0
150000.000000 1500000000.000000 0x1ff -1 -1 0x17e00007 0xf
0 0 0 0 0 0 0
150000.000000 1500000000.000000 0x1ff 5000 100000 0x17e00007 0xf
0 0 0 0 0 0 0
0x1ff 1
0x1ff 0
0 0
0xc 2400
0xc 1800
0xc 3000
0xc 0
0x2 500
0x2 2400
0x2 50
0x2 0
0x10 300
0x10 2400
0x10 50
0x10 0
0x1 8000
0x1 2400
0x1 10000
0x20 15000
0x20 8000
0x40 230000
0 0
9990
9990
10000
0
10
10 20 30
0xffffffffffffffff
0xffffffffffffffff
0xfffffffff7ffffff
0xfffeff7083ffffff
0xffffffffffffffff
0xffffffffffffffbf
vfo_ops=0x7ffffff
ptt_type=0x0
targetable_vfo=0x10c3
has_set_vfo=1
has_get_vfo=1
has_set_freq=1
has_get_freq=1
has_set_conf=1
has_get_conf=1
has_power2mW=1
has_mW2power=1
has_get_ant=1
has_set_ant=1
timeout=0
rig_model=1
done
`

/** Reply for one rigctl command line, or null to close the connection. Exported for tests.
 * PTT lines resolve asynchronously (the caller must serialize per connection). */
export async function respond(line: string, ptt: RigctlPtt): Promise<string | null> {
  const cmd = line.trim()
  if (cmd === '' ) return ''
  if (cmd === '\\get_powerstat') return '1\n'
  if (cmd === '\\chk_vfo') return '0\n'
  if (cmd === '\\dump_state') return DUMP_STATE
  if (cmd === 'v') return 'VFOA\n'
  if (cmd === 'f') return '145000000\n'
  if (cmd === 'm') return 'FM\n15000\n'
  if (cmd === 's') return '0\nNone\n'
  if (cmd.startsWith('l ')) return '0\n'
  if (cmd === 't') return `${ptt.keyed ? 1 : 0}\n`
  if (cmd === 'q' || cmd === '\\quit') return null
  if (cmd === 'T 1' || cmd.startsWith('T 1 ')) {
    try {
      await ptt.key()
      return 'RPRT 0\n'
    } catch {
      return 'RPRT -1\n'
    }
  }
  if (cmd === 'T 0' || cmd.startsWith('T 0 ')) {
    try {
      await ptt.unkey()
      return 'RPRT 0\n'
    } catch {
      return 'RPRT -1\n'
    }
  }
  return 'RPRT -11\n' // RIG_ENAVAIL — not a command we emulate
}

/** TCP server hosting the protocol. One direwolf connects; commands are serialized per socket
 * (a blocking `T 1` must finish before the next line is answered). A socket dropping while it
 * holds PTT force-unkeys — direwolf crashing mid-transmission can never leave the radio keyed. */
export class RigctlServer {
  private server: net.Server | null = null
  private readonly sockets = new Set<net.Socket>()

  constructor(
    private readonly ptt: RigctlPtt,
    private readonly log: (m: string) => void = () => {},
  ) {}

  async listen(port: number, host = '127.0.0.1'): Promise<void> {
    if (this.server) return
    const server = net.createServer((socket) => {
      this.log(`rigctl: client connected`)
      this.sockets.add(socket)
      let buf = ''
      let chain: Promise<void> = Promise.resolve()
      socket.on('data', (d) => {
        buf += d.toString('utf8')
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          chain = chain.then(async () => {
            const reply = await respond(line, this.ptt)
            if (reply === null) socket.end('RPRT 0\n')
            else if (reply !== '' && !socket.destroyed) socket.write(reply)
          })
        }
      })
      const bail = (): void => {
        this.sockets.delete(socket)
        this.log('rigctl: client gone')
        // deadman: whoever keyed through this socket can no longer release it
        if (this.ptt.keyed) void this.ptt.unkey().catch(() => {})
      }
      socket.on('close', bail)
      socket.on('error', () => socket.destroy())
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => resolve())
    })
    this.log(`rigctl: listening on ${host}:${port}`)
  }

  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    // Sever live clients too: server.close() alone waits for existing connections (teardown
    // would block on direwolf's exit), and an open socket could still issue a T 1 mid-teardown.
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
