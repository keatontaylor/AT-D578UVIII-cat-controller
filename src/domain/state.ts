// The one authoritative RadioState (ARCHITECTURE: single state object). Defined as a Zod
// schema so the schema is the single source of truth (NF7) — the domain type, the api
// validation, and the ui client type all derive from `RadioState`. This first slice covers
// the connect→enumerate snapshot; live signal/DMR/scan fields are added in later slices.

import { z } from 'zod'
import { PTT_PHASES } from './ptt'

export const Tone = z.object({
  kind: z.enum(['off', 'ctcss', 'dcs']),
  display: z.string(),
  ctcssIndex: z.number().nullable(),
  dcsCode: z.number().nullable(),
})

// Device-shadow overlay (UI_PROTOCOL): a setting write in flight. `desired` is the optimistic
// value; the reported value stays authoritative until the write is confirmed. Shared by the global
// menu settings (`pendingSettings`) and per-side channel settings (`Side.pendingChannel`).
export const PendingSetting = z.object({
  desired: z.union([z.string(), z.number()]),
  phase: z.enum(['pending', 'failed']),
})

/** The working channel's live configuration (decoded from the channel block). */
export const ChannelConfig = z.object({
  type: z.enum(['analog', 'digital', 'a+d-tx-a', 'd+a-tx-d']),
  power: z.enum(['low', 'mid', 'high', 'turbo']),
  bandwidthKHz: z.number(),
  reverse: z.boolean(),
  txProhibit: z.boolean(),
  talkaround: z.boolean(),
  rxTone: Tone.nullable(),
  txTone: Tone.nullable(),
  squelchMode: z.enum(['sq', 'cdt', 'tone', 'c&t', 'c|t']).nullable(),
  optionalSignal: z.enum(['off', 'dtmf', '2tone', '5tone']).nullable(),
  compander: z.boolean().nullable(),
  scrambler: z.number().nullable(),
  busyLock: z.enum(['off', 'cdt', 'free']).nullable(),
  colorCode: z.number().nullable(),
  timeSlot: z.number().nullable(),
  txInterrupt: z.enum(['off', 'low', 'high']).nullable(),
  aprsReceive: z.boolean().nullable(),
  smsForbid: z.boolean().nullable(),
  dataAckForbid: z.boolean().nullable(),
  dmrMode: z.enum(['simplex', 'repeater', 'double-slot', 'double-slot-d']).nullable(),
  contact: z
    .object({ callType: z.enum(['group', 'private', 'all']), talkgroup: z.number().nullable(), name: z.string() })
    .nullable(),
})

export const SideState = z.object({
  freqMHz: z.number().nullable(),
  /** TX frequency (RX + repeater shift); equals freqMHz on a simplex channel. */
  txFreqMHz: z.number().nullable(),
  channelName: z.string(),
  /** Absolute in-zone channel index — the channel-step/select target. */
  channelPosition: z.number().nullable(),
  zoneName: z.string(),
  /** 0-based zone index — the zone-step/select target. */
  zoneNumber: z.number().nullable(),
  /** Total zones for host-side wrap/bounds, from `04 1b` byte 36 (the BT-01's own source —
   * it never walks zone names). Null until the enumeration read lands. */
  zoneCount: z.number().int().positive().nullable(),
  /** Channels in this side's CURRENT zone — the count of members in the `04 27 <zone>` list
   * (live-verified: FAVORITES=15, HOTSPOT=7). Drives channel-step host-side wrap + display.
   * Refreshed on connect and on each zone change; null until the first 04 27 read lands. */
  channelCount: z.number().int().positive().nullable(),
  /** VFO vs memory mode for this side (decoded from the channel block). */
  mode: z.enum(['vfo', 'memory']).nullable(),
  /** The RAW working-channel record (hex of the last `04 2c/2d` frame) — CANONICAL for
   * context writes: the decoded fields above are projections of it, and record mutations splice
   * known offsets into these bytes so unmapped offsets are never disturbed (record-canonical
   * model; see data/record-maps.json + src/codec/record.ts). Null until the first channel read. */
  channelRaw: z.string().nullable(),
  /** The working channel's config (type/power/bandwidth/flags); null until the full record reads. */
  channel: ChannelConfig.nullable(),
  /** In-flight per-channel setting writes (2f) for this side, keyed by channel-setting key —
   * the pending/failed overlay while the radio confirms (mirrors `pendingSettings`). */
  pendingChannel: z.record(z.string(), PendingSetting),
  /** Per-side volume (the physical knob level, `08 4a`). Write-only on the wire — no read/decode
   * is known — so this holds the last level WE set; null until the first host-side adjustment. */
  volume: z.number().int().nullable(),
})
export type Side = z.infer<typeof SideState>

export const ClockState = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  second: z.number().int().min(0).max(59),
  year: z.number().int().nullable(),
  month: z.number().int().nullable(),
  day: z.number().int().nullable(),
})

export const IdentityState = z.object({
  dmrId: z.number().int().nonnegative(),
  callsign: z.string(),
})

// Live per-side signal, resolved to the physical sides: the 5a frame reports active/inactive RSSI
// (0-4, the radio's 4-bar meter) + a per-side squelch-open mask RELATIVE to the radio's selected
// side, and the reducer maps both to a/b via `selectedSide`. aOpen/bOpen are the per-side "RX"
// indicator (squelch open / audio passing); the global 5b `squelchOpen` is their OR.
export const SignalState = z.object({
  aRssi: z.number().int().min(0),
  bRssi: z.number().int().min(0),
  /** Squelch open (receiving) on side A — the per-side RX indicator. */
  aOpen: z.boolean(),
  /** Squelch open (receiving) on side B. */
  bOpen: z.boolean(),
})

// Live DMR call activity, decoded from the 5e link-state push (+ 58 alias). Single top-level slice
// (not per-side) — the radio decodes DMR on its selected side and 5e carries no side. Null when no
// call is in progress.
export const DmrState = z.object({
  direction: z.enum(['rx', 'tx']),
  colorCode: z.number().nullable(),
  slot: z.number().nullable(),
  /** Caller/source DMR id. */
  source: z.number().nullable(),
  /** Talkgroup (group call) or target unit (private). */
  dest: z.number().nullable(),
  /** Group (false) vs private (true) call; null until a voice frame resolves it. */
  private: z.boolean().nullable(),
  /** Caller alias from the 58 talker push (radio's contact-list lookup), when known. */
  alias: z.string().nullable(),
  /** The talker's DMR id (58 push) — the key for the RadioID caller-id lookup. */
  callerId: z.number().nullable(),
  /** RadioID.net caller-id (resolved server-side from callerId): a real operator has a callsign,
   * a talkgroup does not. */
  callsign: z.string().nullable(),
  name: z.string().nullable(),
  location: z.string().nullable(),
})
export type Dmr = z.infer<typeof DmrState>

// Native scan status. `active` flips on the 57 48 ack; the locked channel shows through the normal
// channel block (the radio pushes the new channel record when scan locks) — no extra field needed.
export const ScanState = z.object({
  active: z.boolean(),
  /** Name of the scan list being scanned, when known. */
  listName: z.string().nullable(),
  /** The scan has LOCKED onto a busy channel (squelch held open ≥ the confirm window, and we read
   * the channel back) — the displayed channel is now the real locked one, not a mid-hop stale. */
  locked: z.boolean(),
  /** The radio has PAUSED the scan because the OTHER (non-scanning) side is receiving — only one
   * side scans at a time, so its traffic holds the scan until it clears. */
  paused: z.boolean(),
  /** The channel the paused scan is PARKED on (the radio holds the last-scanned channel during a
   * pause). Filled by the pause-confirm live-register read; null until that read lands — the
   * pre-scan channel name is stale while hopping and must not be presented as the parked one. */
  pausedChannel: z.string().nullable(),
  /** The channel the scan most recently locked on, captured when the lock DROPS (the scan resumed
   * hopping). Explicit history — the card shows it as "Last: …" while sweeping instead of letting
   * stale channel values impersonate the present. Cleared when the scan starts or stops. */
  lastLock: z.object({ name: z.string(), freqMHz: z.number().nullable(), at: z.number() }).nullable(),
})
export type Scan = z.infer<typeof ScanState>

export const RadioState = z.object({
  firmware: z.string().nullable(),
  identity: IdentityState.nullable(),
  clock: ClockState.nullable(),
  sides: z.object({ a: SideState, b: SideState }),
  /** Which side the radio has selected (A=a/B=b). Advances when the radio acks our 08 19 select
   * (ACK = gospel) or a 05 read-back confirms it — never optimistically. NOTE: the radio's 5a
   * status engine settles its selected-side reference ~300-700ms AFTER the ack (relay-measured),
   * so the Session holds 5a application through a settle window around every swap. The
   * active/inactive 5a fields resolve to the physical sides through this. */
  selectedSide: z.enum(['a', 'b']),
  /** A side-select in flight: the side we asked the radio to switch to but haven't had confirmed.
   * The UI pulses this side while it's set; it clears (to null) when `selectedSide` catches up on
   * the ack/read-back, or on failure (reverting to the current `selectedSide`). */
  pendingSide: z.enum(['a', 'b']).nullable(),
  settings: z.record(z.string(), z.union([z.string(), z.number()])),
  pendingSettings: z.record(z.string(), PendingSetting),
  signal: SignalState,
  /** Live DMR call activity (5e/58 pushes); null when no call is in progress. */
  dmr: DmrState.nullable(),
  /** Native scan status (57 48 / 2f 2b). */
  scan: ScanState,
  /** Sticky manual-dial override: the next PTT on a DMR channel calls this target instead of the
   * channel's programmed contact, until cleared. Null = use the channel contact. */
  manualDial: z
    .object({ target: z.number().int().positive(), callType: z.enum(['group', 'private']) })
    .nullable(),
  squelchOpen: z.boolean(),
  /** The radio is transmitting — ITS truth, from the 5a state field (byte 7 ∈ {0x86,0x87},
   * live-pinned Sitting 1). Covers PTT initiated anywhere (our app, the radio's mic, a head),
   * unlike `ptt` which tracks only OUR key/unkey lifecycle. */
  transmitting: z.boolean(),
  ptt: z.enum(PTT_PHASES),
})
export type RadioState = z.infer<typeof RadioState>

export type SideKey = 'a' | 'b'

export function initialState(): RadioState {
  const emptySide = (): Side => ({
    freqMHz: null,
    txFreqMHz: null,
    channelName: '',
    channelPosition: null,
    zoneName: '',
    zoneNumber: null,
    zoneCount: null,
    channelCount: null,
    mode: null,
    channelRaw: null,
    channel: null,
    pendingChannel: {},
    volume: null,
  })
  return {
    firmware: null,
    identity: null,
    clock: null,
    sides: { a: emptySide(), b: emptySide() },
    selectedSide: 'a',
    pendingSide: null,
    settings: {},
    pendingSettings: {},
    signal: { aRssi: 0, bRssi: 0, aOpen: false, bOpen: false },
    dmr: null,
    scan: { active: false, listName: null, locked: false, paused: false, pausedChannel: null, lastLock: null },
    manualDial: null,
    squelchOpen: false,
    transmitting: false,
    ptt: 'idle',
  }
}
