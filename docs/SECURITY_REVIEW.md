# SECURITY_REVIEW

Security review from the Phase 3 audit. **No code changed in this pass** — all
items "Fixed: No". This is a hobbyist radio controller on a private LAN/Pi behind
nginx+TLS, so the threat model is: (a) other devices on the LAN, (b) a remote
browser reaching the public `/anytone/` URL, (c) accidental data exposure in git.

Severity: critical / high / medium / low.

---

## S1 — Passwordless `sudo -n` for Bluetooth/serial system tools
- **Where:** `mjs` `connect`/`disconnect`/`openRfcomm`/`stopBluealsaHfp`:
  `sudo -n rfcomm`, `sudo -n bluealsa`, `sudo -n pkill -x bluealsa`.
- **Severity:** medium (privilege surface), low exploitability.
- **Why it matters:** The service must be granted passwordless sudo for these
  binaries. `pkill -x bluealsa` as root and a long-running `sudo bluealsa` widen
  the root surface. Arguments are fixed/derived from config (MAC, rfcomm id), not
  from HTTP input, so there is no direct injection — but anyone who can reach the
  backend can trigger root subprocesses (BT connect/disconnect, process kill).
- **Recommendation:** Scope the sudoers entry to the exact binaries + args
  (`NOPASSWD` only for `rfcomm`, `bluealsa`, `bluetoothctl` with constrained
  args). Prefer `setcap`/group membership (e.g. `bluetooth`) over sudo where
  possible. Keep the backend bound to `127.0.0.1` (it is).
- **Behavior change now?** No — document the required sudoers in README/STARTUP.
- **Fixed:** No.

## S2 — `/raw/send` and `/raw/query` send arbitrary frames to the radio
- **Where:** `mjs` `POST /raw/send`, `/raw/query`, `/raw/keytest`,
  `/raw/ptttest`.
- **Severity:** medium.
- **Why it matters:** These accept arbitrary hex and write it to the radio over
  SPP. That is the intended RE capability, but it means anyone who can POST to
  `:3010` (or through the UI proxy, if exposed) can transmit / reprogram / key
  the radio. `ptttest`/`keytest` can key the transmitter (RF emission —
  regulatory concern) though PTT bytes are forced safe in key variants.
- **Recommendation:** Gate `/raw/*` behind an env flag (`ANYTONE_ENABLE_RAW=1`)
  so production deployments can disable the RE endpoints; keep them off by
  default in the public-facing config. Ensure these are **not** proxied by Nuxt
  (currently they are not — good).
- **Behavior change now?** Optional (recommended before any public exposure).
- **Fixed:** No.

## S3 — Transmitter control reachable from the public UI
- **Where:** `/anytone/command` `TX1`/`TX0` via the proxied `/anytone/api/command`.
- **Severity:** medium (regulatory/safety, not classic infosec).
- **Why it matters:** The public `/anytone/` URL can key a licensed transmitter.
  The watchdog bounds hold time (60 s) but there is no auth in front of TX. For a
  licensed operator's private URL this may be acceptable; it should be a
  conscious decision.
- **Recommendation:** Put auth (nginx basic-auth / mTLS / an app token) in front
  of `/anytone/`, at minimum on TX-capable endpoints. Document the operator's
  responsibility.
- **Fixed:** No.

## S4 — Personal data committed / present in the tree
- **Where:** (historical) `channels.CSV`, `zones.CSV`, capture JSON/txt,
  codeplug backups, and GPS/callsign examples in `PROTOCOL.md`.
- **Severity:** low–medium (privacy, not credentials).
- **Why it matters:** Codeplug + GPS fixes + callsign are personal.
- **Recommendation / resolution:** CSVs are gitignored; protocol captures,
  codeplug backups, zone maps, and async logs are excluded from the public tree;
  `docs/PROTOCOL.md` uses generic examples for callsigns, GPS, IDs, and channel
  names. History is kept as a single clean initial commit before publication.
- **Fixed:** **Yes**.

## S5 — No committed credentials, but hardcoded infra in code
- **Where:** radio MAC, example host `radio.example.com` (nuxt comments /
  STARTUP.md).
- **Severity:** low.
- **Why it matters:** No secrets/tokens/passwords were found in source (the high
  grep counts for "token"/"password" are from `package-lock.json` and example
  IPs in dependency docs, not real secrets). Hardcoded internal IP/host is config
  smell, not a vuln.
- **Recommendation:** Already env-overridable (`ANYTONE_BT_ADDR`). Document
  defaults; no action required.
- **Fixed:** N/A.

## S6 — Outbound fetches
- **Where:** `radioid.mjs` downloads the RadioID DMR user dump from a fixed host
  (`database.radioid.net`, override `ANYTONE_RADIOID_URL`), triggered by
  `POST /radioid/refresh`.
- **Severity:** low.
- **Why it matters:** The URL is a server-side constant, not user-supplied, so
  there is no user-driven SSRF.
- **Recommendation:** Keep the URL config-controlled (it is).
- **Fixed:** N/A.

## S7 — Verbose logging may include status/position data
- **Where:** `this.log(RX … hexdump)`, async NDJSON capture (full raw frames,
  which include GPS `52`, callsign `33`, contacts).
- **Severity:** low.
- **Why it matters:** Logs/NDJSON persist decoded personal data (GPS, callsign).
  On a shared host the log ring + `unsolicited.ndjson` leak position.
- **Recommendation:** Keep file logging opt-in; avoid logging GPS/contact payloads
  at info level in production.
- **Fixed:** No.

---

## Summary
No critical/high infosec issues for the stated private-LAN threat model. The
real risks are (1) the root subprocess surface (S1), (2) unauthenticated TX /
raw-frame control if the UI is exposed without auth (S2, S3), and (3) personal
codeplug/GPS data hygiene (S4, S7). All are deployment/config hardening rather
than code vulnerabilities. Recommended pre-public-exposure changes: env-gate
`/raw/*`, put auth in front of `/anytone/`, scope sudoers, keep CSVs/recordings
out of git (done).
