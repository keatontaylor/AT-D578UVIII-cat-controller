// The UI-side PTT DEADMAN over a REAL Fastify /ws (loopback ws client): the browser proves once a
// second that its JS is alive and the button is held (`ptt.hold`); keyed with no beacon for the
// deadman window — or the keying socket closing — force-releases. Scoped to the keying socket, so
// a second viewer's connection can never release someone else's transmission. Real timers, small
// windows (deadmanMs 200 → check tick 50).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { createServer } from '../src/api/server'
import { StateBroadcaster } from '../src/api/broadcast'
import { ADDR, newController } from './controller-fakes'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function rig(): Promise<{
  app: FastifyInstance
  url: string
  c: ReturnType<typeof newController>['c']
  session: () => ReturnType<typeof newController>['session']
}> {
  const controller = newController()
  const broadcaster = new StateBroadcaster(controller.c.appState)
  controller.c.onChange((s) => broadcaster.publish(s))
  const app = await createServer({ controller: controller.c, broadcaster }, { pttDeadmanMs: 200 })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  await controller.c.connect(ADDR)
  return { app, url: `ws://127.0.0.1:${port}/ws`, c: controller.c, session: () => controller.session }
}

function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url)
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

const key = (ws: WebSocket): void => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ptt.key' }))
const unkey = (ws: WebSocket): void => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ptt.unkey' }))
const hold = (ws: WebSocket): void => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ptt.hold' }))

test('beacons keep a keyed PTT alive well past the deadman window', async () => {
  const { app, url, session } = await rig()
  const ws = await open(url)
  try {
    key(ws)
    const holder = setInterval(() => hold(ws), 50) // healthy page: beacon every 50ms
    await sleep(600) // 3× the deadman window
    clearInterval(holder)
    assert.deepEqual(session()!.pttCalls, ['key'], 'never force-released while beacons flowed')
    unkey(ws)
    await sleep(50)
    assert.deepEqual(session()!.pttCalls, ['key', 'unkey'])
  } finally {
    ws.close()
    await app.close()
  }
})

test('beacons stop (tab frozen / connection stalled) → force-release + persistent error', async () => {
  const { app, url, c, session } = await rig()
  const ws = await open(url)
  try {
    key(ws)
    hold(ws)
    await sleep(500) // silence past the 200ms window (socket still OPEN — like a frozen tab)
    assert.deepEqual(session()!.pttCalls, ['key', 'unkey'], 'the deadman released')
    assert.match(c.appState.error ?? '', /PTT was force-released/, 'the WHY persists on AppState')
    assert.match(c.appState.error ?? '', /went silent/)
  } finally {
    ws.close()
    await app.close()
  }
})

test('the keying socket closing mid-PTT releases immediately', async () => {
  const { app, url, c, session } = await rig()
  const ws = await open(url)
  try {
    key(ws)
    await sleep(30)
    ws.terminate() // unclean close, like a crashed browser
    await sleep(150)
    assert.deepEqual(session()!.pttCalls, ['key', 'unkey'], 'released on the owner socket closing')
    assert.match(c.appState.error ?? '', /disconnected mid-PTT/)
  } finally {
    await app.close()
  }
})

test("a SECOND viewer's socket closing never releases the keyer's transmission", async () => {
  const { app, url, session } = await rig()
  const keyer = await open(url)
  const viewer = await open(url)
  try {
    key(keyer)
    const holder = setInterval(() => hold(keyer), 50)
    await sleep(30)
    viewer.terminate() // the bystander drops — must not touch PTT
    await sleep(300)
    clearInterval(holder)
    assert.deepEqual(session()!.pttCalls, ['key'], 'the keyer was untouched')
    unkey(keyer)
    await sleep(50)
    assert.deepEqual(session()!.pttCalls, ['key', 'unkey'])
  } finally {
    keyer.close()
    await app.close()
  }
})

test('a clean unkey disarms the deadman (no spurious release after)', async () => {
  const { app, url, c, session } = await rig()
  const ws = await open(url)
  try {
    key(ws)
    await sleep(30)
    unkey(ws)
    await sleep(500) // way past the window with no beacons — nothing must fire
    assert.deepEqual(session()!.pttCalls, ['key', 'unkey'], 'exactly the user actions, nothing forced')
    assert.equal(c.appState.error, null, 'no deadman error for a clean release')
  } finally {
    ws.close()
    await app.close()
  }
})

test("error.dismiss clears the persistent error (the banner's ✕)", async () => {
  const { app, url, c } = await rig()
  const ws = await open(url)
  try {
    key(ws)
    await sleep(500) // trip the deadman
    assert.match(c.appState.error ?? '', /PTT was force-released/)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'error.dismiss' }))
    await sleep(50)
    assert.equal(c.appState.error, null)
  } finally {
    ws.close()
    await app.close()
  }
})
