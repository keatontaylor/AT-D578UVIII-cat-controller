// TX release DRAIN + keyed-but-silent guard (parrot-measured 2026-07-18: the browser→backend
// audio pipe runs 0.4–0.7 s behind on LAN, 1.5–3 s over TURN — an instant 56 00 guillotines the
// in-flight tail). The drain delays the release by the keyup's OWN measured pipe latency
// (first-frame-arrival − key), capped; safety paths bypass it; keyed-with-no-audio force-releases.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '../src/services/session'
import type { Transport } from '../src/transport/types'
import { bytesToHex, hexToBytes } from './capture'

class FakeTransport implements Transport {
  handler: (chunk: Uint8Array) => void = () => {}
  writes: string[] = []
  onData(h: (chunk: Uint8Array) => void): void {
    this.handler = h
  }
  onClose(): void {}
  close(): void {}
  write(bytes: Uint8Array): void {
    this.writes.push(bytesToHex(bytes))
    if (bytes[0] === 0x56) this.handler(hexToBytes('03 56 00 00 59'))
  }
}

const keyWrites = (tp: FakeTransport): string[] => tp.writes.filter((w) => w.startsWith('56 '))
const releases = (tp: FakeTransport): number => tp.writes.filter((w) => w.startsWith('56 00')).length

function rig(events: { onPttFailsafe?: (d: string) => void } = {}) {
  const clock = { t: 0 }
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => clock.t, events)
  // Advance the session's clock AND the (mocked) timer wheel together.
  const advance = (ms: number): void => {
    clock.t += ms
    mock.timers.tick(ms)
  }
  return { clock, tp, s, advance }
}

test('release drains the MEASURED pipe latency before the 56 00 (clamp floor 300, +250 margin)', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const { tp, s, advance } = rig()
    s.key() // t=0, acked synchronously
    assert.equal(s.state.ptt, 'keyed')
    s.noteTxMicActive(true)
    advance(400)
    s.noteTxAudioFrame() // first frame at t=400 → pipe latency 400ms → drain 650ms
    advance(600)
    s.noteTxAudioFrame()
    s.unkey()
    assert.equal(releases(tp), 0, 'release is DELAYED — the tail is still in flight')
    assert.equal(s.state.ptt, 'keyed', 'still transmitting the drain')
    advance(600)
    assert.equal(releases(tp), 0, 'under the 650ms drain window')
    advance(100)
    assert.equal(releases(tp), 1, '56 00 submitted after the drain')
    assert.equal(s.state.ptt, 'idle')
  } finally {
    mock.timers.reset()
  }
})

test('a keyup with NO mic stream releases immediately (kerchunk / analog / plain key)', () => {
  const { tp, s } = rig()
  s.key()
  s.unkey()
  assert.equal(releases(tp), 1, 'no drain when nothing was ever buffered')
  assert.equal(s.state.ptt, 'idle')
})

test('immediate release (deadman path) bypasses a pending drain', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const { tp, s, advance } = rig()
    s.key()
    s.noteTxMicActive(true)
    advance(500)
    s.noteTxAudioFrame()
    s.unkey() // drain pending (750ms)
    assert.equal(releases(tp), 0)
    s.unkey(true) // deadman fires mid-drain
    assert.equal(releases(tp), 1, 'immediate release submits NOW')
    assert.equal(s.state.ptt, 'idle')
    advance(2000)
    assert.equal(releases(tp), 1, 'the cancelled drain timer never double-releases')
  } finally {
    mock.timers.reset()
  }
})

test('re-key during the drain cancels the pending release (two overs merge)', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const { tp, s, advance } = rig()
    s.key()
    s.noteTxMicActive(true)
    advance(300)
    s.noteTxAudioFrame()
    s.unkey() // drain pending
    s.key() // finger back down before the drain expired
    for (let i = 0; i < 10; i += 1) {
      advance(500)
      s.noteTxAudioFrame() // audio keeps flowing (silence guard stays happy)
    }
    assert.equal(releases(tp), 0, 'the pending release was cancelled — still transmitting')
    assert.equal(s.state.ptt, 'keyed')
    assert.equal(keyWrites(tp).length, 1, 'no duplicate key-down either (still the original key)')
  } finally {
    mock.timers.reset()
  }
})

test('keyed-but-silent guard: mic expected, no audio → force release + failsafe notice', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const notices: string[] = []
    const { tp, s, advance } = rig({ onPttFailsafe: (d) => notices.push(d) })
    s.key()
    s.noteTxMicActive(true) // stream attached… and then the audio path dies: no frames, ever
    advance(2000)
    assert.equal(releases(tp), 0, 'under the guard window — no release yet')
    advance(1500)
    assert.equal(releases(tp), 1, 'guard force-released the dead-air transmitter')
    assert.equal(s.state.ptt, 'idle')
    assert.ok(notices.some((n) => n.includes('no TX audio')), `notice surfaced: ${notices}`)
  } finally {
    mock.timers.reset()
  }
})

test('guard stays quiet while frames flow; never arms for a mic-less keyup', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const a = rig()
    a.s.key()
    a.s.noteTxMicActive(true)
    for (let i = 0; i < 10; i += 1) {
      a.advance(500)
      a.s.noteTxAudioFrame()
    }
    assert.equal(releases(a.tp), 0, '5 s keyed with flowing audio — no false release')
    assert.equal(a.s.state.ptt, 'keyed')

    const b = rig()
    b.s.key() // no mic ever — analog operator keying dead air ON PURPOSE is allowed
    b.advance(10_000)
    assert.equal(releases(b.tp), 0, 'mic-less keyup is never guarded')
    assert.equal(b.s.state.ptt, 'keyed')
  } finally {
    mock.timers.reset()
  }
})

test('drain is hard-capped at 3 s even when the pipe measured slower', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const { tp, s, advance } = rig()
    s.key() // t=0
    // Pathological pipe: the mic stream only attaches at t=4750 (the guard measures from
    // ATTACH, so this stays under its window) and the first frame lands at t=5000 → measured
    // pipe latency 5 s → the drain must clamp to the 3 s cap, not wait 5.25 s.
    advance(4750)
    s.noteTxMicActive(true)
    advance(250)
    s.noteTxAudioFrame()
    s.unkey()
    advance(2900)
    assert.equal(releases(tp), 0, 'still draining under the cap')
    advance(200)
    assert.equal(releases(tp), 1, 'released at the cap')
  } finally {
    mock.timers.reset()
  }
})
