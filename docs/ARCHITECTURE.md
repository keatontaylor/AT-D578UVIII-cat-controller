# ARCHITECTURE

How the AnyTone AT-D578UV controller is put together. Pairs with
[DATA_FLOW.md](DATA_FLOW.md) (request/response tracing) and
[REPO_MAP.md](REPO_MAP.md) (file inventory).

## Component diagram

```
┌──────────────────────────────────────────────────────────────────┐
│ Browser  (Vue 3 SPA, single file pages/index.vue)                  │
│  - polls/streams /anytone/api/* ; renders radio state               │
│  - WebRTC audio peer (RX from radio, TX mic to radio)               │
└───────────────┬───────────────────────────────┬──────────────────┘
       HTTP/SSE │ (/anytone/api/*)        WebRTC │ (audio)
┌───────────────▼───────────────────────────────▼──────────────────┐
│ Nuxt server  :3030   (app/server)                      │
│  api/*.ts  ── thin proxies → backend  $fetch(serialServerUrl)      │
│  utils/*.ts ── LOCAL features (no radio control):                  │
│     audio.ts / rx-audio-capture.ts  ── ffmpeg + BlueALSA capture    │
│     webrtc-audio.ts                 ── @roamhq/wrtc peer, RX mix    │
│     recordings.ts                   ── squelch-triggered MP3s       │
│     rx-squelch.ts / scan-groups.ts  ── squelch logic, scan presets  │
└───────────────┬──────────────────────────────────────────────────┘
        HTTP/SSE │ (serialServerUrl, default http://127.0.0.1:3010)
┌───────────────▼──────────────────────────────────────────────────┐
│ Backend  :3010   anytone-server.mjs                               │
│  AnyToneBackend (EventEmitter, single global instance)            │
│   ├ transport: sudo rfcomm → /dev/rfcomm10 → SerialPort (115200)   │
│   ├ audio link: bluealsa (hfp-hf) + bluetoothctl (spawnSync)       │
│   ├ command queue: this.busy promise chain (serializes all I/O)    │
│   ├ protocol: decodePayload / applyDecoded / splitFrames           │
│   ├ shim: anytoneToState()  → UI-facing JSON state              │
│   └ http: handleRequest (no framework, raw node:http)             │
└───────────────┬──────────────────────────────────────────────────┘
   RFCOMM (SPP ch2) + HFP (ch1)  over Bluetooth Classic
┌───────────────▼──────────────────────────────────────────────────┐
│ AnyTone AT-D578UV   MAC AA:BB:CC:DD:EE:FF                          │
└──────────────────────────────────────────────────────────────────┘
```

## Layers

### 1. Transport (backend)
Bluetooth Classic only. Two independent links to the radio:

- **SPP / RFCOMM** for control. Brought up by shelling out to `sudo rfcomm
  connect /dev/rfcomm10 <MAC> 2`, then opened with `serialport` at 115200 8N1.
  All control frames flow here.
- **HFP** for audio, provided by **BlueALSA** (`bluealsa -p hfp-hf`). The radio
  only answers SPP reads *while an HFP SLC is established*, so HFP is a hard
  prerequisite for control, not just audio (see PROTOCOL.md "Transport").

Both are managed with `spawn`/`spawnSync` on system tools (`rfcomm`,
`bluealsa`, `bluealsa-cli`, `bluetoothctl`, `systemctl`, `pkill`), several via
passwordless `sudo -n`. "Persistent-BT mode": HFP/BlueALSA is left up across
SPP stop/start; only `POST /bt/teardown` fully drops Bluetooth.

### 2. Protocol (backend)
Frame-oriented binary protocol over SPP. Helpers in `anytone-server.mjs`:

- `splitFrames(buffer)` — segment the rx byte stream into frames.
- `decodePayload(payload)` — classify (`firmware`/`settings`/`zone`/`channel`/
  `clock`/`rx-status`/`signal`/…) and extract fields; `checksumOk` = trailing
  byte equals sum of the rest & 0xFF.
- `applyDecoded(state, decoded, ts)` — fold a decoded frame into backend state,
  field-by-field and defensively (e.g. squelch nulled if byte out of 0–5 range).
- Read commands are 6 bytes `04 <code> 07 00 00 00`; write commands are a small
  proven family (`08` side-select, `2f` set-freq, `57` VFO mode). Full opcode
  map lives in [./PROTOCOL.md](./PROTOCOL.md).

### 3. State (backend)
A single mutable object (`emptyState()`), held on the `AnyToneBackend`
singleton. Mutated by `applyDecoded`, `patch()`, and the PTT/side paths. Two
projections:

- `getState()` → deep clone of raw state (for `/raw/status`, RE tools).
- `getState()` → `anytoneToState(state)` → the UI-facing state object the
  browser consumes.

State changes emit `stateChange` (EventEmitter) → SSE subscribers.

### 4. HTTP / SSE (backend)
No framework — a single `handleRequest(req,res)` switch over `url.pathname`.
SSE (`/events`, `/anytone/events`) pushes `getState()` on every `stateChange`
plus a 15 s comment keepalive.

### 5. Nuxt proxy + local features (UI server)
`server/api/*.ts` are mostly one-line `$fetch` proxies to the backend so remote
browsers never touch :3010 directly. A second, independent feature set lives
entirely in the Nuxt server and does **not** touch the radio control link:
audio capture/stream (ffmpeg + BlueALSA), WebRTC audio, squelch-triggered
recordings, scan groups, presets.

### 6. UI (browser)
`pages/index.vue` — a single ~10.3k-line Vue component rendering the full radio
control panel (VFO cards, S-meters, memory list, pseudo-scan, recordings
timeline, WebRTC player). SSR is disabled (`ssr: false`);
it is a pure SPA served under `/anytone/`.

## Concurrency model

- **One serial command queue.** `enqueue(fn)` chains onto `this.busy`, so every
  read/write/PTT runs strictly in sequence — no two frames overlap on the wire.
- **`pendingQuery` flag.** While a deliberate query is in flight, the `data`
  handler stops auto-draining so the query owns the rx buffer; otherwise
  `drainAsyncFrames()` consumes unsolicited pushes.
- **Timers.** `keepaliveTimer` (re-armed each tick) polls 5a/5e + 61 to drive
  the live S-meter/squelch; `pttWatchdog` force-releases a stuck PTT.
- **Async pushes.** The radio emits unsolicited `5a`/`5b`/`5e` frames between
  polls; these are logged to a ring + NDJSON and applied to live state.

See [DATA_FLOW.md](DATA_FLOW.md) for the per-flow sync/async and race notes.

The canonical stack is **`app` + `anytone-server.mjs`**; the published tree
contains no other backend or UI.
