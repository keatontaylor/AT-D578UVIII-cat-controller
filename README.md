# AnyTone AT-D578UV Bluetooth Controller

Web-based remote controller for an **AnyTone AT-D578UV** mobile radio over
**Bluetooth Classic** (SPP control + HFP audio), running on a Raspberry Pi / Linux
host. Shows live state (frequency, zone/channel, S-meter, squelch), controls PTT
and active side (A/B), streams two-way audio over WebRTC, and records
squelch-opened RX audio.

## One-line install (Raspberry Pi / Debian)

For a full production setup on a Linux host — system deps, Node 20, build,
Bluetooth audio, and a boot-time systemd service — run the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/sourceunknown/anytone/main/install.sh | bash
```

It is idempotent (safe to re-run) and also works from inside an existing clone
(`./install.sh`). It installs `bluez`, `bluez-alsa-utils`, `ffmpeg` and build
tools, ensures Node ≥ 20 via NodeSource, runs `npm install && npm run build`,
seeds `.env` from the example, configures the isolated BlueALSA HFP instance, and
enables an `anytone` systemd service. Afterward, edit `.env` (set
`ANYTONE_BT_ADDR`) and `sudo systemctl restart anytone`. See
[docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) for the manual route.

## Quick start (development)

Prerequisite: **Node.js ≥ 20**. (Connecting to a radio additionally needs a Linux
host with BlueZ + BlueALSA + `ffmpeg` — see [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)
— but the UI runs without any of that.)

From the **repo root**:

```bash
npm install      # installs the app (delegates to app/)
npm run dev      # backend (:3010) + UI (:3030) together
```

Open **http://localhost:3030/**. The servers start without a radio (the UI shows
disconnected) — that's expected. To connect real hardware, set your radio's MAC:
`cp .env.example .env` and edit `ANYTONE_BT_ADDR`.

Common commands (all from the repo root):

| Command | Does |
|---|---|
| `npm run dev` | backend + UI dev (hot-reload UI), open `http://localhost:3030/` |
| `npm run dev:backend` / `npm run dev:frontend` | run one side only |
| `npm run build` then `npm run start` | production build, then run the built app |
| `npm run typecheck` | `vue-tsc` over the project |

More detail: [docs/RUNNING.md](docs/RUNNING.md). Configuration (ports, hosts, base
URL, radio MAC) is all via env vars — [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
and [`.env.example`](.env.example). Nothing personal is required; the app does
**not** need any CSV file to run.

**Deployment is optional and not required to run locally.** systemd, nginx,
Docker, pm2, etc. are all supported but none are assumed — see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and the templates in [`deploy/`](deploy/).

### Privacy / publishing
Local & personal data (your `.env`, codeplug `*.CSV`, protocol `captures/`, audio
recordings) is gitignored and must never be committed. See
[docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md).

## Layout

| Path | What |
|---|---|
| `app/` | **Production** Nuxt UI + Node backend (`anytone-server.mjs`). |
| `examples/` | Generic example config / channel CSV (safe to read). |
| `docs/` | Architecture, data flow, configuration, audits, protocol. |
| `captures/` *(gitignored)* | Runtime protocol captures / async-frame log. Personal; never committed. |
| `channels.CSV`, `zones.CSV` *(gitignored)* | Your CPS codeplug export (optional runtime input). |

## Documentation

- [docs/RUNNING.md](docs/RUNNING.md) — run it locally (dev).
- [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) — Node / BlueZ / BlueALSA / ffmpeg.
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — all environment variables.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — optional systemd / nginx / Docker.
- [docs/OPTIONAL_INTEGRATIONS.md](docs/OPTIONAL_INTEGRATIONS.md) — squelch recording (opt-in).
- [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) — run locally; what stays local.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components & layers.
- [docs/DATA_FLOW.md](docs/DATA_FLOW.md) — request/response tracing.
- [docs/REPO_MAP.md](docs/REPO_MAP.md) — file inventory.
- [docs/ANYTONE_578_NOTES.md](docs/ANYTONE_578_NOTES.md) — implemented vs TODO.
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — the protocol bible.
- [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md)

## Status (2026-06-14)

**Working:** connect, live reads, S-meter/squelch, PTT, side select, frequency &
VFO-mode writes, zone/channel select & stepping over BT, WebRTC audio, squelch
recording.
**Not implemented (return HTTP 501, marked `TODO_ANYTONE`):** the inherited
`preset-execute` / `memory-write` / `pseudo-scan` features (need an unfound
memory-channel write opcode). See
[docs/ANYTONE_578_NOTES.md](docs/ANYTONE_578_NOTES.md).

## Requirements & security

Node 20+ for the app; radio control additionally needs Linux with BlueZ
(`rfcomm`, `bluetoothctl`), **BlueALSA** (`bluealsa`, `bluealsa-cli`), and
`ffmpeg` ([docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)). The backend shells out to
some of these via passwordless `sudo -n` at Connect time. The UI can key a
licensed transmitter — put authentication in front of it before any remote/public
exposure. See [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md).
