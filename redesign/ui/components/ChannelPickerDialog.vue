<script setup lang="ts">
// "Go anywhere" picker — enumerates every zone (04 2b), lazily reads a zone's channels on expand
// (04 27 members + 04 2e names), and jumps the side to a channel in ANY zone (switch zone → select
// channel). Self-contained: it drives its own reads/writes through useRadio; the resulting channel
// block flows back through RadioState. Styled after the setting/tone modals + scan accordion.
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useRadio } from '../composables/useRadio'

const props = defineProps<{
  label: string
  side: 'a' | 'b'
  /** The side's current zone index + in-zone position — expanded and highlighted on open. */
  currentZoneIndex?: number | null
  currentPosition?: number | null
}>()

const emit = defineEmits<{ close: [] }>()

const radio = useRadio()
const zones = ref<{ index: number; name: string }[]>([])
const loadingZones = ref(true)
const expanded = ref<number | null>(props.currentZoneIndex ?? null)
const channels = ref<Record<number, { position: number; name: string }[]>>({})
const loadingZone = ref<number | null>(null)
const busy = ref(false)

const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') emit('close')
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  try {
    zones.value = await radio.zones()
    if (expanded.value != null) await loadZone(expanded.value)
  } finally {
    loadingZones.value = false
  }
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const refreshing = ref(false)
async function loadZone(index: number): Promise<void> {
  if (channels.value[index]) return
  loadingZone.value = index
  try {
    channels.value[index] = await radio.zoneChannelsIn(index)
  } finally {
    loadingZone.value = null
  }
}
// Force a fresh enumeration (zones + the open zone's channels); the codeplug is otherwise cached.
async function refresh(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  channels.value = {}
  try {
    zones.value = await radio.zones(true)
    if (expanded.value != null) await loadZone(expanded.value)
  } finally {
    refreshing.value = false
  }
}
async function toggleZone(index: number): Promise<void> {
  if (expanded.value === index) {
    expanded.value = null
    return
  }
  expanded.value = index
  await loadZone(index)
}
async function pick(zoneIndex: number, position: number): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await radio.selectZoneChannel(props.side, zoneIndex, position)
    emit('close')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="tone-modal-backdrop" @click.self="emit('close')">
      <div class="tone-modal picker-modal" role="dialog" aria-modal="true" :aria-label="label">
        <div class="tone-modal-header">
          <span class="tone-modal-title">{{ label }}</span>
          <span class="tone-modal-head-actions">
            <button class="picker-refresh" :disabled="refreshing || loadingZones" title="Re-read zones from the radio" @click="refresh">
              {{ refreshing ? '↻…' : '↻' }}
            </button>
            <button class="tone-modal-close" aria-label="Close" @click="emit('close')">✕</button>
          </span>
        </div>

        <p class="setting-desc">Pick a zone, then a channel — jump anywhere in the codeplug. Cached; ↻ re-reads.</p>

        <div class="picker-list">
          <p v-if="loadingZones" class="picker-empty">Reading zones…</p>
          <p v-else-if="!zones.length" class="picker-empty">No zones found on the radio.</p>

          <div v-for="zone in zones" :key="zone.index" class="picker-zone">
            <button
              type="button"
              class="picker-zone-row"
              :class="{ 'picker-zone-row--current': zone.index === currentZoneIndex, 'picker-zone-row--open': expanded === zone.index }"
              @click="toggleZone(zone.index)"
            >
              <span class="picker-caret">{{ expanded === zone.index ? '▾' : '▸' }}</span>
              <span class="picker-zone-name">{{ zone.name }}</span>
              <span v-if="zone.index === currentZoneIndex" class="picker-zone-cur">current</span>
            </button>

            <div v-if="expanded === zone.index" class="picker-channels">
              <p v-if="loadingZone === zone.index" class="picker-empty picker-empty--sub">Reading channels…</p>
              <template v-else>
                <button
                  v-for="ch in channels[zone.index] ?? []"
                  :key="ch.position"
                  type="button"
                  class="picker-ch"
                  :class="{ 'picker-ch--current': zone.index === currentZoneIndex && ch.position === currentPosition }"
                  :disabled="busy"
                  @click="pick(zone.index, ch.position)"
                >
                  <span class="picker-ch-num">{{ ch.position + 1 }}</span>
                  <span class="picker-ch-name">{{ ch.name }}</span>
                  <span v-if="zone.index === currentZoneIndex && ch.position === currentPosition" class="setting-enum-check">✓</span>
                </button>
                <p v-if="!(channels[zone.index] ?? []).length" class="picker-empty picker-empty--sub">No channels in this zone.</p>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.picker-modal { width: 340px; }
.tone-modal-head-actions { display: inline-flex; align-items: center; gap: 4px; }
.picker-refresh {
  background: none; border: none; color: var(--text-muted, #8b949e); cursor: pointer;
  font-size: 15px; line-height: 1; padding: 2px 6px; border-radius: 4px;
}
@media (hover: hover) {
  .picker-refresh:hover:not(:disabled) { background: rgba(255, 255, 255, .1); color: var(--text, #e6edf3); }
}

.picker-refresh:disabled { opacity: .5; cursor: default; }
.picker-list { overflow-y: auto; max-height: min(64vh, 460px); padding: 8px; }
.picker-empty { margin: 0; padding: 10px 8px; font-size: 12.5px; color: var(--text-muted, #8b949e); }
.picker-empty--sub { padding: 8px 12px; }
.picker-zone { border-radius: 8px; }
.picker-zone-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border, #30363d);
  border-radius: 8px;
  background: var(--surface-2, #161b22);
  color: var(--text, #e6edf3);
  font-size: 14px;
  cursor: pointer;
  text-align: left;
}
@media (hover: hover) {
  .picker-zone-row:hover { border-color: var(--accent, #58a6ff); }
}

.picker-zone-row--open { border-color: var(--accent, #58a6ff); border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.picker-zone-row--current { box-shadow: inset 2px 0 0 var(--accent, #58a6ff); }
.picker-caret { width: 12px; color: var(--text-muted, #8b949e); font-size: 11px; }
.picker-zone-name { flex: 1 1 auto; font-weight: 600; }
.picker-zone-cur { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--accent, #58a6ff); }
.picker-channels {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--border, #30363d);
  border-top: none;
  border-bottom-left-radius: 8px;
  border-bottom-right-radius: 8px;
}
.picker-ch {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--surface, #0d1117);
  color: var(--text, #e6edf3);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
@media (hover: hover) {
  .picker-ch:hover:not(:disabled) { border-color: var(--accent, #58a6ff); }
}

.picker-ch:disabled { opacity: .6; cursor: wait; }
.picker-ch--current { border-color: var(--accent, #58a6ff); }
.picker-ch-num {
  min-width: 26px;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted, #8b949e);
}
.picker-ch-name { flex: 1 1 auto; }
</style>
