<script setup lang="ts">
// Startup progress stepper — renders AppState.phase as an ordered checklist while connecting.
import { computed } from 'vue'
import type { ConnectPhase } from '../../src/services/radio-service'

const props = defineProps<{ phase: ConnectPhase | null }>()

const STEPS: { key: ConnectPhase; label: string }[] = [
  { key: 'bluetooth', label: 'Connecting Bluetooth' },
  { key: 'handshake', label: 'Starting COM mode' },
  { key: 'info', label: 'Reading radio info' },
  { key: 'settings', label: 'Fetching settings' },
  { key: 'channels', label: 'Fetching channel state' },
  { key: 'status', label: 'Reading live status' },
]

// −1 (phase unknown/null) reads as "all done" so the list shows complete on hand-off to connected.
const currentIndex = computed(() => STEPS.findIndex((s) => s.key === props.phase))
function state(i: number): 'done' | 'active' | 'pending' {
  const cur = currentIndex.value
  if (cur < 0 || i < cur) return 'done'
  return i === cur ? 'active' : 'pending'
}
</script>

<template>
  <div class="connect-progress" role="list" aria-label="Startup progress">
    <div v-for="(s, i) in STEPS" :key="s.key" class="connect-step" :class="`connect-step--${state(i)}`" role="listitem">
      <span class="connect-step-dot">
        <span v-if="state(i) === 'done'" class="connect-step-check">✓</span>
        <span v-else-if="state(i) === 'active'" class="connect-step-spin" />
      </span>
      <span class="connect-step-label">{{ s.label }}</span>
    </div>
  </div>
</template>

<style scoped>
.connect-progress {
  display: inline-flex;
  flex-direction: column;
  gap: 14px;
  text-align: left;
}
.connect-step {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  transition: opacity 0.2s;
}
.connect-step-dot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.connect-step--done .connect-step-dot {
  border-color: #c35910;
  background: #c35910;
  color: #fff;
}
.connect-step--done .connect-step-label {
  color: var(--text-muted);
}
.connect-step-check {
  font-size: 12px;
  line-height: 1;
}
.connect-step--active .connect-step-dot {
  border-color: #c35910;
}
.connect-step--active .connect-step-label {
  color: var(--text);
  font-weight: 600;
}
.connect-step--pending {
  opacity: 0.45;
}
.connect-step-spin {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid rgba(249, 115, 22, 0.35);
  border-top-color: #f97316;
  animation: connect-spin 0.7s linear infinite;
}
@keyframes connect-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
