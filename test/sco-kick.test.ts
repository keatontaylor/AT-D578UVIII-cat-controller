// SCO kick gating: the experiment must acquire the HFP sink exactly on gate rising edges while
// connected + PTT-idle, and release it the instant the gate closes, PTT starts, or the radio
// disconnects — PTT owns the sink, so a kick lingering into a key would break mic TX.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { ScoKick, type ScoKickSnapshot } from '../src/audio/sco-kick'

class FakeProc extends EventEmitter {
  killed: string | null = null
  written: Buffer[] = []
  ended = false
  readonly stdin = {
    writable: true,
    write: (b: Buffer): boolean => {
      this.written.push(b)
      return true
    },
    end: (): void => {
      this.ended = true
    },
  }
  readonly stderr = new EventEmitter()
  kill(sig: string): boolean {
    this.killed = sig
    return true
  }
}

function harness(sinkAvailable = true): { kick: ScoKick; procs: FakeProc[]; logs: string[] } {
  const procs: FakeProc[] = []
  const logs: string[] = []
  const kick = new ScoKick(
    () => (sinkAvailable ? { command: 'bluealsa-cli', args: ['open', 'sink'] } : null),
    (m) => logs.push(m),
    () => {
      const p = new FakeProc()
      procs.push(p)
      return p as unknown as ChildProcess
    },
  )
  return { kick, procs, logs }
}

const snap = (over: Partial<ScoKickSnapshot>): ScoKickSnapshot => ({ gateOpen: false, pttBusy: false, connected: true, ...over })

test('gate rising edge arms the sink once and feeds silence immediately', () => {
  const { kick, procs } = harness()
  kick.update(snap({ gateOpen: true }))
  assert.equal(procs.length, 1)
  assert.ok(kick.active)
  assert.ok(procs[0]!.written.length >= 1, 'first silence write happens at arm time')
  // repeated open-gate snapshots must not spawn again
  kick.update(snap({ gateOpen: true }))
  assert.equal(procs.length, 1)
  kick.update(snap({ gateOpen: false })) // cleanup timers
})

test('gate close releases: stdin ended + SIGTERM', () => {
  const { kick, procs } = harness()
  kick.update(snap({ gateOpen: true }))
  kick.update(snap({ gateOpen: false }))
  assert.equal(kick.active, false)
  assert.ok(procs[0]!.ended)
  assert.equal(procs[0]!.killed, 'SIGTERM')
  // next rising edge arms a fresh process
  kick.update(snap({ gateOpen: true }))
  assert.equal(procs.length, 2)
  kick.update(snap({ gateOpen: false }))
})

test('PTT preempts instantly and blocks arming while busy', () => {
  const { kick, procs } = harness()
  kick.update(snap({ gateOpen: true }))
  kick.update(snap({ gateOpen: true, pttBusy: true }))
  assert.equal(kick.active, false)
  assert.equal(procs[0]!.killed, 'SIGTERM')
  // gate still open + PTT busy → stays released; PTT clearing mid-gate is NOT a rising edge
  kick.update(snap({ gateOpen: true, pttBusy: true }))
  assert.equal(procs.length, 1)
  kick.update(snap({ gateOpen: true }))
  assert.equal(procs.length, 1, 'no re-arm without a fresh gate edge')
  // a real fresh edge after PTT re-arms
  kick.update(snap({ gateOpen: false }))
  kick.update(snap({ gateOpen: true }))
  assert.equal(procs.length, 2)
  kick.update(snap({ gateOpen: false }))
})

test('never arms while disconnected or without a sink', () => {
  const a = harness()
  a.kick.update({ gateOpen: true, pttBusy: false, connected: false })
  assert.equal(a.procs.length, 0)
  const b = harness(false)
  b.kick.update(snap({ gateOpen: true }))
  assert.equal(b.procs.length, 0)
  assert.equal(b.kick.active, false)
})

test('sink process dying on its own is observed, not double-released', () => {
  const { kick, procs, logs } = harness()
  kick.update(snap({ gateOpen: true }))
  procs[0]!.emit('close', 1)
  assert.equal(kick.active, false)
  assert.ok(logs.some((l) => l.includes('released by the other end')))
  kick.update(snap({ gateOpen: false })) // must be a no-op, not a crash
  assert.equal(procs[0]!.killed, null)
})
