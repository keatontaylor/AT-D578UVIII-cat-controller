// Conformance: the /ws state pipeline is strictly RFC 7396 (JSON Merge Patch) over the
// authoritative AppState. Every AppState is pure JSON (no `undefined` — which JSON drops,
// breaking patch semantics), and a snapshot + the broadcaster's patch stream reconstructs every
// state exactly on a client that applies patches with applyMergePatch — including clearing fields
// via `null` (RFC 7396 treats null as delete, so cleared keys become absent).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StateBroadcaster } from '../src/api/broadcast'
import { applyMergePatch, renullAfterPatch } from '../src/api/merge-patch'
import { initialState, type RadioState } from '../src/domain/state'
import type { AppState } from '../src/services/radio-service'

const ADDR = '00:1B:10:1C:FA:C3'
const radio = (over: Partial<RadioState> = {}): RadioState => ({ ...initialState(), ...over })
const app = (over: Partial<AppState>): AppState => ({
  connection: 'disconnected',
  address: null,
  error: null,
  phase: null,
  radio: initialState(),
  metrics: { retransmits: 0, failed: 0, framingIncidents: 0 },
  ...over,
})

// RFC 7396 conflates null with deletion, so a reconstructed client has cleared keys ABSENT (not
// null). Compare up to that equivalence: drop null/undefined keys recursively, then deep-equal.
function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) if (val !== null && val !== undefined) out[k] = prune(val)
    return out
  }
  return v
}

test('every AppState is pure JSON — no undefined (valid RFC 7396 source)', () => {
  const states = [
    app({}),
    app({ connection: 'connecting', address: ADDR }),
    app({ connection: 'connected', address: ADDR, radio: radio({ firmware: 'FWX' }) }),
  ]
  for (const s of states) assert.deepEqual(JSON.parse(JSON.stringify(s)), s)
})

test('snapshot + patch stream reconstructs every AppState (RFC 7396: null ≡ absent)', () => {
  const base = initialState()
  const connected = radio({
    firmware: 'FWX',
    sides: { a: { ...base.sides.a, freqMHz: 462.675, channelName: 'LOOKOUT', mode: 'memory' }, b: base.sides.b },
  })
  const states: AppState[] = [
    app({}),
    app({ connection: 'connecting', address: ADDR }),
    app({ connection: 'connected', address: ADDR, radio: radio({ firmware: 'FWX' }) }),
    app({ connection: 'connected', address: ADDR, radio: connected }),
    app({}), // disconnect — firmware/freq/mode must clear back
  ]

  const broadcaster = new StateBroadcaster<AppState>(states[0]!)
  let client: unknown = {}
  broadcaster.subscribe((m) => {
    if (m.method === 'state.snapshot') client = m.params
    else if (m.method === 'state.patch') client = applyMergePatch(client, m.params)
  })
  assert.deepEqual(client, states[0]) // full snapshot on subscribe

  for (let i = 1; i < states.length; i += 1) {
    broadcaster.publish(states[i]!)
    assert.deepEqual(prune(client), prune(states[i]), `state ${i} reconstructed via RFC 7396 patch`)
  }

  // After disconnect the patch carries `radio.firmware: null` etc., which RFC 7396 applies as a
  // DELETE — proving cleared fields don't linger.
  const c = client as { radio: { firmware?: unknown; sides: { a: Record<string, unknown> } } }
  assert.ok(!('firmware' in c.radio), 'firmware deleted (cleared) on disconnect per RFC 7396')
  assert.ok(!('freqMHz' in c.radio.sides.a), 'sides.a.freqMHz deleted (cleared) per RFC 7396')
})

// ── the client-side re-null shim ────────────────────────────────────────────────
// RFC 7396 cannot express "set to null" (null means delete), so a server field going value→null
// arrives as a deletion and the applied client state loses the key (undefined, not null —
// silently off-type). renullAfterPatch restores fixed fields; record maps stay really deleted.

test('renullAfterPatch: a field patched value→null comes back as literal null, not missing', () => {
  const before = { connection: 'connected', address: '00:1B:10:1C:FA:C3', error: null, radio: { firmware: 'FWX' } }
  const after = { connection: 'disconnected', address: null, error: null, radio: { firmware: null } }
  const patch = new StateBroadcaster(before)
  // simulate what the server generates + the client applies
  const applied = applyMergePatch(before, { connection: 'disconnected', address: null, radio: { firmware: null } })
  assert.ok(!('address' in (applied as object)), 'RFC apply really deletes the key')
  const fixed = renullAfterPatch(before, applied, []) as typeof after
  assert.equal(fixed.address, null)
  assert.equal(fixed.radio.firmware, null)
  assert.deepEqual(fixed, after)
  void patch
})

test('renullAfterPatch: record deletions under skip paths stay deleted', () => {
  const before = { radio: { pendingSettings: { key_tone: { desired: 'L1', phase: 'pending' } }, settings: { a: 1 } } }
  const applied = applyMergePatch(before, { radio: { pendingSettings: { key_tone: null } } })
  const fixed = renullAfterPatch(before, applied, ['/radio/settings', '/radio/pendingSettings']) as {
    radio: { pendingSettings: Record<string, unknown>; settings: Record<string, unknown> }
  }
  assert.ok(!('key_tone' in fixed.radio.pendingSettings), 'an acked pending setting is really removed')
  assert.deepEqual(fixed.radio.settings, { a: 1 })
})
