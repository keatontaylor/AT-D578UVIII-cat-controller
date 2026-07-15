<script setup lang="ts">
import { computed, ref, shallowRef, watchEffect } from 'vue'
import { useRadio } from './composables/useRadio'
import ConnectBar from './components/ConnectBar.vue'
import VfoCard from './components/VfoCard.vue'
import RecordingsPanel from './components/RecordingsPanel.vue'
import StatusFooter from './components/StatusFooter.vue'
import ConnectProgress from './components/ConnectProgress.vue'
import PairingPanel from './components/PairingPanel.vue'
import SubChannelDialog from './components/SubChannelDialog.vue'
// ALL per-card render derivations live in the shared view model (src/domain/view.ts) — the
// integration suite asserts on the same functions, so what the tests prove is what renders.
// Do NOT re-derive rendering logic locally; add it to view.ts (and vfoView) instead.
import { dmrBusy as viewBusy, dmrUnlocked as viewUnlocked, dmrSideFor, inactiveSide as viewInactive, openFor as viewOpen, smeterFor as viewSmeter, txStateFor as viewTxState } from '../src/domain/view'
import type { TxState } from '../src/domain/view'

const radio = useRadio()
const state = radio.state

// Reconnect grace: a just-dropped socket keeps the last-known UI rendered — heavily dimmed and
// inert (stale values must not look live or be actionable) — while the 1 s retry loop works.
// Only once the grace expires does the full "reconnecting" placeholder tear the layout down.
const inGrace = computed(() => !radio.online.value && state.value !== null && !radio.graceExpired.value)
const effectiveOnline = computed(() => radio.online.value || inGrace.value)
// The layout goes stale (dimmed, inert) for BOTH a dropped controller socket (grace) and a
// user-initiated disconnect still tearing down — same visual language, same reused chip.
const stale = computed(() => inGrace.value || disconnecting.value)

const connected = computed(() => effectiveOnline.value && state.value?.connection === 'connected')
const connecting = computed(() => effectiveOnline.value && state.value?.connection === 'connecting')
// Explicit-disconnect teardown in progress: same stale treatment as a lost controller socket —
// the last-known radio UI stays rendered, heavily dimmed and inert, until the disconnect is
// CONFIRMED (status flips to 'disconnected' only after the session/SPP/ACL teardown completes).
const disconnecting = computed(() => effectiveOnline.value && state.value?.connection === 'disconnecting')

// The teardown resets the server-side radio state immediately, so the greyed-out display uses
// the last snapshot seen while CONNECTED (patch merges replace the object, so the old reference
// is a stable frozen copy). Cleared once fully disconnected — the pairing panel takes over.
const lastLiveRs = shallowRef<NonNullable<typeof state.value>['radio'] | null>(null)
watchEffect(() => {
  if (state.value?.connection === 'connected' && state.value.radio) lastLiveRs.value = state.value.radio
  else if (state.value?.connection === 'disconnected') lastLiveRs.value = null
})
const rs = computed(() => (disconnecting.value ? lastLiveRs.value : state.value?.radio ?? null))

// Nothing radio-shaped may render before the /ws snapshot: pre-hydration the connection state is
// simply UNKNOWN, and the disconnected UI (pairing panel, connect controls) would be a lie.
// Covers first load (no socket yet), the snapshot-in-flight window, and an expired-grace drop.
const hydrated = computed(() => effectiveOnline.value && state.value !== null)
const waitLabel = computed(() =>
  !radio.online.value && state.value !== null
    ? 'Connection to the controller lost — reconnecting…'
    : !radio.online.value
      ? 'Connecting to the controller…'
      : 'Loading radio state…',
)

// Card A = side a, card B = side b (the radio calls them MAIN/SUB, but A/B is what every wire command and state field uses). The signal is already resolved to physical sides (the reducer maps
// the 5a active/inactive fields via selectedSide), so each card just reads its own side's RSSI.
const main = computed(() => rs.value?.sides?.a ?? null)
const sub = computed(() => rs.value?.sides?.b ?? null)

const dmrSide = computed(() => (rs.value ? dmrSideFor(rs.value) : null))
const txStateFor = (side: 'a' | 'b'): TxState => (rs.value ? viewTxState(rs.value, side) : null)
const smeterFor = (side: 'a' | 'b'): number | null => (rs.value ? viewSmeter(rs.value, side) : null)
const openFor = (side: 'a' | 'b'): boolean => (rs.value ? viewOpen(rs.value, side) : false)
const busyFor = (side: 'a' | 'b'): boolean => (rs.value ? viewBusy(rs.value, side) : false)
const unlockedFor = (side: 'a' | 'b'): boolean => (rs.value ? viewUnlocked(rs.value, side) : false)
const inactiveSide = (side: 'a' | 'b'): boolean => (rs.value ? viewInactive(rs.value, side) : false)

// Write actions → JSON-RPC; the result flows back via the AppState patch stream.
function channelStep(side: 'a' | 'b', dir: 'UP' | 'DN'): void {
  void radio.channelStep(side, dir === 'UP' ? 1 : -1)
}
function zoneStep(side: 'a' | 'b', dir: 'UP' | 'DN'): void {
  void radio.zoneStep(side, dir === 'UP' ? 1 : -1)
}
function selectSide(side: 'a' | 'b'): void {
  if (rs.value?.scan?.active) return // side-switching is locked while a scan runs
  void radio.chooseSide(side)
}
function setVfoMode(side: 'a' | 'b', vfo: boolean): void {
  void radio.setVfoMode(side, vfo)
}

// Sub-Channel safety net: once per connect, when the settings read lands with sub_channel ON —
// the mono BT stream carries no side labels, so side attribution is inference; the popup offers
// the recommended single-receiver state (one settings write) without nagging a deliberate
// dual-watch operator ("don't show again" persists in localStorage).
const SUBCH_HINT_KEY = 'anytone.subChannelHintDismissed'
const showSubChHint = ref(false)
const subChHintDone = ref(false) // once per connect; re-arms on disconnect
watchEffect(() => {
  if (!connected.value) {
    showSubChHint.value = false
    subChHintDone.value = false
    return
  }
  if (subChHintDone.value || showSubChHint.value) return
  if (rs.value?.settings?.['sub_channel'] !== 'on') return
  if (localStorage.getItem(SUBCH_HINT_KEY) === '1') {
    subChHintDone.value = true
    return
  }
  showSubChHint.value = true
})
function subChHintClose(turnOff: boolean, dontShowAgain: boolean): void {
  showSubChHint.value = false
  subChHintDone.value = true
  if (dontShowAgain) localStorage.setItem(SUBCH_HINT_KEY, '1')
  if (turnOff) void radio.setSetting('sub_channel', 'off')
}
</script>

<template>
  <div class="app" :class="{ 'app--stale': stale }">
    <ConnectBar />

    <!-- Grace-period / disconnecting chip: the layout below stays (dimmed, inert) instead of
         tearing down — same stale treatment for both "socket lost" and "teardown in progress". -->
    <div v-if="stale" class="stale-chip" role="status">
      {{ disconnecting ? 'Disconnecting…' : 'Connection lost — reconnecting…' }}
    </div>

    <div v-if="!hydrated" class="connect-placeholder">
      <span class="hydrate-wait">{{ waitLabel }}</span>
    </div>

    <main v-else-if="(connected || disconnecting) && rs" class="dashboard">
      <section class="vfo-section">
        <VfoCard
          label="B"
          side="b"
          :freq-m-hz="sub?.freqMHz ?? null"
          :tx-freq-m-hz="sub?.txFreqMHz ?? null"
          :channel-name="sub?.channelName ?? ''"
          :channel-position="sub?.channelPosition ?? null"
          :zone-name="sub?.zoneName ?? ''"
          :zone-number="sub?.zoneNumber ?? null"
          :mode="sub?.mode ?? null"
          :config="sub?.channel ?? null"
          :pending-channel="sub?.pendingChannel ?? {}"
          :smeter="smeterFor('b')"
          :open="openFor('b')"
          :tx-state="txStateFor('b')"
          :dmr="dmrSide === 'b' || unlockedFor('b') ? rs.dmr : null"
          :dmr-busy="busyFor('b')"
          :dmr-unlocked="unlockedFor('b')"
          :scan="rs.selectedSide === 'b' ? rs.scan : null"
          :manual-dial="rs.manualDial.b"
          :connected="connected"
          :selected="rs.selectedSide === 'b'"
          :scan-active="!!rs.scan?.active"
          :pending="rs.pendingSide === 'b'"
          :inactive="inactiveSide('b')"
          @channel-step="(d) => channelStep('b', d)"
          @zone-step="(d) => zoneStep('b', d)"
          @select-side="selectSide('b')"
          @set-vfo-mode="(v) => setVfoMode('b', v)"
        />
        <VfoCard
          label="A"
          side="a"
          :freq-m-hz="main?.freqMHz ?? null"
          :tx-freq-m-hz="main?.txFreqMHz ?? null"
          :channel-name="main?.channelName ?? ''"
          :channel-position="main?.channelPosition ?? null"
          :zone-name="main?.zoneName ?? ''"
          :zone-number="main?.zoneNumber ?? null"
          :mode="main?.mode ?? null"
          :config="main?.channel ?? null"
          :pending-channel="main?.pendingChannel ?? {}"
          :smeter="smeterFor('a')"
          :open="openFor('a')"
          :tx-state="txStateFor('a')"
          :dmr="dmrSide === 'a' || unlockedFor('a') ? rs.dmr : null"
          :dmr-busy="busyFor('a')"
          :dmr-unlocked="unlockedFor('a')"
          :scan="rs.selectedSide === 'a' ? rs.scan : null"
          :manual-dial="rs.manualDial.a"
          :connected="connected"
          :selected="rs.selectedSide === 'a'"
          :scan-active="!!rs.scan?.active"
          :pending="rs.pendingSide === 'a'"
          :inactive="inactiveSide('a')"
          @channel-step="(d) => channelStep('a', d)"
          @zone-step="(d) => zoneStep('a', d)"
          @select-side="selectSide('a')"
          @set-vfo-mode="(v) => setVfoMode('a', v)"
        />
      </section>

      <RecordingsPanel />
    </main>

    <div v-else-if="connecting" class="connect-placeholder">
      <ConnectProgress :phase="state?.phase ?? null" />
    </div>

    <PairingPanel v-else />

    <StatusFooter v-if="(connected || disconnecting) && rs" :radio="rs" :metrics="state?.metrics ?? null" />

    <SubChannelDialog
      v-if="showSubChHint"
      @turn-off="(d: boolean) => subChHintClose(true, d)"
      @keep="(d: boolean) => subChHintClose(false, d)"
    />
  </div>
</template>

<style scoped>
.connect-placeholder {
  max-width: 1100px;
  margin: 48px auto;
  padding: 48px;
  text-align: center;
  color: var(--text-muted);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}
.hydrate-wait {
  animation: hydrate-pulse 1.4s ease-in-out infinite;
}
@keyframes hydrate-pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}

/* ── Reconnect grace: last-known UI stays up but is UNMISTAKABLY stale — strong dim, greyed,
   and fully inert (values on a dead socket must not look live or accept clicks). ── */
.app--stale .dashboard,
.app--stale .connect-placeholder,
.app--stale :deep(.header),
.app--stale :deep(.footer) {
  opacity: .35;
  filter: grayscale(.5);
  pointer-events: none;
  user-select: none;
  transition: opacity .25s, filter .25s;
}
.stale-chip {
  position: sticky;
  top: 8px;
  z-index: 300;
  width: fit-content;
  margin: 8px auto -4px;
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(210, 153, 34, .14);
  border: 1px solid rgba(210, 153, 34, .6);
  color: var(--yellow, #d29922);
  font-size: 12px;
  font-weight: 600;
  animation: hydrate-pulse 1.4s ease-in-out infinite;
}
</style>
