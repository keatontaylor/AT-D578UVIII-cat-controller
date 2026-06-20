// Thin, event-driven wrapper around BlueZ's D-Bus API (org.bluez) via dbus-next.
//
// WHY THIS EXISTS: the rest of the stack used to drive Bluetooth by shelling out
// to `bluetoothctl` and scraping its human-readable text. That is fragile (output
// format drift, no events, races). BlueZ exposes a clean, event-driven D-Bus API;
// this module is the only place that knows about it. It covers everything the
// connection state machine ([[bt-manager.mjs]]) needs in Phase 1: power/scan the
// adapter, enumerate + watch devices, pair/trust/connect, and auto-accept pairing
// via a registered Agent1. HFP-HF Profile1 registration is added in Phase 2.
//
// Addresses are the public identity used throughout: uppercase colon form
// (AA:BB:CC:DD:EE:FF). Device object paths (/org/bluez/hciN/dev_AA_..) are an
// internal detail resolved from the ObjectManager, never required from callers.
import { EventEmitter } from 'node:events'
import dbus from 'dbus-next'

const { Variant } = dbus
const { Interface } = dbus.interface

const BLUEZ = 'org.bluez'
const OM_IFACE = 'org.freedesktop.DBus.ObjectManager'
const PROPS_IFACE = 'org.freedesktop.DBus.Properties'
const ADAPTER_IFACE = 'org.bluez.Adapter1'
const DEVICE_IFACE = 'org.bluez.Device1'
const AGENT_MANAGER_IFACE = 'org.bluez.AgentManager1'
const AGENT_PATH = '/anytone/agent'

// Unwrap a dbus-next Variant ({ signature, value }) to its plain value.
const v = x => (x && typeof x === 'object' && 'signature' in x && 'value' in x) ? x.value : x

function normAddr(addr) {
  return String(addr || '').trim().toUpperCase()
}

// A pairing agent that auto-accepts. AnyTone radios pair "Just Works" (no UI), so
// confirmation/authorization requests are accepted and any PIN/passkey request is
// answered with a fixed code (configurable; 0000 covers legacy fixed-PIN devices).
class AutoAgent extends Interface {
  constructor(pin) {
    super('org.bluez.Agent1')
    this._pin = String(pin ?? '0000')
  }
  Release() {}
  RequestPinCode(_device) { return this._pin }
  RequestPasskey(_device) { return Number.parseInt(this._pin, 10) || 0 }
  DisplayPinCode(_device, _code) {}
  DisplayPasskey(_device, _passkey, _entered) {}
  RequestConfirmation(_device, _passkey) {}
  RequestAuthorization(_device) {}
  AuthorizeService(_device, _uuid) {}
  Cancel() {}
}
AutoAgent.configureMembers({
  methods: {
    Release: { inSignature: '', outSignature: '' },
    RequestPinCode: { inSignature: 'o', outSignature: 's' },
    RequestPasskey: { inSignature: 'o', outSignature: 'u' },
    DisplayPinCode: { inSignature: 'os', outSignature: '' },
    DisplayPasskey: { inSignature: 'ouq', outSignature: '' },
    RequestConfirmation: { inSignature: 'ou', outSignature: '' },
    RequestAuthorization: { inSignature: 'o', outSignature: '' },
    AuthorizeService: { inSignature: 'os', outSignature: '' },
    Cancel: { inSignature: '', outSignature: '' },
  },
})

export class Bluez extends EventEmitter {
  constructor({ pin } = {}) {
    super()
    this.bus = null
    this.om = null
    this.adapterPath = null
    this.pin = pin
    this._propsWatchers = new Map() // device path -> Properties iface (for cleanup)
    this._agent = null
  }

  // Connect the system bus, locate an adapter, and start watching the object tree.
  // Safe to call once; the state machine holds a single Bluez instance.
  async init() {
    if (this.bus) return
    this.bus = dbus.systemBus()
    this.bus.on('error', err => this.emit('error', err))
    const root = await this.bus.getProxyObject(BLUEZ, '/')
    this.om = root.getInterface(OM_IFACE)
    const managed = await this.om.GetManagedObjects()
    for (const [path, ifaces] of Object.entries(managed)) {
      if (ifaces[ADAPTER_IFACE] && !this.adapterPath) this.adapterPath = path
    }
    if (!this.adapterPath) throw new Error('no Bluetooth adapter found (is the controller present and bluetoothd running?)')
    // Watch the whole tree: scan results and bonded devices appear/disappear here.
    this.om.on('InterfacesAdded', (path, ifaces) => {
      if (ifaces[DEVICE_IFACE]) {
        this._watchDevice(path)
        this.emit('deviceAdded', this._shapeDevice(path, ifaces[DEVICE_IFACE]))
      }
    })
    this.om.on('InterfacesRemoved', (path, ifaces) => {
      if (ifaces.includes(DEVICE_IFACE)) {
        this._unwatchDevice(path)
        this.emit('deviceRemoved', { path })
      }
    })
    // Subscribe to property changes on devices already present.
    for (const [path, ifaces] of Object.entries(managed)) {
      if (ifaces[DEVICE_IFACE]) this._watchDevice(path)
    }
  }

  get adapter() { return this.adapterPath }

  async _props(path) {
    const obj = await this.bus.getProxyObject(BLUEZ, path)
    return obj.getInterface(PROPS_IFACE)
  }

  async _iface(path, name) {
    const obj = await this.bus.getProxyObject(BLUEZ, path)
    return obj.getInterface(name)
  }

  _shapeDevice(path, props) {
    return {
      path,
      address: normAddr(v(props.Address)),
      name: v(props.Name) ?? v(props.Alias) ?? null,
      alias: v(props.Alias) ?? null,
      paired: !!v(props.Paired),
      trusted: !!v(props.Trusted),
      connected: !!v(props.Connected),
      uuids: (v(props.UUIDs) || []).map(u => String(u).toLowerCase()),
      rssi: v(props.RSSI) ?? null,
    }
  }

  async _watchDevice(path) {
    if (this._propsWatchers.has(path)) return
    const props = await this._props(path)
    const handler = (iface, changed) => {
      if (iface !== DEVICE_IFACE) return
      const patch = {}
      for (const [k, val] of Object.entries(changed)) patch[k] = v(val)
      this.emit('deviceChanged', { path, changed: patch })
    }
    props.on('PropertiesChanged', handler)
    this._propsWatchers.set(path, { props, handler })
  }

  _unwatchDevice(path) {
    const w = this._propsWatchers.get(path)
    if (w) { try { w.props.off('PropertiesChanged', w.handler) } catch {} this._propsWatchers.delete(path) }
  }

  // Snapshot of all known devices (bonded + currently-discovered).
  async listDevices() {
    const managed = await this.om.GetManagedObjects()
    const out = []
    for (const [path, ifaces] of Object.entries(managed)) {
      if (ifaces[DEVICE_IFACE]) out.push(this._shapeDevice(path, ifaces[DEVICE_IFACE]))
    }
    return out
  }

  async findDeviceByAddress(addr) {
    const want = normAddr(addr)
    return (await this.listDevices()).find(d => d.address === want) || null
  }

  async _devicePath(addr) {
    const d = await this.findDeviceByAddress(addr)
    if (!d) throw new Error(`device ${normAddr(addr)} is not known to BlueZ (not in range / never discovered)`)
    return d.path
  }

  // --- Adapter -------------------------------------------------------------
  async adapterInfo() {
    const props = await this._props(this.adapterPath)
    const all = await props.GetAll(ADAPTER_IFACE)
    return {
      path: this.adapterPath,
      address: normAddr(v(all.Address)),
      powered: !!v(all.Powered),
      discovering: !!v(all.Discovering),
    }
  }

  async powerOn() {
    const props = await this._props(this.adapterPath)
    const powered = v(await props.Get(ADAPTER_IFACE, 'Powered'))
    if (!powered) await props.Set(ADAPTER_IFACE, 'Powered', new Variant('b', true))
  }

  async startDiscovery() {
    const adapter = await this._iface(this.adapterPath, ADAPTER_IFACE)
    try { await adapter.StartDiscovery() } catch (err) {
      if (!/InProgress|already/i.test(err?.message || '')) throw err
    }
  }

  async stopDiscovery() {
    const adapter = await this._iface(this.adapterPath, ADAPTER_IFACE)
    try { await adapter.StopDiscovery() } catch {}
  }

  // --- Device operations ---------------------------------------------------
  async pair(addr) {
    const dev = await this._iface(await this._devicePath(addr), DEVICE_IFACE)
    await dev.Pair()
  }

  async setTrusted(addr, trusted = true) {
    const props = await this._props(await this._devicePath(addr))
    await props.Set(DEVICE_IFACE, 'Trusted', new Variant('b', !!trusted))
  }

  async connect(addr) {
    const dev = await this._iface(await this._devicePath(addr), DEVICE_IFACE)
    await dev.Connect()
  }

  async disconnect(addr) {
    const path = await this.findDeviceByAddress(addr).then(d => d?.path)
    if (!path) return
    const dev = await this._iface(path, DEVICE_IFACE)
    try { await dev.Disconnect() } catch {}
  }

  async removeDevice(addr) {
    const path = await this.findDeviceByAddress(addr).then(d => d?.path)
    if (!path) return
    const adapter = await this._iface(this.adapterPath, ADAPTER_IFACE)
    try { await adapter.RemoveDevice(path) } catch {}
  }

  // --- Pairing agent -------------------------------------------------------
  // Register an auto-accepting agent as the system default so Pair() needs no
  // interactive confirmation. Idempotent.
  async registerAgent() {
    if (this._agent) return
    const agent = new AutoAgent(this.pin)
    this.bus.export(AGENT_PATH, agent)
    const mgr = await this._iface('/org/bluez', AGENT_MANAGER_IFACE)
    // KeyboardDisplay matches bluetoothctl's default and is the most capable
    // profile: it lets BlueZ pick Just-Works, numeric-comparison, passkey, OR
    // legacy-PIN as the device requires, routing each to our auto-accept handlers.
    // NoInputNoOutput forces Just-Works and makes PIN/passkey radios fail with
    // "authentication failed".
    await mgr.RegisterAgent(AGENT_PATH, 'KeyboardDisplay')
    try { await mgr.RequestDefaultAgent(AGENT_PATH) } catch {}
    this._agent = agent
  }

  async unregisterAgent() {
    if (!this._agent) return
    try {
      const mgr = await this._iface('/org/bluez', AGENT_MANAGER_IFACE)
      await mgr.UnregisterAgent(AGENT_PATH)
    } catch {}
    try { this.bus.unexport(AGENT_PATH, this._agent) } catch {}
    this._agent = null
  }

  close() {
    for (const path of [...this._propsWatchers.keys()]) this._unwatchDevice(path)
    try { this.bus?.disconnect() } catch {}
    this.bus = null
  }
}

export const isLikelyRadio = (device, namePattern) => {
  const SPP = '00001101-0000-1000-8000-00805f9b34fb'
  const HFP_AG = '0000111f-0000-1000-8000-00805f9b34fb'
  const nameOk = namePattern ? namePattern.test(device.name || device.alias || '') : true
  if (!nameOk) return false
  // UUIDs are only reliable AFTER pairing (full SDP). A freshly-discovered or
  // unpaired device often exposes no/partial UUIDs, so requiring SPP+HFP-AG there
  // would hide the radio from a scan — exactly when we need to find it to pair.
  // For a fully-resolved PAIRED device, require the radio's SPP + HFP-AG so we
  // don't mistake the head/handset (which advertises only one) for the radio.
  const u = device.uuids || []
  if (device.paired && u.length) return u.includes(SPP) && u.includes(HFP_AG)
  return true
}
