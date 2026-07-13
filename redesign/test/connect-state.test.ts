// connect → enumerate → RadioState golden: replay a real startup enumeration through the
// decoders + reducer and assert the resulting state. Captures are gitignored (personal
// callsign/DMR-id), so this asserts EXACT values on non-PII fields (firmware, clock, public
// repeater frequencies) and STRUCTURAL invariants on PII (callsign/channel/zone non-empty).
// Skips cleanly when the capture isn't present (CI without the corpus).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DecodedFrame } from '../src/codec/framing'
import { READ_HEAD } from '../src/codec/frame-table'
import { allSettings } from '../src/codec/settings-table'
import { initialState, RadioState } from '../src/domain/state'
import { reduceFrames } from '../src/domain/reduce'
import { hexToBytes } from './capture'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const STARTUP = resolve(repoRoot, 'captures/bt01-relay-20260619-150048.ndjson')

const RX = new Set(['rx', 'R>H'])

/** rx frames received during the enumeration phase — up to the COM_CHECK_END (head 0x64)
 * that ends the handshake — so the snapshot is the post-enumeration state, not a later one. */
function loadStartupRx(path: string): DecodedFrame[] {
  const out: DecodedFrame[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: { dir?: string; hex?: string }
    try {
      rec = JSON.parse(trimmed) as { dir?: string; hex?: string }
    } catch {
      continue
    }
    if (!rec.hex || !rec.dir) continue
    const bytes = hexToBytes(rec.hex)
    if (bytes[0] === 0x64) break // COM_CHECK_END → enumeration complete
    if (RX.has(rec.dir)) {
      out.push({
        head: bytes[0]!,
        reg: bytes[0] === READ_HEAD ? bytes[1]! : undefined,
        bytes,
        checksumOk: true,
      })
    }
  }
  return out
}

test(
  'connect → enumerate → RadioState (startup replay)',
  { skip: existsSync(STARTUP) ? false : 'startup capture not present' },
  () => {
    const frames = loadStartupRx(STARTUP)
    assert.ok(frames.length > 20, `expected a full enumeration, got ${frames.length} rx frames`)

    const state = reduceFrames(frames, initialState())

    // schema is the contract — the reduced state must validate
    assert.doesNotThrow(() => RadioState.parse(state))

    // exact assertions on non-PII fields
    assert.equal(state.firmware, 'V200ET12_AQQX_V10043')
    assert.deepEqual(state.clock, { hour: 21, minute: 28, second: 2, year: null, month: null, day: null })
    assert.equal(state.sides.a.freqMHz, 462.675)
    assert.equal(state.sides.b.freqMHz, 438.625)

    // structural invariants on PII-bearing fields (don't pin the values)
    assert.match(state.identity?.callsign ?? '', /^[A-Z0-9]+$/)
    assert.ok((state.identity?.dmrId ?? 0) > 0)
    for (const side of [state.sides.a, state.sides.b]) {
      assert.match(side.channelName, /\S/)
      assert.match(side.zoneName, /\S/)
    }

    // settings decoded coherently: each decoded value is a defined option label or a raw index
    const decodedCount = Object.keys(state.settings).length
    assert.ok(decodedCount >= 25, `decoded only ${decodedCount} settings`)
    for (const s of allSettings) {
      const v = state.settings[s.name]
      if (v === undefined) continue
      assert.ok(
        typeof v === 'number' || s.options.includes(v),
        `${s.name} = ${String(v)} is not a valid option`,
      )
    }
  },
)
