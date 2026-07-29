// The recordings live-push path over a REAL Fastify /ws: opened/saved/discarded events from BOTH
// recorders (RX squelch + TX mic) reach the client as recordings.* notifications, and one
// recordings.setEnabled switch drives the pair. This is what the timeline's live blocks ride.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/api/server'
import { StateBroadcaster } from '../src/api/broadcast'
import { Recorder } from '../src/audio/recorder'
import type { RxCapture } from '../src/audio/rx-capture'
import { newController } from './controller-fakes'

function scriptedSource() {
  const subs = new Set<(f: Buffer) => void>()
  return {
    source: { subscribe: async (cb: (f: Buffer) => void) => (subs.add(cb), () => subs.delete(cb)) } as unknown as RxCapture,
    push: (n: number) => {
      for (let i = 0; i < n; i += 1) for (const cb of subs) cb(Buffer.alloc(160))
    },
  }
}

test('TX recorder events relay over /ws; setEnabled drives both recorders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-relay-'))
  const { c } = newController()
  const broadcaster = new StateBroadcaster(c.appState)
  c.onChange((s) => broadcaster.publish(s))

  const rx = scriptedSource()
  const tx = scriptedSource()
  let keyed = false
  const rxCtx = () => ({ squelchOpen: false, side: 'a' as const, channelName: 'RX', freqMHz: null, mode: 'FM', talkgroup: null })
  const txCtx = () => ({ squelchOpen: keyed, side: 'a' as const, channelName: 'MIDSOUTH', freqMHz: 449.7, mode: 'DMR', talkgroup: 43114 })
  const recorder = new Recorder(rx.source, dir, rxCtx)
  const txRecorder = new Recorder(tx.source, dir, txCtx, () => {}, 'tx')

  const app = await createServer({ controller: c, broadcaster, recorder, txRecorder }, {})
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const messages: { method?: string; params?: { clip?: { id?: string; direction?: string }; id?: string } }[] = []
  ws.on('message', (d: Buffer) => messages.push(JSON.parse(d.toString())))
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  const until = async (pred: () => boolean, label: string): Promise<void> => {
    // generous cap: the full suite runs files in parallel and starves this one on a loaded Pi
    // (the loop exits on success, so the cap only ever costs time on a genuine failure)
    for (let i = 0; i < 500 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 10))
    assert.ok(pred(), label)
  }

  try {
    // one switch enables the PAIR
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'recordings.setEnabled', params: { enabled: true } }))
    await until(() => recorder.status.enabled && txRecorder.status.enabled, 'both recorders enabled by one switch')

    // the operator keys and talks → the TX recorder's opened/saved events reach the client.
    // Feed frames INSIDE the poll loop: setEnabled flips status.enabled synchronously but the
    // source subscription lands after an await, so a one-shot burst can fire into zero
    // subscribers under suite load (the flake this replaced).
    keyed = true
    await until(() => {
      tx.push(10)
      return messages.some((m) => m.method === 'recordings.opened' && m.params?.clip?.direction === 'tx')
    }, 'TX opened event relayed')
    tx.push(100) // 1 s of TX audio → comfortably over minDurationMs

    // a client that just (re)connected hydrates the in-progress clip via recordings.live
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'recordings.live' }))
    await until(() => messages.some((m) => (m as { id?: number }).id === 7), 'live rpc answered')
    const liveResp = messages.find((m) => (m as { id?: number }).id === 7) as { result?: { id: string; direction: string }[] }
    assert.equal(liveResp.result?.length, 1, 'the open clip is hydratable')
    assert.equal(liveResp.result?.[0]?.direction, 'tx')
    keyed = false
    tx.push(70) // tail closes the clip
    await until(
      () => messages.some((m) => m.method === 'recordings.saved' && m.params?.clip?.direction === 'tx'),
      'TX saved event relayed',
    )
    const saved = messages.find((m) => m.method === 'recordings.saved')!
    assert.match(saved.params!.clip!.id!, /-tx$/)
  } finally {
    ws.close()
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('live snapshot route: corrected-header WAV of the in-progress clip, ranges, 404 when not live', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-live-'))
  const { c } = newController()
  const broadcaster = new StateBroadcaster(c.appState)
  const rx = scriptedSource()
  let open = false
  const rxCtx = () => ({ squelchOpen: open, side: 'a' as const, channelName: 'LIVE TEST', freqMHz: 146.94, mode: 'FM', talkgroup: null })
  const recorder = new Recorder(rx.source, dir, rxCtx)
  const app = await createServer({ controller: c, broadcaster, recorder }, {})
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`
  try {
    await recorder.setEnabled(true)
    open = true
    for (let i = 0; i < 300 && !recorder.live; i += 1) {
      rx.push(5)
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.ok(recorder.live, 'clip open')
    const id = recorder.live!.id
    rx.push(200) // ≈2 s of PCM appended to the growing file
    await new Promise((r) => setTimeout(r, 150)) // let the write stream flush

    const res = await fetch(`${base}/recordings/${id}/live.wav`)
    assert.equal(res.status, 200)
    const body = Buffer.from(await res.arrayBuffer())
    assert.equal(body.subarray(0, 4).toString(), 'RIFF')
    const dataLen = body.readUInt32LE(40)
    assert.ok(dataLen > 0, 'header advertises the bytes written so far (not 0)')
    assert.equal(body.length, 44 + dataLen, 'body matches the advertised snapshot exactly')

    // range request (Safari requirement) over the virtual snapshot
    const r2 = await fetch(`${base}/recordings/${id}/live.wav`, { headers: { range: 'bytes=0-43' } })
    assert.equal(r2.status, 206)
    const head = Buffer.from(await r2.arrayBuffer())
    assert.equal(head.length, 44)
    assert.equal(head.readUInt32LE(40), dataLen, 'ranged header carries the corrected length too')

    // close the clip — the live route must stop serving it
    open = false
    for (let i = 0; i < 300 && recorder.live; i += 1) {
      rx.push(1)
      await new Promise((r) => setTimeout(r, 10))
    }
    const r3 = await fetch(`${base}/recordings/${id}/live.wav`)
    assert.equal(r3.status, 404, 'saved clips use the normal range route')
    const r4 = await fetch(`${base}/recordings/..%2Fevil/live.wav`)
    assert.ok([400, 404].includes(r4.status), 'traversal rejected')
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
