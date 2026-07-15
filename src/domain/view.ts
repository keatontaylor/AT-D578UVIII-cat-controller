// The VIEW MODEL — every rendering rule that turns RadioState into what the cards show. PURE
// functions shared by the UI (App.vue / VfoCard.vue import and call these) and the integration
// suite (which asserts on `vfoView` — the composed per-card render model). Keeping the derivations
// HERE, not in component computeds, means the tests exercise the exact code path the browser
// renders: there is no second copy of rendering logic to drift.

import { activeReceive, audioGateOpen } from './receive'
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
  // Side is LATCHED at call onset (reduce.ts pickDmrSide, first-wins) — 5e carries no side and only
  // one DMR call decodes at a time, so this is stable for the call's life; no live re-resolution.
  return d.side
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
 *  `releasing` unkey sent — the radio is STILL transmitting (ack outstanding, or acked with the
 *              radio's own TX indications still up: the post-unkey terminator drain) (yellow-on-red)
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
  // AUDIBLE DMR RX only: a decode-only (muted, DigiMon-off non-matching) call is decoded but not
  // routed to audio (audioRouted false) — it must not light the green RX / full meter. See
  // dmrBusy for its own indicator.
  return !!rs.dmr && rs.dmr.direction === 'rx' && rs.dmr.audioRouted && dmrSideFor(rs) === side
}
/** UNLOCKED decode on this side: an identity-bearing RX 5e stream with no 59 lock — outside a
 * scan that is a REAL decode (a muted DigiMon-off call, or the first beats of an audible call
 * whose 59 hasn't landed). The INFO (amber tuple + caller) renders immediately from this — it
 * claims nothing about audio — so a DigiMon-off toggle mid-call never blacks the card out while
 * the sparse muted stream crawls toward a threshold. Checks dmr.side directly (unlocked calls
 * never present, so dmrSideFor is null by design). Scan-scoped out: unlocked 5e streams during
 * a scan are the engine's SAMPLES and must not render. */
export function dmrUnlocked(rs: RadioState, side: SideKey): boolean {
  return !!rs.dmr && rs.dmr.direction === 'rx' && !rs.dmr.presented && !rs.scan.active && dmrLocked(rs) && rs.dmr.side === side
}
/** The NO MATCH verdict (amber pill): an unlocked decode that has outlived the 59 LOCK WINDOW
 * (the session's ~2 s timer → dmr.noLock; an audible call's 59 lands within ~0.5 s of its first
 * 5e) — the radio is NOT taking this call. Unlike the info, the pill CLAIMS the mismatch, so it
 * waits for the window (seeded by dmrRemnant across a muted conversation's transmissions: the
 * verdict is earned once, instant thereafter). */
export function dmrBusy(rs: RadioState, side: SideKey): boolean {
  return dmrUnlocked(rs, side) && !rs.dmr!.audioRouted && rs.dmr!.noLock
}
export function smeterFor(rs: RadioState, side: SideKey): number | null {
  if (txSide(rs, side)) return 0 // no RX meter while this side transmits
  // DMR channels: a LOCKED call reads full bars (digital = copy or nothing); otherwise show the
  // honest 5a RSSI — the radio streams it for muted decode-only traffic too (wire-pinned), so
  // the meter mirrors the radio's own RX LED even when no audio is passing.
  if (isDmrChannel(rs, side)) return dmrRxOn(rs, side) ? DMR_RX_LEVEL : side === 'a' ? rs.signal.aRssi : rs.signal.bRssi
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
    // a non-null lockedChannel IS current by construction (scanHold/relock keep it through the
    // WAITING hold — park bit OR pause; scanResume clears it) — show it regardless of which
    // hold evidence is up at this instant
    if (scan.locked || scan.lockedChannel !== null) {
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

/** TX identity context — the side's programmed channel + any manual-dial override. On TX the
 * radio's own 5e tuple is INERT (wire+relay-proven 2026-07-14: frozen at the LAST call, never
 * refreshes mid-key — a 9 s keyup showed one unchanging stale value), so the TX badge must be
 * built from what we actually key: the dial, else the channel contact, with the channel's CC/slot. */
export interface TxIdentity {
  readonly channel: ChannelConfig | null
  readonly dial: { target: number; callType: 'group' | 'private' } | null
}

/** Pulsating live-call badge — the call's parameters, PoC order: TS2 · CC10 · TG 5067498. A group
 * call shows its talkgroup (dest); a private call shows the peer's DMR id. On RX the 5e tuple is
 * the actual received call and is trusted; on TX it's inert (see TxIdentity), so the tuple is
 * derived from `tx` (dial → channel contact + programmed CC/slot) when provided. */
export function dmrLiveBadge(dmr: Dmr | null | undefined, tx?: TxIdentity): { direction: 'rx' | 'tx'; label: string } | null {
  if (!dmr) return null
  const parts: string[] = []
  // TX NEVER reads the 5e tuple — it's inert (frozen at the last call). Derive from the dial /
  // channel contact + programmed CC/slot; with nothing known, a bare "TX" (never a stale value).
  if (dmr.direction === 'tx') {
    const slot = tx?.channel?.timeSlot ?? null
    const cc = tx?.channel?.colorCode ?? null
    if (slot != null) parts.push(`TS${slot}`)
    if (cc != null) parts.push(`CC${cc}`)
    const isPrivate = tx?.dial ? tx.dial.callType === 'private' : tx?.channel?.contact?.callType === 'private'
    const target = tx?.dial?.target ?? tx?.channel?.contact?.talkgroup ?? null
    if (target != null) parts.push(`${isPrivate ? 'PRIV' : 'TG'} ${target}`)
    return { direction: 'tx', label: parts.join(' · ') || 'TX' }
  }
  // RX: the 5e tuple IS the received call — trustworthy.
  if (dmr.slot != null) parts.push(`TS${dmr.slot}`)
  if (dmr.colorCode != null) parts.push(`CC${dmr.colorCode}`)
  const isPrivate = dmr.private === true
  const value = isPrivate ? dmr.callerId ?? dmr.source : dmr.dest
  if (value != null) parts.push(`${isPrivate ? 'PRIV' : 'TG'} ${value}`)
  return { direction: 'rx', label: parts.join(' · ') || 'DMR' }
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
  const word = scan.locked ? 'LOCK' : scan.paused ? 'PAUSE' : 'SCAN'
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

/** True while the frequency/values are UNKNOWN: scan hopping; parked but no read has named the
 * stop yet (the lock-follow read after a lock, or the pause-confirm read during a pause); or
 * LOCKED but the lock-follow read hasn't landed (scan.locked flips at lock-confirm, ~1 read
 * round-trip BEFORE the channel data is current — rendering then would flash the previous
 * channel's values). Named channels mean a read put real data in the side slice — show it. */
export function scanSweeping(scan: Scan | null | undefined): boolean {
  if (!scan?.active) return false
  if (scan.locked || scan.parked || scan.paused) {
    // held with the lock read landed (post-signal hold) OR the pause read landed → current
    if (scan.lockedChannel !== null) return false
    return !(scan.paused && scan.pausedChannel !== null)
  }
  return true
}

/** The zone-line readout with its status tone. Mid-scan the zone is as unknown as the frequency,
 * so the line carries the scan status instead; VFO mode has no zone either (direct entry).
 * `receiving` = squelch open on this side, for classifying a park (see below).
 *
 * COLLAPSED (2026-07-13): the radio's park bit covers EVERY stop — lock, post-signal dropout
 * delay, other-side pause — and never says which. The old derived DWELL/PAUSED split guessed,
 * flapped between overs, and masked pauses behind a sticky dwell flag. Parked-not-receiving is
 * now ONE state: WAITING. The cause is visible elsewhere anyway (the other card's RX pill for a
 * pause; the just-shown lock data for a dropout). */
export type ScanTone = 'scanning' | 'acquiring' | 'locked' | 'waiting' | null
export function zoneReadout(zoneName: string, mode: ChannelMode, scan: Scan | null | undefined, receiving = false): { text: string; tone: ScanTone } {
  if (scan?.active) {
    const list = scan.listName ? ' · ' + scan.listName : ''
    // ACQUIRING: the radio has stopped (lock confirmed) but the lock-follow channel read hasn't
    // landed — we know THAT we landed, not WHERE. Distinct from LOCKED so the UI never implies
    // the displayed values are current before they are (same freshness rule as scanSweeping).
    if (scan.locked && scan.lockedChannel === null) return { text: `ACQUIRING${list}`, tone: 'acquiring' }
    if (scan.locked) return { text: `LOCKED${list}`, tone: 'locked' }
    // PARKED (5a byte-3 bit) OR PAUSED (other side receiving — the park bit is NOT reliable at
    // pause onset: wire 2026-07-13 22:32, other-side RX frames with the bit clear; the paused
    // flag is edge-driven from the other side's own 5a bit, no timers). Squelch open on this
    // side = ACQUIRING from the true stop moment (pre-lock confirm window + read RTT read as
    // one phase); squelch closed = WAITING — the radio is holding and resumes on its own.
    if (scan.parked || scan.paused) return receiving ? { text: `ACQUIRING${list}`, tone: 'acquiring' } : { text: `WAITING${list}`, tone: 'waiting' }
    return { text: `SCANNING${list}`, tone: 'scanning' }
  }
  if (mode === 'vfo') return { text: 'DIRECT FREQUENCY', tone: null }
  return { text: zoneName || '--', tone: null }
}

/** History chip while the scan is between locks (hopping OR paused — anything but locked): what
 * it last locked on (name · freq), or null. Age is the caller's to render — it ticks, and the
 * view model stays a pure function of state. */
export function scanLastLock(scan: Scan | null | undefined): { name: string; freqMHz: number | null; at: number } | null {
  // hidden while locked or while the lock's data is still on display (parked post-signal hold)
  return scan?.active && !scan.locked && scan.lockedChannel === null && scan.lastLock ? scan.lastLock : null
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
  /** A DMR call is decoded on this side but muted (DigiMon off, tuple mismatch) — show it as
   * "monitor · no audio", not a live RX. dmrLive still carries the tuple for display. */
  /** Unlocked decode on this side — the card renders the dmr info in AMBER (caller badge). */
  readonly dmrUnlocked: boolean
  /** The NO MATCH pill (verdict, threshold-gated). Implies dmrUnlocked. */
  readonly dmrBusy: boolean
  readonly dmrCaller: string | null
  readonly scanBadge: { label: string; locked: boolean; paused: boolean } | null
  /** Frequency/values are unknown (scan hopping): the card shows placeholders, not stale digits. */
  readonly sweeping: boolean
  readonly zoneReadout: { text: string; tone: ScanTone }
  readonly scanLastLock: { name: string; freqMHz: number | null; at: number } | null
}

/** Everything a VfoCard renders for `side`, derived exactly the way App.vue wires the props and
 * VfoCard computes its badges. This is what the integration suite asserts against. */
export function vfoView(rs: RadioState, side: SideKey, connected = true): VfoView {
  const unlocked = dmrUnlocked(rs, side)
  // The call info renders for a LOCKED call (green caller, audible) AND for any UNLOCKED decode
  // (amber caller) — an operator seeing someone interesting may want to flip DigiMon on.
  const dmr = dmrSideFor(rs) === side || unlocked ? rs.dmr : null
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
    dmrLive: dmrLiveBadge(dmr, { channel: s.channel, dial: rs.manualDial[side] }),
    dmrUnlocked: unlocked,
    dmrBusy: dmrBusy(rs, side),
    dmrCaller: dmrCallerBadge(dmr),
    scanBadge: scanBadge(scan),
    sweeping: scanSweeping(scan),
    zoneReadout: zoneReadout(s.zoneName, s.mode, scan, openFor(rs, side)),
    scanLastLock: scanLastLock(scan),
  }
}

// ── the lock-screen media surface (Media Session metadata) ──────────────────────
// Same render model as the cards (vfoView), composed into the two lines an OS media widget
// gives us. Lives HERE (not in the composable) so the integration suite exercises the exact
// strings the lock screen shows — and so it can never disagree with the cards.

/** One side as a compact lock-screen line: `A · BCSO SOUTH · 159.270`. Used for the idle title
 * and wherever the OTHER side appears — nothing was demoted into it, so it's just identity.
 * While the scan position is UNKNOWN (hopping, or a stop whose lock-follow read hasn't landed)
 * the zone-line scan status IS the line — `A · SCANNING · SHORT FAVORITES` / `ACQUIRING` /
 * `WAITING` — the same freshness rule (`sweeping`) that keeps the card from flashing the
 * previous channel's values as current. */
export function lockScreenSummary(rs: RadioState, side: SideKey): string {
  const v = vfoView(rs, side)
  const s = side.toUpperCase()
  if (v.scanBadge && v.sweeping) return `${s} · ${v.zoneReadout.text}`
  const freq = v.freqMHz != null ? ` · ${v.freqMHz.toFixed(3)}` : ''
  return `${s} · ${v.channelName || v.memoryDisplay}${freq}`
}

/** The two lock-screen lines. CAR RULE: many car head units show ONLY the title, so it must be
 * self-sufficient in every state — the identity of what you're hearing (the channel on analog,
 * the caller on DMR), always led by the owning side (`A ·`/`B ·`). The second line (iOS shows
 * it, cars don't) carries whatever the title demoted; when nothing was demoted it's the other
 * side. States, strongest first:
 *
 *  CALLER-ID: an identified PRESENTED RX DMR call (a muted decode-only call never presents, so
 *  it can never be named here) → `B · KF0WWS · Keaton · Parker, CO · TG 700` (first name only —
 *  full badge scrolls in a car) / artist = channel + tuple. No `RX ·` prefix: the caller format
 *  IS the receiving signal.
 *
 *  RX: while audio flows (the effective gate) and we're not transmitting, the RECEIVING side
 *  takes the title with an `RX ·` prefix — attributed by the recorder's first-RX-wins holder
 *  latch (activeReceive), so the lock screen, the cards, and the clip labels always agree who
 *  owns the audio, through overlaps and the tail. A presented-but-unidentified DMR call keeps
 *  the TG on the title (`RX · B · JOENX · TG 700`). Analog demotes the freq to the artist
 *  (`SHERIF RX · 159.270`). Scan info appears ONLY while the position is unknown (`RX · A ·
 *  ACQUIRING · list`); a locked stop with the read landed is a plain RX title whose artist says
 *  how it got there (`LOCKED · list`).
 *
 *  Idle: selected side as title, other side as artist. */
export function lockScreenLines(rs: RadioState): { title: string; artist: string } {
  const d = rs.dmr
  const callSide = d?.direction === 'rx' ? dmrSideFor(rs) : null
  const otherLine = (side: SideKey): string => lockScreenSummary(rs, side === 'a' ? 'b' : 'a')

  // CALLER-ID promotion — callsign · first-name · location · TG, side-led, parts as available.
  if (callSide && d && (d.callsign || d.name)) {
    const target = d.dest != null ? `${d.private ? 'PRIV' : 'TG'} ${d.dest}` : null
    const title = [callSide.toUpperCase(), d.callsign, d.name?.trim().split(/\s+/)[0], d.location, target]
      .filter(Boolean).join(' · ')
    const v = vfoView(rs, callSide)
    const artist = [v.channelName || v.memoryDisplay, `TS${d.slot} CC${d.colorCode}`].filter(Boolean).join(' · ')
    return { title, artist }
  }

  const open = audioGateOpen(rs)
  if (open && !isTransmitting(rs)) {
    const rx = activeReceive(rs, open).side
    const v = vfoView(rs, rx)
    const s = rx.toUpperCase()
    // scan position unknown → the status is the whole story (SCANNING/ACQUIRING/WAITING · list)
    if (v.scanBadge && v.sweeping) return { title: `RX · ${s} · ${v.zoneReadout.text}`, artist: otherLine(rx) }
    const name = v.channelName || v.memoryDisplay
    // presented DMR call with no DB identity: keep the live TG on the title
    if (callSide === rx && d && d.dest != null) {
      const title = `RX · ${s} · ${name} · ${d.private ? 'PRIV' : 'TG'} ${d.dest}`
      const artist = [v.zoneName || null, `TS${d.slot} CC${d.colorCode}`].filter(Boolean).join(' · ')
      return { title, artist: artist || otherLine(rx) }
    }
    // analog (or no decoded call): the channel name IS the identity; freq demotes to the artist.
    // A locked scan stop reads as a plain RX — the artist says the scanner is holding it.
    const freq = v.freqMHz != null ? v.freqMHz.toFixed(3) : null
    const title = `RX · ${s} · ${name || freq || '—'}`
    const artist = v.scanBadge
      ? v.zoneReadout.text // LOCKED · list (or ACQUIRING/WAITING per the zone line's honesty)
      : [v.zoneName || null, freq].filter(Boolean).join(' · ')
    return { title, artist: artist || otherLine(rx) }
  }

  const sel = rs.selectedSide
  return { title: lockScreenSummary(rs, sel), artist: otherLine(sel) }
}
