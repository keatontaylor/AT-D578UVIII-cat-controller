// The full-stack integration rig: SimRadio ⇄ REAL Session (framer/link/ARQ/reducer) → REAL
// activeReceive → REAL Recorder (scripted PCM source, temp dir) — the exact wiring main.ts uses,
// under node:test mock timers so every cadence (ARQ ticker, scan-lock confirm, DMR frames, settle
// windows) is deterministic virtual time.
//
// Usage:
//   const rig = await Rig.create(t, { plug })   // enables t.mock.timers + connects
//   rig.sim.setCarrier('a', 3); await rig.advance(500)
//   rig.assertClean()                           // invariants + no framing incidents
//
// INVARIANTS are checked on every state emission (the reducer's one-event-one-broadcast contract
// means each emission must be internally consistent — there is no "between patches" excuse):
//   • the state parses against the RadioState schema
//   • scan.locked/paused imply scan.active
//   • pendingSide never equals selectedSide
//   • selectedSide never moves without a pendingSide first (no spontaneous side flips)
//   • dmr tuple fields stay in protocol range

import assert from 'node:assert/strict'
import { mkdtempSync, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { Recorder, type ClipMeta } from '../../src/audio/recorder'
import { activeReceive, audioGateOpen } from '../../src/domain/receive'
import { initialState, RadioState } from '../../src/domain/state'
import type { LinkConfig } from '../../src/link/link'
import { Session } from '../../src/services/session'
import { SimRadio, type SimCodeplug } from './sim-radio'

/** A codeplug most scenarios share: zone 0 mixes analog + DMR; zone 1 is analog; one scan list. */
export function defaultPlug(): SimCodeplug {
  return {
    firmware: 'SIM_D578_V1',
    dmrId: 3100001,
    callsign: 'SIMCALL',
    zones: [
      {
        name: 'FAVORITES',
        channels: [
          { name: 'LOCAL FM', rxMHz: 146.52, type: 'analog' },
          { name: 'RPT ALPHA', rxMHz: 147.06, shiftMHz: 0.6, type: 'analog', rxTone: { type: 'ctcss', value: 8 } },
          {
            name: 'MIDSOUTH',
            rxMHz: 444.7,
            shiftMHz: 5,
            type: 'digital',
            colorCode: 10,
            timeSlot: 2,
            contact: { callType: 'group', talkgroup: 43114, name: 'MIDSOUTH' },
          },
          {
            name: 'HOTSPOT',
            rxMHz: 438.8,
            type: 'digital',
            colorCode: 1,
            timeSlot: 1,
            contact: { callType: 'group', talkgroup: 310997, name: 'PARROT' },
          },
        ],
      },
      {
        name: 'GMRS',
        channels: [
          { name: 'GMRS 17', rxMHz: 462.6, type: 'analog' },
          { name: 'GMRS 19', rxMHz: 462.65, type: 'analog' },
        ],
      },
    ],
    scanLists: [
      { name: 'FIRE', members: [{ zone: 0, pos: 0 }, { zone: 0, pos: 1 }, { zone: 1, pos: 0 }] },
      { name: 'WX', members: [{ zone: 1, pos: 0 }, { zone: 1, pos: 1 }] },
    ],
  }
}

export interface RigOptions {
  readonly plug?: SimCodeplug
  /** Wire a real Recorder (enabled) fed by rig.feedAudio(). */
  readonly recorder?: boolean
  readonly linkConfig?: Partial<LinkConfig>
  /** RadioID-style caller resolution injected into the session (dmrCaller enrichment). */
  readonly resolveCaller?: (id: number) => { callsign: string | null; name: string | null; location: string | null } | null
  /** Virtual epoch for the mocked clock. */
  readonly epochMs?: number
  /** Shape the radio's state BEFORE the app connects (e.g. a scan already running). */
  readonly preConnect?: (sim: SimRadio) => void
}

const PCM_FRAME = Buffer.alloc(160) // one 10 ms 8 kHz S16LE frame (silence — content is irrelevant)

export class Rig {
  readonly states: RadioState[] = []
  readonly incidents: string[] = []
  readonly failures: string[] = []
  readonly violations: string[] = []
  /** PTT failsafe escalations (the session asking for a Bluetooth teardown). */
  readonly pttFailsafes: string[] = []
  recorder: Recorder | null = null
  recDir: string | null = null
  /** False during connect-time hydration (the 04 05 read may set selectedSide with no pending). */
  private hydrated = false
  private readonly audioSubs = new Set<(frame: Buffer) => void>()

  private constructor(
    private readonly t: TestContext,
    readonly sim: SimRadio,
    readonly session: Session,
  ) {}

  static async create(t: TestContext, opts: RigOptions = {}): Promise<Rig> {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: opts.epochMs ?? 1_750_000_000_000 })
    const sim = new SimRadio(opts.plug ?? defaultPlug(), () => Date.now())
    let rig: Rig
    const session = new Session(
      sim,
      { timeoutMs: 1000, maxAttempts: 3, gapMs: 0, ...opts.linkConfig },
      () => Date.now(),
      {
        onState: (s) => rig.onState(s),
        onFramingIncident: (d) => rig.incidents.push(d),
        onFailed: (c, reason) => rig.failures.push(`0x${c.op.toString(16)} ${reason}`),
        onPttFailsafe: (d) => rig.pttFailsafes.push(d),
        ...(opts.resolveCaller ? { resolveCaller: opts.resolveCaller } : {}),
      },
    )
    rig = new Rig(t, sim, session)
    if (opts.recorder) await rig.wireRecorder()
    opts.preConnect?.(sim)
    await session.connect({ wakeCount: 1, wakeDelayMs: 0 })
    await rig.flush()
    rig.hydrated = true
    t.after(async () => {
      session.close()
      sim.close()
      if (rig.recDir) await fsp.rm(rig.recDir, { recursive: true, force: true }).catch(() => {})
    })
    return rig
  }

  /** The exact recorder wiring main.ts uses: context = activeReceive over the live session state. */
  private async wireRecorder(): Promise<void> {
    this.recDir = mkdtempSync(join(tmpdir(), 'anytone-sim-rec-'))
    const source = { subscribe: async (cb: (f: Buffer) => void) => (this.audioSubs.add(cb), () => this.audioSubs.delete(cb)) }
    this.recorder = new Recorder(source, this.recDir, () => {
      const rs = this.session.state
      const recv = activeReceive(rs, audioGateOpen(rs)) // exact main.ts wiring (derived gate)
      return {
        squelchOpen: recv.open,
        side: recv.side,
        source: recv.source,
        aOpen: recv.aOpen,
        bOpen: recv.bOpen,
        channelName: recv.channelName,
        freqMHz: recv.freqMHz,
        mode: recv.mode,
        talkgroup: recv.talkgroup,
      }
    })
    await this.recorder.setEnabled(true)
  }

  // ── time control ────────────────────────────────────────────────────────────

  /** Let queued microtasks (promise chains through link/session) run. */
  async flush(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve()
  }

  /** Advance virtual time in 10 ms steps, flushing promise chains between steps so timer-driven
   * work (ARQ ticker, scan confirm, sim cadences) interleaves the way real time would. */
  async advance(ms: number, stepMs = 10): Promise<void> {
    let remaining = ms
    while (remaining > 0) {
      const step = Math.min(stepMs, remaining)
      this.t.mock.timers.tick(step)
      remaining -= step
      await this.flush(4)
    }
    await this.flush()
  }

  /** Feed PCM into the recorder while advancing time in lockstep (one 10 ms frame per 10 ms). */
  async feedAudio(ms: number): Promise<void> {
    for (let fed = 0; fed < ms; fed += 10) {
      for (const cb of this.audioSubs) cb(PCM_FRAME)
      this.t.mock.timers.tick(10)
      await this.flush(4)
    }
  }

  /** Let REAL event-loop I/O (recorder file writes) complete — setImmediate is not mocked. */
  async settleIo(rounds = 4): Promise<void> {
    for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r))
  }

  /** Saved clips, oldest first. Clip finalization is REAL fs I/O (mock timers don't cover the
   * threadpool), so poll until `expected` clips have landed (bounded) rather than guess rounds. */
  async clips(expected = 0): Promise<ClipMeta[]> {
    await this.settleIo(20)
    let list = (await this.recorder?.list()) ?? []
    for (let i = 0; i < 500 && list.length < expected; i += 1) {
      await this.settleIo(2)
      list = (await this.recorder?.list()) ?? []
    }
    return list.sort((a, b) => a.startedAt - b.startedAt)
  }

  get state(): RadioState {
    return this.session.state
  }

  // ── invariants ──────────────────────────────────────────────────────────────

  private onState(next: RadioState): void {
    const prev = this.states.length ? this.states[this.states.length - 1]! : initialState()
    this.states.push(next)
    const fail = (msg: string) => this.violations.push(`emission ${this.states.length}: ${msg}`)

    const parsed = RadioState.safeParse(next)
    if (!parsed.success) fail(`schema violation: ${parsed.error.issues[0]?.message}`)
    if (next.scan.locked && !next.scan.active) fail('scan.locked while scan inactive')
    if (next.scan.paused && !next.scan.active) fail('scan.paused while scan inactive')
    if (next.pendingSide !== null && next.pendingSide === next.selectedSide) {
      fail(`pendingSide ${next.pendingSide} equals selectedSide`)
    }
    if (this.hydrated && next.selectedSide !== prev.selectedSide && prev.pendingSide !== next.selectedSide) {
      // after hydration a side flip must be the ack of OUR pending select — never spontaneous
      fail(`selectedSide flipped ${prev.selectedSide}→${next.selectedSide} without pendingSide`)
    }
    const d = next.dmr
    if (d) {
      if (d.colorCode !== null && (d.colorCode < 0 || d.colorCode > 15)) fail(`dmr colorCode ${d.colorCode}`)
      if (d.slot !== null && d.slot !== 1 && d.slot !== 2) fail(`dmr slot ${d.slot}`)
    }
  }

  /** No invariant violations, no framing incidents, no failed commands (unless expected). */
  assertClean(opts: { allowFailures?: boolean } = {}): void {
    assert.deepEqual(this.violations, [], 'state invariant violations')
    assert.deepEqual(this.incidents, [], 'framing incidents')
    if (!opts.allowFailures) assert.deepEqual(this.failures, [], 'failed commands')
  }

  /** Compare the session's quiescent state against the sim's ground truth. Skips channel identity
   * on a scanning side (the host intentionally does not track silent hops). */
  expectConsistent(): void {
    const truth = this.sim.groundTruth()
    const s = this.state
    assert.equal(s.selectedSide, truth.selectedSide, 'selectedSide')
    assert.equal(s.audioGate, truth.gateOpen, 'squelchOpen (5b gate)')
    assert.equal(s.transmitting, truth.transmitting, 'transmitting')
    assert.equal(s.signal.aOpen, truth.rf.a.open, 'signal.aOpen (physical side A)')
    assert.equal(s.signal.bOpen, truth.rf.b.open, 'signal.bOpen (physical side B)')
    assert.equal(s.signal.aRssi, truth.rf.a.rssi, 'signal.aRssi')
    assert.equal(s.signal.bRssi, truth.rf.b.rssi, 'signal.bRssi')
    for (const k of ['a', 'b'] as const) {
      if (truth.scanning && this.sim.scanning?.side === k) {
        // The host intentionally does not track silent hops; on a CONFIRMED lock it reads the
        // channel identity back — but never the zone (a lock does not navigate zones).
        if (this.state.scan.locked) {
          assert.equal(s.sides[k].channelName, truth.sides[k].channelName, `side ${k} locked channelName`)
          assert.equal(s.sides[k].freqMHz, truth.sides[k].rxMHz, `side ${k} locked freqMHz`)
          assert.equal(s.sides[k].channelPosition, truth.sides[k].position, `side ${k} locked position`)
        }
        continue
      }
      assert.equal(s.sides[k].channelName, truth.sides[k].channelName, `side ${k} channelName`)
      assert.equal(s.sides[k].freqMHz, truth.sides[k].rxMHz, `side ${k} freqMHz`)
      assert.equal(s.sides[k].channelPosition, truth.sides[k].position, `side ${k} position`)
      assert.equal(s.sides[k].zoneNumber, truth.sides[k].zoneIndex, `side ${k} zoneNumber`)
      assert.equal(s.sides[k].zoneName, truth.sides[k].zoneName, `side ${k} zoneName`)
    }
  }
}
