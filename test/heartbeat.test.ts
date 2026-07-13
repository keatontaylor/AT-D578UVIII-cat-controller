// The /ws keepalive logic (timer-free unit): ping while alive, terminate on a missed pong.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHeartbeat, type Pingable } from '../src/api/heartbeat'

function fakeSocket() {
  const calls: string[] = []
  const socket: Pingable = { ping: () => calls.push('ping'), terminate: () => calls.push('terminate') }
  return { socket, calls }
}

test('heartbeat pings a live socket and keeps it while pongs arrive', () => {
  const { socket, calls } = fakeSocket()
  const hb = makeHeartbeat(socket)
  assert.equal(hb.tick(), true) // starts alive → ping
  hb.pong() // client answered
  assert.equal(hb.tick(), true) // still alive → ping
  hb.pong()
  assert.equal(hb.tick(), true)
  assert.deepEqual(calls, ['ping', 'ping', 'ping'])
})

test('heartbeat terminates a socket that missed the previous pong', () => {
  const { socket, calls } = fakeSocket()
  const hb = makeHeartbeat(socket)
  assert.equal(hb.tick(), true) // ping, now awaiting a pong
  // ...no pong...
  assert.equal(hb.tick(), false) // missed → terminate
  assert.deepEqual(calls, ['ping', 'terminate'])
})
