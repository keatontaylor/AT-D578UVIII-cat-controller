# Startup — see the docs/

This file used to describe one specific Raspberry Pi deployment (systemd + nginx).
That content has been generalized and moved:

- **Run it locally (development):** [../docs/RUNNING.md](../docs/RUNNING.md)
  → `npm install && npm run dev`, open `http://localhost:3030/`.
- **Configuration / env vars:** [../docs/CONFIGURATION.md](../docs/CONFIGURATION.md)
- **Dependencies (Node, BlueZ/BlueALSA/ffmpeg):** [../docs/DEPENDENCIES.md](../docs/DEPENDENCIES.md)
- **Production (systemd, nginx, Docker, pm2 — all optional):**
  [../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md), with templates in
  [../deploy/](../deploy/).

## Operational notes worth keeping

- The two processes: backend `anytone-server.mjs` (`:3010`) + the Nuxt UI
  (`:3030`). The UI proxies the browser's API/SSE calls to the backend
  (`ANYTONE_SERVER_URL`); only the UI port needs to be reachable by clients.
- The radio is **not** auto-connected at startup — click **Connect** in the UI
  (or `POST /connect`), which brings up BlueALSA HFP + the SPP link on demand.
- Health check:
  ```bash
  curl -s http://127.0.0.1:3010/raw/status | head -c 80                       # backend
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3030/             # UI
  ```
- Production runs the **built** output; after code changes run `npm run build`
  then restart your supervisor (or rerun `scripts/run-anytone.sh`).
