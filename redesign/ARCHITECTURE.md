# Architecture

A **single process**, organized as strict layers around **one authoritative state object**.
The design target is: easy to reason about, cleanly task-separated, small modules, and a
state model that makes the UI's "is this change in flight?" question answerable for free.

## Why single process (vs the PoC's two)
The PoC runs a radio daemon (`anytone-server.mjs`, :3010) and a Nuxt/Nitro server (:3030)
that proxies to it. Sharing live state (smeter/squelch) across that HTTP boundary is a smell —
that state wants to be **one in-memory object**, not serialized and re-fetched. The PoC split
was buying fault isolation for a *fragile* link; a clean link layer + a supervisor that
restarts forever (NF2.3) recovers that robustness without the split-brain state.

## Layer diagram

```
┌──────────────────────────────────────────────────────────────┐
│ ui/            client-rendered SPA (componentized)            │
│   - one WebSocket to the api layer; renders RadioState         │
│   - WebRTC peer for audio media only                           │
└───────────────┬───────────────────────────────────────────────┘
        one WS  │  (commands ↑  · state/events/lifecycle ↓)
┌───────────────▼───────────────────────────────────────────────┐
│ api/           JSON-RPC 2.0 bus over `ws` (UI_PROTOCOL.md)      │
│   - request→response commands; state.snapshot / RFC7396 patches │
│   - one WS only — no REST/SSE; commands + pushes share it       │
├────────────────────────────────────────────────────────────────┤
│ domain/        the one authoritative RadioState                │
│   - desired vs reported reconciliation                          │
│   - per-field/op lifecycle (pending/confirmed/failed)           │
│   - PTT lifecycle state machine                                 │
├────────────────────────────────────────────────────────────────┤
│ services/      side-effecting features (TRANSPLANTED glue)      │
│   - audio/HFP orchestration · recording · WebRTC signaling      │
│   - each behind a narrow interface                              │
├────────────────────────────────────────────────────────────────┤
│ link/          the radio link state machine (LINK_PROTOCOL.md)  │
│   - one-in-flight, write serializer + gap, ARQ/retransmit       │
│   - ACK-class handling, push demux                              │
├────────────────────────────────────────────────────────────────┤
│ codec/         pure frame encode/decode + register map          │
│   - framing (head byte + checksum + length-by-type)             │
│   - no I/O, no state — fully unit/replay testable               │
├────────────────────────────────────────────────────────────────┤
│ transport/     native AF_BLUETOOTH RFCOMM socket (SOCK_STREAM)   │
│   - send: one small write ≈ one packet (clean frame for radio)   │
│   - recv: a BYTE STREAM — no lengths; codec frames it            │
│   - (wired serial is a future second impl behind this seam)      │
└────────────────────────────────────────────────────────────────┘
```

## Dependency rule
Dependencies point **downward only**. `codec/` and `link/` know nothing about `domain/`,
`api/`, or `ui/`. `domain/` knows nothing about `api/`. This keeps the testable core
(`transport`/`codec`/`link`) free of framework and UI concerns and is what enables NF4
(replay tests) and NF3 (small, isolated modules).

## Standards & contracts (NF7)
Above the hardware seam, lean on standards, not bespoke code: the `api/` bus is **JSON-RPC 2.0**
over the maintained **`ws`** library, state deltas are **RFC 7396 merge patches**, and the
message + `RadioState` contracts are **Zod** schemas that are the single source of truth — the
`domain` types, the `api` validation, and the `ui` client types all derive from the same schemas.
Bespoke code is confined to the hardware-forced seam (`transport`/`codec`/`link`) and the radio
protocol itself.

## The one state object (`domain/RadioState`)
- A single typed object: link status, per-side signal/freq/mode/zone/channel, DMR activity,
  settings, scan, audio, metrics.
- **Two faces per field** where reconciliation applies (UI_PROTOCOL): a *reported* value (what
  the radio actually is) and, transiently, a *desired* value with a lifecycle while a write is
  in flight.
- Mutations happen in exactly one place; everything observes. The `api` layer pushes a
  snapshot on connect and patches on change. There is no second copy of truth anywhere.
- **Record-canonical**: for radio records (the working-channel block today), the state carries
  the RAW frame (hex) alongside its decoded projection, stored in the same reduction so they
  can never disagree. Context writes (RX-freq echo-back; future full-record writes) splice
  known fields into the raw bytes via `codec/record.ts`, driven by `data/record-maps.json` —
  the same map that generates the frame-map docs. Unmapped offsets are preserved verbatim,
  proved by the byte-identity golden-master (`test/record.test.ts`).

## State flow (event-driven, one pipe)
Every state change — whether an unsolicited radio push or a consequence of a user command —
converges on one notify pipe and is fanned out as a patch. Nothing mutates silently.

**Inbound (unsolicited pushes AND command responses — the same path).** A 5a/5b/5e push and a
`04 xx` read response are both just decoded frames; there is no special-casing:
```
transport.onData(chunk) → link.receiveBytes (framing / ARQ / demux)
  → inbound(frame) → Session.dispatch({kind:'frame', frame})
  → applyEvent(current, event)                                ← the ONE reducer
  → events.onState(current)
```

**User commands.** The UI sends a JSON-RPC request; the Session issues the write and dispatches
the write's lifecycle as DOMAIN EVENTS (`pending` → `acked`/`failed`) through the same reducer.
The *reported* consequence still returns via the inbound path above:
```
ui → useRadio.rpc → /ws → dispatch → controller → session method
  → session.dispatch({kind:'setting'|'channelSetting'|…, phase:'pending', …})
  → link.submit(frame)          (radio's reply/ACK re-enters through Inbound / outcome hooks)
  → session.dispatch({…, phase:'acked'|'failed'})              → applyEvent → events.onState
```
One event = one reduction = one broadcast patch, **structurally** — a logical mutation (e.g.
"apply the acked value AND clear its pending overlay") cannot straddle two patches, because it
is one reducer case. (This class of bug shipped once as a stale-value flash; the event model
makes it unrepresentable.)

**Fan-out (both cases).** One place computes the delta and pushes it:
```
events.onState(st) → controller { radio = st; emit() }
  → broadcaster.publish(appState) → generateMergePatch(current, next)
  → if non-empty → notify('state.patch', patch) → every /ws subscriber
```
A new subscriber gets a full `state.snapshot` on join, then change-only patches. The controller's
own lifecycle transitions (`connection` status, connect `phase`) go through the same `emit()`.

**Frontend.** `useRadio` folds each snapshot/patch into the single `AppState` ref via
`applyMergePatch`; components render off it. Non-domain UI state (scan candidates, settings
option-catalogue, transient busy/drag flags) is deliberately *not* in `AppState`.

### Two categories of mutation — one reducer
1. **Reported** (from the radio): `{kind:'frame'}` events — pushes and read responses, shared path.
2. **Write lifecycles** (user intent): `{kind:'setting'|'channelSetting'|'channelTone'|
   'channelFrequency'|'sideSelect'|'ptt'|…}` events with a `pending → acked/failed` phase — the
   **device-shadow** (*desired-vs-reported*) model. The Session ORCHESTRATES (ARQ correlation,
   side-readiness, the 5a settle window) and dispatches; `applyEvent` in `domain/` is the only
   code that constructs a new state. `dispatch()` skips the broadcast when a reduction is a no-op
   (same reference back).

This is the mechanism behind **"ACK = gospel"**: a write's `03 <op>` ACK is consumed by the link's
ARQ + an outcome hook that dispatches the `acked` event; the reported consequence (e.g. the new
channel after a step) arrives later as a data frame → reducer. We do **not** poll to confirm writes.

### Invariant: exclusive controller
While connected we ARE the head (we emulate the BT-01), and **the radio disables its own front
panel** — no knobs, buttons, or menus operate on the radio while a head is attached (confirmed).
Consequently `RadioState` is complete by construction:
```
state = startup enumeration + our acked writes + the radio's pushes    — nothing else exists
```
This is what makes ack-optimistic updates and the no-polling rule *sound* rather than hopeful.
Corollary: any observed drift between our state and the radio is a protocol unknown (an undecoded
push/field) or a bug — never operator input — and is therefore always worth capturing for RE.

## Transport abstraction
`transport/` exposes a minimal duplex interface (`write(bytes)`, `onData(cb)`, `onClose(cb)`).
v1 has **one implementation: the native AF_BLUETOOTH RFCOMM socket** (`SOCK_STREAM`, no `rfcomm`
CLI, no kernel TTY — confirmed as the live config). Important: `SOCK_STREAM` is a **byte stream**
— the kernel does NOT expose RFCOMM packet boundaries or lengths, so the `codec` layer must frame
the inbound stream itself (head + checksum + length-by-type). The socket's benefit is on the
**send** side: one small `write()` (paced by one-in-flight) goes out as ~one RFCOMM packet, giving
the radio a clean per-frame boundary to parse — which is what avoids the write-coalescing desync
the old kernel TTY caused. A wired serial transport is **deferred** behind this same seam.

## Services are transplanted, not rewritten
`services/` (BlueZ pairing, BlueALSA HFP/SCO, ffmpeg capture, WebRTC, recordings) is the
under-documented system glue. Per the redesign philosophy we **port the PoC's working
implementations behind narrow interfaces** (e.g. `AudioLink`, `Recorder`, `RtcPeer`) rather
than re-deriving them. They depend on `domain/` for triggers (e.g. recording follows squelch
state) but never reach into `link/`/`codec/`.

## Process & deployment model
- **One runtime process** hosts `transport → … → api`.
- The UI is built to **static SPA assets** (no SSR needed, NF non-goal) and served by the same
  process. Nuxt/Vite is used as a **build tool**, not a runtime server — eliminating the second
  process while keeping the daemon as the single long-lived unit.
- Audio media stays on WebRTC (peer connection); only its *signaling* rides the WS.
- Supervised by systemd with restart-forever (NF2.3).

## Module-size discipline (NF3.1)
Each layer is a directory of small files, one concern each — e.g. `link/` splits into
`writer.ts` (serializer + gap), `arq.ts` (retransmit/timeout), `ack.ts` (push-ACK classes),
`inflight.ts` (the single outstanding slot), `demux.ts` (frame router). No file is the
"everything" file. The 10k-line `index.vue` and 4k-line backend are the explicit anti-pattern.

## Migration shape (strangler, not big-bang)
Build the new core alongside the PoC; cut over **per capability** (connect → state → PTT →
settings → scan → audio → recording), validating each against captures + live (NF4). The PoC
keeps running until a capability reaches parity, then that path is retired.
