<script setup lang="ts">
// Manual DMR dial: enter a target ID/TG + call type. The next PTT on this DMR channel calls the
// dialed target instead of the channel's programmed contact, until cleared. Local override — no
// radio write until you key. Styled after the setting modal.
import { onMounted, onBeforeUnmount, ref } from 'vue'

const props = defineProps<{
  label: string
  current: { target: number; callType: 'group' | 'private' } | null
}>()

const emit = defineEmits<{
  apply: [target: number, callType: 'group' | 'private']
  clear: []
  close: []
}>()

const targetInput = ref(props.current ? String(props.current.target) : '')
const callType = ref<'group' | 'private'>(props.current?.callType ?? 'group')
const inputEl = ref<HTMLInputElement | null>(null)
const error = ref<string | null>(null)

function submit(): void {
  const t = Number(targetInput.value.replace(/\D/g, ''))
  if (!Number.isInteger(t) || t <= 0 || t > 0xffffff) {
    error.value = 'Enter a valid DMR ID / talkgroup'
    return
  }
  emit('apply', t, callType.value)
}

const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  inputEl.value?.focus()
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

        <p class="setting-desc">The next PTT calls the dialed target instead of the channel's programmed contact, until restored.</p>

        <label class="value-field-label" for="dial-target">Target ID / talkgroup</label>
        <input
          id="dial-target"
          ref="inputEl"
          v-model="targetInput"
          class="value-number-input value-number-input--wide"
          type="text"
          inputmode="numeric"
          placeholder="3223436"
          autocomplete="off"
        />

        <div class="dial-calltype">
          <button type="button" class="setting-enum-btn" :class="{ 'setting-enum-btn--active': callType === 'group' }" @click="callType = 'group'">Group</button>
          <button type="button" class="setting-enum-btn" :class="{ 'setting-enum-btn--active': callType === 'private' }" @click="callType = 'private'">Private</button>
        </div>

        <div v-if="error" class="value-hint dial-error">{{ error }}</div>

        <div class="value-actions">
          <button v-if="current" type="button" class="btn btn-ghost" @click="emit('clear')">Clear dial</button>
          <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
          <button type="submit" class="btn btn-primary">Set dial</button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.dial-calltype {
  display: flex;
  gap: 8px;
  padding: 10px 18px 0;
}
.dial-calltype .setting-enum-btn {
  flex: 1;
  justify-content: center;
}
.dial-error { color: var(--red, #f85149); }
</style>
