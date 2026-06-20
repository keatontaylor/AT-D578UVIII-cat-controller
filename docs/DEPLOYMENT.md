# DEPLOYMENT

Running the AnyTone controller in production. **All of this is optional** — for
development just use `npm run dev` ([RUNNING.md](RUNNING.md)). The repo does not
assume any single deployment model: nginx, Caddy, Traefik, Apache, Docker,
systemd, pm2, or a plain launcher all work.

The app is two Node processes:
- **backend** `anytone-server.mjs` — BT control + audio, HTTP on `:3010`.
- **UI** the built Nuxt server `.output/server/index.mjs`, HTTP on `:3030`.

The browser talks only to the UI; the UI proxies API/SSE to the backend
(`ANYTONE_SERVER_URL`). So you only need to expose the **UI** port publicly.

## 0. One-shot Debian/Raspberry Pi OS install

On an apt-based host, the top-level installer performs the production setup:

```bash
./install.sh
```

It installs OS packages, Node.js, npm dependencies, the isolated AnyTone
BlueALSA service, scoped sudoers, `anytone.service`, and an nginx reverse-proxy
site. Run it as a normal sudo-capable user, or as root with
`ANYTONE_RUN_USER=<user>`.

Use the manual sections below for development, non-systemd hosts, or custom
deployments.

## 1. Build

```bash
npm install      # repo root
npm run build    # → app/.output
```

## 2. Run the built app (pick one)

**Plain launcher** (portable, any supervisor or none):
```bash
app/scripts/run-anytone.sh
```
It loads a repo-root `.env` if present, starts both processes, and exits if either
dies. Build must exist first.

**npm:**
```bash
npm run start            # both
npm run start:backend    # just the backend
npm run start:frontend   # just the built UI (Nitro reads PORT/HOST)
```

**Process manager (example: pm2):**
```bash
pm2 start app/anytone-server.mjs --name anytone-backend
PORT=3030 pm2 start app/.output/server/index.mjs --name anytone-ui
```

## 3. Configuration

Set env vars (or a repo-root `.env`, which `run-anytone.sh` and the systemd
example load). See [CONFIGURATION.md](CONFIGURATION.md). For production you
typically set at least `ANYTONE_BT_ADDR`, and `HOST`/`PORT` if not default.

Bind the UI to loopback (`HOST=127.0.0.1`) and put a reverse proxy in front, or
bind `0.0.0.0` to expose it directly on the LAN.

## 4. Optional: systemd

A template unit is in [`../deploy/systemd/anytone.service.example`](../deploy/systemd/anytone.service.example)
(system or user service). It runs `run-anytone.sh`, restarts on failure, and
reads your `.env`. Replace the `<PLACEHOLDER>` values (user, absolute repo path).
The top-level `install.sh` can generate and enable the system service for you.

## 5. Optional: reverse proxy (nginx, etc.)

A template is in [`../deploy/nginx/anytone.conf.example`](../deploy/nginx/anytone.conf.example).
The only hard requirement: **do not buffer** the SSE endpoint (`/api/events`) or
the audio stream (`/api/audio/stream`) — otherwise live status/audio stall
(`proxy_buffering off`).
The top-level `install.sh` can generate and enable a root-path HTTP nginx site
for a trusted LAN deployment.

- Serving at the **root** (`/`) works out of the box (default `NUXT_APP_BASE_URL=/`).
- Serving under a **sub-path** (e.g. `https://host/anytone/`): set
  `NUXT_APP_BASE_URL=/anytone/` in `.env` so the app's asset/API URLs match, then
  proxy that prefix.

Caddy/Traefik/Apache equivalents just need the same: proxy to `:3030` and disable
buffering on the SSE/audio paths.

## 6. Optional: Docker

No image is shipped, but the model is standard: a Node 20 base, `npm install &&
npm run build`, then `CMD` the `run-anytone.sh` launcher (or run the two
processes). Mount `/dev` and grant Bluetooth access for radio control.

## Security before exposing publicly
The UI can key a licensed transmitter and the backend has `/raw/*` frame
endpoints. Put authentication in front of it (reverse-proxy basic-auth / mTLS).
See [SECURITY_REVIEW.md](SECURITY_REVIEW.md).
