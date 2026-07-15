// Randomized consistency fuzz: a seeded interleaving of USER actions (side swap, channel/zone
// step, scan start/stop, PTT, manual dial) and RADIO events (carriers rising/falling, DMR calls
// starting/ending, scan hits) over virtual time — the "everything smashed together" test. After
// every action the per-emission invariants run (harness), and at each quiescence point the
// session's state must equal the sim's ground truth. Actions are gated the way the UI gates them
// (no side swap / steps during a scan), so the fuzz explores reachable operator behavior.
//
// Deterministic: a fixed seed reproduces the exact action trace, which is printed on failure.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Rig } from './sim/harness'

/** mulberry32 — tiny deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CALLS = [
  { colorCode: 10, slot: 2 as const, source: 3223436, dest: 43114 }, // MIDSOUTH's tuple
  { colorCode: 1, slot: 1 as const, source: 5042450, dest: 310997 }, // HOTSPOT's tuple
  { colorCode: 10, slot: 2 as const, source: 5042450, dest: 5042450 }, // monitored TG
] as const

async function fuzz(t: TestContext, seed: number, steps: number): Promise<void> {
  const rig = await Rig.create(t)
  const rand = prng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const trace: string[] = []
  const act = (name: string) => trace.push(name)

  let dmrUp = false
  let keyed = false
  let dialed = false

  try {
    for (let step = 0; step < steps; step += 1) {
      const scanning = rig.state.scan.active
      const roll = rand()

      if (roll < 0.12 && !scanning && !keyed) {
        const side = rig.state.selectedSide === 'a' ? 'b' : 'a'
        act(`swap→${side}`)
        rig.session.chooseSide(side)
      } else if (roll < 0.24 && !scanning && !keyed) {
        const side = pick(['a', 'b'] as const)
        const dir = pick([1, -1] as const)
        act(`chan ${side}${dir > 0 ? '+' : '-'}`)
        rig.session.stepChannel(side, dir)
      } else if (roll < 0.3 && !scanning && !keyed) {
        const side = pick(['a', 'b'] as const)
        const dir = pick([1, -1] as const)
        act(`zone ${side}${dir > 0 ? '+' : '-'}`)
        rig.session.stepZone(side, dir)
      } else if (roll < 0.42) {
        const side = pick(['a', 'b'] as const)
        const rssi = 1 + Math.floor(rand() * 4)
        act(`rf ${side}=${rssi}`)
        rig.sim.setCarrier(side, rssi)
      } else if (roll < 0.54) {
        const side = pick(['a', 'b'] as const)
        act(`rf ${side}=0`)
        rig.sim.clearCarrier(side)
      } else if (roll < 0.62 && !dmrUp && !keyed) {
        const call = pick(CALLS)
        act(`dmr rx TG${call.dest}`)
        rig.sim.startDmrCall({ direction: 'rx', ...call })
        dmrUp = true
      } else if (roll < 0.7 && dmrUp) {
        act('dmr end')
        rig.sim.endDmrCall()
        dmrUp = false
      } else if (roll < 0.76 && !scanning && !keyed && !dmrUp) {
        act('scan start')
        rig.session.startScan(rig.state.selectedSide, 0, 'FIRE')
      } else if (roll < 0.8 && scanning) {
        act('scan stop')
        rig.session.stopScan()
      } else if (roll < 0.84 && scanning && rig.sim.scanning && !rig.sim.scanning.landed) {
        act('scan hit')
        rig.sim.scanLand(1, Math.floor(rand() * 2), 1 + Math.floor(rand() * 4))
      } else if (roll < 0.87 && scanning && rig.sim.scanning?.landed) {
        act('scan clear')
        rig.sim.scanResume()
      } else if (roll < 0.92 && !keyed && !scanning && !dmrUp && rig.state.ptt === 'idle') {
        if (rand() < 0.3 && !dialed) {
          act('dial 5042450')
          rig.session.setManualDial('a', 5042450, 'group')
          dialed = true
        }
        act('key')
        rig.session.key()
        keyed = true
      } else if (keyed) {
        act('unkey')
        rig.session.unkey()
        keyed = false
      } else {
        act('idle')
      }

      await rig.advance(20 + Math.floor(rand() * 150))

      // Quiesce + full ground-truth comparison every ~12 steps: settle everything in flight,
      // clear TX/call transients, get past every settle window, refresh the meter, compare.
      if (step % 12 === 11) {
        if (keyed) {
          rig.session.unkey()
          keyed = false
        }
        if (dmrUp) {
          rig.sim.endDmrCall()
          dmrUp = false
        }
        act('quiesce')
        await rig.advance(1600)
        rig.sim.nudge()
        await rig.flush()
        rig.expectConsistent()
        assert.equal(rig.session.busy, false, 'nothing left in flight at quiescence')
      }
    }

    // final teardown to a clean quiescent state
    if (keyed) rig.session.unkey()
    if (dmrUp) rig.sim.endDmrCall()
    if (rig.state.scan.active) rig.session.stopScan()
    await rig.advance(2000)
    rig.sim.nudge()
    await rig.flush()
    rig.expectConsistent()
    rig.assertClean()
  } catch (e) {
    ;(e as Error).message += `\n\nseed ${seed} trace (${trace.length} steps):\n${trace.join(' → ')}`
    throw e
  }
}

for (const seed of [1, 42, 1337, 20260710]) {
  test(`fuzz seed ${seed}: 120 interleaved actions stay consistent with ground truth`, async (t) => {
    await fuzz(t, seed, 120)
  })
}
