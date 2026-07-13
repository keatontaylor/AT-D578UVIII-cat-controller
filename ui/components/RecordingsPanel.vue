<script setup lang="ts">
// Squelch-recording timeline (F4.3), PoC-style. The clip list is LIVE — hydrated once on open then
// kept current by server pushes (recordings.opened / .saved / .discarded / .removed / .status via
// useRadio); no polling, no refresh button. Clips lay out on a pan-able (drag or buttons) time
// axis, grouped into per-channel lanes: RX colored by mode (FM / DMR), the operator's own
// transmissions (direction 'tx') in orange, and an IN-PROGRESS recording as a pulsing block
// growing toward "now". A CURSOR scrubs the timeline; Play runs continuously from the cursor,
// auto-advancing to the next clip (Next jumps manually). Audio streams from the range-capable
// /recordings/<id>.wav route. Touch: horizontal drag pans, tap seeks/plays.
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import AppSelect from './AppSelect.vue'
import AppSlider from './AppSlider.vue'
import { useRadio, type LiveRecording, type RecordingClip } from '../composables/useRadio'

const radio = useRadio()
const recordings = radio.recordings
const liveRecordings = radio.liveRecordings
const status = radio.recorderStatus
const busy = ref(false)
const error = ref<string | null>(null)
const selectedId = ref<string | null>(null)

// ── View mode: horizontal LANES (desktop) vs vertical FEED (mobile) ─────────────
// Research-driven: a horizontal time axis at phone width puts short transmissions at ~1 px and
// needs pan/zoom gymnastics; every comparable product (NVR event lists, voicemail, voice memos)
// uses a vertical, newest-first feed on narrow screens. Auto picks by viewport; the user can pin
// either (persisted).
type ViewMode = 'auto' | 'lanes' | 'feed'
const VIEW_KEY = 'anytone.rec.view'
const viewMode = ref<ViewMode>((localStorage.getItem(VIEW_KEY) as ViewMode) || 'auto')
const narrow = ref(window.matchMedia('(max-width: 640px)').matches)
const mq = window.matchMedia('(max-width: 640px)')
const onMq = (e: MediaQueryListEvent): void => {
  narrow.value = e.matches
}
const effectiveView = computed<'lanes' | 'feed'>(() =>
  viewMode.value === 'auto' ? (narrow.value ? 'feed' : 'lanes') : viewMode.value,
)
function setView(mode: ViewMode): void {
  viewMode.value = mode
  localStorage.setItem(VIEW_KEY, mode)
}

// Live "now" edge — ticks so the window advances without a reload.
const now = ref(Date.now())
let ticker: number | undefined

const WINDOWS = [
  { label: '15 min', hours: 0.25 },
  { label: '30 min', hours: 0.5 },
  { label: '1 hr', hours: 1 },
  { label: '6 hr', hours: 6 },
  { label: '24 hr', hours: 24 },
]
const windowHours = ref(1)
const windowMs = computed(() => windowHours.value * 3_600_000)
// Pan offset (ms) from "live". 0 = anchored to now (follows live); negative = panned into the past.
const panMs = ref(0)
const live = computed(() => panMs.value >= 0)
// FUTURE HEADROOM: when anchored to live, ~12% of the window stays empty to the RIGHT of "now" —
// otherwise the newest clips pin to the very edge of the track and are hard to see/hit. The "now"
// playhead sits at the 88% mark and the future region is shaded. Panned into the past → no headroom.
const FUTURE_FRAC = 0.12
const windowEnd = computed(() => now.value + (panMs.value >= 0 ? windowMs.value * FUTURE_FRAC : panMs.value))
const windowStart = computed(() => windowEnd.value - windowMs.value)

const minDurationSec = ref(0)
const channelFilter = ref<string>('all')

// Lane grouping: a DMR clip with a live talkgroup groups by TG (so digital-monitor traffic on
// different talkgroups lands on separate lanes), everything else by channel name / freq / side.
// TX clips share their channel/TG lane — the direction shows as color, not as a separate lane.
type AnyClip = RecordingClip | LiveRecording
const isDmrClip = (c: AnyClip): boolean => (c.mode === 'DMR' || c.mode === 'D+A') && c.talkgroup != null
const isTx = (c: AnyClip): boolean => c.direction === 'tx'
const laneKey = (c: AnyClip): string =>
  isDmrClip(c) ? `tg:${c.talkgroup}` : c.channelName || (c.freqMHz != null ? `${c.freqMHz.toFixed(4)} MHz` : (c.side ?? 'clip'))
const laneLabel = (c: AnyClip): string =>
  isDmrClip(c) ? `TG ${c.talkgroup}` : c.channelName || (c.freqMHz != null ? `${c.freqMHz.toFixed(4)} MHz` : (c.side ?? 'clip'))
const clipEnd = (c: RecordingClip): number => c.startedAt + c.durationMs
const passesFilters = (c: RecordingClip): boolean =>
  c.durationMs >= minDurationSec.value * 1000 && (channelFilter.value === 'all' || laneKey(c) === channelFilter.value)

const channels = computed(() => {
  const map = new Map<string, string>() // key → display label
  for (const c of recordings.value) if (!map.has(laneKey(c))) map.set(laneKey(c), laneLabel(c))
  return [...map.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label))
})

interface Lane { key: string; label: string; mode: string | null; clips: RecordingClip[]; live: LiveRecording[] }

// The label column sizes to the LONGEST visible lane name (desktop), so channel names don't
// truncate at an arbitrary fixed width. Estimated at ~7 px/char (12 px, 600 weight) + the mode
// pill, clamped so one absurd name can't eat the timeline. Phones keep the fixed narrow column —
// there the track needs every pixel and names ellipsize instead (same as the settings tiles).
const laneColPx = computed(() => {
  if (narrow.value) return 92
  const chars = Math.max(0, ...lanes.value.map((l) => l.label.length))
  return Math.max(138, Math.min(240, Math.round(chars * 7) + 42))
})
const lanes = computed<Lane[]>(() => {
  const start = windowStart.value
  const end = windowEnd.value
  const map = new Map<string, Lane>()
  const laneFor = (c: AnyClip): Lane => {
    const key = laneKey(c)
    let lane = map.get(key)
    if (!lane) {
      lane = { key, label: laneLabel(c), mode: c.mode, clips: [], live: [] }
      map.set(key, lane)
    }
    return lane
  }
  for (const c of recordings.value) {
    if (!passesFilters(c)) continue
    if (clipEnd(c) < start || c.startedAt > end) continue
    laneFor(c).clips.push(c)
  }
  // in-progress recordings: always shown (no duration yet, so no min-duration filter), growing
  // toward "now" — their lane appears even before the first saved clip lands on it
  for (const c of liveRecordings.value) {
    if (channelFilter.value !== 'all' && laneKey(c) !== channelFilter.value) continue
    if (c.startedAt > end || now.value < start) continue
    laneFor(c).live.push(c)
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label))
})
const visibleCount = computed(() => lanes.value.reduce((n, l) => n + l.clips.length, 0))

// What the header's REC pill says: the channel(s) being recorded RIGHT NOW, if any.
const liveLabel = computed(() => {
  if (!liveRecordings.value.length) return null
  return liveRecordings.value.map((c) => `${isTx(c) ? 'TX ' : ''}${laneLabel(c)}`).join(' · ')
})

// ── The FEED view: newest-first rows grouped by hour (mobile's projection of the data) ──
const FEED_CAP = 200
interface FeedGroup { label: string; clips: RecordingClip[] }
const feedTotal = computed(() => recordings.value.filter(passesFilters).length)
const feedGroups = computed<FeedGroup[]>(() => {
  const clips = recordings.value
    .filter(passesFilters)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, FEED_CAP)
  const groups: FeedGroup[] = []
  for (const c of clips) {
    const d = new Date(c.startedAt)
    const label = `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString([], { hour: '2-digit' })}`
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.clips.push(c)
    else groups.push({ label, clips: [c] })
  }
  return groups
})
// Duration bar: linear to 30 s then capped — 2 s vs 20 s must read at a glance, outliers flatten.
const durFrac = (ms: number): number => Math.max(4, Math.min(100, (ms / 30_000) * 100))
const liveElapsed = (c: LiveRecording): string => fmtDur(Math.max(0, now.value - c.startedAt))

// ── Continuous playback ──────────────────────────────────────────────────────────
// The PLAYER BAR is the single playback surface: transport + the LOADED clip (selectedId) with
// its in-clip scrubber and Download/Delete. Clicking a clip anywhere loads it here and plays.
const playerRef = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const playingId = ref<string | null>(null)
// Seconds into the LOADED clip — drives the player bar's scrubber (follows playback; dragging seeks).
const posSec = ref(0)
// The cursor: a timestamp along the timeline. Null → track live "now". During playback it follows
// the audio position; a click on the timeline (or a block) moves it.
const cursorTime = ref<number | null>(null)

// All filter-passing clips in time order — the continuous-playback sequence.
const playable = computed(() => recordings.value.filter(passesFilters).sort((a, b) => a.startedAt - b.startedAt))
const clipAtOrAfter = (time: number): RecordingClip | null => playable.value.find((c) => clipEnd(c) >= time) ?? null

function playClip(clip: RecordingClip, offsetSec = 0): void {
  const audio = playerRef.value
  if (!audio) return
  playingId.value = clip.id
  selectedId.value = clip.id
  posSec.value = offsetSec
  cursorTime.value = clip.startedAt + offsetSec * 1000
  audio.src = clipUrl(clip.id)
  audio.load()
  const begin = (): void => {
    audio.removeEventListener('loadedmetadata', begin)
    const dur = Number.isFinite(audio.duration) ? audio.duration : offsetSec
    try {
      audio.currentTime = Math.min(offsetSec, Math.max(0, dur - 0.05))
    } catch {
      /* seeking can reject before metadata on some browsers */
    }
    audio.play().then(() => (playing.value = true)).catch(() => (playing.value = false))
  }
  if (audio.readyState >= 1) begin()
  else audio.addEventListener('loadedmetadata', begin)
}
function pause(): void {
  playerRef.value?.pause()
  playing.value = false
}
function togglePlay(): void {
  if (playing.value) return pause()
  // A loaded-but-paused clip resumes EXACTLY where it stopped (the audio element still holds it).
  const audio = playerRef.value
  if (audio && selectedId.value && playingId.value === selectedId.value && audio.src) {
    void audio.play().then(() => (playing.value = true)).catch(() => (playing.value = false))
    return
  }
  const start = cursorTime.value ?? playable.value[0]?.startedAt ?? now.value
  const clip = clipAtOrAfter(start)
  if (clip) playClip(clip, Math.max(0, (start - clip.startedAt) / 1000))
}
function playNext(): void {
  const cur = recordings.value.find((c) => c.id === playingId.value)
  const after = cur ? clipEnd(cur) + 1 : (cursorTime.value ?? now.value) + 1
  const next = clipAtOrAfter(after)
  if (next) playClip(next, 0)
  else {
    pause()
    playingId.value = null
  }
}
function onEnded(): void {
  playNext() // continuous: roll into the next clip
}
function onTimeupdate(): void {
  const audio = playerRef.value
  const clip = recordings.value.find((c) => c.id === playingId.value)
  if (audio && clip) {
    cursorTime.value = clip.startedAt + audio.currentTime * 1000
    if (clip.id === selectedId.value) posSec.value = audio.currentTime
  }
}
/** Player-bar scrubber: seek WITHIN the loaded clip. If it's already in the audio element this is
 * an exact currentTime seek (works paused or playing); otherwise load it at that offset. */
function seekWithin(sec: number): void {
  const clip = selected.value
  if (!clip) return
  posSec.value = sec
  cursorTime.value = clip.startedAt + sec * 1000
  const audio = playerRef.value
  if (audio && playingId.value === clip.id && audio.src) {
    try {
      audio.currentTime = sec
    } catch {
      /* pre-metadata seek — playClip handles it */
    }
  } else {
    playClip(clip, sec)
  }
}
// Move the cursor to a timeline position; if playing, resume from there.
function seekTo(time: number): void {
  cursorTime.value = time
  if (playing.value) {
    const clip = clipAtOrAfter(time)
    if (clip) playClip(clip, Math.max(0, (time - clip.startedAt) / 1000))
    else pause()
  }
}
function seekFromTrack(e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement
  const frac = Math.max(0, Math.min(1, e.offsetX / el.clientWidth))
  seekTo(windowStart.value + frac * windowMs.value)
}

const modeClass = (mode: string | null): 'dmr' | 'fm' => (mode === 'DMR' || mode === 'D+A' ? 'dmr' : 'fm')
// Block color: the operator's own transmissions are ORANGE regardless of mode; RX by mode.
const clipColor = (c: AnyClip): string =>
  isTx(c)
    ? 'linear-gradient(180deg,#f0883e,#d1601f)'
    : modeClass(c.mode) === 'dmr'
      ? 'linear-gradient(180deg,#58a6ff,#1f6feb)'
      : 'linear-gradient(180deg,#3fb950,#2ea043)'

function placeBlock(startedAt: number, durationMs: number, c: AnyClip): Record<string, string> {
  const span = windowMs.value
  const left = ((startedAt - windowStart.value) / span) * 100
  const width = (durationMs / span) * 100
  return {
    left: `${Math.max(0, left)}%`,
    width: `${Math.max(0.6, Math.min(width, 100 - Math.max(0, left)))}%`,
    background: clipColor(c),
  }
}
const blockStyle = (c: RecordingClip): Record<string, string> => placeBlock(c.startedAt, c.durationMs, c)
// An in-progress block grows to "now" every ticker tick — RED while recording (it takes its
// mode/direction color only once saved).
const liveBlockStyle = (c: LiveRecording): Record<string, string> => ({
  ...placeBlock(c.startedAt, Math.max(500, now.value - c.startedAt), c),
  background: 'linear-gradient(180deg,#f85149,#c93c37)',
})

// ── Drag-to-pan (touch + mouse) ─────────────────────────────────────────────────
// Horizontal drag anywhere on the timeline pans the window; a tap (< 6 px) falls through to the
// normal click handlers (seek / play). `touch-action: pan-y` keeps vertical page scroll working.
const drag = { active: false, moved: false, lastX: 0, width: 1 }
function onPanStart(e: PointerEvent): void {
  drag.active = true
  drag.moved = false
  drag.lastX = e.clientX
  drag.width = Math.max(1, (e.currentTarget as HTMLElement).clientWidth - laneColPx.value)
}
function onPanMove(e: PointerEvent): void {
  if (!drag.active) return
  const dx = e.clientX - drag.lastX
  if (!drag.moved && Math.abs(dx) < 6) return // still a tap
  drag.moved = true
  drag.lastX = e.clientX
  // dragging right moves the window into the past (content follows the finger)
  panMs.value = Math.min(0, panMs.value - (dx / drag.width) * windowMs.value)
}
function onPanEnd(): void {
  drag.active = false
}
/** Swallow the click that ends a drag so it doesn't seek/play. */
function onTimelineClickCapture(e: MouseEvent): void {
  if (drag.moved) {
    e.stopPropagation()
    e.preventDefault()
    drag.moved = false
  }
}

// Playhead fraction across the track: the cursor when set, else live "now".
const playheadFrac = computed(() => {
  const t = cursorTime.value ?? (live.value ? now.value : null)
  if (t == null) return null
  const frac = (t - windowStart.value) / windowMs.value
  return frac >= 0 && frac <= 1 ? frac : null
})

const ticks = computed(() => {
  const out: { left: number; label: string }[] = []
  const n = 6
  for (let i = 0; i <= n; i += 1) {
    const t = windowStart.value + (windowMs.value * i) / n
    out.push({ left: (i / n) * 100, label: new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
  }
  return out
})

function pan(dir: -1 | 1): void {
  panMs.value = Math.min(0, panMs.value + dir * windowMs.value * 0.5)
}
function goLive(): void {
  panMs.value = 0
  cursorTime.value = null
}

const selected = computed(() => recordings.value.find((c) => c.id === selectedId.value) ?? null)
const clipUrl = (id: string): string => `${import.meta.env.BASE_URL}recordings/${id}.wav`
const fmtTime = (ms: number): string =>
  new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtDur = (ms: number): string => `${(ms / 1000).toFixed(1)}s`
const fmtFreq = (mhz: number | null): string => (mhz == null ? '' : `${mhz.toFixed(4)} MHz`)
const clipTitle = (c: RecordingClip): string =>
  `${isTx(c) ? 'TX · ' : ''}${c.channelName || '—'}${c.mode ? ` [${c.mode}]` : ''} · ${fmtTime(c.startedAt)} · ${fmtDur(c.durationMs)}`
const windowLabel = computed(() => `${fmtTime(windowStart.value)} — ${live.value ? 'now' : fmtTime(windowEnd.value)}`)

async function toggleRecorder(): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await radio.recordingsSetEnabled(!status.value.enabled) // status updates via the pushed event
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
async function remove(id: string): Promise<void> {
  try {
    if (playingId.value === id) pause()
    await radio.recordingsDelete(id) // list updates via the pushed event
    if (selectedId.value === id) selectedId.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(async () => {
  ticker = window.setInterval(() => (now.value = Date.now()), 1000)
  mq.addEventListener('change', onMq)
  try {
    await radio.loadRecordings()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})
onBeforeUnmount(() => {
  window.clearInterval(ticker)
  mq.removeEventListener('change', onMq)
})
</script>

<template>
  <section class="status-panel rec-panel">
    <div class="status-panel-header rec-head">
      <div class="rec-title-row">
        <span class="scope-title">Recordings</span>
        <span class="rec-count">{{ visibleCount }}</span>
        <span class="rec-state" :class="{ 'rec-state--on': status.enabled, 'rec-state--live': liveLabel }">
          <span class="rec-dot" />{{ liveLabel ? `REC · ${liveLabel}` : status.enabled ? 'Recording squelch + TX' : 'Recorder off' }}
        </span>
      </div>
      <button
        class="btn btn-sm"
        :class="status.enabled ? 'btn-danger' : 'btn-primary'"
        :disabled="busy"
        @click="toggleRecorder"
      >{{ status.enabled ? 'Stop' : 'Record Squelch' }}</button>
    </div>

    <!-- Context strip — VIEWPORT controls (where am I looking) left, DATA controls (what am I
         seeing) right. Playback lives in the player bar at the bottom, not here. -->
    <div class="rec-controls">
      <template v-if="effectiveView === 'lanes'">
        <span class="rec-ctl-group">
          <button class="btn btn-ghost btn-sm" title="Older" @click="pan(-1)">‹</button>
          <button class="btn btn-ghost btn-sm" :class="{ 'rec-live': live && cursorTime == null }" @click="goLive">Now</button>
          <button class="btn btn-ghost btn-sm" title="Newer" :disabled="live" @click="pan(1)">›</button>
        </span>
        <label class="rec-field">
          <AppSelect v-model="windowHours" :options="WINDOWS.map((w) => ({ value: w.hours, label: w.label }))" aria-label="Timeline window" />
        </label>
        <span class="rec-window-label">{{ windowLabel }}</span>
      </template>
      <span class="rec-strip-spacer" />
      <label class="rec-field">Channel
        <AppSelect v-model="channelFilter" :options="[{ value: 'all', label: 'All' }, ...channels.map((ch) => ({ value: ch.key, label: ch.label }))]" aria-label="Channel filter" />
      </label>
      <label class="rec-field rec-field--range" title="Hide clips shorter than this">Min
        <AppSlider v-model="minDurationSec" :min="0" :max="30" aria-label="Minimum clip duration" />
        <span class="rec-range-val">{{ minDurationSec }}s</span>
      </label>
      <span class="rec-ctl-group rec-view-toggle" role="group" aria-label="View">
        <button class="btn btn-ghost btn-sm" :class="{ 'rec-view-on': effectiveView === 'lanes' }" title="Timeline lanes (best on wide screens); tap again for auto" @click="setView(viewMode === 'lanes' ? 'auto' : 'lanes')">▤</button>
        <button class="btn btn-ghost btn-sm" :class="{ 'rec-view-on': effectiveView === 'feed' }" title="Activity feed (best on phones); tap again for auto" @click="setView(viewMode === 'feed' ? 'auto' : 'feed')">☰</button>
      </span>
    </div>

    <p v-if="error" class="rec-error">{{ error }}</p>

    <!-- ═══ FEED (vertical, newest first) — the phone-width projection of the same data ═══ -->
    <div v-if="effectiveView === 'feed'" class="rec-feed">
      <!-- recording IN PROGRESS: pinned, pulsing -->
      <div v-for="clip in liveRecordings" :key="clip.id" class="rec-feed-live">
        <span class="rec-dot" />
        <span class="rec-feed-live-label">REC · {{ isTx(clip) ? 'TX ' : '' }}{{ laneLabel(clip) }}</span>
        <span class="rec-feed-live-dur">{{ liveElapsed(clip) }}</span>
      </div>

      <p v-if="!feedGroups.length && !liveRecordings.length" class="rec-empty">
        {{ status.enabled ? 'No recordings yet — clips appear as squelch opens or you transmit.' : 'Recorder is off. Enable it to capture squelch + TX audio.' }}
      </p>

      <template v-for="group in feedGroups" :key="group.label">
        <div class="rec-feed-head">{{ group.label }}</div>
        <button
          v-for="clip in group.clips"
          :key="clip.id"
          type="button"
          class="rec-row"
          :class="{ 'rec-row--sel': clip.id === selectedId, 'rec-row--playing': clip.id === playingId }"
          @click="playClip(clip, 0)"
        >
          <i class="rec-row-edge" :style="{ background: clipColor(clip) }" />
          <span class="rec-row-main">
            <span class="rec-row-title">
              {{ laneLabel(clip) }}
              <span v-if="isTx(clip)" class="rec-pill rec-pill--tx">TX</span>
              <span v-else-if="clip.mode" class="rec-pill" :class="`rec-pill--${modeClass(clip.mode)}`">{{ clip.mode }}</span>
            </span>
            <span class="rec-row-bar"><i :style="{ width: durFrac(clip.durationMs) + '%', background: clipColor(clip) }" /></span>
          </span>
          <span class="rec-row-meta">
            <span class="rec-row-time">{{ fmtClock(clip.startedAt) }}</span>
            <span class="rec-row-dur">{{ fmtDur(clip.durationMs) }}</span>
          </span>
        </button>
      </template>
      <p v-if="feedTotal > FEED_CAP" class="rec-feed-more">showing the latest {{ FEED_CAP }} of {{ feedTotal }}</p>
    </div>

    <!-- ═══ LANES (horizontal time axis) — the wide-screen projection ═══ -->
    <div v-if="effectiveView === 'lanes'" class="rec-window-row">
      <span class="rec-legend">
        <span class="rec-legend-item"><i class="rec-swatch rec-swatch--fm" />FM</span>
        <span class="rec-legend-item"><i class="rec-swatch rec-swatch--dmr" />DMR</span>
        <span class="rec-legend-item"><i class="rec-swatch rec-swatch--tx" />TX</span>
        <span class="rec-legend-item"><i class="rec-swatch rec-swatch--rec" />live</span>
      </span>
    </div>

    <div
      v-if="effectiveView === 'lanes'"
      class="rec-timeline"
      :style="{ '--lane-col': laneColPx + 'px' }"
      @pointerdown="onPanStart"
      @pointermove="onPanMove"
      @pointerup="onPanEnd"
      @pointercancel="onPanEnd"
      @pointerleave="onPanEnd"
      @click.capture="onTimelineClickCapture"
    >
      <div class="rec-axis">
        <span class="rec-lane-label rec-axis-label">Channel</span>
        <div class="rec-axis-track">
          <span v-for="(t, i) in ticks" :key="i" class="rec-tick" :style="{ left: t.left + '%' }">{{ t.label }}</span>
        </div>
      </div>

      <p v-if="!lanes.length" class="rec-empty">
        {{ status.enabled ? 'No recordings in this window — clips appear as squelch opens.' : 'Recorder is off. Enable it to capture squelch audio.' }}
      </p>

      <div v-for="lane in lanes" :key="lane.key" class="rec-lane">
        <button class="rec-lane-label" :title="lane.label" @click="channelFilter = channelFilter === lane.key ? 'all' : lane.key">
          <!-- name in its own span: text-overflow can't ellipsize anonymous flex text -->
          <span class="rec-lane-name">{{ lane.label }}</span>
          <span v-if="lane.mode" class="rec-lane-mode" :class="`rec-lane-mode--${modeClass(lane.mode)}`">{{ lane.mode }}</span>
        </button>
        <!-- Click empty track → move the cursor there (seek); click a block → play that clip. -->
        <div class="rec-lane-track" @click="seekFromTrack">
          <button
            v-for="clip in lane.clips"
            :key="clip.id"
            type="button"
            class="rec-block"
            :class="{ 'rec-block--sel': clip.id === selectedId, 'rec-block--playing': clip.id === playingId, 'rec-block--tx': isTx(clip) }"
            :style="blockStyle(clip)"
            :title="clipTitle(clip)"
            @click.stop="playClip(clip, 0)"
          />
          <!-- Recording IN PROGRESS: grows toward "now", pulsing — not clickable (no audio yet). -->
          <div
            v-for="clip in lane.live"
            :key="clip.id"
            class="rec-block rec-block--rec"
            :style="liveBlockStyle(clip)"
            :title="`Recording… ${laneLabel(clip)}${isTx(clip) ? ' (TX)' : ''}`"
          />
        </div>
      </div>

      <!-- the FUTURE region (right of "now" while live) — shaded so it reads as "not yet" -->
      <div v-if="live && lanes.length" class="rec-future" :style="{ left: `calc(var(--lane-col) + (100% - var(--lane-col)) * ${(1 - FUTURE_FRAC).toFixed(4)})` }" />
      <div v-if="playheadFrac != null" class="rec-playhead" :class="{ 'rec-playhead--playing': playing }" :style="{ left: `calc(var(--lane-col) + (100% - var(--lane-col)) * ${playheadFrac.toFixed(4)})` }" />
    </div>

    <!-- ═══ PLAYER BAR — the single playback surface (both views): transport, the loaded clip,
         its in-clip scrubber, and the clip actions. Always present, so the layout never jumps. -->
    <div class="rec-player">
      <div class="rec-player-main">
        <!-- Inline SVGs, not unicode glyphs: iOS renders ⏭/🗑/⬇ as color emoji. -->
        <span class="rec-ctl-group">
          <button class="btn btn-primary btn-sm rec-player-play" :disabled="!playable.length && !selected" :title="playing ? 'Pause' : 'Play'" @click="togglePlay">
            <svg v-if="playing" class="rec-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
            <svg v-else class="rec-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="!playable.length" title="Next clip" @click="playNext">
            <svg class="rec-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l8.5 6L6 18V6zM16 6h2v12h-2z" /></svg>
          </button>
        </span>
        <div class="rec-player-info">
          <template v-if="selected">
            <span class="rec-player-title">{{ laneLabel(selected) }}</span>
            <span v-if="isDmrClip(selected) && selected.channelName" class="rec-player-sub">{{ selected.channelName }}</span>
            <span v-if="isTx(selected)" class="rec-pill rec-pill--tx">TX</span>
            <span v-else-if="selected.mode" class="rec-pill" :class="`rec-pill--${modeClass(selected.mode)}`">{{ selected.mode }}</span>
            <span class="rec-player-meta">{{ fmtTime(selected.startedAt) }}</span>
            <span v-if="selected.freqMHz != null" class="rec-player-meta">{{ fmtFreq(selected.freqMHz) }}</span>
          </template>
          <span v-else class="rec-player-idle">Select a clip — or press play to run the timeline from the cursor</span>
        </div>
        <span class="rec-player-actions">
          <a v-if="selected" class="btn btn-sm btn-ghost" :href="clipUrl(selected.id)" :download="`${selected.id}.wav`" title="Download WAV">
            <svg class="rec-icon rec-icon--stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M4.5 20h15" /></svg>
          </a>
          <button v-if="selected" class="btn btn-sm btn-ghost rec-player-del" title="Delete this clip" @click="remove(selected.id)">
            <svg class="rec-icon rec-icon--stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6.5 7l1 12a2 2 0 002 2h5a2 2 0 002-2l1-12M9.5 7V5a1 1 0 011-1h3a1 1 0 011 1v2" /></svg>
          </button>
        </span>
      </div>
      <div v-if="selected" class="rec-player-scrub">
        <span class="rec-player-pos">{{ posSec.toFixed(1) }}s</span>
        <AppSlider class="rec-player-slider" :model-value="posSec" :min="0" :max="selected.durationMs / 1000" :step="0.1" aria-label="Position in clip" @update:model-value="seekWithin" />
        <span class="rec-player-pos">{{ fmtDur(selected.durationMs) }}</span>
      </div>
    </div>

    <!-- Single hidden player drives continuous timeline playback (auto-advances via @ended). -->
    <audio ref="playerRef" class="rec-audio-hidden" preload="metadata" @timeupdate="onTimeupdate" @ended="onEnded" @pause="playing = false" @play="playing = true" />
  </section>
</template>

<style scoped>
.rec-head { align-items: center; gap: 10px; flex-wrap: wrap; }
.rec-title-row { display: flex; align-items: center; gap: 10px; }
.rec-count {
  min-width: 20px; padding: 1px 7px; border-radius: 999px; text-align: center;
  background: var(--surface-2, #21262d); color: var(--text-muted, #8b949e); font-size: 11px; font-weight: 700;
}
.rec-state { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted, #8b949e); text-transform: uppercase; letter-spacing: .05em; }
.rec-state--on { color: var(--red, #f85149); }
.rec-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .5; }
.rec-state--on .rec-dot { opacity: 1; animation: rec-pulse 1.1s ease-in-out infinite; }
@keyframes rec-pulse { 50% { opacity: .3; } }
.rec-head > .btn { margin-left: auto; }

.rec-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 10px; }
.rec-ctl-group { display: inline-flex; gap: 4px; }
/* pushes the data controls (filters + view toggle) to the right edge of the strip */
.rec-strip-spacer { flex: 1; }
.rec-live { color: var(--green, #3fb950); border-color: rgba(63,185,80,.5); }
.rec-field { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted, #8b949e); }
.rec-field--range .app-slider { width: 90px; }
.rec-range-val { font-family: var(--font-mono); color: var(--text, #e6edf3); }
.rec-error { color: var(--red, #f85149); font-size: 12px; margin: 6px 0; }
.rec-window-row { margin-top: 8px; display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.rec-window-label { font-size: 11px; font-family: var(--font-mono); color: var(--text-muted, #8b949e); }
.rec-legend { display: inline-flex; gap: 10px; font-size: 10px; color: var(--text-muted, #8b949e); text-transform: uppercase; letter-spacing: .05em; }
.rec-legend-item { display: inline-flex; align-items: center; gap: 4px; }
.rec-swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.rec-swatch--fm { background: linear-gradient(180deg,#3fb950,#2ea043); }
.rec-swatch--dmr { background: linear-gradient(180deg,#58a6ff,#1f6feb); }
.rec-swatch--tx { background: linear-gradient(180deg,#f0883e,#d1601f); }
.rec-swatch--rec { background: rgba(248,81,73,.85); animation: rec-pulse 1.1s ease-in-out infinite; }

/* touch-action pan-y: horizontal drags pan the timeline, vertical swipes still scroll the page.
   --lane-col = label column + gap; the playhead offset derives from it (kept in sync with the
   grid-template-columns below AND the narrow-screen override). */
.rec-timeline { --lane-col: 138px; margin-top: 6px; display: flex; flex-direction: column; gap: 4px; position: relative; touch-action: pan-y; cursor: grab; }
.rec-timeline:active { cursor: grabbing; }
/* label column derives from --lane-col (set inline, sized to the longest name) minus the grid gap */
.rec-axis, .rec-lane { display: grid; grid-template-columns: calc(var(--lane-col) - 8px) 1fr; align-items: center; gap: 8px; }
.rec-lane-label {
  font-size: 12px; color: var(--text, #e6edf3); font-weight: 600; text-align: left;
  background: none; border: none; cursor: pointer; padding: 0; display: flex; align-items: center; gap: 6px;
  min-width: 0;
}
.rec-lane-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.rec-lane-mode { flex: none; }
@media (hover: hover) {
  .rec-lane-label:hover { color: var(--accent, #58a6ff); }
}

.rec-lane-mode { font-size: 9px; font-weight: 800; padding: 1px 4px; border-radius: 3px; letter-spacing: .04em; }
.rec-lane-mode--dmr { background: rgba(88,166,255,.18); color: #58a6ff; }
.rec-lane-mode--fm { background: rgba(63,185,80,.18); color: #3fb950; }
.rec-axis-label { color: var(--text-muted, #8b949e); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
.rec-axis-track { position: relative; height: 16px; }
.rec-tick { position: absolute; top: 0; transform: translateX(-50%); font-size: 10px; color: var(--text-muted, #8b949e); font-family: var(--font-mono); white-space: nowrap; }
.rec-tick:first-child { transform: none; }
.rec-tick:last-child { transform: translateX(-100%); }
.rec-lane-track { position: relative; height: 22px; border-radius: 5px; background: var(--surface, #0d1117); border: 1px solid var(--border, #30363d); overflow: hidden; cursor: crosshair; }
.rec-block { position: absolute; top: 2px; bottom: 2px; min-width: 3px; border: none; border-radius: 3px; padding: 0; cursor: pointer; }
@media (hover: hover) {
  .rec-block:hover { filter: brightness(1.15); }
}

.rec-block--sel { outline: 2px solid var(--accent, #58a6ff); outline-offset: 1px; z-index: 3; }
.rec-block--playing { box-shadow: 0 0 0 2px #fff inset; }
/* recording IN PROGRESS: pulsing red edge racing toward "now"; not interactive (no audio yet) */
.rec-block--rec {
  cursor: default; z-index: 2; opacity: .9;
  border-right: 2px solid rgba(248,81,73,1);
  animation: rec-live-pulse 1.1s ease-in-out infinite;
}
@keyframes rec-live-pulse { 50% { opacity: .55; } }
.rec-state--live { color: var(--red, #f85149); font-weight: 700; }
.rec-playhead { position: absolute; top: 20px; bottom: 0; width: 2px; background: rgba(88,166,255,.85); pointer-events: none; z-index: 4; }
/* the not-yet region right of "now" — subtle hatching, clicks pass through to the tracks */
.rec-future {
  position: absolute; top: 20px; bottom: 0; right: 0; pointer-events: none; z-index: 1;
  background: repeating-linear-gradient(-45deg, rgba(139,148,158,.07) 0 6px, transparent 6px 12px);
  border-left: 1px dashed rgba(139,148,158,.25);
}
.rec-playhead--playing { background: rgba(248,81,73,.9); box-shadow: 0 0 6px rgba(248,81,73,.6); }
.rec-empty { margin: 8px 0 2px; padding: 10px; text-align: center; font-size: 12.5px; color: var(--text-muted, #8b949e); }

/* ── PLAYER BAR — the one playback surface ── */
.rec-player {
  margin-top: 12px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
  background: var(--surface-2, #161b22); border: 1px solid var(--border, #30363d); border-radius: 8px;
}
.rec-player-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.rec-player-play { min-width: 40px; }
/* icon buttons: filled shapes for transport, stroked outlines for the file actions */
.rec-icon { width: 14px; height: 14px; display: block; margin: 0 auto; fill: currentColor; }
.rec-icon--stroke { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.rec-player-main .btn { display: inline-flex; align-items: center; justify-content: center; }
.rec-player-actions .btn { min-width: 34px; }
.rec-player-info {
  flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  font-size: 12px; color: var(--text-muted, #8b949e);
}
.rec-player-title { font-size: 13px; font-weight: 700; color: var(--text, #e6edf3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rec-player-sub { font-size: 11px; }
.rec-player-meta { font-family: var(--font-mono); font-size: 11px; white-space: nowrap; }
.rec-player-idle { font-size: 12px; font-style: italic; }
.rec-player-actions { display: flex; gap: 4px; flex: none; }
.rec-player-actions a.btn { text-decoration: none; display: inline-flex; align-items: center; }
@media (hover: hover) {
  .rec-player-del:hover { color: var(--red, #f85149); border-color: rgba(248, 81, 73, .5); }
}

.rec-player-scrub { display: flex; align-items: center; gap: 10px; }
.rec-player-slider { flex: 1; }
.rec-player-pos { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted, #8b949e); min-width: 4ch; text-align: center; }
.rec-pill { font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 4px; align-self: center; }
.rec-pill--dmr { background: rgba(88,166,255,.18); color: #58a6ff; }
.rec-pill--fm { background: rgba(63,185,80,.18); color: #3fb950; }
.rec-pill--tx { background: rgba(240,136,62,.18); color: #f0883e; }
.rec-audio-hidden { display: none; }

/* ── FEED view (vertical, newest first — the phone projection) ─────────────────── */
.rec-feed { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.rec-feed-live {
  display: flex; align-items: center; gap: 8px; padding: 9px 10px;
  border: 1px solid rgba(248,81,73,.5); border-radius: 8px; background: rgba(248,81,73,.07);
  color: var(--red, #f85149); font-size: 12px; font-weight: 700;
}
.rec-feed-live .rec-dot { animation: rec-pulse 1.1s ease-in-out infinite; }
.rec-feed-live-dur { margin-left: auto; font-family: var(--font-mono); font-weight: 400; }
.rec-feed-head {
  margin-top: 6px; padding: 2px 2px 0; font-size: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .07em; color: var(--text-muted, #8b949e);
}
.rec-row {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; /* thumb-sized */
  padding: 6px 10px 6px 0; text-align: left; cursor: pointer;
  background: var(--surface, #0d1117); border: 1px solid var(--border, #30363d); border-radius: 8px;
  color: var(--text, #e6edf3);
}
@media (hover: hover) {
  .rec-row:hover { border-color: var(--accent, #58a6ff); }
}

.rec-row--sel { border-color: var(--accent, #58a6ff); background: rgba(88,166,255,.06); }
.rec-row--playing { border-color: var(--accent, #58a6ff); box-shadow: 0 0 0 1px var(--accent, #58a6ff); }
.rec-row-edge { align-self: stretch; width: 4px; border-radius: 8px 0 0 8px; flex: none; }
.rec-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.rec-row-title { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rec-row-bar { display: block; height: 4px; border-radius: 2px; background: var(--surface-2, #21262d); overflow: hidden; }
.rec-row-bar i { display: block; height: 100%; border-radius: 2px; }
.rec-row-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: none; }
.rec-row-time { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted, #8b949e); }
.rec-row-dur { font-family: var(--font-mono); font-size: 11px; color: var(--text, #e6edf3); }
.rec-feed-more { margin: 6px 0 0; text-align: center; font-size: 11px; color: var(--text-muted, #8b949e); }
.rec-view-on { color: var(--accent, #58a6ff); border-color: rgba(88,166,255,.55); background: rgba(88,166,255,.08); }

/* ── narrow screens: tighter lane labels, wrapped controls, finger-sized targets ── */
@media (max-width: 640px) {
  /* --lane-col comes from the component (92px when narrow); the 6px gap replaces the 8px one */
  .rec-axis, .rec-lane { grid-template-columns: calc(var(--lane-col) - 6px) 1fr; gap: 6px; }
  .rec-lane-label { font-size: 11px; }
  .rec-lane-track { height: 28px; } /* bigger touch targets */
  .rec-playhead { top: 18px; }
  .rec-controls { gap: 8px; }
  .rec-controls .btn { min-height: 32px; }
  .rec-field--range .app-slider { width: 64px; }
  .rec-legend { width: 100%; justify-content: flex-start; }
  .rec-window-label { display: none; } /* the range readout is a luxury at phone width */
  .rec-player-actions .btn, .rec-player-play { min-height: 36px; } /* thumb targets */
}
</style>
