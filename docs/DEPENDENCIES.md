# DEPENDENCIES

What you need installed, and how to get it.

## Core app (UI + backend) — Node only

- **Node.js ≥ 20** + npm. (Electron 41 in the toolchain also expects Node 20+.)
- Everything else is fetched by npm:

  ```bash
  npm install        # from the repo root — installs app/ deps
  ```

  Key packages (declared in `app/package.json`, no global installs
  needed): `nuxt`, `serialport`, `@roamhq/wrtc` (WebRTC audio),
  `ffmpeg-static`, `dbus-next`, `concurrently` (dev),
  `vue-tsc`/`typescript` (typecheck).

The UI builds and runs on any OS. **Connecting to a radio is Linux-only** because
it uses BlueZ + BlueALSA (below).

## One-shot Debian/Raspberry Pi OS install

For a fresh apt-based host, prefer the repo installer. It installs system
packages, Node.js, npm dependencies, the isolated BlueALSA service, sudoers,
the AnyTone systemd unit, and nginx:

```bash
./install.sh
```

Run as a normal sudo-capable user, or as root with `ANYTONE_RUN_USER=<user>`.

## Radio control (runtime, Linux) — system packages

These are needed only to actually talk to the radio; not to build/run the UI.
They are **not** installable via npm/pip — use your distro package manager.

| Tool | Package (Debian/Raspberry Pi OS) | Used for |
|---|---|---|
| BlueZ (`rfcomm`, `bluetoothctl`) | `bluez` | SPP control link |
| BlueALSA (`bluealsa`, `bluealsa-cli`) | `bluez-alsa-utils` (or build from `arkq/bluez-alsa`) | HFP audio link |
| `ffmpeg` | `ffmpeg` | RX/TX audio + recordings |
| ALSA tools/headers | `alsa-utils`, `libasound2-dev` | Audio diagnostics + native module builds |
| nginx | `nginx` | Optional LAN-facing reverse proxy installed by `install.sh` |
| build toolchain | `build-essential`, `python3`, `pkg-config` | Native npm modules |

```bash
sudo apt install bluez bluez-alsa-utils ffmpeg alsa-utils libasound2-dev nginx build-essential python3 pkg-config
```

The backend shells out to some of these via passwordless `sudo -n` at *Connect*
time (`rfcomm`, `bluealsa`, `pkill`). Scope a sudoers entry for them — see
[SECURITY_REVIEW.md](SECURITY_REVIEW.md). No sudo is needed just to start the
servers or load the UI.

## Troubleshooting
- **`npm install` slow/odd on a Pi:** native modules (`serialport`, `@roamhq/wrtc`)
  compile; ensure `build-essential` + `python3` are present.
- **No audio / HFP PCM never appears:** confirm `bluealsa` is installed and the
  radio is paired (`bluetoothctl`); see `app/STARTUP.md`.
- **UI loads but Connect fails:** set `ANYTONE_BT_ADDR` to your radio's MAC
  (see [CONFIGURATION.md](CONFIGURATION.md)); the default is a placeholder.
