// Packet TNC service + rigctl shim. The rigctl replies are pinned to the REAL dialogue captured
// from direwolf 1.7 / hamlib 4.6.2 (see src/packet/rigctl.ts) — if these break, direwolf's rig
// open handshake breaks. The service tests fake spawn/capture/radio so nothing real runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createSocket } from 'node:dgram'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { respond, RigctlServer, type RigctlPtt } from '../src/packet/rigctl'
import { PacketService, renderConfig, type PacketOptions, type PacketRadio } from '../src/packet/service'

// ── rigctl protocol ──────────────────────────────────────────────────────────

function fakePtt(overrides: Partial<RigctlPtt> = {}): RigctlPtt & { keyCalls: number; unkeyCalls: number } {
  const ptt = {
    keyCalls: 0,
    unkeyCalls: 0,
    keyed: false,
    async key() {
      ptt.keyCalls += 1
      ptt.keyed = true
    },
    async unkey() {
      ptt.unkeyCalls += 1
      ptt.keyed = false
    },
    ...overrides,
  }
  return ptt as RigctlPtt & { keyCalls: number; unkeyCalls: number }
}

void test('rigctl: replays the captured hamlib open handshake', async () => {
  const ptt = fakePtt()
  assert.equal(await respond('\\get_powerstat', ptt), '1\n')
  assert.equal(await respond('\\chk_vfo', ptt), '0\n')
  const dump = await respond('\\dump_state', ptt)
  assert.ok(dump!.startsWith('1\n1\n0\n'))
  assert.ok(dump!.endsWith('done\n'))
  assert.equal(await respond('v', ptt), 'VFOA\n')
  assert.equal(await respond('m', ptt), 'FM\n15000\n')
  assert.equal(await respond('s', ptt), '0\nNone\n')
  assert.equal(await respond('l KEYSPD', ptt), '0\n')
  assert.equal(await respond('\\bogus', ptt), 'RPRT -11\n')
  assert.equal(await respond('q', ptt), null)
})

void test('rigctl: T 1 keys (only after the ptt confirms) and t reflects it', async () => {
  const ptt = fakePtt()
  assert.equal(await respond('t', ptt), '0\n')
  assert.equal(await respond('T 1', ptt), 'RPRT 0\n')
  assert.equal(ptt.keyCalls, 1)
  assert.equal(await respond('t', ptt), '1\n')
  assert.equal(await respond('T 0', ptt), 'RPRT 0\n')
  assert.equal(ptt.unkeyCalls, 1)
  assert.equal(await respond('t', ptt), '0\n')
})

void test('rigctl: a refused key replies RPRT -1 (direwolf aborts the transmission)', async () => {
  const ptt = fakePtt({
    key: async () => {
      throw new Error('busy')
    },
  })
  assert.equal(await respond('T 1', ptt), 'RPRT -1\n')
})

void test('rigctl server: serves a live socket and force-unkeys on disconnect', async () => {
  const ptt = fakePtt()
  const server = new RigctlServer(ptt)
  const port = 14000 + Math.floor(Math.random() * 1000)
  await server.listen(port)
  try {
    const sock = net.connect(port, '127.0.0.1')
    await new Promise<void>((resolve) => sock.once('connect', resolve))
    let rx = ''
    sock.on('data', (d) => (rx += d.toString()))
    sock.write('\\chk_vfo\nT 1\n')
    const until = Date.now() + 2000
    while (!rx.includes('RPRT 0') && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    assert.ok(rx.startsWith('0\n'), `handshake reply first: ${JSON.stringify(rx)}`)
    assert.ok(rx.includes('RPRT 0\n'), `key acked: ${JSON.stringify(rx)}`)
    assert.equal(ptt.keyed, true)
    // direwolf dies mid-transmission → the socket drops → the transmitter MUST release
    sock.destroy()
    const until2 = Date.now() + 2000
    while (ptt.keyed && Date.now() < until2) await new Promise((r) => setTimeout(r, 10))
    assert.equal(ptt.keyed, false)
    assert.equal(ptt.unkeyCalls, 1)
  } finally {
    await server.close()
  }
})

// ── service (all process/audio boundaries faked) ─────────────────────────────

class FakeProc extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = Object.assign(new EventEmitter(), {
    writable: true,
    chunks: [] as Buffer[],
    write(b: Buffer) {
      this.chunks.push(b)
      return true
    },
  })
  killed = false
  kill(): boolean {
    this.killed = true
    this.emit('close', 0)
    return true
  }
}

interface Rig {
  service: PacketService
  procs: Map<string, FakeProc[]>
  taps: Array<(f: Buffer) => void>
  untapped: { count: number }
  radio: PacketRadio & {
    phase: 'idle' | 'keying' | 'keyed' | 'unkeying' | 'fault'
    refusal: string | null
    keys: number
    unkeys: number
    busy: boolean
    dropKeys: number
  }
  opts: PacketOptions
  logs: string[]
}

async function makeRig(): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'packet-test-'))
  const procs = new Map<string, FakeProc[]>()
  const taps: Array<(f: Buffer) => void> = []
  const untapped = { count: 0 }
  const logs: string[] = []
  const radio = {
    phase: 'idle' as 'idle' | 'keying' | 'keyed' | 'unkeying' | 'fault',
    refusal: null as string | null,
    keys: 0,
    unkeys: 0,
    busy: false,
    /** Simulate the busy-gate eating the first wire send: the SESSION's bounded retransmits
     * recover it internally (one key() call, late confirm) — the packet layer never re-calls. */
    dropKeys: 0,
    key() {
      this.keys += 1
      if (this.dropKeys > 0) {
        this.dropKeys -= 1
        this.phase = 'keying' // first send eaten; the session's retry confirms a beat later
        setTimeout(() => {
          if (this.phase === 'keying') this.phase = 'keyed'
        }, 150).unref?.()
        return
      }
      this.phase = 'keyed' // radio ACK, compressed for the test
    },
    unkey() {
      this.unkeys += 1
      this.phase = 'idle'
    },
    pttPhase() {
      return this.phase
    },
    txRefusal() {
      return this.refusal
    },
    rxBusy() {
      return this.busy
    },
  }
  const opts: PacketOptions = {
    callsign: 'T3ST',
    kissPort: 18001,
    agwPort: 18000,
    udpPort: 15000 + Math.floor(Math.random() * 1000),
    rigctlPort: 16000 + Math.floor(Math.random() * 1000),
    playbackDevice: 'plughw:CARD=Loopback,DEV=0',
    captureDevice: 'plughw:CARD=Loopback,DEV=1',
    confPath: join(dir, 'direwolf.conf'),
    mdnsName: 'Test TNC',
    rxDevice: null,
    txDelay: 70,
    txTail: 5,
  }
  const spawnFn = ((command: string) => {
    const proc = new FakeProc()
    const list = procs.get(command) ?? []
    list.push(proc)
    procs.set(command, list)
    return proc
  }) as unknown as typeof import('node:child_process').spawn
  const service = new PacketService(
    {
      subscribe: async (onFrame) => {
        taps.push(onFrame)
        return () => {
          untapped.count += 1
        }
      },
    },
    () => ({ command: 'sink-cmd', args: ['a'] }),
    radio,
    opts,
    (m) => logs.push(m),
    spawnFn,
  )
  return { service, procs, taps, untapped, radio, opts, logs }
}

void test('packet: enable renders config, taps RX to UDP, spawns modem; disable tears down', async () => {
  const rig = await makeRig()
  // a listener standing in for direwolf's udp: audio input
  const udp = createSocket('udp4')
  const got: Buffer[] = []
  udp.on('message', (m) => got.push(m))
  await new Promise<void>((resolve) => udp.bind(rig.opts.udpPort, '127.0.0.1', resolve))
  try {
    const status = await rig.service.enable()
    assert.equal(status.enabled, true)
    assert.equal(status.running, true)

    const conf = await readFile(rig.opts.confPath, 'utf8')
    assert.match(conf, /ADEVICE udp:\d+ plughw:CARD=Loopback,DEV=0/)
    assert.match(conf, /ARATE 8000/)
    assert.match(conf, /MODEM 1200/)
    assert.match(conf, new RegExp(`PTT RIG 2 127\\.0\\.0\\.1:${rig.opts.rigctlPort}`))
    assert.match(conf, /KISSPORT 18001/)
    assert.match(conf, /AGWPORT 18000/)

    assert.equal(rig.procs.get('direwolf')?.length, 1)
    assert.equal(rig.procs.get('arecord')?.length, 1)
    assert.equal(rig.taps.length, 1)
    // Bonjour advertisement (RadioMail/PacketCommander discovery) rides the same lifecycle
    assert.equal(rig.procs.get('avahi-publish-service')?.length, 1)

    // an RX frame fans out to the UDP tap
    rig.taps[0]!(Buffer.from([1, 2, 3, 4]))
    const until = Date.now() + 2000
    while (got.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    assert.equal(got.length, 1)
    assert.deepEqual([...got[0]!], [1, 2, 3, 4])

    const off = await rig.service.disable()
    assert.equal(off.enabled, false)
    assert.equal(rig.untapped.count, 1)
    assert.equal(rig.procs.get('direwolf')![0]!.killed, true)
    assert.equal(rig.procs.get('arecord')![0]!.killed, true)
    assert.equal(rig.procs.get('avahi-publish-service')![0]!.killed, true)
  } finally {
    udp.close()
    await rig.service.disable().catch(() => {})
  }
})

void test('packet: PTT keys through the radio, forwards loopback TX audio, releases clean', async () => {
  const rig = await makeRig()
  try {
    await rig.service.enable()
    await rig.service.key()
    assert.equal(rig.radio.keys, 1)
    assert.equal(rig.service.keyed, true)
    const sink = rig.procs.get('sink-cmd')![0]!
    // direwolf's TX audio arrives on the loopback mirror → forwarded to the radio sink
    rig.procs.get('arecord')![0]!.stdout.emit('data', Buffer.alloc(320))
    assert.equal(sink.stdin.chunks.length, 1)
    await rig.service.unkey()
    assert.equal(rig.radio.unkeys, 1)
    assert.equal(rig.service.keyed, false)
    assert.equal(sink.killed, true)
    // after release, stray loopback audio must NOT reach the radio
    rig.procs.get('arecord')![0]!.stdout.emit('data', Buffer.alloc(320))
    assert.equal(sink.stdin.chunks.length, 1)
  } finally {
    await rig.service.disable().catch(() => {})
  }
})

void test('packet: key refused while the transmitter is busy or the channel is digital', async () => {
  const rig = await makeRig()
  try {
    await rig.service.enable()
    rig.radio.refusal = 'selected channel is digital'
    await assert.rejects(() => rig.service.key(), /digital/)
    rig.radio.refusal = null
    rig.radio.phase = 'keyed' // someone else (web PTT) is transmitting
    await assert.rejects(() => rig.service.key(), /busy/)
    assert.equal(rig.radio.keys, 0)
  } finally {
    await rig.service.disable().catch(() => {})
  }
})

void test('packet: a swallowed keydown recovers via the session retries — ONE packet-level attempt', async () => {
  const rig = await makeRig()
  try {
    await rig.service.enable()
    rig.radio.dropKeys = 1 // firmware busy-gate eats the first wire send; the session retry lands
    await rig.service.key()
    assert.equal(rig.radio.keys, 1, 'the packet layer keys once and waits for the outcome')
    assert.equal(rig.service.keyed, true)
  } finally {
    await rig.service.disable().catch(() => {})
  }
})

void test('packet: keydown waits for the radio to stop receiving (radio-truth DCD)', async () => {
  const rig = await makeRig()
  try {
    await rig.service.enable()
    rig.radio.busy = true
    const keyP = rig.service.key()
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(rig.radio.keys, 0) // held while the channel is busy
    rig.radio.busy = false
    await keyP
    assert.equal(rig.radio.keys, 1)
    assert.equal(rig.service.keyed, true)
  } finally {
    await rig.service.disable().catch(() => {})
  }
})

void test('packet: decoded frames on direwolf stdout update the counters', async () => {
  const rig = await makeRig()
  try {
    await rig.service.enable()
    const dw = rig.procs.get('direwolf')![0]!
    dw.stdout.emit('data', Buffer.from('W1ABC-9 audio level = 52(21/12)   [NONE]   ___|||___\n'))
    dw.stdout.emit('data', Buffer.from('[0.3] W1ABC-9>APRS,WIDE1-1:!4237.14N/07120.83W>Test\n'))
    assert.equal(rig.service.status.decodes, 1)
    assert.match(rig.service.status.lastHeard!, /^W1ABC-9>APRS/)
    // audio-level / info lines are not frames
    dw.stdout.emit('data', Buffer.from('Ready to accept KISS TCP client application 0 on port 18001 ...\n'))
    assert.equal(rig.service.status.decodes, 1)
    // KISS parameter overrides from a client MUST surface in the log (they replace our TXDELAY)
    dw.stdout.emit('data', Buffer.from('KISS protocol set TXDELAY = 30, chan 0\n'))
    assert.ok(rig.logs.some((l) => /KISS protocol set TXDELAY = 30/.test(l)))
  } finally {
    await rig.service.disable().catch(() => {})
  }
})

void test('packet: disable mid-transmission force-releases without the drain wait', async () => {
  const rig = await makeRig()
  try {
    await rig.service.enable()
    await rig.service.key()
    assert.equal(rig.service.keyed, true)
    await rig.service.disable()
    assert.equal(rig.service.keyed, false)
    assert.equal(rig.radio.unkeys, 1)
  } finally {
    await rig.service.disable().catch(() => {})
  }
})

void test('packet: disable during the channel-clear wait aborts the keydown before it commits', async () => {
  const rig = await makeRig()
  try {
    await rig.service.enable()
    rig.radio.busy = true // key() parks in the RX-quiet wait
    const keyP = rig.service.key()
    await new Promise((r) => setTimeout(r, 80))
    await rig.service.disable()
    rig.radio.busy = false // channel clears AFTER the teardown
    await assert.rejects(keyP, /packet mode is off/)
    assert.equal(rig.radio.keys, 0) // the keydown was never issued
    assert.equal(rig.service.keyed, false)
  } finally {
    await rig.service.disable().catch(() => {})
  }
})

void test('packet: disable while the radio is confirming a keydown releases it (no orphan TX)', async () => {
  const rig = await makeRig()
  try {
    await rig.service.enable()
    // radio ACK is in flight: the keydown lands but confirmation arrives after the disable
    rig.radio.key = () => {
      rig.radio.keys += 1
      rig.radio.phase = 'keying'
    }
    const keyP = rig.service.key()
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(rig.radio.keys, 1) // keydown issued, still unconfirmed
    await rig.service.disable() // sees pttHeld=false — nothing for IT to release
    rig.radio.phase = 'keyed' // the radio's ACK arrives post-teardown
    await assert.rejects(keyP, /packet mode is off/)
    assert.equal(rig.radio.unkeys, 1) // key() itself released the orphaned keydown
    assert.equal(rig.service.keyed, false)
  } finally {
    await rig.service.disable().catch(() => {})
  }
})

void test('packet: disable during the unkey drain releases exactly once', async () => {
  const rig = await makeRig()
  try {
    await rig.service.enable()
    await rig.service.key()
    const unkeyP = rig.service.unkey() // parks in the drain-margin wait
    await new Promise((r) => setTimeout(r, 20))
    await rig.service.disable() // force-release wins the race
    assert.equal(rig.radio.unkeys, 1)
    await unkeyP // drain wait elapses; must see the release already happened
    assert.equal(rig.radio.unkeys, 1)
    assert.equal(rig.service.keyed, false)
  } finally {
    await rig.service.disable().catch(() => {})
  }
})

void test('rigctl server: close severs live clients instead of waiting on them', async () => {
  const ptt = fakePtt()
  const server = new RigctlServer(ptt)
  const port = 14000 + Math.floor(Math.random() * 1000)
  await server.listen(port)
  const sock = net.connect(port, '127.0.0.1')
  await new Promise<void>((resolve) => sock.once('connect', resolve))
  try {
    // a connected client would make bare server.close() wait forever
    const closed = server.close()
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 1500))
    assert.notEqual(await Promise.race([closed.then(() => 'closed'), timeout]), 'timeout')
  } finally {
    sock.destroy()
  }
})

void test('packet: renderConfig is deterministic and complete', () => {
  const conf = renderConfig({
    callsign: 'N0CALL',
    kissPort: 8001,
    agwPort: 8000,
    udpPort: 7355,
    rigctlPort: 4532,
    playbackDevice: 'plughw:CARD=Loopback,DEV=0',
    captureDevice: 'plughw:CARD=Loopback,DEV=1',
    confPath: 'direwolf.conf',
    mdnsName: 'AnyTone D578 TNC',
    rxDevice: null,
    txDelay: 70,
    txTail: 5,
  })
  for (const line of ['ADEVICE udp:7355 plughw:CARD=Loopback,DEV=0', 'ARATE 8000', 'ACHANNELS 1', 'MYCALL N0CALL', 'MODEM 1200', 'PTT RIG 2 127.0.0.1:4532', 'TXDELAY 70', 'TXTAIL 5', 'KISSPORT 8001', 'AGWPORT 8000']) {
    assert.ok(conf.includes(`${line}\n`), `missing: ${line}`)
  }
})

void test('packet: a wired rxDevice gives direwolf a private 48 kHz capture (no shared tap)', async () => {
  const rig = await makeRig()
  ;(rig.opts as { rxDevice: string | null }).rxDevice = 'plughw:CARD=RadioTop,DEV=0'
  const udp = createSocket('udp4')
  const got: Buffer[] = []
  udp.on('message', (m) => got.push(m))
  await new Promise<void>((resolve) => udp.bind(rig.opts.udpPort, '127.0.0.1', resolve))
  try {
    await rig.service.enable()
    // no shared-tap subscription; a dedicated arecord on the wired device instead
    assert.equal(rig.taps.length, 0)
    const captures = rig.procs.get('arecord')!
    assert.equal(captures.length, 2) // loopback mirror + wired RX
    const conf = await readFile(rig.opts.confPath, 'utf8')
    assert.match(conf, /ARATE 48000/)
    // wired audio chunks stream to direwolf as ≤4 KB datagrams (startRxCapture spawns first)
    const wired = captures[0]!
    wired.stdout.emit('data', Buffer.alloc(10000, 1))
    const until = Date.now() + 2000
    while (got.length < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    assert.equal(got.length, 3)
    assert.deepEqual(got.map((g) => g.length), [4096, 4096, 1808])
  } finally {
    udp.close()
    await rig.service.disable().catch(() => {})
  }
})

void test('packet: direwolf audio-level reports surface on status', async () => {
  const rig = await makeRig()
  try {
    await rig.service.enable()
    const dw = rig.procs.get('direwolf')![0]!
    dw.stdout.emit('data', Buffer.from('W1ABC-9 audio level = 52(21/12)   [NONE]   ___|||___\n'))
    dw.stdout.emit('data', Buffer.from('[0.3] W1ABC-9>APRS:test\n'))
    assert.equal(rig.service.status.audioLevel, 52)
    assert.equal(rig.service.status.decodes, 1)
  } finally {
    await rig.service.disable().catch(() => {})
  }
})
