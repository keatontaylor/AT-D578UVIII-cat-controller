import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addrInt,
  dedupeRadios,
  HFP_AG_UUID,
  isLikelyRadio,
  isValidAddr,
  normAddr,
  preferClassic,
  SPP_UUID,
} from '../src/bluetooth/radio-select'
import type { Device } from '../src/bluetooth/types'

function dev(p: Partial<Device> & { address: string }): Device {
  return {
    path: `/d/${p.address.replace(/:/g, '_')}`,
    name: 'ELET_AGHF_TEST',
    alias: null,
    paired: false,
    trusted: false,
    connected: false,
    uuids: [],
    rssi: null,
    ...p,
  }
}

test('address validation + normalization', () => {
  assert.equal(normAddr(' 00:1b:10:1c:fa:c3 '), '00:1B:10:1C:FA:C3')
  assert.ok(isValidAddr('00:1B:10:1C:FA:C3'))
  assert.ok(!isValidAddr('AA:BB:CC:DD:EE:FF')) // placeholder
  assert.ok(!isValidAddr('00:1B:10'))
  assert.ok(!isValidAddr(null))
  assert.ok(addrInt('00:1B:10:1C:FA:C3') < addrInt('00:1B:10:2C:FA:C3')) // Classic < BLE shadow
})

test('isLikelyRadio: name gate always; UUID gate only for a fully-resolved paired device', () => {
  const pattern = /ELET_AGHF/i
  // unpaired / freshly discovered with no UUIDs — must NOT be hidden (we need to find it to pair)
  assert.ok(isLikelyRadio(dev({ address: '00:1B:10:1C:FA:C3' }), pattern))
  // paired with the radio's SPP + HFP-AG → yes
  assert.ok(isLikelyRadio(dev({ address: '00:1B:10:1C:FA:C3', paired: true, uuids: [SPP_UUID, HFP_AG_UUID] }), pattern))
  // paired but only SPP (a head/handset, not the radio) → no
  assert.ok(!isLikelyRadio(dev({ address: '00:1B:10:1C:FA:C3', paired: true, uuids: [SPP_UUID] }), pattern))
  // name mismatch → no
  assert.ok(!isLikelyRadio(dev({ address: '00:1B:10:1C:FA:C3', name: 'Some Speaker' }), pattern))
})

test('preferClassic never ranks by UUID count — SPP/HFP and lower address win', () => {
  const classic = dev({ address: '00:1B:10:1C:FA:C3', uuids: [SPP_UUID, HFP_AG_UUID] })
  // BLE shadow: adjacent higher address, MORE uuids (GATT) but no SPP/HFP
  const shadow = dev({ address: '00:1B:10:2C:FA:C3', uuids: ['0000180a-0000-1000-8000-00805f9b34fb', '00001801-0000-1000-8000-00805f9b34fb', '00001800-0000-1000-8000-00805f9b34fb'] })
  assert.ok(preferClassic(classic, shadow, null), 'SPP carrier beats more-UUIDs shadow')
  assert.ok(!preferClassic(shadow, classic, null))

  // configured MAC trumps everything
  assert.ok(preferClassic(shadow, classic, shadow.address))

  // tie-break by lower address when both carry SPP/HFP
  const lower = dev({ address: '00:00:00:00:00:01', uuids: [SPP_UUID, HFP_AG_UUID] })
  const higher = dev({ address: '00:00:00:00:00:02', uuids: [SPP_UUID, HFP_AG_UUID] })
  assert.ok(preferClassic(lower, higher, null))
})

test('dedupeRadios collapses the same-named Classic + BLE shadow to the Classic entry', () => {
  const classic = dev({ address: '00:1B:10:1C:FA:C3', name: 'ELET_AGHF_LEFAC3', paired: true, uuids: [SPP_UUID, HFP_AG_UUID] })
  const shadow = dev({ address: '00:1B:10:2C:FA:C3', name: 'ELET_AGHF_LEFAC3', uuids: [] })
  const speaker = dev({ address: '11:22:33:44:55:66', name: 'Some Speaker' })

  const radios = dedupeRadios([shadow, classic, speaker], /ELET_AGHF/i, '00:1B:10:1C:FA:C3')
  assert.equal(radios.length, 1)
  assert.equal(radios[0]!.address, '00:1B:10:1C:FA:C3') // the Classic interface
  assert.equal(radios[0]!.configured, true)
})
