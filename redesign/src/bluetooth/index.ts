import { Bluez } from './bluez'
import { BtManager, type BtManagerOptions } from './manager'

export * from './types'
export * from './radio-select'
export { Bluez } from './bluez'
export { BtManager } from './manager'
export { resolveSppChannel, parseSppChannel } from './sdp'

/** Wire a BtManager onto the real BlueZ D-Bus bus. */
export function createBtManager(opts: Omit<BtManagerOptions, 'bluez'> & { pin?: string }): BtManager {
  const bluez = new Bluez({ ...(opts.pin !== undefined ? { pin: opts.pin } : {}), ...(opts.log ? { log: opts.log } : {}) })
  return new BtManager({ ...opts, bluez })
}
