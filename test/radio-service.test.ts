import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ADDR, FakeTransport, newController } from './controller-fakes'

test('connect runs the bring-up, opens a session, and reaches connected', async () => {
  const { c, bt } = newController()
  const states: string[] = []
  c.onChange((s) => states.push(s.connection))
  await c.connect(ADDR)

  assert.equal(c.appState.connection, 'connected')
  assert.equal(c.appState.address, ADDR)
  assert.equal(c.appState.radio.firmware, 'FWX')
  assert.deepEqual(bt.calls, [`setTarget:${ADDR}`, 'ensureReady', 'connectAcl'])
  assert.equal(states.at(-1), 'connected')
})

test('connect is rejected while not disconnected', async () => {
  const { c } = newController()
  await c.connect(ADDR)
  await assert.rejects(() => c.connect(ADDR), /cannot connect while connected/)
})

test('disconnect tears down session + transport + ACL and resets state', async () => {
  const s = newController()
  await s.c.connect(ADDR)
  const sess = s.session
  const tx = s.transport
  await s.c.disconnect()

  assert.equal(s.c.appState.connection, 'disconnected')
  assert.equal(s.c.appState.address, null)
  assert.equal(s.c.appState.radio.firmware, null) // reset
  assert.equal(sess?.closed, true)
  assert.equal(tx?.closed, true)
  assert.ok(s.bt.calls.includes('disconnectAcl'))
})

test('disconnect reports a DISCONNECTING phase until the teardown confirms', async () => {
  const s = newController()
  await s.c.connect(ADDR)
  let release!: () => void
  s.bt.disconnectGate = new Promise<void>((r) => (release = r)) // hold the ACL drop mid-teardown

  const states: string[] = []
  s.c.onChange((st) => states.push(st.connection))
  const done = s.c.disconnect()

  // status flips to 'disconnecting' immediately; address is retained so the UI can grey the
  // last-known radio rather than blank it
  assert.equal(s.c.appState.connection, 'disconnecting')
  assert.equal(s.c.appState.address, ADDR)

  // our own transport close during teardown must NOT be treated as an unexpected drop
  s.transport!.dropHandler()
  assert.equal(s.c.appState.connection, 'disconnecting', 'onDrop is a no-op while disconnecting')
  assert.equal(s.c.appState.error, null)

  release()
  await done
  assert.equal(s.c.appState.connection, 'disconnected')
  assert.equal(s.c.appState.address, null)
  assert.deepEqual(states, ['disconnecting', 'disconnected'])
})

test('live ops require a connection; setSetting flows a state change once connected', async () => {
  const { c } = newController()
  assert.throws(() => c.key(), /not connected/)
  assert.throws(() => c.setSetting('key_tone', 'L1'), /not connected/)

  await c.connect(ADDR)
  let last = c.appState
  c.onChange((s) => (last = s))
  c.setSetting('key_tone', 'L1')
  assert.equal(last.radio.settings['key_tone'], 'L1')
})

test('an unexpected transport drop returns to disconnected with an error', async () => {
  const s = newController()
  await s.c.connect(ADDR)
  s.transport!.dropHandler() // simulate link loss
  assert.equal(s.c.appState.connection, 'disconnected')
  assert.equal(s.c.appState.error, 'radio link dropped')
})

test('with reconnect enabled, a drop self-heals back to connected (capped backoff)', async () => {
  const s = newController({ reconnect: true, reconnectBaseMs: 5 })
  await s.c.connect(ADDR)
  assert.equal(s.c.appState.connection, 'connected')

  s.transport!.dropHandler() // unexpected loss
  assert.equal(s.c.appState.connection, 'disconnected')

  // the scheduled reconnect fires after the (tiny) backoff and re-establishes
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(s.c.appState.connection, 'connected', 'auto-reconnected')
  assert.equal(s.c.appState.address, ADDR)
})

test('an explicit disconnect cancels the reconnect intent (no self-heal)', async () => {
  const s = newController({ reconnect: true, reconnectBaseMs: 5 })
  await s.c.connect(ADDR)
  await s.c.disconnect()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(s.c.appState.connection, 'disconnected', 'stays down after a requested disconnect')
})

test('scan / pair / list delegate to the manager', async () => {
  const { c, bt } = newController()
  assert.equal((await c.scan()).length, 1)
  assert.equal(await c.pair(ADDR), ADDR)
  assert.equal((await c.listRadios()).length, 1)
  assert.ok(bt.calls.includes('scan') && bt.calls.includes(`pair:${ADDR}`) && bt.calls.includes('list'))
})

test('scan / pair / forget are rejected while not disconnected (inquiry would disrupt the link)', async () => {
  const { c } = newController()
  await c.connect(ADDR)
  await assert.rejects(async () => c.scan(), /cannot scan while connected/)
  await assert.rejects(async () => c.pair(ADDR), /cannot pair while connected/)
  await assert.rejects(async () => c.forget(ADDR), /cannot forget while connected/)
})

test('connect resolves the SPP channel and passes it to the transport', async () => {
  let ch = -1
  const { c } = newController({
    channel: 2,
    resolveChannel: async () => 7,
    createTransport: (_addr, channel) => {
      ch = channel
      return new FakeTransport()
    },
  })
  await c.connect(ADDR)
  assert.equal(ch, 7)
})

test('connect falls back to the default channel when SDP resolution yields null or throws', async () => {
  for (const resolveChannel of [async () => null, async () => Promise.reject(new Error('sdp down'))]) {
    let ch = -1
    const { c } = newController({
      channel: 2,
      resolveChannel,
      createTransport: (_addr, channel) => {
        ch = channel
        return new FakeTransport()
      },
    })
    await c.connect(ADDR)
    assert.equal(ch, 2)
  }
})

test('disconnect aborts an in-flight connect', async () => {
  const s = newController()
  let release!: () => void
  s.bt.ensureReadyGate = new Promise<void>((r) => (release = r))
  const p = s.c.connect(ADDR)
  await Promise.resolve() // let connect reach the blocked ensureReady
  assert.equal(s.c.appState.connection, 'connecting')
  await s.c.disconnect()
  release() // unblock the abandoned ensureReady; connect should already be unwinding
  await assert.rejects(() => p, /disconnect requested/)
  assert.equal(s.c.appState.connection, 'disconnected')
})

test('connect aborts on the deadline even if a phase hangs', async () => {
  const s = newController({ connectDeadlineMs: 20 })
  s.bt.ensureReadyGate = new Promise<void>(() => {}) // never resolves
  await assert.rejects(() => s.c.connect(ADDR), /timed out/)
  assert.equal(s.c.appState.connection, 'disconnected')
})

// ── control-socket retry: the radio's SPP refuses for a few seconds after power-on ──

test('control socket: refusals are retried and a later attempt connects', async () => {
  let calls = 0
  const { c } = newController({
    transportRetryMs: 1,
    createTransport: () => {
      calls += 1
      if (calls < 3) throw new Error('The radio refused the connection (errno 111)')
      return new FakeTransport()
    },
  })
  await c.connect(ADDR)
  assert.equal(calls, 3, 'two refusals then success')
  assert.equal(c.appState.connection, 'connected')
})

test('control socket: gives up after the configured attempts with the LAST error surfaced', async () => {
  let calls = 0
  const { c } = newController({
    transportRetryMs: 1,
    transportAttempts: 3,
    createTransport: () => {
      calls += 1
      throw new Error(`refused #${calls}`)
    },
  })
  await assert.rejects(c.connect(ADDR), /refused #3/)
  assert.equal(calls, 3, 'exactly the configured attempts')
  assert.equal(c.appState.connection, 'disconnected')
  assert.match(c.appState.error ?? '', /refused #3/, 'the user sees the final failure')
})

test('control socket: an explicit disconnect aborts the retry loop mid-backoff', async () => {
  let calls = 0
  const { c } = newController({
    transportRetryMs: 60_000, // long backoff — only an abort can end this test quickly
    createTransport: () => {
      calls += 1
      throw new Error('refused')
    },
  })
  const attempt = c.connect(ADDR)
  await new Promise((r) => setTimeout(r, 10)) // let the first attempt fail into the backoff
  await c.disconnect()
  await assert.rejects(attempt, /disconnect requested/)
  assert.equal(calls, 1, 'no further attempts after the abort')
  assert.equal(c.appState.connection, 'disconnected')
})
