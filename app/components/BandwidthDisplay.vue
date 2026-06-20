<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  mode: string | null
  bandwidth: number | null
}>()

const widthKhz = computed<number | null>(() => {
  if (props.bandwidth != null) {
    const value = Number(props.bandwidth)
    if (Number.isFinite(value)) return value >= 1000 ? value / 1000 : value
  }
  if (props.mode === 'FM-N') return 12.5
  if (props.mode === 'FM') return 25
  return null
})

const widthLabel = computed(() => {
  if (widthKhz.value == null) return '--'
  return `${widthKhz.value.toFixed(widthKhz.value % 1 === 0 ? 0 : 1)}k`
})

const fillStyle = computed(() => {
  if (widthKhz.value == null) return { width: '0%' }
  return { width: widthKhz.value <= 12.5 ? '50%' : '100%' }
})
</script>

<template>
  <div class="bw-display" title="AnyTone channel bandwidth">
    <div class="bw-bar">
      <div class="bw-fill" :style="fillStyle" />
    </div>
    <div class="bw-value">{{ widthLabel }}</div>
    <div class="bw-label">CHANNEL WIDTH</div>
  </div>
</template>

<style scoped>
.bw-display {
  display: flex;
  flex-direction: column;
  align-self: center;
  gap: 3px;
  min-width: 88px;
  margin-left: 10px;
  opacity: 0.86;
}

.bw-bar {
  position: relative;
  height: 12px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  overflow: hidden;
}

.bw-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  background: rgb(181, 150, 94);
  border-right: 1px solid rgba(237, 182, 99, 0.75);
}

.bw-value {
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 1;
  color: #63b3ed;
  text-align: center;
  white-space: nowrap;
}

.bw-label {
  font-size: 8px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  text-align: center;
  opacity: 0.55;
  pointer-events: none;
}
</style>
