import { test } from 'node:test'
import assert from 'node:assert/strict'
import { additiveSum, checksumOk } from '../src/codec/checksum'
import { hexToBytes } from './capture'

test('additive sum matches a real ACK frame', () => {
  const f = hexToBytes('03 61 00 00 64') // 03+61+00+00 = 0x64
  assert.equal(additiveSum(f, 0, f.length - 1), 0x64)
  assert.ok(checksumOk(f, 0, f.length))
})

test('checksumOk accepts a real 04 5b snapshot', () => {
  const f = hexToBytes('04 5b 00 5f') // 04+5b+00 = 0x5f
  assert.ok(checksumOk(f, 0, f.length))
})

test('checksumOk rejects a corrupted trailing byte', () => {
  assert.ok(!checksumOk(hexToBytes('03 61 00 00 65'), 0, 5))
})

test('checksumOk requires at least two bytes', () => {
  assert.ok(!checksumOk(hexToBytes('03'), 0, 1))
})
