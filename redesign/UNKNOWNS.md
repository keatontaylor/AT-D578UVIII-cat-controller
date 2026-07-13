# Protocol Unknowns — inventory + live-BT-01 decode plan

Everything we send, receive, or ACK **without full end-to-end understanding**, ranked by what the
capture corpus says actually varies. Companion to [COMMAND_REFERENCE](COMMAND_REFERENCE.md)
(register-level status); this is the **byte-level** gap list inside the frames we already use,
plus the opaque constants we transmit.

**Empirical basis:** `tools/unknowns-census.py` — a per-offset distinct-value census over the
full capture corpus (~24k `5a` pushes, ~16k `5e`, ~2.7k `59`, …). An offset that never varies
across 30k frames is a constant or session-invariant codeplug state (low priority); an offset
that varies is a live decode target. Census run 2026-07-03; re-run after new captures.

---

## A. Frames we consume PARTIALLY (byte-level gaps)

### `5a` push (16B) / `04 5a` read (17B, = push + `04` prefix) — smeter/squelch
Known: b1/b2 selected/other RSSI (0-4), b5 open mask (bit1 selected, bit2 other, bit0 DMR slot).
| offset (push form) | census | status |
|---|---|---|
| **b7** | 7 distinct values | **PINNED (Sitting 1, 2026-07-03): radio-state bitfield flagging TRANSMIT.** `0x89` idle → `0x86`/`0x87` from ~500ms after `56 01` key until ~350ms after unkey; returns to `0x89`. Did NOT change across 17 side swaps, 8 zone steps, or channel selects — **the swap-readiness-gate hypothesis is NOT supported**. (The firmware-RE `status[8]&3==0` gate note needs re-examination: idle `0x89&3==1`, so the remembered condition/index can't be literal.) `86` vs `87` discriminator unknown (bit0). |
| b3 | 10 values | bit0 = TX overlay (`08`→`09` during PTT, Sitting 1); base value (June: `0a/0c/0e`) still unknown — channel-ish |
| b4 | 2 values (`00`/`40`) | **NOT the selected side** (Sitting 1 block 2: constant `40` across swaps of both sides while signal active; block-1 side-correlation was coincidental). Correlates with signal/AF activity in-session; still open |
| b12, b13 | 2 values each | b13=`01` whenever signal activity present (both sides' pushes, Sitting 1); b12 unknown |
| b6 (`ff`), b8-b11, b14 | constant | ignore for now |
| **swap behavior** | — | **MEASURED (Sitting 1, 17 swaps): the radio SUSPENDS 5a pushes for ~900ms after an `08 19` ack and resumes ALREADY in the new frame of reference — it never emits reference-ambiguous pushes.** `04 5a` READS inside ~1s remain stale (old reference at +500ms, correct by +2s; reconfirmed). The v2 1000ms hold is validated-generous; the only poisonous frames are reads, which v2 no longer sends. |
| — | — | **RESOLVED (census 2026-07-03): head `0x5a` is bidirectionally overloaded.** The `5a 0d`/`5a 07`/`5a 09`/`5a 00` sightings are 5-byte **HOST→radio commands** (`5a <sub> <v1> <v2> <v3>`, ~900 in corpus, radio acks `03 5a 00 00`) the BT-01 sends — the settings-walk "menu-nav" frames. Our inbound path never sees them (they're outbound), so the smeter decoder is safe — but the command family itself is UNDECODED (see plan P1.3). |

### `04 5e` read (19B) / `5e` push (18B) — DMR/link status (**reducer ignores entirely — F2.2 gap**)
Known (partial): b1 active/ending, b2 `60/64` active `20/24` hang, CC=b7, slot=b12, dest b8-11,
src b13-16. Census: 15 of 16 payload bytes vary — nearly everything here is live signal we drop.
Unknowns: b3-b6 (b3: 8-10 values!), b17; and the exact b7/b12 bit layouts.

### `58` push (112B) — talker info (**ACK-only today**)
Known: caller ID b6-9, alias ASCII. Varying-but-unknown regions: b1-5, b10-20 (ID/flags),
b88-99 (second alias/target region), b105-110 (tail target + provisional `0x80` call-type bit —
one sample only). 72 constant bytes.

### `59` push (57B) — call info (**ACK-only today**)
Known: caller ID @24, alias @28, b55 per-call sequence counter. Unknown varying: b2-18 (a full
first region — 17 bytes), b34-38. **Call-type discriminator still TBD** (group vs private vs
all — the blocker for proper DMR badges).

### `5c` (12B) / `5f` (5B) — call-teardown metadata (**ACK-only**)
`5c`: only b1 (4 values), b3, b10 vary. `5f`: **zero varying bytes** in 53 samples — it is a
constant marker frame; document and stop wondering.

### `04 2c/2d` — channel block (72/118/121B)
Decoded: freq, offset+dir, type/power/bw, tones, sq/optsig/busylock, compander, scrambler,
CC/slot/dmrMode/APRS/SMS/dataAck/txInterrupt, name, position, contact.
Unknown **varying** offsets: b18-21 (near tones — 5-tone/2-tone/DTMF ids?), b22 (11 values on
2d!), b29-33, b36, b53, b55-59, b61-62, b64-70, b74+ overlap contact region on 2c,
b98-106 (2 values each), b118-119 (2d full form). **b73 (Sitting 1): strong
global-channel-index hypothesis** — unique per channel across two zones (37-94 observed, b70=0
as high byte?); verify against `04 2e` browse indices. Also: **VFO-vs-memory is still inferred
from the channel NAME pattern** — no flag byte pinned.

### `04 29/2a` — zone block (37B)
Known: name @2-17, zone index @34, **b35 = current/last in-zone channel POSITION** (restored on
zone entry). NOTE (corrected 2026-07-05): b35 is NOT the channel count — an earlier "count − 1"
reading was a coincidence of sampling on the last channel, and shipping it capped channel stepping
(regression, reverted). Corpus check: b35 takes every value 0-14 within FAVORITES alone.

### `04 27` — zone channel-member list (→ CHANNEL COUNT) ✅
`04 27 <zoneIndex> <page> 00 00` → LE16 global channel indices from byte 3, 0xffff-terminated.
Reads ANY zone by index without navigating. **The channel count = number of members before the
terminator** — live-verified 2026-07-05: FAVORITES(0)=15, HOTSPOT(1)=7, zone2=19, zone3=3, … .
IMPLEMENTED: read on connect + each zone change, stored as `side.channelCount`, drives
`stepChannel` host-side wrap. (The individual index values → channel picker, later.)

### `04 05/06/09` — settings blocks
Mapped: 21 + 1 + 12 offsets (`data/settings-offsets.json`) + selected side @37 (05).
- **05** (99B): unmapped-but-varying: 4, 7-9, 11, 15-28 (b25/26: 7 values each), 30, 32-33,
  35-36, 41, 46, 48, 50-64, 66-97. Much of this is menu state we never walked.
- **06** (99B): only 8 offsets vary in the whole corpus: 80, 81, **84 (mapped)**, 90-94 — the
  band/step sub-table region. Small, finishable.
- **09** (141B): unmapped-but-varying: 37, 45-46, 55-61, 65-72 (**b72: 14 values**), 74, 88-95,
  98-128 region (2 values each). Known missing: **DigiMon read-back offset**, `power_save`
  (proven NOT in 05/06/09 — lives elsewhere), `08 33` ambiguity, `am_fm_radio`/`vox_level`
  re-walk.

### `04 51` — clock (12B)
Decoded: h/m/s @2-4. Census: b6-9 vary — `e7 07 <m> <d>` = **LE16 year + month + day (near
certain)**, b9 = 14 values (day). Trivial to confirm and decode; gives us the full RTC date.

### `04 1b` — zone count (60B)
Decoded: b36 = zone count. Unknown varying: **b47 (3 values), b50 (5 values)** — the only other
live bytes in the block; unknown meaning.

### `04 4a` — active-zone descriptor (135B)
Partially understood (2026-07-02 analysis): current zone name @17-32, LE16 member channel
indices after; prefix words @8-15 (`14 00 1e 00 1f 00 1f 00`) unknown. Useful later for the
channel picker.

### `04 4d` (29B) / `04 4e` (7B) — startup-enumerated, reducer ignores
**Zero varying bytes across the corpus.** Constants. Either drop from enumeration or leave and
stop caring. (COMMAND_REFERENCE keeps them OPEN; census says inert.)

## B. Commands we SEND with opaque bytes

| frame | opaque part | notes / risk |
|---|---|---|
| `08 <op> <val>` | **20-byte WRITE_TAIL** | Constant across all captures. Read as LE32 it is pointer-like: `0x20001f88` (Cortex-M SRAM), `0x08000271 / 0x08000651 / 0x08000445 / 0x0800064d` (flash, bootloader region) — plausibly a debug/context blob the OEM head sends. Firmware cross-ref could confirm; harmless but cargo-culted. |
| `57 3d <val>` | ~140-byte VFO_MEMORY_MODE_TAIL | Same `88 1f 00 20 …` prefix + repeated `8b 02 00 08` words — same pointer-list pattern. |
| `2f 03` RX freq | ~~16-byte tail~~ | **RESOLVED (Sitting 2, 2026-07-03): NOT a constant — it is a byte-exact ECHO of the working channel's record.** The frame is `2f 03 00 <new BCD4>` + the live `04 2c/2d` block's bytes [6:22] (TX freq, byte-10 type/power/bw flags, tone region). FIXED: `rxFrequencyWrite(hz, contextBlock)` now splices into the cached raw record; the old hardcoded tail would have corrupted TX freq + type/power/bandwidth on every RX edit of any channel but the June one. |
| `2f 04` TX freq | 16-byte TX_FREQ_TAIL | Sitting 2: the tail matched our constant across 2 writes (451/452 MHz) — but both were the SAME channel (446 base), so constant-vs-context is still not distinguished. Unlike RX, the tail is NOT block-shaped (BE32 + `05 05 05 05 9f 80 03 08`), so it may genuinely be a fixed template. Capture TX writes on ≥2 different channels to confirm. |
| `2f 02/16` tones | template tail `05×4 06×4 07×4`; b7=`02` only for Off | DCS inverted (type 3) + codes > 0o377 still hypothesis — needs D023I / D777N captures. |
| `56` PTT | bytes 3+ | **Sitting 1 (analog): the head sends `56 <key> 00 00 <all zeros>`** — b3=0, everything zero. The June `80 ff` bytes were DMR-channel context, and our b3=`01` is a third variant (works live, provenance unknown). So b3 ∈ {00 head-analog, 01 ours}; pin whether b3 matters at all. Head also DOUBLE-SENDS the first key frame (~25ms apart) — its own retransmit quirk, worth knowing when counting acks. DMR extended tail still to validate on-air. |
| `04 2c/2d 01 55 <target> <dir>` | the `01 55` marker + dir byte | Works; semantics of `01`/`55` unproven; `0xf9` wrap sentinel known empirically only. |
| `04 <reg> <mode>` reads | the **mode byte** (`07` startup, `01` live, `00`, `09` seen from BT-01) | What mode actually changes in the reply is unknown — we treat replies identically. |
| `08 4a <val>` | never sent by us | BT-01-observed op (probable **volume knob**, monotonic 05-0f steps). Unconfirmed. |

## C. ACK semantics
`03 <op> 00 <status>` — only `status=00` (success) is mapped. **No NAK/status-code table exists.**
We currently treat timeout as the only failure mode; a non-zero status would be silently
"resolved". Passively collect: log any inbound `03` with b3 ≠ 0 (none in corpus so far).

## D. Registers the BT-01 reads at startup that we don't
From the relay startup sweep: `07 0a 0b 0c 0d 0e 10-1f 22 23 24 26 28 30 31 33 34 35 37 38 4a
4f 52 59`. Per COMMAND_REFERENCE most are decoded-empty/partial; live-interesting ones: `37/38`
(DMR TX contact per side), `52` (GPS), `0d` (APRS), `16` (auth/serial blob), `4f` (WX?).

---

## Decode plan — live BT-01 experiments (relay mode, one variable at a time)

**Method:** relay mode gives an uncontaminated bus. For each experiment: start a labelled relay
capture, perform ONE stimulus repeatedly (≥5×), stop, then diff with the census tool (run it on
just that capture dir). Annotate the capture filename with the stimulus.

### P1 — live-path correctness (do first)
1. ~~**`5a` b7 / read b8 — the readiness field.**~~ **EXECUTED (Sitting 1, 2026-07-03).**
   Outcome: b7 = TX-state bitfield (pinned above), NOT a swap-commit barrier — b7 never moved
   across 17 swaps. Bonus findings: the radio suspends pushes ~900ms post-swap and resumes in
   the new reference (settle window validated); `04 29/2a` b35 = current channel position (NOT
   count — corrected 2026-07-05; the real count is the 04 27 member list);
   `0xf9` wrap confirmed radio-side; head analog PTT = `56 01 00 00…`; head double-sends key
   frames. Remaining from this thread: the `86` vs `87` bit, b3 base value, b4/b12 meaning, and
   re-examining the firmware `status[8]&3` note against the pinned b7 values.
2. **Freq-write tail invariance.** Have the BT-01 (or radio keypad + relay watch) set several
   RX/TX frequencies on different bands/channels; diff the `2f 03`/`2f 04` tails. Confirms or
   falsifies our constant-tail assumption before freq-edit sees heavy use.
3. **The `5a <sub>` HOST-command family** (5-byte, subs `00/07/09/0d` observed, acked `03 5a`).
   The BT-01 sends these around menu navigation (`0d` dominates, ~900 samples). Correlate sub +
   operands against BT-01 UI actions in the labelled relay captures; the settings-walk notes
   already tie `5a 0d` to menu entry/exit. Decoding it may unlock menu-driven ops (and explains
   an entire command head we currently never send).
4. **ACK status codes.** Add a permanent log hook for `03 <op> 00 <status≠0>`; optionally
   provoke one safely (e.g. re-send a valid setting write while the radio is in a menu).
5. ~~**`04 29` b35.**~~ RESOLVED 2026-07-05: b35 = current in-zone position; channel COUNT comes
   from the 04 27 member list (implemented).

### Scan family — MAPPED (Sitting 2, 2026-07-03), ready to build
Full flow captured against the live radio:
- **`57 48 01` + menu tail** = scan START; **`57 48 00`** = scan STOP. Both acked `03 57 48 00`.
- **`2f 2b <listIndex>` + menu tail** = SELECT scan list (acked `03 2f`); only needed to change
  list, not to start on the current one.
- **`04 4b <index> 02 03 00`** = read scan-list directory entry: 135B populated / 18B empty slot;
  list name ASCII @~13. Corpus map here: 0=SHORT FAVORITES, 1=FIRE, 2=POLICE, 3=(empty), 4=GMRS,
  5=FRONT RANGE GMRS, 6=RMHAM DMR, 7=FAVORITES.
- **`04 4a 01 00 00 00`** = active-zone/scan descriptor (read after select/start to reflect state).
Lock-follow (which channel the scan stopped on) still needs decoding from the 5a/5b + channel-
block stream during a lock — present in this capture (COLCON locks at 16:18/16:20), analyze next.

### P2 — next roadmap features (DMR + scan)
6. **`5e`/`58`/`59` call-type discriminator + full layouts.** Scripted DMR session: hotspot
   PARROT private call, a group call, an all-call; capture each separately. Diff b-regions
   listed above; the `5e` dest==own-ID heuristic is the leading hypothesis.
7. **Scan family.** BT-01-driven scan start/lock/stop with relay: pins `57 48` variants, `2f 2b`
   ctx tail, and `04 4a/4b` field meanings on live data.
8. **`04 26/27` paging semantics** (picker prerequisite): page through a >48-channel zone.

### P3 — completeness (background)
9. **Settings menu-walk v2** for the unmapped-but-varying offsets in 05/09 and the 06 band/step
   region: BT-01-driven menu walk over relay, diffing block reads after each change (same
   harvest method as v1). Also re-walk `am_fm_radio`, `vox_level`, `08 33`; hunt `power_save`
   outside 05/06/09 (wider read sweep after toggling).
10. **`04 51` date bytes** — set the radio clock/date, re-read, confirm LE16-year/month/day.
11. **`04 1b` b47/b50** — observe across zone-count changes and scan states.
12. **PTT b3/b4/b5** — compare our frame vs BT-01's on analog + DMR; test whether `00 01` vs
    `00 00 80 ff` changes radio behavior (relay first, then careful live A/B).
13. **`04 39` contact browse length** — capture a contact-list browse (still absent from corpus).

### Tooling to build (small)
- `tools/unknowns-census.py` — DONE (this document's data source).
- **Event-correlated diff**: extend the census to take a `--around "08 19"` filter that windows
  frames ±N seconds around a command head and reports per-offset value *transitions* — turns
  "what changed when I did X" into one command. (~50 lines on top of the census.)
