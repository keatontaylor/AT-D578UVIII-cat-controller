<script setup lang="ts">
// The radio reports a coarse 0-4 signal level (byte 1/2 of the 5a frame), the same 4-bar meter
// the radio's own screen shows — NOT a calibrated S-meter (corpus-verified: ~58k 5a frames carry
// only 0-4). So render it honestly as 4 discrete segments rather than fabricating S-units from a
// value we don't have (what the PoC did).
import { computed } from 'vue'

const props = defineProps<{ value: number | null; label?: string }>()

const MAX = 4
const lit = computed(() => (props.value == null ? 0 : Math.max(0, Math.min(MAX, Math.round(props.value)))))
const reading = computed(() => (props.value == null ? '--' : `${lit.value}/${MAX}`))

// Signal-quality coloring: a 1-bar signal is marginal (red), 2 is workable (amber),
// 3-4 is solid copy (green).
function segColor(i: number): string {
  if (i <= 1) return '#f87171'
  if (i <= 2) return '#facc15'
  return '#22c55e'
}
</script>

<template>
  <div class="smeter">
    <div class="smeter-label">{{ label }}</div>
    <div class="smeter-bars" role="meter" :aria-valuenow="lit" aria-valuemin="0" :aria-valuemax="MAX">
      <span v-for="i in MAX" :key="i" class="smeter-seg" :style="i <= lit ? { background: segColor(i) } : undefined" />
    </div>
    <div class="smeter-value"><span class="smeter-reading">{{ reading }}</span></div>
  </div>
</template>

<style scoped>
.smeter {
  margin-top: 8px;
}
.smeter-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #8b949e;
  margin-bottom: 4px;
}
.smeter-bars {
  display: flex;
  gap: 3px;
  height: 14px;
}
.smeter-seg {
  flex: 1;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 2px;
  transition: background 0.15s;
}
.smeter-value {
  margin-top: 4px;
  text-align: right;
}
.smeter-reading {
  font-family: 'SF Mono', monospace;
  font-size: 12px;
  font-weight: 700;
  color: #6e7681;
}
</style>
