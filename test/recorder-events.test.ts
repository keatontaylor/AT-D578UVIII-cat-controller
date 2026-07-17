// The Recorder pushes events (status / saved / removed) to subscribers — the /ws server relays
// these so the timeline updates live with no polling. This covers the event plumbing (the clip
// WAV/segmenter I/O is proven by segmenter.test.ts + the pure wavHeader).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recorder, type RecorderEvent } from '../src/audio/recorder'
import type { RxCapture } from '../src/audio/rx-capture'

// A no-op capture: the event tests never open a clip, so it only needs a subscribe() shape.
const fakeCapture = { subscribe: async () => () => {} } as unknown as RxCapture
const ctx = () => ({ squelchOpen: false, side: 'a' as const, channelName: 'TEST', freqMHz: 146.52, mode: 'FM', talkgroup: null })

test('setEnabled emits a status event with the new state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const rec = new Recorder(fakeCapture, dir, ctx)
    const events: RecorderEvent[] = []
    rec.subscribe((e) => events.push(e))
    await rec.setEnabled(true)
    await rec.setEnabled(true) // no-op: same state, no second event
    await rec.setEnabled(false)
    assert.deepEqual(
      events.filter((e) => e.type === 'status').map((e) => (e as { status: { enabled: boolean } }).status.enabled),
      [true, false],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('remove emits a removed event with the id; unsubscribe stops delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const rec = new Recorder(fakeCapture, dir, ctx)
    const events: RecorderEvent[] = []
    const off = rec.subscribe((e) => events.push(e))
    await rec.remove('2026-07-09T00-00-00-000Z')
    off()
    await rec.remove('another-id') // after unsubscribe → not delivered
    assert.deepEqual(events, [{ type: 'removed', id: '2026-07-09T00-00-00-000Z' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── opened / discarded / direction (the live-timeline + TX-recording contract) ──

/** A scriptable frame source: push() delivers a 10 ms PCM frame to the recorder. */
function scriptedSource() {
  const subs = new Set<(f: Buffer) => void>()
  return {
    source: { subscribe: async (cb: (f: Buffer) => void) => (subs.add(cb), () => subs.delete(cb)) },
    push: (n: number) => {
      for (let i = 0; i < n; i += 1) for (const cb of subs) cb(Buffer.alloc(160))
    },
  }
}

test('a clip announces opened at open and saved on close, with direction rx', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const { source, push } = scriptedSource()
    let open = true
    const rec = new Recorder(source as unknown as RxCapture, dir, () => ({ ...ctx(), squelchOpen: open }))
    const events: RecorderEvent[] = []
    rec.subscribe((e) => events.push(e))
    await rec.setEnabled(true)
    push(100) // 1000 ms voiced — clip opens on the first frame
    const opened = events.find((e) => e.type === 'opened') as { clip: { id: string; direction: string; channelName: string } }
    assert.ok(opened, 'opened event fired at clip open')
    assert.equal(opened.clip.direction, 'rx')
    assert.equal(opened.clip.channelName, 'TEST')
    open = false
    push(70) // 700 ms silence → tail (600 ms) closes; voiced 1000 ms ≥ min 800 → keep
    await new Promise((r) => setTimeout(r, 50)) // finalize I/O
    const saved = events.find((e) => e.type === 'saved') as { clip: { id: string; direction: string } }
    assert.ok(saved, 'saved event fired')
    assert.equal(saved.clip.id, opened.clip.id, 'the SAME clip the opened event announced')
    assert.equal(saved.clip.direction, 'rx')
    assert.ok(!events.some((e) => e.type === 'discarded'), 'kept clips are never discarded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a blip announces opened then discarded — the live block must leave the timeline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const { source, push } = scriptedSource()
    let open = true
    const rec = new Recorder(source as unknown as RxCapture, dir, () => ({ ...ctx(), squelchOpen: open }))
    const events: RecorderEvent[] = []
    rec.subscribe((e) => events.push(e))
    await rec.setEnabled(true)
    push(20) // 200 ms — far under minDurationMs (800)
    open = false
    push(70) // tail closes it
    await new Promise((r) => setTimeout(r, 50))
    const opened = events.find((e) => e.type === 'opened') as { clip: { id: string } }
    const discarded = events.find((e) => e.type === 'discarded') as { id: string }
    assert.ok(opened && discarded, 'both lifecycle events fired')
    assert.equal(discarded.id, opened.clip.id)
    assert.ok(!events.some((e) => e.type === 'saved'), 'a blip is never saved')
    assert.deepEqual(await rec.list(), [], 'nothing on disk')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a TX recorder tags direction:'tx' and suffixes ids so same-ms RX/TX clips cannot collide", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const { source, push } = scriptedSource()
    let keyed = true
    const rec = new Recorder(
      source as unknown as RxCapture,
      dir,
      () => ({ squelchOpen: keyed, side: 'a' as const, channelName: 'MIDSOUTH', freqMHz: 449.7, mode: 'DMR', talkgroup: 43114 }),
      () => {},
      'tx',
    )
    const events: RecorderEvent[] = []
    rec.subscribe((e) => events.push(e))
    await rec.setEnabled(true)
    push(100) // the operator talks for 1 s
    keyed = false
    push(70)
    await new Promise((r) => setTimeout(r, 50))
    const saved = events.find((e) => e.type === 'saved') as { clip: { id: string; direction: string; talkgroup: number } }
    assert.ok(saved)
    assert.equal(saved.clip.direction, 'tx')
    assert.match(saved.clip.id, /-tx$/, 'TX ids carry the -tx suffix')
    assert.equal(saved.clip.talkgroup, 43114, 'the TG being transmitted to')
    const listed = await rec.list()
    assert.equal(listed[0]!.direction, 'tx', 'direction survives the sidecar round-trip')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the DMR talkgroup NAME is captured and late-fills (like the id) into the clip metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const { source, push } = scriptedSource()
    // The 59 destName resolves a beat after the call opens: start with no name, fill it mid-clip.
    let open = true
    let tgName: string | null = null
    const rec = new Recorder(
      source as unknown as RxCapture,
      dir,
      () => ({ squelchOpen: open, side: 'a' as const, channelName: 'HOTSPOT', freqMHz: 449.7, mode: 'DMR', talkgroup: 700, talkgroupName: tgName }),
    )
    const events: RecorderEvent[] = []
    rec.subscribe((e) => events.push(e))
    await rec.setEnabled(true)
    push(30) // clip opens with no name yet
    const opened = events.find((e) => e.type === 'opened') as { clip: { talkgroup: number; talkgroupName: string | null } }
    assert.equal(opened.clip.talkgroupName ?? null, null, 'opens before the 59 lands')
    tgName = 'RMHAM RM WIDE' // the 59 destName arrives
    push(90) // more audio while open → late-fill applies (well over minDurationMs)
    open = false
    push(70) // silence past tailMs → closes the clip
    await new Promise((r) => setTimeout(r, 50))
    const saved = events.find((e) => e.type === 'saved') as { clip: { talkgroup: number; talkgroupName: string | null } }
    assert.ok(saved)
    assert.equal(saved.clip.talkgroup, 700)
    assert.equal(saved.clip.talkgroupName, 'RMHAM RM WIDE', 'name late-filled onto the clip')
    const listed = await rec.list()
    assert.equal((listed[0] as { talkgroupName?: string }).talkgroupName, 'RMHAM RM WIDE', 'survives the sidecar round-trip')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('navigating channels mid-clip does NOT relabel the recording (it keeps the RX channel)', async () => {
  // Live bug 2026-07-16: an RX clip on COLCON DENVER got saved as LOOKOUT 675 / SHL BOULDER VLY
  // because the operator browsed channels while the clip was still open — the recorded audio is
  // the ORIGINAL channel, so a plain same-side name change must not repaint the metadata.
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const { source, push } = scriptedSource()
    let open = true
    let channel = 'COLCON DENVER'
    // A normally-attributed analog clip: identityResolved is TRUE at open (not a scan placeholder).
    const rec = new Recorder(
      source as unknown as RxCapture,
      dir,
      () => ({ squelchOpen: open, side: 'a' as const, source: 'analog' as const, channelName: channel, freqMHz: 145.0, mode: 'FM', talkgroup: null, identityResolved: true }),
    )
    const events: RecorderEvent[] = []
    rec.subscribe((e) => events.push(e))
    await rec.setEnabled(true)
    push(100) // recording COLCON DENVER
    channel = 'LOOKOUT 675' // operator browses to another channel mid-clip
    push(50)
    channel = 'SHL BOULDER VLY' // …and another
    push(50)
    open = false
    push(70) // tail closes the clip
    await new Promise((r) => setTimeout(r, 50))
    const saved = events.find((e) => e.type === 'saved') as { clip: { channelName: string } }
    assert.ok(saved)
    assert.equal(saved.clip.channelName, 'COLCON DENVER', 'the clip keeps the channel it actually recorded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('list() defaults pre-TX-era sidecars (no direction field) to rx', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const { writeFileSync } = await import('node:fs')
    const legacy = { id: 'old-clip', startedAt: 1, durationMs: 1000, side: 'a', channelName: 'X', freqMHz: null, mode: 'FM', talkgroup: null }
    writeFileSync(join(dir, 'old-clip.json'), JSON.stringify(legacy))
    const rec = new Recorder(fakeCapture, dir, ctx)
    const listed = await rec.list()
    assert.equal(listed[0]!.direction, 'rx')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── stuck-"live" hygiene: orphan sweep, stall force-close, live hydration ───────

test('enable sweeps orphaned WAVs (no sidecar — a process death mid-clip) but keeps saved clips', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const { writeFileSync, existsSync } = await import('node:fs')
    writeFileSync(join(dir, 'orphan.wav'), Buffer.alloc(44)) // crashed mid-clip: wav, no sidecar
    writeFileSync(join(dir, 'kept.wav'), Buffer.alloc(44))
    writeFileSync(join(dir, 'kept.json'), JSON.stringify({ id: 'kept', startedAt: 1, durationMs: 1000 }))
    const rec = new Recorder(fakeCapture, dir, ctx)
    await rec.setEnabled(true)
    assert.equal(existsSync(join(dir, 'orphan.wav')), false, 'orphan swept')
    assert.equal(existsSync(join(dir, 'kept.wav')), true, 'saved clip untouched')
    assert.equal(existsSync(join(dir, 'kept.json')), true)
    await rec.setEnabled(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stalled audio stream force-closes the open clip (radio disconnect mid-clip)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const { source, push } = scriptedSource()
    const rec = new Recorder(
      source as unknown as RxCapture,
      dir,
      () => ({ ...ctx(), squelchOpen: true }),
      () => {},
      'rx',
      { stallMs: 80, stallCheckMs: 20 },
    )
    const events: RecorderEvent[] = []
    rec.subscribe((e) => events.push(e))
    await rec.setEnabled(true)
    push(100) // 1 s voiced — clip open, live
    assert.ok(rec.live, 'clip is live')
    // …the capture dies (radio disconnected): no more frames, ever
    await new Promise((r) => setTimeout(r, 250)) // past stallMs + a couple of check ticks
    assert.equal(rec.live, null, 'the stalled clip was force-closed')
    const saved = events.find((e) => e.type === 'saved')
    assert.ok(saved, 'the audio recorded so far was SAVED, not stranded')
    await rec.setEnabled(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('live exposes the open clip for (re)connect hydration; null when idle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const { source, push } = scriptedSource()
    let open = true
    const rec = new Recorder(source as unknown as RxCapture, dir, () => ({ ...ctx(), squelchOpen: open }))
    await rec.setEnabled(true)
    assert.equal(rec.live, null)
    push(20)
    // (a function boundary sidesteps strictEqual's `asserts` narrowing pinning the getter to null)
    const readLive = (r: Recorder): { channelName: string | null } | null => r.live
    assert.equal(readLive(rec)?.channelName, 'TEST', 'open clip visible for hydration')
    open = false
    push(70)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(rec.live, null, 'closed → nothing live')
    await rec.setEnabled(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setEnabled(false) with a clip open finalizes it (the graceful-shutdown path)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const { source, push } = scriptedSource()
    const rec = new Recorder(source as unknown as RxCapture, dir, () => ({ ...ctx(), squelchOpen: true }))
    const events: RecorderEvent[] = []
    rec.subscribe((e) => events.push(e))
    await rec.setEnabled(true)
    push(100) // 1 s voiced, clip open
    await rec.setEnabled(false) // shutdown flushes
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(events.some((e) => e.type === 'saved'), 'the in-flight clip was saved on disable')
    assert.equal(rec.live, null)
    assert.equal((await rec.list()).length, 1, 'sidecar written — nothing orphaned')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── held announcement (scan lock-follow): the live indicator must never show the WRONG channel ──

test('unresolved identity HOLDS opened; it announces with the RIGHT channel once resolved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const { source, push } = scriptedSource()
    let open = true
    let resolved = false
    let name = 'STALE PREV CH' // what the slice says while the 04 2d read is in flight
    const rec = new Recorder(source as unknown as RxCapture, dir, () => ({
      ...ctx(), squelchOpen: open, identityResolved: resolved, channelName: name,
    }))
    const events: RecorderEvent[] = []
    rec.subscribe((e) => events.push(e))
    await rec.setEnabled(true)
    push(30) // clip opens — announcement held
    assert.ok(!events.some((e) => e.type === 'opened'), 'no live block while identity is unresolved')
    assert.equal(rec.live, null, 'the hydration path holds it too')
    // the lock-follow read lands: identity resolves with the REAL channel
    name = 'LOCKED CH'
    resolved = true
    push(70)
    const opened = events.find((e) => e.type === 'opened') as { clip: { channelName: string } } | undefined
    assert.ok(opened, 'announced once resolved')
    assert.equal(opened!.clip.channelName, 'LOCKED CH', 'announced with the read-back channel, never the stale one')
    open = false
    push(70)
    await new Promise((r) => setTimeout(r, 50))
    const saved = events.find((e) => e.type === 'saved') as { clip: { channelName: string } }
    assert.equal(saved.clip.channelName, 'LOCKED CH')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a clip that closes before resolving stays silent: saved is its first announcement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  try {
    const { source, push } = scriptedSource()
    let open = true
    const rec = new Recorder(source as unknown as RxCapture, dir, () => ({
      ...ctx(), squelchOpen: open, identityResolved: false, channelName: 'STALE',
    }))
    const events: RecorderEvent[] = []
    rec.subscribe((e) => events.push(e))
    await rec.setEnabled(true)
    push(100) // ≥ minDurationMs — will be kept
    open = false
    push(70)
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(!events.some((e) => e.type === 'opened'), 'never announced live')
    assert.ok(!events.some((e) => e.type === 'discarded'), 'nothing to retract either')
    assert.ok(events.some((e) => e.type === 'saved'), 'the saved event (final metadata) is the first word')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
