// Pure radio-identity logic — the part that is decision, not I/O, and the part most worth
// testing. A D578 advertises TWICE under one name: its Classic BR/EDR interface (SPP for the
// control socket + HFP-AG for audio — the one we need) and a BLE shadow at an adjacent
// address with neither. Picking the Classic interface is the whole ballgame: pair the BLE
// shadow and the radio looks paired/trusted/connected yet the SPP socket never opens.

import type { Device } from './types'

export const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb'
export const HFP_AG_UUID = '0000111f-0000-1000-8000-00805f9b34fb'
const PLACEHOLDER = 'AA:BB:CC:DD:EE:FF'

export function normAddr(addr: string | null | undefined): string {
  return String(addr ?? '').trim().toUpperCase()
}

export function isValidAddr(addr: string | null | undefined): boolean {
  const a = normAddr(addr)
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(a) && a !== PLACEHOLDER
}

/** MAC as a comparable integer (48 bits fits a JS number). The Classic interface sits at the
 * LOWER address; the BLE shadow is the adjacent higher one. */
export function addrInt(addr: string): number {
  return Number.parseInt(addr.replace(/[^0-9a-fA-F]/g, ''), 16) || 0
}

const hasUuid = (d: Device, u: string): boolean => d.uuids.includes(u)

/** Does this device look like the radio? Name-match always; UUIDs only gate a fully-resolved
 * PAIRED device (an unpaired/just-discovered device often exposes no/partial UUIDs, so
 * requiring SPP+HFP there would hide it from the scan — exactly when we need to find it). */
export function isLikelyRadio(device: Device, namePattern?: RegExp): boolean {
  const nameOk = namePattern ? namePattern.test(device.name ?? device.alias ?? '') : true
  if (!nameOk) return false
  if (device.paired && device.uuids.length) {
    return hasUuid(device, SPP_UUID) && hasUuid(device, HFP_AG_UUID)
  }
  return true
}

/** Is `cand` a better "Classic interface" pick than `prev`? Prefer, in order: the configured
 * MAC; an entry carrying SPP; one carrying HFP-AG; then the lower address. NEVER rank by raw
 * UUID count — a BLE shadow can advertise MORE (GATT) UUIDs than the Classic interface's two. */
export function preferClassic(cand: Device, prev: Device, configuredAddress: string | null): boolean {
  const isConf = (d: Device): boolean => configuredAddress !== null && d.address === configuredAddress
  if (isConf(cand) !== isConf(prev)) return isConf(cand)
  if (hasUuid(cand, SPP_UUID) !== hasUuid(prev, SPP_UUID)) return hasUuid(cand, SPP_UUID)
  if (hasUuid(cand, HFP_AG_UUID) !== hasUuid(prev, HFP_AG_UUID)) return hasUuid(cand, HFP_AG_UUID)
  return addrInt(cand.address) < addrInt(prev.address)
}

export interface RadioCandidate extends Device {
  readonly configured: boolean
}

/** Collapse same-named radios (Classic + BLE shadow) to one entry each — the Classic one. */
export function dedupeRadios(
  devices: readonly Device[],
  namePattern: RegExp,
  configuredAddress: string | null,
): RadioCandidate[] {
  const best = new Map<string, Device>()
  for (const d of devices) {
    if (!isLikelyRadio(d, namePattern)) continue
    const key = (d.name ?? d.address).toUpperCase()
    const prev = best.get(key)
    if (!prev || preferClassic(d, prev, configuredAddress)) best.set(key, d)
  }
  return [...best.values()].map((d) => ({
    ...d,
    configured: configuredAddress !== null && d.address === configuredAddress,
  }))
}
