<script setup lang="ts">
// A range slider in the app's design language (companion to AppSelect): filled accent track up
// to the thumb, dark rail after it — replacing the browser-default look, which ignores the dark
// theme. Still a real <input type="range"> underneath, so keyboard/touch/a11y come free.
import { computed } from 'vue'

const props = defineProps<{
  modelValue: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  title?: string
  ariaLabel?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

// filled-fraction drives the WebKit track gradient (Firefox has ::-moz-range-progress instead)
const pct = computed(() => {
  const span = props.max - props.min
  if (span <= 0) return 0
  return Math.min(100, Math.max(0, ((props.modelValue - props.min) / span) * 100))
})

function onInput(e: Event): void {
  emit('update:modelValue', Number((e.target as HTMLInputElement).value))
}
</script>

<template>
  <input
    class="app-slider"
    type="range"
    :value="modelValue"
    :min="min"
    :max="max"
    :step="step ?? 1"
    :disabled="disabled"
    :title="title"
    :aria-label="ariaLabel"
    :style="{ '--pct': pct + '%' }"
    @input="onInput"
  />
</template>

<style scoped>
.app-slider {
  -webkit-appearance: none;
  appearance: none;
  height: 18px; /* touch target; the drawn rail is the 4px gradient below */
  background: transparent;
  cursor: pointer;
  margin: 0;
}
.app-slider:disabled { cursor: not-allowed; opacity: .45; }

/* WebKit: the track carries the filled/unfilled gradient split at --pct. */
.app-slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(
    to right,
    var(--accent, #58a6ff) 0%,
    var(--accent, #58a6ff) var(--pct),
    rgba(255, 255, 255, .12) var(--pct),
    rgba(255, 255, 255, .12) 100%
  );
}
.app-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -5px; /* center on the 4px track */
  border-radius: 50%;
  background: var(--text, #e6edf3);
  border: 2px solid var(--accent, #58a6ff);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .5);
  transition: transform .08s;
}
.app-slider:focus-visible::-webkit-slider-thumb { transform: scale(1.15); }
@media (hover: hover) {
  .app-slider:hover::-webkit-slider-thumb { transform: scale(1.15); }
}


/* Firefox: native progress pseudo-element — no gradient needed. */
.app-slider::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, .12);
}
.app-slider::-moz-range-progress {
  height: 4px;
  border-radius: 2px;
  background: var(--accent, #58a6ff);
}
.app-slider::-moz-range-thumb {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text, #e6edf3);
  border: 2px solid var(--accent, #58a6ff);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .5);
}

.app-slider:focus-visible {
  outline: 2px solid var(--accent, #58a6ff);
  outline-offset: 2px;
  border-radius: 4px;
}
</style>
