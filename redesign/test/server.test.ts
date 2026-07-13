// Loopback integration over a REAL Fastify server (@fastify/websocket) + ws client on
// 127.0.0.1 — proves the production wire: an AppState snapshot on connect, request→response
// (clean JSON-RPC methods), and state.patch frames reflecting controller changes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/api/server'
import { StateBroadcaster } from '../src/api/broadcast'
import { ADDR, newController } from './controller-fakes'

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms))])
}

interface Msg {
  id?: number
  method?: string
  result?: { connection?: string }
  error?: unknown
  params?: { connection?: string; radio?: { settings?: Record<string, unknown> } }
}

test('fastify /ws: AppState snapshot, request→response, connect + setting patches', async () => {
  const { c } = newController()
  const broadcaster = new StateBroadcaster(c.appState)
  c.onChange((s) => broadcaster.publish(s))
  const app = await createServer({ controller: c, broadcaster }, {}) // ws only — no static/dev
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const messages: Msg[] = []
  const waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = []
  const waitFor = (pred: (m: Msg) => boolean): Promise<Msg> => {
    const found = messages.find(pred)
    if (found) return Promise.resolve(found)
    return withTimeout(new Promise<Msg>((resolve) => waiters.push({ pred, resolve })), 2000, 'message')
  }

  ws.on('message', (data: Buffer) => {
    const m = JSON.parse(data.toString()) as Msg
    messages.push(m)
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i]!.pred(m)) {
        waiters[i]!.resolve(m)
        waiters.splice(i, 1)
      }
    }
  })

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', reject)
      }),
      2000,
      'open',
    )

    const snapshot = await waitFor((m) => m.method === 'state.snapshot')
    assert.equal(snapshot.params?.connection, 'disconnected')

    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'connect', params: { address: ADDR } }))
    const connectRes = await waitFor((m) => m.id === 7)
    assert.equal(connectRes.error, undefined)
    assert.equal(connectRes.result?.connection, 'connected')
    await waitFor((m) => m.method === 'state.patch' && m.params?.connection === 'connected')

    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'setting.set', params: { name: 'key_tone', value: 'L1' } }))
    const response = await waitFor((m) => m.id === 8)
    assert.equal(response.error, undefined)
    const patch = await waitFor((m) => m.method === 'state.patch' && m.params?.radio?.settings?.['key_tone'] === 'L1')
    assert.equal(patch.params?.radio?.settings?.['key_tone'], 'L1')
  } finally {
    ws.close()
    await app.close()
  }
})

test('fastify /ws: rtc messages are validated before reaching the audio session', async () => {
  const { c } = newController()
  const broadcaster = new StateBroadcaster(c.appState)
  let sessions = 0
  const app = await createServer({
    controller: c,
    broadcaster,
    audio: {
      createSession: () => {
        sessions += 1
        return {
          offer: async () => ({ type: 'answer', sdp: 'ok' }),
          addIce: async () => {},
          close: () => {},
        }
      },
    } as never,
  }, {})
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const messages: Msg[] = []
  const waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = []
  const waitFor = (pred: (m: Msg) => boolean): Promise<Msg> => {
    const found = messages.find(pred)
    if (found) return Promise.resolve(found)
    return withTimeout(new Promise<Msg>((resolve) => waiters.push({ pred, resolve })), 2000, 'message')
  }
  ws.on('message', (data: Buffer) => {
    const m = JSON.parse(data.toString()) as Msg
    messages.push(m)
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i]!.pred(m)) {
        waiters[i]!.resolve(m)
        waiters.splice(i, 1)
      }
    }
  })

  try {
    await withTimeout(new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject) }), 2000, 'open')
    await waitFor((m) => m.method === 'state.snapshot')

    const badOfferP = waitFor((m) => m.id === 1)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'rtc.offer', params: { type: 'answer', sdp: '' } }))
    const badOffer = await badOfferP
    assert.equal(badOffer.id, 1)
    assert.equal((badOffer.error as { code?: number })?.code, -32602)
    assert.equal(sessions, 0, 'invalid offer must not create a native RTC session')

    const earlyIceP = waitFor((m) => m.id === 2)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'rtc.ice', params: { candidate: 'candidate:1 1 udp 1 0.0.0.0 9 typ host' } }))
    const earlyIce = await earlyIceP
    assert.equal(earlyIce.id, 2)
    assert.equal((earlyIce.error as { code?: number })?.code, -32600)
  } finally {
    ws.close()
    await app.close()
  }
})
