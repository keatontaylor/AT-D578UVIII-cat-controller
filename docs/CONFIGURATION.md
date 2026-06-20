# CONFIGURATION

The app is configured entirely through **environment variables** — there is no
bespoke config-file format (deliberately: it avoids adding a config-loader
dependency, and env vars compose cleanly with systemd, Docker, and `.env`).

- Copy [`.env.example`](../.env.example) → `.env` (gitignored) and edit.
- Or export the variables in your shell / systemd unit.
- Only **`ANYTONE_BT_ADDR`** effectively needs setting; everything else defaults.

Local config (`.env`, `*.local`, `config/local.*`, `local/`) is gitignored and
must never be committed. See [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md).

## Required

| Variable | Default | Notes |
|---|---|---|
| `ANYTONE_BT_ADDR` | `AA:BB:CC:DD:EE:FF` (placeholder) | Your radio's Bluetooth Classic MAC. The placeholder lets the server boot (so the UI loads) but **Connect fails until you set a real value** — the server logs a warning at startup. |

## Backend (`anytone-server.mjs`, port 3010)

| Variable | Default | Notes |
|---|---|---|
| `ANYTONE_SERVER_PORT` | `3010` | Backend HTTP port (takes precedence over `PORT`). |
| `ANYTONE_SERVER_HOST` | `127.0.0.1` | Bind address. Keep on loopback; front with a reverse proxy for remote access. |
| `ANYTONE_SPP_CHANNEL` | `2` | Radio SPP RFCOMM channel. |
| `ANYTONE_RFCOMM_ID` | `10` | `/dev/rfcommN` id used for the bind. |
| `ANYTONE_RFCOMM_PATH` | `/dev/rfcomm<ID>` | Override the device path directly. |
| `ANYTONE_RFCOMM_BAUD` | `115200` | Serial baud for the rfcomm device. |
| `ANYTONE_BLUEALSA_PCM` | derived from MAC | HFP source PCM path. |
| `ANYTONE_BLUEALSA_KEEPALIVE` | `30` | BlueALSA `--keep-alive`. |
| `ANYTONE_BLUEALSA_LOGLEVEL` | `warning` | Managed BlueALSA daemon log level. Keep at `warning` unless debugging; debug logs can add audio jitter. |
| `ANYTONE_BLUEALSA_CODEC` | `CVSD` | Managed BlueALSA HFP codec. `CVSD` keeps the app's Bluetooth PCM path at 8 kHz mono. |
| `ANYTONE_BLUEALSA_IO_RT_PRIORITY` | `20` | BlueALSA `--io-rt-priority` for SCO IO threads. Set `0` to disable. |
| `ANYTONE_BLUEALSA_STOP_WIREPLUMBER` | `1` | Stop wireplumber while BlueALSA owns HFP. |
| `ANYTONE_KEEPALIVE_INTERVAL_MS` | `250` | 61 keepalive/listen cadence. |
| `ANYTONE_PTT_MAX_MS` | `60000` | PTT watchdog auto-release ceiling. |
| `ANYTONE_CHANNELS_CSV` | `../channels.CSV` | Optional CPS CSV for channel power/bandwidth enrichment. App runs without it (logs a warning). Schema: [`examples/channels.example.csv`](../examples/channels.example.csv). |
| `ANYTONE_ASYNC_LOG_FILE` | `1` | Write unsolicited frames to an NDJSON log (RE aid). Set `0` to disable. |
| `ANYTONE_ASYNC_LOG_PATH` | `../captures/unsolicited.ndjson` | Gitignored by default. |
| `ANYTONE_ASYNC_LOG_LIMIT` | `300` | In-memory async-frame ring size. |

## UI (Nuxt server, port 3030)

| Variable | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `3030` / `127.0.0.1` | UI bind. |
| `ANYTONE_SERVER_URL` | `http://127.0.0.1:3010` | Where the UI proxies API calls (the backend). |

## Optional integrations (disabled unless set)

See [OPTIONAL_INTEGRATIONS.md](OPTIONAL_INTEGRATIONS.md).

| Variable | Default | Notes |
|---|---|---|
| `CAT_DATA_PATH` / `CAT_RECORDINGS_PATH` | `./.data` | Squelch-recording storage. |

## Validation behavior
- **Missing optional integration config** ⇒ that integration is silently disabled.
- **Missing `channels.CSV`** ⇒ warning + empty channel-enrichment table; app runs.
- **Placeholder/unset `ANYTONE_BT_ADDR`** ⇒ startup warning; Connect will error
  clearly when attempted.
- **Missing Bluetooth/serial tools at Connect time** ⇒ the connect attempt fails
  with the underlying error surfaced in the UI; the servers stay up.
