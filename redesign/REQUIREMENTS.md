# Requirements

Numbered so the rest of the docs and the eventual tests can reference them. **F** =
functional, **NF** = non-functional. Grades per [README](README.md#evidence-grading).

## F — Functional

### F1. Connectivity
- **F1.1** Establish the radio control link over a **native AF_BLUETOOTH RFCOMM socket** (no
  `rfcomm` CLI / kernel TTY), with HFP for audio. [CONFIRMED — live config]
- **F1.2** *(deferred)* A wired serial transport is out of scope for v1; the transport seam
  leaves room to re-adopt it later.
- **F1.3** **Continuous link health + automatic redial** — establish/re-establish the control
  link with capped backoff, **indefinitely, including retrying the INITIAL connection**, without
  tearing down audio. Make **no assumption about why** a link drops. (The PoC's "DMR call sheds
  SPP" rationale was a misdiagnosis — keep the resilience, drop the causal story.) [improvement]
- **F1.4** **Relay mode**: open the radio link but inject nothing; forward a real BT-01's
  traffic for reverse-engineering. (Retained — it's how the protocol gets validated.) [CONFIRMED]

### F2. Live radio state
- **F2.1** Maintain authoritative live state: per-side S-meter/RSSI, squelch open/close,
  RX/TX frequency, mode, zone, channel name/number, selected side, dual-watch. [CONFIRMED]
- **F2.2** Decode DMR call activity: TG, caller DMR ID, talker alias, RX/TX/idle, slot/CC.
  [CONFIRMED]
- **F2.3** Surface clock and GPS where the radio reports them. [CONFIRMED]

### F3. Control
- **F3.1** PTT (key/unkey), with a hard watchdog auto-release ceiling. [CONFIRMED]
- **F3.2** Read/write radio menu settings (gains, NR, squelch, tones, etc.). [CONFIRMED]
- **F3.3** Read/write per-channel settings (type, power, bandwidth, tone, name, freq). [CONFIRMED]
- **F3.4** Channel up/down and zone up/down; direct channel/zone select. [CONFIRMED]
- **F3.5** Native scan: enumerate scan lists, start/stop, follow the locked channel. [CONFIRMED]
- **F3.6** Manual DMR dial (group/private). [DOCUMENTED]

### F4. Audio
- **F4.1** Stream radio RX audio to the browser (WebRTC). [CONFIRMED]
- **F4.2** Send browser mic to the radio for TX while keyed (WebRTC → HFP sink). [CONFIRMED]
- **F4.3** Squelch-triggered recording to disk, **operating headless** (no UI required). [CONFIRMED]

### F5. Codeplug enumeration
- **F5.1** Enumerate zones → channels and scan lists → members for the UI pickers, purely
  via reads (non-destructive, no navigation/commit). [CONFIRMED]

## NF — Non-functional

### NF1. Single process, single state
- **NF1.1** One runtime process owns the radio link **and** the authoritative state object.
  No cross-process proxying of live state (smeter/squelch). The two-process PoC split is
  replaced. [decision]
- **NF1.2** Exactly **one authoritative `RadioState`** in memory; everything else derives from
  it. The UI receives projections/patches, never a second source of truth.

### NF2. Robustness (the link must not break the system)
- **NF2.1** Strict one-command-in-flight; retransmit on timeout; never corrupt the codeplug.
  (See LINK_PROTOCOL — these collapse to a few invariants.) [CONFIRMED]
- **NF2.2** The radio link self-heals: indefinite reconnect + on-reconnect state re-snapshot.
- **NF2.3** The service restarts forever under its supervisor; no start-rate-limit lockout.
- **NF2.4** Headless operation: recording/relay/link work with no browser attached. [CONFIRMED]

### NF3. Modularity & reviewability
- **NF3.1** Files are **single-responsibility and small** (target ≤ ~400 lines; hard ceiling
  to be set). No file should be too large to hold in one human's — or one LLM's — working
  context. This is a hard requirement, motivated directly by the 10k-line `index.vue` and
  4k-line backend of the PoC. [decision]
- **NF3.2** Clean layer boundaries (transport / link / codec / domain / services / api / ui),
  each independently testable. (See ARCHITECTURE.)
- **NF3.3** TypeScript, **strict**, across backend and UI. The UI stays **Vue** (the PoC's
  monolithic `index.vue` decomposed into components), built to a **static SPA** served by the
  daemon — no second runtime process, no SSR.

### NF4. Testability
- **NF4.1** Link + codec layers are **pure and replay-testable** against captured
  `wire.ndjson` traffic (golden-master). Framing/decoding must reproduce the reference
  implementation frame-for-frame. [decision]
- **NF4.2** A captured session is the definition of done for parity per capability.

### NF5. Observability
- **NF5.1** Expose link-health metrics (command retransmit/drop rate, push-ACK latency,
  reconnects). [CONFIRMED — already built in the PoC]

### NF6. Security / deployment
- **NF6.1** Scoped privilege (sudoers limited to the exact BT commands needed). [DOCUMENTED]
- **NF6.2** TLS + (optionally mutual TLS) termination at the reverse proxy. [DOCUMENTED]
- **NF6.3** One-shot idempotent installer; service config via env. [DOCUMENTED]

### NF7. Standards & dependencies
- **NF7.1** **Prefer well-defined standards and maintained libraries over bespoke code**, except
  where the hardware forces custom (the radio link protocol; the AF_BLUETOOTH RFCOMM socket, since
  Node has no native support). Committed choices:
  - WS command bus → **JSON-RPC 2.0**.
  - Incremental state → **JSON Merge Patch (RFC 7396)**; full snapshot on (re)connect.
  - Contracts (messages + `RadioState`) → **Zod** schemas as the single source of truth (runtime
    validation + derived TS types).
  - WebSocket server → maintained **`ws`**; **WS-level ping/pong** for heartbeat.
  - WebRTC → standard SDP offer/answer + trickle ICE; server lib chosen by the CONNECTION eval.
  - Command correlation → JSON-RPC `id`; v1 deliberately fails mutating commands fast on WS loss
    rather than replaying them without an idempotency model.
- **NF7.2** **Validate every inbound message against its schema at the boundary** (Zod); reject
  malformed frames rather than trusting the wire.
- **NF7.3** Bespoke code is allowed only at the hardware seam (link/codec/transport) and must be
  justified in-doc; everything above it leans on standards.

## Non-goals / deferred (v1)
- No multi-radio concurrency (single radio per instance).
- No multi-user auth model beyond the reverse-proxy layer.
- SSR is **not** required — the UI is a client-rendered SPA (no SEO need); this enables the
  single-process "daemon serves built assets" option (see ARCHITECTURE).
- Full codeplug *programming* (CPS replacement) is out of scope; we read + adjust live state.

## Definition of done (per capability)
Behavioral **parity with the PoC verified two ways**: (1) capture-replay tests pass for the
link/codec path, and (2) a live session against the real radio exercises the capability with
no regression. Only then is the PoC path retired for that capability.
