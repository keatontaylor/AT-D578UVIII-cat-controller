#!/usr/bin/env bash
# Run the BUILT AnyTone D578 control stack as two long-running Node processes:
#   - anytone-server.mjs        : BT SPP control + HFP audio backend, HTTP on :3010
#   - .output/server/index.mjs  : built Nuxt UI, HTTP on :3030
#
# Portable, dependency-free launcher: it starts both processes and exits if
# either dies, so ANY supervisor (systemd, pm2, runit, a container entrypoint, or
# nothing) can restart it. OPTIONAL — for development use `npm run dev`. For
# production behind a reverse proxy, see docs/DEPLOYMENT.md. Build first:
# `npm run build`. Config is via env vars (.env.example / docs/CONFIGURATION.md);
# a repo-root `.env` is loaded automatically if present.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"          # app/
REPO="$(cd "$DIR/.." && pwd)"                      # repo root

# Run from app/ so the app's cwd-relative paths resolve correctly
# (the audio capture helper scripts/bluealsa-capture.mjs and the .data/recordings
# dir are resolved from process.cwd()). Must hold regardless of where this script
# is invoked from.
cd "$DIR"

# Load repo-root .env if present (gitignored; holds your local config).
if [ -f "$REPO/.env" ]; then set -a; . "$REPO/.env"; set +a; fi

# Backend control server (:3010). ANYTONE_SERVER_PORT takes precedence over PORT
# inside anytone-server.mjs, so it stays 3010 even though PORT below is 3030.
export ANYTONE_SERVER_PORT="${ANYTONE_SERVER_PORT:-3010}"
export ANYTONE_SERVER_HOST="${ANYTONE_SERVER_HOST:-127.0.0.1}"
# Streaming (COM CHECK END push) is OFF by default: polling 04 5a/5e drives the
# smeter and is TX-safe. Set to 1 only to re-run the streaming/wedge experiment.
export ANYTONE_STREAM_MODE="${ANYTONE_STREAM_MODE:-0}"
# Isolated BlueALSA instance suffix (org.bluealsa.<suffix>) — both the backend and
# the UI audio pipeline target it via `bluealsa-cli -B <suffix>`. Installed by
# scripts/setup.sh; coexists with any system BlueALSA. Set empty for the default bus.
export ANYTONE_BLUEALSA_DBUS="${ANYTONE_BLUEALSA_DBUS-anytone}"

# Nuxt UI (:3030). Nitro reads PORT/HOST. Bind to loopback by default; set
# HOST=0.0.0.0 (or front with a reverse proxy) to expose it on the LAN.
export PORT="${PORT:-3030}"
export HOST="${HOST:-127.0.0.1}"
export NITRO_PORT="$PORT"
export NITRO_HOST="$HOST"
export ANYTONE_SERVER_URL="${ANYTONE_SERVER_URL:-http://127.0.0.1:3010}"
# UI mount path. Default "/" (open http://<host>:3030/). To serve under a
# sub-path behind a reverse proxy, set NUXT_APP_BASE_URL=/your-path/ in .env.
export NUXT_APP_BASE_URL="${NUXT_APP_BASE_URL:-/}"
# TX audio tuning (see docs/CONFIGURATION.md): pin TX input rate to the opus
# negotiated rate, and scale browser mic gain down for the radio's mic input.
export CAT_AUDIO_TX_INPUT_SAMPLE_RATE="${CAT_AUDIO_TX_INPUT_SAMPLE_RATE:-16000}"
export CAT_AUDIO_TX_GAIN="${CAT_AUDIO_TX_GAIN:-0.3}"

if [ ! -f "$DIR/.output/server/index.mjs" ]; then
  echo "Built UI not found at .output/ — run 'npm run build' first." >&2
  exit 1
fi

node "$DIR/anytone-server.mjs" &
PID_BACKEND=$!
node "$DIR/.output/server/index.mjs" &
PID_UI=$!

SHUTDOWN() { kill "$PID_BACKEND" "$PID_UI" 2>/dev/null; exit; }
trap SHUTDOWN SIGTERM SIGINT

# Exit if either process dies, so the supervisor (if any) can restart the stack.
while kill -0 "$PID_BACKEND" 2>/dev/null && kill -0 "$PID_UI" 2>/dev/null; do sleep 1; done
wait
