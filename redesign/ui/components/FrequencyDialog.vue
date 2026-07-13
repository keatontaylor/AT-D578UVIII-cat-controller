<script setup lang="ts">
// Direct frequency entry for one side's working RX or TX frequency — markup and behavior match
// the PoC's value-modal editor (global .tone-modal/.value-* classes from app.css). Accepts MHz
// or raw Hz (values ≥ 1000 are Hz, like the PoC). Both writes are live-validated (RX 2f 03,
// TX 2f 04); pending/failed state flows back through RadioState (pendingChannel rxFreq/txFreq).
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'

const props = defineProps<{
  label: string
  field: 'rx' | 'tx'
  /** The current displayed frequency in MHz (prefills the input), or null when unknown. */
  currentMHz: number | null
  /** Desired value (MHz string) of an in-flight write for this field, or null when settled. */
  pending: string | null
  /** True when the last write for this field failed (radio didn't ack). */
  failed: boolean
}>()

const emit = defineEmits<{ select: [hz: number]; close: [] }>()

const input = ref(props.currentMHz != null ? props.currentMHz.toFixed(6) : '')
const inputEl = ref<HTMLInputElement | null>(null)
const error = ref<string | null>(null)

// Radio-enforced bounds in Hz (mirror the codec validators — src/codec/commands.ts).
const MIN_HZ = props.field === 'rx' ? 100_000 : 30_000
const MAX_HZ = props.field === 'rx' ? 999_999_990 : 470_000_000

/** PoC parse rule: strip commas; < 1000 reads as MHz, otherwise raw Hz. */
function parseFrequencyInput(value: string): number | null {
  const normalized = value.trim().replace(/,/g, '')
  if (!normalized) return null
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) return null
  return Math.round(parsed >= 1000 ? parsed : parsed * 1_000_000)
}

const busy = computed(() => !!props.pending)

function submit(): void {
  if (busy.value) return
  const hz = parseFrequencyInput(input.value)
  if (hz == null || hz < MIN_HZ || hz > MAX_HZ) {
    error.value = 'Enter a valid frequency in MHz'
    return
  }
  error.value = null
  emit('select', hz)
}

const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  inputEl.value?.focus()
  inputEl.value?.select()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="tone-modal-backdrop" @click.self="emit('close')">
      <form class="tone-modal value-modal" role="dialog" aria-modal="true" :aria-label="label" @submit.prevent="submit">
        <div class="tone-modal-header">
          <span class="tone-modal-title">{{ label }}</span>
          <button type="button" class="tone-modal-close" aria-label="Close" @click="emit('close')">✕</button>
        </div>

        <label class="value-field-label" for="frequency-entry">{{ field === 'tx' ? 'TX frequency' : 'Frequency' }} in MHz</label>
        <input
          id="frequency-entry"
          ref="inputEl"
          v-model="input"
          class="value-number-input value-number-input--wide"
          type="text"
          inputmode="decimal"
          :placeholder="field === 'tx' ? '467.675000' : '438.625000'"
          autocomplete="off"
          spellcheck="false"
          :disabled="busy"
        />
        <div class="value-hint">
          Examples: <code>438.625</code>, <code>145.310</code>, or raw Hz.
          {{ field === 'tx' ? 'Writes the TX frequency to this side (2f 04).' : '' }}
        </div>
        <div v-if="error" class="value-hint freq-error">{{ error }}</div>
        <div v-else-if="failed" class="value-hint freq-error">Last change wasn’t confirmed by the radio — try again.</div>
        <div v-else-if="pending" class="value-hint freq-pending">
          <span class="freq-pending-spin">⟳</span> Setting <strong>{{ pending }} MHz</strong> — waiting for the radio…
        </div>

        <div class="value-actions">
          <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="busy">{{ field === 'tx' ? 'Set TX' : 'Set' }}</button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.freq-error { color: var(--red, #f85149); }
.freq-pending { color: var(--yellow, #d29922); }
</style>
