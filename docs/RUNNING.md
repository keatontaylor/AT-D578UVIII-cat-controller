# RUNNING

How to run the AnyTone controller locally from a fresh clone. No systemd, no
nginx, no sudo required just to start the app and see the UI.

## Prerequisites
- **Node.js ≥ 20** (and npm).
- To actually *connect to a radio* you also need a Linux host with BlueZ +
  BlueALSA + `ffmpeg` and a paired AnyTone radio — see
  [DEPENDENCIES.md](DEPENDENCIES.md). The UI itself runs without any of that.

## Quick start (development)

From the **repo root**:

```bash
npm install      # installs the app (delegates to app/)
npm run dev      # starts backend (:3010) + UI (:3030) together
```

Open **http://localhost:3030/** (or `http://<your-LAN-IP>:3030/` — the dev server
binds `0.0.0.0`). The UI loads and shows a disconnected radio; that is expected
without hardware.

`npm run dev` runs both processes with [`concurrently`], colour-labelled
`backend` / `ui`, and Ctrl-C stops both.

## Run just one side

```bash
npm run dev:backend     # only the control backend  (:3010)
npm run dev:frontend    # only the Nuxt UI          (:3030)
```

Restarting one side is just stopping that command and rerunning it — they are
independent processes. The UI hot-reloads on file changes (Nuxt dev). The backend
does not auto-reload; restart `dev:backend` after editing `anytone-server.mjs`.

## Ports & config

Defaults: UI `3030`, backend `3010`, both configurable by environment variable.
Copy `.env.example` → `.env` (repo root, gitignored) to set them and other
options:

```bash
cp .env.example .env
# e.g. PORT=8080, ANYTONE_SERVER_PORT=9000, ANYTONE_BT_ADDR=<your radio MAC>
```

Full list: [CONFIGURATION.md](CONFIGURATION.md). Notable ones:
- `PORT` / `HOST` — UI bind (default 3030 / dev binds 0.0.0.0).
- `ANYTONE_SERVER_PORT` / `ANYTONE_SERVER_HOST` — backend bind (3010 / 127.0.0.1).
- `ANYTONE_SERVER_URL` — where the UI proxies API calls (default `http://127.0.0.1:3010`).
- `NUXT_APP_BASE_URL` — UI mount path (default `/`; set e.g. `/anytone/` only if
  serving under a sub-path behind a proxy).
- `ANYTONE_BT_ADDR` — your radio's Bluetooth MAC (required to connect).

> The browser only ever talks to the Nuxt server (same origin), which proxies to
> the backend — so there is **no CORS setup** to worry about in development.

## Production build (local preview)

```bash
npm run build      # builds the UI into app/.output
npm run start      # runs the built UI + backend together
```

`npm run start:backend` / `npm run start:frontend` run them separately. For
deploying behind a supervisor or reverse proxy, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Type checking

```bash
npm run typecheck   # vue-tsc over the project
```

There is no unit-test or lint suite yet.

[`concurrently`]: https://www.npmjs.com/package/concurrently
