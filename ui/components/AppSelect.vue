<script setup lang="ts" generic="T extends string | number">
// A dropdown in the app's own design language, replacing native <select> where the OS-drawn
// option list clashes with the dark UI (the browser can't style it). Same interaction contract:
// v-model, keyboard (Enter/Space/Escape/arrows), closes on outside click. Options are
// {value, label}; the trigger renders like a compact .btn, the list like the setting-enum panel.
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  options: ReadonlyArray<{ value: T; label: string }>
  modelValue: T
  /** Accessible name for the listbox (the visible label usually sits outside). */
  ariaLabel?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T] }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
/** Index the keyboard is on while the list is open (starts at the current value). */
const cursor = ref(0)

const currentLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? String(props.modelValue),
)

// A trigger in the right half of the viewport opens its list right-aligned so the list can't
// overflow the screen edge (the Channel filter sits at the far right on phones).
const alignRight = ref(false)

function toggle(): void {
  open.value = !open.value
  if (open.value) {
    cursor.value = Math.max(0, props.options.findIndex((o) => o.value === props.modelValue))
    const rect = root.value?.getBoundingClientRect()
    alignRight.value = !!rect && rect.left + rect.width / 2 > window.innerWidth / 2
  }
}
function choose(value: T): void {
  emit('update:modelValue', value)
  open.value = false
}
function onKey(e: KeyboardEvent): void {
  if (!open.value) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      toggle()
    }
    return
  }
  if (e.key === 'Escape') open.value = false
  else if (e.key === 'ArrowDown') cursor.value = Math.min(cursor.value + 1, props.options.length - 1)
  else if (e.key === 'ArrowUp') cursor.value = Math.max(cursor.value - 1, 0)
  else if (e.key === 'Enter' || e.key === ' ') {
    const opt = props.options[cursor.value]
    if (opt) choose(opt.value)
  } else return
  e.preventDefault()
}

// outside click closes — listener only lives while open
function onDocClick(e: MouseEvent): void {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}
watch(open, (o) => {
  if (o) document.addEventListener('mousedown', onDocClick)
  else document.removeEventListener('mousedown', onDocClick)
})
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick))
</script>

<template>
  <div ref="root" class="app-select" @keydown="onKey">
    <button
      type="button"
      class="app-select-trigger"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-label="ariaLabel"
      @click.stop="toggle"
    >
      <span class="app-select-value">{{ currentLabel }}</span>
      <span class="app-select-caret" :class="{ 'app-select-caret--open': open }">▾</span>
    </button>
    <div v-if="open" class="app-select-list" :class="{ 'app-select-list--right': alignRight }" role="listbox" :aria-label="ariaLabel">
      <button
        v-for="(opt, i) in options"
        :key="String(opt.value)"
        type="button"
        class="app-select-opt"
        :class="{ 'app-select-opt--active': opt.value === modelValue, 'app-select-opt--cursor': i === cursor }"
        role="option"
        :aria-selected="opt.value === modelValue"
        @click.stop="choose(opt.value)"
        @mousemove="cursor = i"
      >
        <span>{{ opt.label }}</span>
        <span v-if="opt.value === modelValue" class="app-select-check">✓</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.app-select { position: relative; display: inline-flex; }
.app-select-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 10px;
  background: var(--surface2, #21262d);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  color: var(--text, #e6edf3);
  font-size: 12px;
  cursor: pointer;
  transition: border-color .1s, background .1s;
}
.app-select-trigger:focus-visible { border-color: var(--accent, #58a6ff); outline: none; }
@media (hover: hover) {
  .app-select-trigger:hover { border-color: var(--accent, #58a6ff); outline: none; }
}

.app-select-value { white-space: nowrap; }
.app-select-caret { font-size: 9px; color: var(--text-muted, #8b949e); transition: transform .12s; }
.app-select-caret--open { transform: rotate(180deg); }

.app-select-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 120;
  min-width: 100%;
  max-width: calc(100vw - 24px);
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  background: var(--surface, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 8px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, .7);
}
.app-select-opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text, #e6edf3);
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.app-select-list--right { left: auto; right: 0; }
.app-select-opt--cursor { background: rgba(88, 166, 255, .1); border-color: rgba(88, 166, 255, .35); }
.app-select-opt--active { color: var(--accent, #58a6ff); }
.app-select-check { color: var(--accent, #58a6ff); font-weight: 700; }
</style>
