<script setup lang="ts">
// Per-side volume knob (08 4a — RE'd from a BT-01 relay capture of the physical knob). With RX
// audio on the WIRED rear jack, this is the capture input level (the jack follows the knob) —
// which is why it lives in the grid. (It does nothing audible for BT listening: the BT path has
// its own gain staging. Removed once for that reason; restored for the wired era.)
// Write-only on the wire: state shows the last level WE set ('—' until the first adjustment).
import { computed, ref, watch } from 'vue'
import StatusBadge from './StatusBadge.vue'
import AppSlider from './AppSlider.vue'
import { useRadio } from '../composables/useRadio'

const props = defineProps<{ side: 'a' | 'b'; disabled?: boolean }>()
const radio = useRadio()

const open = ref(false)
const level = ref(8)
const error = ref<string | null>(null)

const stateLevel = computed<number | null>(() => radio.state.value?.radio?.sides?.[props.side]?.volume ?? null)
watch(stateLevel, (v) => {
  if (v != null) level.value = v
}, { immediate: true })

const badgeValue = computed(() => (stateLevel.value == null ? '—' : String(stateLevel.value)))

function openDialog(): void {
  if (!props.disabled) open.value = true
}

// Debounced live apply — dragging the slider streams at most ~4 writes/s to the radio.
let timer: number | undefined
function onInput(): void {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    error.value = null
    void radio.setVolume(props.side, level.value).catch((e: unknown) => {
      error.value = (e as { message?: string })?.message ?? String(e)
    })
  }, 250)
}
</script>

<template>
  <div
    class="ctl-box"
    :class="{ 'ctl-box--disabled': disabled }"
    role="button"
    :tabindex="disabled ? undefined : 0"
    :aria-disabled="disabled ? 'true' : undefined"
    title="Volume — this side's knob level (the wired audio capture level)"
    @click.stop="openDialog"
    @keydown.enter.space.prevent="openDialog"
  >
    <StatusBadge label="Volume" :value="badgeValue" :disabled="disabled" clickable @toggle="openDialog" />
  </div>

  <Teleport to="body">
    <div v-if="open" class="tone-modal-backdrop" @click.self="open = false">
      <div class="tone-modal volume-modal" role="dialog" aria-modal="true" aria-label="Side volume">
        <div class="tone-modal-header">
          <span class="tone-modal-title">Volume — side {{ side.toUpperCase() }}</span>
          <button type="button" class="tone-modal-close" aria-label="Close" @click="open = false">✕</button>
        </div>
        <div class="volume-body">
          <p class="volume-hint">
            The radio's volume knob for this side. With RX audio on the rear jack this sets the
            level into the wired capture — for packet, aim the TNC card's RX audio level at ~50.
          </p>
          <label class="volume-slider">
            <AppSlider v-model="level" :min="0" :max="31" class="volume-range" aria-label="Side volume" @update:model-value="onInput" />
            <span class="volume-value">{{ level }}</span>
          </label>
          <span v-if="error" class="volume-error">{{ error }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.volume-modal { width: 340px; max-width: calc(100vw - 24px); }
.volume-body {
  display: flex; flex-direction: column; gap: 14px;
  padding: 12px 14px 16px;
}
.volume-hint { font-size: 12px; line-height: 1.5; color: var(--text-muted, #8b949e); margin: 0; }
.volume-slider { display: flex; align-items: center; gap: 12px; }
.volume-slider .volume-range { flex: 1; }
.volume-value { font-family: var(--font-mono, monospace); font-size: 16px; font-weight: 700; min-width: 2ch; text-align: right; }
.volume-error { color: #f85149; font-size: 12px; }
</style>
