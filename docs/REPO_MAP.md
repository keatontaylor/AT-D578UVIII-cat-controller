# REPO_MAP

Inventory of the AnyTone AT-D578UV control repository. See
[ARCHITECTURE.md](ARCHITECTURE.md) for component detail.

## Top-level layout

```
anytone/
├── app/            # ★ PRODUCTION stack (Nuxt UI + Node backend)
│   ├── anytone-server.mjs     # ★ backend: BT control, REST/SSE on :3010
│   ├── pages/index.vue        # ★ entire front end (~10.3k lines, monolith)
│   ├── app.vue
│   ├── nuxt.config.ts         # baseURL /anytone/, serialServerUrl :3010
│   ├── components/*.vue        # SMeter, LevelBar, StatusBadge, ...
│   ├── server/api/**           # Nuxt proxy + local feature endpoints
│   ├── server/utils/*.ts       # audio, webrtc, recordings, squelch, scan-groups
│   ├── utils/webrtc-sdp.ts
│   ├── scripts/                # run-anytone.sh, bluealsa-capture.mjs, setup.sh
│   ├── cat-presets.json        # preset command macros
│   ├── public/media/radio.svg
│   ├── STARTUP.md              # how the production service runs
│   └── .data/recordings/       # RUNTIME audio (~897 MB, gitignored)
│
├── channels.CSV / zones.CSV   # personal codeplug export (gitignored)
├── docs/PROTOCOL.md           # ★★ exhaustive AnyTone BT protocol RE notes (sanitized)
├── captures/                  # runtime protocol captures / async log (GITIGNORED, personal)
└── docs/                       # public documentation
```

★ = production-critical · ★★ = highest-value reference

## Runtime entry points

| Entry point | Command | Port | Notes |
|---|---|---|---|
| Backend (Node) | `node anytone-server.mjs` (npm `serial`) | 3010 | The radio controller. Production. |
| UI (built) | `node .output/server/index.mjs` | 3030 | Nuxt SSR, baseURL `/anytone/`. |
| UI (dev) | `nuxt dev` (npm `dev`) | 3030 | |
| Both, supervised | `scripts/run-anytone.sh` | 3010+3030 | Used by systemd user service. |

Public access (production): `https://radio.example.com/anytone/` via nginx →
:3030 (UI) → proxy → :3010 (backend). See `app/STARTUP.md`.

## Backend HTTP surface — `anytone-server.mjs` (:3010)

| Method/Path | Purpose |
|---|---|
| `GET /status`, `GET /anytone/status` | application state snapshot |
| `GET /raw/status` | raw decoded backend state |
| `GET /raw/async`, `POST /raw/async/clear` | unsolicited-frame ring buffer |
| `GET /events`, `GET /anytone/events` | SSE state stream |
| `GET /anytone/ports` | paired-radio + wired port descriptors |
| `POST /connect`, `/anytone/connect` | bring up HFP + SPP |
| `POST /disconnect`, `/anytone/disconnect` | drop SPP (keep HFP) |
| `POST /bt/teardown` | full Bluetooth teardown |
| `POST /raw/query`, `/raw/send` | raw frame TX/RX diagnostics |
| `POST /raw/ptttest`, `/raw/keytest` | one-shot PTT/key experiments |
| `POST /anytone/command` | high-level commands: `TX1/TX0`, `FT0/FT1` (side), `ZONE_*`/`ZONE:n`, `UP/DN`/`CH:`/`ZC:` (channel+zone), `KEY_*` |

## Nuxt API endpoints — `app/server/api` (:3030, behind `/anytone/api`)

| Endpoint | Backend / source | Status |
|---|---|---|
| `command.post` | → `/anytone/command` | OK |
| `connect.post` / `disconnect.post` | → `/anytone/connect` / `/anytone/disconnect` | OK |
| `events.get` | → `/anytone/events` (streamed) | OK |
| `ports.get` | → `/anytone/ports` | OK |
| `status.get` | → `/anytone/status` (fallback object on error) | OK, fallback is thin |
| `preset-execute.post` | (none) | **501 stub** — no preset→BT-write mapping yet |
| `memory-write.post` | (none) | **501 stub** — no memory-channel write opcode yet |
| `pseudo-scan.post` | (none) | **501 stub** — needs a BT channel-step opcode |
| `presets.get` | reads `cat-presets.json` | OK (local) |
| `scan-groups.*` | `server/utils/scan-groups.ts` (`.data/`) | OK (local) |
| `recordings/*` | `server/utils/recordings.ts` (`.data/recordings/`) | OK (local) |
| `audio/*`, `audio/webrtc/*` | `server/utils/{audio,webrtc-audio,rx-*}.ts` | OK (local, ffmpeg/BlueALSA) |

## Generated / runtime artifacts (excluded from git)

`**/node_modules`, `**/.nuxt`, `**/.output`, `**/.data` (incl. `recordings/`),
`__pycache__/`, `*.CSV` (personal codeplug), `tools/`, and `experiments/`.
See root `.gitignore`.

## Deferred stubs and compatibility seams

- **State projection:** the `/anytone/*` endpoint namespace + `anytoneToState()`
  shim (anytone-server.mjs) produces a broad UI-facing object. Some fields are
  hardcoded `null` because the AnyTone lacks an equivalent feature or no read
  opcode is known yet.
- **Dead proxies:** `preset-execute`, `memory-write`, `pseudo-scan` (above).
