<script setup lang="ts">
// Packet TNC card (channel settings grid tile): toggles the direwolf soundcard-modem bridge.
// While enabled, the server runs direwolf against the radio's audio + PTT and exposes a standard
// KISS TNC (TCP) and AGWPE port on the LAN for packet apps (APRSdroid, Xastir, YAAC, …).
// Rendered only on the SELECTED side — packet TX keys whatever side the radio has selected.
import { computed, ref } from 'vue'
import StatusBadge from './StatusBadge.vue'
import { useRadio } from '../composables/useRadio'

const props = defineProps<{ disabled?: boolean }>()
const radio = useRadio()

const open = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)

const pkt = computed(() => radio.packetStatus.value)
const enabled = computed(() => pkt.value?.enabled ?? false)
const badgeValue = computed(() => {
  const s = pkt.value
  if (!s?.enabled) return 'Off'
  if (!s.running) return 'Starting'
  return s.ptt ? 'TX' : 'On'
})

// Where LAN clients point their packet apps — this host, the TNC ports.
const host = window.location.hostname
const kiss = computed(() => `${host}:${pkt.value?.kissPort ?? 8001}`)
const agw = computed(() => `${host}:${pkt.value?.agwPort ?? 8000}`)

function openDialog(): void {
  if (!props.disabled) open.value = true
}

async function toggle(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = null
  try {
    await radio.packetSetEnabled(!enabled.value)
  } catch (e) {
    error.value = (e as { message?: string })?.message ?? String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    class="ctl-box"
    :class="{ 'ctl-box--disabled': disabled }"
    role="button"
    :tabindex="disabled ? undefined : 0"
    :aria-disabled="disabled ? 'true' : undefined"
    title="Packet TNC (direwolf) — KISS/AGW over the LAN"
    @click.stop="openDialog"
    @keydown.enter.space.prevent="openDialog"
  >
    <StatusBadge
      label="Packet TNC"
      :value="badgeValue"
      :active="enabled"
      :disabled="disabled"
      hint
      :color-active="pkt?.ptt ? '#f85149' : '#10b981'"
    />
  </div>

  <Teleport to="body">
    <div v-if="open" class="tone-modal-backdrop" @click.self="open = false">
      <div class="tone-modal packet-modal" role="dialog" aria-modal="true" aria-label="Packet TNC">
        <div class="tone-modal-header">
          <span class="tone-modal-title">Packet TNC — direwolf</span>
          <button type="button" class="tone-modal-close" aria-label="Close" @click="open = false">✕</button>
        </div>

        <div class="packet-body">
          <p class="packet-hint">
            Bridges the radio's audio and PTT to a <strong>1200-baud AFSK soundcard modem</strong>.
            Park this side on an <strong>analog</strong> channel and hold the squelch
            <strong>open (SQL 0)</strong> so the modem hears the channel continuously.
            <em>Best-effort over the Bluetooth audio path — decode reliability is limited by the
            radio's voice codec, so expect occasional retries.</em>
          </p>

          <section class="webrtc-stat-card">
            <h3>TNC</h3>
            <dl class="webrtc-stat-list">
              <dt>Status</dt>
              <dd>{{ !pkt?.enabled ? 'Off' : pkt.running ? (pkt.ptt ? 'Transmitting' : 'Listening') : 'Starting…' }}</dd>
              <dt>KISS TNC (TCP)</dt>
              <dd>{{ kiss }}</dd>
              <dt>AGWPE</dt>
              <dd>{{ agw }}</dd>
              <dt>Decoded frames</dt>
              <dd>{{ pkt?.decodes ?? 0 }}</dd>
              <template v-if="pkt?.audioLevel != null">
                <dt>RX audio level</dt>
                <dd :class="{ 'packet-level-bad': pkt.audioLevel < 20 || pkt.audioLevel > 85 }">
                  {{ pkt.audioLevel }} <span class="packet-level-hint">(target ~50 — adjust BT-01 speaker gain in Radio Settings)</span>
                </dd>
              </template>
              <template v-if="pkt?.lastHeard">
                <dt>Last heard</dt>
                <dd>{{ pkt.lastHeard }}</dd>
              </template>
              <template v-if="pkt?.error || error">
                <dt>Error</dt>
                <dd class="packet-error">{{ error ?? pkt?.error }}</dd>
              </template>
            </dl>
          </section>

          <button type="button" class="btn packet-toggle" :class="enabled ? 'packet-toggle--off' : 'packet-toggle--on'" :disabled="busy" @click="toggle">
            {{ busy ? 'Working…' : enabled ? 'Disable Packet TNC' : 'Enable Packet TNC' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.packet-modal { width: 420px; max-width: calc(100vw - 24px); }
/* Body padding + internal scroll follow the shared dialog convention (.webrtc-stats-body /
   .radio-settings-body); the info rows reuse the global stat-card styling for consistency. */
.packet-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px 14px 16px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.packet-hint { font-size: 12px; line-height: 1.5; color: var(--text-muted, #8b949e); margin: 0; }
.packet-error { color: #f85149 !important; }
.packet-level-bad { color: #f59e0b !important; }
.packet-level-hint { color: var(--text-muted, #8b949e); font-family: inherit; font-size: 10px; }
.packet-toggle { width: 100%; }
.packet-toggle--on { border-color: rgba(16, 185, 129, .6); color: #10b981; }
.packet-toggle--off { border-color: rgba(248, 81, 73, .6); color: #f85149; }
</style>
