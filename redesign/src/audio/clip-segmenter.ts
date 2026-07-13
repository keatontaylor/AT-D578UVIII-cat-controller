// Squelch-triggered clip segmentation — PURE and unit-testable (the hard part of the recorder).
// Fed a stream of fixed-duration PCM frames + the live squelch-open state, it emits open/append/
// close events for recordable clips: a clip opens when squelch opens, appends while it stays open
// (plus a trailing tail so word-endings aren't clipped), and closes after the tail. Clips shorter
// than a minimum are dropped (a blip of noise isn't a recording). No I/O here — the Recorder does
// the disk work; this only decides boundaries, so silence-tail / min-duration logic is testable.

export interface SegmenterConfig {
  /** Frame duration in ms (RX capture emits 10 ms frames). */
  readonly frameMs: number
  /** Keep recording this long after squelch closes (captures the tail of speech). */
  readonly tailMs: number
  /** Discard a finished clip shorter than this (a squelch blip is not a recording). */
  readonly minDurationMs: number
}

export type ClipEvent =
  | { kind: 'open' }
  | { kind: 'append'; frame: Buffer }
  /** Close the current clip; `keep` is false when it was shorter than minDurationMs (discard it). */
  | { kind: 'close'; keep: boolean; durationMs: number }

/** Stateful-but-pure segmenter: `feed` returns the events for one frame, `flush` closes an open
 * clip (e.g. on stop). No timers — the caller drives it with frames + squelch state. */
export class ClipSegmenter {
  private recording = false
  private silenceMs = 0
  private clipMs = 0

  constructor(private readonly cfg: SegmenterConfig) {}

  feed(frame: Buffer, squelchOpen: boolean): ClipEvent[] {
    const events: ClipEvent[] = []
    if (!this.recording) {
      if (!squelchOpen) return events
      this.recording = true
      this.silenceMs = 0
      this.clipMs = 0
      events.push({ kind: 'open' })
    }
    // recording:
    events.push({ kind: 'append', frame })
    this.clipMs += this.cfg.frameMs
    if (squelchOpen) {
      this.silenceMs = 0
    } else {
      this.silenceMs += this.cfg.frameMs
      if (this.silenceMs >= this.cfg.tailMs) events.push(this.finish())
    }
    return events
  }

  /** Close any open clip (stop / disable). Returns the close event, or null if not recording. */
  flush(): ClipEvent | null {
    return this.recording ? this.finish() : null
  }

  private finish(): ClipEvent {
    // The trailing silence is tail padding, not signal — its length shouldn't make a blip "long
    // enough": measure the clip against its VOICED duration.
    const voicedMs = this.clipMs - this.silenceMs
    const keep = voicedMs >= this.cfg.minDurationMs
    const durationMs = this.clipMs
    this.recording = false
    this.silenceMs = 0
    this.clipMs = 0
    return { kind: 'close', keep, durationMs }
  }
}
