// Cloudflare TURN credential provider: minting, TTL caching, refresh near expiry, and the
// failure ladder (valid cache → stale-but-valid cache → static fallback). All against a fake
// fetch + fake clock — no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cloudflareTurn, staticIce, type IceServer } from '../src/audio/ice'

const CF_SET = [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u1', credential: 'c1' },
]

function fakeFetch(responses: (() => { status: number; body: unknown })[]): { fn: typeof fetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = []
  const fn = (async (url: unknown, init?: { body?: unknown }) => {
    const r = responses.shift() ?? (() => ({ status: 500, body: {} }))
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    const { status, body } = r()
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }) as unknown as typeof fetch
  return { fn, calls }
}

test('staticIce returns the configured list verbatim', async () => {
  const servers: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
  assert.deepEqual(await staticIce(servers)(), servers)
})

test('mints once and serves the cache until near expiry; re-mints after', async () => {
  let clock = 1_000_000
  const { fn, calls } = fakeFetch([
    () => ({ status: 200, body: { iceServers: CF_SET } }),
    () => ({ status: 200, body: { iceServers: CF_SET } }),
  ])
  const provider = cloudflareTurn({ keyId: 'k', apiToken: 'tok', ttlSeconds: 1000, fetchFn: fn, now: () => clock })

  assert.deepEqual(await provider(), CF_SET)
  assert.equal(calls.length, 1, 'minted')
  assert.match(calls[0]!.url, /turn\/keys\/k\/credentials\/generate-ice-servers$/)
  assert.deepEqual(calls[0]!.body, { ttl: 1000 })

  clock += 500_000 // half the ttl — still comfortably valid
  assert.deepEqual(await provider(), CF_SET)
  assert.equal(calls.length, 1, 'served from cache')

  clock += 260_000 // now < 25% of the ttl remains → refresh
  await provider()
  assert.equal(calls.length, 2, 're-minted near expiry')
})

test('the legacy single-object response shape is accepted', async () => {
  const single = { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' }
  const { fn } = fakeFetch([() => ({ status: 200, body: { iceServers: single } })])
  const provider = cloudflareTurn({ keyId: 'k', apiToken: 'tok', fetchFn: fn })
  assert.deepEqual(await provider(), [single])
})

test('mint failure: cached-but-aging credentials are served while still valid', async () => {
  let clock = 0
  const { fn, calls } = fakeFetch([
    () => ({ status: 200, body: { iceServers: CF_SET } }),
    () => ({ status: 500, body: {} }),
    () => ({ status: 500, body: {} }),
  ])
  const fallback = [{ urls: 'stun:fallback.example' }]
  const provider = cloudflareTurn({ keyId: 'k', apiToken: 'tok', ttlSeconds: 1000, fallback, fetchFn: fn, now: () => clock })

  await provider() // mint ok
  clock += 800_000 // in the refresh window but not expired
  assert.deepEqual(await provider(), CF_SET, 'refresh failed → aging creds still served')
  assert.equal(calls.length, 2)

  clock += 300_000 // now past expiry — dead creds must not be served
  assert.deepEqual(await provider(), fallback, 'expired + mint down → static fallback')
})

test('cold-start mint failure serves the fallback (LAN keeps working through an outage)', async () => {
  const { fn } = fakeFetch([() => ({ status: 403, body: {} })])
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }]
  const provider = cloudflareTurn({ keyId: 'k', apiToken: 'bad', fallback, fetchFn: fn })
  assert.deepEqual(await provider(), fallback)
})

test('concurrent callers share one in-flight mint', async () => {
  const { fn, calls } = fakeFetch([() => ({ status: 200, body: { iceServers: CF_SET } })])
  const provider = cloudflareTurn({ keyId: 'k', apiToken: 'tok', fetchFn: fn })
  const [a, b] = await Promise.all([provider(), provider()])
  assert.deepEqual(a, CF_SET)
  assert.deepEqual(b, CF_SET)
  assert.equal(calls.length, 1, 'one API call for both callers')
})
