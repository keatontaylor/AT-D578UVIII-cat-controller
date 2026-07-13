<template>
  <div
    class="badge"
    :class="{ 'badge--clickable': clickable && !disabled, 'badge--busy': busy, 'badge--failed': failed, 'badge--disabled': disabled }"
    :style="badgeStyle"
    :role="clickable ? 'button' : undefined"
    :tabindex="clickable && !disabled ? 0 : undefined"
    :aria-disabled="clickable && disabled ? 'true' : undefined"
    :title="clickable && !disabled ? `Change ${label}` : undefined"
    @click="clickable && !disabled && !busy && emit('toggle')"
    @keydown.enter.space.prevent="clickable && !disabled && !busy && emit('toggle')"
  >
    <span class="badge-label">
      <span class="badge-label-text">{{ label }}</span>
      <span v-if="failed" class="badge-fail-mark" title="Change not confirmed">!</span>
      <span v-else-if="clickable || hint" class="badge-toggle-hint">{{ active ? '◉' : '○' }}</span>
    </span>
    <span class="badge-value" :title="busy ? undefined : value">
      <span v-if="busy" class="badge-spinner">⟳</span>
      <template v-else>{{ value }}</template>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  label: string
  value: string
  active?: boolean
  colorActive?: string
  clickable?: boolean
  /** Show the ○/◉ affordance dot without making the badge itself handle clicks — for badges
   * inside a clickable wrapper (.ctl-box), so every editable grid tile reads the same. */
  hint?: boolean
  busy?: boolean
  disabled?: boolean
  /** The last change to this value was not confirmed by the radio. */
  failed?: boolean
}>()

const emit = defineEmits<{
  toggle: []
}>()

const badgeStyle = computed(() => {
  if (props.failed) return {} // red styling comes from .badge--failed
  if (props.active) {
    const color = props.colorActive ?? '#f59e0b'
    return {
      borderColor: color,
      background: color + '18',
    }
  }
  return {}
})
</script>

<style scoped>
.badge {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  padding: 6px 12px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  min-width: 85px;
  max-width: 100%; /* never wider than the tile that holds it */
  transition: border-color .2s, background .2s;
  user-select: none;
}

.badge--clickable {
  cursor: pointer;
}
@media (hover: hover) {
  .badge--clickable:hover:not(.badge--busy) {
  border-color: #58a6ff;
  background: rgba(88, 166, 255, .08);
}
}


.badge--clickable:focus-visible {
  outline: 2px solid #58a6ff;
  outline-offset: 2px;
}

.badge--busy {
  cursor: wait;
  opacity: .7;
}

.badge--disabled {
  cursor: not-allowed;
  opacity: .5;
}

.badge--failed {
  border-color: #f85149 !important;
  background: rgba(248, 81, 73, .1) !important;
}

.badge-fail-mark {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #f85149;
  color: #0d1117;
  font-size: 9px;
  font-weight: 800;
}

.badge-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: #8b949e;
  font-weight: 600;
  margin-bottom: 3px;
  display: flex;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  min-width: 0;
}

/* Long labels/values truncate INSIDE the tile instead of blowing it out (mobile-critical). */
.badge-label-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.badge-toggle-hint {
  font-size: 9px;
  opacity: .7;
  flex: none;
}

.badge-value {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 13px;
  font-weight: 700;
  color: #e6edf3;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Narrow screens: the letter-spacing is the first thing to give (an 11-char label at 1.5px
   tracking is ~17px of pure air), then labels/values ellipsize via the rules above. */
@media (max-width: 760px) {
  .badge-label { letter-spacing: .8px; }
}

.badge-spinner {
  display: inline-block;
  animation: spin .8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
