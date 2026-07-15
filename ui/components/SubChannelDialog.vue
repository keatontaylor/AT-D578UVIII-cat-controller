<script setup lang="ts">
// Sub-Channel safety net (shown once per connect while sub_channel is ON): the radio's mono
// audio stream carries no side labels, so side attribution is INFERRED — with the second
// receiver off, whole classes of attribution ambiguity become unrepresentable. The primary
// action is the existing settings write; "don't show again" is the operator's standing choice
// (persisted by the parent). Styled after the tone/setting modals like every other dialog.
import { onMounted, onBeforeUnmount, ref } from 'vue'

const emit = defineEmits<{ turnOff: [dontShowAgain: boolean]; keep: [dontShowAgain: boolean] }>()
const dontShowAgain = ref(false)

const onKey = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') emit('keep', dontShowAgain.value)
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="tone-modal-backdrop" @click.self="emit('keep', dontShowAgain)">
      <div class="tone-modal value-modal" role="dialog" aria-modal="true" aria-label="Sub Channel is on">
        <div class="tone-modal-header">
          <span class="tone-modal-title">Sub Channel is on</span>
          <button type="button" class="tone-modal-close" aria-label="Close" @click="emit('keep', dontShowAgain)">✕</button>
        </div>

        <p class="setting-desc">
          The radio sends a single mono audio stream with no indication of which side it belongs to,
          so this app has to <strong>infer</strong> the receiving side. With Sub Channel on that
          inference can occasionally be wrong — recordings, RX indicators, and the media player info
          are all most reliable with Sub Channel off.
        </p>
        <p class="setting-desc">You can change this anytime on the radio or in Settings → Display.</p>

        <label class="subch-dismiss">
          <input v-model="dontShowAgain" type="checkbox" />
          <span>Don't show this again</span>
        </label>

        <div class="value-actions">
          <button type="button" class="btn btn-ghost" @click="emit('keep', dontShowAgain)">Keep it on</button>
          <button type="button" class="btn btn-primary" @click="emit('turnOff', dontShowAgain)">Turn off Sub Channel</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Own row, indented to the body-text gutter (same 14px as .setting-desc) so it reads as the
   last line of the copy — the footer keeps just the two buttons. */
.subch-dismiss {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 14px 0;
  font-size: 12.5px;
  color: var(--text-muted, #8b949e);
  cursor: pointer;
  user-select: none;
}
.subch-dismiss input {
  margin: 0;
  accent-color: var(--accent, #58a6ff);
  cursor: pointer;
}
</style>
