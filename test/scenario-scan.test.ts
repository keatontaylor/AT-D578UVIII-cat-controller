// Scenario: native scan through the full stack — the radio hops SILENTLY (it never pushes the
// channel it's scanning), a lock is only visible as held-open squelch, and the host's confirm
// timer + `04 2c/2d 01` read must land the locked channel. Plus the recorder riding along and the
// pause semantics when the non-scanning side receives.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Rig } from './sim/harness'

test('scan lock: the confirm timer reads the locked channel while the radio is quiet', async (t) => {
  const rig = await Rig.create(t)
  rig.session.startScan('a', 0, 'FIRE')
  await rig.advance(100)
  assert.equal(rig.state.scan.active, true)
  assert.equal(rig.state.scan.listName, 'FIRE')
  assert.equal(rig.state.sides.a.channelName, 'LOCAL FM', 'display holds the pre-scan channel while hopping')

  await rig.advance(600) // a few silent hops — nothing on the wire, nothing may change
  assert.equal(rig.state.scan.locked, false)

  rig.sim.scanLand(1, 0, 3) // scan stops on GMRS 17, carrier up
  await rig.advance(400) // inside the confirm window
  assert.equal(rig.state.scan.locked, false, 'a graze under the window is not a lock')

  await rig.advance(800) // past the 1 s confirm — the TIMER must fire the read; the radio is quiet
  assert.equal(rig.state.scan.locked, true, 'confirmed lock')
  assert.equal(rig.state.sides.a.channelName, 'GMRS 17', 'the locked channel was read back')
  assert.equal(rig.state.sides.a.freqMHz, 462.6)
  rig.expectConsistent()

  rig.sim.scanResume() // channel goes quiet → unlock, ready for the next hit
  await rig.advance(100)
  assert.equal(rig.state.scan.locked, false)
  assert.equal(rig.state.scan.active, true, 'still scanning')
  rig.assertClean()
})

test('RX on the NON-scanning side pauses the scan — never a false lock', async (t) => {
  const rig = await Rig.create(t)
  rig.session.startScan('a', 0, 'FIRE')
  await rig.advance(100)

  rig.sim.setCarrier('b', 3) // the other side receives
  await rig.advance(1500) // well past the confirm window
  assert.equal(rig.state.scan.paused, true, 'the radio holds the scan for the other side')
  assert.equal(rig.state.scan.locked, false, 'other-side RX must never read as a lock')

  rig.sim.clearCarrier('b')
  await rig.advance(100)
  assert.equal(rig.state.scan.paused, false, 'resumes when the other side clears')
  rig.assertClean()
})

test('stop scan restores the pre-scan channel from the live register and resets scan state', async (t) => {
  const rig = await Rig.create(t)
  rig.session.startScan('a', 0, 'FIRE')
  await rig.advance(100)
  rig.sim.scanLand(1, 1, 2) // lands on GMRS 19
  await rig.advance(1200) // locked
  assert.equal(rig.state.scan.locked, true)
  assert.equal(rig.state.sides.a.channelName, 'GMRS 19')
  rig.sim.scanResume()
  await rig.advance(50)

  // On stop the radio RETURNS to its pre-scan channel; the display was showing the last locked
  // channel, so the `04 2c 01` restore read is what re-syncs it — the exact reason the BT-01
  // reads the LIVE register (the base 07 one is stale post-scan).
  rig.session.stopScan()
  await rig.advance(100)
  assert.equal(rig.state.scan.active, false)
  assert.equal(rig.state.scan.locked, false)
  assert.equal(rig.state.scan.paused, false)
  assert.equal(rig.state.sides.a.channelName, 'LOCAL FM', 'the restore read re-synced the display')
  rig.expectConsistent()
  rig.assertClean()
})

test('lock → unlock → second lock cycles cleanly (fresh confirm each time)', async (t) => {
  const rig = await Rig.create(t)
  rig.session.startScan('a', 0, 'FIRE')
  await rig.advance(100)

  rig.sim.scanLand(1, 0, 3)
  await rig.advance(1200)
  assert.equal(rig.state.scan.locked, true)
  assert.equal(rig.state.sides.a.channelName, 'GMRS 17')

  rig.sim.scanResume()
  await rig.advance(300)
  assert.equal(rig.state.scan.locked, false)

  rig.sim.scanLand(0, 1, 4) // next hit: RPT ALPHA
  await rig.advance(1200)
  assert.equal(rig.state.scan.locked, true)
  assert.equal(rig.state.sides.a.channelName, 'RPT ALPHA', 'second lock reads the NEW channel')
  rig.assertClean()
})

test('recorder during scan: the clip late-fills the LOCKED channel name', async (t) => {
  const rig = await Rig.create(t, { recorder: true })
  rig.session.startScan('a', 0, 'FIRE')
  await rig.advance(100)

  rig.sim.scanLand(1, 0, 3) // carrier opens — the clip opens NOW with the stale pre-scan name
  await rig.feedAudio(1500) // through the confirm window; the lock read lands mid-clip
  assert.equal(rig.state.scan.locked, true)
  rig.sim.scanResume()
  await rig.feedAudio(800) // tail closes the clip

  const clips = await rig.clips(1)
  assert.equal(clips.length, 1)
  assert.equal(clips[0]!.channelName, 'GMRS 17', 'metadata refreshed to the locked channel, not the stale pre-scan one')
  assert.equal(clips[0]!.side, 'a')
  assert.equal(clips[0]!.mode, 'FM')
  rig.assertClean()
})

// ── the radio's OWN scan truth: 5a byte 12 (corpus-pinned 2026-07-10) ─────────────

test('a scan already running at connect is discovered from the startup 04 5a read', async (t) => {
  const rig = await Rig.create(t, { preConnect: (sim) => sim.panelScan(true) })
  assert.equal(rig.state.scan.active, true, 'the startup status read carries the scan flag')
  await rig.advance(100) // the discovery 04 4a read names the list
  assert.equal(rig.state.scan.listName, 'FIRE', 'named from the channel-assigned list record (04 4a)')

  // the lock-follow must work for a scan we never started: the radio scans its selected side
  rig.sim.scanLand(1, 0, 3)
  await rig.advance(1200)
  assert.equal(rig.state.scan.locked, true, 'lock-follow armed for the discovered scan')
  assert.equal(rig.state.sides.a.channelName, 'GMRS 17')
  rig.assertClean()
})

test('a front-panel scan start/stop mid-session flows through the 5a flag', async (t) => {
  const rig = await Rig.create(t)
  assert.equal(rig.state.scan.active, false)

  rig.sim.panelScan(true) // operator hits SCAN on the radio — no host command involved
  await rig.advance(50)
  assert.equal(rig.state.scan.active, true, 'the app discovered the panel scan')
  assert.equal(rig.state.scan.listName, 'FIRE', 'and named it from the 04 4a read')

  rig.sim.panelScan(false) // operator stops it on the radio
  await rig.advance(50)
  assert.equal(rig.state.scan.active, false, 'the app saw the panel stop')
  assert.equal(rig.state.scan.locked, false)
  rig.assertClean()
})

test('the app-initiated scan lifecycle still works with the 5a flag flowing (no fights)', async (t) => {
  const rig = await Rig.create(t)
  rig.session.startScan('a', 0, 'FIRE')
  await rig.advance(100)
  assert.equal(rig.state.scan.active, true)
  assert.equal(rig.state.scan.listName, 'FIRE', 'the ack path keeps the list name')
  rig.sim.nudge() // a 5a WITH the scan flag — must not reset listName or flap active
  await rig.advance(50)
  assert.equal(rig.state.scan.active, true)
  assert.equal(rig.state.scan.listName, 'FIRE')
  rig.session.stopScan()
  await rig.advance(100)
  assert.equal(rig.state.scan.active, false)
  rig.assertClean()
})

test('a graze too short to record leaves neither a lock nor a clip', async (t) => {
  const rig = await Rig.create(t, { recorder: true })
  rig.session.startScan('a', 0, 'FIRE')
  await rig.advance(100)

  rig.sim.scanLand(1, 0, 2)
  await rig.feedAudio(400) // shorter than both the confirm window and minDurationMs
  rig.sim.scanResume()
  await rig.feedAudio(800)

  assert.equal(rig.state.scan.locked, false)
  assert.deepEqual(await rig.clips(), [], 'a squelch blip is not a recording')
  rig.assertClean()
})

test('scan + DMR RX on the OTHER side: PAUSED (never a false lock) and the call still records', async (t) => {
  // Wire-pinned 2026-07-11 (v2-wire-…02-49-22): while a native scan runs, a DMR call on the
  // NON-scanning side never raises the 5b gate — only its per-side 5a open/RSSI stream. With the
  // gate read raw from 5b, the pause went blind ("claims it is not paused") and the recorder
  // never opened a clip for the call. Both must survive on the 5a evidence alone.
  const rig = await Rig.create(t, { recorder: true })
  rig.session.selectChannel('a', 2) // MIDSOUTH (DMR) on A
  await rig.advance(1500)
  rig.session.chooseSide('b') // swap to the analog side…
  await rig.advance(1500)
  rig.session.startScan('b', 0, 'FIRE') // …and scan it
  await rig.advance(100)
  assert.equal(rig.state.scan.active, true)

  // the DMR side receives — NO 5b OPEN will be pushed (sim models the measured behavior)
  rig.sim.startDmrCall({ direction: 'rx', colorCode: 10, slot: 2, source: 3223436, dest: 43114, side: 'a' })
  await rig.feedAudio(1500) // well past the lock-confirm window
  assert.equal(rig.state.squelchOpen, false, 'the 5b gate really never opened (the trap)')
  assert.equal(rig.state.scan.paused, true, 'paused on the 5a evidence alone')
  assert.equal(rig.state.scan.locked, false, 'and never a false lock')

  rig.sim.endDmrCall()
  await rig.feedAudio(800)
  assert.equal(rig.state.scan.paused, false, 'resumes when the call ends')
  assert.equal(rig.state.scan.active, true)

  const clips = await rig.clips(1)
  assert.equal(clips.length, 1, 'the scan-held DMR call WAS recorded')
  assert.equal(clips[0]!.side, 'a')
  assert.equal(clips[0]!.channelName, 'MIDSOUTH')
  assert.equal(clips[0]!.mode, 'DMR')
  assert.equal(clips[0]!.talkgroup, 43114)

  // the scan is still fully functional afterwards: a real hit locks normally
  rig.sim.scanLand(1, 0, 3)
  await rig.advance(1200)
  assert.equal(rig.state.scan.locked, true)
  assert.equal(rig.state.sides.b.channelName, 'GMRS 17')
  rig.assertClean()
})

// ── scan PAUSE truth (2026-07-11): the radio PARKS a paused scan on the last-scanned channel ──

test('pause parks: the pause-confirm read names the PARKED channel, and a hit there records correctly', async (t) => {
  const rig = await Rig.create(t, { recorder: true })
  rig.session.startScan('a', 0, 'FIRE')
  await rig.advance(2000) // several silent hops — the cursor is somewhere in the FIRE list

  rig.sim.setCarrier('b', 3) // the NON-scanning side receives → the radio parks the scan
  await rig.advance(1500) // pause-confirm window + the live-register read round-trip
  assert.equal(rig.state.scan.paused, true)
  const parked = rig.sim.currentChannel('a')!.name
  assert.equal(rig.state.scan.pausedChannel, parked, 'the parked channel was read and named')
  assert.equal(rig.state.sides.a.channelName, parked, 'the side state carries the parked channel')

  // The user-reported race: the PARKED channel gets signal while the pause still holds — the
  // recorder must attribute the clip to the parked channel, not the stale pre-scan one.
  rig.sim.setCarrier('a', 3)
  await rig.feedAudio(1500) // through the lock-confirm window (scanning side now receiving)
  rig.sim.clearCarrier('a')
  rig.sim.clearCarrier('b')
  await rig.feedAudio(800)

  const clips = await rig.clips(1)
  assert.ok(clips.length >= 1, 'the parked-channel hit was recorded')
  assert.equal(clips[0]!.side, 'a')
  assert.equal(clips[0]!.channelName, parked, 'attributed to the PARKED channel, not the pre-scan one')
  rig.assertClean()
})

test('pause end clears the parked channel name (the scan resumes hopping)', async (t) => {
  const rig = await Rig.create(t)
  rig.session.startScan('a', 0, 'FIRE')
  await rig.advance(1000)
  rig.sim.setCarrier('b', 3)
  await rig.advance(1500)
  assert.notEqual(rig.state.scan.pausedChannel, null, 'named while paused')
  rig.sim.clearCarrier('b')
  await rig.advance(100)
  assert.equal(rig.state.scan.paused, false)
  assert.equal(rig.state.scan.pausedChannel, null, 'no parked channel once hopping again')
  rig.assertClean()
})

// ── pause × lock CO-EXISTENCE: the other side holds the scan while the parked channel itself
// receives — per-side truth, not a single-winner (2026-07-12) ──

test('pause + lock co-exist: the parked channel locks WHILE the other side holds the pause; both clips attribute correctly', async (t) => {
  const rig = await Rig.create(t, { recorder: true })
  rig.session.selectChannel('b', 1) // RPT ALPHA on the non-scanning side (distinct name)
  await rig.advance(1500)
  rig.session.startScan('a', 0, 'FIRE')
  await rig.advance(2000) // hopping

  // the NON-scanning side receives → pause; its audio wins first (clip 1 = B)
  rig.sim.setCarrier('b', 3)
  await rig.feedAudio(1500) // pause-confirm read lands, clip 1 open on B
  assert.equal(rig.state.scan.paused, true)
  const parked = rig.sim.currentChannel('a')!.name
  assert.equal(rig.state.scan.pausedChannel, parked)

  // the PARKED channel gets RX while the pause still holds → LOCK must co-exist with PAUSE
  rig.sim.setCarrier('a', 3)
  await rig.feedAudio(1500) // through the lock-confirm window
  assert.equal(rig.state.scan.locked, true, 'the parked channel locked')
  assert.equal(rig.state.scan.paused, true, 'the pause STILL holds — the other side is receiving')
  assert.equal(rig.state.sides.a.channelName, parked, 'the lock read named the parked channel')

  // B ends while A still receives: pause clears, lock holds, and the recorder SPLITS
  rig.sim.clearCarrier('b')
  await rig.feedAudio(2000)
  assert.equal(rig.state.scan.paused, false)
  assert.equal(rig.state.scan.locked, true, 'lock unaffected by the pause ending')

  rig.sim.clearCarrier('a')
  await rig.feedAudio(1000)
  assert.equal(rig.state.scan.locked, false, 'lock drops when the channel clears')

  const clips = await rig.clips(2)
  assert.equal(clips.length, 2, 'two transmissions, two clips')
  assert.equal(clips[0]!.side, 'b')
  assert.equal(clips[0]!.channelName, 'RPT ALPHA', 'the pausing side clip keeps ITS channel')
  assert.equal(clips[1]!.side, 'a')
  assert.equal(clips[1]!.channelName, parked, 'the locked-channel clip carries the parked channel')
  rig.assertClean()
})

test('lock first, pause joins, lock drops: pause remains and the parked-channel read re-arms', async (t) => {
  const rig = await Rig.create(t, { recorder: true })
  rig.session.selectChannel('b', 1)
  await rig.advance(1500)
  rig.session.startScan('a', 0, 'FIRE')
  await rig.advance(2000)

  // the scanning side hits first → normal lock
  rig.sim.setCarrier('a', 3)
  await rig.feedAudio(1500)
  assert.equal(rig.state.scan.locked, true)
  assert.equal(rig.state.scan.paused, false)
  const locked = rig.sim.currentChannel('a')!.name

  // the other side opens mid-lock → pause co-exists with the lock
  rig.sim.setCarrier('b', 2)
  await rig.feedAudio(800)
  assert.equal(rig.state.scan.locked, true)
  assert.equal(rig.state.scan.paused, true, 'pause and lock at the same time')

  // the locked channel drops while the other side still receives: lock clears, pause holds,
  // and the re-armed parked read names the channel the scan is still parked on
  rig.sim.clearCarrier('a')
  await rig.feedAudio(1500)
  assert.equal(rig.state.scan.locked, false)
  assert.equal(rig.state.scan.paused, true)
  assert.equal(rig.state.scan.pausedChannel, locked, 'parked right where the lock was')

  rig.sim.clearCarrier('b')
  await rig.feedAudio(1000)
  const clips = await rig.clips(2)
  assert.equal(clips.length, 2)
  assert.equal(clips[0]!.side, 'a')
  assert.equal(clips[0]!.channelName, locked)
  assert.equal(clips[1]!.side, 'b')
  assert.equal(clips[1]!.channelName, 'RPT ALPHA')
  rig.assertClean()
})

// ── analog-tail false-pause guard (wire-observed 2026-07-11 22:27:37) ──
// A mixed pair (DMR on the non-scanning side, analog on the scanning side): as the scanning
// side's analog RX ends, its per-side 5a squelch closes a beat BEFORE the 5b gate. In that gap
// activeReceive INFERS the lone DMR side — which must NOT be read as the other side "receiving"
// and flip PAUSE. scanFollow's evidence-only rule keeps pause steady through the tail.
test('the analog tail does not blip a false PAUSE on a DMR-other-side pair', async (t) => {
  const { smeterPush } = await import('./sim/frames')
  const rig = await Rig.create(t)
  rig.session.selectChannel('a', 2) // MIDSOUTH (DMR) on the NON-scanning side A
  await rig.advance(1500)
  rig.session.chooseSide('b') // analog LOCAL FM selected on B
  await rig.advance(1500)
  rig.session.startScan('b', 0, 'FIRE')
  await rig.advance(1000)
  assert.equal(rig.state.scan.paused, false)

  // scanning side B receives (analog), then LOCKS
  rig.sim.setCarrier('b', 3)
  await rig.advance(1200)
  assert.equal(rig.state.scan.locked, true)
  assert.equal(rig.state.scan.paused, false)

  // THE TAIL GAP: B's per-side squelch closes (both open bits false) while the 5b gate is still
  // open — no 5b CLOSED pushed yet. selectedSide is B, so selectedOpen→B, otherOpen→A.
  rig.sim.injectPush(smeterPush({ selectedRssi: 0, otherRssi: 0, selectedOpen: false, otherOpen: false, scanning: true }))
  await rig.advance(50)
  assert.equal(rig.state.scan.paused, false, 'the lone-DMR inference must not fake a pause during the tail')

  rig.sim.clearCarrier('b')
  await rig.advance(100)
  assert.equal(rig.state.scan.paused, false)
  rig.assertClean()
})
