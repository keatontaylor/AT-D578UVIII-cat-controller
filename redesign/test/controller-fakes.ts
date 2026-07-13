// Shared fakes for exercising RadioController + the api router/ws without hardware or the real
// enumeration (which connect-session.test covers). Injected session/transport/bt/audio.

import { RadioController, type RadioControllerDeps, type RadioManager, type SessionLike } from '../src/services/radio-service'
import type { SessionEvents } from '../src/services/session'
import type { AudioLink } from '../src/audio/types'
import type { RadioCandidate } from '../src/bluetooth/radio-select'
import type { AdapterInfo } from '../src/bluetooth/types'
import { initialState } from '../src/domain/state'
import type { Transport } from '../src/transport/types'

export const ADDR = '00:1B:10:1C:FA:C3'

export const candidate = (address: string): RadioCandidate => ({
  path: `/d/${address}`,
  address,
  name: 'ELET_AGHF',
  alias: null,
  paired: true,
  trusted: true,
  connected: false,
  uuids: [],
  rssi: null,
  configured: false,
})

export class FakeBt implements RadioManager {
  readonly adapterPath = '/org/bluez/hci0'
  readonly calls: string[] = []
  /** When set, ensureReady blocks on it — lets a test hold a connect mid-flight. */
  ensureReadyGate: Promise<void> | null = null
  async ensureReady(opts: { signal?: AbortSignal } = {}): Promise<string> {
    if (this.ensureReadyGate) await this.ensureReadyGate
    if (opts.signal?.aborted) throw opts.signal.reason
    this.calls.push('ensureReady')
    return ADDR
  }
  async connectAcl(opts: { signal?: AbortSignal } = {}): Promise<string> {
    if (opts.signal?.aborted) throw opts.signal.reason
    this.calls.push('connectAcl')
    return ADDR
  }
  async scanForRadios(): Promise<RadioCandidate[]> {
    this.calls.push('scan')
    return [candidate(ADDR)]
  }
  async pairAddress(address: string): Promise<string> {
    this.calls.push(`pair:${address}`)
    return address
  }
  async forget(address: string): Promise<void> {
    this.calls.push(`forget:${address}`)
  }
  async listRadios(): Promise<RadioCandidate[]> {
    this.calls.push('list')
    return [candidate(ADDR)]
  }
  async adapterInfo(): Promise<AdapterInfo> {
    return { path: this.adapterPath, address: '00:00:00:00:00:00', powered: true, discovering: false }
  }
  setTarget(address: string): void {
    this.calls.push(`setTarget:${address}`)
  }
  async disconnectAcl(): Promise<void> {
    this.calls.push('disconnectAcl')
  }
}

export class FakeAudio implements AudioLink {
  pcmPath(address: string): string {
    return `/pcm/${address}`
  }
  async ensureDaemon(opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (opts.signal?.aborted) throw opts.signal.reason
  }
  async waitForPcm(_pcm?: string, _timeoutMs?: number, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (opts.signal?.aborted) throw opts.signal.reason
  }
  captureCommand(pcm: string): { command: string; args: readonly string[] } {
    return { command: 'true', args: ['open', pcm] }
  }
  pcmSinkPath(address: string): string {
    return `/pcm/${address}/sink`
  }
  playCommand(sink: string): { command: string; args: readonly string[] } {
    return { command: 'true', args: ['open', sink] }
  }
}

export class FakeSession implements SessionLike {
  closed = false
  constructor(private readonly events: SessionEvents) {}
  async connect(): Promise<void> {
    this.events.onState?.({ ...initialState(), firmware: 'FWX' })
  }
  close(): void {
    this.closed = true
  }
  /** PTT calls in order ('key'/'unkey') — the deadman tests assert on these. */
  readonly pttCalls: string[] = []
  key(): void {
    this.pttCalls.push('key')
    this.events.onState?.({ ...initialState(), firmware: 'FWX', ptt: 'keyed' })
  }
  unkey(): void {
    this.pttCalls.push('unkey')
    this.events.onState?.({ ...initialState(), firmware: 'FWX', ptt: 'idle' })
  }
  setSetting(name: string, value: string | number): void {
    this.events.onState?.({ ...initialState(), firmware: 'FWX', settings: { [name]: value } })
  }
  chooseSide(side: 'a' | 'b'): void {
    this.events.onState?.({ ...initialState(), selectedSide: side })
  }
  setVfoMode(): void {}
  stepChannel(): void {}
  stepZone(): void {}
  setChannelSetting(): void {}
  setChannelTone(): void {}
  setFrequency(): void {}
  setVolume(): void {}
  async listScanLists(): Promise<{ index: number; name: string }[]> {
    return []
  }
  startScan(): void {}
  stopScan(): void {}
  async listChannels(): Promise<{ position: number; name: string }[]> {
    return []
  }
  selectChannel(): void {}
  async listZones(): Promise<{ index: number; name: string }[]> {
    return []
  }
  async listZoneChannels(): Promise<{ position: number; name: string }[]> {
    return []
  }
  selectZoneChannel(): void {}
  setManualDial(): void {}
  clearManualDial(): void {}
  readonly metrics = { retransmits: 0 }
}

export class FakeTransport implements Transport {
  closed = false
  dropHandler: () => void = () => {}
  write(): void {}
  onData(): void {}
  onClose(h: () => void): void {
    this.dropHandler = h
  }
  close(): void {
    this.closed = true
  }
}

export function newController(overrides: Partial<RadioControllerDeps> = {}) {
  const bt = new FakeBt()
  let session: FakeSession | null = null
  let transport: FakeTransport | null = null
  const c = new RadioController({
    bt,
    audio: new FakeAudio(),
    createTransport: () => (transport = new FakeTransport()),
    createSession: (_t, _cfg, _now, events) => (session = new FakeSession(events)),
    linkConfig: { timeoutMs: 1, maxAttempts: 1, gapMs: 0 },
    now: () => 0,
    ...overrides,
  })
  return {
    c,
    bt,
    get session(): FakeSession | null {
      return session
    },
    get transport(): FakeTransport | null {
      return transport
    },
  }
}
