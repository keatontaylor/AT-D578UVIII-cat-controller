<script setup lang="ts">
// CTCSS/DCS tone picker for one side's RX or TX tone — styling harvested from the PoC's tone modal.
// Pick a type (Off / CTCSS / DCS), then a value; the selection is written via 2f 16 (rx) / 2f 02
// (tx) and the pending/failed overlay flows back through the side's channel overlay.
import { ref } from 'vue'
import { onBeforeUnmount, onMounted } from 'vue'
import { CTCSS_TONES, DCS_CODES } from '../../src/codec/tone-tables'

type ToneType = 'off' | 'ctc' | 'dcs'

const props = defineProps<{
  label: string
  /** Current selection for preselect highlighting. */
  current: { type: ToneType; value: number }
  /** In-flight desired label, or null when settled. */
  pending: string | null
  failed: boolean
}>()

const emit = defineEmits<{ select: [type: ToneType, value: number, inverted: boolean]; close: [] }>()

const draftType = ref<ToneType>(props.current.type)
const draftInverted = ref(false)
const busy = () => props.pending !== null

const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function pick(type: ToneType, value: number, inverted = false): void {
  if (busy()) return
  emit('select', type, value, inverted)
}
</script>

<template>
  <Teleport to="body">
    <div class="tone-modal-backdrop" @click.self="emit('close')">
      <div class="tone-modal tone-modal--dcs" role="dialog" aria-modal="true" :aria-label="label">
        <div class="tone-modal-header">
          <span class="tone-modal-title">{{ label }}</span>
          <button class="tone-modal-close" aria-label="Close" @click="emit('close')">✕</button>
        </div>

        <p v-if="failed" class="tone-status tone-status--failed">
          Last change wasn’t confirmed by the radio — pick again to retry.
        </p>
        <p v-else-if="pending" class="tone-status tone-status--pending">
          <span class="tone-spin">⟳</span> Setting <strong>{{ pending }}</strong> — waiting for the radio…
        </p>

        <!-- Type tabs and value grids carry the tile palette: blue = CTCSS, purple = DCS. -->
        <div class="tone-type-row">
          <button class="setting-enum-btn" :class="{ 'setting-enum-btn--active': draftType === 'off' }" :disabled="busy()" @click="pick('off', 0)">Off</button>
          <button class="setting-enum-btn tone-tab--ctc" :class="{ 'setting-enum-btn--active': draftType === 'ctc' }" :disabled="busy()" @click="draftType = 'ctc'">CTCSS</button>
          <button class="setting-enum-btn tone-tab--dcs" :class="{ 'setting-enum-btn--active': draftType === 'dcs' }" :disabled="busy()" @click="draftType = 'dcs'">DCS</button>
        </div>

        <div v-if="draftType === 'ctc'" class="ctcss-tone-grid">
          <button
            v-for="(hz, idx) in CTCSS_TONES"
            :key="idx"
            class="ctcss-tone-btn"
            :class="{ 'ctcss-tone-btn--active': current.type === 'ctc' && current.value === idx + 1 }"
            :disabled="busy()"
            @click="pick('ctc', idx + 1)"
          >{{ hz.toFixed(1) }}</button>
        </div>

        <template v-else-if="draftType === 'dcs'">
          <label class="tone-dcs-invert">
            <input v-model="draftInverted" type="checkbox" :disabled="busy()" />
            <span>Inverted (D…I)</span>
          </label>
          <div class="dcs-code-grid">
            <button
              v-for="code in DCS_CODES"
              :key="code"
              class="ctcss-tone-btn tone-btn--dcs"
              :class="{ 'ctcss-tone-btn--active': current.type === 'dcs' && current.value === code }"
              :disabled="busy()"
              @click="pick('dcs', code, draftInverted)"
            >D{{ String(code).padStart(3, '0') }}{{ draftInverted ? 'I' : 'N' }}</button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tone-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, .65);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.tone-modal {
  background: var(--surface, #161b22);
  border: 1px solid var(--border, #505152);
  border-radius: var(--radius, 8px);
  box-shadow: 0 16px 48px rgba(0, 0, 0, .85);
  width: 360px;
  max-width: calc(100vw - 24px);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tone-modal--dcs { width: 450px; }
.tone-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 9px;
  border-bottom: 1px solid var(--border, #505152);
  flex-shrink: 0;
}
.tone-modal-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .07em;
  color: var(--text-muted, #8b949e);
}
.tone-modal-close {
  background: none;
  border: none;
  color: var(--text-muted, #8b949e);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
}
@media (hover: hover) {
  .tone-modal-close:hover { background: rgba(255, 255, 255, .1); color: var(--text, #e6edf3); }
}


.tone-status {
  margin: 0;
  padding: 8px 14px;
  font-size: 12px;
  border-bottom: 1px solid var(--border, #505152);
}
.tone-status--pending { color: var(--yellow, #d29922); }
.tone-status--failed { color: var(--red, #f85149); }
.tone-spin { display: inline-block; animation: spin .8s linear infinite; }

.tone-type-row {
  display: flex;
  gap: 6px;
  padding: 10px 10px 0;
}
.setting-enum-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px 12px;
  border: 1px solid var(--border, #505152);
  border-radius: 8px;
  background: var(--surface2, #21262d);
  color: var(--text, #e6edf3);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) {
  .setting-enum-btn:hover:not(:disabled) { border-color: var(--accent, #58a6ff); }
}

.setting-enum-btn:disabled { opacity: .5; cursor: wait; }
.setting-enum-btn--active { border-color: var(--accent, #58a6ff); background: rgba(88, 166, 255, .12); }

.ctcss-tone-grid,
.dcs-code-grid {
  padding: 10px;
  overflow-y: auto;
  display: grid;
  gap: 4px;
}
.ctcss-tone-grid { grid-template-columns: repeat(5, 1fr); }
.dcs-code-grid { grid-template-columns: repeat(5, 1fr); }
.ctcss-tone-btn {
  font-size: 10px;
  padding: 6px 2px;
  background: var(--surface2, #1e2330);
  border: 1px solid var(--border, #505152);
  border-radius: 4px;
  color: var(--text, #e6edf3);
  cursor: pointer;
  text-align: center;
  transition: background .1s, border-color .1s;
}
@media (hover: hover) {
  .ctcss-tone-btn:hover:not(:disabled) { background: rgba(88, 166, 255, .25); border-color: #58a6ff; color: #b6d4fe; }
}

.ctcss-tone-btn:disabled { opacity: .5; cursor: wait; }
.ctcss-tone-btn--active { background: #58a6ff; border-color: #58a6ff; color: #0d1117; font-weight: 700; }
@media (hover: hover) {
  /* DCS values wear the DCS purple (TONE_COLORS.dcs) instead of the CTCSS blue. */
.tone-btn--dcs:hover:not(:disabled) { background: rgba(163, 113, 247, .25); border-color: #a371f7; color: #d6bcfa; }
}

.tone-btn--dcs.ctcss-tone-btn--active { background: #a371f7; border-color: #a371f7; color: #0d1117; }
/* Type tabs preview their palette when selected. */
.tone-tab--ctc.setting-enum-btn--active { border-color: #58a6ff; background: rgba(88, 166, 255, .12); color: #58a6ff; }
.tone-tab--dcs.setting-enum-btn--active { border-color: #a371f7; background: rgba(163, 113, 247, .12); color: #a371f7; }

.tone-dcs-invert {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 0;
  font-size: 13px;
  color: var(--text-muted, #8b949e);
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
