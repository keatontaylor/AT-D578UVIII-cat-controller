// Offline coverage for the native transport: the sockaddr_rc encoding is pure (no FFI), so we
// pin its byte layout. The socket I/O itself needs real hardware and is exercised by the live
// smoke script (examples/rfcomm-smoke.ts), not in CI.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sockaddrRc } from '../src/transport/rfcomm'
import { bytesToHex } from './capture'

test('sockaddr_rc: family LE + reversed bdaddr + channel, padded to 10', () => {
  // BT-01 from the captures: 00:1B:10:B2:14:49, channel 1
  const buf = sockaddrRc('00:1B:10:B2:14:49', 1)
  assert.equal(buf.length, 10)
  // 1f 00 = AF_BLUETOOTH(31) LE; 49 14 b2 10 1b 00 = address reversed; 01 = channel; 00 = pad
  assert.equal(bytesToHex(new Uint8Array(buf)), '1f 00 49 14 b2 10 1b 00 01 00')
})

test('sockaddr_rc carries the channel byte', () => {
  assert.equal(sockaddrRc('00:1B:10:B2:14:49', 7)[8], 7)
})

test('sockaddr_rc rejects a malformed MAC', () => {
  assert.throws(() => sockaddrRc('not-a-mac', 1))
  assert.throws(() => sockaddrRc('00:1B:10:B2:14', 1)) // too few octets
})

// ── connect-failure messages: errno → something an operator can act on ─────────
import { describeConnectFailure } from '../src/transport/rfcomm'

test('describeConnectFailure translates the common errnos to human hints', () => {
  assert.match(
    describeConnectFailure('00:1B:10:1C:FA:C3', 2, 111),
    /refused the connection — it is likely still booting/,
    'ECONNREFUSED = radio booting / SPP not ready',
  )
  assert.match(describeConnectFailure('00:1B:10:1C:FA:C3', 2, 112), /powered off or out of range/)
  assert.match(describeConnectFailure('00:1B:10:1C:FA:C3', 2, 110), /did not respond/)
  assert.match(describeConnectFailure('00:1B:10:1C:FA:C3', 2, 13), /re-paired/)
  // the technical detail survives for the logs
  assert.match(describeConnectFailure('00:1B:10:1C:FA:C3', 2, 111), /ch2, errno 111/)
  // an unmapped errno still reads sanely
  assert.match(describeConnectFailure('00:1B:10:1C:FA:C3', 2, 99), /Bluetooth connection failed .*errno 99/)
})
