<script setup lang="ts">
// WebRTC connection-stats popup (PoC parity, sane subset). Polls the live peer's getStats() via
// useRadio and renders connection / candidate-pair / RX / TX cards. Auto-refreshes while open.
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'
import { useRadio, type RtcStats } from '../composables/useRadio'

const emit = defineEmits<{ close: [] }>()
const radio = useRadio()

const stats = ref<RtcStats | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const copied = ref(false)
let timer: number | undefined

async function refresh(): Promise<void> {
  loading.value = true
  try {
    stats.value = await radio.getRtcStats()
    error.value = stats.value ? null : 'No audio peer — enable audio first.'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

const fmtBytes = (b?: number): string => {
  if (b == null) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1048576).toFixed(2)} MB`
}
const fmtMs = (m: number | null): string => (m == null ? '—' : `${m} ms`)
const num = (n?: number): string => (n == null ? '—' : String(n))

const stateLabel = computed(() => stats.value?.connectionState ?? 'disconnected')
const connectionRows = computed(() => [
  ['Peer state', stats.value?.connectionState ?? '—'],
  ['ICE state', stats.value?.iceConnectionState ?? '—'],
])
// One-line verdict on HOW the audio is flowing: same-network direct, NAT-punched direct
// (STUN did its job), or relayed through a TURN server (and which one).
const pathLabel = computed(() => {
  const p = stats.value?.pair
  const lt = p?.local?.type
  const rt = p?.remote?.type
  if (!p || !lt) return '—'
  if (lt === 'relay') {
    const via = p.local?.url?.replace(/^turns?:/, '').split('?')[0] ?? 'TURN'
    const proto = p.local?.relayProtocol ? ` · ${p.local.relayProtocol}` : ''
    return `relayed via ${via}${proto}`
  }
  if (rt === 'relay') return 'relayed (server side via TURN)'
  if (lt === 'host' && rt === 'host') return 'direct — same network'
  return 'direct — NAT-traversed (STUN)'
})
const endpoint = (c?: { type?: string; address?: string; port?: number } | null): string => {
  if (!c?.type) return '—'
  const addr = c.address ? ` ${c.address}${c.port != null ? `:${c.port}` : ''}` : ''
  return `${c.type}${addr}`
}
const pairRows = computed(() => {
  const p = stats.value?.pair
  if (!p) return []
  const rows: [string, string][] = [
    ['Path', pathLabel.value],
    ['Round-trip', fmtMs(p.rttMs)],
    ['Local', endpoint(p.local)],
    ['Remote', endpoint(p.remote)],
    ['Protocol', p.protocol ?? '—'],
    ['Sent', fmtBytes(p.bytesSent)],
    ['Received', fmtBytes(p.bytesReceived)],
  ]
  if (p.local?.url) rows.splice(4, 0, ['ICE server', p.local.url])
  return rows
})
const inboundRows = computed(() => {
  const i = stats.value?.inbound
  if (!i) return []
  return [
    ['Codec', i.codec ?? '—'],
    ['Packets', num(i.packets)],
    ['Lost', num(i.lost)],
    ['Jitter', fmtMs(i.jitterMs)],
    // The direct "pops" counter: NetEq concealment events = playout underruns/loss it papered over.
    // If this climbs steadily while you hear crackle, it's the receiver buffer, not the network.
    ['Conceal events', num(i.concealmentEvents)],
    ['Concealed samples', num(i.concealedSamples)],
    ['Buffer depth', fmtMs(i.jitterBufferMs ?? null)],
    ['Bytes', fmtBytes(i.bytes)],
  ]
})
const outboundRows = computed(() => {
  const o = stats.value?.outbound
  const r = stats.value?.remote
  if (!o && !r) return []
  return [
    ['Codec', o?.codec ?? '—'],
    ['Packets', num(o?.packets)],
    ['Bytes', fmtBytes(o?.bytes)],
    ['Remote RTT', fmtMs(r?.rttMs ?? null)],
    ['Remote lost', num(r?.lost)],
  ]
})

async function copyJson(): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify(stats.value, null, 2))
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    /* clipboard blocked — no-op */
  }
}

const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  void refresh()
  timer = window.setInterval(refresh, 1500)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.clearInterval(timer)
})
</script>

<template>
  <Teleport to="body">
    <div class="tone-modal-backdrop" @click.self="emit('close')">
      <div class="tone-modal webrtc-stats-modal" role="dialog" aria-modal="true" aria-label="WebRTC connection stats">
        <div class="tone-modal-header">
          <span class="tone-modal-title">WebRTC Stats</span>
          <button type="button" class="tone-modal-close" aria-label="Close" @click="emit('close')">✕</button>
        </div>

        <div class="webrtc-stats-body">
          <div class="webrtc-stats-toolbar">
            <span class="webrtc-stats-pill" :class="{ 'webrtc-stats-pill--live': stateLabel === 'connected', 'webrtc-stats-pill--reconnecting': stateLabel === 'connecting' }">
              {{ stateLabel === 'connected' ? 'Live' : stateLabel === 'connecting' ? 'Connecting' : 'Disconnected' }}
            </span>
            <span v-if="stats?.collectedAt" class="webrtc-stats-updated">Updated {{ new Date(stats.collectedAt).toLocaleTimeString() }}</span>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="loading" @click="refresh">{{ loading ? 'Refreshing…' : 'Refresh' }}</button>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="!stats" @click="copyJson">{{ copied ? 'Copied' : 'Copy JSON' }}</button>
          </div>

          <div v-if="error" class="webrtc-stats-error">{{ error }}</div>

          <div v-if="stats" class="webrtc-stats-grid">
            <section class="webrtc-stat-card">
              <h3>Connection</h3>
              <dl class="webrtc-stat-list">
                <template v-for="[label, value] in connectionRows" :key="label"><dt>{{ label }}</dt><dd>{{ value }}</dd></template>
              </dl>
            </section>
            <section class="webrtc-stat-card">
              <h3>Candidate Pair</h3>
              <dl v-if="pairRows.length" class="webrtc-stat-list">
                <template v-for="[label, value] in pairRows" :key="label"><dt>{{ label }}</dt><dd>{{ value }}</dd></template>
              </dl>
              <p v-else class="webrtc-stats-empty">No selected candidate pair yet.</p>
            </section>
            <section class="webrtc-stat-card">
              <h3>Inbound · RX</h3>
              <dl v-if="inboundRows.length" class="webrtc-stat-list">
                <template v-for="[label, value] in inboundRows" :key="label"><dt>{{ label }}</dt><dd>{{ value }}</dd></template>
              </dl>
              <p v-else class="webrtc-stats-empty">No inbound audio.</p>
            </section>
            <section class="webrtc-stat-card">
              <h3>Outbound · TX</h3>
              <dl v-if="outboundRows.length" class="webrtc-stat-list">
                <template v-for="[label, value] in outboundRows" :key="label"><dt>{{ label }}</dt><dd>{{ value }}</dd></template>
              </dl>
              <p v-else class="webrtc-stats-empty">No outbound audio (mic not keyed).</p>
            </section>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.webrtc-stats-modal { width: 560px; max-width: calc(100vw - 24px); }
</style>
