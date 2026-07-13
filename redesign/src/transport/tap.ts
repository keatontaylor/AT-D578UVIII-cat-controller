// Diagnostics wire tap: wraps a Transport and appends every raw chunk (both directions) to an
// NDJSON log in the relay-capture schema ({ts, dir, hex}) — so the existing corpus tooling
// (gen-frame-lengths, the analysis scripts) reads it directly. Enabled via ANYTONE_WIRE_LOG;
// meant for hunting live protocol anomalies (e.g. the every-other-call 5e decode dropout),
// not for permanent operation. The radio sends one frame per RFCOMM packet, so an rx chunk is
// (almost always) exactly one frame.

import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Transport } from './types'

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ')

export function tapTransport(inner: Transport, path: string): Transport {
  mkdirSync(dirname(path), { recursive: true })
  const out = createWriteStream(path, { flags: 'a' })
  const record = (dir: 'rx' | 'tx', bytes: Uint8Array): void => {
    out.write(`${JSON.stringify({ ts: new Date().toISOString(), dir, hex: hex(bytes) })}\n`)
  }
  return {
    write: (bytes) => {
      record('tx', bytes)
      inner.write(bytes)
    },
    onData: (handler) => inner.onData((chunk) => {
      record('rx', chunk)
      handler(chunk)
    }),
    onClose: (handler) => inner.onClose(handler),
    close: () => {
      inner.close()
      out.end()
    },
  }
}
