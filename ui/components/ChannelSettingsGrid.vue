<script setup lang="ts">
// Editable per-channel settings for one side (the 2f family). The canonical current values are
// derived from the decoded channel config; options + descriptions come from the shared
// channel-settings catalogue. The pending/failed overlay flows through side.pendingChannel.
import { computed, onMounted, ref } from 'vue'
import StatusBadge from './StatusBadge.vue'
import SettingDialog from './SettingDialog.vue'
import { useRadio } from '../composables/useRadio'
import { optionDisplay, settingValueColor } from '../lib/settings'
import { CHANNEL_SETTINGS } from '../../src/codec/channel-settings'
import type { ChannelConfig } from '../../src/codec/decode'
import type { PendingSetting } from '../../src/domain/state'

const props = defineProps<{
  side: 'a' | 'b'
  disabled?: boolean
  /** Decoded channel config (canonical current values). */
  config: ChannelConfig | null
  /** In-flight/failed overlay per key (from state.sides[side].pendingChannel). */
  pending: Record<string, PendingSetting>
  /** Native scan running on this side: dims every tile except the Scan tile (matches the radio). */
  scanning?: boolean
}>()

const radio = useRadio()

interface Meta {
  label: string
  options: string[]
  description: string
}
const meta = ref<Record<string, Meta>>(Object.fromEntries(
  CHANNEL_SETTINGS.map((c) => [c.key, { label: c.label, options: [...c.options], description: c.description }]),
))
const order = ref<string[]>(CHANNEL_SETTINGS.map((c) => c.key)) // catalogue order, so the grid layout is stable
const openKey = ref<string | null>(null)

onMounted(async () => {
  try {
    const cat = await radio.channelCatalogue()
    order.value = cat.map((c) => c.key)
    for (const c of cat) meta.value[c.key] = { label: c.label, options: c.options, description: c.description }
  } catch {
    /* offline / not connected — values stay read-only */
  }
})

const values = computed<Record<string, string>>(() => {
  if (!props.config) return {}
  const out: Record<string, string> = {}
  for (const setting of CHANNEL_SETTINGS) {
    const value = setting.read(props.config)
    if (value != null) out[setting.key] = value
  }
  return out
})

interface Item {
  key: string
  label: string
  rawValue: string
  value: string
  options: string[]
  description: string
  rawPending: string | null
  pending: string | null
  failed: boolean
}
const keys = computed(() => {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (key: string) => {
    if (!seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  for (const key of order.value) add(key)
  for (const key of Object.keys(values.value)) add(key)
  for (const key of Object.keys(props.pending ?? {})) add(key)
  return out
})

// Only settings that decode from this channel, rendered in catalogue order; pending-only keys still
// render so failures don't disappear before the user sees them — but ONLY if they are real grid
// settings. The tone/frequency writes also put rxTone/txTone/rxFreq/txFreq into pendingChannel
// (those are VfoCard tiles, NOT grid settings), and a bare phantom tile for them must not appear
// in the grid while a tone/freq save is in flight.
const items = computed<Item[]>(() =>
  keys.value
    .filter((key) => key in values.value || (key in (props.pending ?? {}) && key in meta.value))
    .map((key) => {
      const m = meta.value[key]
      const p = (props.pending ?? {})[key]
      const rawPending = p?.phase === 'pending' ? String(p.desired) : null
      const raw = values.value[key] ?? ''
      return {
        key,
        label: m?.label ?? key,
        rawValue: raw,
        value: optionDisplay(raw),
        options: m?.options ?? [],
        description: m?.description ?? '',
        rawPending,
        pending: rawPending ? optionDisplay(rawPending) : null,
        failed: p?.phase === 'failed',
      }
    }),
)

const openItem = computed<Item | null>(() => items.value.find((i) => i.key === openKey.value) ?? null)

function open(item: Item): void {
  if (!props.disabled && item.options.length) openKey.value = item.key
}
function choose(value: string): void {
  const key = openKey.value
  if (!key || props.disabled) return
  void radio.setChannelSetting(props.side, key, value)
  openKey.value = null
}

/** Status color for a tile — the pending target's color wins so a write-in-flight previews it. */
function tileColor(s: Item): string | null {
  return settingValueColor(s.key, s.rawPending ?? s.rawValue)
}
</script>

<template>
  <section class="status-section channel-settings" :class="{ 'controls-locked': scanning }">
    <!-- Front slot: badges that belong visually first (VFO/MEM toggle, RX/TX tone pickers) but are
         edited through their own dedicated controls rather than the generic option dialog. -->
    <slot name="front" />
    <StatusBadge
      v-for="s in items"
      :key="s.key"
      :label="s.label"
      :value="s.pending ?? s.value"
      :clickable="!!s.options.length"
      :active="!!tileColor(s)"
      :color-active="tileColor(s) ?? undefined"
      :disabled="disabled"
      :busy="!!s.pending"
      :failed="s.failed"
      @toggle="open(s)"
    />
    <!-- Tail slot: extra cards that belong in the grid but aren't 2f channel settings
         (e.g. the Packet TNC toggle on the selected side). -->
    <slot />

    <SettingDialog
      v-if="openItem"
      :label="openItem.label"
      :description="openItem.description"
      :options="openItem.options"
      :current="openItem.rawValue"
      :pending="openItem.rawPending"
      :failed="openItem.failed"
      :color-for="(opt: string) => settingValueColor(openItem!.key, opt)"
      @select="choose"
      @close="openKey = null"
    />
  </section>
</template>
