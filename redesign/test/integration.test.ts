// End-to-end integration: a real startup enumeration replayed through the FULL stack —
// transport (scripted) → link (framing/ARQ/demux) → reducer → RadioState. The scripted
// transport answers each read with the captured response, so this also exercises link's
// one-in-flight pumping under request/response, not just the reducer in isolation.

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
  '../..',
  'captures/bt01-relay-20260619-150048.ndjson',
)

interface Conversation {
  reads: Uint8Array[] // ordered host 04-reads (those with a captured response)
  responses: Map<number, Uint8Array> // reg → its 04 response
}

/** Pull the host reads + reg→response map from the capture, up to COM_CHECK_END. */
function loadConversation(path: string): Conversation {
  const reads: Uint8Array[] = []
  const responses = new Map<number, Uint8Array>()
  const RX = new Set(['rx', 'R>H'])
  const TX = new Set(['tx', 'H>R'])
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
    if (bytes[0] === 0x64) break // COM_CHECK_END ends enumeration
    if (bytes[0] !== 0x04) continue
    const reg = bytes[1]!
    if (RX.has(rec.dir) && !responses.has(reg)) responses.set(reg, bytes)
    else if (TX.has(rec.dir)) reads.push(bytes)
  }
  return { reads, responses }
}

/** In-memory transport: queues a response per read, drained by flush(). */
class ScriptedTransport implements Transport {
  private handler: (chunk: Uint8Array) => void = () => {}
  private readonly pending: Uint8Array[] = []
  constructor(private readonly responses: Map<number, Uint8Array>) {}
  onData(handler: (chunk: Uint8Array) => void): void {
    this.handler = handler
  }
  onClose(): void {}
  close(): void {}
  write(bytes: Uint8Array): void {
    if (bytes[0] === 0x04) {
      const resp = this.responses.get(bytes[1]!)
      if (resp) this.pending.push(resp)
    }
  }
  /** Deliver all queued responses; each may pump the next read (which queues the next). */
  flush(): void {
    while (this.pending.length > 0) this.handler(this.pending.shift()!)
  }
}

test(
  'startup enumeration through the full stack → RadioState',
  { skip: existsSync(STARTUP) ? false : 'startup capture not present' },
  () => {
    const { reads, responses } = loadConversation(STARTUP)
    assert.ok(reads.length > 20, `expected a full enumeration, got ${reads.length} reads`)

    const clock = { t: 0 }
    const transport = new ScriptedTransport(responses)
    const session = new Session(transport, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => clock.t)

    // submit only reads that have a captured response, so every write gets answered
    for (const read of reads) {
      if (responses.has(read[1]!)) session.submit(read)
    }
    transport.flush()

    const state = session.state
    assert.doesNotThrow(() => RadioState.parse(state))
    assert.equal(session.busy, false, 'no command left in flight')

    // same golden values as the unit-level connect→state test, now end-to-end
    assert.equal(state.firmware, 'V200ET12_AQQX_V10043')
    assert.deepEqual(state.clock, { hour: 21, minute: 28, second: 2, year: null, month: null, day: null })
    assert.equal(state.sides.a.freqMHz, 462.675)
    assert.equal(state.sides.b.freqMHz, 438.625)
    assert.match(state.identity?.callsign ?? '', /^[A-Z0-9]+$/)
    assert.ok(Object.keys(state.settings).length >= 25)
  },
)
