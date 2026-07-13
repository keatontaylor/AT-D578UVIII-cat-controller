// BlueALSA HFP handler (ported from the PoC). Uses an ISOLATED BlueALSA instance under a
// private D-Bus suffix (org.bluealsa.<suffix>) serving HFP only — never the system BlueALSA
// (A2DP for other apps) / PipeWire. All bluealsa-cli calls target it via `-B <suffix>`. The
// instance is a managed systemd unit installed by the PoC's scripts/setup.sh.
//
// Shells out to bluealsa-cli + systemctl, so it needs the daemon present — exercised live, not
// in CI. The pure pcmPath is unit-tested.

import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { AbortOptions, AudioLink, AudioLogger } from './types'

const pexec = promisify(execFile)

const DBUS_SUFFIX = process.env['ANYTONE_BLUEALSA_DBUS'] ?? 'anytone'
const DBUS_NAME = `org.bluealsa${DBUS_SUFFIX ? `.${DBUS_SUFFIX}` : ''}`
const SERVICE = process.env['ANYTONE_BLUEALSA_SERVICE'] ?? `bluealsa-${DBUS_SUFFIX || 'anytone'}.service`

// Async so polling (waitForPcm) never blocks the Node event loop — the old spawnSync stalled /ws
// heartbeats and RPC dispatch for the duration of every bluealsa-cli call during connect.
async function cli(args: string[]): Promise<{ status: number; stdout: string }> {
  const pre = DBUS_SUFFIX ? ['-B', DBUS_SUFFIX] : []
  try {
    const { stdout } = await pexec('bluealsa-cli', [...pre, ...args])
    return { status: 0, stdout: stdout ?? '' }
  } catch (e: unknown) {
    const err = e as { code?: number; stdout?: string }
    return { status: typeof err.code === 'number' ? err.code : -1, stdout: err.stdout ?? '' }
  }
}

export class BluealsaHfp implements AudioLink {
  constructor(private readonly log: AudioLogger = () => {}) {}

  pcmPath(address: string, adapterPath: string | null): string {
    const override = process.env['ANYTONE_BLUEALSA_PCM']
    if (override) return override
    const hci = (adapterPath || '/org/bluez/hci0').split('/').pop() || 'hci0'
    return `/org/bluealsa/${hci}/dev_${address.replace(/:/g, '_')}/hfphf/source`
  }

  async ensureDaemon(opts: AbortOptions = {}): Promise<void> {
    throwIfAborted(opts.signal)
    if ((await cli(['status'])).status === 0) {
      this.log(`BlueALSA ${DBUS_NAME} ready`)
      return
    }
    this.log(`BlueALSA ${DBUS_NAME} not running — starting ${SERVICE}`)
    await pexec('sudo', ['-n', 'systemctl', 'start', SERVICE]).catch(() => undefined)
    const deadline = Date.now() + 6000
    while (Date.now() < deadline) {
      throwIfAborted(opts.signal)
      if ((await cli(['status'])).status === 0) {
        this.log(`BlueALSA ${DBUS_NAME} ready`)
        return
      }
      await delay(300, undefined, { signal: opts.signal })
    }
    throw new Error(`BlueALSA instance ${DBUS_NAME} is not available — run scripts/setup.sh to install it (it never touches the system BlueALSA).`)
  }

  async waitForPcm(pcm: string, timeoutMs: number, opts: AbortOptions = {}): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      throwIfAborted(opts.signal)
      const r = await cli(['list-pcms'])
      if (r.status === 0 && r.stdout.includes(pcm)) {
        this.log(`BlueALSA HFP ready: ${pcm}`)
        return
      }
      await delay(350, undefined, { signal: opts.signal })
    }
    throw new Error(`BlueALSA HFP PCM did not appear on ${DBUS_NAME}: ${pcm}`)
  }

  captureCommand(pcm: string): { command: string; args: readonly string[] } {
    const pre = DBUS_SUFFIX ? ['-B', DBUS_SUFFIX] : []
    return { command: 'bluealsa-cli', args: [...pre, 'open', pcm] }
  }

  pcmSinkPath(address: string, adapterPath: string | null): string {
    const override = process.env['ANYTONE_BLUEALSA_SINK']
    if (override) return override
    const hci = (adapterPath || '/org/bluez/hci0').split('/').pop() || 'hci0'
    // The HFP hands-free SINK — mic audio written here plays out the radio's TX path.
    return `/org/bluealsa/${hci}/dev_${address.replace(/:/g, '_')}/hfphf/sink`
  }

  playCommand(sink: string): { command: string; args: readonly string[] } {
    const pre = DBUS_SUFFIX ? ['-B', DBUS_SUFFIX] : []
    // `bluealsa-cli open <sink>` is bidirectional: its STDIN is written to the PCM.
    return { command: 'bluealsa-cli', args: [...pre, 'open', sink] }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal?.reason ?? 'aborted'))
}
