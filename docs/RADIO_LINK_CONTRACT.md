# AnyTone D578UV — Radio Link Contract (transaction / link-layer discipline)

This is the **link-layer contract** for talking to the radio over the BT-01
head-bus: framing, transaction sequencing, acknowledgement rules, retransmission,
and the failure modes our serial core must defend against. It is the reference the
serial-core rewrite is built against.

It is deliberately **scoped to the link layer**. It does *not* re-document register
semantics or payload field layouts — those live in:

- [`PROTOCOL.md`](PROTOCOL.md) — register map, channel-block layout, settings offsets.
- [`BT01_HEAD_BUS_PROTOCOL.md`](BT01_HEAD_BUS_PROTOCOL.md) — head-bus opcode catalogue,
  status-push meanings, DMR caller-ID decode, the "5e wedge".
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — where the serial core sits in the stack.

> **Why this doc exists.** The communication model was previously spread across code
> comments, two protocol docs, and tribal memory. The goal here is a single,
> evidence-graded contract so the serial core can be refined **without re-deriving
> the rules** and **without baking in unverified assumptions** about radio behavior.

---

## 1. How to read this document — evidence grades

Every behavioral claim below carries a grade. Do not promote a claim to a stronger
grade without new evidence; do not implement a hard dependency on anything below
**DOCUMENTED** without flagging it.

| Grade | Meaning |
|---|---|
| **CONFIRMED** | Reproduced live against a real radio (multiple samples / controlled test). |
| **OBSERVED** | Seen directly in a capture, but from a single session / not stress-tested. |
| **DOCUMENTED** | Recorded in prior RE (PROTOCOL.md / head-bus doc / measured MITM) but not re-verified here. |
| **INFERRED** | Logical deduction from confirmed facts; not directly observed. |
| **PROPOSED** | An implementation choice for the rewrite, *not* a radio fact — must be validated. |
| **UNKNOWN** | Open question; data needed. |

The primary new evidence backing this doc is a **2026-06-26 relay-mode capture**
(`bt01-relay-macos-20260626-103259`, analog scan session, real BT-01 driving the
bus). Relay mode is the gold standard for "what should we emulate": the genuine
BT-01 is the sole operator, so its on-wire behavior *is* the target contract.

> **Timing now measured (2026-06-26 DMR `wire.ndjson`).** The analog session above
> could not establish ACK/retransmit timing; a subsequent DMR capture does. Two
> segments are the basis for §6.1/§7: **seg361** (recent, healthy relay DMR, 305 s,
> BT-01 ACKing cleanly) and **seg112** (62 min, the radio re-sending un-ACKed `5e`
> after a head dropout — a relay-dropout, NOT a head ACK bug; see §6.1 mode note).
> The measured constants are folded into §6.1 and §7 below and graded **CONFIRMED**.

---

## 2. Roles & transport (summary)

- The radio and the BT-01 each expose `BRCM SPP SERVER` on **RFCOMM channel 2**;
  HFP (channel 1) carries audio. [CONFIRMED, see head-bus doc §1]
- For control, the **radio is the SPP client and dials the BT-01's SPP server**; the
  head then *drives* the protocol. When **we** are the controller we take the head's
  role. [DOCUMENTED]
- Frames are **raw** over a direct SPP link. The `+ADATA:00,<len>\r\n…\r\n` envelope
  exists only inside a physical BT-01's internal UART and **must never be sent over
  SPP**. Our transport abstraction (`encodeOutbound`) selects framing per link;
  default BT path is raw. [CONFIRMED]
- The radio answers SPP reads **only while an HFP link is established**. [DOCUMENTED]

---

## 3. Frame format & checksum

- A frame is `<opcode> <payload…> <checksum>`. [CONFIRMED]
- **Checksum** = 8-bit additive sum of all preceding bytes mod 256 (the final byte).
  [CONFIRMED]
- **ACK frames are the exception:** `03 <op> 00 00` is sent as a **bare 4-byte frame
  with no trailing checksum byte** (the radio's own ACKs appear as 5 bytes
  `03 <op> 00 00 <ck>`; the head's push-ACKs are written as 4 bytes). [DOCUMENTED —
  head-bus doc §6; our `dispatch()` writes the 4-byte form.]
- Read requests are `04 <reg> <mode> 00 00 00`. [CONFIRMED] See §5 for `<mode>`.

> **Edge case — checksum-valid desync.** A frame can pass the checksum and still be
> semantically stale/garbage after a link wedge (the historical "5a register wedge":
> S-meter flaps with no signal while status looks healthy). Checksum-OK is necessary
> but **not sufficient** for trust; liveness must also be tracked (§13). [DOCUMENTED]

---

## 4. Transaction discipline — the core contract

### 4.1 One command in flight (strict request/response)

**The head never has more than one command outstanding.** It writes a command, waits
for the matching response/ACK, and only then issues the next command.

- Evidence: in the 2026-06-26 capture, every `H→R` frame is followed by its `R→H`
  response/ACK **before** the next `H→R` — across the entire ~55-register startup
  enumeration *and* the operational phase. No pipelining anywhere. [OBSERVED, strong]
- Measured request→response latency this session: **~150–330 ms**
  (COM MODE→ACK 231 ms; `04 02` read→resp 267 ms; `57 48`→ACK 332 ms;
  `56 01`→ACK 146 ms). [OBSERVED]

**Contract:** commands are serialized; a new command MUST NOT be written until the
prior command has resolved (matched) or terminally failed (timeout + retries
exhausted). [CONFIRMED as radio expectation / required behavior]

### 4.2 The ACK exception (out-of-band, not a "command")

Acknowledging the radio's acknowledged status pushes (§6) is the **one write that is
allowed while a command is in flight**. A push-ACK:

- is latency-critical (the radio re-sends the push until ACKed and stalls its stream
  meanwhile), so it **must not queue behind an in-flight command**; [DOCUMENTED]
- expects **no response** and therefore occupies **no outstanding slot**; [INFERRED]
- is fire-and-forget. [DOCUMENTED]

**Contract:** push-ACKs bypass the command serializer entirely. They are the *only*
exception to §4.1. Everything else is a serialized command. [CONFIRMED as the model;
matches the user's prior recollection — "one write in flight except ACKs".]

> **Ordering note [INFERRED]:** push-ACKs and command writes ultimately share one
> byte stream to the socket. The OS/stream serializes whole writes FIFO, so frames
> cannot interleave mid-frame, but a push-ACK issued while a command's bytes are
> draining will be sent *after* that command. Over BT this added delay is sub-ms and
> below the radio's re-send window; acceptable. If a future DMR capture shows the
> radio re-sending pushes under our load, revisit ACK prioritization.

### 4.3 Command classes

| Class | Opcodes | Expects | Notes |
|---|---|---|---|
| Read | `04 <reg> …` | data frame `04 <reg> …` | response *is* the data; carries state |
| Session | `01` COM MODE, `64` COM CHECK END, `61` wake | `03 <op> 00 00 <ck>` ACK (wake: none) | lifecycle only (§9) |
| Write | `08 …`, `2f …`, `57 …` | `03 <op> 00 00 <ck>` ACK | ACK is the confirmation (no per-write read-back); see §8 two-tier note |
| PTT | `56 <key> …` | `03 56 00 00 59` ACK | also pushes `5e` on DMR release |
| Push-ACK (ours) | `03 <op> 00 00` | none | the §4.2 exception |

[All CONFIRMED except where a specific field is flagged in PROTOCOL.md.]

---

## 5. Read modes — the `07` vs `01` byte

The third byte of a read request is a **mode selector**:

- `07` — used by the BT-01 for the **startup bulk enumeration**. [OBSERVED]
- `01` — used by the BT-01 for **live refresh** during operation
  (`04 2d 01 …`, `04 51 01 …`, `04 4a 01 …` all seen in the operational phase).
  [OBSERVED]
- `04 26` is special: byte 2 is a **page index**, not a mode. [CONFIRMED, PROTOCOL.md]
- Other list/browse reads (`2b`/`2e`/`27`/`39`/`4b`) use command-specific argument
  bytes, not this mode field. [CONFIRMED, PROTOCOL.md]

**What is NOT established:** whether `07` and `01` return *different content* for the
same register (e.g. `07`=stored vs `01`=live/current), or are interchangeable. Our
code currently reads **everything with `07`**, including live re-reads, and it works
(the radio answers `07` live too). [OBSERVED divergence — see §10]

> **Decision [PROPOSED, needs one test]:** Before switching live reads to `01`, run a
> controlled `04 2d 07` vs `04 2d 01` read **while scanning** and diff the payloads.
> If identical → keep `07` everywhere (simpler). If `01` tracks the live channel more
> faithfully → use `01` for refresh and reserve `07` for startup. Do not change blind.

---

## 6. Status pushes & the acknowledgement rule

The radio emits two categories of unsolicited frame after `COM CHECK END`:

| Category | Opcodes | ACK required? | Behavior |
|---|---|---|---|
| **Free-running** | `5a` (RSSI/squelch), `5b` (squelch open/close) | **NO** | best-effort telemetry stream |
| **Acknowledged** | `58 59 5c 5e 5f` (DMR talker/call/link state) | **YES** — `03 <op> 00 00` | radio re-sends until ACKed |

[CONFIRMED — head-bus doc §5/§7. The acknowledged set is the constant `ACK_PUSH_OPS`.]

- **Never ACK `5a`/`5b`.** ACKing them is wrong and unnecessary. [CONFIRMED]
- **Always ACK `58/59/5c/5e/5f`** immediately (§4.2). [CONFIRMED]

### 6.1 The "5e wedge" (must-not-regress failure mode)

If the head fails to ACK an acknowledged push, the radio **re-sends that same frame
forever and stops advancing the `5a`/`5b` stream** — the analog S-meter dies until a
full SPP reconnect. The fix is the §6 ACK rule. Any rewrite MUST preserve it.

**Quantified from a relay-dropout (DMR `wire.ndjson` seg112):** a head was driving a DMR
call, then **dropped out mid-call** (in relay the BT-01 owns ACKs; with it gone, nothing
ACKed). For the next ~3,639 s — with **zero head frames on the bus** — the radio re-sent
the un-ACKed `5e` **every ~500 ms** (7,268 back-to-back identical re-sends) while the
`5a` stream collapsed to **4 frames in 62 min (≈0/s)**. A head then reconnected
(`01`→`04…`→`64`) and it cleared. This is the radio's *persistence*, not a head ACK bug:
un-ACKed ⇒ 500 ms re-send **forever** ⇒ S-meter dead until a head returns and ACKs.
[CONFIRMED]

> **Mode note.** In **relay** this failure belongs to the connected BT-01 (or its
> dropout), not our backend — we intentionally do not ACK in relay (§12). The hazard is
> ours only in **control mode**, where our §6 ACK rule is the defense. seg112 is the
> radio-behavior oracle, not an indictment of our ACK path.

### 6.2 `5a` push decoding nuance [OBSERVED]

In `5a` pushes the first data byte is the **selected-side RSSI** (0 idle, ~2 rising,
~4 active), and RSSI **leads** the squelch flag: in the capture RSSI hit 4 one frame
*before* the squelch bitmask set and ~150 ms before the `5b 01`. Consumers that gate
audio/recording on `5b` are slightly late; gating on `5a` RSSI is earlier. (Decode
offsets: PROTOCOL.md reg `5a`.)

---

## 7. Retransmission & timeout contract

> **Status: timing now MEASURED** (DMR `wire.ndjson`, 2026-06-26). Constants below are
> grounded in data, not placeholders.

### 7.1 Radio behavior (measured)

- **Command response latency** (clean relay DMR, ~30 min, 2026-06-26 14:xx): reads
  `04→04` **p50 77 ms / p90 151 ms**; writes `→03` ACK **p50 141 ms / p90 238 ms / max
  281 ms**. The radio answers a *received* command in ~80–240 ms. [CONFIRMED]
- **The radio DROPS reads under load** (~3 %: 9 / 332 commands), clustered during DMR
  pushes. A dropped read produces **no single slow response** — instead the BT-01
  re-sends and the radio answers the *retransmit*. (The "max 1321 ms" in an earlier
  draft was first-request→retransmit-response, NOT one slow reply.) [CONFIRMED]
- **BT-01 command retransmit is BIMODAL** (whole-log: only 45 retransmits in 67 h, so
  modest evidence): a **fast <100 ms double** (~56 %) and a **~1 s timeout re-send**
  (~29 %, clustered **800–1100 ms**). The ~1 s timeout regime is the one that recovers
  dropped reads (39 / 45 retransmits are `04` reads); the radio answers the re-send in
  ~100 ms. Retransmit is a **normal, regularly-exercised mechanism**, not rare-loss
  insurance — but the exact timer is a band, not a hard constant like the 500 ms push.
  [CONFIRMED bimodal; ~1 s value on ~13 samples → tune from production counters (§0)]
- **The <100 ms "fast double" is NOT a retransmit timer — don't replicate it.** Broken
  down: **44 % are `04 51` clock-poll spam during DMR floods** (the radio is saturated
  with `5e` and drops the low-priority read, so the head re-fires it 0–1 ms apart, up to
  4× in a row, until the flood eases); ~40 % are startup `07` reads re-fired ~50–80 ms,
  racing the ~77 ms response; only ~3 are control commands — incl. a **PTT keydown**
  (`56 01 … 80 ff`, 47 ms) and **zone-select** (`08 39`) belt-and-suspenders double-fire
  of important user actions. So a single send + ~1 s timeout retransmit captures the
  needed behavior; the fast double is mostly wasteful. [CONFIRMED]
- **Push re-send interval**: an un-ACKed acknowledged push is re-sent every **~500 ms**
  — **rock-solid and universal**: whole-log scan = **7,376 samples, p50 500, p90 508,
  p99 527, 98.8 % in the 450–550 ms band**. Treat 500 ms as a hard constant. [CONFIRMED]
- **Steady-state ACK health** (clean relay): the genuine BT-01 ACKs every push family
  in **p50 58–110 ms / max 360 ms**, always inside the 500 ms window; only ~9 % of
  pushes see a single transient re-send before the ACK lands, and **zero wedge loops**.
  [CONFIRMED]
- The radio re-sends *until ACKed* (head-bus doc §6); §6.1 shows it never gives up.
  [CONFIRMED]

### 7.2 Implementation contract

`sendCommand` retries on timeout rather than failing on the first miss. **This mirrors
the BT-01, which retransmits because the radio drops ~3 % of reads under load (§7.1) —
retry is required for correct operation, not an optimization.**

- **per-attempt timeout ~1000 ms** — sits in the BT-01's measured ~1 s timeout band
  (800–1100 ms). The radio answers a received command in ≤240 ms, so ~1 s of silence
  means the request was dropped; re-send then. (Do **not** inflate this to "cover a
  1.3 s response" — no such single response exists; that figure was a
  request→retransmit-response artifact.) **Keep this env-configurable** — unlike the
  500 ms push timer it rests on ~13 samples, so confirm/tune from §0 production
  counters. We emulate only the ~1 s timeout regime, NOT the BT-01's <100 ms fast
  double (an unneeded bus-traffic quirk). [CONFIRMED band; default tunable]
- **up to 10 attempts** (~10 s worst case) then terminal failure. The BT-01 re-sends
  until answered; a finite-but-generous cap + surfaced error is our pragmatic deviation
  (10 favors riding out a transient drop/flood over giving up early). Most drops recover
  on the **first** retransmit (observed re-sends were single). [tune from §0 counters]
- retry only if the command is **retransmit-safe** (§8);
- a late response to attempt *N* arriving during attempt *N+1*'s window MUST resolve
  the command exactly once (dedup via splice-on-match, §13/E4).

### 7.3 Push-ACK latency budget

Because the radio re-sends every ~500 ms (§7.1), when **we** are the head our push-ACK
must reach the wire in under 500 ms, or we cause a redundant re-send. This is an easy
bar: the genuine BT-01 (our oracle, measured in the relay segment) ACKs pushes in
**p50 95 ms / p90 183 ms / max 348 ms — always inside the 500 ms window** with a plain
immediate ACK. [CONFIRMED]

**Contract:** an immediate, out-of-band push-ACK (§4.2) is sufficient; **no special
"express path" is required.** A push-ACK latency counter is still cheap insurance —
treat a sustained `>500 ms` ACK as a regression signal (§0) — but the data shows the
straightforward approach meets the deadline comfortably.

> *Correction note:* an earlier draft flagged a ">500 ms ACK stall." That was a
> measurement artifact (repeat-run gaps mis-attributed as latency) **and** was measuring
> the BT-01's ACKs in a relay log, not our code. Re-measured correctly, there is no
> stall. No action needed beyond the counter.

---

## 8. Idempotency / retransmit-safety classification

Retransmitting a command whose ACK was merely lost (radio already applied it) can
double-apply. Each command must declare whether retry is safe.

| Command | Retransmit-safe? | Reason | Grade |
|---|---|---|---|
| `04 <reg>` reads | **Yes** | pure reads, no side effect | CONFIRMED |
| `08 <sub> <val>` settings | **Yes** | absolute set; setting value twice == once | INFERRED |
| `2f <sub> <val>` channel settings | **Yes** | absolute set; persists to codeplug, idempotent | INFERRED |
| `08 39 <absolute zone>` | **Yes** | absolute target | CONFIRMED (absolute) |
| `04 2c/2d 01 55 <abs pos> <dir>` channel step | **Yes** | target is an absolute position | DOCUMENTED |
| `56 01` keydown PTT | **No (generic retry)** | handled by the dedicated `setPtt` path, not `sendCommand` retransmit | see note |
| `56 00` **unkey** PTT | **No (generic retry)** | a duplicate all-zero `56 00` can re-trigger the release-`5e` wedge — do NOT blind-retransmit; watchdog/safety-release covers it | see note |
| `57 3d` VFO/Mem mode | **Yes** | absolute mode select | DOCUMENTED |
| `2f 03` / `2f 04` freq set | **Yes** | absolute frequency | DOCUMENTED |
| Any *relative/toggle* op | **No** | a lost ACK + retry double-steps | INFERRED — default deny |

**Contract:** default a command to **retransmit-unsafe** unless explicitly classified
safe. Most of our vocabulary is absolute and therefore safe; the safety flag exists to
catch any future relative command. [PROPOSED]

> **PTT unkey — special-case [CONFIRMED from `wire.ndjson`, 67 h]:** across **49 unkeys
> there was ZERO timeout-retransmit** — every unkey was acked first try (p50 ~50 ms). The
> head instead protects the safety-critical release with **redundant dual-form sends** (a
> context-carrying `56 00 00 <side> 00 <id-tail>`/`…ff` form *and* a cleanup all-zero
> form, tens–hundreds of ms apart; radio acks the first, ignores the redundant second).
> The only `56` retransmits seen were keydowns (47 ms double; 1021 ms timeout).
> **Implication (implemented):** PTT is **excluded from the generic `sendCommand`
> retransmit** — blind-resending an all-zero `56 00` can itself re-trigger the
> release-`5e` wedge ([[dmr-ptt-wedge-keydown]]). Instead the dedicated `setPtt` path
> provides the unkey's reliability: a single **correct-form** send, a `sent`-flag
> safety-release (also correct-form) only if the write never drained, and the
> `ANYTONE_PTT_MAX_MS` **watchdog auto-release** as the final backstop. This is safer
> than blind retransmit for this one command. Mirroring the head's dual-form redundancy
> is an optional later tweak.

> Note: write confirmation has **two tiers** (verified live 2026-06-26 — the BT-01 does
> NOT read back its writes; it sends, takes the `03` ACK, and moves on; our backend does
> the same — `setRadioSetting`/`setChannelSetting` are "ACK → apply optimistically"):
> - **Acknowledged-only** — most `08` menu + `2f` channel-param writes (tone, power,
>   gains, NR, …). The `03 <op>` ACK is the *only* per-write confirmation; nobody reads
>   the value back. The radio applies valid writes on receipt, so the ACK is the success
>   proxy. Caveat: the ACK means "received/parsed," not provably "in effect" (the radio
>   ACKs even no-op `56` keycodes), so don't treat ACK as proof of *effect* for a command
>   whose effect you haven't independently established.
> - **Self-reported** — current channel/zone/freq (`04 2c/2d`, re-read on nav/refresh)
>   and signal/squelch (pushed). These have a real reported value to reconcile against,
>   but only *eventually* (next read), not a per-write verify.
> A dedicated post-write verify-read of the settings-block offsets would upgrade tier-1
> to true verification — the BT-01 doesn't do it; an optional "be better than the head"
> enhancement (extra bus traffic). [CONFIRMED]

---

## 9. Connection lifecycle

```
1. (optional) wake/keepalive   61                       -> (no response)
2. enter COM mode              01 "D578UV COM MODE" x2   -> 03 01 00 00 04
3. bulk enumeration            04 <reg> 07 00 00 00 ...  -> register blocks
4. finish handshake            64 "COM CHECK END"        -> 03 64 00 00 67
5. streaming                   (radio pushes 5a/5b + acked family; head refresh-reads with 01)
```

[CONFIRMED — capture + head-bus doc §3. The real BT-01 sends COM MODE twice; the
capture shows one (relay/log artifact).]

### Lifecycle hazards

- **Do NOT send `COM CHECK END` during runtime.** It belongs only at step 4. Sending
  it later has corrupted settings block `04 05` (a stuck "COM CHECK END" echo was
  stored into bytes 6–18 and persisted across reboot). [CONFIRMED — PROTOCOL.md]
- The enumeration order observed is a stable, deterministic sweep
  (identity → settings → APRS → tables → auth → roaming → status → zone → channel →
  DMR identity → scan list → END). Mirroring it on connect pre-warms all state in one
  pass. [OBSERVED]
- After the bulk read, the first live action in the capture was a `04 2d 01` re-read
  (mode `01`). [OBSERVED]

---

## 10. Mapping to the current implementation

File: `app/anytone-server.mjs` (the `AnyToneBackend` serial core).

| Contract element | Current code | Status |
|---|---|---|
| One command in flight | `enqueue()` promise chain on `this.busy` (`:1363`); `sendCommand` always called inside it | ✅ matches §4.1 |
| Push-ACK out of band | `dispatch()` writes `03 <op> 00 00` via direct `writeOnly`, bypassing the queue (`:1461`) | ✅ matches §4.2 |
| Never ACK `5a`/`5b` | `ACK_PUSH_OPS = {58,59,5c,5e,5f}` excludes them (`:126`) | ✅ matches §6 |
| Continuous framer (pushes never dropped mid-command) | `ingest()` keeps only the trailing partial in `rxBuffer` (`:1429`) | ✅ |
| Relay double-ACK suppression | `PUSH_ACK && !this.relayMode` guard (`:1461`) | ✅ matches §12 |
| Retransmit on timeout | **DONE** — `sendCommand` retries retransmit-safe commands up to `CMD_MAX_ATTEMPTS`, then rejects | ✅ §7 |
| Retransmit-safety flag | **DONE** — `retransmitSafe` option; default = reads (`0x04`) safe, else opt-in; absolute writes flagged at call sites | ✅ §8 |
| Health counters | **DONE** — `this.metrics` (cmd sent/ok/retransmit/fail, push-ack count + latency) at `GET /raw/metrics` | ✅ §0 |
| Push-ACK latency tracking | **DONE** — `dispatch()` times each push-ack write, counts breaches of `ACK_LATENCY_BUDGET_MS` (500 ms) | ✅ §7.3 |
| Per-attempt timeout | **DONE** — default `CMD_TIMEOUT_MS` 1000 ms (env-overridable) | ✅ §7 |
| Single outstanding slot | `this.pending` is still an **array**; dedup works via splice-on-match, retry tested. Kept as-is | ⚠️ optional cleanup (deferred — low value) |
| Read mode byte | **all reads use `07`** | ⚠️ OPEN — gated behind the §5 `07`/`01` test (Phase 4) |

**Assessment:** the concurrency model was already correct and is untouched. The
retransmit/safety/metrics gaps are now **closed**; the single-slot cleanup and the
read-mode test remain as low-priority follow-ups.

---

## 11. Target serial-core shape [IMPLEMENTED 2026-06-26]

Minimal, evidence-grounded changes — not a from-scratch rewrite. Items 1, 3, 4
(retry, safety flag, timeout) plus the §0 counters are **shipped**; item 2 (single
slot) and the read-mode test are deferred. Config knobs: `ANYTONE_CMD_RETRANSMIT`
(default on), `ANYTONE_CMD_TIMEOUT_MS` (1000), `ANYTONE_CMD_ATTEMPTS` (10),
`ANYTONE_ACK_BUDGET_MS` (500). PTT is intentionally **excluded** from the generic
retry (§8 unkey note — watchdog/safety-release covers it).

```
writer (enqueue)   serializes COMMANDS only; exactly one in flight   [keep as-is]
sendCommand(frame, { match, retransmitSafe=false, perAttemptMs=1000, attempts=3 })
   - register the single `outstanding` slot, then write
   - on match  -> resolve once (clear slot)
   - on timeout-> retransmitSafe && attemptsLeft ? rewrite + restart timer : reject
   - dedup: a frame matching an already-resolved/removed slot is treated as a push
ackPush(op)        immediate writeOnly(03 op 00 00); never queued; no slot  [keep]
dispatch           match outstanding first; 5a/5b -> state, no ack;
                   58/59/5c/5e/5f -> ackPush(op)                            [keep]
```

Concretely:
1. Add the retry loop + `retransmitSafe` to `sendCommand` (§7, §8).
2. Replace the `pending[]` array with a single `outstanding` slot (§4.1) — clarifies
   the invariant and makes dedup trivial.
3. Bump default per-attempt timeout 800 → ~1000 ms (§7).
4. **Gate** the read-mode change behind the §5 test before touching live reads.

Everything else (enqueue serializer, out-of-band push-ACK, the no-ACK `5a`/`5b` rule,
relay suppression, the continuous framer) is already conformant — **leave it**.

> **Timing is now measured (§7.1), not assumed.** Per-attempt ~1000 ms and the ~500 ms
> push-ACK deadline are data-backed; only the retry *count* (3) still wants field
> tuning via the §0 counters. Add a §7.3 push-ACK latency counter while here — the
> capture showed a real >500 ms ACK tail worth watching.

---

## 12. Relay-mode contract

When relaying a real BT-01 to the radio, the backend must be **transparent**:

- **Inject nothing.** The BT-01 is the sole operator. [CONFIRMED — `relayMode`]
- **Do not emit local push-ACKs.** The BT-01 sends its own; a second local ACK
  contaminates the wire trace and could confuse the radio. (`PUSH_ACK && !relayMode`.)
  [CONFIRMED]
- **Still apply decoded read responses to backend state**, even though they arrive
  unmatched (no command waiter), so the UI / audio-squelch follower tracks the head.
  The normal-mode `selectedSide`-flip guard is intentionally relaxed in relay because
  the head is the only operator. [CONFIRMED — `dispatch()` `:1484`]

Relay captures are the **canonical source** for refining this contract: they show the
genuine head's behavior with zero contamination from us.

---

## 13. Edge cases & failure modes (defend against these)

| # | Failure mode | Defense | Grade |
|---|---|---|---|
| E1 | **5e wedge** — un-ACKed acknowledged push freezes the stream | §6 ACK rule; never regress | DOCUMENTED |
| E2 | **Checksum-valid desync** (5a flaps, status looks fine) | track liveness (`lastValidFrameAt`), not just checksum; reconnect recovers | DOCUMENTED |
| E3 | **Lost-ACK double-apply** on retry | §8 retransmit-safety gating; default deny | INFERRED |
| E4 | **Late response after retransmit** | single-slot dedup; resolve once, extra frame → treated as push | PROPOSED |
| E5 | **Unsolicited push during a command** | continuous framer never clears mid-transaction; match-first then state-apply | CONFIRMED |
| E6 | **Unsolicited `04 05`/zone/channel flips `selectedSide`** | normal mode applies only live-status frames unmatched; full apply gated to matched/relay | CONFIRMED |
| E7 | **Partial frame across reads** | `rxBuffer` holds only the trailing remainder | CONFIRMED |
| E8 | **`COM CHECK END` echo corrupting `04 05`** | never send at runtime; field-level resilient decode (null squelch if out of range) | CONFIRMED |
| E9 | **Sending `+ADATA` over raw SPP** | `encodeOutbound` selects raw for the BT path | CONFIRMED |
| E10 | **Over-trusting ACK as proof of EFFECT** (radio ACKs even no-op `56` keycodes) | ACK confirms received/parsed; for settings it's a safe success proxy, but verify *effect* via read-back only where the radio self-reports (channel/freq/signal) | CONFIRMED |
| E11 | **Hammering low-priority reads during a push flood** (radio drops them → head spams 0 ms re-fires; observed: `04 51` clock spammed during DMR) | back off / defer non-critical refresh polls while `58/59/5c/5e/5f` are flooding; keep the bus clear for the 500 ms ACK lane | CONFIRMED (anti-pattern) |

---

## 14. Invariants checklist (what the serial core must always uphold)

1. At most **one command** outstanding at any time. (§4.1)
2. Push-ACKs for `58/59/5c/5e/5f` are sent **immediately and out of band**. (§4.2/§6)
3. `5a`/`5b` are **never** ACKed. (§6)
4. `COM CHECK END` is sent **once, at handshake**, never at runtime. (§9)
5. A frame is trusted only if checksum-OK **and** the link is live. (§3/E2)
6. Retransmission happens **only for retransmit-safe** commands, and resolves each
   command **exactly once**. (§7/§8/E4)
7. The continuous framer **never drops** an unsolicited push mid-transaction. (§13/E5/E7)
8. Relay mode injects nothing and emits no local ACKs. (§12)
9. Raw (un-ADATA) framing on the BT SPP path. (§3/E9)
10. Write confirmation = the `03` ACK for most settings (no read-back); only
    self-reported fields (channel/freq/signal) get eventual read-back reconciliation.
    Don't over-trust the ACK as proof of *effect*. (§8/E10)

---

## 15. Open data we still need

| Need | Unblocks | Status |
|---|---|---|
| ~~DMR-active capture (`5e`/`58` traffic)~~ | retransmit/timeout constants (§7), ACK latency, E1 | **SATISFIED** — `wire.ndjson` seg361 + seg112, 2026-06-26 (§6.1/§7) |
| `04 2d 07` vs `04 2d 01` diff **while scanning** | read-mode decision (§5) | OPEN — only `01` seen live; no side-by-side |
| Weak-vs-strong signal capture | `5a` RSSI → dB/S-unit calibration | only idle/active (0/4) seen |
| Menu-walk relay (open menu, change one value, save) | maps the ~30–50 still-unlabeled settings-block fields | startup only read settings; no writes observed |

---

*Cross-references: register/payload semantics → [`PROTOCOL.md`](PROTOCOL.md);
head-bus opcode catalogue & DMR decode → [`BT01_HEAD_BUS_PROTOCOL.md`](BT01_HEAD_BUS_PROTOCOL.md);
stack placement → [`ARCHITECTURE.md`](ARCHITECTURE.md).*
