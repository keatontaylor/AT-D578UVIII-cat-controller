<script setup lang="ts">
// Native-scan list picker (styled after the tone/setting modals). Self-contained like the Go-to
// dialog: it opens IMMEDIATELY and reads the radio's scan lists (04 4b directory) itself, showing a
// loading indicator until they return — then a "current list" option (start without changing the
// list) plus each list. Picking a row emits the choice; the parent starts the scan on that side.
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useRadio } from '../composables/useRadio'

defineProps<{ label: string }>()
const emit = defineEmits<{ select: [list: { index: number; name: string } | null]; close: [] }>()

const radio = useRadio()
const lists = ref<{ index: number; name: string }[]>([])
const loading = ref(true)
const refreshing = ref(false)

async function load(force = false): Promise<void> {
  if (force) refreshing.value = true
  try {
    lists.value = await radio.scanLists(force) // cached after the first read; force re-enumerates
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  void load()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="tone-modal-backdrop" @click.self="emit('close')">
      <div class="tone-modal setting-modal" role="dialog" aria-modal="true" :aria-label="label">
        <div class="tone-modal-header">
          <span class="tone-modal-title">{{ label }}</span>
          <span class="tone-modal-head-actions">
            <button class="scan-refresh" :disabled="loading || refreshing" title="Re-read scan lists from the radio" @click="load(true)">
              {{ refreshing ? '↻…' : '↻' }}
            </button>
            <button class="tone-modal-close" aria-label="Close" @click="emit('close')">✕</button>
          </span>
        </div>

        <p class="setting-desc">Start scanning a list. The radio stops on activity; controls stay locked until you stop the scan.</p>

        <div class="setting-edit-enum">
          <p v-if="loading" class="setting-desc scan-loading">Reading scan lists…</p>
          <template v-else>
            <button class="setting-enum-btn" @click="emit('select', null)">
              <span class="setting-enum-label">Current list</span>
            </button>
            <button
              v-for="list in lists"
              :key="list.index"
              class="setting-enum-btn"
              @click="emit('select', list)"
            >
              <span class="setting-enum-label">{{ list.name }}</span>
            </button>
            <p v-if="!lists.length" class="setting-desc">No scan lists found on the radio.</p>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tone-modal-head-actions { display: inline-flex; align-items: center; gap: 4px; }
.scan-refresh {
  background: none; border: none; color: var(--text-muted, #8b949e); cursor: pointer;
  font-size: 15px; line-height: 1; padding: 2px 6px; border-radius: 4px;
}
@media (hover: hover) {
  .scan-refresh:hover:not(:disabled) { background: rgba(255, 255, 255, .1); color: var(--text, #e6edf3); }
}

.scan-refresh:disabled { opacity: .5; cursor: default; }
.scan-loading { text-align: center; border-bottom: none; }
</style>
