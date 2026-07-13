# TODO — known non-urgent items

Deferred findings from the 2026-07-01 full-lifecycle review. Everything here was judged real but
low-severity; the high/medium findings were fixed in commits `4a24efe`…`534061f`. Ordered roughly
by value.

## Bluetooth (from the connect-lifecycle review)

- [ ] **Unregister the pairing agent on shutdown** (`src/bluetooth/bluez.ts`). We register as the
  system *default* agent (`RequestDefaultAgent`) and never call `unregisterAgent()` from `close()`,
  hijacking the desktop's agent for the process lifetime. BlueZ auto-cleans on bus disconnect, so
  this is cosmetic — but a clean shutdown should release it explicitly.
- [ ] **Refcount discovery start/stop** (`src/bluetooth/bluez.ts` + `manager.ts`). `scanFor` and
  `pairWithDiscovery` each `finally { stopDiscovery() }`; two concurrent operations can cut
  discovery out from under each other. Fine for today's sequential flow; a refcount future-proofs it.
- [ ] **Re-assert the bredr discovery filter if externally reset** (`src/bluetooth/bluez.ts`).
  `ensureDiscoveryFilter` latches `filterSet=true` after first success; another client or
  `bluetoothctl` resetting the adapter filter won't be corrected. Also note BlueZ merges discovery
  filters as a *union across D-Bus clients* — the old PoC app (port 3010) registering `auto`/`le`
  can let LE adverts leak back in. Retiring the old app is the cleanest fix.
- [ ] **RFCOMM write EAGAIN busy-spin** (`src/transport/rfcomm.ts` `write()`). Retries up to 50×
  with no yield when the socket buffer is full. Negligible for our tiny frames; a short poll/sleep
  would be more polite.

## Behavior / polish

- [x] **Non-destructive zone enumeration for v2** — RESOLVED 2026-07-02 without the `04 2b` walk:
  BT-01 relay RE showed the head never enumerates zone names; the zone COUNT lives in `04 1b`
  byte 36 (live-matched). The startup enumeration now reads `1b` and the reducer populates
  `side.zoneCount`, so Zone +/- wraps host-side exactly like the BT-01 does.
- [ ] **Connect-deadline error can mask the root cause** (`src/services/radio-service.ts`
  `connect()` catch): if the deadline fires while teardown after a *real* error is still running,
  `signal.aborted` wins and the timeout message replaces the underlying failure. Cosmetic; prefer
  the first error.
- [ ] **Auto-reconnect policy** (deliberately absent in v1). An unexpected transport drop lands on
  `disconnected` + error; the user reconnects manually. If/when wanted, implement once, centrally —
  the framing-incident path intentionally reuses whatever this policy becomes.

## Deployment / cutover

- [ ] **Root npm scripts still target the legacy PoC** (`package.json`). Add explicit redesign
  scripts or switch the root delegation once v2 becomes the default app.
- [ ] **Installer/systemd still run `app/`** (`install.sh`, `deploy/systemd/anytone.service.example`).
  Cut over only when the redesign is intended to replace the PoC service.
- [ ] **Environment names still describe the two-process app** (`.env.example`). Decide whether v2
  uses `ANYTONE_API_*` only or supports compatibility aliases for `HOST`/`PORT`/`ANYTONE_SERVER_*`.
- [ ] **nginx docs/templates need the v2 single-process model**. Document the final port, loopback
  bind, static SPA serving, and `/ws` upgrade location; remove old SSE/audio-stream requirements
  when v2 is the production target.
- [ ] **Optional sub-path deployment** (`/anytone/`) needs a Vite `base` and configurable WebSocket
  path if it remains supported.

## RE / protocol (nice-to-have)

- [ ] **`04 00` garble characterization**. The one corpus anomaly (checksum-valid browse reply with
  zeroed register + stale payload, ~1 in 36k under fast name-browse polling) is contained and
  logged with its bytes (`framingIncident`). If incidents recur, correlate: does it only happen
  under rapid `04 2e` polling? A small inter-read delay might eliminate it at the source.
- [ ] **VFO-vs-memory read-flag byte** (`src/codec/decode.ts` `Channel.mode`): currently inferred
  from the "Channel VFO A/B" name pattern; a dedicated flag byte could be pinned from
  VFO-vs-memory captures.
- [ ] **DigiMon read-back offset** — the one settings read-back still unmapped (see
  settings/zone-picker notes).
