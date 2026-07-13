// LONG-LIVED SOAK: hours of virtual time against the full product loop (SimRadio → controller →
// broadcaster → JSON wire → mirror client → view model), with LINK DROPS and auto-reconnects mixed
// into the seeded action stream. The mirror-equality contract and the view invariants run on every
// single patch (FullRig wires them); at each quiescence point the CLIENT's state — after the whole
// patch pipeline — must match the sim's ground truth. This is the "leave it running all day"
// test: drift, leaks of stale state across reconnects, patch-pipeline rot, render-rule
// inconsistencies all surface as a divergence with the reproducing seed + action trace.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FullRig } from './sim/full-rig'

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
  { colorCode: 10, slot: 2 as const, source: 43114, dest: 43114 }, // MIDSOUTH group
  { colorCode: 1, slot: 1 as const, source: 310997, dest: 310997 }, // HOTSPOT group
  { colorCode: 10, slot: 2 as const, source: 3223436, dest: 5042450 }, // private to a monitored id
] as const

async function soak(t: TestContext, seed: number, steps: number): Promise<void> {
  const rig = await FullRig.create(t, { reconnect: true })
  const rand = prng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const trace: string[] = []
  const act = (name: string) => trace.push(name)

  let dmrUp = false
  let keyed = false
  let quiesces = 0
  let drops = 0

  try {
    for (let step = 0; step < steps; step += 1) {
      const connected = rig.client.connection === 'connected'
      const scanning = connected && rig.client.radio.scan.active
      const roll = rand()

      if (!connected) {
        // mid-reconnect: the world keeps moving — RF changes while we're down
        if (roll < 0.3) {
          const side = pick(['a', 'b'] as const)
          act(`down:rf ${side}=${roll < 0.15 ? 0 : 3}`)
          if (roll < 0.15) rig.sim.clearCarrier(side)
          else rig.sim.setCarrier(side, 3)
        } else {
          act('down:wait')
        }
        await rig.advance(300 + Math.floor(rand() * 500))
        continue
      }

      if (roll < 0.04 && !scanning && !keyed && !dmrUp) {
        act('DROP LINK')
        drops += 1
        rig.sim.dropLink()
      } else if (roll < 0.14 && !scanning && !keyed) {
        const side = rig.client.radio.selectedSide === 'a' ? 'b' : 'a'
        act(`swap→${side}`)
        rig.controller.chooseSide(side)
      } else if (roll < 0.26 && !scanning && !keyed) {
        const side = pick(['a', 'b'] as const)
        const dir = pick([1, -1] as const)
        act(`chan ${side}${dir > 0 ? '+' : '-'}`)
        rig.controller.stepChannel(side, dir)
      } else if (roll < 0.32 && !scanning && !keyed) {
        const side = pick(['a', 'b'] as const)
        act(`zone ${side}+`)
        rig.controller.stepZone(side, 1)
      } else if (roll < 0.44) {
        const side = pick(['a', 'b'] as const)
        const rssi = 1 + Math.floor(rand() * 4)
        act(`rf ${side}=${rssi}`)
        rig.sim.setCarrier(side, rssi)
      } else if (roll < 0.56) {
        const side = pick(['a', 'b'] as const)
        act(`rf ${side}=0`)
        rig.sim.clearCarrier(side)
      } else if (roll < 0.64 && !dmrUp && !keyed) {
        const call = pick(CALLS)
        act(`dmr rx TG${call.dest}`)
        rig.sim.startDmrCall({ direction: 'rx', ...call })
        dmrUp = true
      } else if (roll < 0.72 && dmrUp) {
        act('dmr end')
        rig.sim.endDmrCall()
        dmrUp = false
      } else if (roll < 0.77 && !scanning && !keyed && !dmrUp) {
        act('scan start')
        rig.controller.startScan(rig.client.radio.selectedSide, 0, 'FIRE')
      } else if (roll < 0.8 && scanning && rig.sim.scanning && !rig.sim.scanning.landed) {
        act('scan hit')
        rig.sim.scanLand(1, Math.floor(rand() * 2), 1 + Math.floor(rand() * 4))
      } else if (roll < 0.82 && scanning && rig.sim.scanning?.landed) {
        act('scan clear')
        rig.sim.scanResume()
      } else if (roll < 0.85 && scanning) {
        act('scan stop')
        rig.controller.stopScan()
      } else if (roll < 0.9 && !keyed && !scanning && !dmrUp && rig.client.radio.ptt === 'idle') {
        act('key')
        rig.controller.key()
        keyed = true
      } else if (keyed) {
        act('unkey')
        rig.controller.unkey()
        keyed = false
      } else {
        act('setting')
        rig.controller.setSetting('key_tone', Math.floor(rand() * 2))
      }

      await rig.advance(20 + Math.floor(rand() * 200))

      // Quiesce every ~15 steps: settle transients, cross every settle window, compare the
      // CLIENT's state (through the whole pipeline) against the sim's ground truth.
      if (step % 15 === 14 && rig.client.connection === 'connected') {
        if (keyed) {
          rig.controller.unkey()
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
        if (rig.client.connection === 'connected') {
          rig.expectClientConsistent() // handles a running scan (skips the scanning side's channel)
          quiesces += 1
        }
      }
    }

    // final teardown to a clean quiescent state
    if (keyed) rig.controller.unkey()
    if (dmrUp) rig.sim.endDmrCall()
    await rig.advance(2500) // rides out a trailing drop's reconnect too
    if (rig.client.connection === 'connected' && rig.client.radio.scan.active) {
      rig.controller.stopScan()
      await rig.advance(200)
    }
    await rig.advance(1600)
    rig.sim.nudge()
    await rig.flush()
    assert.equal(rig.client.connection, 'connected', 'ends connected (reconnect held up)')
    rig.expectClientConsistent()
    rig.assertClean()
    assert.ok(quiesces >= Math.floor(steps / 30), `quiescent checks actually ran (${quiesces})`)
    assert.ok(rig.mirror.patches > steps, `the patch stream flowed (${rig.mirror.patches} patches)`)
  } catch (e) {
    ;(e as Error).message += `\n\nsoak seed ${seed} (${trace.length} steps, ${drops} drops):\n${trace.join(' → ')}`
    throw e
  }
}

for (const seed of [7, 99, 4242]) {
  test(`soak seed ${seed}: 400 actions with reconnects — client mirrors truth throughout`, async (t) => {
    await soak(t, seed, 400)
  })
}

// The marathon: one deep run (~2500 actions, dozens of reconnect cycles, tens of virtual minutes)
// — long enough for slow drift (stale state leaking across reconnects, counters, patch rot) to
// compound and surface.
test('soak marathon: 2500 actions stay consistent end to end', async (t) => {
  await soak(t, 31337, 2500)
})
