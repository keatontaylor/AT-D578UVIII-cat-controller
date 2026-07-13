# Deployment reference

`../install.sh` sets all of this up automatically; these are the pieces it installs,
kept here as reviewable examples for manual/custom deployments.

## Pieces

| File | Installs to | Purpose |
|---|---|---|
| `systemd/anytone-v2.service.example` | `~/.config/systemd/user/anytone-v2.service` | The app (user unit; enable linger so it starts at boot) |
| `systemd/turn.conf.example` | `~/.config/systemd/user/anytone-v2.service.d/turn.conf` (mode **600**) | Secrets drop-in (Cloudflare TURN credentials) |
| `systemd/bluealsa-anytone.service.example` | `/etc/systemd/system/bluealsa-anytone.service` | Isolated BlueALSA HFP instance (`org.bluealsa.anytone`) |
| `dbus-bluealsa-anytone.conf.example` | `/etc/dbus-1/system.d/bluealsa-anytone.conf` | Lets the `audio` group talk to that instance |
| `nginx/anytone.conf.example` | `/etc/nginx/sites-available/anytone` | HTTPS reverse proxy, subpath-native `/anytone-v2/` |

## Rules worth knowing

- **Secrets never go in the unit file or the repo** — only in the mode-600 drop-in.
- **The nginx proxy must NOT strip the subpath**: the app is subpath-native
  (`ANYTONE_BASE_PATH`), and four things must agree — the Vite base, the server
  `basePath`, the frontend `BASE_URL`, and the nginx `location`. Change one env var
  (`ANYTONE_BASE_PATH`) and rebuild rather than editing any of them individually.
- **HTTPS is required for the microphone** (browser secure-origin rule). Self-signed
  is fine on a LAN.
- One scoped sudoers line is the app's entire privilege surface:
  `user ALL=(root) NOPASSWD: /usr/bin/systemctl start bluealsa-anytone.service`
