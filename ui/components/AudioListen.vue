<script setup lang="ts">
// Audio toolbar (PoC parity): Enable Audio (RX), Enable Mic (arm the mic independently), and Stats
// (WebRTC diagnostics popup). The hold-to-talk floating PTT is only present once the mic is armed —
// no mic, no PTT — mirroring the PoC's `v-if="audioMicActive"`.
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRadio } from '../composables/useRadio'
import { setAudioSessionType, useMediaSession } from '../composables/useMediaSession'
import SettingsDialog from './SettingsDialog.vue'

const radio = useRadio()
const listening = ref(false)

// Mic→radio gain: server-held at its 0.6 default (main.ts). The live-adjust slider was removed —
// the default is left in place; re-add the AppSlider + setTxGain/getTxGain wiring to expose it.
// RX codec picker (PCMU native-8k default vs Opus). Changing it re-establishes audio so the new
// codec is negotiated. Persisted in localStorage by the composable.
const busy = ref(false)
const micBusy = ref(false)
const micEnabled = ref(false)
const keyed = ref(false)
const settingsOpen = ref(false)
const error = ref<string | null>(null)
const audioPlayerRef = ref<HTMLAudioElement | null>(null)

const audioToggleLabel = computed(() => (busy.value ? 'Audio…' : listening.value ? 'Disable Audio' : 'Enable Audio'))
const audioTitle = computed(() => (listening.value ? 'Stop the live radio audio' : 'Listen to the live radio audio'))
const micLabel = computed(() => (micBusy.value ? 'Mic…' : micEnabled.value ? 'Disable Mic' : 'Enable Mic'))
const micTitle = computed(() =>
  !listening.value ? 'Enable audio first' : micEnabled.value ? 'Release the microphone (keeps RX audio)' : 'Arm the microphone for hold-to-talk',
)

async function toggleAudio(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = null
  try {
    if (listening.value) {
      if (keyed.value) await releaseMic()
      if (micEnabled.value) await radio.disableMic().catch(() => {})
      await radio.stopAudio()
      // Detach the dead stream from the element — a lingering srcObject keeps iOS's now-playing
      // surface alive even after the peer connection is closed (media session teardown pairs
      // with this in useMediaSession's listening watch).
      if (audioPlayerRef.value) {
        audioPlayerRef.value.srcObject = null
        audioPlayerRef.value.load()
      }
      setAudioSessionType('auto') // release the playback routing hint
      listening.value = false
      micEnabled.value = false
    } else if (audioPlayerRef.value) {
      setAudioSessionType('playback') // BEFORE play: listening must not route as a "call" on iOS
      await radio.startAudio(audioPlayerRef.value)
      listening.value = true
    }
  } catch (e) {
    error.value = (e as { message?: string })?.message ?? String(e)
    listening.value = false
  } finally {
    busy.value = false
  }
}

async function toggleMic(): Promise<void> {
  if (micBusy.value || !listening.value) return
  micBusy.value = true
  error.value = null
  try {
    if (micEnabled.value) {
      if (keyed.value) await releaseMic()
      await radio.disableMic()
      micEnabled.value = false
      setAudioSessionType('playback') // mic released → back to media routing
    } else {
      setAudioSessionType('play-and-record')
      await radio.enableMic()
      micEnabled.value = radio.hasMic()
      if (!micEnabled.value) setAudioSessionType('playback')
    }
  } catch (e) {
    error.value = (e as { message?: string })?.message ?? String(e)
    micEnabled.value = false
  } finally {
    micBusy.value = false
  }
}

// UI_PROTOCOL §6 color contract: the button colors off the BACKEND's ptt phase — never red
// until the radio acks the key, back to green only when the release confirms, flashing on
// fault. The local `keyed` ref is only the finger (it drives key/release + the label).
const pttPhase = computed(() => radio.state.value?.radio?.ptt ?? 'idle')
const pttClass = computed(() => ({
  'floating-ptt--fault': pttPhase.value === 'fault',
  'floating-ptt--active': pttPhase.value === 'keyed',
  'floating-ptt--busy': pttPhase.value === 'keying' || pttPhase.value === 'unkeying' || (keyed.value && pttPhase.value === 'idle'),
  'floating-ptt--ready': !keyed.value && pttPhase.value === 'idle',
}))
const pttSub = computed(() =>
  pttPhase.value === 'fault' ? 'FAULT' : pttPhase.value === 'keyed' ? 'TX ON' : pttPhase.value === 'keying' ? 'KEYING…' : pttPhase.value === 'unkeying' ? 'RELEASING…' : 'Hold',
)
const pttTitle = computed(() =>
  pttPhase.value === 'fault'
    ? 'Release NOT confirmed — the radio may still be transmitting'
    : pttPhase.value === 'keyed'
      ? 'Transmitting (radio-confirmed) — release to stop'
      : pttPhase.value === 'unkeying'
        ? 'Release sent — awaiting the radio'
        : pttPhase.value === 'keying'
          ? 'Key sent — awaiting the radio'
          : 'Hold to transmit (browser mic → radio)',
)

async function pressMic(): Promise<void> {
  if (!micEnabled.value || keyed.value) return
  keyed.value = true
  await radio.keyMic().catch((e) => {
    error.value = (e as { message?: string })?.message ?? String(e)
    keyed.value = false
  })
}
async function releaseMic(): Promise<void> {
  if (!keyed.value) return
  keyed.value = false
  await radio.unkeyMic().catch(() => {})
}

// Lock-screen / Dynamic Island now-playing card while listening (play/pause + channel step).
useMediaSession({
  el: () => (listening.value ? audioPlayerRef.value : null),
  listening,
  start: () => void toggleAudio(),
})

onBeforeUnmount(() => {
  if (keyed.value) void radio.unkeyMic()
  if (listening.value) void radio.stopAudio()
})
</script>

<template>
  <div class="audio-listener" :class="{ 'audio-listener--active': listening }">
    <button class="btn btn-ghost" :class="{ 'btn-audio--active': listening }" :disabled="busy" :title="audioTitle" @click="toggleAudio">{{ audioToggleLabel }}</button>
    <button
      class="btn btn-ghost"
      :class="{ 'btn-mic--active': micEnabled }"
      :disabled="micBusy || !listening"
      :title="micTitle"
      @click="toggleMic"
    >{{ micLabel }}</button>
    <button class="btn btn-ghost audio-settings-btn" title="Radio settings — organized like the radio's own menu" @click="settingsOpen = true">Radio Settings</button>
    <span v-if="error" class="audio-listener-error">{{ error }}</span>

    <!-- Live-audio playback sink: where WebRTC audio actually plays, kept in the DOM but hidden. -->
    <audio
      ref="audioPlayerRef"
      class="webrtc-media-player webrtc-media-player--hidden"
      playsinline
      webkit-playsinline="true"
      x-webkit-airplay="allow"
      preload="none"
      autoplay
    />

    <!-- Hold-to-talk PTT — ONLY present once the mic is armed (no mic, no button). Fixed,
         corner-anchored, teleported to <body> so the header can't clip it. -->
    <Teleport to="body">
      <button
        v-if="listening && micEnabled"
        class="floating-ptt"
        :class="pttClass"
        :title="pttTitle"
        :aria-pressed="keyed"
        aria-label="Hold to transmit"
        @pointerdown.prevent="pressMic"
        @pointerup.prevent="releaseMic"
        @pointerleave="releaseMic"
        @pointercancel.prevent="releaseMic"
        @contextmenu.prevent
      >
        <span class="floating-ptt-main">{{ keyed ? 'SPEAK' : 'PTT' }}</span>
        <span class="floating-ptt-sub">{{ pttSub }}</span>
      </button>
    </Teleport>

    <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false" />
  </div>
</template>

<style scoped>
.btn-mic--active,
.btn-audio--active {
  border-color: rgba(63, 185, 80, .6);
  color: var(--green, #3fb950);
  background: rgba(63, 185, 80, .1);
}
</style>
