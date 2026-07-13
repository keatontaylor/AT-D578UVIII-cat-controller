<script setup lang="ts">
// Renders the radio's identity/firmware/clock from RadioState (already decoded; just displayed),
// plus link-health counters (NF5.1) from AppState.metrics — clickable, opening the link-stats
// dialog (per-event retransmit/failure history + copy-as-JSON).
import { computed, ref } from 'vue'
import LinkStatsDialog from './LinkStatsDialog.vue'
import type { RadioState } from '../../src/domain/state'
import type { LinkMetrics } from '../../src/services/radio-service'

const props = defineProps<{ radio: RadioState; metrics?: LinkMetrics | null }>()

const statsOpen = ref(false)

const pad = (n: number): string => String(n).padStart(2, '0')
const clockText = computed(() => {
  const c = props.radio.clock
  if (!c) return null
  const time = `${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)}`
  return c.year != null ? `${c.year}-${pad(c.month!)}-${pad(c.day!)} ${time}` : time
})
const identityText = computed(() => {
  const id = props.radio.identity
  if (!id) return null
  return id.callsign ? `${id.callsign} · ID ${id.dmrId}` : `ID ${id.dmrId}`
})
// Link health: only shown once something noteworthy has happened (a clean link reads "Link OK").
const linkText = computed(() => {
  const m = props.metrics
  if (!m) return null
  const parts: string[] = []
  if (m.retransmits) parts.push(`R:${m.retransmits}`)
  if (m.failed) parts.push(`F:${m.failed}`)
  if (m.framingIncidents) parts.push(`I:${m.framingIncidents}`)
  return parts.length ? `Link ${parts.join(' ')}` : 'Link OK'
})
</script>

<template>
  <footer class="footer">
    <span class="footer-fw">
      AT-D578UVIII<template v-if="radio.firmware"> · Firmware: {{ radio.firmware }}</template
      ><template v-if="identityText"> · {{ identityText }}</template
      ><template v-if="clockText"> · {{ clockText }}</template
      ><template v-if="linkText"> ·
        <button
          type="button"
          class="footer-link-btn"
          :class="{ 'footer-link-warn': metrics && (metrics.failed || metrics.framingIncidents) }"
          title="Link statistics — retransmits, failures, framing incidents"
          @click="statsOpen = true"
        >{{ linkText }}</button>
      </template>
    </span>

    <LinkStatsDialog v-if="statsOpen" @close="statsOpen = false" />
  </footer>
</template>

<style scoped>
.footer-link-btn {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}
@media (hover: hover) {
  .footer-link-btn:hover { color: var(--accent, #58a6ff); }
}
.footer-link-btn:focus-visible { outline: 2px solid var(--accent, #58a6ff); outline-offset: 2px; border-radius: 3px; }
.footer-link-warn { color: var(--yellow, #d29922); }
</style>
