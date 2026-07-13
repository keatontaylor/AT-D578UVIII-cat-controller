# AnyTone D578 Controller — Redesign (v2) Doc Set

This folder is the **foundational specification** for a clean re-implementation of the
AnyTone D578UV Bluetooth controller. It is the output of a long design pass over the
existing proof-of-concept (`app/anytone-server.mjs` + `app/pages/index.vue`), distilled
into normative contracts so the rewrite can be built against a *spec*, not by archaeology.

> **Status: DRAFT for review.** Nothing here is committed to code yet. Review, push back,
> and we refine before a line is written.

## Philosophy

1. **Treat the current codebase as a PoC, not garbage.** It encodes a large amount of
   hard-won, validated behavior. We **harvest** it as the reference implementation and
   behavioral oracle — every guard and edge case becomes a numbered requirement or a test,
   not a deleted line.
2. **Spec-first, then code.** These docs are the requirements. The protocol is now
   well-understood (it was reverse-engineered live and documented); the rewrite implements
   a known contract rather than re-deriving one.
3. **Capture-verified, not blind.** We have a corpus of real wire captures
   (`captures/wire.ndjson`). The rewrite's link/codec layers are validated by **replaying
   captured traffic and asserting identical framing/decoding** (golden-master /
   characterization tests). This is what turns a risky rewrite into a verifiable one.
4. **Invariants, not incidents.** Contracts describe what is *always true* (positive rules),
   not a catalogue of bugs we hit. Where a historical "edge case" was really a symptom of an
   incomplete model, it collapses into the correct rule. (e.g. the "5e wedge" is just *"these
   message classes require an ACK"*; "codeplug corruption" is just *"one frame on the wire at
   a time, with a gap"*.)
5. **Transplant the gnarly glue, rewrite the protocol.** The radio *protocol* is the
   well-understood part (safe to rewrite). The BT/audio *orchestration* (BlueZ, BlueALSA,
   HFP/SCO, ffmpeg, WebRTC) is under-documented system glue — we **port it behind a clean
   interface** rather than re-deriving it.
6. **Small, single-responsibility modules.** Files are sized so a human *and* an LLM can hold
   one in working memory. No 10k-line monoliths. This is a first-class requirement
   (see REQUIREMENTS §NF), not a nicety.

## How to read this set

| Doc | What it covers |
|---|---|
| [REQUIREMENTS.md](REQUIREMENTS.md) | Numbered functional + non-functional requirements; scope and non-goals |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Single-process layered design, the one state object, module boundaries |
| [LINK_PROTOCOL.md](LINK_PROTOCOL.md) | **Normative** radio link contract — framing, transactions, ACK classes, ARQ |
| [UI_PROTOCOL.md](UI_PROTOCOL.md) | The WebSocket command bus, command lifecycle, desired/reported state, PTT lifecycle |
| [CONNECTION_AND_COMPONENTS.md](CONNECTION_AND_COMPONENTS.md) | Connection establishment sequence + external-component inventory |
| [COMMAND_REFERENCE.md](COMMAND_REFERENCE.md) | Frame format + opcode/register catalogue (decode completion tracked here) |
| [TESTING.md](TESTING.md) | Capture-replay / golden-master test strategy (how NF4 is actually done) |

## Evidence grading (used throughout)

Every behavioral claim carries a grade. Do not promote a grade without new evidence; do not
build a hard dependency on anything below **DOCUMENTED** without flagging it.

| Grade | Meaning |
|---|---|
| **CONFIRMED** | Reproduced live / measured across many samples |
| **OBSERVED** | Seen directly in a capture, single session / not stress-tested |
| **DOCUMENTED** | Recorded in prior RE, not re-verified here |
| **INFERRED** | Logical deduction from confirmed facts |
| **HYPOTHESIS** | Working model, not yet validated — *must not be asserted as fact* |
| **OPEN** | Unknown; data needed |

The cardinal rule: **never launder a HYPOTHESIS into a fact to make the contract look tidy.**
A clean-but-wrong spec is worse than an honest messy one.
