// rtc.config over a REAL Fastify /ws: the browser fetches the server's ICE server list before
// building its RTCPeerConnection, so both peers gather from the same STUN/TURN set — the thing
// that makes remote (cellular/NATed) audio connect at all. Plus the AudioBridge default (LAN-only)
// and pass-through, mirroring how main.ts feeds ANYTONE_ICE_SERVERS in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/api/server'
import { StateBroadcaster } from '../src/api/broadcast'
import { AudioBridge } from '../src/audio/rtc'
import { staticIce } from '../src/audio/ice'
import { newController } from './controller-fakes'

test('AudioBridge: ICE defaults to none (LAN-only); a provider passes through', async () => {
  const lan = new AudioBridge(() => ({ command: 'true', args: [] }))
  assert.deepEqual(await lan.iceServers(), [], 'default: host candidates only')

  const servers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'turn:relay.example:3478', username: 'u', credential: 'c' }]
  const wan = new AudioBridge(() => ({ command: 'true', args: [] }), () => {}, () => null, 0.6, staticIce(servers))
  assert.deepEqual(await wan.iceServers(), servers)
})

test('rtc.config returns the bridge ICE servers over /ws', async () => {
  const { c } = newController()
  const broadcaster = new StateBroadcaster(c.appState)
  c.onChange((s) => broadcaster.publish(s))
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }]
  const audio = new AudioBridge(() => ({ command: 'true', args: [] }), () => {}, () => null, 0.6, staticIce(servers))
  const app = await createServer({ controller: c, broadcaster, audio }, {})
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const responses = new Map<number, { result?: { iceServers?: unknown } }>()
  ws.on('message', (d: Buffer) => {
    const m = JSON.parse(d.toString()) as { id?: number }
    if (m.id != null) responses.set(m.id, m as never)
  })
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  try {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'rtc.config' }))
    for (let i = 0; i < 100 && !responses.has(1); i += 1) await new Promise((r) => setTimeout(r, 10))
    const resp = responses.get(1)
    assert.ok(resp, 'response arrived')
    assert.deepEqual(resp!.result?.iceServers, servers, 'the browser sees exactly the server-side ICE set')
    assert.equal((resp!.result as { iceTransportPolicy?: string }).iceTransportPolicy, 'all', 'direct paths allowed by default')
  } finally {
    ws.close()
    await app.close()
  }
})

test('rtc.config carries iceTransportPolicy relay when the bridge is relay-only', async () => {
  const { c } = newController()
  const broadcaster = new StateBroadcaster(c.appState)
  c.onChange((s) => broadcaster.publish(s))
  const servers = [{ urls: 'turn:relay.example:3478', username: 'u', credential: 'c' }]
  const audio = new AudioBridge(() => ({ command: 'true', args: [] }), () => {}, () => null, 0.6, staticIce(servers), true)
  const app = await createServer({ controller: c, broadcaster, audio }, {})
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const responses = new Map<number, { result?: { iceTransportPolicy?: string } }>()
  ws.on('message', (d: Buffer) => {
    const m = JSON.parse(d.toString()) as { id?: number }
    if (m.id != null) responses.set(m.id, m as never)
  })
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  try {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'rtc.config' }))
    for (let i = 0; i < 100 && !responses.has(1); i += 1) await new Promise((r) => setTimeout(r, 10))
    assert.equal(responses.get(1)!.result?.iceTransportPolicy, 'relay', 'both peers are forced through TURN')
  } finally {
    ws.close()
    await app.close()
  }
})
