<script setup lang="ts">
// Radio Settings popup — replaces the old always-visible settings pane. Settings are grouped the
// way the AT-D578UVIII's own menu tree organizes them (SETTINGS_GROUPS, from the user manual's
// Radio Set walk + the radio's separate Bluetooth/Digital/GPS menus), so knowing the radio means
// knowing this dialog. Editing reuses SettingDialog (pending/failed overlay flows via AppState).
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import StatusBadge from './StatusBadge.vue'
import SettingDialog from './SettingDialog.vue'
import { useRadio } from '../composables/useRadio'
import { CHANNEL_CARD_SETTINGS, optionDisplay, settingLabel, SETTINGS_GROUPS, settingValueColor } from '../lib/settings'

const emit = defineEmits<{ close: [] }>()
const radio = useRadio()

interface Meta {
  options: string[] | null
  description: string
}
const meta = ref<Record<string, Meta>>({})
const openKey = ref<string | null>(null)

onMounted(async () => {
  try {
    for (const s of await radio.catalogue()) meta.value[s.name] = { options: s.options, description: s.description }
  } catch {
    /* offline — settings stay read-only */
  }
})

interface Item {
  key: string
  label: string
  rawValue: string
  value: string
  options: string[] | null
  description: string
  rawPending: string | null
  pending: string | null
  failed: boolean
}
const itemByKey = computed<Record<string, Item>>(() => {
  const rs = radio.state.value?.radio
  const out: Record<string, Item> = {}
  for (const [key, value] of Object.entries(rs?.settings ?? {})) {
    const p = (rs?.pendingSettings ?? {})[key]
    const m = meta.value[key]
    const rawPending = p?.phase === 'pending' ? String(p.desired) : null
    out[key] = {
      key,
      label: settingLabel(key),
      rawValue: String(value),
      value: optionDisplay(String(value)),
      options: m?.options ?? null,
      description: m?.description ?? '',
      rawPending,
      pending: rawPending ? optionDisplay(rawPending) : null,
      failed: p?.phase === 'failed',
    }
  }
  // WRITE-ONLY settings (e.g. external_audio_jack, 08 46): the radio never reports a value, so
  // they'd otherwise be invisible forever. Any grouped, catalogue-known key with no reported
  // value renders as '—' and stays editable; after the first write the optimistic value shows.
  for (const key of SETTINGS_GROUPS.flatMap((g) => g.keys)) {
    const m = meta.value[key]
    if (out[key] || !m?.options) continue
    const p = (rs?.pendingSettings ?? {})[key]
    const rawPending = p?.phase === 'pending' ? String(p.desired) : null
    out[key] = {
      key,
      label: settingLabel(key),
      rawValue: '',
      value: '—',
      options: m.options,
      description: m.description ?? '',
      rawPending,
      pending: rawPending ? optionDisplay(rawPending) : null,
      failed: p?.phase === 'failed',
    }
  }
  return out
})

/** The manual's groups, filtered to settings the radio actually reported — plus a trailing
 * "Other" for any reported key the grouping doesn't know (a future decode never disappears). */
const groups = computed(() => {
  const known = new Set(SETTINGS_GROUPS.flatMap((g) => g.keys))
  const sections = SETTINGS_GROUPS.map((g) => ({
    title: g.title,
    items: g.keys.map((k) => itemByKey.value[k]).filter((i): i is Item => !!i),
  })).filter((g) => g.items.length > 0)
  // channel-card settings (squelch, DigiMon) live on the VFO cards — don't resurrect them here
  const other = Object.values(itemByKey.value).filter((i) => !known.has(i.key) && !CHANNEL_CARD_SETTINGS.has(i.key))
  if (other.length) sections.push({ title: 'Other', items: other })
  return sections
})
const empty = computed(() => groups.value.length === 0)

const openItem = computed<Item | null>(() => (openKey.value ? itemByKey.value[openKey.value] ?? null : null))
function open(item: Item): void {
  if (item.options && item.options.length) openKey.value = item.key
}
function choose(value: string): void {
  const key = openKey.value
  if (!key) return
  void radio.setSetting(key, value)
  openKey.value = null
}

const onKeydown = (e: KeyboardEvent): void => {
  if (e.key === 'Escape' && !openKey.value) emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div class="tone-modal-backdrop" @click.self="emit('close')">
      <div class="tone-modal radio-settings-modal" role="dialog" aria-modal="true" aria-label="Radio settings">
        <div class="tone-modal-header">
          <span class="tone-modal-title">Radio Settings</span>
          <button type="button" class="tone-modal-close" aria-label="Close" @click="emit('close')">✕</button>
        </div>

        <div class="radio-settings-body">
          <p v-if="empty" class="status-empty">No settings read yet — connect to the radio first.</p>
          <section v-for="g in groups" :key="g.title" class="radio-settings-group">
            <h3 class="radio-settings-group-title">{{ g.title }}</h3>
            <div class="radio-settings-grid">
              <StatusBadge
                v-for="s in g.items"
                :key="s.key"
                :label="s.label"
                :value="s.pending ?? s.value"
                :clickable="!!s.options"
                :active="!!settingValueColor(s.key, s.rawPending ?? s.rawValue)"
                :color-active="settingValueColor(s.key, s.rawPending ?? s.rawValue) ?? undefined"
                :busy="!!s.pending"
                :failed="s.failed"
                @toggle="open(s)"
              />
            </div>
          </section>
        </div>

        <SettingDialog
          v-if="openItem && openItem.options"
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
      </div>
    </div>
  </Teleport>
</template>
