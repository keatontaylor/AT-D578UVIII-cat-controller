// The reducer: DOMAIN EVENTS → RadioState (ARCHITECTURE: mutations happen in one place).
// Pure — `applyEvent(state, event)` returns a new state; everything else observes. An event is
// either an inbound decoded frame or the lifecycle of one of OUR writes (pending → acked/failed).
// Because one event is one reduction is one broadcast patch, the "a logical mutation must land in
// a single emission" invariant (the stale-flash class of bug) is structural, not conventional.
// The Session orchestrates (ARQ correlation, side-readiness, settle windows) and dispatches
// events; it never touches state directly.

import type { DecodedFrame } from '../codec/framing'
import {
  decodeChannel,
  decodeClock,
  decodeDmr,
  decodeDmrAlias,
  decodeFirmware,
  decodeIdentity,
  decodeLastCall,
  decodeScanListName,
  decodeSettingsBlock,
  decodeSmeter,
  decodeSelectedSide,
  decodeAudioGate,
  decodeZoneName,
  decodeZoneNumber,
} from '../codec/decode'
import { CHANNEL_SETTINGS_BY_KEY } from '../codec/channel-settings'
import { bytesToHexStr, hexStrToBytes, writeField } from '../codec/record'
import { toneLabel, type ToneType } from '../codec/tones'
import type { DmrActivity, Smeter } from '../codec/decode'
import { READ_HEAD } from '../codec/frame-table'
import type { PttPhase } from './ptt'
import { pickDmrSide } from './dmr-side'
import type { RadioState, Side, SideKey } from './state'

/** One pending/failed write overlay entry ({ desired, phase }). */
type PendingEntry = RadioState['pendingSettings'][string]

/** The lifecycle phase of one of our writes: optimistic overlay → confirmed / not confirmed. */
export type WritePhase = 'pending' | 'acked' | 'failed'

/** Everything that may mutate RadioState. `frame` covers all radio→host traffic; the rest are
 * the write lifecycles the Session correlates (ACK = gospel — `acked` applies optimistically). */
export type DomainEvent =
  | { kind: 'frame'; frame: DecodedFrame }
  | { kind: 'setting'; phase: WritePhase; name: string; desired: string | number }
  | { kind: 'channelSetting'; phase: WritePhase; side: SideKey; key: string; desired: string }
  | { kind: 'channelTone'; phase: WritePhase; side: SideKey; field: 'rx' | 'tx'; type: ToneType; value: number; desired: string }
  | { kind: 'channelFrequency'; phase: WritePhase; side: SideKey; field: 'rx' | 'tx'; mhz: number; desired: string }
  | { kind: 'sideSelect'; phase: WritePhase; side: SideKey }
  | { kind: 'ptt'; phase: PttPhase }
  | { kind: 'channelCount'; side: SideKey; count: number }
  | { kind: 'volume'; side: SideKey; level: number }
  | { kind: 'scan'; active: boolean; listName: string | null }
  | { kind: 'scanLock'; locked: boolean }
  | { kind: 'scanHold' }
  | { kind: 'scanRelock' }
  | { kind: 'scanResume' }
  | { kind: 'scanPause'; paused: boolean }
  | { kind: 'manualDial'; side: SideKey; dial: { target: number; callType: 'group' | 'private' } | null }
  | { kind: 'dmrNoLock' }
  | { kind: 'dmrCaller'; callerId: number; callsign: string | null; name: string | null; location: string | null }

/** A copy of `map` without `key` (immutably clear one pending overlay). */
function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _drop, ...rest } = map
  return rest
}

const BLOCK_BY_REG: Record<number, string> = { 0x05: '05', 0x06: '06', 0x09: '09' }

function patchSide(state: RadioState, side: SideKey, patch: Partial<Side>): RadioState {
  const next: Side = { ...state.sides[side], ...patch }
  const sides = side === 'a' ? { ...state.sides, a: next } : { ...state.sides, b: next }
  return { ...state, sides }
}

/** A channel block landing for the scanning (selected) side while the scan is PAUSED is the
 * pause-confirm read of the PARKED channel (the radio holds the last-scanned channel through a
 * pause) — record its name so the UI can say WHICH channel "Paused" is sitting on. Any other
 * channel read leaves the scan slice alone. */
function reconcilePausedChannel(state: RadioState, side: SideKey): RadioState {
  const scan = state.scan
  if (!scan.active || state.selectedSide !== side) return state
  const name = state.sides[side].channelName || null
  // LOCKED: this block is the lock-follow read landing — the side slice is now CURRENT; naming
  // lockedChannel is what releases the sweeping placeholder and the recorder's held announcement.
  if (scan.locked) {
    if (name === scan.lockedChannel) return state
    return { ...state, scan: { ...scan, lockedChannel: name } }
  }
  if (!scan.paused) return state
  if (name === scan.pausedChannel) return state
  return { ...state, scan: { ...scan, pausedChannel: name } }
}

function channelProjectionPatch(raw: Uint8Array): Pick<Side, 'channelRaw' | 'freqMHz' | 'txFreqMHz' | 'channelName' | 'channelPosition' | 'mode' | 'channel'> {
  const ch = decodeChannel(raw)
  return {
    channelRaw: bytesToHexStr(raw),
    freqMHz: ch.freqMHz,
    txFreqMHz: ch.txFreqMHz,
    channelName: ch.name,
    channelPosition: ch.position,
    mode: ch.mode,
    channel: ch.config,
  }
}

function channelRawPatch(state: RadioState, side: SideKey, mutate: (raw: Uint8Array) => Uint8Array): Partial<Side> {
  const rawHex = state.sides[side].channelRaw
  if (!rawHex) return {}
  try {
    return channelProjectionPatch(mutate(hexStrToBytes(rawHex)))
  } catch {
    // If the cached raw is malformed/too short for this write, do not leave stale echo-back context.
    return { channelRaw: null }
  }
}

function hasChannelProjection(patch: Partial<Side>): boolean {
  return Object.prototype.hasOwnProperty.call(patch, 'freqMHz')
}

function applyRawChannelSetting(raw: Uint8Array, key: string, desired: string): Uint8Array {
  const def = CHANNEL_SETTINGS_BY_KEY[key]
  const index = def?.options.indexOf(desired) ?? -1
  if (index < 0) throw new Error(`unknown channel setting value for raw update: ${key}=${desired}`)
  if (key === 'channelType') return writeField('channel', raw, 'chanType', index)
  if (key === 'dmrMode') {
    const direct = index === 1 ? 0 : 1
    const slot = index === 0 ? 0 : index === 2 ? 1 : index === 3 ? 2 : 0
    return writeField('channel', writeField('channel', raw, 'dmrDirect', direct), 'dmrModeSlot', slot)
  }
  return writeField('channel', raw, key, index)
}

function dcsRaw(value: number): number {
  return parseInt(String(value), 8)
}

function applyRawTone(raw: Uint8Array, field: 'rx' | 'tx', type: ToneType, value: number): Uint8Array {
  const toneTypeKey = field === 'rx' ? 'rxToneType' : 'txToneType'
  const ctcssKey = field === 'rx' ? 'rxCtcssIndex' : 'txCtcssIndex'
  const dcsKey = field === 'rx' ? 'rxDcs' : 'txDcs'
  const typeRaw = type === 'ctc' ? 1 : type === 'dcs' ? 2 : 0
  let out = writeField('channel', raw, toneTypeKey, typeRaw)
  out = writeField('channel', out, ctcssKey, type === 'ctc' ? value : 0)
  return writeField('channel', out, dcsKey, type === 'dcs' ? dcsRaw(value) : 0)
}

function applyRawFrequency(raw: Uint8Array, field: 'rx' | 'tx', mhz: number, rxMHz: number | null): Uint8Array {
  if (field === 'rx') return writeField('channel', raw, 'rxFreq', Math.round(mhz * 100000))
  if (rxMHz == null) throw new Error('cannot project TX frequency into raw channel record without RX frequency')
  const diff = Number((mhz - rxMHz).toFixed(5))
  const dir = diff > 0 ? 1 : diff < 0 ? 2 : 0
  let out = writeField('channel', raw, 'shiftDir', dir)
  if (dir !== 0) out = writeField('channel', out, 'txOffset', Math.round(Math.abs(diff) * 100000))
  return out
}

/** Resolve a decoded 5a smeter (selected/other-relative) to physical sides via selectedSide.
 * Shared by the async `5a` push and the `04 5a` startup/refresh read — one decode path. */
function applySmeter(state: RadioState, s: Smeter | null): RadioState {
  if (!s) return state
  const selA = state.selectedSide === 'a'
  // The 5a scan flag (byte 12) is the RADIO's truth about a running native scan — it covers scans
  // started on the radio's front panel and scans already running at connect (the startup 04 5a
  // read). Our own 57 48 ack flips scan.active optimistically; this reconciles: an ON transition
  // keeps whatever listName the ack recorded (null for a panel scan — the wire doesn't say), an
  // OFF transition resets the slice exactly like a stop ack. Corpus: the flag flips on the very
  // next push after the ack, so the two sources never fight.
  let scan = state.scan
  // While scanning, mirror the radio's PARK truth (byte-3 bit) — the session's hold/resume
  // state machine keys off it.
  if (s.scanning === scan.active && scan.active && scan.parked !== s.parked) {
    scan = { ...scan, parked: s.parked }
  }
  let scanStopped = false
  if (s.scanning !== scan.active) {
    scanStopped = !s.scanning
    scan = s.scanning
      ? { active: true, listName: scan.listName, locked: false, paused: false, pausedChannel: null, parked: s.parked, lockedChannel: null, lastLock: null }
      : { active: false, listName: null, locked: false, paused: false, pausedChannel: null, parked: false, lockedChannel: null, lastLock: null }
  }
  const aOpen = selA ? s.selectedOpen : s.otherOpen
  const bOpen = selA ? s.otherOpen : s.selectedOpen
  // The per-side open bits are AUDIO truth, not carrier presence — wire-proven 2026-07-14: a
  // DigiMon-off MUTED DMR call streams RSSI but its open bit stays 0 for the call's whole life,
  // so a muted call can never grab this latch. No decode-only filtering is needed here.
  // AUDIO HOLDER latch (ear+clip-proven 2026-07-13): the radio's mono audio path is a latch —
  // first side to open keeps the audio; when the holder releases while the other side is
  // receiving, audio transfers INSTANTLY; the released side reopening does NOT reclaim it. The
  // latch survives its own squelch close (tail audio) until the whole gate is down.
  let holder = state.signal.holder
  if (holder === null) {
    if (aOpen !== bOpen) holder = aOpen ? 'a' : 'b'
    // Both rise in one frame (unobserved on the wire): the selected side is the radio's default.
    else if (aOpen && bOpen) holder = state.selectedSide
    // 5b-only audio (no per-side bits — undecoded DMR): the radio's FOCUS field names the sole
    // active side when it points away from the selected side; focus==selected is ambiguous
    // (idle default) and stays unlatched for the downstream inference to handle.
    else if (state.audioGate && s.focusSide !== state.selectedSide) holder = s.focusSide
  } else {
    const holderOpen = holder === 'a' ? aOpen : bOpen
    const otherOpen = holder === 'a' ? bOpen : aOpen
    if (!holderOpen && otherOpen) holder = holder === 'a' ? 'b' : 'a'
  }
  // Whole gate down (no 5b audio, no squelch) → nothing is playing; the latch resets.
  if (!state.audioGate && !aOpen && !bOpen) holder = null
  // SCAN-HELD DMR call END: during a scan the radio suppresses BOTH the 5e stream and the
  // end-of-call 5c (see the 5c case — it dismisses the presentation early), so the ONLY signal a
  // scan-held DMR call has ended is its side's per-side bit going open→closed. Clear the
  // now-stale slice on that edge, or dmrRxOn would keep the smeter lit for a call that ended.
  // Scoped to a running scan: normal calls keep their 5c-driven hang display untouched.
  let dmr = state.dmr
  if (dmr && scan.active && dmr.side) {
    const dside = dmr.side
    const wasOpen = dside === 'a' ? state.signal.aOpen : state.signal.bOpen
    const nowOpen = dside === 'a' ? aOpen : bOpen
    if (wasOpen && !nowOpen) dmr = null
  }
  // Scan ENDING (radio truth — covers panel stops) mid-call: same cleanup as the stop-ack event —
  // an RX call on the scanning side belongs to a channel the radio just left and its teardown
  // never arrives (5c fired at scan start, 5e suppressed while scanning).
  if (dmr && scanStopped && dmr.direction === 'rx' && dmr.side === state.selectedSide) dmr = null
  // Audio-evidence latch, backup to the 59 LOCK: the call's side's OWN 5a open bit RISING while
  // the call is live — per-side audio truth (a muted call streams RSSI but never sets its bit,
  // cap 07-12T17-30-40). EDGE-triggered, never level: a DigiMon-off toggle MID-call tears the
  // presented slice down while the bit is still up from the audible phase, and the rebuilt muted
  // slice must not inherit that stale level as evidence (live bug 2026-07-14 15:08 — the call
  // came back with audioRouted true / presented false and rendered neither RX nor BUSY).
  if (dmr && !dmr.audioRouted && dmr.direction === 'rx' && dmr.side) {
    const was = dmr.side === 'a' ? state.signal.aOpen : state.signal.bOpen
    const now = dmr.side === 'a' ? aOpen : bOpen
    if (!was && now) dmr = { ...dmr, audioRouted: true }
  }
  return {
    ...state,
    signal: {
      aRssi: selA ? s.selectedRssi : s.otherRssi,
      bRssi: selA ? s.otherRssi : s.selectedRssi,
      aOpen,
      bOpen,
      holder,
      focus: s.focusSide,
    },
    // TX is side-agnostic (it happens on the selected side by definition) — no mapping needed.
    transmitting: s.transmitting,
    scan,
    ...(dmr !== state.dmr ? { dmr } : {}),
  }
}

/** Merge a decoded DMR activity into state. The radio streams 5e frames continuously during a call:
 * VOICE frames carry the caller identity (source/dest/cc/slot), but the interleaved non-voice
 * frames decode with those fields null. Replacing wholesale made the badge flap — the caller
 * appeared on a voice frame then blanked on the next non-voice one, falling back to the channel's
 * programmed contact. So we LATCH: keep the last-known identity fields and only overwrite them when
 * a newer frame actually carries them. `a === null` is the explicit end-of-call (5e status byte 0)
 * — that, and only that, clears the slice. (Alias rides a separate 58 push and is preserved too.) */

/** Does a 59 last-call record belong to the LIVE call? Group calls match on dest (the TG rides
 * both). PRIVATE calls need the caller field: wire-pinned 2026-07-14 (cap 16-30-21, parrot
 * private calls) — the record's dest slot holds the STALE last-group TG (5067498) while the
 * caller field carries the actual transmitting station (310997 = the call's other party, the
 * slice's src or dest). A dest-only guard silently rejected every private 59 → the call never
 * locked → NO MATCH on an audibly-playing call. */
function lastCallMatches(dmr: NonNullable<RadioState['dmr']>, last: { dest: number | null; callerId: number | null }): boolean {
  if (last.dest != null && last.dest === dmr.dest) return true
  if (last.callerId != null && (last.callerId === dmr.dest || last.callerId === dmr.source)) return true
  return false
}

/** The 5b AUDIO gate (async push and the 04 5b read share this): sets audioGate and resets the
 * holder latch on a full close. Deliberately NOT audio evidence for the DMR slice — the gate is
 * global mono and can belong to the other side; the 59 lock + own-bit cover every audible call. */
function applyAudioGate(state: RadioState, open: boolean): RadioState {
  // Gate fully closed (no audio, no squelch) → the audio-holder latch resets (see applySmeter).
  const clearHolder = !open && !state.signal.aOpen && !state.signal.bOpen && state.signal.holder !== null
  return { ...state, audioGate: open, signal: clearHolder ? { ...state.signal, holder: null } : state.signal }
}

function applyDmr(state: RadioState, a: DmrActivity | null, presented = false): RadioState {
  if (a === null) {
    if (state.dmr === null) return state
    // An UNLOCKED RX call dying leaves a REMNANT {dest, frames}: the muted 5e stream is sparse
    // and idles between transmissions, so without carrying the earned frames the NO MATCH info
    // flickers or never shows (see state.dmrRemnant). Locked calls never stash — 59 re-locks
    // their next transmission within a frame or two.
    const d = state.dmr
    const stash = !d.presented && d.direction === 'rx' && d.dest != null ? { dest: d.dest, noLock: d.noLock } : state.dmrRemnant
    return { ...state, dmr: null, ...(stash !== state.dmrRemnant ? { dmrRemnant: stash } : {}) }
  }
  const prev = state.dmr
  // DUAL-RECEIVE SCAN GUARD (live bug 2026-07-14): the DMR slice is a single top-level slice, but
  // when one side holds a PRESENTED call and the other side SCANS, two 5e sources feed it — the
  // live call, and the scan engine's SAMPLES of other channels. A sample is unpresented and
  // carries a DIFFERENT destination; without this guard it overwrites the presented call's dest,
  // so resolveDmrSide loses the call's side and the smeter/caller vanish until the call ends. An
  // unpresented frame whose non-null dest differs from a presented call's dest is a foreign
  // sample — ignore it entirely. (Same-call voice frames match dest; non-voice frames carry null
  // dest and latch as before; a genuinely new call re-presents via its own 58 after the 5e idle.)
  if (prev?.presented && !presented && a.dest != null && prev.dest != null && a.dest !== prev.dest) {
    return state
  }
  // Side is LATCHED at onset (first frame of the call) and held — 5e carries no side, and only one
  // DMR call decodes at a time, so first-wins by the open 5a (audio) bit is exact and stable. TX
  // keys on the selected side by definition.
  const side =
    prev?.side ??
    (a.direction === 'tx'
      ? state.selectedSide
      : pickDmrSide(
          a,
          state.sides.a.channel,
          state.sides.b.channel,
          state.selectedSide,
          state.signal.aOpen,
          state.signal.bOpen,
          state.manualDial.a?.target ?? null,
          state.manualDial.b?.target ?? null,
        ))
  // The verdict seeds from the REMNANT when the same dest reappears — a muted conversation's
  // next transmission shows its NO MATCH pill instantly instead of re-waiting the lock window.
  const noLock = prev ? prev.noLock : (state.dmrRemnant != null && state.dmrRemnant.dest === a.dest && state.dmrRemnant.noLock)
  const nowPresented = (prev?.presented ?? false) || presented
  return {
    ...state,
    // A LOCK clears the remnant: an audible call's transmissions must never seed-inherit an
    // amber flash from an earlier muted phase of the same TG (DigiMon flipped on mid-QSO).
    ...(nowPresented && state.dmrRemnant !== null ? { dmrRemnant: null } : {}),
    dmr: {
      direction: a.direction,
      // THE 59 LOCK: an RX call renders (tuple/caller) only once the radio's call-log write
      // arrives (the 0x59 push handler sets this) or the 04 5e READ says a call is live (the
      // mid-call-connect path — the radio's own call-state register). Async 5e alone NEVER
      // presents: a muted (DigiMon-off non-matching) call streams identical identity-bearing
      // frames — and 58s in some DigiMon states — for its whole life. Unlocked activity shows
      // as live RSSI + the amber NO MATCH pill/info (view.dmrBusy), never as a live call.
      presented: nowPresented,
      // AUDIBLE: the 59 lock (0x59 handler), the read (param), or the own-bit RISING edge
      // (applySmeter). Deliberately NO level check here — a slice rebuilt mid-carrier (DigiMon
      // toggled off during a call) must not inherit the stale open bit as audio evidence.
      audioRouted: (prev?.audioRouted ?? false) || presented,
      noLock,
      side,
      colorCode: a.colorCode ?? prev?.colorCode ?? null,
      slot: a.slot ?? prev?.slot ?? null,
      source: a.source ?? prev?.source ?? null,
      dest: a.dest ?? prev?.dest ?? null,
      private: a.private ?? prev?.private ?? null,
      // Alias + RadioID caller-id ride the 58 push (and its lookup) — carry them across 5e frames.
      alias: prev?.alias ?? null,
      callerId: prev?.callerId ?? null,
      callsign: prev?.callsign ?? null,
      name: prev?.name ?? null,
      location: prev?.location ?? null,
    },
  }
}

export function applyFrame(state: RadioState, frame: DecodedFrame): RadioState {
  switch (frame.head) {
    case 0x5a:
      return applySmeter(state, decodeSmeter(frame.bytes))
    case 0x5b:
      return applyAudioGate(state, decodeAudioGate(frame.bytes))
    case 0x5e:
      return applyDmr(state, decodeDmr(frame.bytes))
    case 0x58: {
      // CALL PRESENTATION (live-QSO-pinned 2026-07-13): the radio pushes 58 only for calls it
      // actually presents (the BT-01 popup) — scan samples and DigiMon-off traffic never get one
      // — and it always precedes the audio gate. It carries the talker id (the RadioID lookup
      // key, fed back via `dmrCaller`); the name field is the radio's DISPLAY line (usually the
      // destination's contact name, often stale), so it fills alias only as a fallback.
      if (state.dmr === null) return state
      const a = decodeDmrAlias(frame.bytes)
      if (!a) return state
      const alias = a.alias || state.dmr.alias
      const callerId = a.id ?? state.dmr.callerId
      // The 58 ENRICHES (talker id + display line) but does NOT lock: the radio pushes 58s for
      // DigiMon-off non-matching calls it mutes (wire-pinned 2026-07-14, cap 05-54-31: 58 on
      // every transmission, 5b never opened). The 59 call-log write is the lock (see 0x59).
      if (alias === state.dmr.alias && callerId === state.dmr.callerId) return state
      return { ...state, dmr: { ...state.dmr, alias, callerId } }
    }
    case 0x59: {
      // Raw last-call PUSH — the radio WRITING ITS CALL LOG, which it does ONLY for calls it
      // routes to audio: corpus-tallied 2026-07-14 across 7 captures, 59-push count tracks the
      // 5b-open count exactly (0↔0 in both muted captures — including the DigiMon state that
      // pushes 58s for muted calls — nonzero wherever audio flowed). So unlike the 58 popup,
      // this IS per-call audio truth, and it self-correlates: the record carries the dest.
      // Same layout as the 04 59 read shifted DOWN one byte; pad the front so one decoder
      // serves both. The caller-NAME field in the push form starts with a NUL (stale residue
      // follows) — only the ids are usable. Guarded on dest matching the live call.
      if (state.dmr === null || state.dmr.direction !== 'rx') return state
      const padded = new Uint8Array(frame.bytes.length + 1)
      padded.set(frame.bytes, 1)
      const last = decodeLastCall(padded)
      if (!last || !lastCallMatches(state.dmr, last)) return state
      const callerId = state.dmr.callerId ?? last.callerId
      if (state.dmr.presented && state.dmr.audioRouted && callerId === state.dmr.callerId) return state
      // Locking also clears any muted-phase remnant of this TG (see applyDmr's seed logic).
      return { ...state, dmr: { ...state.dmr, callerId, presented: true, audioRouted: true }, dmrRemnant: null }
    }
    case 0x5c: {
      // Hang-time teardown (`5c 07 01 …`). NORMALLY the authoritative end-of-call — it fires
      // ~1.2 s AFTER the audio gate closes, when the call's side has already gone quiet.
      //
      // BUT starting a scan makes the radio DISMISS the DMR PRESENTATION with a 5c while the call
      // is STILL LIVE (wire-pinned 2026-07-14 04:15:02: scan start → 5c, yet 5a shows the call's
      // side open and it keeps receiving; the 5e stream just stops for the scan). Clearing then
      // wiped the smeter/caller for a call that hadn't ended, and it never returned (no fresh
      // 5e/58 arrives during the scan). So honor the teardown only when the CALL'S SIDE has
      // actually gone quiet; while it's still open, keep the slice (the per-side 5a bit stays
      // live for a scan-held DMR call — memory: only the per-side bits stream during a scan).
      if (frame.bytes[1] !== 0x07 || state.dmr === null) return state
      // The call's side is the value latched at onset; if it's still open, this 5c is a scan
      // dismissal, not an end-of-call — keep the slice. Unknown side (never latched) → honor it.
      const side = state.dmr.side
      const sideStillOpen = side != null && (side === 'a' ? state.signal.aOpen : state.signal.bOpen)
      return sideStillOpen ? state : { ...state, dmr: null }
    }
    case READ_HEAD:
      return frame.reg === undefined ? state : applyRead(state, frame.reg, frame.bytes)
    default:
      return state
  }
}

/** A channel read landing a DIFFERENT identity on the side a live RX call is latched to → the
 * call belongs to the channel we just LEFT (zone/channel navigation — UI acks trigger the
 * re-read; panel nav is caught by the next read), and its teardown will never arrive: the 5e
 * stream died with the old channel (same latch class as the scan-stop bug, live 2026-07-15).
 * Scan-scoped OUT: the lock-follow read lands a new identity mid-call BY DESIGN (the scan paths
 * have their own cleanup). A missing prior identity (mid-call connect: the 04 5e seed lands
 * before the first channel read) is not a departure. */
function clearDepartedCall(next: RadioState, side: SideKey, prev: RadioState): RadioState {
  const d = next.dmr
  if (!d || d.direction !== 'rx' || d.side !== side || next.scan.active) return next
  const before = prev.sides[side]
  const after = next.sides[side]
  if (!before.channelName) return next
  if (before.channelName === after.channelName && before.freqMHz === after.freqMHz) return next
  return { ...next, dmr: null }
}

function applyRead(state: RadioState, reg: number, b: Uint8Array): RadioState {
  switch (reg) {
    case 0x02:
      return { ...state, firmware: decodeFirmware(b) }
    case 0x32:
      return { ...state, identity: decodeIdentity(b) }
    case 0x51: {
      const clock = decodeClock(b)
      return clock ? { ...state, clock } : state
    }
    // The raw record is stored ALONGSIDE its decoded projection in the same reduction — they can
    // never disagree (record-canonical model: raw is truth, decoded fields are views of it).
    case 0x2c: {
      return reconcilePausedChannel(clearDepartedCall(patchSide(state, 'a', channelProjectionPatch(b)), 'a', state), 'a')
    }
    case 0x2d: {
      return reconcilePausedChannel(clearDepartedCall(patchSide(state, 'b', channelProjectionPatch(b)), 'b', state), 'b')
    }
    case 0x29:
      return patchSide(state, 'a', { zoneName: decodeZoneName(b), zoneNumber: decodeZoneNumber(b) })
    case 0x2a:
      return patchSide(state, 'b', { zoneName: decodeZoneName(b), zoneNumber: decodeZoneNumber(b) })
    case 0x05: {
      // The 05 block also carries the radio's active side (@37) — the authoritative source for the
      // 5a active/inactive → a/b mapping. Keep the prior side if this frame is too short to decode.
      // A read-back that matches a pending side-select clears the pending flag (the switch landed).
      const withSettings = { ...state, settings: { ...state.settings, ...decodeSettingsBlock(b, '05') } }
      const side = decodeSelectedSide(b)
      if (!side) return withSettings
      return { ...withSettings, selectedSide: side, pendingSide: state.pendingSide === side ? null : state.pendingSide }
    }
    case 0x06:
    case 0x09: {
      const block = BLOCK_BY_REG[reg]!
      return { ...state, settings: { ...state.settings, ...decodeSettingsBlock(b, block) } }
    }
    // `04 1b` byte 36 = the codeplug's ZONE COUNT (BT-01 RE: it never walks zone names; this is
    // how it bounds/wraps zone navigation — matched the on-radio count live, 2026-07-02). Zones
    // are shared, so both sides get it; it's what stepZone's wrap arithmetic needs.
    case 0x1b: {
      const count = b.length > 36 ? b[36]! : 0
      if (count < 1 || count > 250) return state // sanity: an implausible count is not a count
      return {
        ...state,
        sides: {
          a: { ...state.sides.a, zoneCount: count },
          b: { ...state.sides.b, zoneCount: count },
        },
      }
    }
    // `04 4a` — the working channel's ASSIGNED scan-list record; while a scan runs it names the
    // list BEING SCANNED (a panel scan runs the channel's list). Only meaningful mid-scan, and
    // only fills a gap: a scan WE started already carries its list name from the ack path.
    case 0x4a: {
      if (!state.scan.active || state.scan.listName !== null) return state
      const name = decodeScanListName(b)
      return name ? { ...state, scan: { ...state.scan, listName: name } } : state
    }
    // `04 59` — the persisted last-call record. It enriches an ONGOING RX call at startup: when
    // we connect mid-call the 04 5e read carries direction/CC/slot/src/dest, but the talker id +
    // alias normally arrive only on later 58 pushes — 04 59 has them NOW. Guarded on the dest
    // matching the live call so a STALE record (from a previous call) can never paint this one;
    // and it never overwrites what a real 58 push already provided.
    case 0x59: {
      if (!state.dmr || state.dmr.direction !== 'rx') return state
      const last = decodeLastCall(b)
      if (!last || !lastCallMatches(state.dmr, last)) return state
      const callerId = state.dmr.callerId ?? last.callerId
      const alias = state.dmr.alias ?? (last.callerName || null)
      if (state.dmr.presented && callerId === state.dmr.callerId && alias === state.dmr.alias) return state
      return { ...state, dmr: { ...state.dmr, callerId, alias, presented: true }, dmrRemnant: null }
    }
    // `04 5a` / `04 5b` reads (startup enumeration + post-side-swap refresh) carry the same
    // payload as the async pushes, shifted by the `04` prefix — reuse the push decoders so the
    // initial squelch/RSSI state hydrates through the exact path the live stream uses.
    case 0x5a:
      return applySmeter(state, decodeSmeter(b.slice(1)))
    case 0x5b:
      return applyAudioGate(state, decodeAudioGate(b.slice(1)))
    case 0x5e:
      // The 04 5e READ is the radio's own current-call register — an active call here IS
      // presented (this is the mid-call-connect path; scan-sample ambiguity is async-only).
      return applyDmr(state, decodeDmr(b.slice(1)), true)
    default:
      return state
  }
}

export function reduceFrames(frames: Iterable<DecodedFrame>, initial: RadioState): RadioState {
  let state = initial
  for (const frame of frames) state = applyFrame(state, frame)
  return state
}

// ── write lifecycles (the device-shadow overlay) ────────────────────────────────
// pending → the desired value overlays the reported one (UI spinner); acked → the desired value
// becomes the reported value AND the overlay clears IN THE SAME REDUCTION (never two patches);
// failed → the overlay flips to failed and the reported value stays authoritative.

/** The side's pendingChannel with `key` set to a phase overlay, or cleared. */
function channelOverlay(state: RadioState, side: SideKey, key: string, entry: PendingEntry | null): Record<string, PendingEntry> {
  const pending = state.sides[side].pendingChannel
  return entry === null ? withoutKey(pending, key) : { ...pending, [key]: entry }
}

/** Build a Tone value for an acked tone write (mirrors the decode-side Tone shape). */
function toneValue(type: ToneType, value: number) {
  return type === 'ctc'
    ? { kind: 'ctcss' as const, display: toneLabel('ctc', value), ctcssIndex: value, dcsCode: null }
    : type === 'dcs'
      ? { kind: 'dcs' as const, display: toneLabel('dcs', value), ctcssIndex: null, dcsCode: value }
      : { kind: 'off' as const, display: 'Off', ctcssIndex: null, dcsCode: null }
}

/** THE state transition function: one event in, one new state out (or the SAME reference for a
 * no-op, which the Session uses to skip the broadcast). All mutation lives here. */
export function applyEvent(state: RadioState, event: DomainEvent): RadioState {
  switch (event.kind) {
    case 'frame':
      return applyFrame(state, event.frame)

    case 'setting': {
      const { name, desired, phase } = event
      if (phase === 'acked') {
        return {
          ...state,
          settings: { ...state.settings, [name]: desired },
          pendingSettings: withoutKey(state.pendingSettings, name),
        }
      }
      return { ...state, pendingSettings: { ...state.pendingSettings, [name]: { desired, phase } } }
    }

    case 'channelSetting': {
      const { side, key, desired, phase } = event
      if (phase !== 'acked') {
        return patchSide(state, side, { pendingChannel: channelOverlay(state, side, key, { desired, phase }) })
      }
      const rawPatch = channelRawPatch(state, side, (raw) => applyRawChannelSetting(raw, key, desired))
      return patchSide(state, side, {
        ...rawPatch,
        pendingChannel: channelOverlay(state, side, key, null),
      }) // optimistic; no re-read (ACK = gospel, anti-corruption write discipline)
    }

    case 'channelTone': {
      const { side, field, type, value, desired, phase } = event
      const key = field === 'rx' ? 'rxTone' : 'txTone'
      if (phase !== 'acked') {
        return patchSide(state, side, { pendingChannel: channelOverlay(state, side, key, { desired, phase }) })
      }
      const config = state.sides[side].channel
      const rawPatch = channelRawPatch(state, side, (raw) => applyRawTone(raw, field, type, value))
      return patchSide(state, side, {
        ...rawPatch,
        // No channel block read yet → still settle the overlay (no stuck spinner).
        ...(!hasChannelProjection(rawPatch) && config ? { channel: { ...config, [key]: toneValue(type, value) } } : {}),
        pendingChannel: channelOverlay(state, side, key, null),
      })
    }

    case 'channelFrequency': {
      const { side, field, mhz, desired, phase } = event
      const key = field === 'rx' ? 'rxFreq' : 'txFreq'
      if (phase !== 'acked') {
        return patchSide(state, side, { pendingChannel: channelOverlay(state, side, key, { desired, phase }) })
      }
      // An RX retune carries the repeater shift into the displayed TX (the radio keeps the offset).
      // When raw context exists, reprojecting that mutated raw record does the same atomically.
      const cur = state.sides[side]
      const shift = cur.txFreqMHz != null && cur.freqMHz != null ? cur.txFreqMHz - cur.freqMHz : null
      const rawPatch = channelRawPatch(state, side, (raw) => applyRawFrequency(raw, field, mhz, cur.freqMHz))
      return patchSide(state, side, {
        ...rawPatch,
        ...(!hasChannelProjection(rawPatch)
          ? field === 'rx'
            ? { freqMHz: mhz, ...(shift != null ? { txFreqMHz: Number((mhz + shift).toFixed(5)) } : {}) }
            : { txFreqMHz: mhz }
          : {}),
        pendingChannel: channelOverlay(state, side, key, null),
      })
    }

    case 'sideSelect': {
      const { side, phase } = event
      if (phase === 'pending') {
        return state.pendingSide === side ? state : { ...state, pendingSide: side }
      }
      if (phase === 'acked') return { ...state, selectedSide: side, pendingSide: null }
      return state.pendingSide === null ? state : { ...state, pendingSide: null } // failed: revert
    }

    case 'ptt':
      return state.ptt === event.phase ? state : { ...state, ptt: event.phase }

    case 'channelCount':
      return state.sides[event.side].channelCount === event.count
        ? state
        : patchSide(state, event.side, { channelCount: event.count })

    // ACKed volume write — no wire read-back exists, so the acked level IS the state.
    case 'volume':
      return state.sides[event.side].volume === event.level
        ? state
        : patchSide(state, event.side, { volume: event.level })

    case 'scan': {
      // Start/stop resets the lock + pause (a fresh scan hasn't locked or paused yet).
      // STOP mid-call: a live RX call on the SCANNING (selected) side belongs to a channel the
      // radio just left, and its teardown never arrives — the presentation was dismissed by the
      // scan-start 5c and the 5e stream is suppressed while scanning, so without this the tuple
      // and caller chips latch forever (live bug 2026-07-15). A call on the OTHER side is
      // independent of the scan and keeps its normal 5c-driven life.
      const dmr = !event.active && state.dmr?.direction === 'rx' && state.dmr.side === state.selectedSide ? null : state.dmr
      return { ...state, dmr, scan: { active: event.active, listName: event.listName, locked: false, paused: false, pausedChannel: null, parked: false, lockedChannel: null, lastLock: null } }
    }

    case 'scanLock': {
      if (state.scan.locked === event.locked) return state
      // Lock DROPPING → the channel it was on becomes history: remember it for the "Last: …"
      // chip (the lock-follow read put the real locked channel in the selected side's slice).
      let lastLock = state.scan.lastLock
      if (state.scan.locked && !event.locked) {
        const side = state.sides[state.selectedSide]
        if (side.channelName) lastLock = { name: side.channelName, freqMHz: side.freqMHz, at: Date.now() }
      }
      // a fresh lock is UNREAD until the lock-follow read names lockedChannel; a drop clears it
      return { ...state, scan: { ...state.scan, locked: event.locked, lockedChannel: null, lastLock } }
    }

    case 'scanHold':
      // Signal ended but the radio is still PARKED (dropout delay / other-side pause — the wire
      // never says which): the lock releases but the channel's values stay current and displayed
      // (still sitting on it); the view reads parked-not-receiving as WAITING.
      if (!state.scan.locked) return state
      return { ...state, scan: { ...state.scan, locked: false } }

    case 'scanRelock':
      // Re-key while still parked (dropout window or pause): the radio re-opens the SAME channel
      // without hopping — lockedChannel is KEPT (no placeholder flash); the session re-reads to
      // reconcile anyway.
      if (state.scan.locked) return state
      return { ...state, scan: { ...state.scan, locked: true } }

    case 'scanResume': {
      // The park lifted — the hop resumed. The channel it sat on becomes the "Last:" history.
      const scan = state.scan
      if (!scan.locked && scan.lockedChannel === null) return state
      let lastLock = scan.lastLock
      const side = state.sides[state.selectedSide]
      if (scan.lockedChannel && side.channelName) {
        lastLock = { name: side.channelName, freqMHz: side.freqMHz, at: Date.now() }
      }
      return { ...state, scan: { ...scan, locked: false, lockedChannel: null, lastLock } }
    }

    case 'scanPause':
      if (state.scan.paused === event.paused) return state
      // pause END clears the parked channel — the scan resumes hopping and no channel is current
      return { ...state, scan: { ...state.scan, paused: event.paused, pausedChannel: event.paused ? state.scan.pausedChannel : null } }

    case 'manualDial':
      return { ...state, manualDial: { ...state.manualDial, [event.side]: event.dial } }

    case 'dmrNoLock':
      // The session's 59 LOCK WINDOW expired (~2 s, wire-measured: an audible call's 59 lands
      // within ~0.5 s of its first 5e) with the slice still unlocked → the radio is NOT taking
      // this call. Guarded: a lock racing the timer wins.
      if (!state.dmr || state.dmr.direction !== 'rx' || state.dmr.presented || state.dmr.noLock) return state
      return { ...state, dmr: { ...state.dmr, noLock: true } }

    case 'dmrCaller':
      // Resolved RadioID caller-id for the CURRENT call only (guard on callerId so a late lookup
      // can't paint a call that already ended / moved on).
      if (!state.dmr || state.dmr.callerId !== event.callerId) return state
      return { ...state, dmr: { ...state.dmr, callsign: event.callsign, name: event.name, location: event.location } }
  }
}
