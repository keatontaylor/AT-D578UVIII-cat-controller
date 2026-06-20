# deploy/ — optional production deployment examples

**You do not need anything in this folder to run the project.** For development,
use `npm run dev` from the repo root (see [../docs/RUNNING.md](../docs/RUNNING.md)).

For Debian/Raspberry Pi OS production installs, the top-level `install.sh` can
generate the systemd and nginx configuration automatically.

These are **generic templates** for custom production deployments. They
contain placeholders (`<YOUR_USER>`, `<ABSOLUTE_PATH_TO_REPO>`, `<YOUR_HOSTNAME>`,
cert paths) — substitute your own. They are examples of *one* way to deploy; you
can equally use Docker, pm2, Caddy, Traefik, Apache, or a bare `run-anytone.sh`.

| File | What |
|---|---|
| `systemd/anytone.service.example` | Run the stack under systemd (system or user service). |
| `nginx/anytone.conf.example` | Reverse proxy with TLS + unbuffered SSE/audio. |

General flow:

```bash
npm install            # repo root
npm run build          # build the UI into app/.output
# then either:
app/scripts/run-anytone.sh     # plain launcher (any supervisor)
# or install the systemd unit, and/or put nginx in front.
```

See [../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) for the full walkthrough.
