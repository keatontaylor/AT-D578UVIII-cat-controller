<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRadio } from '../composables/useRadio'
import AudioListen from './AudioListen.vue'

const radio = useRadio()
const { state, radios } = radio

const selected = ref<string>('')
const busy = ref(false)
const uiError = ref<string | null>(null)

const connected = computed(() => radio.online.value && state.value?.connection === 'connected')
const connecting = computed(() => radio.online.value && state.value?.connection === 'connecting')
// No controls before the /ws snapshot — a Connect button rendered on unknown state is a lie
// (and its RPC would only queue in the outbox anyway). Mirrors App.vue's hydration gate.
const hydrated = computed(() => radio.online.value && state.value !== null)

// Keep a sensible selection as the shared radio list changes (prefer the configured/paired one).
watch(
  radios,
  (list) => {
    if (!selected.value || !list.some((r) => r.address === selected.value)) {
      selected.value = list.find((r) => r.configured)?.address ?? list.find((r) => r.paired)?.address ?? list[0]?.address ?? ''
    }
  },
  { immediate: true },
)

function dismissError(): void {
  uiError.value = null
  void radio.dismissError().catch(() => {}) // also clear the persistent server-side error
}

async function toggle(): Promise<void> {
  busy.value = true
  uiError.value = null
  try {
    if (connected.value) await radio.disconnect()
    else if (selected.value) await radio.connect(selected.value)
  } catch (e) {
    uiError.value = (e as { message?: string })?.message ?? String(e)
  } finally {
    busy.value = false
  }
}

onMounted(() => void radio.refreshRadios())
</script>

<template>
  <header class="header">
    <div class="header-brand">
      <span class="brand-logo">AT-D578UVIII</span>
      <span class="brand-sub">Bluetooth Controller</span>
    </div>

    <div v-if="hydrated" class="conn-bar">
      <select v-model="selected" class="sel" :disabled="connected || connecting">
        <option v-if="!radios.length" value="">No radios — Scan</option>
        <option v-for="r in radios" :key="r.address" :value="r.address">
          {{ r.name || r.address }}{{ r.paired ? '' : ' (unpaired)' }}
        </option>
      </select>
      <button
        class="btn"
        :class="connected ? 'btn-danger' : 'btn-primary'"
        :disabled="busy || connecting || (!connected && !selected)"
        @click="toggle"
      >
        {{ connecting ? '…' : connected ? 'Disconnect' : 'Connect' }}
      </button>
    </div>

    <AudioListen v-if="connected" />
  </header>

  <div v-if="uiError || state?.error" class="error-banner">
    {{ uiError || state?.error }}
    <button class="close-btn" @click="dismissError">✕</button>
  </div>
</template>
