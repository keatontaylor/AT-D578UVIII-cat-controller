import { WebSocket } from 'ws'

// WebSocket proxy: bridges a LAN client to the backend's loopback-only raw head-bus
// at ws://127.0.0.1:3010/raw/ws, so the
// raw control/inject bus is reachable over the single LAN-facing :3030 port without
// exposing :3010. Mirrors the SSE proxy in server/api/events.get.ts, but full-duplex.
// Requires nitro.experimental.websocket (see nuxt.config.ts).
//
// Connect from the LAN at:  ws://<pi-host>:3030<baseURL>api/raw-ws
// (baseURL is "/" by default, so ws://<pi-host>:3030/api/raw-ws).

// Per-peer upstream state. crossws reuses the same `peer` object across
// open/message/close, but peer.ctx is not a writable bag in all versions, so we
// key our own Map by peer.
const upstreams = new Map<unknown, { up: WebSocket; queue: string[] }>()

function backendWsUrl(): string {
  const base = process.env.ANYTONE_SERVER_URL || 'http://127.0.0.1:3010'
  return base.replace(/^http/, 'ws') + '/raw/ws'
}

export default defineWebSocketHandler({
  open(peer) {
    const up = new WebSocket(backendWsUrl())
    const state = { up, queue: [] as string[] }
    upstreams.set(peer, state)
    up.on('open', () => { for (const m of state.queue) up.send(m); state.queue = [] })
    up.on('message', (data: any) => { try { peer.send(data.toString()) } catch {} })
    up.on('close', () => { try { peer.close() } catch {} })
    up.on('error', () => { try { peer.close() } catch {} })
  },
  message(peer, message) {
    const state = upstreams.get(peer)
    if (!state) return
    const data = message.text()
    if (state.up.readyState === WebSocket.OPEN) state.up.send(data)
    else state.queue.push(data)
  },
  close(peer) {
    const state = upstreams.get(peer)
    if (state) { try { state.up.close() } catch {} ; upstreams.delete(peer) }
  },
})
