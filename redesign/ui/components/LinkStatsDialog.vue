<script setup lang="ts">
// Link diagnostics behind the footer's Link readout: totals, the ARQ config, and the per-event
// history (which commands were retransmitted / failed, framing discards) — with a Copy button
// that emits the whole report as JSON for pasting into an issue or a chat.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRadio, type LinkReport } from '../composables/useRadio'

const emit = defineEmits<{ close: [] }>()
const radio = useRadio()

const report = ref<LinkReport | null>(null)
const error = ref<string | null>(null)
const copied = ref(false)

async function load(): Promise<void> {
  error.value = null
  try {
    report.value = await radio.linkStats()
  } catch (e) {
    error.value = (e as { message?: string })?.message ?? String(e)
  }
}

async function copyJson(): Promise<void> {
  if (!report.value) return
  const text = JSON.stringify(report.value, null, 2)
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    setTimeout(() => (copied.value = false), 1600)
  } catch {
    // clipboard API needs a secure context / permission — fall back to a selectable textarea
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      copied.value = true
      setTimeout(() => (copied.value = false), 1600)
    } finally {
      ta.remove()
    }
  }
}

const fmtTime = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour12: false })
const KIND_LABEL: Record<string, string> = { retransmit: 'RETRY', failed: 'FAIL', framing: 'FRAME' }

const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  void load()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="tone-modal-backdrop" @click.self="emit('close')">
      <div class="tone-modal link-stats-modal" role="dialog" aria-modal="true" aria-label="Link statistics">
        <div class="tone-modal-header">
          <span class="tone-modal-title">Link Statistics</span>
          <span class="link-stats-head-actions">
            <button type="button" class="btn btn-sm btn-ghost" title="Re-fetch" @click="load">Refresh</button>
            <button type="button" class="btn btn-sm btn-ghost" :disabled="!report" title="Copy the full report as JSON" @click="copyJson">
              {{ copied ? 'Copied ✓' : 'Copy JSON' }}
            </button>
            <button type="button" class="tone-modal-close" aria-label="Close" @click="emit('close')">✕</button>
          </span>
        </div>

        <div class="link-stats-body">
          <p v-if="error" class="link-stats-error">{{ error }}</p>
          <template v-else-if="report">
            <section class="webrtc-stat-card">
              <h3>Session</h3>
              <dl class="webrtc-stat-list">
                <dt>Connection</dt>
                <dd>{{ report.connection }}<template v-if="report.address"> · {{ report.address }}</template></dd>
                <dt>Session started</dt>
                <dd>{{ report.sessionStartedAt ? new Date(report.sessionStartedAt).toLocaleString() : '—' }}</dd>
                <dt>Retransmits</dt>
                <dd>{{ report.metrics.retransmits }}</dd>
                <dt>Failed commands</dt>
                <dd>{{ report.metrics.failed }}</dd>
                <dt>Framing incidents</dt>
                <dd>{{ report.metrics.framingIncidents }}</dd>
                <dt>ARQ config</dt>
                <dd>timeout {{ report.linkConfig.timeoutMs }} ms · {{ report.linkConfig.maxAttempts }} attempts · gap {{ report.linkConfig.gapMs }} ms<template v-if="report.linkConfig.rxQuietMs"> · RX-quiet {{ report.linkConfig.rxQuietMs }} ms</template></dd>
              </dl>
            </section>

            <section class="webrtc-stat-card">
              <h3>Events <span class="link-stats-count">{{ report.events.length }}</span></h3>
              <p v-if="!report.events.length" class="link-stats-empty">
                Nothing noteworthy — no retransmits, failures, or framing discards this session.
              </p>
              <div v-else class="link-stats-events">
                <div v-for="(ev, i) in [...report.events].reverse()" :key="i" class="link-stats-event">
                  <span class="link-stats-ev-time">{{ fmtTime(ev.at) }}</span>
                  <span class="link-stats-ev-kind" :class="`link-stats-ev-kind--${ev.kind}`">{{ KIND_LABEL[ev.kind] ?? ev.kind }}</span>
                  <span class="link-stats-ev-what">
                    <template v-if="ev.kind === 'framing'">{{ ev.detail }}</template>
                    <template v-else>
                      {{ ev.command }}
                      <template v-if="ev.attempt"> · attempt {{ ev.attempt }}</template>
                      <template v-if="ev.reason"> · {{ ev.reason }}</template>
                      <span v-if="ev.frame" class="link-stats-ev-frame">{{ ev.frame }}</span>
                    </template>
                  </span>
                </div>
              </div>
            </section>
          </template>
          <p v-else class="link-stats-empty">Loading…</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.link-stats-modal { width: 560px; max-width: calc(100vw - 24px); }
.link-stats-head-actions { display: inline-flex; align-items: center; gap: 6px; }
.link-stats-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px 14px 16px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.link-stats-error { margin: 0; color: var(--red, #f85149); font-size: 12px; }
.link-stats-empty { margin: 0; font-size: 12px; color: var(--text-muted, #8b949e); }
.link-stats-count {
  margin-left: 6px; padding: 1px 7px; border-radius: 999px;
  background: var(--surface-2, #21262d); color: var(--text-muted, #8b949e);
  font-size: 10px; font-weight: 700;
}
.link-stats-events { display: flex; flex-direction: column; gap: 4px; max-height: 40vh; overflow-y: auto; }
.link-stats-event {
  display: flex; align-items: baseline; gap: 8px;
  font-size: 12px; padding: 4px 6px; border-radius: 6px;
  background: var(--surface, #0d1117);
}
.link-stats-ev-time { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted, #8b949e); flex: none; }
.link-stats-ev-kind {
  flex: none; font-size: 9px; font-weight: 800; letter-spacing: .05em;
  padding: 1px 6px; border-radius: 4px;
}
.link-stats-ev-kind--retransmit { background: rgba(210, 153, 34, .18); color: #d29922; }
.link-stats-ev-kind--failed { background: rgba(248, 81, 73, .18); color: #f85149; }
.link-stats-ev-kind--framing { background: rgba(139, 148, 158, .18); color: #b6bec8; }
.link-stats-ev-what { min-width: 0; overflow-wrap: anywhere; }
.link-stats-ev-frame {
  display: block; font-family: var(--font-mono); font-size: 10px;
  color: var(--text-muted, #8b949e); margin-top: 1px;
}
</style>
