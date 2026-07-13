// Synthetic remote client: relay-only ICE so the media path MUST go through Cloudflare TURN,
// like a symmetric-NAT cellular phone. Uses the real /ws signaling + rtc.config.
import WebSocket from 'ws'
import { createRequire } from 'node:module'
const wrtc = createRequire(import.meta.url)('@roamhq/wrtc')

const ws = new WebSocket('ws://127.0.0.1:8080/anytone-v2/ws')
let id = 1
const waits = new Map()
const rpc = (method, params) => new Promise((res, rej) => {
  const n = id++
  waits.set(n, { res, rej })
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }))
  setTimeout(() => waits.has(n) && (waits.delete(n), rej(new Error(`${method} timeout`))), 10000)
})
let pc
ws.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result) }
  else if (m.method === 'rtc.ice' && pc) pc.addIceCandidate(m.params).catch(() => {})
})
ws.on('open', async () => {
  try {
    const cfg = await rpc('rtc.config')
    console.log('policy from server:', cfg.iceTransportPolicy)
    pc = new wrtc.RTCPeerConnection({ iceServers: cfg.iceServers, iceTransportPolicy: 'relay' })
    const types = new Set()
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const t = /typ (\w+)/.exec(e.candidate.candidate)?.[1]
        types.add(t)
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'rtc.ice', params: e.candidate }))
      }
    }
    pc.oniceconnectionstatechange = () => console.log('ice:', pc.iceConnectionState)
    pc.onconnectionstatechange = () => console.log('peer:', pc.connectionState)
    pc.addTransceiver('audio', { direction: 'sendrecv' })
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const answer = await rpc('rtc.offer', { type: 'offer', sdp: offer.sdp })
    await pc.setRemoteDescription(answer)
    setTimeout(() => {
      console.log('final:', pc.connectionState, '| ice:', pc.iceConnectionState, '| my candidate types:', [...types].join(','))
      pc.close(); ws.close(); process.exit(0)
    }, 15000)
  } catch (e) { console.error('FAIL:', e.message); process.exit(1) }
})
