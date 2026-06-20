<template>
  <div class="level-bar">
    <div class="level-label">{{ label }}</div>
    <div
      class="level-track"
      :class="{ 'level-track--clickable': clickable }"
      @click="clickable ? handleClick($event) : undefined"
    >
      <div
        class="level-fill"
        :style="{ transform: `scaleX(${fillPercent / 100})`, background: fillColor }"
      />
      <div v-if="clickable && dragging" class="level-cursor" :style="{ left: cursorPct + '%' }" />
    </div>
    <div class="level-value">{{ value != null ? value : '--' }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  value: number | null
  label: string
  max?: number
  color?: string
  clickable?: boolean
}>()

const emit = defineEmits<{
  (e: 'update', value: number): void
}>()

const maxVal = computed(() => props.max ?? 255)

const fillPercent = computed(() => {
  if (props.value == null) return 0
  return Math.max(0, Math.min(100, (props.value / maxVal.value) * 100))
})

const fillColor = computed(() =>
  props.color ?? 'linear-gradient(90deg, #3b82f6, #60a5fa)'
)

// ── Click handling ──────────────────────────────────────

const dragging = ref(false)
const cursorPct = ref(0)

function handleClick(e: MouseEvent) {
  const track = e.currentTarget as HTMLElement
  const rect = track.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const newVal = Math.round(pct * maxVal.value)
  cursorPct.value = pct * 100
  dragging.value = true
  setTimeout(() => { dragging.value = false }, 400)
  emit('update', newVal)
}
</script>

<style scoped>
.level-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.level-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #8b949e;
  white-space: nowrap;
  width: 49px;
  flex-shrink: 0;
}

.level-track {
  flex: 1;
  height: 7px;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 3px;
  overflow: hidden;
  position: relative;
}

.level-track--clickable {
  cursor: pointer;
  overflow: visible;
}

.level-track--clickable:hover {
  border-color: #6e7681;
}

.level-fill {
  width: 100%;
  height: 100%;
  border-radius: 3px;
  transform: scaleX(0);
  transform-origin: left center;
  pointer-events: none;
}

.level-cursor {
  position: absolute;
  top: -3px;
  width: 2px;
  height: 13px;
  background: #fff;
  border-radius: 1px;
  transform: translateX(-50%);
  opacity: 0;
  animation: cursor-flash .4s ease-out forwards;
  pointer-events: none;
}

@keyframes cursor-flash {
  0%   { opacity: 1; }
  70%  { opacity: 1; }
  100% { opacity: 0; }
}

.level-value {
  font-size: 9px;
  font-family: 'SF Mono', monospace;
  color: #8b949e;
  width: 24px;
  text-align: right;
  flex-shrink: 0;
}
</style>
