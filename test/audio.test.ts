import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BluealsaHfp } from '../src/audio/bluealsa'

test('pcmPath resolves the HFP source PCM from address + adapter', () => {
  const a = new BluealsaHfp()
  assert.equal(
    a.pcmPath('00:1B:10:1C:FA:C3', '/org/bluez/hci0'),
    '/org/bluealsa/hci0/dev_00_1B_10_1C_FA_C3/hfphf/source',
  )
  assert.equal(
    a.pcmPath('00:1B:10:1C:FA:C3', '/org/bluez/hci1'),
    '/org/bluealsa/hci1/dev_00_1B_10_1C_FA_C3/hfphf/source',
  )
  // default adapter when unknown
  assert.equal(
    a.pcmPath('00:1B:10:1C:FA:C3', null),
    '/org/bluealsa/hci0/dev_00_1B_10_1C_FA_C3/hfphf/source',
  )
})
