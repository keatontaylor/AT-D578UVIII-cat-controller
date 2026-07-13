<script setup lang="ts">
// Option picker for one radio setting (styled after the PoC's tone-modal). Lists every option,
// marks the current one, describes what the setting does, and — while a write for this setting is
// in flight — shows which option is pending. Picking an option emits it; the pending/failed state
// flows back through RadioState.
import { onMounted, onBeforeUnmount } from 'vue'
import { optionDisplay } from '../lib/settings'

const props = defineProps<{
  label: string
  description: string
  options: string[]
  current: string
  /** Desired value of an in-flight write for this setting, or null when settled. */
  pending: string | null
  /** True when the last write for this setting failed (radio didn't ack). */
  failed: boolean
  /** Option → its tile status color (settingValueColor), for the swatch dot beside each option.
   * Omit for pickers whose values carry no color (VFO/MEM etc.) — no swatches render. */
  colorFor?: (option: string) => string | null
}>()

const emit = defineEmits<{ select: [value: string]; close: [] }>()

const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="tone-modal-backdrop" @click.self="emit('close')">
      <div class="tone-modal setting-modal" role="dialog" aria-modal="true" :aria-label="label">
        <div class="tone-modal-header">
          <span class="tone-modal-title">{{ label }}</span>
          <button class="tone-modal-close" aria-label="Close" @click="emit('close')">✕</button>
        </div>

        <p v-if="description" class="setting-desc">{{ description }}</p>

        <p v-if="failed" class="setting-status setting-status--failed">
          Last change wasn’t confirmed by the radio — pick again to retry.
        </p>
        <p v-else-if="pending" class="setting-status setting-status--pending">
          <span class="setting-spin">⟳</span> Setting <strong>{{ optionDisplay(pending) }}</strong> — waiting for the radio…
        </p>

        <div class="setting-edit-enum">
          <button
            v-for="opt in options"
            :key="opt"
            class="setting-enum-btn"
            :class="{
              'setting-enum-btn--active': opt === current && !pending,
              'setting-enum-btn--pending': opt === pending,
            }"
            :disabled="!!pending"
            @click="emit('select', opt)"
          >
            <span class="setting-enum-label">
              <span
                v-if="colorFor"
                class="setting-enum-swatch"
                :class="{ 'setting-enum-swatch--none': !colorFor(opt) }"
                :style="colorFor(opt) ? { background: colorFor(opt)! } : undefined"
              ></span>
              {{ optionDisplay(opt) }}
            </span>
            <span v-if="opt === pending" class="setting-enum-spin">⟳</span>
            <span v-else-if="opt === current" class="setting-enum-check">✓</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tone-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, .65);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.tone-modal {
  background: var(--surface, #161b22);
  border: 1px solid var(--border, #505152);
  border-radius: var(--radius, 8px);
  box-shadow: 0 16px 48px rgba(0, 0, 0, .85);
  width: 320px;
  max-width: calc(100vw - 24px);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tone-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 9px;
  border-bottom: 1px solid var(--border, #505152);
  flex-shrink: 0;
}
.tone-modal-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .07em;
  color: var(--text-muted, #8b949e);
}
.tone-modal-close {
  background: none;
  border: none;
  color: var(--text-muted, #8b949e);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background .1s, color .1s;
}
@media (hover: hover) {
  .tone-modal-close:hover { background: rgba(255, 255, 255, .1); color: var(--text, #e6edf3); }
}


.setting-desc {
  margin: 0;
  padding: 11px 14px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-muted, #8b949e);
  border-bottom: 1px solid var(--border, #505152);
}
.setting-status {
  margin: 0;
  padding: 8px 14px;
  font-size: 12px;
  border-bottom: 1px solid var(--border, #505152);
}
.setting-status--pending { color: var(--yellow, #d29922); }
.setting-status--failed { color: var(--red, #f85149); }
.setting-spin { display: inline-block; animation: spin .8s linear infinite; }

.setting-edit-enum {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  overflow-y: auto;
}
.setting-enum-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 14px;
  border: 1px solid var(--border, #505152);
  border-radius: 8px;
  background: var(--surface2, #21262d);
  color: var(--text, #e6edf3);
  font-size: 14px;
  cursor: pointer;
  transition: border-color .1s, background .1s;
}
@media (hover: hover) {
  .setting-enum-btn:hover:not(:disabled) { border-color: var(--accent, #58a6ff); }
}

.setting-enum-btn:disabled { opacity: .55; cursor: wait; }
.setting-enum-btn--active { border-color: var(--accent, #58a6ff); }
.setting-enum-btn--pending { border-color: var(--yellow, #d29922); color: var(--yellow, #d29922); }
.setting-enum-label { display: inline-flex; align-items: center; gap: 8px; }
/* Swatch = the color the TILE will take if this option is picked; hollow = neutral value. */
.setting-enum-swatch { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.setting-enum-swatch--none { border: 1px solid var(--border, #505152); }
.setting-enum-check { color: var(--accent, #58a6ff); font-weight: 700; }
.setting-enum-spin { display: inline-block; animation: spin .8s linear infinite; color: var(--yellow, #d29922); }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
