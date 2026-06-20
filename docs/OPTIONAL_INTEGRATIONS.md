# OPTIONAL_INTEGRATIONS

Everything here is **not required** for the core AnyTone 578 controller (connect,
live state, PTT, side select, audio, recording) and degrades gracefully when
unavailable — a failed optional feature is logged, never surfaced as a core app
error.

## Squelch recording

**What:** records RX audio clips when squelch opens.

**Status:** local feature; writes MP3s to `CAT_DATA_PATH`/`.data` (gitignored).
No external service. Requires `ffmpeg` + BlueALSA at runtime.
