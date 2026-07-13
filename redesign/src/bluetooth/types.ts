// Bluetooth seam contracts (CONNECTION_AND_COMPONENTS). The connection lifecycle
// (scan/pair/trust/connect) lives here, separate from the byte transport. `BluezApi` is the
// narrow surface the connection state machine depends on — the real implementation drives
// BlueZ over D-Bus; tests inject a fake.

import type { EventEmitter } from 'node:events'

/** A BlueZ device snapshot (addresses are uppercase colon form: AA:BB:CC:DD:EE:FF). */
export interface Device {
  readonly path: string
  readonly address: string
  readonly name: string | null
  readonly alias: string | null
  readonly paired: boolean
  readonly trusted: boolean
  readonly connected: boolean
  readonly uuids: readonly string[]
  readonly rssi: number | null
}

export interface AdapterInfo {
  readonly path: string
  readonly address: string
  readonly powered: boolean
  readonly discovering: boolean
}

/** Connection state-machine phases (also the values emitted on the manager's `step` event). */
export type BtStep =
  | 'idle'
  | 'adapter'
  | 'discover'
  | 'pair'
  | 'trust'
  | 'paired'
  | 'connect'
  | 'ready'

export interface StepEvent {
  readonly step: BtStep
  readonly address: string | null
  readonly detail: string | null
}

export type Logger = (message: string) => void

/** The BlueZ operations the connection manager needs. Emits `deviceAdded` (Device),
 * `deviceChanged` ({path, changed}), `deviceRemoved` ({path}), and `error` (Error). */
export interface BluezApi extends EventEmitter {
  init(): Promise<void>
  registerAgent(): Promise<void>
  readonly adapter: string | null
  adapterInfo(): Promise<AdapterInfo>
  powerOn(): Promise<void>
  startDiscovery(): Promise<void>
  stopDiscovery(): Promise<void>
  listDevices(): Promise<Device[]>
  findDeviceByAddress(addr: string): Promise<Device | null>
  pair(addr: string): Promise<void>
  setTrusted(addr: string, trusted?: boolean): Promise<void>
  connect(addr: string): Promise<void>
  disconnect(addr: string): Promise<void>
  removeDevice(addr: string): Promise<void>
  close(): void
}
