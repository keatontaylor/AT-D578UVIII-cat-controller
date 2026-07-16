// Native scan (57 48 start/stop, 2f 2b select, 04 4b directory) end-to-end through the Session.
// Protocol live-validated Sitting 2 (2026-07-03).

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '../src/services/session'
import { scanSelect, scanStartStop, readScanList } from '../src/codec/commands'
import { decodeScanListName } from '../src/codec/decode'
import type { Transport } from '../src/transport/types'
import { bytesToHex, hexToBytes } from './capture'

const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve()
}

/** A 135-byte populated 04 4b directory entry with a 16-byte name @17 (real wire layout,
 * live-validated 2026-06-22), or an 18-byte empty slot. */
function scanListReply(index: number, name: string | null): Uint8Array {
  if (name === null) {
    const b = new Uint8Array(18)
    b.set([0x04, 0x4b, index], 0)
    let s = 0
    for (let i = 0; i < 17; i += 1) s = (s + b[i]!) & 0xff
    b[17] = s
    return b
  }
  const b = new Uint8Array(135)
  b.set([0x04, 0x4b, index], 0)
  for (let i = 0; i < name.length && i < 16; i += 1) b[17 + i] = name.charCodeAt(i)
  let s = 0
  for (let i = 0; i < 134; i += 1) s = (s + b[i]!) & 0xff
  b[134] = s
  return b
}

class FakeTransport implements Transport {
  handler: (chunk: Uint8Array) => void = () => {}
  writes: string[] = []
  lists: (string | null)[] = ['SHORT FAVORITES', 'FIRE', null, null, null]
  onData(h: (chunk: Uint8Array) => void): void {
    this.handler = h
  }
  onClose(): void {}
  close(): void {}
  write(bytes: Uint8Array): void {
    this.writes.push(bytesToHex(bytes))
    if (bytes[0] === 0x57 && bytes[1] === 0x48) this.handler(hexToBytes('03 57 48 00 a2'))
    else if (bytes[0] === 0x2f) this.handler(hexToBytes('03 2f 00 00 32'))
    else if (bytes[0] === 0x04 && bytes[1] === 0x4b) {
      const idx = bytes[2]!
      this.handler(scanListReply(idx, this.lists[idx] ?? null))
    }
  }
}

test('scanStartStop / scanSelect / readScanList build the validated frames', () => {
  assert.equal(bytesToHex(scanStartStop(true)).startsWith('57 48 01'), true)
  assert.equal(bytesToHex(scanStartStop(false)).startsWith('57 48 00'), true)
  assert.equal(bytesToHex(scanSelect(3)).startsWith('2f 2b 03'), true)
  assert.equal(bytesToHex(readScanList(2)), '04 4b 02 02 03 00')
})

test('decodeScanListName: populated → name, empty slot → null', () => {
  assert.equal(decodeScanListName(scanListReply(0, 'SHORT FAVORITES')), 'SHORT FAVORITES')
  assert.equal(decodeScanListName(scanListReply(3, null)), null)
})

test('listScanLists reads the 04 4b directory until the empty-slot run', async () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  const lists = await s.listScanLists()
  assert.deepEqual(lists, [{ index: 0, name: 'SHORT FAVORITES' }, { index: 1, name: 'FIRE' }])
})

test('startScan on the current list: 57 48 01 → scan.active flips on the ack', async () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.startScan('a', null, 'SHORT FAVORITES')
  await flush()
  assert.ok(tp.writes.some((w) => w.startsWith('57 48 01')), 'scan start sent')
  assert.ok(!tp.writes.some((w) => w.startsWith('2f 2b')), 'no list-select when starting current list')
  assert.equal(s.state.scan.active, true)
  assert.equal(s.state.scan.listName, 'SHORT FAVORITES')
})

test('startScan with a list index selects it first (2f 2b) then starts', async () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.startScan('a', 1, 'FIRE')
  await flush(10)
  const selAt = tp.writes.findIndex((w) => w.startsWith('2f 2b 01'))
  const startAt = tp.writes.findIndex((w) => w.startsWith('57 48 01'))
  assert.ok(selAt >= 0 && startAt > selAt, 'list select precedes scan start')
  assert.equal(s.state.scan.active, true)
  assert.equal(s.state.scan.listName, 'FIRE')
})

test('stopScan clears scan.active on the ack', async () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.startScan('a', null, 'SHORT FAVORITES')
  await flush()
  s.stopScan()
  await flush()
  assert.ok(tp.writes.some((w) => w.startsWith('57 48 00')), 'scan stop sent')
  assert.equal(s.state.scan.active, false)
  assert.equal(s.state.scan.listName, null)
})

test('scan-lock follow: the confirm TIMER fires the lock read with NO further frames; close unlocks', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const tp = new FakeTransport()
    const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => Date.now())
    s.startScan('a', null, 'FIRE')
    await flush()
    assert.equal(s.state.scan.active, true)

    // squelch opens (5b 01) → arms the confirm timer
    tp.handler(hexToBytes('5b 01 5c'))
    await flush()
    assert.equal(s.state.scan.locked, false, 'under the confirm window → not locked')
    assert.ok(!tp.writes.some((w) => w.startsWith('04 2c 01')), 'no scan-poll read yet')

    // advance past the confirm window with NO further frames (the radio is quiet on a lock) — the
    // timer alone must trip the read + lock.
    mock.timers.tick(1100)
    await flush()
    assert.ok(tp.writes.some((w) => w.startsWith('04 2c 01')), 'scan-poll read issued by the timer')
    assert.equal(s.state.scan.locked, true)

    // squelch closes → unlock (ready for the next lock)
    tp.handler(hexToBytes('5b 00 5b'))
    await flush()
    assert.equal(s.state.scan.locked, false)
  } finally {
    mock.timers.reset()
  }
})

test('PTT mid-scan pauses the follow and names the TX channel (no blind WAITING)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    class PttTransport extends FakeTransport {
      override write(bytes: Uint8Array): void {
        if (bytes[0] === 0x56) {
          this.writes.push(bytesToHex(bytes))
          this.handler(hexToBytes('03 56 00 00 59'))
          return
        }
        if (bytes[0] === 0x04 && bytes[1] === 0x2c) {
          this.writes.push(bytesToHex(bytes))
          this.handler(channelBlock('a', { name: 'BCSO SOUTH', rxMHz: 159.27, type: 'analog' }, 5))
          return
        }
        super.write(bytes)
      }
    }
    const tp = new PttTransport()
    const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => Date.now())
    s.startScan('a', null, 'FIRE')
    await flush()
    assert.equal(s.state.scan.active, true)

    // keyup: the ack (not a later push) engages the pause — the radio parks the scan for our TX
    s.key()
    await flush()
    assert.equal(s.state.ptt, 'keyed')
    assert.equal(s.state.scan.paused, true, 'confirmed TX parks the scan follow')

    // the pause-confirm window fires the live-channel read → the card names the TX channel
    // instead of sitting on the sweeping placeholder for the whole keyup
    mock.timers.tick(1100)
    await flush()
    assert.ok(tp.writes.some((w) => w.startsWith('04 2c 01')), 'TX-channel read issued')
    assert.equal(s.state.scan.pausedChannel, 'BCSO SOUTH')
    assert.equal(scanSweeping(s.state.scan), false, 'named channel releases the placeholder')

    // release → pause lifts, the scan resumes hopping (pausedChannel cleared with it)
    s.unkey()
    await flush()
    assert.equal(s.state.ptt, 'idle')
    assert.equal(s.state.scan.paused, false, 'TX end releases the PTT-held pause')
    assert.equal(s.state.scan.pausedChannel, null)
  } finally {
    mock.timers.reset()
  }
})

test('scan-lock: RX on the NON-scanning side pauses the scan (no false lock)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const tp = new FakeTransport()
    const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => Date.now())
    s.startScan('a', null, 'FIRE') // scans side A (selected)
    await flush()

    // The OTHER side (B) opens: a 5a with OPEN_OTHER (b4=0x04) → bOpen, plus the global 5b gate.
    // byte 12 = 0x02: the radio reports its scan RUNNING (a 5a without it would rightly clear
    // scan.active — the radio's own scan truth, corpus-pinned 2026-07-10).
    tp.handler(hexToBytes('5a 04 04 00 00 04 00 00 00 00 00 00 02 00 00 68'))
    tp.handler(hexToBytes('5b 01 5c'))
    await flush()
    assert.equal(s.state.scan.paused, true, 'other-side RX pauses the scan')

    // past the confirm window there is STILL no lock — it's not the scanning side. The one
    // `04 2c 01` read that DOES fire is the pause-confirm read of the PARKED channel (the radio
    // holds a paused scan on the last-scanned channel; the read names it) — never a lock.
    mock.timers.tick(1100)
    await flush()
    assert.equal(s.state.scan.locked, false)
    assert.equal(tp.writes.filter((w) => w.startsWith('04 2c 01')).length, 1, 'exactly the pause-parked-channel read')
  } finally {
    mock.timers.reset()
  }
})

// ── scan-time display honesty: sweeping placeholder, zone status line, last-lock history ──
import { applyEvent } from '../src/domain/reduce'
import { initialState } from '../src/domain/state'
import { contactDisplay, contactId, memoryDisplay, scanLastLock, scanSweeping, vfoView, zoneReadout } from '../src/domain/view'

test('scan display: sweeping hides values, lock shows them, unlock records history', () => {
  let rs = initialState()
  rs = { ...rs, sides: { ...rs.sides, a: { ...rs.sides.a, channelName: 'HOME', zoneName: 'LOCAL', freqMHz: 146.52, mode: 'memory' as const } } }

  // idle: real values, zone line is the zone
  assert.equal(scanSweeping(rs.scan), false)
  assert.deepEqual(zoneReadout('LOCAL', 'memory', rs.scan), { text: 'LOCAL', tone: null })

  // scan starts → sweeping: frequency unknown, zone line carries the status, no history yet
  rs = applyEvent(rs, { kind: 'scan', active: true, listName: 'FIRE' })
  assert.equal(scanSweeping(rs.scan), true)
  assert.deepEqual(zoneReadout('LOCAL', 'memory', rs.scan), { text: 'SCANNING · FIRE', tone: 'scanning' })
  assert.equal(scanLastLock(rs.scan), null)
  const swept = vfoView(rs, 'a')
  assert.equal(swept.sweeping, true)
  assert.equal(swept.zoneReadout.tone, 'scanning')

  // PARK: the 5a parked bit lands with the squelch open — ACQUIRING from the true hop-stop
  // moment (before the session's confirm window even fires the lock + read). The same park with
  // squelch CLOSED is WAITING — dropout hold, other-side pause, sub-confirm blip: the radio
  // never says which, so neither does the display (the collapse).
  const parkedScan = { ...rs.scan, parked: true }
  assert.deepEqual(zoneReadout('LOCAL', 'memory', parkedScan, true), { text: 'ACQUIRING · FIRE', tone: 'acquiring' })
  assert.deepEqual(zoneReadout('LOCAL', 'memory', parkedScan, false), { text: 'WAITING · FIRE', tone: 'waiting' })
  // a paused park reads the same WAITING — the pause cause shows on the other card's RX pill
  assert.equal(zoneReadout('LOCAL', 'memory', { ...parkedScan, paused: true }, false).tone, 'waiting')
  // PAUSED WITHOUT the park bit must ALSO read WAITING — the radio does not reliably set the
  // bit at pause onset (wire 2026-07-13 22:32: other-side RX frames with byte-3 0x20 clear),
  // so the pause flag (edge-driven from the other side's 5a bit) is its own trigger.
  assert.deepEqual(zoneReadout('LOCAL', 'memory', { ...rs.scan, paused: true }, false), { text: 'WAITING · FIRE', tone: 'waiting' })

  // lock CONFIRMED but the lock-follow read hasn't landed: ACQUIRING — we know THAT we stopped,
  // not WHERE. Still sweeping (the slice holds the PREVIOUS channel and must not flash), the
  // zone line says so honestly, and the channel name stays "Scanning…" until a real name lands.
  rs = applyEvent(rs, { kind: 'scanLock', locked: true })
  assert.equal(scanSweeping(rs.scan), true, 'locked-unread → placeholder holds')
  assert.deepEqual(zoneReadout('LOCAL', 'memory', rs.scan), { text: 'ACQUIRING · FIRE', tone: 'acquiring' })
  assert.equal(memoryDisplay('memory', rs.sides.a.channelName, rs.scan), 'Scanning…')

  // the read lands (channel block for the scanning side) → lockedChannel named → values live
  rs = { ...rs, sides: { ...rs.sides, a: { ...rs.sides.a, channelName: 'PAPA BRIDGE', freqMHz: 146.76 } } }
  rs = { ...rs, scan: { ...rs.scan, lockedChannel: 'PAPA BRIDGE' } }
  assert.equal(scanSweeping(rs.scan), false)
  assert.deepEqual(zoneReadout('LOCAL', 'memory', rs.scan), { text: 'LOCKED · FIRE', tone: 'locked' })
  assert.equal(scanLastLock(rs.scan), null, 'no history chip while locked — the value IS current')

  // lock drops → back to sweeping, and the locked channel becomes labeled history
  rs = applyEvent(rs, { kind: 'scanLock', locked: false })
  assert.equal(scanSweeping(rs.scan), true)
  const ll = scanLastLock(rs.scan)
  assert.equal(ll?.name, 'PAPA BRIDGE')
  assert.equal(ll?.freqMHz, 146.76)
  assert.ok(typeof ll?.at === 'number' && ll.at > 0)

  // pause: the radio PARKS a paused scan, so the zone line reads WAITING; history persists.
  // UNCONFIRMED pause (parked channel not read back yet) still placeholders; once the
  // pause-confirm read names the parked channel, its values are CURRENT.
  rs = applyEvent(rs, { kind: 'scanPause', paused: true })
  rs = { ...rs, scan: { ...rs.scan, parked: true } } // the radio's park bit rides the same 5a
  assert.equal(zoneReadout('LOCAL', 'memory', rs.scan).tone, 'waiting')
  assert.equal(scanLastLock(rs.scan)?.name, 'PAPA BRIDGE')
  assert.equal(scanSweeping(rs.scan), true, 'unconfirmed pause → values still unknown')
  rs = { ...rs, scan: { ...rs.scan, pausedChannel: 'PARKED CH' } } // pause-confirm read landed
  assert.equal(scanSweeping(rs.scan), false, 'confirmed pause → parked-channel values are current')
  assert.equal(scanLastLock(rs.scan)?.name, 'PAPA BRIDGE', 'history chip survives the confirmed pause')
  rs = applyEvent(rs, { kind: 'scanPause', paused: false })
  rs = { ...rs, scan: { ...rs.scan, parked: false } } // park lifts as the hop resumes
  assert.equal(scanSweeping(rs.scan), true, 'pause over → hopping again → placeholder')

  // scan stops → history cleared, zone line back to the zone
  rs = applyEvent(rs, { kind: 'scan', active: false, listName: null })
  assert.equal(rs.scan.lastLock, null)
  assert.deepEqual(zoneReadout('LOCAL', 'memory', rs.scan), { text: 'LOCAL', tone: null })
})

test('scan display: VFO mode reads DIRECT FREQUENCY; scan status wins over VFO', () => {
  const idle = initialState().scan
  assert.deepEqual(zoneReadout('ZONE', 'vfo', idle), { text: 'DIRECT FREQUENCY', tone: null })
  assert.deepEqual(zoneReadout('ZONE', 'vfo', null), { text: 'DIRECT FREQUENCY', tone: null })
  const scanning = { ...idle, active: true, listName: null }
  assert.deepEqual(zoneReadout('ZONE', 'vfo', scanning), { text: 'SCANNING', tone: 'scanning' })
})

// ── sweeping blanks the STALE channel-record badges (type + contact), same rule as the freq ──
import { applyFrame } from '../src/domain/reduce'
import { channelBlock, smeterPush } from './sim/frames'
import type { ChannelConfig } from '../src/codec/decode'
import type { RadioState as RS } from '../src/domain/state'

const dmrChannelCfg = { type: 'digital', colorCode: 1, timeSlot: 1, contact: { callType: 'group', talkgroup: 31088, name: 'CO HD' } } as unknown as ChannelConfig

// The contact chip shows the programmed contact-list NAME (channel record byte 79) over the ID.
const contact = (over: Record<string, unknown>) => ({ callType: 'group', talkgroup: 700, name: '', ...over }) as never
test('contactDisplay prefixes the programmed name (TG …); contactId is the numeric companion', () => {
  assert.equal(contactDisplay(contact({ name: 'NXDN JOE' })), 'TG NXDN JOE')
  assert.equal(contactId(contact({ name: 'NXDN JOE' })), 'TG 700')
  // no name → fall back to the call-type-prefixed id
  assert.equal(contactDisplay(contact({ name: '' })), 'TG 700')
  assert.equal(contactDisplay(contact({ name: 'PARROT', callType: 'private', talkgroup: 310997 })), 'Priv PARROT')
  assert.equal(contactId(contact({ name: 'PARROT', callType: 'private', talkgroup: 310997 })), 'Priv 310997')
  // no contact at all
  assert.equal(contactDisplay(null), '')
  assert.equal(contactId(null), '')
})

test('sweeping blanks the type badge and contact chip — a DMR channel in the list must not haunt the hop', () => {
  let rs = initialState()
  rs = { ...rs, sides: { ...rs.sides, a: { ...rs.sides.a, channelName: 'COLORADO HD', freqMHz: 449.625, channel: dmrChannelCfg, mode: 'memory' as const } } }
  let v = vfoView(rs, 'a')
  assert.equal(v.typeLabel, 'DMR')
  assert.equal(v.contactDisplay, 'TG CO HD')

  // scan resumes → position unknown → the stale record's badges blank with the freq
  rs = applyEvent(rs, { kind: 'scan', active: true, listName: 'FIRE' })
  v = vfoView(rs, 'a')
  assert.equal(v.typeLabel, '--', 'type badge placeholders while sweeping')
  assert.equal(v.contactDisplay, '', 'contact chip hides while sweeping')

  // lock-follow read lands → the record is current again → badges return
  rs = applyEvent(rs, { kind: 'scanLock', locked: true })
  rs = { ...rs, scan: { ...rs.scan, lockedChannel: 'COLORADO HD' } }
  v = vfoView(rs, 'a')
  assert.equal(v.typeLabel, 'DMR')
  assert.equal(v.contactDisplay, 'TG CO HD')
})

// ── scan stop mid-DMR-call: the scanning side's call must clear (its teardown never arrives —
// the presentation was dismissed by the scan-start 5c and 5e is suppressed while scanning) ──

const liveCall = (side: 'a' | 'b'): NonNullable<RS['dmr']> => ({
  direction: 'rx', colorCode: 1, slot: 1, source: 3223436, dest: 700, private: false,
  alias: null, callerId: 3223436, callsign: 'KF0WWS', name: 'Keaton', location: null,
  presented: true, audioRouted: true, side, noLock: false,
})

test('stop ack mid-call clears the scanning side\'s call — the tuple/caller chips must not latch', () => {
  let rs = initialState() // selectedSide 'a'
  rs = applyEvent(rs, { kind: 'scan', active: true, listName: 'FIRE' })
  rs = { ...rs, dmr: liveCall('a') }
  rs = applyEvent(rs, { kind: 'scan', active: false, listName: null })
  assert.equal(rs.dmr, null)
})

test('stop ack keeps a live call on the NON-scanning side (independent of the scan)', () => {
  let rs = initialState()
  rs = applyEvent(rs, { kind: 'scan', active: true, listName: 'FIRE' })
  rs = { ...rs, dmr: liveCall('b') }
  rs = applyEvent(rs, { kind: 'scan', active: false, listName: null })
  assert.ok(rs.dmr, 'the other side\'s call keeps its normal 5c-driven life')
})

test('radio-truth scan-off (5a flag drop — panel stop) clears the scanning side\'s call too', () => {
  let rs = initialState()
  rs = applyEvent(rs, { kind: 'scan', active: true, listName: 'FIRE' })
  rs = { ...rs, dmr: liveCall('a') }
  const bytes = smeterPush({ selectedRssi: 0, otherRssi: 0, selectedOpen: false, otherOpen: false, scanning: false })
  rs = applyFrame(rs, { head: 0x5a, reg: undefined, bytes, checksumOk: true })
  assert.equal(rs.scan.active, false, 'the 5a flag reconciles the scan off')
  assert.equal(rs.dmr, null)
})

// ── channel picker (04 27 members + 04 2e names → listChannels; absolute select) ──
import { decodeZoneChannelMembers, decodeChannelName } from '../src/codec/decode'
import { readChannelName } from '../src/codec/commands'

test('decodeZoneChannelMembers reads LE16 indices to the 0xffff terminator', () => {
  const b = new Uint8Array(104)
  b.set([0x04, 0x27, 0x00], 0)
  b.set([0x4e, 0x00, 0x4c, 0x00, 0x31, 0x00], 3) // 3 members: 78, 76, 49
  b.set([0xff, 0xff], 9)
  assert.deepEqual(decodeZoneChannelMembers(b), [78, 76, 49])
})

test('readChannelName is 04 2e <hi> <lo> 04 00; decodeChannelName reads @2', () => {
  assert.equal(bytesToHex(readChannelName(0x0134)), '04 2e 01 34 04 00')
  const b = new Uint8Array(20)
  b.set([0x04, 0x2e], 0)
  for (let i = 0; i < 6; i++) b[2 + i] = 'LOOKUT'.charCodeAt(i)
  assert.equal(decodeChannelName(b), 'LOOKUT')
})

test('listChannels reads members then names for the current zone', async () => {
  class PickerTransport extends FakeTransport {
    names: Record<number, string> = { 78: 'RMRL', 76: 'SHL', 49: 'COLCON' }
    override write(bytes: Uint8Array): void {
      this.writes.push(bytesToHex(bytes))
      if (bytes[0] === 0x04 && bytes[1] === 0x27) {
        const b = new Uint8Array(104)
        b.set([0x04, 0x27, 0x00], 0)
        b.set([78, 0, 76, 0, 49, 0, 0xff, 0xff], 3)
        let s = 0
        for (let i = 0; i < 103; i++) s = (s + b[i]!) & 0xff
        b[103] = s
        this.handler(b)
      } else if (bytes[0] === 0x04 && bytes[1] === 0x2e) {
        const gi = (bytes[2]! << 8) | bytes[3]!
        const nm = this.names[gi] ?? ''
        const b = new Uint8Array(20)
        b.set([0x04, 0x2e], 0)
        for (let i = 0; i < nm.length; i++) b[2 + i] = nm.charCodeAt(i)
        let s = 0
        for (let i = 0; i < 19; i++) s = (s + b[i]!) & 0xff
        b[19] = s
        this.handler(b)
      }
    }
  }
  const tp = new PickerTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.state.sides.a.zoneNumber = 0
  const chans = await s.listChannels('a')
  assert.deepEqual(chans, [
    { position: 0, name: 'RMRL' },
    { position: 1, name: 'SHL' },
    { position: 2, name: 'COLCON' },
  ])
})

test('selectChannel jumps to an absolute in-zone position', () => {
  const tp = new FakeTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.selectChannel('a', 5)
  assert.ok(tp.writes[0]!.startsWith('04 2c 01 55 05 01'), 'absolute select of position 5')
})

// ── "go anywhere": zone directory (04 2b) enumeration + cross-zone jump ──
import { readZoneName } from '../src/codec/commands'
import { decodeZoneBrowseName } from '../src/codec/decode'

/** A 35-byte 04 2b zone-directory entry (the radio's fixed length) with a 32-byte ASCII name
 * @offset 2. `name === null` → a blank-name slot (name bytes zeroed → decodes to null). */
function zoneNameReply(index: number, name: string | null): Uint8Array {
  const b = new Uint8Array(35)
  b.set([0x04, 0x2b, index], 0)
  const text = name ?? ''
  for (let i = 0; i < text.length && i < 32; i += 1) b[2 + i] = text.charCodeAt(i)
  let s = 0
  for (let i = 0; i < 34; i += 1) s = (s + b[i]!) & 0xff
  b[34] = s
  return b
}

test('readZoneName is 04 2b <idx> 00 02 00; decodeZoneBrowseName reads @2', () => {
  assert.equal(bytesToHex(readZoneName(3)), '04 2b 03 00 02 00')
  assert.equal(decodeZoneBrowseName(zoneNameReply(0, 'FAVORITES')), 'FAVORITES')
  assert.equal(decodeZoneBrowseName(zoneNameReply(9, null)), null)
})

test('listZones enumerates the 04 2b directory until a blank name', async () => {
  class ZoneTransport extends FakeTransport {
    names: (string | null)[] = ['FAVORITES', 'HOTSPOT', 'GMRS', null, null]
    override write(bytes: Uint8Array): void {
      this.writes.push(bytesToHex(bytes))
      if (bytes[0] === 0x04 && bytes[1] === 0x2b) this.handler(zoneNameReply(bytes[2]!, this.names[bytes[2]!] ?? null))
    }
  }
  const tp = new ZoneTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  const zones = await s.listZones()
  assert.deepEqual(zones, [
    { index: 0, name: 'FAVORITES' },
    { index: 1, name: 'HOTSPOT' },
    { index: 2, name: 'GMRS' },
  ])
})

test('selectZoneChannel switches zone (08 39) then selects the channel on the ack', async () => {
  class JumpTransport extends FakeTransport {
    override write(bytes: Uint8Array): void {
      this.writes.push(bytesToHex(bytes))
      // ack the 08 side/zone writes so the chained channel-select fires
      if (bytes[0] === 0x08) this.handler(hexToBytes('03 08 00 00 0b'))
    }
  }
  const tp = new JumpTransport()
  const s = new Session(tp, { timeoutMs: 1000, maxAttempts: 3, gapMs: 0 }, () => 0)
  s.state.selectedSide = 'a'
  s.selectZoneChannel('a', 2, 4)
  await flush(12)
  const zoneAt = tp.writes.findIndex((w) => w.startsWith('08 39 02'))
  const chAt = tp.writes.findIndex((w) => w.startsWith('04 2c 01 55 04 01'))
  assert.ok(zoneAt >= 0, 'zone-select 08 39 02 sent')
  assert.ok(chAt > zoneAt, 'channel-select follows the zone-select ack')
})

