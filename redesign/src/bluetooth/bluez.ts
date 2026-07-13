// Thin, event-driven wrapper around BlueZ's D-Bus API (org.bluez) via dbus-next — the only
// place that knows about D-Bus. Implements BluezApi. Ported from the PoC's bluez.mjs.
//
// The public surface (BluezApi: Device snapshots, address strings) is strictly typed; the
// D-Bus internals are loosely typed because dbus-next's proxy objects / Variants are dynamic.
// This module needs a live system bus, so it is exercised by the live path, not unit tests.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'node:events'
import dbus from 'dbus-next'
import { normAddr } from './radio-select'
import type { AdapterInfo, BluezApi, Device } from './types'

const Variant = (dbus as any).Variant
const Interface = (dbus as any).interface.Interface

const BLUEZ = 'org.bluez'
const OM_IFACE = 'org.freedesktop.DBus.ObjectManager'
const PROPS_IFACE = 'org.freedesktop.DBus.Properties'
const ADAPTER_IFACE = 'org.bluez.Adapter1'
const DEVICE_IFACE = 'org.bluez.Device1'
const AGENT_MANAGER_IFACE = 'org.bluez.AgentManager1'
const AGENT_PATH = '/anytone/agent'

/** Unwrap a dbus-next Variant ({ signature, value }) to its plain value. */
const v = (x: any): any => (x && typeof x === 'object' && 'signature' in x && 'value' in x ? x.value : x)

// A pairing agent that auto-accepts SSP. Registered as DisplayYesNo (see registerAgent): the radio
// uses numeric-comparison, so BlueZ calls RequestConfirmation — we accept it (return, no error).
// RequestPasskey/RequestPinCode stay as safety fallbacks but shouldn't fire with DisplayYesNo.
class AutoAgent extends Interface {
  private readonly pin: string
  constructor(pin: string | undefined, private readonly log: (message: string) => void = () => {}) {
    super('org.bluez.Agent1')
    this.pin = String(pin ?? '0000')
  }
  Release(): void { this.log('agent: Release') }
  RequestPinCode(device: string): string {
    this.log(`agent: RequestPinCode ${device} -> ${this.pin}`)
    return this.pin
  }
  RequestPasskey(device: string): number {
    const passkey = Number.parseInt(this.pin, 10) || 0
    this.log(`agent: RequestPasskey ${device} -> ${passkey}`)
    return passkey
  }
  DisplayPinCode(device: string, pin: string): void { this.log(`agent: DisplayPinCode ${device} ${pin}`) }
  DisplayPasskey(device: string, passkey: number, entered: number): void { this.log(`agent: DisplayPasskey ${device} ${passkey} entered=${entered}`) }
  RequestConfirmation(device: string, passkey: number): void { this.log(`agent: RequestConfirmation ${device} ${passkey} -> accepted`) }
  RequestAuthorization(device: string): void { this.log(`agent: RequestAuthorization ${device} -> accepted`) }
  AuthorizeService(device: string, uuid: string): void { this.log(`agent: AuthorizeService ${device} ${uuid} -> accepted`) }
  Cancel(): void { this.log('agent: Cancel') }
}
;(AutoAgent as any).configureMembers({
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

export class Bluez extends EventEmitter implements BluezApi {
  private bus: any = null
  private om: any = null
  private adapterPath: string | null = null
  private readonly pin: string | undefined
  private readonly propsWatchers = new Map<string, { props: any; handler: (...args: any[]) => void }>()
  private readonly log: (message: string) => void
  private agent: AutoAgent | null = null
  // Transport for discovery. The radio exposes its remote-head control (SPP) + audio (HFP-AG) on
  // its Classic BR/EDR interface; it ALSO advertises a useless LE shadow (name ELET_AGHF_LE…) at
  // the same address. Default BlueZ discovery ('auto') often surfaces only the LE advert, so Pair()
  // bonds over LE/SMP and the radio rejects it ("Confirm value failed" → Authentication Failed).
  // Forcing 'bredr' makes BlueZ run the Classic inquiry that surfaces the real interface. Override
  // to 'auto'/'le' only if you specifically need LE discovery.
  private readonly discoveryTransport: string
  private filterSet = false

  constructor(opts: { pin?: string; log?: (message: string) => void; discoveryTransport?: string } = {}) {
    super()
    this.pin = opts.pin
    this.log = opts.log ?? (() => {})
    this.discoveryTransport = opts.discoveryTransport ?? 'bredr'
  }

  async init(): Promise<void> {
    if (this.bus) return
    this.bus = dbus.systemBus()
    this.bus.on('error', (err: Error) => this.emit('error', err))
    const root = await this.bus.getProxyObject(BLUEZ, '/')
    this.om = root.getInterface(OM_IFACE)
    const managed = await this.om.GetManagedObjects()
    for (const [path, ifaces] of Object.entries(managed) as [string, any][]) {
      if (ifaces[ADAPTER_IFACE] && !this.adapterPath) this.adapterPath = path
    }
    if (!this.adapterPath) {
      throw new Error('no Bluetooth adapter found (is the controller present and bluetoothd running?)')
    }
    this.om.on('InterfacesAdded', (path: string, ifaces: any) => {
      if (ifaces[DEVICE_IFACE]) {
        void this.watchDevice(path)
        this.emit('deviceAdded', this.shapeDevice(path, ifaces[DEVICE_IFACE]))
      }
    })
    this.om.on('InterfacesRemoved', (path: string, ifaces: string[]) => {
      if (ifaces.includes(DEVICE_IFACE)) {
        this.unwatchDevice(path)
        this.emit('deviceRemoved', { path })
      }
    })
    for (const [path, ifaces] of Object.entries(managed) as [string, any][]) {
      if (ifaces[DEVICE_IFACE]) await this.watchDevice(path)
    }
  }

  get adapter(): string | null {
    return this.adapterPath
  }

  private async props(path: string): Promise<any> {
    const obj = await this.bus.getProxyObject(BLUEZ, path)
    return obj.getInterface(PROPS_IFACE)
  }

  private async iface(path: string, name: string): Promise<any> {
    const obj = await this.bus.getProxyObject(BLUEZ, path)
    return obj.getInterface(name)
  }

  private shapeDevice(path: string, props: any): Device {
    return {
      path,
      address: normAddr(v(props.Address)),
      name: v(props.Name) ?? v(props.Alias) ?? null,
      alias: v(props.Alias) ?? null,
      paired: !!v(props.Paired),
      trusted: !!v(props.Trusted),
      connected: !!v(props.Connected),
      uuids: ((v(props.UUIDs) as string[]) || []).map((u) => String(u).toLowerCase()),
      rssi: v(props.RSSI) ?? null,
    }
  }

  private async watchDevice(path: string): Promise<void> {
    if (this.propsWatchers.has(path)) return
    const props = await this.props(path)
    const handler = (iface: string, changed: Record<string, any>): void => {
      if (iface !== DEVICE_IFACE) return
      const patch: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(changed)) patch[k] = v(val)
      this.emit('deviceChanged', { path, changed: patch })
    }
    props.on('PropertiesChanged', handler)
    this.propsWatchers.set(path, { props, handler })
  }

  private unwatchDevice(path: string): void {
    const w = this.propsWatchers.get(path)
    if (w) {
      try {
        w.props.off('PropertiesChanged', w.handler)
      } catch {
        /* ignore */
      }
      this.propsWatchers.delete(path)
    }
  }

  async listDevices(): Promise<Device[]> {
    const managed = await this.om.GetManagedObjects()
    const out: Device[] = []
    for (const [path, ifaces] of Object.entries(managed) as [string, any][]) {
      if (ifaces[DEVICE_IFACE]) out.push(this.shapeDevice(path, ifaces[DEVICE_IFACE]))
    }
    return out
  }

  async findDeviceByAddress(addr: string): Promise<Device | null> {
    const want = normAddr(addr)
    return (await this.listDevices()).find((d) => d.address === want) ?? null
  }

  private async devicePath(addr: string): Promise<string> {
    const d = await this.findDeviceByAddress(addr)
    if (!d) throw new Error(`device ${normAddr(addr)} is not known to BlueZ (not in range / never discovered)`)
    return d.path
  }

  async adapterInfo(): Promise<AdapterInfo> {
    const props = await this.props(this.adapterPath!)
    const all = await props.GetAll(ADAPTER_IFACE)
    return {
      path: this.adapterPath!,
      address: normAddr(v(all.Address)),
      powered: !!v(all.Powered),
      discovering: !!v(all.Discovering),
    }
  }

  async powerOn(): Promise<void> {
    const props = await this.props(this.adapterPath!)
    const powered = v(await props.Get(ADAPTER_IFACE, 'Powered'))
    if (!powered) await props.Set(ADAPTER_IFACE, 'Powered', new Variant('b', true))
  }

  /** Constrain discovery to a transport (default 'bredr'). MUST be applied before StartDiscovery
   * and cannot change while discovery is running, so we set it once and remember. Tolerant: a
   * failure here just falls back to the adapter's default (auto) behaviour. */
  private async ensureDiscoveryFilter(): Promise<void> {
    if (this.filterSet) return
    const adapter = await this.iface(this.adapterPath!, ADAPTER_IFACE)
    try {
      await adapter.SetDiscoveryFilter({ Transport: new Variant('s', this.discoveryTransport) })
      this.log(`bluez: SetDiscoveryFilter Transport=${this.discoveryTransport}`)
      this.filterSet = true
    } catch (err: any) {
      this.log(`bluez: SetDiscoveryFilter failed: ${err?.message ?? err}`)
    }
  }

  async startDiscovery(): Promise<void> {
    const adapter = await this.iface(this.adapterPath!, ADAPTER_IFACE)
    await this.ensureDiscoveryFilter()
    try {
      this.log('bluez: StartDiscovery')
      await adapter.StartDiscovery()
    } catch (err: any) {
      if (!/InProgress|already/i.test(err?.message || '')) throw err
    }
  }

  async stopDiscovery(): Promise<void> {
    const adapter = await this.iface(this.adapterPath!, ADAPTER_IFACE)
    try {
      this.log('bluez: StopDiscovery')
      await adapter.StopDiscovery()
    } catch {
      /* ignore */
    }
  }

  async pair(addr: string): Promise<void> {
    const path = await this.devicePath(addr)
    this.log(`bluez: Pair ${normAddr(addr)} (${path})`)
    const dev = await this.iface(path, DEVICE_IFACE)
    await dev.Pair()
  }

  async setTrusted(addr: string, trusted = true): Promise<void> {
    const props = await this.props(await this.devicePath(addr))
    await props.Set(DEVICE_IFACE, 'Trusted', new Variant('b', !!trusted))
  }

  async connect(addr: string): Promise<void> {
    const dev = await this.iface(await this.devicePath(addr), DEVICE_IFACE)
    await dev.Connect()
  }

  async disconnect(addr: string): Promise<void> {
    const found = await this.findDeviceByAddress(addr)
    if (!found) return
    const dev = await this.iface(found.path, DEVICE_IFACE)
    try {
      await dev.Disconnect()
    } catch {
      /* ignore */
    }
  }

  async removeDevice(addr: string): Promise<void> {
    const found = await this.findDeviceByAddress(addr)
    if (!found) return
    const adapter = await this.iface(this.adapterPath!, ADAPTER_IFACE)
    try {
      await adapter.RemoveDevice(found.path)
    } catch {
      /* ignore */
    }
  }

  async registerAgent(): Promise<void> {
    if (this.agent) return
    const agent = new AutoAgent(this.pin, this.log)
    this.bus.export(AGENT_PATH, agent)
    const mgr = await this.iface('/org/bluez', AGENT_MANAGER_IFACE)
    // DisplayYesNo (NOT KeyboardDisplay): the radio does SSP numeric-comparison — it shows a code
    // and expects the peer to CONFIRM it (the yes/no prompt the desktop applet pops). Advertising a
    // keyboard (KeyboardDisplay) makes BlueZ pick Passkey-Entry instead and call RequestPasskey,
    // which we can't answer (the passkey is on the radio's screen) → "authentication failed".
    // DisplayYesNo routes to RequestConfirmation, which we auto-accept; simpler radios fall back to
    // Just-Works. Either way we're never asked to type a passkey we don't have.
    await mgr.RegisterAgent(AGENT_PATH, 'DisplayYesNo')
    this.log('bluez: registered pairing agent DisplayYesNo')
    try {
      await mgr.RequestDefaultAgent(AGENT_PATH)
      this.log('bluez: pairing agent is default')
    } catch (e) {
      this.log(`bluez: RequestDefaultAgent failed: ${(e as Error).message}`)
    }
    this.agent = agent
  }

  async unregisterAgent(): Promise<void> {
    if (!this.agent) return
    try {
      const mgr = await this.iface('/org/bluez', AGENT_MANAGER_IFACE)
      await mgr.UnregisterAgent(AGENT_PATH)
    } catch {
      /* ignore */
    }
    try {
      this.bus.unexport(AGENT_PATH, this.agent)
    } catch {
      /* ignore */
    }
    this.agent = null
  }

  close(): void {
    for (const path of [...this.propsWatchers.keys()]) this.unwatchDevice(path)
    try {
      this.bus?.disconnect()
    } catch {
      /* ignore */
    }
    this.bus = null
  }
}
