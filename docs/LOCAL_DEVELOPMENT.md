# LOCAL_DEVELOPMENT

How to run and develop the AnyTone 578 controller locally, and what stays on your
machine (never committed).

## What is safe to commit vs what stays local

**Committed (public-safe):** production source (`app/`), docs, `examples/`,
`.env.example`, `cat-presets.json`.

**Local only (gitignored — never commit):**

| Path | What |
|---|---|
| `.env`, `*.local`, `config/local.*`, `local/` | Your config & secrets |
| `*.CSV` / `*.csv` (except `examples/*.example.csv`) | Personal codeplug exports |
| `captures/`, `*.ndjson` | Protocol captures / async-frame logs (personal: callsign, GPS, contacts) |
| `**/.data/`, recordings | Runtime audio clips & state |
| `node_modules/`, `.nuxt/`, `.output/`, `__pycache__/` | Dependencies & build output |
| `tools/`, `experiments/` | Local-only reverse-engineering/prototype workspaces |

If you ever need to share a capture for debugging, scrub callsign / GPS / contact
/ channel-name fields first.

## First-time setup (fresh clone)

```bash
cd app
npm install
cp ../.env.example ../.env      # then edit: set ANYTONE_BT_ADDR to your radio
```

Optional: drop your CPS channel export at the repo root as `channels.CSV` (or
point `ANYTONE_CHANNELS_CSV` at it) for power/bandwidth enrichment. The app runs
fine without it — see [`examples/channels.example.csv`](../examples/channels.example.csv)
for the schema.

## Run (development)

```bash
cd app
# backend (radio control) + UI, two terminals or via the helper script:
node anytone-server.mjs            # :3010
npm run dev                        # :3030  → http://localhost:3030/anytone/
# or both, supervised:
./scripts/run-anytone.sh
```

Without a paired radio you can still start both servers; the UI loads and shows
disconnected state. `Connect` requires a real `ANYTONE_BT_ADDR` and a Linux host
with BlueZ + BlueALSA (see [CONFIGURATION.md](CONFIGURATION.md) and
[../app/STARTUP.md](../app/STARTUP.md)).

## Deployment

`app/STARTUP.md` documents one production setup (systemd user service
+ nginx + TLS). Hostnames/paths there are examples — substitute your own.
