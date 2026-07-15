// SCO kick (EXPERIMENT — opt-in via ANYTONE_SCO_KICK=1): HF-initiated eSCO at audio-gate open.
//
// btmon (2026-07-13) proved the radio models every squelch opening as a fresh HFP call: it
// pushes `5b 01` on SPP instantly, but only starts its call choreography (+CIEV → eSCO setup)
// ~1.6 s later — so the first ~1.6 s of every cold-start transmission never crosses Bluetooth.
// HFP allows the hands-free side to initiate the audio connection, and our PTT path already
// proves the radio accepts that (opening the HFP sink brings eSCO up). Hypothesis under test:
// the radio+BT-01 are a matched pair — the accessory sees `5b` on SPP and requests audio
// immediately, and the radio's ~1.6 s self-setup is only a fallback for dumb headsets.
//
// Mechanism: on the rising edge of the derived audio gate, acquire the HFP sink (the proven
// SCO trigger) and feed it paced silence; release at gate close. If eSCO comes up at t≈0 AND
// carries voice early, the lost call heads are recovered. If the radio refuses, or grants a
// link that stays silent until its own +1.6 s mark, the delay is the radio's audio source
// itself and no transport trick can help — experiment falsified.
//
// Safety: PTT owns the sink while keyed, so the kick never arms while ptt != idle and releases
// the instant a key starts (including `fault` — the radio may still be transmitting). The radio
// hears our silence on its BT mic input; keep BT VOX off while experimenting.

import { spawn, type ChildProcess } from 'node:child_process'

export type SinkCommand = { command: string; args: readonly string[] }
/** Injection seam for tests — production default wires stdin and logs stderr. */
export type Spawner = (command: string, args: readonly string[]) => ChildProcess

/** One paced silence write: 100 ms of 8 kHz mono S16LE. */
const FEED_MS = 100
const FEED_BYTES = (8000 * 2 * FEED_MS) / 1000
/** Hard cap on one kick's sink hold — a stuck-open gate must never wedge the sink (and PTT'll
 * still preempt, but a runaway silence feed helps nobody). */
const MAX_HOLD_MS = 30_000

export type ScoKickSnapshot = {
  gateOpen: boolean
  pttBusy: boolean
  connected: boolean
}

export class ScoKick {
  private proc: ChildProcess | null = null
  private feeder: ReturnType<typeof setInterval> | null = null
  private cap: ReturnType<typeof setTimeout> | null = null
  private gate = false
  private armedAt = 0

  constructor(
    private readonly sink: () => SinkCommand | null,
    private readonly log: (message: string) => void = () => {},
    private readonly spawner: Spawner = (command, args) => spawn(command, [...args], { stdio: ['pipe', 'ignore', 'pipe'] }),
  ) {}

  get active(): boolean {
    return this.proc !== null
  }

  /** Drive from every state change; edge detection lives here so the wiring stays one line. */
  update(s: ScoKickSnapshot): void {
    const gate = s.gateOpen
    const rising = gate && !this.gate
    this.gate = gate
    if (s.pttBusy || !s.connected) {
      this.release(s.pttBusy ? 'ptt takes the sink' : 'disconnected')
      return
    }
    if (rising) this.arm()
    else if (!gate) this.release('gate closed')
  }

  private arm(): void {
    if (this.proc) return
    const cmd = this.sink()
    if (!cmd) return
    this.armedAt = Date.now()
    let proc: ChildProcess
    try {
      proc = this.spawner(cmd.command, cmd.args)
    } catch (e) {
      this.log(`arm failed: ${(e as Error).message}`)
      return
    }
    this.proc = proc
    proc.on('error', (err) => this.log(`sink error: ${err.message}`))
    proc.stderr?.on('data', (chunk: Buffer) => this.log(`sink stderr: ${chunk.toString().trim()}`))
    proc.on('close', (code) => {
      // Exit while we still consider it armed = bluealsa refused / dropped the transport — that
      // timing is the experiment's data, so log it loudly.
      if (this.proc === proc) {
        this.proc = null
        this.stopTimers()
        this.log(`sink exited (${code}) after ${Date.now() - this.armedAt} ms — released by the other end`)
      }
    })
    // Paced silence so the transport has I/O from the first instant (acquisition alone may not
    // trigger the SCO connect) without flooding the pipe.
    const silence = Buffer.alloc(FEED_BYTES)
    proc.stdin?.write(silence)
    this.feeder = setInterval(() => {
      if (proc.stdin?.writable) proc.stdin.write(silence)
    }, FEED_MS)
    this.cap = setTimeout(() => this.release('max hold reached'), MAX_HOLD_MS)
    this.log('armed — HF-side eSCO request at gate-open')
  }

  private release(reason: string): void {
    if (!this.proc) return
    const proc = this.proc
    this.proc = null
    this.stopTimers()
    proc.stdin?.end()
    proc.kill('SIGTERM')
    this.log(`released after ${Date.now() - this.armedAt} ms (${reason})`)
  }

  private stopTimers(): void {
    if (this.feeder) {
      clearInterval(this.feeder)
      this.feeder = null
    }
    if (this.cap) {
      clearTimeout(this.cap)
      this.cap = null
    }
  }
}
