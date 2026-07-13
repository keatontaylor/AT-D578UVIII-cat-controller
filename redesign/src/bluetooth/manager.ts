// Connection state machine for the radio's Bluetooth link (ported from the PoC's
// bt-manager.mjs). Owns the full chain and recovers automatically:
//
//   adapter powered → device resolved → paired + trusted → ACL connected
//
// Identity is MAC-primary with a name fallback. Drives BlueZ purely through the injected
// BluezApi; emits step-level status. It deliberately does NOT own the SPP control socket or
// audio — the caller opens the RfcommTransport once this resolves.

import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  addrInt,
  dedupeRadios,
  isLikelyRadio,
  isValidAddr,
  normAddr,
  preferClassic,
  type RadioCandidate,
  SPP_UUID,
} from './radio-select'
import type { AdapterInfo, BluezApi, BtStep, Device, Logger, StepEvent } from './types'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const hasSpp = (d: Device): boolean => d.uuids.includes(SPP_UUID)
const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const timer = setTimeout(resolve, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason ?? 'aborted'))
}
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal)
}

export interface BtManagerOptions {
  readonly bluez: BluezApi
  readonly address?: string | null
  readonly namePattern?: RegExp
  readonly scanTimeoutMs?: number
  /** Where to persist an adopted address; null disables persistence. */
  readonly statePath?: string | null
  readonly log?: Logger
}

export class BtManager extends EventEmitter {
  private readonly bluez: BluezApi
  private readonly configuredAddress: string | null
  private readonly namePattern: RegExp
  private readonly scanTimeoutMs: number
  private readonly statePath: string | null
  private readonly log: Logger
  private initPromise: Promise<void> | null = null

  address: string | null
  step: BtStep = 'idle'

  constructor(opts: BtManagerOptions) {
    super()
    this.bluez = opts.bluez
    this.configuredAddress = isValidAddr(opts.address) ? normAddr(opts.address) : null
    this.namePattern = opts.namePattern ?? /ELET_AGHF/i
    this.scanTimeoutMs = opts.scanTimeoutMs ?? 20000
    this.statePath = opts.statePath === undefined ? null : opts.statePath
    this.log = opts.log ?? (() => {})
    this.address = this.configuredAddress ?? this.loadPersisted()
  }

  // ── persistence ────────────────────────────────────────────────────────────
  private loadPersisted(): string | null {
    if (!this.statePath) return null
    try {
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as { address?: string }
      return isValidAddr(saved.address) ? normAddr(saved.address) : null
    } catch {
      return null
    }
  }

  private persist(address: string): void {
    if (!this.statePath) return
    try {
      mkdirSync(dirname(this.statePath), { recursive: true })
      writeFileSync(this.statePath, JSON.stringify({ address, savedAt: new Date().toISOString() }, null, 2))
    } catch (e) {
      this.log(`bt-state persist failed: ${errMsg(e)}`)
    }
  }

  private setStep(step: BtStep, detail?: string): void {
    this.step = step
    const event: StepEvent = { step, address: this.address, detail: detail ?? null }
    this.emit('step', event)
    this.log(detail ? `bt: ${step} — ${detail}` : `bt: ${step}`)
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  /** Idempotent + concurrency-safe: parallel callers await the same initialization. */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      this.bluez.on('error', (err: Error) => this.log(`bluez bus error: ${errMsg(err)}`))
      await this.bluez.init()
      await this.bluez.registerAgent()
    })().catch((err: unknown) => {
      this.initPromise = null
      throw err
    })
    return this.initPromise
  }

  private async ensureAdapter(): Promise<void> {
    this.setStep('adapter')
    await this.bluez.powerOn()
  }

  /** Phase A: adapter powered, device resolved, paired + trusted. Does NOT connect the ACL. */
  async ensureReady({ allowPair = true, signal }: { allowPair?: boolean; signal?: AbortSignal } = {}): Promise<string> {
    throwIfAborted(signal)
    await this.init()
    throwIfAborted(signal)
    await this.ensureAdapter()
    throwIfAborted(signal)
    let dev = await this.resolveDevice(signal)
    throwIfAborted(signal)

    if (!dev.paired) {
      if (!allowPair) throw new Error(`radio ${dev.address} is not paired`)
      this.setStep('pair', `pairing ${dev.address}`)
      try {
        await this.pairWithDiscovery(dev.address)
      } catch (e) {
        throw new Error(`pairing failed for ${dev.address}: ${errMsg(e)} — put the radio in pairing mode and retry`)
      }
      throwIfAborted(signal)
      dev = (await this.waitForDevice((d) => d.paired, 15000, signal)) ?? dev
    }

    if (!dev.trusted) {
      this.setStep('trust')
      try {
        await this.bluez.setTrusted(dev.address, true)
      } catch (e) {
        this.log(`set trusted failed: ${errMsg(e)}`)
      }
    }

    throwIfAborted(signal)
    this.setStep('paired')
    return this.address!
  }

  /** Phase B: connect the ACL + profiles. Device1.Connect connects every advertised profile;
   * SPP has no BlueZ handler here (we use a raw socket) so it errors even on success —
   * tolerate the partial-profile error as long as the device actually reaches Connected. */
  async connectAcl({ signal }: { signal?: AbortSignal } = {}): Promise<string> {
    // Do NOT early-return on `connected`: that flag only means an ACL/some profile is up, not that
    // HFP is. A fresh pair leaves the SSP bonding ACL connected, so skipping Connect() here would
    // never establish the HFP-AG profile and BlueALSA's HFP PCM would never appear. Always drive
    // Device1.Connect() — it connects any not-yet-connected profiles (incl. HFP) and is a no-op
    // once everything is up.
    this.setStep('connect', `connecting ${this.address}`)
    throwIfAborted(signal)
    try {
      await this.bluez.connect(this.address!)
    } catch (e) {
      const msg = errMsg(e)
      // SPP has no BlueZ handler (we use a raw socket) so it errors even on success; an
      // already-connected link is likewise benign. Tolerate both — the connected-wait is the gate.
      if (!/profile-unavailable|NotAvailable|not available|already connected|in progress/i.test(msg)) throw e
      this.log(`connect: tolerating (${msg})`)
    }
    throwIfAborted(signal)
    const up = await this.waitForDevice((d) => d.connected, 15000, signal)
    if (!up) throw new Error(`ACL did not connect for ${this.address}`)
    this.setStep('ready')
    return this.address!
  }

  /** Full chain (standalone use / tests): ready + connect. */
  async ensureConnected(opts: { allowPair?: boolean } = {}): Promise<string> {
    await this.ensureReady(opts)
    return this.connectAcl()
  }

  /** Drop the ACL — the radio's clean way out of COM MODE. */
  async disconnectAcl(): Promise<void> {
    if (this.address) {
      try {
        await this.bluez.disconnect(this.address)
      } catch (e) {
        this.log(`acl disconnect: ${errMsg(e)}`)
      }
    }
  }

  // ── device resolution ──────────────────────────────────────────────────────
  private async resolveDevice(signal?: AbortSignal): Promise<Device> {
    throwIfAborted(signal)
    if (this.address) {
      const known = await this.bluez.findDeviceByAddress(this.address)
      throwIfAborted(signal)
      if (known) {
        // Self-heal a persisted/auto-adopted BLE-shadow address (only when it isn't itself a
        // usable Classic interface, and wasn't an explicit configured MAC).
        if (!this.configuredAddress && !hasSpp(known)) {
          const classic = await this.classicSibling(known)
          if (classic.address !== known.address) {
            this.log(`re-resolved ${known.address} -> ${classic.address} (Classic BR/EDR interface)`)
            this.address = classic.address
            this.persist(classic.address)
            return classic
          }
        }
        return known
      }
      const scanned = await this.scanFor(signal ? { wantAddress: this.address, signal } : { wantAddress: this.address })
      if (scanned) return this.configuredAddress ? scanned : await this.classicSibling(scanned)
      if (this.configuredAddress) {
        throw new Error(`configured radio ${this.address} not found (out of range or powered off)`)
      }
    }
    const hit = await this.scanFor(signal ? { signal } : undefined)
    if (!hit) throw new Error('no radio found — power it on and ensure it is in range / pairable')
    const found = await this.classicSibling(hit)
    if (found.address !== this.address) {
      this.address = found.address
      this.persist(found.address)
      this.log(`adopted radio ${found.address} (${found.name ?? '?'}) by name match`)
    }
    return found
  }

  private async waitForDevice(predicate: (d: Device) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<Device | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      const d = await this.bluez.findDeviceByAddress(this.address!)
      if (d && predicate(d)) return d
      await delay(250, signal)
    }
    return null
  }

  /** Scan until a matching device appears (or timeout). `wantAddress` short-circuits on MAC. */
  private async scanFor({
    wantAddress = null,
    timeoutMs = this.scanTimeoutMs,
    signal,
  }: { wantAddress?: string | null; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Device | null> {
    throwIfAborted(signal)
    const want = wantAddress ? normAddr(wantAddress) : null
    const match = (d: Device): boolean => (want ? d.address === want : isLikelyRadio(d, this.namePattern))

    const pre = (await this.bluez.listDevices()).find(match)
    if (pre) return pre

    this.setStep('discover', want ? `scanning for ${want}` : 'scanning for radio')
    let found: Device | null = null
    const onAdded = (d: Device): void => {
      if (!found && match(d)) found = d
    }
    const onChanged = async (): Promise<void> => {
      if (found) return
      const hit = (await this.bluez.listDevices()).find(match)
      if (hit) found = hit
    }
    this.bluez.on('deviceAdded', onAdded)
    this.bluez.on('deviceChanged', onChanged)
    await this.bluez.startDiscovery()
    try {
      const deadline = Date.now() + timeoutMs
      while (!found && Date.now() < deadline) await delay(250, signal)
    } finally {
      await this.bluez.stopDiscovery()
      this.bluez.off('deviceAdded', onAdded)
      this.bluez.off('deviceChanged', onChanged)
    }
    return found
  }

  private async pairWithDiscovery(addr: string): Promise<void> {
    // BlueZ desktop UIs keep discovery active while pairing. Some unbonded devices disappear or
    // refuse SSP if discovery is stopped between "found" and Pair(); cached BlueZ devices are not
    // proof the radio is currently page-scannable. Keep discovery running for the whole Pair() call.
    this.log(`pair: keeping discovery active while pairing ${addr}`)
    await this.bluez.startDiscovery()
    try {
      await this.bluez.pair(addr)
    } finally {
      await this.bluez.stopDiscovery()
    }
  }

  /** Given a snapshot that may be a BLE shadow, return the Classic interface of the same-named
   * radio if BlueZ knows it. */
  private async classicSibling(dev: Device): Promise<Device> {
    const name = (dev.name ?? '').toUpperCase()
    if (!name) return dev
    const best = this.dedupe(await this.bluez.listDevices()).find((d) => (d.name ?? '').toUpperCase() === name)
    return best ?? dev
  }

  private dedupe(devices: Device[]): RadioCandidate[] {
    return dedupeRadios(devices, this.namePattern, this.configuredAddress)
  }

  // ── manual / UI helpers ─────────────────────────────────────────────────────
  async scanForRadios({ timeoutMs = this.scanTimeoutMs }: { timeoutMs?: number } = {}): Promise<RadioCandidate[]> {
    await this.init()
    await this.ensureAdapter()
    await this.scanFor(this.configuredAddress ? { wantAddress: this.configuredAddress, timeoutMs } : { timeoutMs })
    return this.dedupe(await this.bluez.listDevices())
  }

  async pairAddress(address: string): Promise<string> {
    await this.init()
    await this.ensureAdapter()
    const requested = normAddr(address)
    // Never pair a BLE shadow: that bonds over LE/SMP and the radio rejects it ("Confirm value
    // failed" → Authentication Failed). Resolve the request to the Classic BR/EDR interface exactly
    // like the auto path — a bredr scan surfaces the Classic sibling, classicSibling picks it by
    // name (lower address wins the tie). If the requested device isn't known yet, scan for it first.
    let dev = await this.bluez.findDeviceByAddress(requested)
    if (!dev) dev = await this.scanFor({ wantAddress: requested })
    const addr = dev ? (await this.classicSibling(dev)).address : requested
    if (addr !== requested) this.log(`pair: resolved ${requested} -> ${addr} (Classic BR/EDR interface)`)
    await this.pairWithDiscovery(addr)
    try {
      await this.bluez.setTrusted(addr, true)
    } catch {
      /* tolerate */
    }
    this.address = addr
    this.persist(addr)
    return addr
  }

  async forget(address?: string): Promise<void> {
    await this.init()
    const addr = normAddr(address ?? this.address)
    // Untrust first (pairAddress sets Trusted=true) so trust can't survive a partial RemoveDevice —
    // a re-discovered device must come back untrusted, forcing a fresh, deliberate pair.
    await this.bluez.setTrusted(addr, false).catch(() => undefined)
    await this.bluez.removeDevice(addr)
  }

  /** Point the next connection at a specific already-paired radio (UI override). */
  setTarget(address: string): void {
    const a = normAddr(address)
    if (isValidAddr(a)) this.address = a
  }

  async listRadios(): Promise<RadioCandidate[]> {
    await this.init()
    return this.dedupe(await this.bluez.listDevices())
  }

  async adapterInfo(): Promise<AdapterInfo> {
    await this.init()
    return this.bluez.adapterInfo()
  }

  /** The resolved adapter object path (e.g. /org/bluez/hci0), or null before init. */
  get adapterPath(): string | null {
    return this.bluez.adapter
  }

  statusSnapshot(): { step: BtStep; address: string | null; configuredAddress: string | null; adapter: string | null } {
    return {
      step: this.step,
      address: this.address,
      configuredAddress: this.configuredAddress,
      adapter: this.bluez.adapter,
    }
  }

  close(): void {
    try {
      this.bluez.close()
    } catch {
      /* ignore */
    }
  }
}

// re-export for convenience
export { addrInt }
