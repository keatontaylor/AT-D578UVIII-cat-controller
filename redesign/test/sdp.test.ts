import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSppChannel, resolveSppChannel } from '../src/bluetooth/sdp'

const SPP_RECORD = `Searching for SP on 00:1B:10:1C:FA:C3 ...
Service Name: Serial Port
Service RecHandle: 0x10001
Service Class ID List:
  "Serial Port" (0x1101)
Protocol Descriptor List:
  "L2CAP" (0x0100)
  "RFCOMM" (0x0003)
    Channel: 4
`

test('parseSppChannel reads the RFCOMM channel from an SPP record', () => {
  assert.equal(parseSppChannel(SPP_RECORD), 4)
})

test('parseSppChannel returns null when no channel is present', () => {
  assert.equal(parseSppChannel('Searching for SP ...\nFailed to connect to SDP server\n'), null)
  assert.equal(parseSppChannel(''), null)
})

test('parseSppChannel rejects an implausible channel', () => {
  assert.equal(parseSppChannel('    Channel: 99\n'), null)
  assert.equal(parseSppChannel('    Channel: 0\n'), null)
})

test('resolveSppChannel returns null instead of throwing when the runner fails', async () => {
  assert.equal(await resolveSppChannel('00:11:22:33:44:55', async () => Promise.reject(new Error('no sdptool'))), null)
})

test('resolveSppChannel parses the runner output', async () => {
  assert.equal(await resolveSppChannel('00:11:22:33:44:55', async () => SPP_RECORD), 4)
})
