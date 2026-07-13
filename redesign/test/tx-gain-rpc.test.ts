// rtc.gain / rtc.setGain over a REAL Fastify /ws: get, set (applies to the bridge + persists via
// saveTxGain), and validation. The bridge is faked at the seam (txGain/setTxGain) — the per-frame
// application is covered by rtc-gain.test.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/api/server'
import { StateBroadcaster } from '../src/api/broadcast'
import type { AudioBridge } from '../src/audio/rtc'
import { newController } from './controller-fakes'

test('rtc.gain round-trip: get, set (persisted), reject out-of-range', async () => {
  const { c } = newController()
  const broadcaster = new StateBroadcaster(c.appState)
  c.onChange((s) => broadcaster.publish(s))
  let gain = 0.6
  const saved: number[] = []
  const audio = {
    get txGain() {
      return gain
    },
    setTxGain(g: number) {
      gain = g
      return g
    },
  } as unknown as AudioBridge
  const app = await createServer({ controller: c, broadcaster, audio, saveTxGain: (g) => saved.push(g) }, {})
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const responses = new Map<number, { result?: { gain?: number }; error?: { message?: string } }>()
  ws.on('message', (d: Buffer) => {
    const m = JSON.parse(d.toString()) as { id?: number }
    if (m.id != null) responses.set(m.id, m as never)
  })
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  const call = async (id: number, method: string, params?: unknown) => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    for (let i = 0; i < 100 && !responses.has(id); i += 1) await new Promise((r) => setTimeout(r, 10))
    const resp = responses.get(id)
    assert.ok(resp, `response for ${method}`)
    return resp!
  }

  try {
    assert.equal((await call(1, 'rtc.gain')).result?.gain, 0.6, 'boot value readable')
    assert.equal((await call(2, 'rtc.setGain', { gain: 0.45 })).result?.gain, 0.45)
    assert.equal(gain, 0.45, 'applied to the bridge')
    assert.deepEqual(saved, [0.45], 'persisted')
    assert.equal((await call(3, 'rtc.gain')).result?.gain, 0.45)
    const bad = await call(4, 'rtc.setGain', { gain: 9 })
    assert.match(bad.error?.message ?? '', /0.05, 2/, 'out-of-range rejected')
    assert.equal(gain, 0.45, 'bridge untouched by the rejected set')
    assert.deepEqual(saved, [0.45], 'nothing extra persisted')
  } finally {
    ws.close()
    await app.close()
  }
})
