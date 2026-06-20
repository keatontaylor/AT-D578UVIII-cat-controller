# DATA_FLOW

End-to-end tracing of how data moves through the AnyTone controller. Each flow
lists source → destination, the intermediate functions, the data shape, failure
modes, logging, and a confidence level. Line references are to
`app/anytone-server.mjs` unless noted.

Confidence = how sure this doc is about the *current code behavior* (not the
protocol; protocol confidence lives in PROTOCOL.md).

---

## Flow 1 — Connect

**Source:** UI Connect button → `POST /anytone/api/connect` → proxy
`connect.post.ts` → backend `POST /anytone/connect`.
**Destination:** radio HFP + SPP up; backend state `connected:true`.

Path: `handleRequest` → `backend.connect()` (mjs:229):
1. `startBluealsaHfp()` (mjs:285) — reuse existing BlueALSA if PCM present,
   else stop wireplumber, `pkill bluealsa`, spawn `sudo bluealsa -p hfp-hf`,
   `bluetoothctl disconnect/connect`, poll `bluealsa-cli list-pcms` ≤15 s.
2. `openRfcomm()` (mjs:352) — `sudo rfcomm release` then `connect`, wait for
   `/dev/rfcomm10` ≤12 s, open `SerialPort`, attach `data`/`error`/`close`.
3. `runStartup()` (mjs:385) — WAKE×3, COM MODE×2, then `STARTUP_READS`
   (firmware/settings/zones/channels/clock/status).
4. `scheduleKeepalive()` begins the poll loop.

**Shape:** returns `getState()` (the UI-facing state object).
**Failure modes:** BlueALSA PCM never appears; rfcomm device never appears;
serial open error → caught, `disconnect(false)`, state gets `error`, throws.
**Logging:** `this.log(...)` ring (80 entries) → surfaced in state `logs`.
**Confidence:** High.

---

## Flow 2 — Live Status (BT Push Stream / Wired Poll)

**Source:** BT radio unsolicited status pushes; wired `keepaliveTimer` polls.
**Destination:** updated `signal`/squelch in state → SSE → UI S-meters.

Path: serial `data` → `ingest()` → `extractFrames()` → `dispatch()` →
`decodePayload()` → `applyDecoded()` → `emitState()`. BT steady state matches
the MITM BT-01 pattern: pushed `5a/5b/58/59/5c/5e/5f` frames, with no periodic
clock/status writes after startup. Wired has no push stream, so it polls `04 5a`.

**Shape:** 5a → per-side RSSI + open bitmask; 5b/5e → global squelch/DMR gate.
DMR meter is 5e-latched; BT analog meters are event-driven and retain the last
radio-reported state until another push changes it. Wired analog meters require
a recent 5a poll and fail closed if polling stalls. Mapped to
`mainSmeter/subSmeter` in `anytoneToState()`.
**Failure modes:** serial error → `patch({error})`; ACK-required push framing
bugs can stall later status pushes.
**Logging:** every dispatched frame logs `ASYNC <type> [<head>] <raw>`.
**Races:** wired keepalive shares the queue with commands. BT async pushes always
flow through the continuous reader.
**Confidence:** High (mechanics) · RSSI calibration: Low (see PROTOCOL.md).

---

## Flow 3 — Unsolicited push frames (5a / 5b / 58 / 59 / 5c / 5e / 5f)

**Source:** radio pushes frames between polls → `SerialPort` `data` event
(mjs:371).
**Destination:** live state + `captures/unsolicited.ndjson` (gitignored) + in-memory
ring (`state.asyncFrames`, last 300).

Path: `data` handler appends to `rxBuffer` → incremental framer isolates complete
fixed/variable frames → `dispatch()` → `decodePayload()` → `recordAsyncFrame()`
(ring + NDJSON via `appendAsyncLog`) → live `signal` / `rx-status` /
`async-status` frames update state and may emit to the UI.

**Shape:** NDJSON entries `{at, iso, type, head, length, checksumOk, raw, …}`.
**Failure modes:** ACKed pushes (`58/59/5c/5e/5f`) must be framed separately and
replied to with `03 <op> 00 00`; otherwise the radio repeats the same push and
the 5a S-meter stream stalls. Async-push variant offsets differ by 1 byte
(handled in decode).
**Logging:** `ASYNC <type> [<head>] <raw>` per frame.
**Confidence:** High for frame mechanics; RSSI calibration remains uncalibrated.

---

## Flow 4 — PTT (TX)

**Source:** UI key/unkey → `POST /anytone/api/command {command:"TX1"|"TX0"}`.
**Destination:** radio transmitter on/off; HFP mic sink gated.

Path: `command.post.ts` first toggles `setWebRtcTxPttActive(on)` (gates mic
audio), then proxies `/anytone/command` → `setPtt(on)` (mjs:529):
- enqueue → write `56 01…`/`56 00…` (23-byte frame), read ACK `03 56 00 00 59`;
  on **release** also drain the radio's async `5e` burst and apply it.
- `pttWatchdog` (mjs:565) force-releases after `PTT_MAX_MS` (60 s default).

**Shape:** returns `getState()` with `txState`.
**Failure modes:** if write never goes out, a single safety release is sent.
**Important protocol hazard:** a *duplicate* `56 00` re-triggers the radio's
release-`5e` push and can wedge the status stream — the code is deliberately
careful to send exactly one release on the happy path (mjs:553-560).
**Logging:** `PTT keyed/released`, watchdog messages.
**Confidence:** High (confirmed live, see PROTOCOL.md).

---

## Flow 5 — Side / VFO select (A ↔ B)

**Source:** UI VFO-card click → `command {command:"FT0"|"FT1"}`.
**Destination:** radio active side; settings byte 37 toggles.

Path: `/anytone/command` → `selectSide('A'|'B')` (mjs:499): write
`SELECT_SIDE_A/B` (proven raw `08 19 00/01 …` frame), read ACK, inline re-read
`READ_SETTINGS` so `txVfo` updates immediately, then `refreshState()`
(zone/channel/settings re-read).
**Failure modes:** SPP closed → throws. **Confidence:** High (confirmed write).

---

## Flow 6 — Key press (UP/DOWN/keypad/etc.)

**Source:** `command {command:"KEY_up"|…}`.
**Destination:** intended channel/menu nav — **currently a no-op on the radio.**

Path: `/anytone/command` KEY_* → `pressKey(code)` (mjs:474): write `41`-frame
press/release variants, read responses, `refreshState()`.
**Status:** Per PROTOCOL.md, `41`/`56`-family key frames are **not accepted over
Bluetooth** — they ACK or do nothing; no channel change. `UP`/`DN` return
**HTTP 501** by design. This whole flow is exploratory and should be marked
`TODO_ANYTONE` (see ANYTONE_578_NOTES.md). **Confidence:** High that it is a
no-op; the feature is intentionally unimplemented.

---

## Flow 7 — State → UI (SSE)

**Source:** any `emitState()` / `patch()`.
**Destination:** all SSE clients.

Path: backend `stateChange` → `handleEvents` (mjs:1430) writes
`data: <getState()>\n\n`. The UI connects via `events.get.ts` (mjs proxy that
pipes the upstream SSE with backpressure, `X-Accel-Buffering: no` for nginx).
**Failure modes:** upstream ≥400 → 503 before headers, else stream ends cleanly;
client `close` tears down both ends.
**Confidence:** High.

---

## Flow 8 — RX audio (radio → browser)

**Source:** BlueALSA HFP `source` PCM (8 kHz mono).
**Destination:** browser via WebRTC (`audio/webrtc*`) or chunked stream
(`audio/stream`).

Path (Nuxt server, no radio control): `rx-audio-capture.ts` spawns `bluealsa-cli
open <source>` piped through `ffmpeg`; `webrtc-audio.ts` builds a `@roamhq/wrtc`
peer and an RX mix (main/sub gain). Squelch detection (`rx-squelch.ts`) drives
recordings (`recordings.ts` → MP3 in `.data/recordings/<day>/`).
**Failure modes:** ffmpeg/BlueALSA missing → capture errors surfaced via status
endpoints; child exit logged. **Confidence:** Medium (subsystem not deeply
re-verified this pass).

---

## TX audio (browser mic → radio)

`webrtc-audio.ts` publishes normalized browser-mic PCM to the BlueALSA HFP
`sink` (`bluealsa-cli open <sink>`), gated on PTT via `setWebRtcTxPttActive`.
8 kHz mono S16LE. **Confidence:** Medium.

---

## Synchronous vs async / shared-state summary

| Path | Sync/async | Mutates shared state | Can block/queue |
|---|---|---|---|
| `connect`/`disconnect` | async, awaited | yes (`state`, ports, timers) | shells out (spawnSync) — blocks event loop briefly |
| keepalive poll | async timer | yes (`signal`, counters) | shares serial queue |
| async push drain | async, event-driven | yes (`signal`) | suppressed during `pendingQuery` |
| PTT / side / key | async, queued | yes (`pttActive`, side) | serial queue |
| Nuxt audio/recordings | async | local file/process state only | child processes |

**Notable blocking risk:** `startBluealsaHfp` / `openRfcomm` / `disconnect` use
`spawnSync` (rfcomm, pkill, bluetoothctl, systemctl). These block the single
Node event loop for the duration of each subprocess — fine at connect time, but
`disconnect`'s `spawnSync('sudo rfcomm release')` also runs on the request path.
