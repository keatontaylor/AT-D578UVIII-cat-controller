# AnyTone AT-D578UVIII Bluetooth Controller

Full remote control for the AnyTone AT-D578UV III mobile radio over its built-in
Bluetooth — the same link its BT-01 remote head uses, reverse-engineered from wire
captures and BT-01 firmware analysis. Runs great on a Raspberry Pi sitting next to
the radio; operate from any browser on the LAN (or beyond, behind a reverse proxy).

## What it does

- **Live dual-VFO dashboard** — both sides (A/B): frequency, channel/zone, S-meters,
  squelch state, TX truth indicators; click-to-edit frequency, channel/zone stepping,
  a zone+channel picker, VFO/memory switching.
- **Voice** — listen to the radio's RX audio in the browser (WebRTC: Opus or native-8k
  PCMU), hold-to-talk PTT with mic capture, lock-screen media display on mobile.
  Optional Cloudflare TURN for hostile NATs (credentials via env, never in the repo).
- **DMR** — live call decode (talkgroup, caller ID with RadioID lookup, slot/CC),
  digital-monitor control, manual dial (call any TG / private ID without a codeplug slot).
- **Channel + radio settings** — per-channel settings (power, tones, bandwidth, color
  code, time slot, …) and the radio's global settings menu, editable live with
  ack-confirmed writes and a CTCSS/DCS tone picker.
- **Native scan** — start/stop the radio's own scanner, scan-list selection, lock/pause
  follow, honest "position unknown" display while it hops.
- **Squelch + TX recordings** — every squelch opening and every transmission recorded
  to disk, browsable on a per-channel timeline with continuous playback and download.
- **Packet TNC (optional)** — a direwolf soundcard modem bridged to the radio's audio
  and PTT: KISS (TCP :8001) + AGWPE (:8000) on the LAN, Bonjour-advertised for iOS
  packet apps (RadioMail etc). Best-effort over the Bluetooth voice path.
- **PTT safety chain** — radio-ACK-confirmed keying, bounded retries, automatic
  failsafe release, Bluetooth-teardown last resort, and a deadman that releases PTT
  if the browser vanishes mid-transmission.

## Quick start (Raspberry Pi OS / Debian)

One-shot from a fresh machine:

```sh
curl -fsSL https://raw.githubusercontent.com/keatontaylor/AT-D578UVIII-cat-controller/main/install.sh | sh
```

or from a clone:

```sh
git clone https://github.com/keatontaylor/AT-D578UVIII-cat-controller.git ~/anytone
cd ~/anytone && ./install.sh
```

The installer is idempotent and POSIX-clean (runs under any `/bin/sh` — dash, bash).
It installs system packages (BlueZ, BlueALSA, Node.js), builds the UI, sets up the
isolated BlueALSA HFP instance + D-Bus policy + one scoped sudoers rule, installs the
app as a **user** systemd service (`anytone-v2`), and (optionally) an nginx HTTPS
reverse proxy. The header comments in `install.sh` document every `ANYTONE_NO_*`
opt-out and env override.

Then open `https://<pi>/anytone-v2/`, put the radio in pairing mode
(Menu → Bluetooth → Pairing), scan, pair, connect.

> **HTTPS matters:** browsers only allow microphone capture (PTT voice) on secure
> origins. The installer's self-signed cert works; a real cert works better.

> **Tip — Sub Channel:** the radio sends a single mono audio stream with no side
> label, so the app *infers* which side you're hearing. Recordings, RX indicators, and
> the media-player display are most reliable with the radio's **Sub Channel off**
> (single receiver). On connect the app offers a one-click switch; dual-watch still
> works, just best-effort on side attribution.

## Manual run (development)

```sh
npm install
npm test            # 470+ tests, no radio required (sim rig + captured-wire replays)
npm run build       # Vite SPA → dist/
node --import tsx src/main.ts   # Fastify + /ws on :8080, SPA at /anytone-v2/
```

## Configuration (environment)

Everything is optional; defaults suit a Pi with one radio.

| Variable | Default | Purpose |
|---|---|---|
| `ANYTONE_API_PORT` / `ANYTONE_API_HOST` | `8080` / `0.0.0.0` | HTTP/WS bind |
| `ANYTONE_BASE_PATH` | `/anytone-v2` | Subpath the SPA + API mount at |
| `ANYTONE_BLUEALSA_DBUS` | `anytone` | Isolated BlueALSA D-Bus suffix |
| `ANYTONE_RADIOID_CSV` | `<repo>/data/radioid_user.csv` | RadioID.net user DB for DMR caller ID |
| `ANYTONE_RECORDER_AUTOSTART` | on | Squelch/TX recorders arm on connect (`0` opts out) |
| `ANYTONE_AUDIO_TX_GAIN` | `0.6` | Mic → radio gain |
| `ANYTONE_CF_TURN_KEY_ID` / `ANYTONE_CF_TURN_API_TOKEN` | unset | Mint Cloudflare TURN credentials for WebRTC relay — put these in a mode-600 systemd drop-in, **never** in the repo |
| `ANYTONE_ICE_SERVERS` | unset | Static ICE server JSON (alternative to Cloudflare TURN) |
| `ANYTONE_RTC_FORCE_RELAY` | unset | `1` forces WebRTC through TURN |
| `ANYTONE_PACKET_*` | see `src/main.ts` | Packet TNC: callsign, ports, TXDELAY/TXTAIL… |
| `ANYTONE_WIRE_LOG` | on | NDJSON wire capture per connect (diagnostics, downloadable from the link-stats dialog); `0` disables, a path targets a custom directory (default `<repo>/captures`) |

## Architecture

One Node process (TypeScript via tsx): Bluetooth SPP transport → framing + codec
(corpus-derived frame tables) → stop-and-wait ARQ link with retransmit-safety classes
→ pure domain reducer + shared view model → single WebSocket (JSON-RPC 2.0 commands,
RFC 7396 state patches) → Vue 3 SPA. Audio rides BlueZ/BlueALSA HFP (CVSD) into WebRTC.

The docs are the spec the code was built against:

| Doc | What it covers |
|---|---|
| [REQUIREMENTS.md](REQUIREMENTS.md) | Numbered functional + non-functional requirements; scope and non-goals |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Single-process layered design, the one state object, module boundaries |
| [LINK_PROTOCOL.md](LINK_PROTOCOL.md) | **Normative** radio link contract — framing, transactions, ACK classes, ARQ |
| [UI_PROTOCOL.md](UI_PROTOCOL.md) | The WebSocket command bus, command lifecycle, desired/reported state, PTT lifecycle |
| [CONNECTION_AND_COMPONENTS.md](CONNECTION_AND_COMPONENTS.md) | Connection establishment sequence + external-component inventory |
| [COMMAND_REFERENCE.md](COMMAND_REFERENCE.md) | Frame format + opcode/register catalogue |
| [TESTING.md](TESTING.md) | Capture-replay / golden-master strategy, the sim rig, invariant fuzzing |
| [docs/PROTOCOL.md](docs/PROTOCOL.md), [docs/BT01_HEAD_BUS_PROTOCOL.md](docs/BT01_HEAD_BUS_PROTOCOL.md) | The reverse-engineered radio protocol |

### Evidence grading (used throughout the docs)

Every behavioral claim carries a grade — **CONFIRMED / OBSERVED / DOCUMENTED /
INFERRED / HYPOTHESIS / OPEN** — and the cardinal rule is: never launder a
HYPOTHESIS into a fact to make the contract look tidy. A clean-but-wrong spec is
worse than an honest messy one.

## Security notes

- The app has **no authentication** — put it behind your reverse proxy's auth if it
  is reachable beyond a trusted LAN (`rtc.config` mints TURN credentials for anyone
  who can reach `/ws`).
- Secrets (the TURN API token) belong in a systemd drop-in
  (`~/.config/systemd/user/anytone-v2.service.d/turn.conf`, mode 600); see
  `deploy/README.md`. The repo `.gitignore` refuses `.env` files as a backstop.
- Wire captures and codeplug exports contain personal data (callsign, contacts,
  channel names) and are git-ignored; `captures/wire.ndjson` is the one reviewed,
  frozen test fixture.

## Heritage / disclaimer

Built by reverse-engineering the AnyTone BT-01 remote-head protocol from live wire
captures and firmware analysis. Not affiliated with AnyTone. It keys a real
transmitter — know your license conditions, and use at your own risk.
