// Media Session integration: while listening, the OS-level media surfaces (iOS lock screen /
// Dynamic Island, Android notification, macOS now-playing) show the radio state as track
// metadata — selected side as the "title", other side as the "artist" — with lock-screen
// play/pause driving the audio element. Deliberately a DISPLAY surface, not a control surface:
// every other action is unregistered (the PoC's seek-steps-the-channel trick is retired).
// Ported from the PoC (pages/index.vue) onto v2's AppState + vfoView so labels match the cards.
//
// iOS quirks honored here (all PoC-learned):
//  • Lock-screen artwork must be PNG — iOS won't render SVG artwork; render the SVG to canvas
//    at the standard sizes and fall back to the raw SVG elsewhere.
//  • navigator.audioSession.type must be 'playback' while merely listening — otherwise Safari
//    routes us as a "call" (receiver speaker, orange mic dot). Only mic-armed flips it to
//    'play-and-record'.
//  • Metadata writes are debounced: smeter-rate state churn must not thrash the lock screen.

import { onBeforeUnmount, watch, type Ref } from 'vue'
import { useRadio } from './useRadio'
import { lockScreenLines } from '../../src/domain/view'

const ARTWORK_SOURCE = `${import.meta.env.BASE_URL}media/radio.svg`
const ARTWORK_SIZES = [96, 256, 512] as const

type Artwork = { src: string; sizes: string; type: string }

const svgArtwork: Artwork[] = ARTWORK_SIZES.map((size) => ({ src: ARTWORK_SOURCE, sizes: `${size}x${size}`, type: 'image/svg+xml' }))
let artwork: Artwork[] = svgArtwork
let artworkLoaded = false

function renderSvgArtworkAsPng(src: string): Promise<Artwork[]> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      try {
        resolve(
          ARTWORK_SIZES.map((size) => {
            const canvas = document.createElement('canvas')
            canvas.width = size
            canvas.height = size
            const ctx = canvas.getContext('2d')
            if (!ctx) throw new Error('canvas unavailable')
            ctx.drawImage(image, 0, 0, size, size)
            return { src: canvas.toDataURL('image/png'), sizes: `${size}x${size}`, type: 'image/png' }
          }),
        )
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    image.onerror = () => reject(new Error('artwork failed to load'))
    image.src = src
  })
}

/** Safari 17+ audio routing hint — see the file comment. No-op elsewhere. */
export function setAudioSessionType(type: 'playback' | 'play-and-record' | 'auto'): void {
  const session = (navigator as unknown as { audioSession?: { type?: string } }).audioSession
  if (!session) return
  try {
    session.type = type
  } catch {
    /* older Safari: readonly */
  }
}

export interface MediaSessionHooks {
  /** The live audio element (null when not listening). */
  el: () => HTMLAudioElement | null
  listening: Ref<boolean>
  /** Re-start listening from a lock-screen "play" after the session went away entirely. */
  start: () => void
}

export function useMediaSession(hooks: MediaSessionHooks): void {
  const radio = useRadio()
  const session = navigator.mediaSession
  if (!session) return

  let lastKey = ''
  let debounce: number | undefined

  const applyMetadata = (): void => {
    const rs = radio.state.value?.radio
    if (!rs || typeof MediaMetadata === 'undefined') return
    // The two lines are DOMAIN (lockScreenLines, tested with the view model): caller-id
    // promotion for a presented RX DMR call, RX promotion of the first-wins receiving side
    // (the recorder's holder-latch attribution) for everything audible — analog included —
    // and the scan-honest ACQUIRING/locked progression while the scanner owns a side.
    const { title, artist } = lockScreenLines(rs)
    const album = radio.state.value?.connected ? 'Remote RX · AT-D578UVIII' : 'Remote RX'
    const key = [title, artist, album, artworkLoaded ? 'png' : 'svg'].join('\u0000')
    if (key === lastKey) return
    lastKey = key
    try {
      session.metadata = new MediaMetadata({ title, artist, album, artwork })
    } catch {
      /* metadata is best-effort */
    }
  }

  const applyPlaybackState = (): void => {
    const el = hooks.el()
    try {
      session.playbackState = hooks.listening.value ? (el && !el.paused ? 'playing' : 'paused') : 'none'
    } catch {
      /* best-effort */
    }
  }

  const schedule = (): void => {
    if (!hooks.listening.value) return
    if (debounce) window.clearTimeout(debounce)
    debounce = window.setTimeout(() => {
      debounce = undefined
      applyMetadata()
      applyPlaybackState()
    }, 120)
  }

  const ALL_ACTIONS: MediaSessionAction[] = ['play', 'pause', 'seekbackward', 'seekforward', 'stop', 'seekto', 'previoustrack', 'nexttrack']

  /** Full teardown: iOS keeps the lock-screen player alive as long as ANY action handler is
   * registered — metadata=null alone leaves a zombie widget whose buttons do nothing. */
  const clearHandlers = (): void => {
    if (!session.setActionHandler) return
    for (const action of ALL_ACTIONS) {
      try {
        session.setActionHandler(action, null)
      } catch {
        /* action unsupported on this platform */
      }
    }
  }

  const setHandlers = (): void => {
    if (!session.setActionHandler) return
    const handlers: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      [
        'play',
        () => {
          const el = hooks.el()
          if (el) void el.play().then(applyPlaybackState)
          else if (!hooks.listening.value) hooks.start()
        },
      ],
      [
        'pause',
        () => {
          hooks.el()?.pause()
          applyPlaybackState()
        },
      ],
      // No lock-screen ⏮/⏭: the PoC's channel-step party trick was retired — an accidental
      // pocket-press retuning the radio is worse than the novelty. (Play/pause can't be removed:
      // iOS always offers it for playing audio; unregistered it just pauses the element anyway.)
      ['seekbackward', null],
      ['seekforward', null],
      ['stop', null],
      ['seekto', null],
      ['previoustrack', null],
      ['nexttrack', null],
    ]
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler)
      } catch {
        /* action unsupported on this platform */
      }
    }
  }

  // PNG artwork once, lazily — before the first listen it's never needed
  const ensureArtwork = (): void => {
    if (artworkLoaded) return
    void renderSvgArtworkAsPng(ARTWORK_SOURCE)
      .then((png) => {
        artwork = png
        artworkLoaded = true
        schedule()
      })
      .catch(() => {
        /* keep the SVG fallback */
      })
  }

  const stopStateWatch = watch(
    () => radio.state.value?.radio,
    () => schedule(),
    { deep: true },
  )
  const stopListenWatch = watch(hooks.listening, (on) => {
    if (on) {
      ensureArtwork()
      setHandlers()
      lastKey = '' // force a metadata write for the new session
      applyMetadata()
      applyPlaybackState()
    } else {
      // Audio disabled → tear the OS media surface down COMPLETELY: state, metadata, and every
      // action handler. Anything less leaves dead controls on the iOS lock screen. (This also
      // retires the lock-screen-play-restarts-listening trick — a control surface for a stopped
      // session is exactly the zombie we're removing.)
      applyPlaybackState() // → 'none'
      try {
        session.metadata = null
      } catch {
        /* best-effort */
      }
      clearHandlers()
      lastKey = ''
    }
  })

  onBeforeUnmount(() => {
    stopStateWatch()
    stopListenWatch()
    if (debounce) window.clearTimeout(debounce)
    clearHandlers()
  })
}
