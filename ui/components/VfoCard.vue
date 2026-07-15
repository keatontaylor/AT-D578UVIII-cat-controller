<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import SMeter from './SMeter.vue'
import StatusBadge from './StatusBadge.vue'
import BandwidthDisplay from './BandwidthDisplay.vue'
import ChannelSettingsGrid from './ChannelSettingsGrid.vue'
import PacketCard from './PacketCard.vue'
import GlobalSettingCard from './GlobalSettingCard.vue'
import ChannelPickerDialog from './ChannelPickerDialog.vue'
import FrequencyDialog from './FrequencyDialog.vue'
import ManualDialDialog from './ManualDialDialog.vue'
import ScanDialog from './ScanDialog.vue'
import SettingDialog from './SettingDialog.vue'
import ToneDialog from './ToneDialog.vue'
import { useRadio } from '../composables/useRadio'
import { freqGroups } from '../lib/freq'
import { TONE_COLORS } from '../lib/settings'
// Display derivations come from the shared view model (src/domain/view.ts) — the same functions
// the integration suite asserts on. Add rendering rules THERE, not as local computeds.
import {
  contactDisplay as viewContact,
  dmrCallerBadge,
  dmrLiveBadge,
  memoryDisplay as viewMemory,
  scanLastLock as viewScanLastLock,
  scanSweeping as viewScanSweeping,
  typeLabel as viewTypeLabel,
  vfoMemLabel as viewVfoMem,
  zoneReadout as viewZoneReadout,
} from '../../src/domain/view'
import type { ChannelConfig, Dmr, PendingSetting, Scan } from '../../src/domain/state'

const radio = useRadio()
type ToneType = 'off' | 'ctc' | 'dcs'

const props = defineProps<{
  label: 'A' | 'B'
  side: 'a' | 'b'
  freqMHz: number | null
  txFreqMHz: number | null
  channelName: string
  channelPosition?: number | null
  zoneName: string
  /** 0-based current zone index — used to highlight/expand the current zone in the Go-to picker. */
  zoneNumber?: number | null
  mode: 'vfo' | 'memory' | null
  config: ChannelConfig | null
  pendingChannel: Record<string, PendingSetting>
  smeter: number | null
  /** Live DMR call activity (5e/58), passed only to the selected side (the radio decodes DMR on
   * its active side). Null when no call is up. */
  dmr?: Dmr | null
  /** Native scan status (57 48), passed to the selected side. */
  scan?: Scan | null
  /** Sticky manual-dial override (selected side only). */
  manualDial?: { target: number; callType: 'group' | 'private' } | null
  /** Squelch open on this side (receiving) — lights the RX indicator. */
  open: boolean
  /** NO MATCH: DMR traffic decoded on this side's frequency that the radio is NOT taking (the
   * call's tuple doesn't match this channel and Digital Monitor is off) — the radio's RX LED is
   * solid but it passes no audio. The card shows the decoded tuple + caller in AMBER (an operator
   * may see someone interesting and flip DigiMon on) plus the amber NO MATCH pill; the meter
   * carries the live RSSI. */
  dmrBusy?: boolean
  /** Unlocked decode (no 59 yet): the call info renders with the AMBER caller treatment — real
   * decode, audio not (yet) confirmed. dmrBusy (the NO MATCH pill) implies this. */
  dmrUnlocked?: boolean
  /** PTT truth-state for the pill (UI_PROTOCOL §6): TX renders red ONLY once the radio confirms
   * (`confirmed`); a sent-but-unacked key is `pending` (yellow), an unconfirmed release is
   * `releasing` (the radio is still transmitting), an exhausted release is `fault`. */
  txState?: 'pending' | 'confirmed' | 'releasing' | 'fault' | null
  connected: boolean
  selected: boolean
  /** A native scan is running (on either side) — side-switching is locked out while scanning, since
   * only the scanning side is live and the radio holds the other. */
  scanActive?: boolean
  /** This side has a select in flight (radio hasn't confirmed the switch) — pulse, don't re-arm. */
  pending?: boolean
  /** Sub receiver is off (single-receive): this non-active side is dormant — greyed, and its
   * channel/zone/setting controls are disabled. It stays SELECTABLE: the radio's A/B swap (08 19)
   * is valid regardless of sub power, and selecting the dormant side is exactly how you make it
   * the active one. */
  inactive?: boolean
}>()

const emit = defineEmits<{
  channelStep: ['UP' | 'DN']
  zoneStep: ['UP' | 'DN']
  selectSide: []
  setVfoMode: [vfo: boolean]
}>()

// EXPLICIT side-first model: every mutating control on this card requires the side to be the
// radio's SELECTED side — the UI never switches sides implicitly on the user's behalf. To edit
// the other side, click its card (select it) first.
const locked = computed(() => !props.connected || !props.selected)
// While scanning, channel/zone/mode nav is locked out (matches the radio) — only Scan (stop) and
// PTT stay live. Guard steps on this in addition to `locked`.
const scanning = computed(() => !!props.scan?.active)
const navLocked = computed(() => locked.value || scanning.value)
const lockTitle = (action: string): string =>
  !props.connected ? action : locked.value ? 'Select this side first' : scanning.value ? 'Stop the scan first' : action

const memoryDisplay = computed(() => viewMemory(props.mode, props.channelName, props.scan ?? null))
const cardClass = computed(() => (props.label === 'B' ? 'sub-card' : 'main-card'))
const freqClass = computed(() => (props.label === 'B' ? 'freq-sub' : 'freq-main'))

// FM/DMR badge in the header. The detailed enum settings render (editable) via ChannelSettingsGrid.
const typeLabel = computed(() => viewTypeLabel(props.config))
const vfoMemLabel = computed(() => viewVfoMem(props.mode))
const contactDisplay = computed(() => viewContact(props.config?.contact))
// TX badge derives from the channel/dial (the radio's 5e tuple is inert on TX — see dmrLiveBadge).
const dmrLive = computed(() => dmrLiveBadge(props.dmr, { channel: props.config ?? null, dial: props.manualDial ?? null }))
const dmrCaller = computed(() => dmrCallerBadge(props.dmr))

// ── scan-time display honesty (view.ts) ──────────────────────────────────────
// While the scan hops, the frequency is UNKNOWN — show an animated placeholder, never the stale
// pre-scan digits; the zone line carries the scan status; the last lock renders as labeled history.
const sweeping = computed(() => viewScanSweeping(props.scan))
const zoneView = computed(() => viewZoneReadout(props.zoneName, props.mode, props.scan, props.open))
const lastLock = computed(() => viewScanLastLock(props.scan))
// ticking "12s ago" age for the history chip — 1 Hz wall clock, only while the chip shows
const nowTick = ref(Date.now())
let ageTimer: ReturnType<typeof setInterval> | null = null
watch(() => lastLock.value !== null, (show) => {
  if (show && !ageTimer) ageTimer = setInterval(() => (nowTick.value = Date.now()), 1000)
  else if (!show && ageTimer) {
    clearInterval(ageTimer)
    ageTimer = null
  }
}, { immediate: true })
onBeforeUnmount(() => {
  if (ageTimer) clearInterval(ageTimer)
})
const lastLockChip = computed(() => {
  const ll = lastLock.value
  if (!ll) return null
  const secs = Math.max(0, Math.round((nowTick.value - ll.at) / 1000))
  const age = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`
  const freq = ll.freqMHz != null ? ` · ${ll.freqMHz.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}` : ''
  return `Last: ${ll.name}${freq} · ${age}`
})

// ── RX/TX tone (CTCSS/DCS) editing ──────────────────────────────────────────────
const toneField = ref<'rx' | 'tx' | null>(null)
function toneItem(field: 'rx' | 'tx') {
  const tone = field === 'rx' ? props.config?.rxTone : props.config?.txTone
  const p = props.pendingChannel[field === 'rx' ? 'rxTone' : 'txTone']
  const type: ToneType = tone?.kind === 'ctcss' ? 'ctc' : tone?.kind === 'dcs' ? 'dcs' : 'off'
  return {
    display: tone?.display ?? 'Off',
    current: { type, value: tone?.ctcssIndex ?? tone?.dcsCode ?? 0 },
    pending: p?.phase === 'pending' ? String(p.desired) : null,
    failed: p?.phase === 'failed',
    // tile status color: blue = CTCSS, purple = DCS, neutral = off (shared tone palette)
    color: type === 'ctc' ? TONE_COLORS.ctcss : type === 'dcs' ? TONE_COLORS.dcs : null,
  }
}
const rxTone = computed(() => toneItem('rx'))
const txTone = computed(() => toneItem('tx'))
const openTone = computed(() =>
  toneField.value ? { field: toneField.value, item: toneField.value === 'rx' ? rxTone.value : txTone.value } : null,
)
function chooseTone(type: ToneType, value: number, inverted: boolean): void {
  if (!toneField.value || navLocked.value) return
  void radio.setChannelTone(props.side, toneField.value, type, value, inverted)
  toneField.value = null
}
function openToneDialog(field: 'rx' | 'tx'): void {
  if (navLocked.value) return // tones are 2f writes to the working channel — never mid-scan
  toneField.value = field
}

// ── VFO / memory mode picker (57 3d) — a dialog like every other setting, not a blind toggle ──
const vfoDialogOpen = ref(false)
const VFO_MODE_OPTIONS = ['Memory', 'VFO']
function openVfoDialog(): void {
  if (navLocked.value || props.mode === null) return
  vfoDialogOpen.value = true
}
function chooseVfoMode(value: string): void {
  vfoDialogOpen.value = false
  const vfo = value === 'VFO'
  if ((props.mode === 'vfo') === vfo) return // already there — nothing to write
  emit('setVfoMode', vfo)
}

// ── RX/TX frequency click-to-edit (2f 03 / 2f 04) ───────────────────────────────
const freqField = ref<'rx' | 'tx' | null>(null)
// navLocked, not just locked: a 2f 03/04 write mid-scan would hit the working-channel register
// while the scan engine owns it (the same reason channel/zone nav locks out during a scan).
const freqEditable = computed(() => !navLocked.value)
const freqPending = (field: 'rx' | 'tx') => props.pendingChannel[field === 'rx' ? 'rxFreq' : 'txFreq']
const openFreq = computed(() => {
  if (!freqField.value) return null
  const p = freqPending(freqField.value)
  return {
    field: freqField.value,
    current: freqField.value === 'rx' ? props.freqMHz : props.txFreqMHz,
    pending: p?.phase === 'pending' ? String(p.desired) : null,
    failed: p?.phase === 'failed',
  }
})
function openFreqDialog(field: 'rx' | 'tx'): void {
  if (!freqEditable.value) return
  freqField.value = field
}
function chooseFrequency(hz: number): void {
  if (!freqField.value || !freqEditable.value) return
  void radio.setFrequency(props.side, freqField.value, hz)
  freqField.value = null
}

// ── native scan (57 48 start/stop, 2f 2b select). The picker is self-contained: it opens
// immediately and reads the scan lists itself (with a loading indicator), like the Go-to dialog. ──
const scanPickerOpen = ref(false)
function chooseScanList(list: { index: number; name: string } | null): void {
  scanPickerOpen.value = false
  void radio.startScan(props.side, list?.index ?? null, list?.name ?? null)
}
function toggleScan(): void {
  if (locked.value) return
  if (props.scan?.active) void radio.stopScan()
  else scanPickerOpen.value = true // open now; the dialog fetches the lists
}

// ── "Go anywhere" picker (enumerate zones + channels → cross-zone select). The dialog is
// self-contained: it reads zones/channels and issues the jump itself. ─────────────────────────
const gotoOpen = ref(false)
function openGoto(): void {
  if (navLocked.value || props.mode !== 'memory') return
  gotoOpen.value = true
}

// ── manual DMR dial (56 extended tail) ──────────────────────────────────────────
const dialOpen = ref(false)
const isDigital = computed(() => props.config != null && props.config.type !== 'analog')
function openDial(): void {
  if (!locked.value) dialOpen.value = true
}
function applyDial(target: number, callType: 'group' | 'private'): void {
  dialOpen.value = false
  void radio.setManualDial(props.side, target, callType)
}
function clearDial(): void {
  dialOpen.value = false
  void radio.clearManualDial(props.side)
}
</script>

<template>
  <div
    class="vfo-card"
    :class="[
      cardClass,
      {
        'vfo-card--tx-vfo': selected, // the selected side is the active TX/RX side
        'vfo-card--rx-only': !selected && !inactive, // dual-watch secondary (dimmed, still live)
        'vfo-card--inactive': inactive, // sub off → single-receive: this side is dormant
        // Selectable is deliberately independent of `inactive`: the A/B swap must stay available
        // when the sub receiver is off (it's the only way to activate the dormant side). But NOT
        // during a scan — the radio locks side-switching while it scans.
        'vfo-card--selectable': connected && !selected && !pending && !scanActive,
        'vfo-card--pending': pending, // select in flight — pulsing until the radio acks
      },
    ]"
    :title="scanActive && !selected ? 'Stop the scan to switch sides' : undefined"
    @click="connected && !selected && !pending && !scanActive && emit('selectSide')"
  >
    <div class="vfo-header">
      <div class="vfo-title-row">
        <span class="vfo-label">{{ label }}</span>
        <span class="memory-state-badge">{{ memoryDisplay }}</span>
      </div>
      <div class="vfo-control-row">
        <!-- Zone line: mid-scan the zone is as unknown as the frequency, so it carries the scan
             status instead (green sweeping/locked, grey paused); VFO mode has no zone either. -->
        <span
          class="band-sel vfo-readout zone-readout"
          :class="zoneView.tone ? `zone-readout--${zoneView.tone}` : undefined"
          :title="zoneView.tone === 'scanning' ? 'Scanning — position unknown until it locks' : zoneView.tone === 'acquiring' ? 'Scan stopped — reading the channel info from the radio' : zoneView.tone === 'waiting' ? 'Scan is holding this stop (post-receive delay, or the other side is receiving) — it resumes on its own' : zoneView.tone === 'locked' ? 'Scan locked on a busy channel' : mode === 'vfo' ? 'Direct frequency entry — no zone' : zoneName"
        >{{ zoneView.text }}</span>
      </div>
      <div class="vfo-step-row">
        <div class="channel-control">
          <button class="channel-step-btn channel-step-btn--label" :disabled="navLocked || mode !== 'memory'" :title="mode === 'memory' ? lockTitle('Channel down') : 'Memory mode only'" @click.stop="emit('channelStep', 'DN')">Ch −</button>
          <button class="channel-step-btn channel-step-btn--label" :disabled="navLocked || mode !== 'memory'" :title="mode === 'memory' ? lockTitle('Channel up') : 'Memory mode only'" @click.stop="emit('channelStep', 'UP')">Ch +</button>
        </div>
        <div class="channel-control zone-control">
          <button class="channel-step-btn channel-step-btn--label" :disabled="navLocked || mode !== 'memory'" :title="mode === 'memory' ? lockTitle('Zone down') : 'Memory mode only'" @click.stop="emit('zoneStep', 'DN')">Zone −</button>
          <button class="channel-step-btn channel-step-btn--label" :disabled="navLocked || mode !== 'memory'" :title="mode === 'memory' ? lockTitle('Zone up') : 'Memory mode only'" @click.stop="emit('zoneStep', 'UP')">Zone +</button>
        </div>
        <div class="channel-control browse-control">
          <button
            class="channel-step-btn channel-step-btn--label browse-btn"
            :disabled="navLocked || mode !== 'memory'"
            :title="mode === 'memory' ? lockTitle('Go to channel') : 'Memory mode only'"
            @click.stop="openGoto"
          >Go to</button>
        </div>
      </div>
    </div>

    <div class="sql-row">
      <span class="sql-badge sql-badge--mode" title="Channel type">{{ typeLabel }}</span>
      <span v-if="config?.contact" class="sql-badge sql-badge--contact" :title="config.contact.name ? `DMR contact: ${config.contact.name}` : 'DMR contact'">{{ contactDisplay }}</span>
      <span
        v-if="dmrLive"
        class="sql-badge sql-badge--dmr-live"
        :title="dmrBusy ? 'Decoded call the radio is not taking — its tuple doesn\'t match this channel (Digital Monitor off)' : `DMR ${dmrLive.direction === 'tx' ? 'transmit' : 'receive'}`"
      >{{ dmrLive.label }}</span>
      <span v-if="dmrCaller" class="sql-badge sql-badge--dmr-caller" :class="{ 'sql-badge--dmr-nomatch': dmrUnlocked }" title="DMR caller (RadioID)">{{ dmrCaller }}</span>
      <!-- No scan status chip here — the zone line carries SCANNING/PAUSED/LOCKED now; the only
           scan chip is the last-lock HISTORY (something that happened, which is what chips mean). -->
      <span v-if="lastLockChip" class="sql-badge sql-badge--last-lock" title="Where the scan last stopped (history, not the current position)">{{ lastLockChip }}</span>
      <span v-if="txState === 'fault'" class="rx-indicator tx-indicator tx-indicator--fault" title="Release NOT confirmed — the radio may still be transmitting">TX?!</span>
      <span v-else-if="txState === 'releasing'" class="rx-indicator tx-indicator tx-indicator--wait" title="Release sent — the radio is transmitting until it confirms">TX…</span>
      <span v-else-if="txState === 'confirmed'" class="rx-indicator tx-indicator" title="Transmitting (radio-confirmed)">TX</span>
      <span v-else-if="txState === 'pending'" class="rx-indicator tx-indicator--wait" title="Key sent — awaiting the radio's acknowledgment">TX?</span>
      <span v-else-if="open" class="rx-indicator" title="Squelch open — receiving">RX</span>
      <span v-else-if="dmrBusy" class="rx-indicator rx-indicator--busy" title="The call doesn't match this channel's tuple and Digital Monitor is off — the radio is not taking it">NO MATCH</span>
    </div>

    <div class="freq-block">
      <!-- Click-to-edit: the tuner opens the frequency dialog (2f 03 / 2f 04). stop keeps the
           card's select-side click from firing. -->
      <div class="freq-row">
        <!-- Sweeping: the radio is hopping and reports nothing per-hop — the digits are UNKNOWN.
             The placeholder keeps the EXACT same row structure/metrics as the live display (only
             the digits become shimmering dashes) so the card's vertical rhythm never shifts. -->
        <div v-if="sweeping" class="freq-tuner freq-tuner--sweeping" :class="freqClass" title="Scanning — frequency unknown until the scan locks">
          <template v-for="gi in 3" :key="gi">
            <span v-if="gi > 1" class="freq-dot">.</span>
            <div class="freq-group">–––</div>
          </template>
        </div>
        <div
          v-else
          class="freq-tuner"
          :class="[freqClass, { 'freq-tuner--editable': freqEditable, 'freq-tuner--busy': freqPending('rx')?.phase === 'pending' }]"
          :role="freqEditable ? 'button' : undefined"
          :tabindex="freqEditable ? 0 : undefined"
          :title="connected ? lockTitle('Tap to enter RX frequency') : undefined"
          @click.stop="openFreqDialog('rx')"
          @keydown.enter.space.prevent="openFreqDialog('rx')"
        >
          <template v-for="(group, gi) in freqGroups(freqMHz)" :key="gi">
            <span v-if="gi > 0" class="freq-dot">.</span>
            <div class="freq-group">{{ group }}</div>
          </template>
        </div>
        <span class="freq-unit">MHz</span>
        <span v-if="!sweeping && freqPending('rx')?.phase === 'pending'" class="freq-pending-spin" title="Frequency write in flight">⟳</span>
        <span v-else-if="!sweeping && freqPending('rx')?.phase === 'failed'" class="freq-pending-fail" title="Frequency write not confirmed">!</span>
      </div>
      <!-- The TX split row keeps rendering through a sweep (dashed) whenever the pre-scan channel
           had one — same rows before/during/after, so nothing below the tuner jumps. -->
      <div v-if="txFreqMHz != null && sweeping" class="split-freq-row">
        <span class="split-freq-label">TX</span>
        <div class="split-freq-tuner freq-tuner--sweeping" title="Scanning — frequency unknown until the scan locks">
          <template v-for="gi in 3" :key="gi">
            <span v-if="gi > 1" class="freq-dot">.</span>
            <div class="freq-group">–––</div>
          </template>
        </div>
        <span class="split-freq-unit">MHz</span>
      </div>
      <div v-else-if="txFreqMHz != null" class="split-freq-row">
        <span class="split-freq-label">TX</span>
        <div
          class="split-freq-tuner"
          :class="{ 'split-freq-tuner--prohibited': config?.txProhibit, 'split-freq-tuner--editable': freqEditable }"
          :role="freqEditable ? 'button' : undefined"
          :tabindex="freqEditable ? 0 : undefined"
          :title="connected ? lockTitle('Tap to enter TX frequency') : undefined"
          @click.stop="openFreqDialog('tx')"
          @keydown.enter.space.prevent="openFreqDialog('tx')"
        >
          <template v-for="(group, gi) in freqGroups(txFreqMHz)" :key="gi">
            <span v-if="gi > 0" class="freq-dot">.</span>
            <div class="freq-group">{{ group }}</div>
          </template>
        </div>
        <span class="split-freq-unit">MHz</span>
        <span v-if="freqPending('tx')?.phase === 'pending'" class="freq-pending-spin" title="Frequency write in flight">⟳</span>
        <span v-else-if="freqPending('tx')?.phase === 'failed'" class="freq-pending-fail" title="Frequency write not confirmed">!</span>
      </div>
      <!-- mode/bandwidth are per-channel too — unknown while hopping, so the meter renders its
           honest "--"/empty state (kept in the layout so the freq block height never changes) -->
      <BandwidthDisplay :mode="sweeping ? null : typeLabel" :bandwidth="sweeping ? null : config?.bandwidthKHz ?? null" />
    </div>

    <SMeter :value="smeter" :label="`${label} S-meter`" />

    <template v-if="config">
      <ChannelSettingsGrid :side="side" :config="config" :pending="pendingChannel" :disabled="locked" :scanning="scanning">
        <template #front>
          <!-- Scan (57 48), VFO/MEM (57 3d), the RX/TX tone pickers and Manual Dial (56) lead the
               grid as uniform tiles; the remaining channel settings edit through the generic option
               dialog behind their badges. Order mirrors the PoC. -->
          <div
            class="ctl-box scan-ctl"
            :class="{ 'ctl-box--disabled': locked, 'scan-ctl--scanning': scanning }"
            role="button"
            :tabindex="locked ? undefined : 0"
            :aria-disabled="locked ? 'true' : undefined"
            :title="lockTitle(scanning ? 'Stop scan' : 'Start a scan')"
            @click.stop="toggleScan"
            @keydown.enter.space.prevent="toggleScan"
          >
            <StatusBadge label="Scan" :value="scanning ? 'Stop' : 'Start'" :active="scanning" :disabled="locked" hint color-active="#10b981" />
          </div>
          <div
            class="ctl-box"
            :class="{ 'ctl-box--disabled': locked }"
            role="button"
            :tabindex="locked ? undefined : 0"
            :aria-disabled="locked ? 'true' : undefined"
            :title="lockTitle('Change VFO / memory mode')"
            @click.stop="openVfoDialog"
            @keydown.enter.space.prevent="openVfoDialog"
          >
            <StatusBadge label="VFO/MEM" :value="vfoMemLabel" :disabled="navLocked" hint />
          </div>
          <StatusBadge
            v-if="config.rxTone"
            label="RX Tone"
            :value="rxTone.pending ?? rxTone.display"
            :clickable="true"
            :active="!!rxTone.color"
            :color-active="rxTone.color ?? undefined"
            :disabled="locked"
            :busy="!!rxTone.pending"
            :failed="rxTone.failed"
            @toggle="openToneDialog('rx')"
          />
          <StatusBadge
            v-if="config.txTone"
            label="TX Tone"
            :value="txTone.pending ?? txTone.display"
            :clickable="true"
            :active="!!txTone.color"
            :color-active="txTone.color ?? undefined"
            :disabled="locked"
            :busy="!!txTone.pending"
            :failed="txTone.failed"
            @toggle="openToneDialog('tx')"
          />
          <div
            v-if="isDigital"
            class="ctl-box"
            :class="{ 'ctl-box--disabled': locked }"
            role="button"
            :tabindex="locked ? undefined : 0"
            :aria-disabled="locked ? 'true' : undefined"
            :title="lockTitle('Manual dial DMR contact')"
            @click.stop="openDial"
            @keydown.enter.space.prevent="openDial"
          >
            <StatusBadge
              label="Manual Dial"
              :value="manualDial ? `→ ${manualDial.target}` : 'Off'"
              :active="dialOpen || !!manualDial"
              :disabled="locked"
              hint
              :color-active="manualDial ? '#f59e0b' : '#58a6ff'"
            />
          </div>
        </template>
        <!-- Global settings that belong next to a channel type: analog squelch on analog RX,
             DMR promiscuous monitor on digital. Both write through the global settings path. -->
        <GlobalSettingCard
          v-if="config?.type === 'analog'"
          name="analog_squelch_level"
          label="Squelch"
          dialog-label="Analog Squelch"
          :fallback-options="['off', 'L1', 'L2', 'L3', 'L4', 'L5']"
          fallback-description="Analog carrier/noise squelch threshold — higher closes weaker signals."
          :disabled="locked"
        />
        <GlobalSettingCard
          v-if="isDigital"
          name="digi_monitor"
          label="DigiMon"
          dialog-label="Digital Monitor"
          :fallback-options="['off', 'single', 'double']"
          fallback-description="DMR promiscuous monitor: hear other talkgroups on the current (single) or both (double) time slots."
          :disabled="locked"
        />
        <!-- Packet TNC: shown on ANY side whose channel is analog (the mode it can operate in).
             The service itself is global — not side-scoped — so selection doesn't gate it; its
             PTT guard still refuses to key if the SELECTED side is digital at transmit time. -->
        <PacketCard v-if="config?.type === 'analog'" :disabled="!connected" />
      </ChannelSettingsGrid>

      <SettingDialog
        v-if="vfoDialogOpen"
        :label="`VFO / Memory — ${label}`"
        description="Switch this side between direct frequency entry (VFO) and the programmed channel memories."
        :options="VFO_MODE_OPTIONS"
        :current="mode === 'vfo' ? 'VFO' : 'Memory'"
        :pending="null"
        :failed="false"
        @select="chooseVfoMode"
        @close="vfoDialogOpen = false"
      />

      <ToneDialog
        v-if="openTone"
        :label="`${openTone.field === 'rx' ? 'RX' : 'TX'} Tone — ${label}`"
        :current="openTone.item.current"
        :pending="openTone.item.pending"
        :failed="openTone.item.failed"
        @select="chooseTone"
        @close="toneField = null"
      />
    </template>

    <FrequencyDialog
      v-if="openFreq"
      :label="`Set ${openFreq.field === 'tx' ? 'TX ' : ''}Frequency - ${label}`"
      :field="openFreq.field"
      :current-m-hz="openFreq.current"
      :pending="openFreq.pending"
      :failed="openFreq.failed"
      @select="chooseFrequency"
      @close="freqField = null"
    />

    <ScanDialog
      v-if="scanPickerOpen"
      :label="`Scan — ${label}`"
      @select="chooseScanList"
      @close="scanPickerOpen = false"
    />

    <ChannelPickerDialog
      v-if="gotoOpen"
      :label="`Go to — ${label}`"
      :side="side"
      :current-zone-index="zoneNumber"
      :current-position="channelPosition"
      @close="gotoOpen = false"
    />

    <ManualDialDialog
      v-if="dialOpen"
      :label="`Manual Dial — ${label}`"
      :current="manualDial ?? null"
      @apply="applyDial"
      @clear="clearDial"
      @close="dialOpen = false"
    />
  </div>
</template>
