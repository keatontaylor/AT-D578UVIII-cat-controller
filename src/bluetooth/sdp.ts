// SPP RFCOMM channel discovery. The radio's control socket is Serial Port (SPP, UUID 0x1101) on a
// BR/EDR RFCOMM channel. That channel is NOT exposed by BlueZ's Device1 D-Bus API, so we browse the
// device's SDP record with sdptool and read the channel from it — instead of hardcoding 2 and
// failing with a cryptic connect() errno if the firmware ever moves it. Falls back to the caller's
// default when discovery is unavailable (sdptool missing, device unreachable, etc.).
//
// parseSppChannel is pure (unit-tested); resolveSppChannel shells out (exercised live).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

/** Extract the SPP RFCOMM channel from `sdptool search SP` output. That query returns only Serial
 * Port records, so the first `Channel:` line is the SPP channel. Returns null if none/implausible. */
export function parseSppChannel(output: string): number | null {
  const m = /^\s*Channel:\s*(\d+)\s*$/im.exec(output)
  if (!m) return null
  const ch = Number(m[1])
  return Number.isInteger(ch) && ch >= 1 && ch <= 30 ? ch : null
}

export type SdpRunner = (addr: string) => Promise<string>

const runSdptool: SdpRunner = async (addr) => {
  const { stdout } = await pexec('sdptool', ['search', '--bdaddr', addr, 'SP'], { timeout: 8000 })
  return stdout ?? ''
}

/** Resolve the SPP RFCOMM channel for a paired device, or null if it can't be determined. Never
 * throws — a discovery failure just yields null so the caller can fall back to its default. */
export async function resolveSppChannel(addr: string, run: SdpRunner = runSdptool): Promise<number | null> {
  try {
    return parseSppChannel(await run(addr))
  } catch {
    return null
  }
}
