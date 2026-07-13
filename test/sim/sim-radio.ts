// SimRadio — a stateful simulated AT-D578 that speaks the real wire protocol over the Transport
// interface, so the FULL production stack (framer → link/ARQ → session → reducer → activeReceive →
// recorder) runs against it unmodified. It answers reads from its own codeplug/state, acks writes
// and MUTATES (side/zone/channel/scan/PTT), and pushes 5a/5b/5e/58 exactly the way the radio does:
// side-RELATIVE smeter frames, a global squelch gate, latched DMR call streams.
//
// Measured quirks are modelled where the host has logic that depends on them:
//   • post-side-swap the 5a engine SUSPENDS pushes ~900 ms and resumes in the new frame of
//     reference; reads inside the window return OLD-reference data (sitting-1, 2026-07-03)
//   • the radio is QUIET while scan hops — it never pushes the channel it's scanning; a lock is
//     visible only as squelch-open + whatever the host reads back (04 2c/2d mode 01)
//   • the radio pauses the scan while the NON-scanning side is receiving
//
// Time comes from an injected now() plus setTimeout/setInterval — the harness runs it under
// mock.timers, so cadences (DMR voice frames, scan hops, settle windows) are deterministic.

import type { Transport } from '../../src/transport/types'
import {
  ack,
  aliasPush,
  teardownPush,
  channelBlock,
  channelNameBlock,
  clockBlock,
  dmrControlPush,
  dmrIdlePush,
  dmrRead,
  dmrVoicePush,
  firmwareBlock,
  identityBlock,
  lastCallBlock,
  opaqueBlock,
  scanListBlock,
  sealed,
  settingsBlock,
  settingsBlock05,
  smeterPush,
  smeterRead,
  squelchPush,
  squelchRead,
  zoneBlock,
  zoneBrowseBlock,
  zoneCountBlock,
  zoneMembersBlock,
  type DmrCallFields,
  type SimChannel,
  type SimLastCall,
} from './frames'

export interface SimZone {
  readonly name: string
  readonly channels: readonly SimChannel[]
}

export interface SimScanList {
  readonly name: string
  /** Channels in scan order, as {zone, pos} refs into the codeplug. */
  readonly members: readonly { zone: number; pos: number }[]
}

export interface SimCodeplug {
  readonly zones: readonly SimZone[]
  readonly scanLists: readonly SimScanList[]
  readonly firmware?: string
  readonly dmrId?: number
  readonly callsign?: string
}

type SideKey = 'a' | 'b'

interface SideSlot {
  zone: number
  pos: number
}

interface RfCarrier {
  rssi: number
  open: boolean
}

export interface DmrCallSpec extends DmrCallFields {
  readonly alias?: string
  /** Voice-frame cadence (default 60 ms). */
  readonly intervalMs?: number
  /** The PHYSICAL side carrying the call (default: the selected side). Drives the wire-pinned
   * per-side 5a open/RSSI reporting and the scan-held 5b silence (see gateOpen). */
  readonly side?: SideKey
  /** Emit the 58 presentation push (default true — the real radio presents every call it
   * decodes-for-real). false models call-start pushes the host never RECEIVED (started before
   * connect) — presentation then only arrives via the 04 5e/04 59 startup reads. */
  readonly present?: boolean
}

const SIDE_SETTLE_MS = 900 // measured 5a push suspension after an 08 19 ack
const SCAN_HOP_MS = 150

export class SimRadio implements Transport {
  private handler: (chunk: Uint8Array) => void = () => {}
  private closeHandler: () => void = () => {}
  closed = false

  /** Every host→radio frame, for protocol assertions. */
  readonly writes: Uint8Array[] = []

  // ── radio state ─────────────────────────────────────────────────────────────
  selectedSide: SideKey = 'a'
  readonly slot: Record<SideKey, SideSlot> = { a: { zone: 0, pos: 0 }, b: { zone: 0, pos: 0 } }
  /** Physical per-side carrier (analog RF truth). */
  readonly rf: Record<SideKey, RfCarrier> = { a: { rssi: 0, open: false }, b: { rssi: 0, open: false } }
  transmitting = false
  scanListIndex = 0
  /** Non-null while a native scan runs: the side it scans + the working cursor. */
  scanning: { side: SideKey; list: number; cursor: number; landed: SideSlot | null } | null = null
  private dmrCall: { spec: DmrCallSpec; side: SideKey; timer: ReturnType<typeof setInterval>; n: number } | null = null
  /** A call still on the air while the link is down — its push stream resumes on reopen. */
  private pausedCall: { spec: DmrCallSpec; side: SideKey } | null = null
  /** The radio's PERSISTED last-call record (04 59) — set by every DMR call, survives reopen. */
  lastCall: SimLastCall | null = null

  // Post-swap 5a behavior: pushes suspended until, and reads answered in the OLD reference until.
  private pushSuspendedUntil = Number.NEGATIVE_INFINITY
  private staleReadUntil = Number.NEGATIVE_INFINITY
  private previousSelectedSide: SideKey = 'a'
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private hopTimer: ReturnType<typeof setInterval> | null = null
  private readonly ignore = new Map<number, number>() // op → count of writes to silently drop

  constructor(
    readonly plug: SimCodeplug,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ── Transport ───────────────────────────────────────────────────────────────
  onData(handler: (chunk: Uint8Array) => void): void {
    this.handler = handler
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler
  }
  close(): void {
    this.closed = true
    this.stopTimers()
  }
  /** Simulate a link drop (radio side). */
  dropLink(): void {
    this.stopTimers()
    this.closeHandler()
  }

  /** Reopen after a link drop — the SAME physical radio: channel/zone/side state, live RF
   * carriers AND a running native scan all persist across the drop (a scan is a radio-local
   * function; only its BT stream died). A DMR call's push stream is transient — treated as ended.
   * Used by (re)connect scenarios; the host rediscovers the scan from the startup 04 5a flag. */
  reopen(): this {
    this.closed = false
    this.transmitting = false
    this.pushSuspendedUntil = Number.NEGATIVE_INFINITY
    this.staleReadUntil = Number.NEGATIVE_INFINITY
    if (this.scanning) this.armHopTimer() // the scan kept running while the link was down
    if (this.pausedCall) {
      // an RF call doesn't end because OUR link bounced — resume its push stream quietly (no
      // burst emit; the host discovers it through the startup 04 5e/59 reads + the next ticks)
      const { spec, side } = this.pausedCall
      this.pausedCall = null
      const timer = setInterval(() => this.dmrTick(), spec.intervalMs ?? 60)
      ;(timer as { unref?: () => void }).unref?.()
      this.dmrCall = { spec, side, timer, n: 0 }
    }
    return this
  }

  write(bytes: Uint8Array): void {
    this.writes.push(bytes.slice())
    const op = bytes[0]!
    const pending = this.ignore.get(op) ?? 0
    if (pending > 0) {
      this.ignore.set(op, pending - 1)
      return
    }
    switch (op) {
      case 0x61: // wake
        return this.emit(ack(0x61))
      case 0x01: // COM MODE
        return this.emit(ack(0x01))
      case 0x64: // COM CHECK END → streaming on
        return this.emit(ack(0x64))
      case 0x03: // host push-ack — consumed silently
        return
      case 0x04:
        return this.onRead(bytes)
      case 0x08:
        return this.onMenuWrite(bytes)
      case 0x2f:
        return this.on2f(bytes)
      case 0x57:
        return this.on57(bytes)
      case 0x56:
        return this.onPtt(bytes)
      default:
        return // unknown host op: the real radio stays silent; ARQ handles it
    }
  }

  /** Silently drop the next `count` host frames of `op` (ARQ/timeout scenarios). */
  ignoreNext(op: number, count = 1): void {
    this.ignore.set(op, (this.ignore.get(op) ?? 0) + count)
  }

  // ── host command handling ───────────────────────────────────────────────────

  private onRead(b: Uint8Array): void {
    const reg = b[1]!
    // channel SELECT (04 2c/2d 01 55 <target> <dir>) — a write in read clothing.
    if ((reg === 0x2c || reg === 0x2d) && b[2] === 0x01 && b[3] === 0x55) {
      return this.onChannelSelect(reg === 0x2d ? 'b' : 'a', b[4]!, b[5]!)
    }
    switch (reg) {
      case 0x02:
        return this.emit(firmwareBlock(this.plug.firmware ?? 'SIM_D578_V1'))
      case 0x05:
        return this.emit(settingsBlock05(this.readReferenceSide()))
      case 0x06:
      case 0x09:
        return this.emit(settingsBlock(reg))
      case 0x1b:
        return this.emit(zoneCountBlock(this.plug.zones.length))
      case 0x27: {
        const zone = b[2]!
        return this.emit(zoneMembersBlock(zone, this.zoneMemberGlobals(zone)))
      }
      case 0x29:
      case 0x2a: {
        const side: SideKey = reg === 0x2a ? 'b' : 'a'
        const s = this.slot[side]
        return this.emit(zoneBlock(side, this.plug.zones[s.zone]?.name ?? '', s.zone))
      }
      case 0x2b:
        return this.emit(zoneBrowseBlock(b[2]!, this.plug.zones[b[2]!]?.name ?? null))
      case 0x2c:
      case 0x2d:
        return this.emitChannel(reg === 0x2d ? 'b' : 'a')
      case 0x2e: {
        const global = (b[2]! << 8) | b[3]!
        return this.emit(channelNameBlock(this.channelByGlobal(global)?.name ?? ''))
      }
      case 0x32:
        return this.emit(identityBlock(this.plug.dmrId ?? 3100001, this.plug.callsign ?? 'SIMCALL'))
      case 0x4a:
        // The working channel's ASSIGNED scan-list record — while scanning, the list being
        // scanned. Always 135 B (empty = zeroed name), unlike the 4b directory's 18 B empty slot.
        return this.emit(scanListBlock(this.scanListIndex, this.plug.scanLists[this.scanListIndex]?.name ?? '', 0x4a))
      case 0x4b:
        return this.emit(scanListBlock(b[2]!, this.plug.scanLists[b[2]!]?.name ?? null))
      case 0x4d:
      case 0x4e:
        return this.emit(opaqueBlock(reg))
      case 0x51:
        return this.emit(clockBlock(12, 0, 0))
      case 0x59:
        return this.emit(lastCallBlock(this.lastCall))
      case 0x5a:
        return this.emit(smeterRead(this.smeterFields(this.readReferenceSide())))
      case 0x5b:
        return this.emit(squelchRead(this.gateOpen()))
      case 0x5e:
        return this.emit(dmrRead(this.dmrCall?.spec ?? null))
      default:
        return // unknown register: silence (host ARQ times out) — like the hardware
    }
  }

  private onMenuWrite(b: Uint8Array): void {
    const op = b[1]!
    const value = b[2]!
    if (op === 0x19) {
      // side select — swap reference, suspend 5a pushes through the settle window, and answer
      // reads in the OLD reference inside it (both relay-measured).
      const side: SideKey = value === 1 ? 'b' : 'a'
      if (side !== this.selectedSide) {
        this.previousSelectedSide = this.selectedSide
        this.selectedSide = side
        this.pushSuspendedUntil = this.now() + SIDE_SETTLE_MS
        this.staleReadUntil = this.now() + SIDE_SETTLE_MS
        this.armSettleResume()
      }
    } else if (op === 0x39) {
      // zone select applies to the radio's selected side; entering a zone loads its first channel.
      const zone = Math.min(value, Math.max(0, this.plug.zones.length - 1))
      this.slot[this.selectedSide] = { zone, pos: 0 }
    }
    // every 08 write shares the generic 03 08 ack (settings writes mutate nothing we model)
    this.emit(ack(0x08))
  }

  private on2f(b: Uint8Array): void {
    if (b[1] === 0x2b) this.scanListIndex = b[2]!
    this.emit(ack(0x2f)) // channel-setting/tone/freq writes: acked, radio-side effect not modelled
  }

  private on57(b: Uint8Array): void {
    if (b[1] === 0x48) {
      if (b[2] === 0x01) this.startScanning()
      else this.stopScanning()
    }
    this.emit(ack(0x57))
  }

  private onPtt(b: Uint8Array): void {
    const keyed = b[1] === 0x01
    this.emit(ack(0x56))
    this.transmitting = keyed
    this.emit(smeterPush(this.smeterFields(this.selectedSide)))
    const ch = this.currentChannel(this.selectedSide)
    if (ch?.type === 'digital') {
      if (keyed) {
        // manual-dial frame carries setup 0x06 + BE24 target @7-9; else the channel contact.
        const manual = b[4] === 0x06 ? ((b[7]! << 16) | (b[8]! << 8) | b[9]!) : null
        const dest = manual ?? ch.contact?.talkgroup ?? 0
        this.startDmrCall({
          direction: 'tx',
          colorCode: ch.colorCode ?? 1,
          slot: ch.timeSlot ?? 1,
          source: this.plug.dmrId ?? 3100001,
          dest,
        })
      } else {
        this.endDmrCall()
      }
    }
  }

  private onChannelSelect(side: SideKey, target: number, _dir: number): void {
    const s = this.slot[side]
    const count = this.plug.zones[s.zone]?.channels.length ?? 1
    // 0xf9 is the radio's own wrap-to-last sentinel; past-the-end wraps to 0.
    s.pos = target === 0xf9 ? count - 1 : target >= count ? 0 : target
    this.emitChannel(side)
  }

  // ── scenario controls (what the RF world / operator does) ──────────────────

  /** Raise/adjust an analog carrier on a side; pushes 5a (side-relative) + the 5b gate edge. */
  setCarrier(side: SideKey, rssi: number): void {
    const gateWas = this.gateOpen()
    this.rf[side] = { rssi, open: rssi > 0 }
    this.pushSmeter()
    this.pushGateIfChanged(gateWas)
  }

  /** Drop a side's carrier. */
  clearCarrier(side: SideKey): void {
    this.setCarrier(side, 0)
  }

  /** Begin a DMR call stream: 5b gate opens (see gateOpen for the scan-held exception), 5a
   * carries the call side's open bit + full RSSI (wire-pinned), 5e voice/control frames at
   * cadence, one 58 alias. */
  startDmrCall(spec: DmrCallSpec): void {
    this.endDmrCall(true)
    const gateWas = this.gateOpen()
    const interval = spec.intervalMs ?? 60
    const state = { spec, side: spec.side ?? this.selectedSide, n: 0, timer: setInterval(() => this.dmrTick(), interval) }
    ;(state.timer as { unref?: () => void }).unref?.()
    this.dmrCall = state
    // every call updates the radio's persisted last-call record (04 59)
    this.lastCall = { dest: spec.dest, callerId: spec.source, ...(spec.alias ? { callerName: spec.alias } : {}) }
    this.pushGateIfChanged(gateWas)
    this.emit(dmrVoicePush(spec))
    this.pushSmeter() // the call side's 5a open/RSSI (streams ~1 s in on the real wire)
    // CALL PRESENTATION: the real radio pushes 58 for every call it presents (with the caller id;
    // the name field may be empty/stale) — RX calls only render once this arrives.
    if (spec.present ?? true) this.emit(aliasPush(spec.source, spec.alias ?? ''))
  }

  /** End the DMR call: 5e idle + gate closes (unless an analog carrier holds it), then the 5c
   * hang-time teardown (the real radio fires it ~1.2 s after the gate closes; the sim compresses
   * the wait — reducer behavior is identical). */
  endDmrCall(silent = false): void {
    this.pausedCall = null // however it ends, nothing to resume
    if (!this.dmrCall) return
    const gateWas = this.gateOpen()
    clearInterval(this.dmrCall.timer)
    this.dmrCall = null
    if (!silent) {
      this.emit(dmrIdlePush())
      this.pushSmeter() // the call side's 5a open bit drops
      this.pushGateIfChanged(gateWas)
      this.emit(teardownPush())
    }
  }

  private dmrTick(): void {
    const call = this.dmrCall
    if (!call) return
    call.n += 1
    // every third frame is a control frame (no identity fields) — exercises the reducer latch
    this.emit(call.n % 3 === 0 ? dmrControlPush(call.spec.direction) : dmrVoicePush(call.spec))
  }

  /** Scan lands on a busy channel: the working cursor points at it and its carrier opens on the
   * scanning side. The radio pushes ONLY squelch/smeter — never the channel identity. */
  scanLand(zone: number, pos: number, rssi = 3): void {
    if (!this.scanning) throw new Error('scanLand: no scan running')
    this.scanning.landed = { zone, pos }
    this.setCarrier(this.scanning.side, rssi)
  }

  /** Re-push the current smeter state (respects the post-swap suppression window) — what the
   * radio does on any RF activity; scenarios use it to refresh after a settle window. */
  nudge(): void {
    this.pushSmeter()
  }

  /** Inject a raw radio→host push (edge-case frames a behavior model doesn't cover, e.g. the
   * control-frames-before-first-voice-frame start of a DMR call). */
  injectPush(bytes: Uint8Array): void {
    this.emit(bytes)
  }

  /** The operator starts/stops a scan from the RADIO's front panel — no host command involved;
   * the only wire evidence is the 5a scan flag (byte 12) on the next push. */
  panelScan(on: boolean): void {
    if (on) this.startScanning()
    else this.stopScanning()
    this.pushSmeter()
  }

  /** The landed scan channel goes quiet: carrier drops and hopping resumes. */
  scanResume(): void {
    if (!this.scanning) return
    this.clearCarrier(this.scanning.side)
    this.scanning.landed = null
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private startScanning(): void {
    this.stopHop()
    this.scanning = { side: this.selectedSide, list: this.scanListIndex, cursor: 0, landed: null }
    this.armHopTimer()
  }

  private armHopTimer(): void {
    if (this.hopTimer) return
    this.hopTimer = setInterval(() => this.hop(), SCAN_HOP_MS)
    ;(this.hopTimer as { unref?: () => void }).unref?.()
  }

  private stopScanning(): void {
    // The radio RETURNS to its pre-scan channel on stop — the RE evidence: post-scan the base
    // `04 2c/2d 07` register is stale (it holds the scan working slot) while the LIVE `…01`
    // register shows the real current channel, which is why the BT-01 restores from `…01`.
    this.stopHop()
    this.scanning = null
  }

  private hop(): void {
    const scan = this.scanning
    if (!scan || scan.landed) return
    // the radio holds the scan while the OTHER side is receiving (pause — PARKED on the cursor
    // channel) and doesn't hop off its OWN channel while a carrier is up (lock-in-waiting)
    const other: SideKey = scan.side === 'a' ? 'b' : 'a'
    if (this.rf[other].open || this.rf[scan.side].open) return
    const list = this.plug.scanLists[scan.list]
    if (list && list.members.length > 0) scan.cursor = (scan.cursor + 1) % list.members.length
  }

  private stopHop(): void {
    if (this.hopTimer) {
      clearInterval(this.hopTimer)
      this.hopTimer = null
    }
  }

  private stopTimers(): void {
    this.stopHop()
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    if (this.dmrCall) {
      // link teardown, not end-of-call: the call stays on the air (resumed by reopen)
      this.pausedCall = { spec: this.dmrCall.spec, side: this.dmrCall.side }
      clearInterval(this.dmrCall.timer)
      this.dmrCall = null
    }
  }

  /** After the settle window the 5a engine resumes — already in the NEW frame of reference. */
  private armSettleResume(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      this.emit(smeterPush(this.smeterFields(this.selectedSide)))
    }, SIDE_SETTLE_MS)
    ;(this.settleTimer as { unref?: () => void }).unref?.()
  }

  /** Which side reads are answered relative to right now (OLD side inside the stale window). */
  private readReferenceSide(): SideKey {
    return this.now() < this.staleReadUntil ? this.previousSelectedSide : this.selectedSide
  }

  /** Per-side openness/level INCLUDING a live DMR RX call — wire-pinned 2026-07-11: the 5a
   * reports the call side's open bit (mask) + full RSSI even for a non-selected DMR side. */
  private sideOpen(side: SideKey): boolean {
    return this.rf[side].open || (this.dmrCall?.spec.direction === 'rx' && this.dmrCall.side === side)
  }
  private sideRssi(side: SideKey): number {
    const dmr = this.dmrCall?.spec.direction === 'rx' && this.dmrCall.side === side ? 4 : 0
    return Math.max(this.rf[side].rssi, dmr)
  }

  private smeterFields(reference: SideKey) {
    const other: SideKey = reference === 'a' ? 'b' : 'a'
    return {
      selectedRssi: this.sideRssi(reference),
      otherRssi: this.sideRssi(other),
      selectedOpen: this.sideOpen(reference),
      otherOpen: this.sideOpen(other),
      transmitting: this.transmitting,
      scanning: this.scanning !== null, // 5a byte 12 — the radio reports its own scan truth
    }
  }

  private gateOpen(): boolean {
    const call = this.dmrCall
    // Wire-pinned 2026-07-11: while a native SCAN runs, a DMR RX call on the NON-scanning side
    // never raises the 5b gate (the radio pushes only a redundant CLOSED at call end) — its
    // presence shows solely through the per-side 5a bits. Without a scan, it raises 5b normally.
    const dmrGate =
      call?.spec.direction === 'rx' && !(this.scanning && call.side !== this.scanning.side)
    return this.rf.a.open || this.rf.b.open || !!dmrGate
  }

  private pushSmeter(): void {
    if (this.now() < this.pushSuspendedUntil) return // post-swap 5a suspension
    this.emit(smeterPush(this.smeterFields(this.selectedSide)))
  }

  private pushGateIfChanged(was: boolean): void {
    const is = this.gateOpen()
    if (is !== was) this.emit(squelchPush(is))
  }

  /** The channel a side is working: the scan cursor's channel while its scan runs, else the slot. */
  private workingSlot(side: SideKey): SideSlot {
    const scan = this.scanning
    if (scan && scan.side === side) {
      if (scan.landed) return scan.landed
      const m = this.plug.scanLists[scan.list]?.members[scan.cursor]
      if (m) return { zone: m.zone, pos: m.pos }
    }
    return this.slot[side]
  }

  currentChannel(side: SideKey): SimChannel | null {
    const s = this.workingSlot(side)
    return this.plug.zones[s.zone]?.channels[s.pos] ?? null
  }

  private emitChannel(side: SideKey): void {
    const s = this.workingSlot(side)
    const ch = this.plug.zones[s.zone]?.channels[s.pos]
    if (!ch) return
    this.emit(channelBlock(side, ch, s.pos))
  }

  private zoneMemberGlobals(zone: number): number[] {
    let base = 0
    for (let z = 0; z < zone; z += 1) base += this.plug.zones[z]?.channels.length ?? 0
    const n = this.plug.zones[zone]?.channels.length ?? 0
    return Array.from({ length: n }, (_, i) => base + i)
  }

  private channelByGlobal(global: number): SimChannel | null {
    let i = global
    for (const z of this.plug.zones) {
      if (i < z.channels.length) return z.channels[i] ?? null
      i -= z.channels.length
    }
    return null
  }

  private emit(bytes: Uint8Array): void {
    if (this.closed) return
    this.handler(bytes)
  }

  /** Ground truth for quiescent-state comparison: what the session SHOULD believe. */
  groundTruth() {
    const side = (k: SideKey) => {
      const s = this.workingSlot(k)
      const ch = this.plug.zones[s.zone]?.channels[s.pos] ?? null
      return {
        zoneIndex: s.zone,
        zoneName: this.plug.zones[s.zone]?.name ?? '',
        position: s.pos,
        channelName: ch?.name ?? '',
        rxMHz: ch?.rxMHz ?? null,
      }
    }
    return {
      selectedSide: this.selectedSide,
      transmitting: this.transmitting,
      gateOpen: this.gateOpen(),
      rf: { a: { ...this.rf.a }, b: { ...this.rf.b } },
      sides: { a: side('a'), b: side('b') },
      scanning: this.scanning !== null,
    }
  }
}

// re-export for scenario convenience
export { sealed }
export type { SimChannel }
