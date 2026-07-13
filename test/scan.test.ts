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
import { memoryDisplay, scanLastLock, scanSweeping, vfoView, zoneReadout } from '../src/domain/view'

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

  // lock CONFIRMED but the lock-follow read hasn't landed: still sweeping — the slice holds the
  // PREVIOUS channel and must not flash (the two-phase lock: locked says stopped, lockedChannel
  // says the data is current)
  rs = applyEvent(rs, { kind: 'scanLock', locked: true })
  assert.equal(scanSweeping(rs.scan), true, 'locked-unread → placeholder holds')
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

  // pause: grey status, history persists. UNCONFIRMED pause (parked channel not read back yet)
  // still placeholders; once the pause-confirm read names the parked channel, its values are
  // CURRENT — the card shows real frequency/channel data through the pause.
  rs = applyEvent(rs, { kind: 'scanPause', paused: true })
  assert.equal(zoneReadout('LOCAL', 'memory', rs.scan).tone, 'paused')
  assert.equal(scanLastLock(rs.scan)?.name, 'PAPA BRIDGE')
  assert.equal(scanSweeping(rs.scan), true, 'unconfirmed pause → values still unknown')
  rs = { ...rs, scan: { ...rs.scan, pausedChannel: 'PARKED CH' } } // pause-confirm read landed
  assert.equal(scanSweeping(rs.scan), false, 'confirmed pause → parked-channel values are current')
  assert.equal(scanLastLock(rs.scan)?.name, 'PAPA BRIDGE', 'history chip survives the confirmed pause')
  rs = applyEvent(rs, { kind: 'scanPause', paused: false })
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

