// Session.connect() drives the whole startup sequence (wake → COM_MODE → enumeration →
// COM_CHECK_END) through the full stack, against a scripted transport that answers each read
// with its captured response. Asserts a COMPLETE RadioState — the enumeration end-to-end.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '../src/services/session'
import { RadioState } from '../src/domain/state'
import type { Transport } from '../src/transport/types'
import { hexToBytes } from './capture'

const STARTUP = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'captures/bt01-relay-20260619-150048.ndjson',
)

/** reg → its first 04 response from the capture. */
function loadResponses(path: string): Map<number, Uint8Array> {
  const responses = new Map<number, Uint8Array>()
  const RX = new Set(['rx', 'R>H'])
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    let rec: { dir?: string; hex?: string }
    try {
      rec = JSON.parse(t) as { dir?: string; hex?: string }
    } catch {
      continue
    }
    if (!rec.hex || !rec.dir) continue
    const bytes = hexToBytes(rec.hex)
    if (bytes[0] === 0x64) break // COM_CHECK_END → enumeration over
    if (bytes[0] === 0x04 && RX.has(rec.dir) && !responses.has(bytes[1]!)) responses.set(bytes[1]!, bytes)
  }
  return responses
}

/** Scripted transport: answers handshakes + 04 reads synchronously. */
class ScriptedTransport implements Transport {
  private handler: (chunk: Uint8Array) => void = () => {}
  constructor(private readonly responses: Map<number, Uint8Array>) {}
  onData(h: (chunk: Uint8Array) => void): void {
    this.handler = h
  }
  onClose(): void {}
  close(): void {}
  write(bytes: Uint8Array): void {
    const head = bytes[0]
    if (head === 0x01) this.handler(hexToBytes('03 01 00 00 04'))
    else if (head === 0x64) this.handler(hexToBytes('03 64 00 00 67'))
    else if (head === 0x04) {
      const r = this.responses.get(bytes[1]!)
      if (r) this.handler(r)
    }
    // 0x61 wake: no response needed
  }
}

test(
  'Session.connect enumerates and builds a complete RadioState',
  { skip: existsSync(STARTUP) ? false : 'startup capture not present' },
  async () => {
    const phases: string[] = []
    const session = new Session(
      new ScriptedTransport(loadResponses(STARTUP)),
      { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 },
      () => Date.now(),
      { onPhase: (p) => phases.push(p) },
    )
    await session.connect({ wakeDelayMs: 0 })
    session.close()

    // Startup progress is reported in order for the UI stepper.
    assert.deepEqual(phases, ['handshake', 'info', 'settings', 'channels', 'status'])

    const state = session.state
    assert.doesNotThrow(() => RadioState.parse(state))
    assert.equal(state.firmware, 'V200ET12_AQQX_V10043')
    assert.deepEqual(state.clock, { hour: 21, minute: 28, second: 2, year: null, month: null, day: null })
    assert.equal(state.sides.a.freqMHz, 462.675)
    assert.equal(state.sides.b.freqMHz, 438.625)
    assert.match(state.sides.a.zoneName, /\S/)
    assert.match(state.sides.b.zoneName, /\S/)
    // (selectedSide isn't asserted here: this relay capture's full 05 block arrives after
    // COM_CHECK_END, so loadResponses only sees a short 05 status-probe. decodeSelectedSide is
    // covered directly in the codec tests against a real full block.)
    // VFO/memory decoded into the domain (named memory channels in this capture).
    assert.equal(state.sides.a.mode, 'memory')
    assert.equal(state.sides.b.mode, 'memory')
    // Channel config (type/power/bandwidth/flags) decoded from the full channel record.
    assert.ok(state.sides.a.channel, 'side A channel config decoded')
    assert.match(state.sides.a.channel!.power, /^(low|mid|high|turbo)$/)
    assert.ok([12.5, 25].includes(state.sides.a.channel!.bandwidthKHz))
    assert.ok(Object.keys(state.settings).length >= 25)
  },
)
