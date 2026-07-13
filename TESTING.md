# Testing Strategy

How we make the rewrite **verifiable, not hopeful** (REQUIREMENTS NF4). The central idea: the PoC
and the capture corpus are a **behavioral oracle** — the new code must reproduce known-good
framing, decoding, and state transitions, proven by replaying real traffic.

## The test pyramid (bottom = most, fastest)

```
        live parity         (manual, per capability — the cutover gate)
      ───────────────
     integration            (services with mocked transports/peers)
    ─────────────────
   replay / golden-master   (captures → codec/link/domain, assert == oracle)   ◀ the core
  ───────────────────────
 unit                       (pure functions: codec, checksum, framing, decoders)
```

## 1. Unit — pure functions (`codec/`, parts of `link/`)
The `codec/` and framing layers are **pure** (no I/O, no state) by the ARCHITECTURE dependency
rule, so they unit-test trivially:
- checksum: `sum(prev) & 0xff == last`.
- framing: head + length-by-type table; the browse-family checksum + next-head rule; partial and
  coalesced inputs.
- decoders: each register/push → typed struct; encoders: each command → bytes.

## 2. Replay / golden-master — THE core (NF4)
Replay real captured traffic through the new `codec`/`link`/`domain` and assert the output matches
a checked-in **golden** generated from the PoC.

- **Input corpus:** the `captures/` NDJSON logs (`wire.ndjson`, relay/control sessions), sanitized
  of personal IDs. Each line is `{dir, hex, …}`.
- **Codec golden:** feed the captured byte stream to the new framer/decoder; assert it produces
  the **same frame boundaries and the same decoded structs** the PoC produced for that stream.
  This is what catches a framing or offset regression frame-for-frame.
- **Link golden:** drive the new `link/` state machine with a captured rx stream + the host's tx
  sequence; assert it makes the same ACK/retransmit/match decisions (which pushes get acked, when
  a retransmit fires, one-in-flight ordering).
- **Domain golden:** apply a captured session to the new `domain/` reducer; assert the resulting
  `RadioState` snapshots match the PoC's at the same points (smeter, squelch, channel, DMR call).

> **Generating goldens (harvest the oracle):** a one-time script runs each capture through the
> **PoC's** decode/state path and dumps the decoded frames + periodic state snapshots as fixture
> files, checked in alongside the captures. The new code is asserted against these. When a decode
> is *intentionally* corrected (e.g. a fixed offset), regenerate the affected golden deliberately —
> a golden diff in review is the signal that behavior changed.

### Adversarial replay (framing robustness)
Beyond clean captures, synthesize hard inputs: split a frame across reads; coalesce several
frames into one read; a checksum-valid 18-byte prefix vs a 135-byte browse frame; a duplicate
`5e` (at-least-once); a dropped read followed by a retransmit. Assert the framer/ARQ handle each.

## 3. Integration — services with mocks
Test `domain` ↔ `services` ↔ `api` with the **transport mocked** (a fake byte pipe that replays a
script or a capture) and the audio/BT peers mocked:
- **Contract tests on the api boundary:** every message validates against its **Zod** schema;
  malformed JSON-RPC is rejected (NF7.2); `state.patch` (RFC 7396) applied to a snapshot yields the
  expected `RadioState`. (Standard libs — `ws`, the JSON-RPC + merge-patch impls — are trusted, not
  re-tested; we test *our* schemas and handlers.)
- a settings write → command lifecycle (in-flight → confirmed via the JSON-RPC response) over the bus.
- squelch state change → `Recorder` start/stop (headless, no UI).
- reconnect → state re-snapshot → in-flight reconciliation.
- PTT lifecycle: keydown → `keying` → `keyed`; unkey → `unkeying` → `idle`; forced unkey-failure →
  `fault` (must NOT reach `idle`).

## 4. Live parity — the cutover gate (NF4.2)
Per capability, a **manual live session against the real radio** exercises it with no regression,
*in addition to* the replay tests passing. Only then is the PoC path retired for that capability.
Checklist per capability: connect, the capability's happy path, a forced failure (e.g. unkey
during a drop), and `/raw/metrics`-style link-health sane.

## What we explicitly do NOT mock
- The **checksum/framing** logic — always the real implementation (it's the thing under test).
- The **captured bytes** — never synthesize "expected" radio responses by hand for the golden
  path; the radio's real bytes are the truth. (Synthesized inputs are only for the adversarial
  framing cases, where the *framer's* behavior, not the radio's, is asserted.)

## Tooling / CI
- Unit + replay + integration run in CI (pure + mocked — no hardware).
- Live parity is a documented manual gate, not CI.
- Captures and goldens live with the repo (sanitized); a `regen-goldens` script makes
  intentional decode changes auditable as fixture diffs.

## Open
- Capture sanitization pipeline (strip personal DMR IDs/callsigns) for the checked-in corpus.
- Whether to assert full `RadioState` snapshots or a curated subset of fields per checkpoint.
