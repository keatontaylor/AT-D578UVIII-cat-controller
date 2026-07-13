// The VIEW MODEL — every rendering rule that turns RadioState into what the cards show. PURE
// functions shared by the UI (App.vue / VfoCard.vue import and call these) and the integration
// suite (which asserts on `vfoView` — the composed per-card render model). Keeping the derivations
// HERE, not in component computeds, means the tests exercise the exact code path the browser
// renders: there is no second copy of rendering logic to drift.

import { resolveDmrSide } from './dmr-side'
import { audioGateOpen } from './receive'
import type { RadioState, Scan, SideKey } from './state'

type Dmr = NonNullable<RadioState['dmr']>
type ChannelConfig = NonNullable<RadioState['sides']['a']['channel']>
type Contact = NonNullable<ChannelConfig['contact']>
type ChannelMode = RadioState['sides']['a']['mode']

// ── call/side attribution ───────────────────────────────────────────────────────

/** A DMR call is "LOCKED" once the discriminating tuple — time slot + color code + destination
 * (TG / private id) — has decoded. Only a voice frame carries these; the early frames of a call
 * have them null. NOTHING DMR-related (meter, RX icon, TS/CC/TG badge, caller-id) shows until the
 * lock, because before it `resolveDmrSide` can't attribute the call and would flash it on the
 * wrong side. */
export function dmrLocked(rs: RadioState): boolean {
  const d = rs.dmr
  return !!d && d.colorCode != null && d.slot != null && d.dest != null
}

/** Which side a locked DMR call belongs to — matched by CC/slot/TG (the 5e stream has no side
 * field), so the info lands on the DMR channel even when the OTHER (e.g. analog) side is selected.
 * TX is on the selected side by definition; RX is resolved from the tuple. Null until locked.
 *
 * PRESENTATION GATE (live-QSO-pinned 2026-07-13, superseding the 2026-07-11 audibility gate):
 * the radio pushes 58/59 ONLY for calls it actually presents — the BT-01 popup, always carrying
 * the caller id — and never for scan-engine 5e samples or DigiMon-off traffic. An RX call
 * renders only once PRESENTED (58/59 push, or the 04 5e call-state read at mid-call connect).
 * This is strictly stronger than the old audio-gate corroboration: it can't be spoofed by an
 * unrelated analog carrier holding the gate open, and the caller id exists at the popup moment. */
export function dmrSideFor(rs: RadioState): SideKey | null {
  const d = rs.dmr
  if (!d || !dmrLocked(rs)) return null
  if (d.direction === 'tx') return rs.selectedSide
  if (!d.presented) return null
  return resolveDmrSide(d, rs.sides.a.channel, rs.sides.b.channel, rs.selectedSide)
}

/** CONFIRMED transmission only (UI_PROTOCOL §6): an ACKED key holds through the transmission
 * (we're the exclusive controller; the radio's 5a byte7 only blips and stops streaming on DMR),
 * `unkeying` still counts — the radio keeps transmitting until the release ack — and the 5a
 * flag + a DMR TX call cover radio-initiated keys. `keying` is deliberately ABSENT: a key-down
 * without its ack is unconfirmed intent, and the UI must never claim TX before the radio
 * acknowledges. */
export function isTransmitting(rs: RadioState): boolean {
  return rs.ptt === 'keyed' || rs.ptt === 'unkeying' || rs.transmitting || (!!rs.dmr && rs.dmr.direction === 'tx')
}
/** TX indicator for a card — TX happens on the selected side by definition. */
export function txSide(rs: RadioState, side: SideKey): boolean {
  return isTransmitting(rs) && rs.selectedSide === side
}

/** The card's PTT truth-state (UI_PROTOCOL §6 color contract):
 *  `pending`   key-down sent, radio has NOT acked — unconfirmed intent (yellow, never red)
 *  `confirmed` the radio acknowledged the key / reports TX itself (red)
 *  `releasing` unkey sent, ack outstanding — the radio is STILL transmitting (yellow-on-red)
 *  `fault`     release retries exhausted — possibly still transmitting (flashing red) */
export type TxState = 'pending' | 'confirmed' | 'releasing' | 'fault' | null
export function txStateFor(rs: RadioState, side: SideKey): TxState {
  if (rs.selectedSide !== side) return null
  if (rs.ptt === 'fault') return 'fault'
  if (rs.ptt === 'keying') return 'pending'
  if (rs.ptt === 'unkeying') return 'releasing'
  return isTransmitting(rs) ? 'confirmed' : null
}

/** S-meter + RX icon follow the SAME DMR-side rules as the caller badge. The 5a open-mask is the
 * TIMESLOT (not the A/B side) on DMR, so for a DMR channel both are driven from the resolved call
 * side instead of the raw 5a mapping: the receiving DMR side reads solid (digital = copy or
 * nothing), the other reads nothing. Analog sides keep the honest per-side 5a values. */
export const DMR_RX_LEVEL = 4 // full bars — DMR has no gradation, it's decoded or it isn't

export function isDmrChannel(rs: RadioState, side: SideKey): boolean {
  const cfg = rs.sides[side].channel
  return !!cfg && cfg.type !== 'analog'
}
export function dmrRxOn(rs: RadioState, side: SideKey): boolean {
  return !!rs.dmr && rs.dmr.direction === 'rx' && dmrSideFor(rs) === side
}
export function smeterFor(rs: RadioState, side: SideKey): number | null {
  if (txSide(rs, side)) return 0 // no RX meter while this side transmits
  if (isDmrChannel(rs, side)) return dmrRxOn(rs, side) ? DMR_RX_LEVEL : 0
  return side === 'a' ? rs.signal.aRssi : rs.signal.bRssi
}
export function openFor(rs: RadioState, side: SideKey): boolean {
  if (isDmrChannel(rs, side)) return dmrRxOn(rs, side)
  return side === 'a' ? rs.signal.aOpen : rs.signal.bOpen
}

/** Sub receiver off (single-receive): the non-selected side is dormant — greyed, controls
 * disabled, but still selectable. Only meaningful once the setting has actually been read
 * (absent → treat as dual-watch on). */
export function singleReceive(rs: RadioState): boolean {
  return rs.settings['sub_channel'] === 'off'
}
export function inactiveSide(rs: RadioState, side: SideKey): boolean {
  return singleReceive(rs) && rs.selectedSide !== side
}

/** Whether clicking a card may switch to it: connected, not already selected/pending, and NOT
 * during a scan — the radio locks side-switching while it scans (only one side scans). */
export function sideSelectable(rs: RadioState, side: SideKey, connected: boolean): boolean {
  return connected && rs.selectedSide !== side && rs.pendingSide !== side && !rs.scan.active
}

// ── display strings (VfoCard badges/readouts) ───────────────────────────────────

export const TYPE_LABEL: Record<string, string> = { analog: 'FM', digital: 'DMR', 'a+d-tx-a': 'A+D', 'd+a-tx-d': 'D+A' }
export function typeLabel(config: ChannelConfig | null): string {
  return config ? TYPE_LABEL[config.type] ?? String(config.type) : '--'
}
export function vfoMemLabel(mode: ChannelMode): string {
  return mode === 'vfo' ? 'VFO' : mode === 'memory' ? 'MEM' : '--'
}

/** Header memory-state readout. Mid-scan it reads "Scanning…" until something REAL replaces it:
 * a LOCK (read-back channel takes over) or a confirmed pause (the parked channel's bare name —
 * the "paused" status itself is the zone line's job). Never a placeholder: an unconfirmed pause
 * stays "Scanning…" until the pause-confirm read names the parked channel. */
export function memoryDisplay(mode: ChannelMode, channelName: string, scan: Scan | null): string {
  if (scan?.active) {
    if (scan.locked || scan.dwell) {
      if (scan.lockedChannel === null) return 'Scanning…' // read-back not landed — no stale name
    } else {
      return scan.paused && scan.pausedChannel ? scan.pausedChannel : 'Scanning…'
    }
  }
  return mode === 'memory' ? channelName || '--' : mode === 'vfo' ? 'VFO' : '--'
}

/** The codeplug DMR contact glance shows the TALKGROUP ID (with its call-type prefix), not the
 * contact name — the ID is the operationally useful value (TG 43114 / Priv 310997 / All). */
export function contactDisplay(contact: Contact | null | undefined): string {
  if (!contact) return ''
  const prefix = contact.callType === 'private' ? 'Priv' : contact.callType === 'all' ? 'All' : 'TG'
  if (contact.talkgroup != null) return `${prefix} ${contact.talkgroup}`
  return contact.name || (contact.callType ? contact.callType.toUpperCase() : '--')
}

/** Pulsating live-call badge — the call's parameters, PoC order: TS2 · CC10 · TG 5067498. A group
 * call shows its talkgroup (dest); a private call shows the peer's DMR id. */
export function dmrLiveBadge(dmr: Dmr | null | undefined): { direction: 'rx' | 'tx'; label: string } | null {
  if (!dmr) return null
  const parts: string[] = []
  if (dmr.slot != null) parts.push(`TS${dmr.slot}`)
  if (dmr.colorCode != null) parts.push(`CC${dmr.colorCode}`)
  const isPrivate = dmr.private === true
  const value = isPrivate ? dmr.callerId ?? dmr.source : dmr.dest
  if (value != null) parts.push(`${isPrivate ? 'PRIV' : 'TG'} ${value}`)
  const label = parts.join(' · ')
  return { direction: dmr.direction, label: label || (dmr.direction === 'tx' ? 'TX' : 'DMR') }
}

/** RadioID.net caller-id line (callsign · name · location) — only once the talker id resolved to
 * a real operator (a talkgroup id has no callsign). */
export function dmrCallerBadge(dmr: Dmr | null | undefined): string | null {
  if (!dmr || !dmr.callsign) return null
  return [dmr.callsign, dmr.name, dmr.location].filter(Boolean).join(' · ')
}

/** Scan badge: LOCK / PAUSE / SCAN (+ the list name), or null when no scan runs. */
export function scanBadge(scan: Scan | null | undefined): { label: string; locked: boolean; paused: boolean } | null {
  if (!scan?.active) return null
  const word = scan.locked ? 'LOCK' : scan.dwell ? 'DWELL' : scan.paused ? 'PAUSE' : 'SCAN'
  return {
    label: `${word}${scan.listName ? ' · ' + scan.listName : ''}`,
    locked: scan.locked,
    paused: scan.paused && !scan.locked,
  }
}

/** The card's corner indicator: TX wins over RX (a transmitting side shows TX, never both). */
export function rxTxIndicator(transmitting: boolean, open: boolean): 'TX' | 'RX' | null {
  return transmitting ? 'TX' : open ? 'RX' : null
}

// ── scan-time display honesty ────────────────────────────────────────────────
// The wire only says where a scan STOPS, never where it IS: the radio hops silently and pushes
// nothing per-hop. So mid-scan the card must not present the pre-scan channel values as current.
// Two honest states: SWEEPING (position unknown → placeholder frequency, scan status in the zone
// line) and LOCKED (lock-follow read the real channel → full values, same as today).

/** True while the frequency/values are UNKNOWN: scan hopping; paused but the parked-channel
 * read hasn't landed; or LOCKED but the lock-follow read hasn't landed (scan.locked flips at
 * lock-confirm, ~1 read round-trip BEFORE the channel data is current — rendering then would
 * flash the previous channel's values). Named channels mean the read put real data in the side
 * slice — show it. */
export function scanSweeping(scan: Scan | null | undefined): boolean {
  if (!scan?.active) return false
  // locked or DWELLING (parked post-signal): the read-back channel is where the radio still sits
  if (scan.locked || scan.dwell) return scan.lockedChannel === null
  return !(scan.paused && scan.pausedChannel !== null)
}

/** The zone-line readout with its status tone. Mid-scan the zone is as unknown as the frequency,
 * so the line carries the scan status instead; VFO mode has no zone either (direct entry). */
export function zoneReadout(
  zoneName: string,
  mode: ChannelMode,
  scan: Scan | null | undefined,
): { text: string; tone: 'scanning' | 'locked' | 'dwell' | 'paused' | null } {
  if (scan?.active) {
    if (scan.locked) return { text: `LOCKED${scan.listName ? ' · ' + scan.listName : ''}`, tone: 'locked' }
    // DWELL: signal ended, the radio is waiting out the dropout delay on this channel
    if (scan.dwell) return { text: `DWELL${scan.listName ? ' · ' + scan.listName : ''}`, tone: 'dwell' }
    if (scan.paused) return { text: `PAUSED${scan.listName ? ' · ' + scan.listName : ''}`, tone: 'paused' }
    return { text: `SCANNING${scan.listName ? ' · ' + scan.listName : ''}`, tone: 'scanning' }
  }
  if (mode === 'vfo') return { text: 'DIRECT FREQUENCY', tone: null }
  return { text: zoneName || '--', tone: null }
}

/** History chip while the scan is between locks (hopping OR paused — anything but locked): what
 * it last locked on (name · freq), or null. Age is the caller's to render — it ticks, and the
 * view model stays a pure function of state. */
export function scanLastLock(scan: Scan | null | undefined): { name: string; freqMHz: number | null; at: number } | null {
  // hidden during lock AND dwell — the channel it refers to is still the one on display
  return scan?.active && !scan.locked && !scan.dwell && scan.lastLock ? scan.lastLock : null
}

// ── the composed per-card render model — the integration suite's single entry point ──

export interface VfoView {
  readonly side: SideKey
  readonly selected: boolean
  readonly pendingSelect: boolean
  readonly selectable: boolean
  readonly inactive: boolean
  readonly channelName: string
  readonly zoneName: string
  readonly freqMHz: number | null
  readonly txFreqMHz: number | null
  readonly typeLabel: string
  readonly vfoMemLabel: string
  readonly memoryDisplay: string
  readonly contactDisplay: string
  readonly smeter: number | null
  readonly indicator: 'TX' | 'RX' | null
  /** PTT truth-state for the pill (UI_PROTOCOL §6) — `indicator` says TX only when confirmed;
   * this adds the unconfirmed/releasing/fault renderings. */
  readonly txState: TxState
  /** The DMR call as this card shows it (null unless the locked call resolved to this side). */
  readonly dmr: Dmr | null
  readonly dmrLive: { direction: 'rx' | 'tx'; label: string } | null
  readonly dmrCaller: string | null
  readonly scanBadge: { label: string; locked: boolean; paused: boolean } | null
  /** Frequency/values are unknown (scan hopping): the card shows placeholders, not stale digits. */
  readonly sweeping: boolean
  readonly zoneReadout: { text: string; tone: 'scanning' | 'locked' | 'dwell' | 'paused' | null }
  readonly scanLastLock: { name: string; freqMHz: number | null; at: number } | null
}

/** Everything a VfoCard renders for `side`, derived exactly the way App.vue wires the props and
 * VfoCard computes its badges. This is what the integration suite asserts against. */
export function vfoView(rs: RadioState, side: SideKey, connected = true): VfoView {
  const dmr = dmrSideFor(rs) === side ? rs.dmr : null
  const scan = rs.selectedSide === side ? rs.scan : null
  const s = rs.sides[side]
  return {
    side,
    selected: rs.selectedSide === side,
    pendingSelect: rs.pendingSide === side,
    selectable: sideSelectable(rs, side, connected),
    inactive: inactiveSide(rs, side),
    channelName: s.channelName,
    zoneName: s.zoneName,
    freqMHz: s.freqMHz,
    txFreqMHz: s.txFreqMHz,
    typeLabel: typeLabel(s.channel),
    vfoMemLabel: vfoMemLabel(s.mode),
    memoryDisplay: memoryDisplay(s.mode, s.channelName, scan),
    contactDisplay: contactDisplay(s.channel?.contact),
    smeter: smeterFor(rs, side),
    indicator: rxTxIndicator(txSide(rs, side), openFor(rs, side)),
    txState: txStateFor(rs, side),
    dmr,
    dmrLive: dmrLiveBadge(dmr),
    dmrCaller: dmrCallerBadge(dmr),
    scanBadge: scanBadge(scan),
    sweeping: scanSweeping(scan),
    zoneReadout: zoneReadout(s.zoneName, s.mode, scan),
    scanLastLock: scanLastLock(scan),
  }
}
