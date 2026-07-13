import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BtManager } from '../src/bluetooth/manager'
import { normAddr, SPP_UUID, HFP_AG_UUID } from '../src/bluetooth/radio-select'
import type { AdapterInfo, BluezApi, Device } from '../src/bluetooth/types'

interface Rec {
  path: string
  address: string
  name: string | null
  alias: string | null
  paired: boolean
  trusted: boolean
  connected: boolean
  uuids: string[]
  rssi: number | null
}
const rec = (p: Partial<Rec> & { address: string }): Rec => ({
  path: `/d/${p.address.replace(/:/g, '_')}`,
  name: 'ELET_AGHF_LEFAC3',
  alias: null,
  paired: false,
  trusted: false,
  connected: false,
  uuids: [],
  rssi: null,
  ...p,
})
const snap = (d: Rec): Device => ({ ...d, uuids: [...d.uuids] })

class FakeBluez extends EventEmitter implements BluezApi {
  devices: Rec[] = []
  calls: string[] = []
  connectError: Error | null = null
  setConnectedOnConnect = true
  readonly adapter = '/org/bluez/hci0'
  async init(): Promise<void> {}
  async registerAgent(): Promise<void> {}
  async powerOn(): Promise<void> {
    this.calls.push('powerOn')
  }
  async startDiscovery(): Promise<void> {
    this.calls.push('startDiscovery')
  }
  async stopDiscovery(): Promise<void> {
    this.calls.push('stopDiscovery')
  }
  async listDevices(): Promise<Device[]> {
    return this.devices.map(snap)
  }
  async findDeviceByAddress(addr: string): Promise<Device | null> {
    const d = this.find(addr)
    return d ? snap(d) : null
  }
  async pair(addr: string): Promise<void> {
    this.calls.push(`pair:${addr}`)
    const d = this.find(addr)
    if (d) d.paired = true
  }
  async setTrusted(addr: string, trusted = true): Promise<void> {
    this.calls.push(`trust:${addr}`)
    const d = this.find(addr)
    if (d) d.trusted = trusted
  }
  async connect(addr: string): Promise<void> {
    this.calls.push(`connect:${addr}`)
    const d = this.find(addr)
    if (d && this.setConnectedOnConnect) d.connected = true
    if (this.connectError) throw this.connectError
  }
  async disconnect(addr: string): Promise<void> {
    this.calls.push(`disconnect:${addr}`)
    const d = this.find(addr)
    if (d) d.connected = false
  }
  async removeDevice(addr: string): Promise<void> {
    this.calls.push(`remove:${addr}`)
    this.devices = this.devices.filter((x) => x.address !== normAddr(addr))
  }
  async adapterInfo(): Promise<AdapterInfo> {
    return { path: this.adapter, address: '00:00:00:00:00:00', powered: true, discovering: false }
  }
  close(): void {}
  private find(addr: string): Rec | undefined {
    return this.devices.find((x) => x.address === normAddr(addr))
  }
}

const ADDR = '00:1B:10:1C:FA:C3'
const SHADOW = '00:1B:10:2C:FA:C3'

test('ensureReady is a no-op when the device is already paired + trusted', async () => {
  const bluez = new FakeBluez()
  bluez.devices = [rec({ address: ADDR, paired: true, trusted: true, uuids: [SPP_UUID, HFP_AG_UUID] })]
  const m = new BtManager({ bluez, address: ADDR, statePath: null })
  assert.equal(await m.ensureReady(), ADDR)
  assert.equal(m.step, 'paired')
  assert.ok(!bluez.calls.some((c) => c.startsWith('pair') || c.startsWith('trust')))
})

test('ensureReady pairs + trusts an unpaired device', async () => {
  const bluez = new FakeBluez()
  bluez.devices = [rec({ address: ADDR, uuids: [SPP_UUID, HFP_AG_UUID] })]
  const m = new BtManager({ bluez, address: ADDR, statePath: null })
  await m.ensureReady()
  assert.deepEqual(
    bluez.calls.filter((c) => c === 'startDiscovery' || c === 'stopDiscovery' || c.startsWith('pair') || c.startsWith('trust')),
    ['startDiscovery', `pair:${ADDR}`, 'stopDiscovery', `trust:${ADDR}`],
  )
  assert.equal(bluez.devices[0]!.paired, true)
  assert.equal(bluez.devices[0]!.trusted, true)
})

test('manual pairAddress also keeps discovery active during Pair', async () => {
  const bluez = new FakeBluez()
  bluez.devices = [rec({ address: ADDR, uuids: [SPP_UUID, HFP_AG_UUID] })]
  const m = new BtManager({ bluez, statePath: null })
  await m.pairAddress(ADDR)
  assert.deepEqual(
    bluez.calls.filter((c) => c === 'startDiscovery' || c === 'stopDiscovery' || c.startsWith('pair') || c.startsWith('trust')),
    ['startDiscovery', `pair:${ADDR}`, 'stopDiscovery', `trust:${ADDR}`],
  )
})

test('connectAcl connects and reaches ready', async () => {
  const bluez = new FakeBluez()
  bluez.devices = [rec({ address: ADDR, paired: true, trusted: true, uuids: [SPP_UUID, HFP_AG_UUID] })]
  const m = new BtManager({ bluez, address: ADDR, statePath: null })
  assert.equal(await m.connectAcl(), ADDR)
  assert.equal(m.step, 'ready')
  assert.equal(bluez.devices[0]!.connected, true)
})

test('connectAcl tolerates a partial-profile error if the device still connects', async () => {
  const bluez = new FakeBluez()
  bluez.devices = [rec({ address: ADDR, paired: true, trusted: true, uuids: [SPP_UUID, HFP_AG_UUID] })]
  bluez.connectError = new Error('org.bluez.Error.NotAvailable: profile-unavailable') // SPP has no BlueZ handler
  const m = new BtManager({ bluez, address: ADDR, statePath: null })
  assert.equal(await m.connectAcl(), ADDR) // tolerated — device reached Connected
  assert.equal(m.step, 'ready')
})

test('connectAcl rethrows a non-tolerated error', async () => {
  const bluez = new FakeBluez()
  bluez.devices = [rec({ address: ADDR, paired: true, trusted: true, uuids: [SPP_UUID, HFP_AG_UUID] })]
  bluez.connectError = new Error('org.bluez.Error.Failed: page timeout')
  bluez.setConnectedOnConnect = false
  const m = new BtManager({ bluez, address: ADDR, statePath: null })
  await assert.rejects(() => m.connectAcl(), /page timeout/)
})

test('a persisted BLE-shadow address self-heals to the Classic sibling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'btstate-'))
  const statePath = join(dir, 'bt-state.json')
  writeFileSync(statePath, JSON.stringify({ address: SHADOW })) // persisted shadow

  const bluez = new FakeBluez()
  bluez.devices = [
    rec({ address: SHADOW, uuids: [] }), // BLE shadow (no SPP)
    rec({ address: ADDR, paired: true, trusted: true, uuids: [SPP_UUID, HFP_AG_UUID] }), // Classic
  ]
  const m = new BtManager({ bluez, statePath }) // no configured address → self-heal allowed
  await m.ensureReady()
  assert.equal(m.address, ADDR) // re-resolved to the Classic interface
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).address, ADDR) // persisted
})

test('ensureConnected runs the full chain', async () => {
  const bluez = new FakeBluez()
  bluez.devices = [rec({ address: ADDR, uuids: [SPP_UUID, HFP_AG_UUID] })]
  const m = new BtManager({ bluez, address: ADDR, statePath: null })
  assert.equal(await m.ensureConnected(), ADDR)
  assert.equal(m.step, 'ready')
  const d = bluez.devices[0]!
  assert.ok(d.paired && d.trusted && d.connected)
})

test('statusSnapshot + setTarget reflect the target', () => {
  const bluez = new FakeBluez()
  const m = new BtManager({ bluez, address: ADDR, statePath: null })
  m.setTarget(SHADOW)
  const s = m.statusSnapshot()
  assert.equal(s.address, SHADOW)
  assert.equal(s.configuredAddress, ADDR)
})
