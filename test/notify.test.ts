// Push webhook for important/urgent clips: format selection (ntfy headers vs generic JSON),
// tier threshold, retry/flood behavior, and the Transcriber wiring that fires it after scoring.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Notifier, envNotifierConfig, type ImportanceNotification } from '../src/transcribe/notify'

type Sent = { url: string; init: RequestInit }

function fakeFetch(sink: Sent[], opts: { failTimes?: number; status?: number } = {}): typeof fetch {
  let fails = opts.failTimes ?? 0
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (fails > 0) {
      fails--
      throw new Error('ECONNREFUSED')
    }
    sink.push({ url: String(url), init: init! })
    return new Response('', { status: opts.status ?? 200 })
  }) as typeof fetch
}

function urgent(over: Partial<ImportanceNotification> = {}): ImportanceNotification {
  return {
    clipId: 'clip-1',
    tier: 3,
    channel: 'BCSO SOUTH',
    startedAt: 1_753_600_000_000,
    reason: 'wildfire evacuation traffic',
    summary: 'Evacuations ordered near Lyons due to wildfire.',
    text: 'All units, evacuation order for the Lyons area, fire crossing Highway 36.',
    ...over,
  }
}

// deliver() is fire-and-forget — let its microtasks/retry timers settle
const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms))

test('notify: disabled without a url — never fetches', async () => {
  const sink: Sent[] = []
  const n = new Notifier({ url: null, fetchFn: fakeFetch(sink) })
  assert.equal(n.enabled, false)
  n.notify(urgent())
  await flush()
  assert.equal(sink.length, 0)
})

test('notify: json format POSTs the full event shape (Home Assistant webhook)', async () => {
  const sink: Sent[] = []
  const n = new Notifier({ url: 'https://ha.local/api/webhook/anytone', fetchFn: fakeFetch(sink) })
  assert.equal(n.format, 'json')
  n.notify(urgent({ talkgroup: 'COLCON DENVER' }))
  await flush()
  assert.equal(sink.length, 1)
  const body = JSON.parse(sink[0]!.init.body as string) as Record<string, unknown>
  assert.equal(body['event'], 'importance')
  assert.equal(body['tier'], 3)
  assert.equal(body['tierLabel'], 'urgent')
  assert.equal(body['title'], 'URGENT — BCSO SOUTH · COLCON DENVER')
  assert.equal(body['channel'], 'BCSO SOUTH')
  assert.equal(body['clipId'], 'clip-1')
  assert.ok((body['summary'] as string).includes('Lyons'))
  assert.ok((body['transcript'] as string).includes('Highway 36'))
  assert.match(body['startedAt'] as string, /^\d{4}-\d{2}-\d{2}T/)
  assert.ok((sink[0]!.init.headers as Record<string, string>)['content-type']!.includes('application/json'))
})

test('notify: ntfy format auto-detects from the host and uses header conventions', async () => {
  const sink: Sent[] = []
  const n = new Notifier({ url: 'https://ntfy.sh/my-radio-alerts', fetchFn: fakeFetch(sink), token: 'tk_abc' })
  assert.equal(n.format, 'ntfy')
  n.notify(urgent())
  await flush()
  const h = sink[0]!.init.headers as Record<string, string>
  assert.equal(h['title'], 'URGENT — BCSO SOUTH')
  assert.equal(h['priority'], '5')
  assert.equal(h['tags'], 'rotating_light')
  assert.equal(h['authorization'], 'Bearer tk_abc')
  const body = sink[0]!.init.body as string
  assert.ok(body.includes('Evacuations ordered'))
  assert.ok(body.includes('Highway 36'))
})

test('notify: tier 2 = high priority; tiers 0/1 stay silent at the default threshold', async () => {
  const sink: Sent[] = []
  const n = new Notifier({ url: 'https://ntfy.sh/t', fetchFn: fakeFetch(sink) })
  n.notify(urgent({ tier: 1 }))
  n.notify(urgent({ tier: 0 }))
  n.notify(urgent({ tier: 2 }))
  await flush()
  assert.equal(sink.length, 1)
  const h = sink[0]!.init.headers as Record<string, string>
  assert.equal(h['priority'], '4')
  assert.equal(h['tags'], 'warning')
})

test('notify: minTier 3 suppresses tier 2', async () => {
  const sink: Sent[] = []
  const n = new Notifier({ url: 'https://ha.local/hook', minTier: 3, fetchFn: fakeFetch(sink) })
  n.notify(urgent({ tier: 2 }))
  await flush()
  assert.equal(sink.length, 0)
  n.notify(urgent({ tier: 3 }))
  await flush()
  assert.equal(sink.length, 1)
})

test('notify: retries once on failure, then succeeds silently', async () => {
  const sink: Sent[] = []
  const log: string[] = []
  const n = new Notifier({ url: 'https://ha.local/hook', fetchFn: fakeFetch(sink, { failTimes: 1 }), retryDelayMs: 1, log: (m) => log.push(m) })
  n.notify(urgent())
  await flush()
  assert.equal(sink.length, 1)
  assert.equal(log.length, 0)
})

test('notify: logs (never throws) when both attempts fail', async () => {
  const log: string[] = []
  const n = new Notifier({ url: 'https://ha.local/hook', fetchFn: fakeFetch([], { failTimes: 2 }), retryDelayMs: 1, log: (m) => log.push(m) })
  n.notify(urgent())
  await flush()
  assert.ok(log.some((m) => m.includes('delivery failed')))
})

test('notify: non-2xx counts as failure', async () => {
  const log: string[] = []
  const n = new Notifier({ url: 'https://ha.local/hook', fetchFn: fakeFetch([], { status: 404 }), retryDelayMs: 1, log: (m) => log.push(m) })
  n.notify(urgent())
  await flush()
  assert.ok(log.some((m) => m.includes('HTTP 404')))
})

test('notify: hourly flood cap, sliding window', async () => {
  const sink: Sent[] = []
  const log: string[] = []
  let t = 0
  const n = new Notifier({ url: 'https://ha.local/hook', fetchFn: fakeFetch(sink), now: () => t, log: (m) => log.push(m) })
  for (let i = 0; i < 25; i++) n.notify(urgent({ clipId: `c${i}` }))
  await flush()
  assert.equal(sink.length, 20)
  assert.ok(log.some((m) => m.includes('hourly cap')))
  t += 3601_000 // window slides — deliveries resume
  n.notify(urgent({ clipId: 'later' }))
  await flush()
  assert.equal(sink.length, 21)
})

test('notify: truncates very long transcripts', async () => {
  const sink: Sent[] = []
  const n = new Notifier({ url: 'https://ha.local/hook', fetchFn: fakeFetch(sink) })
  n.notify(urgent({ text: 'x'.repeat(5000) }))
  await flush()
  const body = JSON.parse(sink[0]!.init.body as string) as { transcript: string }
  assert.ok(body.transcript.length < 750)
  assert.ok(body.transcript.endsWith('…'))
})

test('notify: envNotifierConfig reads the ANYTONE_NOTIFY_* family', () => {
  const cfg = envNotifierConfig({
    ANYTONE_NOTIFY_URL: ' https://ha.local/api/webhook/x ',
    ANYTONE_NOTIFY_FORMAT: 'ntfy',
    ANYTONE_NOTIFY_MIN_TIER: '3',
    ANYTONE_NOTIFY_TOKEN: 'tk',
  } as NodeJS.ProcessEnv)
  assert.equal(cfg.url, 'https://ha.local/api/webhook/x')
  assert.equal(cfg.format, 'ntfy')
  assert.equal(cfg.minTier, 3)
  assert.equal(cfg.token, 'tk')
  assert.equal(envNotifierConfig({} as NodeJS.ProcessEnv).url, null)
})
