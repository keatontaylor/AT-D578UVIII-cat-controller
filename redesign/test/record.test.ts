// The record codec (data/record-maps.json + src/codec/record.ts) — the record-canonical model's
// safety proof. The GOLDEN MASTER: for every real channel/zone record in the capture corpus and
// every mapped field, write-back-what-you-read must be BYTE-IDENTICAL. That property is what
// guarantees a field mutation can never disturb an unmapped (undecoded) offset — "we only mutate
// what we know", mechanically enforced.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bytesToHexStr, hexStrToBytes, readField, recordFields, writeField, type RecordKind } from '../src/codec/record'
import { decodeChannel } from '../src/codec/decode'
import { hexToBytes } from './capture'

const here = dirname(fileURLToPath(import.meta.url))
const CAPTURE_DIRS = [resolve(here, '../../captures'), resolve(here, '../captures')]

/** Every full-length checksum-valid record of the given register set across the corpus. */
function corpusRecords(regs: number[], minLen: number): Uint8Array[] {
  const out: Uint8Array[] = []
  const seen = new Set<string>()
  for (const dir of CAPTURE_DIRS) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ndjson')) continue
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        const t = line.trim()
        if (!t) continue
        let hex: string | undefined
        try {
          hex = (JSON.parse(t) as { hex?: string }).hex
        } catch {
          continue
        }
        if (!hex) continue
        const b = hexToBytes(hex)
        if (b[0] !== 0x04 || !regs.includes(b[1]!) || b.length < minLen) continue
        let sum = 0
        for (let i = 0; i < b.length - 1; i += 1) sum = (sum + b[i]!) & 0xff
        if (sum !== b[b.length - 1]) continue // skip garbles
        const key = hex
        if (!seen.has(key)) {
          seen.add(key)
          out.push(b)
        }
      }
    }
  }
  return out
}

function goldenMaster(kind: RecordKind, records: Uint8Array[]) {
  assert.ok(records.length > 10, `need corpus records (got ${records.length})`)
  for (const raw of records) {
    for (const f of recordFields(kind)) {
      const v = readField(kind, raw, f.key)
      if (v === null) continue // record too short for this field (compact form)
      const back = writeField(kind, raw, f.key, v)
      assert.deepEqual(
        Array.from(back),
        Array.from(raw),
        `${kind}.${f.key}: write-back-of-read must be byte-identical (record ${bytesToHexStr(raw).slice(0, 24)}…)`,
      )
    }
  }
  return records.length
}

test('GOLDEN MASTER: channel-record write-back-of-read is byte-identical across the corpus', () => {
  const n = goldenMaster('channel', corpusRecords([0x2c, 0x2d], 72))
  assert.ok(n > 0)
})

test('GOLDEN MASTER: zone-record write-back-of-read is byte-identical across the corpus', () => {
  goldenMaster('zone', corpusRecords([0x29, 0x2a], 37))
})

test('record map agrees with the legacy channel decoder on shared fields (corpus-wide)', () => {
  // readField is RAW-faithful; decode.ts additionally filters to printable ASCII + trims (its
  // human projection). Normalize the raw read the same way before comparing.
  const printable = (s: string) => [...s].filter((c) => c >= ' ' && c <= '~').join('').trim()
  for (const raw of corpusRecords([0x2c, 0x2d], 100)) {
    const ch = decodeChannel(raw)
    if (ch.freqMHz != null) assert.equal((readField('channel', raw, 'rxFreq') as number) / 1e5, ch.freqMHz)
    assert.equal(printable(readField('channel', raw, 'name') as string), ch.name)
    if (ch.position != null) assert.equal(readField('channel', raw, 'position'), ch.position)
  }
})

test('writeField changes exactly the target field and fixes the checksum', () => {
  const raw = corpusRecords([0x2c, 0x2d], 100)[0]!
  const out = writeField('channel', raw, 'position', 42)
  assert.equal(readField('channel', out, 'position'), 42)
  // every byte outside the field + checksum is untouched
  for (let i = 0; i < raw.length - 1; i += 1) {
    if (i === 71) continue
    assert.equal(out[i], raw[i], `byte ${i} must not change`)
  }
  let sum = 0
  for (let i = 0; i < out.length - 1; i += 1) sum = (sum + out[i]!) & 0xff
  assert.equal(out[out.length - 1], sum, 'trailing checksum recomputed')

  // bit fields preserve their byte's other bits
  const power = readField('channel', raw, 'txPower') as number
  const flipped = writeField('channel', raw, 'bandwidth', 1)
  assert.equal(readField('channel', flipped, 'txPower'), power, 'sibling bits untouched')
  assert.equal(readField('channel', flipped, 'bandwidth'), 1)
})

test('unknown fields and out-of-range values are refused', () => {
  const raw = corpusRecords([0x2c, 0x2d], 100)[0]!
  assert.throws(() => readField('channel', raw, 'nope'), /unknown channel-record field/)
  assert.throws(() => writeField('channel', raw, 'nope', 1), /unknown channel-record field/)
  assert.throws(() => writeField('channel', raw, 'colorCode', 16), /out of 4-bit range/)
  assert.throws(() => writeField('channel', raw, 'name', 'THIS NAME IS WAY TOO LONG'), /longer than 16/)
  assert.throws(() => writeField('channel', raw.slice(0, 40), 'position', 1), /too short/)
})

test('hex round-trip (the raw record travels in state as hex)', () => {
  const raw = corpusRecords([0x2c, 0x2d], 100)[0]!
  assert.deepEqual(Array.from(hexStrToBytes(bytesToHexStr(raw))), Array.from(raw))
  assert.throws(() => hexStrToBytes('abc'), /invalid hex string/)
  assert.throws(() => hexStrToBytes('zz'), /invalid hex string/)
})
