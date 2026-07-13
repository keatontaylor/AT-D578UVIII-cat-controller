// Radio readiness orchestration (ARCHITECTURE services layer). Interleaves the Bluetooth
// connection (BtManager) and the audio bring-up (AudioLink) in the order the radio requires:
// pair/trust → resolve + ensure HFP → connect the ACL/HFP profile → CONFIRM the HFP PCM
// appears. The radio engages its remote-head SPP control only once HFP audio is live; the SPP
// control socket (RfcommTransport) is opened by the caller afterward.
//
// Depends on narrow interfaces (ConnectableBt, AudioLink) so it is unit-testable with fakes.

import { setTimeout as delay } from 'node:timers/promises'
import type { AudioLink } from '../audio/types'

export interface ConnectableBt {
  ensureReady(opts?: { allowPair?: boolean; signal?: AbortSignal }): Promise<string>
  connectAcl(opts?: { signal?: AbortSignal }): Promise<string>
  disconnectAcl(): Promise<void>
  readonly adapterPath: string | null
}

export interface RadioReady {
  readonly address: string
  readonly pcm: string
}

export async function ensureRadioReady(
  bt: ConnectableBt,
  audio: AudioLink,
  opts: { allowPair?: boolean; pcmTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RadioReady> {
  const { signal } = opts
  const signalOpts = signal ? { signal } : undefined
  throwIfAborted(signal)
  const readyOpts =
    opts.allowPair === undefined ? signalOpts : signal ? { allowPair: opts.allowPair, signal } : { allowPair: opts.allowPair }
  const address = await bt.ensureReady(readyOpts)
  throwIfAborted(signal)
  const pcm = audio.pcmPath(address, bt.adapterPath)
  await audio.ensureDaemon(signalOpts) // must precede the profile connect — HFP needs a handler to connect to
  throwIfAborted(signal)
  const pcmTimeoutMs = opts.pcmTimeoutMs ?? 15000

  await bt.connectAcl(signalOpts)
  throwIfAborted(signal)
  try {
    await audio.waitForPcm(pcm, pcmTimeoutMs, signalOpts) // proof the HFP profile actually connected
  } catch {
    throwIfAborted(signal)
    // The FIRST connect right after a fresh pair can bring the ACL up without HFP: the radio needs
    // the link torn down and re-established before it engages HFP-AG. Self-heal once — drop the ACL
    // and reconnect — instead of surfacing "HFP PCM did not appear" and making the user retry.
    await bt.disconnectAcl()
    await delay(1000, undefined, signalOpts)
    await bt.connectAcl(signalOpts)
    throwIfAborted(signal)
    await audio.waitForPcm(pcm, pcmTimeoutMs, signalOpts)
  }
  return { address, pcm }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal?.reason ?? 'aborted'))
}
