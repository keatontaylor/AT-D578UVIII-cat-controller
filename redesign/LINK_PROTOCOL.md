# Radio Link Protocol (normative)

The contract for exchanging frames with the radio. Written as **invariants** — positive
rules that are always true — not as a list of incidents. Where the PoC accumulated "edge
cases," they are collapsed here into the small set of rules that make them impossible.

Grades per [README](README.md#evidence-grading). The **Normative** sections are the rules to
implement; the **Rationale** notes (indented `>`) are *informative* — the why and the
provenance, kept out of the rules so the contract stays clean.

In standard terms this is **Modbus-RTU-style stop-and-wait master/slave with AT-command-style
unsolicited result codes (URCs)**. If a decision is ambiguous, that pairing is the paved road.

---

## 1. Frame format

A frame is:

```
<head byte> <payload …> <checksum>
```

- **Checksum** = 8-bit additive sum of every byte except the last; the last byte *is* that sum
  mod 256. [CONFIRMED]
- There is **no length field, no sequence number, and no delimiter** anywhere in the frame —
  verified empirically across tens of thousands of captured frames. The only structural
  signals are the **head byte** and the **trailing checksum**. [CONFIRMED]

> Rationale: we searched every byte offset for a value equal to the frame length (and ±1/2/3),
> and for any byte that increments frame-to-frame. None exist. So idempotency — not sequence
> numbers — is how we tolerate retransmits (§5), and "head + checksum" is the entire framing
> toolkit.

## 2. Framing rule

**Length is determined by type, not carried in the frame.** Two cases:

- **Fixed-length frames** — for the status/ack head bytes, length is a constant per head byte:
  `03`=5, `5b`=3, `5a`=16, `5c`=12, `5e`=18, `5f`=5, `59`=57, `58`=112. [CONFIRMED]
- **`04` register reads** — length is usually a fixed property *of the register* (e.g. `04 51`=12,
  `04 2e`=20). Generated from the corpus: **56 registers are single fixed length; three registers
  are variable**: `04 2c` (72 compact / 118 full), `04 2d` (72 compact / 121 full), and `04 4b`
  (18 *empty-slot* / 135 *populated*). Variable reads are discriminated by which candidate length
  checksums and lands on a plausible next frame head. The other browse reads (`04 2b`=35,
  `04 2e`=20, `04 27`=104) are *fixed* length — their empty case is a same-length frame of `ff`,
  not a shorter one. `04 39` (contact browse) was not in the corpus — its length is still OPEN.
  [CONFIRMED — `redesign/data/frame-lengths.json`]

**The one framing rule that covers everything:**

> Read until a **checksum-valid frame** whose following byte is a **known head byte** or
> end-of-stream. For fixed registers that lands at the known length; for variable reads it selects
> the valid candidate length because the wrong length does not checksum. [CONFIRMED]

The checksum is a **validator and boundary confirmer**, never a guess. **Decision: the codec uses
a per-opcode length table** (generated from captures, never hand-maintained) for the 56
fixed-length registers — deterministic framing ("read exactly N, verify checksum"), no scanning.
Variable registers carry a tabled candidate length-set and use the checksum + next-head rule above.
Either way the checksum validates every frame.

> Transport note: the native RFCOMM socket is **`SOCK_STREAM` — a byte stream.** The kernel does
> **not** hand us RFCOMM packet lengths or boundaries (RFCOMM is stream-oriented and doesn't
> support `SOCK_SEQPACKET`; raw L2CAP would, but the radio's SPP is RFCOMM). So **framing is
> mandatory and entirely ours** — head + checksum + length-by-type. In practice a single `read()`
> often returns exactly one frame (low-rate traffic), but that is a tendency, not a guarantee:
> the framer must handle partial frames and several-frames-coalesced. We get **no length from the
> radio.**

> Rationale — variable examples: `04 4b 03` returns a valid 18-byte frame ("this scan-list
> slot is empty"); other indices return 135. The radio does **not** avoid the short frame by
> knowing a count — empties are interspersed (index 03 is a gap between populated 00–02 and
> 04–0b), so no count could skip it. Both the BT-01 and the PoC simply *frame the 18-byte as a
> valid empty record and move on*. Treat the empty frame as a first-class response, not an
> error to dodge. `04 2c/2d` likewise have a 72-byte compact channel block and a longer full form;
> both are first-class frames. [CONFIRMED]

## 3. Transaction discipline — TWO independent "one at a time" rules

These are different concerns and must not be conflated:

### 3.1 One frame per write + a permanent inter-frame gap
**Normative:**
- Send each frame as its own `write()`; **never batch multiple frames into one write.** Paced by
  one-in-flight (§3.2), each small write goes out as ~one RFCOMM packet, giving the radio a clean
  per-frame boundary to parse. [CONFIRMED behavior]
- **Keep a small inter-frame gap before the next write, permanently** — cheap insurance against
  the radio's RX-parser desync, independent of the transport. [decision]

> Rationale: the radio's RX parser desyncs if two of our frames coalesce in its receive FIFO (a
> poll read can turn into a stray write → codeplug corruption). That coalescing was largely a
> kernel-TTY artifact (the old `/dev/rfcommN` line discipline merged our writes), and the native
> RFCOMM socket avoids it on the send side (one small write ≈ one packet). **But** `SOCK_STREAM`
> makes no boundary *guarantee*, and "the socket alone fully eliminates the desync" is a
> HYPOTHESIS — so we **keep the small gap permanently** rather than bet the codeplug on it. The
> cost is negligible (tens of ms, far under the ~500 ms ACK budget); the downside of being wrong
> is corruption. Belt **and** suspenders by choice. (Receive-side framing is mandatory regardless
> — §2: the kernel gives us no length.)

### 3.2 One command awaiting a response (correlation / ARQ)
**Normative:** At most **one command is outstanding**. After sending a command, do not send the
next command until its response arrives, or it times out and exhausts retries (§5). Only
*commands* participate; ACKs (§4) do not. [CONFIRMED]

> Rationale: one-in-flight is also what lets us live without sequence numbers — with a single
> outstanding command, a response can only belong to it, so opcode-matching is sufficient and
> reordering is impossible. **One-in-flight and "no correlation IDs" are coupled invariants**;
> pipelining would require sequence numbers the protocol does not provide.

### 3.3 Reads vs writes
- A **read** is acknowledged by its **data frame** (`04 <reg> …`) — the data *is* the ack.
- A **write/session command** is acknowledged by a short **`03 <op> 00 00`** frame.
[CONFIRMED]

## 4. Acknowledged vs free pushes (URCs)

After the streaming handshake the radio emits unsolicited frames in two classes:

| Class | Head bytes | ACK required? | Behavior |
|---|---|---|---|
| **Acknowledged** | `58 59 5c 5e 5f` | **YES** — reply `03 <head> 00 00` | radio **re-sends every ~500 ms** until acked |
| **Free** | `5a` `5b` | **NO** | best-effort telemetry stream |

**Normative:**
- ACK every acknowledged-class push **immediately**, as a **priority write** that **jumps ahead
  of any queued command** but still passes through the §3.1 writer (one-frame-at-a-time + gap).
  It expects no response and occupies no command slot.
- **Never** ACK `5a`/`5b`.
[CONFIRMED]

**Push re-send interval = ~500 ms** — rock-solid universal (7k+ samples, p50 500 / p99 527).
The genuine BT-01 acks within p50 ~95 ms / max ~360 ms, always inside that window. So a plain
immediate priority-write meets the deadline; **no special machinery is needed.** [CONFIRMED]

> Rationale — the "5e wedge" is **not** an edge case. It is what happens when you violate the
> rule above: an un-acked acknowledged-push is re-sent forever and the `5a`/`5b` stream stalls.
> State the rule ("these classes require an ACK"); the wedge needs no further mention.

### 4.1 Acknowledged pushes are AT-LEAST-ONCE → receive-side idempotency
Because the radio re-sends until acked, **you can receive duplicates** of `5e/58/59/…` (a slow
ACK → the radio resends; we process the same push twice — observed). [CONFIRMED]

**Normative:** push handling must be **idempotent** — applying the same push twice yields the
same state. Never do anything *cumulative* on a push (increment a counter, append, re-trigger
an action) without dedup. (This is MQTT-QoS-1's rule.)

## 5. ARQ — retransmission

The radio **drops ~3 % of reads under load** (measured, clusters during DMR floods). It answers
a *received* command in ≤ ~240 ms (p50 ~95 ms), so ~1 s of silence means the request was
dropped. The genuine head recovers by **re-sending the identical frame on a ~1 s timer**.
[CONFIRMED]

**Normative — retransmission is LINK-STATE-AWARE.** A timeout has two distinct causes; decide by
link state, not a blind counter:
- **Link up, radio busy / dropped the frame** (the ~3 % case): **retransmit** the identical frame
  on the ~1 s timer. Keep retrying generously while the link is healthy.
- **Link down** (socket closed / unreachable): **do NOT retransmit** — hammering a dead link is
  pointless. Stop, hand the command off to the reconnect path (F1.3 / CONNECTION), and **re-drive
  it via desired-state reconciliation** (UI_PROTOCOL) once the link returns.
- The retry budget is **gated on link health** — a down link must never consume attempts.
- Retransmit **only retransmit-safe** commands (§5.1); a late/duplicate response resolves the
  single outstanding command exactly once, otherwise treated as a push.
[decision]

> Rationale: retransmit is **required for correctness** while the link is up (without it ~3 % of
> reads silently fail during DMR); the ~1 s timer matches the BT-01's measured 800–1100 ms band.
> But "retransmit" and "reconnect" are answers to *different* failures — the ARQ layer should not
> keep firing into a link that is down; that is the reconnect layer's job.

> **Direction — adaptive retry [HYPOTHESIS/target].** The end state is a link layer that
> *understands overall link state* and chooses retry behavior dynamically: while the radio is
> demonstrably alive (pushes flowing, recent valid frames) it may retry **indefinitely**; when
> link state says the radio/link is gone it pauses immediately and defers to reconnect. v1 may
> start simple — "don't retry on a closed socket; ~10 attempts while up" — and evolve toward the
> fully state-driven model. The flat attempt cap is a v1 placeholder, not the target.

### 5.1 Retransmit safety (idempotency = the sequence-number substitute)
With no sequence number, a retransmit after a *lost ACK* (the radio already acted) can
double-apply. So:

**Normative:** default a command **retransmit-unsafe** unless it is provably idempotent.
- **Safe:** all reads; absolute writes (set value = X twice == once); absolute channel/zone
  selects; PTT keydown.
- **Unsafe / handled specially:** PTT **unkey** (§6), relative/toggle ops.
[INFERRED, per-command]

### 5.2 Head-of-line blocking (don't freeze the UI)
Stop-and-wait means one stuck command blocks the queue (up to N×~1 s). **Normative:** use
**differentiated retry budgets** — background/idempotent reads may be patient; **user-initiated
writes fail faster and rely on supersession** (latest desired-state wins; a newer write for the
same field cancels a stuck older one — see UI_PROTOCOL reconciliation). [decision]

## 6. PTT (safety-critical)

PTT uses the `56` family. The radio ACKs every `56` frame; the ACK **status byte** carries a
result (e.g. `03 56 00 01` DMR success vs `03 56 00 00`). [CONFIRMED]

**Normative:**
- **Keydown** (`56 01 …`): retransmit-safe (re-keying TX is harmless).
- **Unkey** (`56 00 …`): **excluded from the generic ARQ.** A duplicate all-zero `56 00` can
  re-trigger the radio's release-`5e` and wedge its status stream. Reliability for the unkey
  comes from: a single **correct-form** send (DMR context tail where applicable), a
  **safety-release** that fires only if the write never drained, and a **watchdog
  auto-release** ceiling as the final backstop.
[CONFIRMED]

> Rationale: across 67 h of captures there were **zero** unkey timeout-retransmits — every
> unkey was acked first try; the head protects the release with *redundant correct-form sends*,
> not blind retry. A dropped unkey = stuck transmitter, so the watchdog (not ARQ) is the
> guarantee.

## 7. ACK ≠ proof of effect
The `03` ACK means **received and parsed**, not provably **applied**. For most settings writes
the radio acts on valid writes, so the ACK is a safe success proxy — but the radio ACKs even
no-op `56` keycodes, so do **not** treat ACK as proof of *effect* for a command whose effect
you have not independently established. Confirmation tiers:
- **Acknowledged-only** (most `08`/`2f` settings): the ACK is the confirmation; nobody reads
  the value back — neither the BT-01 nor the PoC. [CONFIRMED]
- **Self-reported** (channel/zone/freq via `04 2c/2d` on nav; signal via pushes): a real
  reported value to reconcile against, *eventually* (next read), not per-write. [CONFIRMED]

## 8. Liveness & desync
A frame is trusted only if it is **checksum-valid AND** the link is live (track
`lastValidFrameAt`). A checksum-valid frame on a desynced link can still be stale garbage;
the recovery is reconnect, not in-band repair. [DOCUMENTED]

---

## Invariants checklist (what the link layer must always uphold)
1. Send each frame as its own `write()` (≈ one RFCOMM packet) with a small permanent
   inter-frame gap; never batch. Frame the inbound byte stream ourselves — no length from the
   kernel. (§3.1, §2)
2. One command outstanding; next command only after the prior response completes. (§3.2)
3. Frame length is determined by type; checksum validates and confirms the boundary. (§2)
4. ACK every `58/59/5c/5e/5f` immediately as a priority write; never ACK `5a`/`5b`. (§4)
5. Push handling is idempotent (acknowledged pushes are at-least-once). (§4.1)
6. Retransmit retransmit-safe commands on ~1 s timeout **while the link is up**; defer to
   reconnect when the link is down; resolve exactly once. (§5)
7. PTT unkey is guaranteed by correct-form send + safety-release + watchdog, **not** ARQ. (§6)
8. Trust a frame only if checksum-valid *and* the link is live. (§8)

## Measured constants (for implementation; tune from production metrics)
| Constant | Value | Grade |
|---|---|---|
| Push re-send interval | ~500 ms (p99 527) | CONFIRMED |
| Command response latency | p50 ~95 ms / p90 ~175 ms | CONFIRMED |
| Command-retransmit timer | ~1 s (800–1100 ms band) | CONFIRMED |
| Retry budget | link-state-aware; ~10 attempts while link-up is a v1 placeholder | decision |
| Inter-frame gap | small (~tens of ms), **kept permanently** as insurance | decision |
| Read drop rate under load | ~3 % | CONFIRMED |

## Open / to validate
- Confirm the native RFCOMM socket's clean **send-side** packetization (one small write ≈ one
  packet) eliminates the long-session desync / codeplug-corruption the TTY path showed
  (HYPOTHESIS — mechanism understood; validate over a long session). No manual inter-frame gap
  should be needed. (Receive-side framing is ours regardless — the kernel gives no length.)
- Complete the per-register length table + ACK status-code map (see COMMAND_REFERENCE).
- `04 2d` read-mode byte `07` (startup) vs `01` (live) — confirm whether content differs.
