# UI ⇄ Backend Protocol (normative)

The contract between the SPA and the single backend process. One **bidirectional WebSocket**
carries commands up and state/lifecycle/events down. Audio media stays on WebRTC (only its
*signaling* rides this socket).

Mental model: **the command response is a *receipt*, never the *outcome*.** The outcome always
arrives via the authoritative state stream. This mirrors the radio layer exactly — there, the
`03` ACK is receipt and self-reported state is truth; here, the WS `ack` is receipt and the
`state` stream is truth. The layering is fractal.

The wire protocol **is JSON-RPC 2.0** (the actual spec, not "JSON-RPC-style"): correlated
request/response + unsolicited notifications. **LSP** is the reference template — a client driving
a stateful server with correlated requests *and* server-push notifications. Standards used here:
**JSON-RPC 2.0** (envelope), **JSON Merge Patch / RFC 7396** (state deltas), **Zod** (every
message + `RadioState` validated/typed from one schema), maintained **`ws`** (with WS-level
ping/pong heartbeat). Bespoke message shapes are avoided.

---

## 1. Why one WebSocket (not REST + SSE + polling)
The PoC juggles REST commands, an SSE state stream, recording polling, and WebRTC signaling.
Consolidating them removes the proxy boilerplate and makes the command lifecycle natural to
express. The WS is justified by **consolidation** — the reconciliation fix below could ship
over REST+SSE too, so we keep them conceptually separate: the *protocol* (correlation +
lifecycle) is the fix; the *transport* (WS) is the simplification.

## 2. Message envelope — JSON-RPC 2.0

```jsonc
// UI → backend
{ "jsonrpc":"2.0", "id":<number|string>, "method":"<command>", "params": { ...args } }
{ "jsonrpc":"2.0", "method":"rtc.signal", "params": {...} }                // notification (no id)

// backend → UI
{ "jsonrpc":"2.0", "id":<uuid>, "result": {...} }                          // command DONE
{ "jsonrpc":"2.0", "id":<uuid>, "error": { "code":<int>, "message":<str>, "data"?:{} } }  // FAILED
{ "jsonrpc":"2.0", "method":"state.snapshot", "params":<full RadioState> } // on (re)connect
{ "jsonrpc":"2.0", "method":"state.patch",    "params":<RFC 7396 merge patch> } // on change
{ "jsonrpc":"2.0", "method":"event", "params": { "kind":"recording"|"ptt"|"dmr", ... } }
{ "jsonrpc":"2.0", "method":"rtc.signal", "params": {...} }
```

- **Correlation** is the JSON-RPC `id`. The command's terminal outcome is the JSON-RPC
  **response** (`result` = done, `error` = failed). There is **no separate "ack" message** — the
  in-flight state is client-side from send→response (we collapsed pending/working, §3).
- The v1 client **does not replay mutating commands after WS loss**. In-flight requests fail fast;
  reconnect gets a fresh snapshot. If idempotency is needed later, add it only to operations whose
  repeat semantics are safe and explicit.
- **State** is pushed as JSON-RPC **notifications**: `state.snapshot` (full `RadioState`) on
  (re)connect, then `state.patch` (**RFC 7396 merge patch** — present keys replace, `null`
  deletes) on every change.
- **Errors** use the JSON-RPC error object; we define a small `code` enum (e.g. link-down,
  retransmit-exhausted, invalid-arg) in the Zod schema.
- **Heartbeat** is **WS-level ping/pong** (handled by `ws`), not application messages.
- Every inbound message is **validated against its Zod schema** at the boundary (NF7.2).

## 3. Command lifecycle
On the wire this is just a **JSON-RPC request → response** (there is no separate ack message). The
UI renders off the lifecycle, **never** off the request promise's timeout:

```
        send request                JSON-RPC result  ──▶ confirmed
  idle ──────────────▶ in-flight ──{                 
        (client-side)               JSON-RPC error   ──▶ failed
```

- **in-flight** — request sent, no response yet (client-side; shown as "syncing").
- **confirmed** — JSON-RPC `result` received.
- **failed** — JSON-RPC `error` received (retries exhausted / link-down / terminal).

The backend drives the radio meanwhile (`link/` awaits the radio's `03` ACK and retransmits while
the link is up — LINK_PROTOCOL §5/§7); the JSON-RPC response is sent only at the terminal outcome.
A long retransmit just means the response arrives later — the UI stays "in-flight," never reverts
on the wait. (For diagnostics the backend can still expose finer internal phases via metrics, but
they are not on the wire and not surfaced as UI states.)

## 4. Desired vs reported state (device-shadow reconciliation)
The backend's `RadioState` holds, for reconcilable fields, both a **reported** value (what the
radio is) and a transient **desired** value with a lifecycle while a write is in flight. This
is the AWS-IoT-shadow / Kubernetes spec-vs-status pattern.

**Normative UI behavior:**
- On a control change, show the **desired** value immediately with an **in-flight** indicator.
- Clear the indicator on `confirmed` (reported now matches, or the ACK confirmed it).
- On terminal `failed`, **revert the control to the reported value and show an error affordance.**
- **Never** revert on a request *timeout* — a timeout means "still working," not "failed." Only
  an explicit `failed` result reverts.

**Supersession (latest-wins):** if the user changes the same field again while a write is in
flight, the newer desired value supersedes the stuck one (cancel/replace), rather than queueing
a stale intent. This is also the link-layer HOL-blocking mitigation (LINK_PROTOCOL §5.2).

## 5. Settings pane — in-flight visual (requirement)
Each settings control binds to its field's lifecycle status (collapsed to one in-flight state):
- **in flight** → amber outline + small spinner ("syncing").
- **confirmed** → brief green tick, then clear.
- **failed** → revert to reported value + red outline / error affordance.
The global link-health counters (retransmits/fails/slow-ACKs) remain in the footer; this is the
*per-control* version.

## 6. PTT lifecycle (safety-critical) — the color contract

PTT state is **not** a boolean. The backend exposes `pttState`, driven by the radio's *actual*
ACK timing (LINK_PROTOCOL §6), and the UI colors strictly off it:

| `pttState` | Meaning | Button |
|---|---|---|
| `idle` | confirmed **not** transmitting | 🟢 green |
| `keying` | keydown sent, awaiting radio ACK | 🟡 yellow |
| `keyed` | radio acknowledged TX — **confirmed transmitting** | 🔴 red |
| `unkeying` | unkey sent, awaiting confirmation | 🟡 yellow |
| `fault` | unkey failed — possibly **still transmitting** | 🔴 flashing |

```
 idle ──press──▶ keying ──keydown ACK──▶ keyed
   ▲                │ (keydown fails)        │
   │                ▼                        │ release
   │              idle  (never transmitted)  ▼
   └──unkey ACK / confirmed── unkeying ◀─────┘
                                 │ (retries/watchdog exhausted)
                                 ▼
                               fault  (NEVER auto-returns to green)
```

**Normative:**
- The button **never turns red until the radio truly acknowledges the keydown** (`keyed`).
  Pressing PTT shows **yellow** (`keying`) first.
- On release it goes **yellow** (`unkeying`) and returns to **green only when the unkey is
  confirmed** — never optimistically.
- A failed unkey goes to **`fault`** (flashing red), **not** green — the watchdog
  (LINK_PROTOCOL §6) drives recovery, and the UI must show "possibly still transmitting."

## 7. Reconnect & resilience
WS gives no auto-reconnect for free (unlike SSE), so the client owns it:
- Reconnect with backoff; on (re)connect the server emits a `state.snapshot` notification and the
  client reconciles from it (the client may also call a `state.get` method to pull it explicitly).
- In-flight commands fail with a transport error when the WS drops; the fresh snapshot is the
  authority for whether the radio-side action eventually landed.
- Mutating commands issued while offline are rejected rather than queued/replayed. Relative and
  safety-critical commands (`ptt.*`, channel/zone step) must never auto-replay.
- **WS-level `ping`/`pong`** (the `ws` library) detects a dead socket — not application messages.

## 8. What stays off the WS
- **Audio media** — WebRTC peer connection.
- A few **idempotent GET snapshots** (status, ports, metrics) on plain REST — invaluable for
  `curl`/debugging and as the reconnect re-snapshot fallback.

## Resolved (review 2026-06-27)
- Terminal `failed` → **revert to reported + error affordance**.
- UI **collapses `pending`+`working`** into one in-flight indicator (backend tracks both).
- PTT color contract confirmed as written (§6).

## Open questions
- Field granularity: per-field reconciliation for bindable controls vs a small per-operation
  registry for non-field actions (PTT, scan start) — likely **both** (per-field for controls,
  a tiny op registry for actions). Confirm during implementation.
