<script setup lang="ts">
// A GLOBAL radio setting surfaced as a channel-card grid tile — for settings that live in the
// radio's global menu but only make sense next to a particular channel type (analog squelch on
// analog channels, digital monitor on DMR channels). Reads/writes go through the same global
// settings path as the Radio Settings dialog; the pending overlay comes from pendingSettings.
import { computed, onMounted, ref } from 'vue'
import StatusBadge from './StatusBadge.vue'
import SettingDialog from './SettingDialog.vue'
import { useRadio } from '../composables/useRadio'
import { optionDisplay, settingValueColor } from '../lib/settings'

const props = defineProps<{
  /** Catalogue key of the global setting (e.g. 'analog_squelch_level'). */
  name: string
  /** Tile label (short) and dialog title. */
  label: string
  dialogLabel?: string
  /** Fallbacks shown until the catalogue loads (offline-safe). */
  fallbackOptions: string[]
  fallbackDescription: string
  disabled?: boolean
}>()
const radio = useRadio()

const open = ref(false)
const options = ref<string[]>([...props.fallbackOptions])
const description = ref(props.fallbackDescription)

onMounted(async () => {
  try {
    const cat = await radio.catalogue()
    const def = cat.find((c) => c.name === props.name)
    if (def?.options) options.value = def.options
    if (def?.description) description.value = def.description
  } catch {
    /* offline — defaults stand */
  }
})

const current = computed<string>(() => String(radio.state.value?.radio?.settings?.[props.name] ?? ''))
const pending = computed(() => radio.state.value?.radio?.pendingSettings?.[props.name])
const rawPending = computed(() => (pending.value?.phase === 'pending' ? String(pending.value.desired) : null))
const failed = computed(() => pending.value?.phase === 'failed')
const badgeValue = computed(() => optionDisplay(rawPending.value ?? current.value) || '—')
// Status color (pending target previews) — same value→color language as the channel tiles.
const color = computed(() => settingValueColor(props.name, rawPending.value ?? current.value))

function openDialog(): void {
  if (!props.disabled) open.value = true
}
function choose(value: string): void {
  open.value = false
  void radio.setSetting(props.name, value).catch(() => {})
}
</script>

<template>
  <StatusBadge
    :label="label"
    :value="badgeValue"
    :clickable="true"
    :active="!!color"
    :color-active="color ?? undefined"
    :disabled="disabled"
    :busy="!!rawPending"
    :failed="failed"
    @toggle="openDialog"
  />

  <SettingDialog
    v-if="open"
    :label="dialogLabel ?? label"
    :description="description"
    :options="options"
    :current="current"
    :pending="rawPending"
    :failed="failed"
    :color-for="(opt: string) => settingValueColor(name, opt)"
    @select="choose"
    @close="open = false"
  />
</template>
