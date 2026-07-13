import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureRadioReady, type ConnectableBt } from '../src/services/connect'
import type { AudioLink } from '../src/audio/types'

const ADDR = '00:1B:10:1C:FA:C3'

class FakeBt implements ConnectableBt {
  readonly adapterPath = '/org/bluez/hci0'
  failConnect = false
  constructor(private readonly log: string[]) {}
  async ensureReady(opts: { signal?: AbortSignal } = {}): Promise<string> {
    if (opts.signal?.aborted) throw opts.signal.reason
    this.log.push('ensureReady')
    return ADDR
  }
  async connectAcl(opts: { signal?: AbortSignal } = {}): Promise<string> {
    if (opts.signal?.aborted) throw opts.signal.reason
    this.log.push('connectAcl')
    if (this.failConnect) throw new Error('ACL did not connect')
    return ADDR
  }
  async disconnectAcl(): Promise<void> {
    this.log.push('disconnectAcl')
  }
}

class FakeAudio implements AudioLink {
  pcmMissing = false
  /** Fail the first waitForPcm only (models the fresh-pair ACL-without-HFP case). */
  pcmMissingOnce = false
  private pcmCalls = 0
  constructor(private readonly log: string[]) {}
  pcmPath(address: string, adapterPath: string | null): string {
    this.log.push(`pcmPath(${adapterPath})`)
    return `/org/bluealsa/hci0/dev_${address.replace(/:/g, '_')}/hfphf/source`
  }
  async ensureDaemon(opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (opts.signal?.aborted) throw opts.signal.reason
    this.log.push('ensureDaemon')
  }
  async waitForPcm(_pcm: string, _timeoutMs: number, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (opts.signal?.aborted) throw opts.signal.reason
    this.log.push('waitForPcm')
    const firstCall = this.pcmCalls++ === 0
    if (this.pcmMissing || (this.pcmMissingOnce && firstCall)) throw new Error('HFP PCM did not appear')
  }
  captureCommand(pcm: string): { command: string; args: readonly string[] } {
    return { command: 'bluealsa-cli', args: ['open', pcm] }
  }
  pcmSinkPath(address: string): string {
    return `/org/bluealsa/hci0/dev_${address.replace(/:/g, '_')}/hfphf/sink`
  }
  playCommand(sink: string): { command: string; args: readonly string[] } {
    return { command: 'bluealsa-cli', args: ['open', sink] }
  }
}

test('ensureRadioReady runs the steps in the radio-required order', async () => {
  const log: string[] = []
  const bt = new FakeBt(log)
  const audio = new FakeAudio(log)
  const ready = await ensureRadioReady(bt, audio)

  // pair/trust → resolve PCM → ensure daemon → connect (HFP) → confirm PCM
  assert.deepEqual(log, ['ensureReady', 'pcmPath(/org/bluez/hci0)', 'ensureDaemon', 'connectAcl', 'waitForPcm'])
  assert.equal(ready.address, ADDR)
  assert.equal(ready.pcm, `/org/bluealsa/hci0/dev_${ADDR.replace(/:/g, '_')}/hfphf/source`)
})

test('a first-connect HFP miss self-heals with one disconnect+reconnect', async () => {
  const log: string[] = []
  const bt = new FakeBt(log)
  const audio = new FakeAudio(log)
  audio.pcmMissingOnce = true
  const ready = await ensureRadioReady(bt, audio)

  assert.deepEqual(log, [
    'ensureReady', 'pcmPath(/org/bluez/hci0)', 'ensureDaemon',
    'connectAcl', 'waitForPcm',                 // first try: ACL up but no HFP PCM
    'disconnectAcl', 'connectAcl', 'waitForPcm', // self-heal, PCM appears
  ])
  assert.equal(ready.address, ADDR)
})

test('a missing HFP PCM fails the bring-up (the radio would not engage SPP)', async () => {
  const log: string[] = []
  const audio = new FakeAudio(log)
  audio.pcmMissing = true
  await assert.rejects(() => ensureRadioReady(new FakeBt(log), audio), /HFP PCM did not appear/)
})

test('a failed ACL connect aborts before confirming the PCM', async () => {
  const log: string[] = []
  const bt = new FakeBt(log)
  bt.failConnect = true
  await assert.rejects(() => ensureRadioReady(bt, new FakeAudio(log)), /ACL did not connect/)
  assert.ok(!log.includes('waitForPcm'), 'must not confirm PCM after a failed connect')
})

test('an abort during PCM confirmation does not run the HFP self-heal reconnect', async () => {
  const log: string[] = []
  const ctl = new AbortController()
  class AbortAudio extends FakeAudio {
    override async waitForPcm(_pcm: string, _timeoutMs: number, _opts: { signal?: AbortSignal } = {}): Promise<void> {
      log.push('waitForPcm')
      ctl.abort(new Error('stop connect'))
      throw new Error('HFP PCM did not appear')
    }
  }

  await assert.rejects(() => ensureRadioReady(new FakeBt(log), new AbortAudio(log), { signal: ctl.signal }), /stop connect/)
  assert.deepEqual(log, ['ensureReady', 'pcmPath(/org/bluez/hci0)', 'ensureDaemon', 'connectAcl', 'waitForPcm'])
})
