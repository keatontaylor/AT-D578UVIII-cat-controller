// TX release DRAIN + keyed-but-silent guard (parrot-measured 2026-07-18: the browser→backend
// audio pipe runs 0.4–0.7 s behind on LAN, 1.5–3 s over TURN — an instant 56 00 guillotines the
// in-flight tail). The drain delays the release by the keyup's OWN measured pipe latency
// (first REAL-STREAM evidence − key), capped; safety paths bypass it; keyed-with-no-audio
// force-releases. Evidence = RTP packet counts ADVANCING (noteTxRtpPackets — the frame tee is
// useless: wrtc's NetEq synthesizes frames continuously even with no sender track).

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
  // RTP poll simulation: same-value = frozen counter (no stream); increment = packets arriving.
  let pkts = 0
  const baseline = (): void => s.noteTxRtpPackets(pkts)
  const packets = (): void => s.noteTxRtpPackets(++pkts)
  return { clock, tp, s, advance, baseline, packets }
}

test('release drains until the RTP counter goes QUIET (stream end), then 56 00', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const { tp, s, advance, baseline, packets } = rig()
    s.key() // t=0, acked synchronously
    assert.equal(s.state.ptt, 'keyed')
    s.noteTxMicActive(true)
    baseline() // first poll: establishes the counter baseline, NOT audio evidence
    advance(400)
    packets()
    advance(600)
    packets() // last packet BEFORE release at t=1000
    s.unkey() // release at t=1000 — the tail is still in flight
    assert.equal(releases(tp), 0, 'release is DELAYED — draining')
    assert.equal(s.state.ptt, 'keyed', 'still transmitting the drain')
    // in-flight tail keeps ARRIVING after release (the whole point): packets at 1200, 1500
    advance(200)
    packets()
    advance(300)
    packets() // last real packet at t=1500
    advance(300)
    assert.equal(releases(tp), 0, 'counter quiet only 300ms — still draining')
    advance(200)
    assert.equal(releases(tp), 1, '56 00 at ~last-packet + 400ms quiet')
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
    const { tp, s, advance, baseline, packets } = rig()
    s.key()
    s.noteTxMicActive(true)
    baseline()
    advance(500)
    packets()
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
    const { tp, s, advance, baseline, packets } = rig()
    s.key()
    s.noteTxMicActive(true)
    baseline()
    advance(300)
    packets()
    s.unkey() // drain pending
    s.key() // finger back down before the drain expired
    for (let i = 0; i < 10; i += 1) {
      advance(500)
      packets() // audio keeps flowing (silence guard stays happy)
    }
    assert.equal(releases(tp), 0, 'the pending release was cancelled — still transmitting')
    assert.equal(s.state.ptt, 'keyed')
    assert.equal(keyWrites(tp).length, 1, 'no duplicate key-down either (still the original key)')
  } finally {
    mock.timers.reset()
  }
})

test('keyed-but-silent guard: mic expected, RTP counter FROZEN → force release + notice', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const notices: string[] = []
    const { tp, s, advance, baseline } = rig({ onPttFailsafe: (d) => notices.push(d) })
    s.key()
    s.noteTxMicActive(true)
    // the audio path dies: the poll keeps reporting the SAME packet count forever
    for (let i = 0; i < 4; i += 1) {
      baseline()
      advance(500)
    }
    assert.equal(releases(tp), 0, 'under the guard window — no release yet')
    for (let i = 0; i < 4; i += 1) {
      baseline()
      advance(500)
    }
    assert.equal(releases(tp), 1, 'guard force-released the dead-air transmitter')
    assert.equal(s.state.ptt, 'idle')
    assert.ok(notices.some((n) => n.includes('no TX audio')), `notice surfaced: ${notices}`)
  } finally {
    mock.timers.reset()
  }
})

test('guard stays quiet while packets advance; never arms for a mic-less keyup', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const a = rig()
    a.s.key()
    a.s.noteTxMicActive(true)
    a.baseline()
    for (let i = 0; i < 10; i += 1) {
      a.advance(500)
      a.packets()
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

test('drain is hard-capped at 3 s even if the counter never goes quiet', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const { tp, s, advance, baseline, packets } = rig()
    s.key() // t=0
    s.noteTxMicActive(true)
    baseline()
    advance(300)
    packets()
    s.unkey() // release at t=300
    // Pathological: packets keep arriving forever (browser failed to stop its track) — the
    // drain must not hold the transmitter past the cap.
    for (let i = 0; i < 14; i += 1) {
      advance(200)
      packets()
    }
    assert.equal(releases(tp), 0, 'under the cap (t=+2800)')
    advance(300)
    assert.equal(releases(tp), 1, 'released at the 3 s cap despite a never-quiet counter')
  } finally {
    mock.timers.reset()
  }
})

test('a counter going BACKWARD (new session / renegotiation) re-baselines, not audio evidence', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const { tp, s, advance } = rig()
    s.key() // t=0
    s.noteTxMicActive(true)
    s.noteTxRtpPackets(100) // baseline from a prior session's counter
    advance(300)
    s.noteTxRtpPackets(5) // renegotiated pc: counter reset — must NOT read as arrival
    // If the reset had counted as audio, hasDrainableAudio would be true and release would
    // drain; with no REAL arrival ever, the release must be immediate.
    s.unkey()
    assert.equal(releases(tp), 1, 'no real audio this keyup → immediate release, no phantom drain')
  } finally {
    mock.timers.reset()
  }
})

test('CAPTURE-FIRST ordering: rtc.mic active BEFORE key() still arms the drain + guard', () => {
  // Live bug 2026-07-18: the browser attaches the mic (rtc.mic active) before ptt.key under
  // capture-first keying, and key()'s per-keyup reset wiped micAt → the drain never armed and
  // every release was immediate (56 00 measured landing BEFORE the last audio arrived).
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const { tp, s, advance, baseline, packets } = rig()
    s.noteTxMicActive(true) // mic attaches FIRST (capture-first)
    advance(200)
    s.key() // then the radio keys
    baseline()
    advance(300)
    packets()
    advance(500)
    packets() // audio flowing
    s.unkey() // release — the drain MUST arm (mic was attached, audio arrived)
    assert.equal(releases(tp), 0, 'release is draining, not immediate')
    advance(300)
    packets() // in-flight tail still arriving
    advance(500)
    assert.equal(releases(tp), 1, 'released after the counter went quiet')
    assert.equal(s.state.ptt, 'idle')
  } finally {
    mock.timers.reset()
  }
})

test('CAPTURE-FIRST ordering: the silence guard also survives the key() reset', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const notices: string[] = []
    const { tp, s, advance, baseline } = rig({ onPttFailsafe: (d) => notices.push(d) })
    s.noteTxMicActive(true) // attach before key
    advance(200)
    s.key()
    // audio path dead: counter frozen forever
    for (let i = 0; i < 8; i += 1) {
      baseline()
      advance(500)
    }
    assert.equal(releases(tp), 1, 'guard force-released despite the pre-key mic attach')
    assert.ok(notices.some((n) => n.includes('no TX audio')))
  } finally {
    mock.timers.reset()
  }
})
