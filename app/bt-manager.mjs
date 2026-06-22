// Connection state machine for the radio's Bluetooth link.
//
// WHY THIS EXISTS: connecting used to assume a hand-prepared host — the radio
// already paired+trusted via `bluetoothctl`, a fixed MAC in .env, and the adapter
// powered. Any drift (lost bond, swapped radio, fresh Pi, adapter off) produced a
// dead end. This module owns the full chain and recovers automatically:
//
//   adapterReady -> deviceKnown -> pairedTrusted -> aclConnected
//
// Identity is MAC-primary with a name fallback: if ANYTONE_BT_ADDR is set and the
// device is reachable we use it; otherwise we scan and adopt the first device that
// looks like the radio (SPP + HFP-AG, name match), persisting the address so the
// next boot is instant. It drives BlueZ purely over D-Bus via [[bluez.mjs]] and
// emits step-level status the server forwards to the UI. It deliberately does NOT
// own the SPP control socket or audio — the server opens those once this resolves.
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bluez, isLikelyRadio } from './bluez.mjs'

const STATE_PATH = process.env.ANYTONE_BT_STATE
  || fileURLToPath(new URL('./.data/bt-state.json', import.meta.url))

const delay = ms => new Promise(r => setTimeout(r, ms))
const PLACEHOLDER = 'AA:BB:CC:DD:EE:FF'
const normAddr = a => String(a || '').trim().toUpperCase()
const isValidAddr = a => /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(normAddr(a)) && normAddr(a) !== PLACEHOLDER

// Profiles that ONLY a Classic BR/EDR interface can carry. A D578 advertises two
// addresses under the same name: the Classic one (SPP for the control socket +
// HFP-AG for audio — the interface we actually need) and a BLE shadow that has
// neither. These are the positive Classic discriminators used when collapsing the
// same-named pair down to one entry.
const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb'
const HFP_AG_UUID = '0000111f-0000-1000-8000-00805f9b34fb'
const hasUuid = (d, u) => (d.uuids || []).includes(u)
// MAC as a comparable integer (48 bits fits in a JS number). The Classic
// interface sits at the LOWER address; the BLE shadow is the adjacent higher one
// (user-confirmed across hardware, e.g. Classic ..:1C:.. vs BLE ..:2C:..).
const addrInt = a => Number.parseInt(String(a).replace(/[^0-9a-fA-F]/g, ''), 16) || 0

export class BtManager extends EventEmitter {
  constructor({ address, namePattern, pin, scanTimeoutMs, log } = {}) {
    super()
    this.configuredAddress = isValidAddr(address) ? normAddr(address) : null
    this.namePattern = namePattern || /ELET_AGHF/i
    this.pin = pin || '0000'
    this.scanTimeoutMs = scanTimeoutMs || 20000
    this.log = log || (() => {})
    this.bluez = null
    this.address = this.configuredAddress || this._loadPersisted()
    this.step = 'idle'
  }

  _loadPersisted() {
    try {
      const saved = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
      return isValidAddr(saved.address) ? normAddr(saved.address) : null
    } catch { return null }
  }

  _persist(address) {
    try {
      mkdirSync(dirname(STATE_PATH), { recursive: true })
      writeFileSync(STATE_PATH, JSON.stringify({ address, savedAt: new Date().toISOString() }, null, 2))
    } catch (err) { this.log(`bt-state persist failed: ${err?.message ?? err}`) }
  }

  _setStep(step, detail) {
    this.step = step
    this.emit('step', { step, address: this.address, detail: detail ?? null })
    if (detail) this.log(`bt: ${step} — ${detail}`)
    else this.log(`bt: ${step}`)
  }

  // Idempotent + concurrency-safe: cache the in-flight promise so parallel callers
  // (e.g. Promise.all in btStatus) all await the same completed initialization.
  async init() {
    if (this._initPromise) return this._initPromise
    this._initPromise = (async () => {
      this.bluez = new Bluez({ pin: this.pin })
      this.bluez.on('error', err => this.log(`bluez bus error: ${err?.message ?? err}`))
      await this.bluez.init()
      await this.bluez.registerAgent()
    })().catch(err => { this._initPromise = null; throw err })
    return this._initPromise
  }

  // Adapter present + powered.
  async _ensureAdapter() {
    this._setStep('adapter')
    await this.bluez.powerOn()
  }

  // Scan until a matching device appears (or timeout). Returns the matched
  // device snapshot, or null. `wantAddress` short-circuits on an exact MAC.
  async _scanFor({ wantAddress = null, timeoutMs = this.scanTimeoutMs } = {}) {
    const want = wantAddress ? normAddr(wantAddress) : null
    const match = d => want ? d.address === want : isLikelyRadio(d, this.namePattern)
    // Already known?
    const pre = (await this.bluez.listDevices()).find(match)
    if (pre) return pre

    this._setStep('discover', want ? `scanning for ${want}` : 'scanning for radio')
    let found = null
    const onAdded = d => { if (!found && match(d)) found = d }
    const onChanged = async () => {
      if (found) return
      const hit = (await this.bluez.listDevices()).find(match)
      if (hit) found = hit
    }
    this.bluez.on('deviceAdded', onAdded)
    this.bluez.on('deviceChanged', onChanged)
    await this.bluez.startDiscovery()
    try {
      const deadline = Date.now() + timeoutMs
      while (!found && Date.now() < deadline) await delay(250)
    } finally {
      await this.bluez.stopDiscovery()
      this.bluez.off('deviceAdded', onAdded)
      this.bluez.off('deviceChanged', onChanged)
    }
    return found
  }

  // Resolve which device is our radio: configured MAC first (known or via scan),
  // then name-fallback discovery; adopt + persist the result.
  async _resolveDevice() {
    // 1. Configured/persisted address that's already known to BlueZ.
    if (this.address) {
      const known = await this.bluez.findDeviceByAddress(this.address)
      if (known) {
        // Self-heal a persisted/auto-adopted BLE-shadow address: only when the
        // known device is NOT itself a usable Classic interface (it lacks SPP, so
        // it's the BLE shadow) do we look for the Classic sibling and switch to it.
        // This leaves a real Classic selection — including an explicit dropdown
        // pick via setTarget, or one of two same-named radios — untouched. An
        // explicit configured MAC is always honoured as pinned.
        if (!this.configuredAddress && !hasUuid(known, SPP_UUID)) {
          const classic = await this._classicSibling(known)
          if (classic.address !== known.address) {
            this.log(`re-resolved ${known.address} -> ${classic.address} (Classic BR/EDR interface)`)
            this.address = classic.address
            this._persist(classic.address)
            return classic
          }
        }
        return known
      }
      // Known address but not currently present — try to find it by scanning.
      const scanned = await this._scanFor({ wantAddress: this.address })
      if (scanned) return this.configuredAddress ? scanned : await this._classicSibling(scanned)
      // Configured MAC takes precedence; don't silently adopt a different radio.
      if (this.configuredAddress) {
        throw new Error(`configured radio ${this.address} not found (out of range or powered off)`)
      }
    }
    // 2. Name-fallback discovery + adopt. _scanFor may have stopped on whichever
    // interface appeared first (often the BLE shadow); collapse to the Classic one.
    const hit = await this._scanFor({})
    if (!hit) throw new Error('no radio found — power it on and ensure it is in range / pairable')
    const found = await this._classicSibling(hit)
    if (found.address !== this.address) {
      this.address = found.address
      this._persist(found.address)
      this.log(`adopted radio ${found.address} (${found.name ?? '?'}) by name match`)
    }
    return found
  }

  async _waitForDevice(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const d = await this.bluez.findDeviceByAddress(this.address)
      if (d && predicate(d)) return d
      await delay(250)
    }
    return null
  }

  // Phase A: bring the radio to a paired+trusted, addressable state — adapter
  // powered, device resolved (configured MAC or name-fallback), paired + trusted.
  // Does NOT connect the ACL (the server starts the HFP audio handler first, then
  // calls connectAcl). Returns the resolved address.
  async ensureReady({ allowPair = true } = {}) {
    await this.init()
    await this._ensureAdapter()
    let dev = await this._resolveDevice()

    if (!dev.paired) {
      if (!allowPair) throw new Error(`radio ${dev.address} is not paired`)
      this._setStep('pair', `pairing ${dev.address}`)
      try {
        await this.bluez.pair(dev.address)
      } catch (err) {
        throw new Error(`pairing failed for ${dev.address}: ${err?.message ?? err} — put the radio in pairing mode and retry`)
      }
      dev = await this._waitForDevice(d => d.paired, 15000) || dev
    }

    // Trust so future auto-reconnects need no agent prompt.
    if (!dev.trusted) {
      this._setStep('trust')
      try { await this.bluez.setTrusted(dev.address, true) } catch (err) { this.log(`set trusted failed: ${err?.message ?? err}`) }
    }

    this._setStep('paired')
    return this.address
  }

  // Phase B: connect the ACL + profiles. Device1.Connect connects every advertised
  // profile; SPP has no BlueZ handler here (we use a raw RFCOMM socket) so it errors
  // even on success — tolerate `*profile-unavailable*`/`NotAvailable` as long as the
  // device actually reaches Connected. Must run AFTER the HFP handler (BlueALSA) is
  // up, else there is no profile to connect and the call fails outright.
  async connectAcl() {
    const cur = await this.bluez.findDeviceByAddress(this.address)
    if (cur?.connected) { this._setStep('ready'); return this.address }
    this._setStep('connect', `connecting ${this.address}`)
    try {
      await this.bluez.connect(this.address)
    } catch (err) {
      const msg = err?.message || String(err)
      if (!/profile-unavailable|NotAvailable|not available/i.test(msg)) throw err
      this.log(`connect: tolerating partial-profile error (${msg})`)
    }
    const up = await this._waitForDevice(d => d.connected, 15000)
    if (!up) throw new Error(`ACL did not connect for ${this.address}`)
    this._setStep('ready')
    return this.address
  }

  // Full chain (standalone use / tests): ready + connect.
  async ensureConnected(opts = {}) {
    await this.ensureReady(opts)
    return this.connectAcl()
  }

  // Drop the ACL — the radio's clean way out of COM MODE.
  async disconnectAcl() {
    if (this.bluez && this.address) {
      try { await this.bluez.disconnect(this.address) } catch (err) { this.log(`acl disconnect: ${err?.message ?? err}`) }
    }
  }

  // Manual UI helpers ------------------------------------------------------
  // A single radio often advertises twice — its Classic BR/EDR address (which
  // carries SPP+HFP) and a BLE shadow at an adjacent address with the same name
  // but no usable profiles. Collapse same-named shadows down to the Classic entry.
  // Shared by the scan picker and the status panel so they never disagree.
  //
  // Picking the Classic interface is the whole ballgame here: pair the BLE shadow
  // and the radio looks paired/trusted/connected in bluetoothctl yet the app's SPP
  // control socket never opens. We must NOT rank by raw UUID count — a BLE shadow
  // can advertise MORE (GATT) UUIDs than the Classic interface's two (SPP+HFP-AG),
  // so "most UUIDs" actively picks the wrong one. Prefer, in order: the explicitly
  // configured MAC; an entry carrying SPP; one carrying HFP-AG; then the lower
  // address (the Classic interface; the BLE shadow is the adjacent higher one).
  _preferClassic(cand, prev) {
    const conf = d => this.configuredAddress && d.address === this.configuredAddress
    if (conf(cand) !== conf(prev)) return conf(cand)
    if (hasUuid(cand, SPP_UUID) !== hasUuid(prev, SPP_UUID)) return hasUuid(cand, SPP_UUID)
    if (hasUuid(cand, HFP_AG_UUID) !== hasUuid(prev, HFP_AG_UUID)) return hasUuid(cand, HFP_AG_UUID)
    return addrInt(cand.address) < addrInt(prev.address)
  }

  _dedupeRadios(devices) {
    const radios = devices.filter(d => isLikelyRadio(d, this.namePattern))
    const best = new Map()
    for (const d of radios) {
      const key = (d.name || d.address).toUpperCase()
      const prev = best.get(key)
      if (!prev || this._preferClassic(d, prev)) best.set(key, d)
    }
    return [...best.values()].map(d => ({ ...d, configured: !!this.configuredAddress && d.address === this.configuredAddress }))
  }

  // Given any device snapshot that may be a BLE shadow, return the Classic
  // interface of the same-named radio if BlueZ knows it. Used to self-heal an
  // address that was discovered/persisted as the shadow.
  async _classicSibling(dev) {
    if (!dev) return dev
    const name = (dev.name || '').toUpperCase()
    if (!name) return dev
    const best = this._dedupeRadios(await this.bluez.listDevices())
      .find(d => (d.name || '').toUpperCase() === name)
    return best || dev
  }

  // Return candidate radios seen during a fresh scan (for an explicit picker).
  async scanForRadios({ timeoutMs = this.scanTimeoutMs } = {}) {
    await this.init()
    await this._ensureAdapter()
    // If we know which radio we want, bias the scan toward finding that exact
    // (Classic) address rather than stopping on whichever shadow appears first.
    await this._scanFor(this.configuredAddress ? { wantAddress: this.configuredAddress, timeoutMs } : { timeoutMs })
    return this._dedupeRadios(await this.bluez.listDevices())
  }

  async pairAddress(address) {
    await this.init()
    await this._ensureAdapter()
    const addr = normAddr(address)
    if (!await this.bluez.findDeviceByAddress(addr)) await this._scanFor({ wantAddress: addr })
    await this.bluez.pair(addr)
    try { await this.bluez.setTrusted(addr, true) } catch {}
    this.address = addr
    this._persist(addr)
    return addr
  }

  async forget(address) {
    await this.init()
    await this.bluez.removeDevice(normAddr(address || this.address))
  }

  // Point the next connection at a specific (already-paired) radio chosen in the
  // UI — overrides the configured/persisted default for this session.
  setTarget(address) {
    const a = normAddr(address)
    if (isValidAddr(a)) this.address = a
  }

  // Known radios (no scan) + adapter info, for the status panel. Deduped the same
  // way as the scan picker so the two views never disagree.
  async listRadios() {
    await this.init()
    return this._dedupeRadios(await this.bluez.listDevices())
  }

  async adapterInfo() {
    await this.init()
    return this.bluez.adapterInfo()
  }

  statusSnapshot() {
    return { step: this.step, address: this.address, configuredAddress: this.configuredAddress, adapter: this.bluez?.adapter ?? null }
  }

  close() {
    try { this.bluez?.close() } catch {}
    this.bluez = null
  }
}
