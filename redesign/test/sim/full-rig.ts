// FullRig — the WHOLE product loop, radio to rendered pixels' inputs:
//
//   SimRadio ⇄ RadioController(real Session) → StateBroadcaster → [JSON wire] → MirrorClient
//                                                                       ↓
//                                                    vfoView (the UI's exact render derivations)
//
// The MirrorClient replays useRadio.ts's message handling VERBATIM (snapshot → state, patch →
// applyMergePatch + renullAfterPatch with the shared skip list), through a JSON round-trip like
// the real websocket. After EVERY publish the mirror must deep-equal the server's state — that is
// the /ws pipeline contract: what the frontend holds is what the backend knows, always, not just
// eventually. View assertions then run on the MIRROR state, i.e. on what the browser would
// actually render, through the same src/domain/view.ts functions the components call.

import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import type { TestContext } from 'node:test'
import { StateBroadcaster } from '../../src/api/broadcast'
import { APP_STATE_RENULL_SKIP_PATHS, applyStatePatch, renullAfterPatch } from '../../src/api/merge-patch'
import type { RpcNotification } from '../../src/api/jsonrpc'
import { RadioState } from '../../src/domain/state'
import { vfoView } from '../../src/domain/view'
import type { LinkConfig } from '../../src/link/link'
import { RadioController, type AppState } from '../../src/services/radio-service'
import { FakeAudio, FakeBt, ADDR } from '../controller-fakes'
import { defaultPlug } from './harness'
import { SimRadio, type SimCodeplug } from './sim-radio'

/** The exact client-side state maintenance from useRadio.ts, fed through a JSON round-trip
 * (what the websocket does to every message). */
export class MirrorClient {
  state: AppState | null = null
  patches = 0
  onMessage(raw: RpcNotification): void {
    const m = JSON.parse(JSON.stringify(raw)) as { method?: string; params?: unknown }
    if (m.method === 'state.snapshot') this.state = m.params as AppState
    else if (m.method === 'state.patch') {
      if (!this.state) return
      this.patches += 1
      const patched = applyStatePatch(this.state, m.params)
      this.state = renullAfterPatch(this.state, patched, APP_STATE_RENULL_SKIP_PATHS) as AppState
    }
  }
}

export interface FullRigOptions {
  readonly plug?: SimCodeplug
  readonly linkConfig?: Partial<LinkConfig>
  readonly reconnect?: boolean
  readonly epochMs?: number
  readonly resolveCaller?: (id: number) => { callsign: string | null; name: string | null; location: string | null } | null
  /** Shape the radio's state BEFORE the app connects (e.g. a scan already running). */
  readonly preConnect?: (sim: SimRadio) => void
}

export class FullRig {
  sim: SimRadio
  readonly mirror = new MirrorClient()
  readonly divergences: string[] = []
  readonly viewViolations: string[] = []
  /** Transports created — index 0 is the initial connect; more means reconnects happened. */
  connects = 0

  private constructor(
    private readonly t: TestContext,
    readonly controller: RadioController,
    readonly broadcaster: StateBroadcaster<AppState>,
    sim: SimRadio,
  ) {
    this.sim = sim
  }

  static async create(t: TestContext, opts: FullRigOptions = {}): Promise<FullRig> {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: opts.epochMs ?? 1_750_000_000_000 })
    const plug = opts.plug ?? defaultPlug()
    const sim = new SimRadio(plug, () => Date.now())
    let rig: FullRig
    const controller = new RadioController({
      bt: new FakeBt(),
      audio: new FakeAudio(),
      // Reconnects REOPEN the same physical radio (its channel/side state persists) — a fresh
      // transport, not a fresh radio.
      createTransport: () => {
        rig.connects += 1
        return rig.sim.reopen()
      },
      linkConfig: { timeoutMs: 1000, maxAttempts: 3, gapMs: 0, ...opts.linkConfig },
      now: () => Date.now(),
      connectOptions: { wakeCount: 1, wakeDelayMs: 0 },
      reconnect: opts.reconnect ?? false,
      reconnectBaseMs: 500,
      ...(opts.resolveCaller ? { resolveCaller: opts.resolveCaller } : {}),
    })
    const broadcaster = new StateBroadcaster(controller.appState)
    rig = new FullRig(t, controller, broadcaster, sim)
    // main.ts wiring: every controller change publishes a patch; the mirror consumes it and is
    // then compared against the published truth — the pipeline contract, checked on every patch.
    broadcaster.subscribe((msg) => rig.mirror.onMessage(msg))
    controller.onChange((s) => {
      broadcaster.publish(s)
      rig.checkMirror()
      rig.checkView()
    })
    opts.preConnect?.(sim)
    await controller.connect(ADDR)
    await rig.flush()
    t.after(() => {
      void controller.disconnect().catch(() => {})
      rig.sim.close()
    })
    return rig
  }

  // ── time control (same discipline as the session Rig) ────────────────────────
  async flush(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve()
  }
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

  /** What the CLIENT believes right now — every view assertion reads this, not the server state. */
  get client(): AppState {
    assert.ok(this.mirror.state, 'mirror has no snapshot yet')
    return this.mirror.state!
  }

  /** The two cards as the browser would render them, derived from the CLIENT state. */
  get cards(): { a: ReturnType<typeof vfoView>; b: ReturnType<typeof vfoView> } {
    const rs = this.client.radio
    const connected = this.client.connection === 'connected'
    return { a: vfoView(rs, 'a', connected), b: vfoView(rs, 'b', connected) }
  }

  // ── continuous checks ─────────────────────────────────────────────────────────

  /** The pipeline contract: after a publish, the mirror equals the published state exactly. */
  private checkMirror(): void {
    const server = JSON.parse(JSON.stringify(this.broadcaster.state)) as AppState
    if (!isDeepStrictEqual(this.mirror.state, server)) {
      this.divergences.push(
        `patch ${this.mirror.patches}: mirror diverged from server\n  server: ${JSON.stringify(server)}\n  mirror: ${JSON.stringify(this.mirror.state)}`,
      )
    }
  }

  /** Structural view invariants, evaluated on the CLIENT state after every patch. */
  private checkView(): void {
    const s = this.mirror.state
    if (!s || s.connection !== 'connected') return
    const fail = (m: string) => this.viewViolations.push(`patch ${this.mirror.patches}: ${m}`)
    const parsed = RadioState.safeParse(s.radio)
    if (!parsed.success) {
      fail(`client radio state fails the schema: ${parsed.error.issues[0]?.message}`)
      return
    }
    const a = vfoView(s.radio, 'a')
    const b = vfoView(s.radio, 'b')
    if (a.indicator === 'TX' && b.indicator === 'TX') fail('both cards show TX')
    if (a.indicator === 'TX' && !a.selected) fail('TX shown on the non-selected card')
    if (b.indicator === 'TX' && !b.selected) fail('TX shown on the non-selected card')
    if (a.dmrLive && b.dmrLive) fail('DMR live badge on both cards')
    if (a.scanBadge && b.scanBadge) fail('scan badge on both cards')
    if (s.radio.scan.active && (a.selectable || b.selectable)) fail('a card is selectable during a scan')
    if (a.selected === b.selected) fail('exactly one card must be selected')
  }

  assertClean(): void {
    assert.deepEqual(this.divergences, [], 'mirror/server divergences')
    assert.deepEqual(this.viewViolations, [], 'view invariant violations')
  }

  /** Client-side ground-truth comparison at quiescence: what the BROWSER believes (mirror state,
   * after the full patch pipeline) must match the sim — selected side, signal mapping, gate, and
   * each non-scanning side's channel identity. */
  expectClientConsistent(): void {
    const truth = this.sim.groundTruth()
    const rs = this.client.radio
    assert.equal(this.client.connection, 'connected', 'client sees connected')
    assert.equal(rs.selectedSide, truth.selectedSide, 'client selectedSide')
    assert.equal(rs.squelchOpen, truth.gateOpen, 'client squelchOpen')
    assert.equal(rs.signal.aOpen, truth.rf.a.open, 'client aOpen')
    assert.equal(rs.signal.bOpen, truth.rf.b.open, 'client bOpen')
    assert.equal(rs.signal.aRssi, truth.rf.a.rssi, 'client aRssi')
    assert.equal(rs.signal.bRssi, truth.rf.b.rssi, 'client bRssi')
    for (const k of ['a', 'b'] as const) {
      if (truth.scanning && this.sim.scanning?.side === k) continue
      assert.equal(rs.sides[k].channelName, truth.sides[k].channelName, `client side ${k} channelName`)
      assert.equal(rs.sides[k].freqMHz, truth.sides[k].rxMHz, `client side ${k} freqMHz`)
      assert.equal(rs.sides[k].zoneNumber, truth.sides[k].zoneIndex, `client side ${k} zoneNumber`)
    }
  }
}
