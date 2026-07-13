# Capture Plan — resolving UNKNOWNS.md with live BT-01 data

Executable bench protocol. Each **sitting** is one session at the radio; each **experiment** is
one labelled capture with ONE stimulus repeated ≥5×. Companion to [UNKNOWNS](UNKNOWNS.md) (what
we're resolving) and `tools/unknowns-census.py` (how we diff).

## Ground rules
- **Relay mode** for anything BT-01-originated (uncontaminated bus). Host-driven reads use the
  v2 app or a raw-read tool — reads only, never probe writes blind.
- **One variable per capture.** Repeat the stimulus ≥5×, ~5s apart, with a 10s idle head/tail.
- **Naming:** `captures/exp-<sitting><letter>-<slug>-YYYYMMDD.ndjson` (e.g.
  `exp-1b-side-swaps-20260705.ndjson`).
- **Annotation:** keep a sidecar `…-notes.md` with a wall-clock timestamp per action
  ("14:02:31 swap A→B"). Correlation is worthless without it.
- After every sitting: run the census on that capture alone + `--around` the relevant command;
  update UNKNOWNS/COMMAND_REFERENCE; add decode tests for anything pinned.

## Prep (no radio needed, ~half a day)
- **P0.1 `--around` mode** for the census: window frames ±N s around a command head (`--around
  "08 19"`) and report per-offset value TRANSITIONS. (~50 lines; the workhorse for sittings 1-4.)
- **P0.2 ACK-status logger** (tiny session hook): log any inbound `03 <op> 00 <status≠0>` —
  passive collection for the NAK table (UNKNOWNS §C). Leave it on forever.
- **P0.3 `tools/sweep-diff`**: read EVERY register in `frame-lengths.json` via the v2 session,
  wait for one manual change, read again, print byte-level diffs. Converts most P3 settings
  archaeology into 5-minute bench ops with no BT-01 involved.

## Sitting 1 — readiness field + navigation ops (UNKNOWNS P1.1, P1.5; 5a b3/b4; PTT bytes)
Setup: BT-01 in relay; an analog channel with a receivable signal available (second HT or local
repeater) so RSSI is nonzero part of the time.

| exp | stimulus (BT-01) | resolves |
|---|---|---|
| 1a | nothing — 3 min idle, signal present part of the time | baseline byte drift; 5a b12/b13 vs squelch |
| 1b | side swap ×10 | **5a b7 (read b8) readiness bits around `08 19`** — the settle-window replacement; also confirms the 5a reference-flip latency distribution |
| 1c | zone up/down ×10 | b7 around `08 39`; `04 29` b35 behavior on zone change |
| 1d | channel up/down ×10 within one zone | **`04 29` b35 = in-zone position?**; channel-block b70/b73 (per-channel id?); 5a b3 |
| 1e | PTT key 2s / unkey ×5 on analog | b7 during TX; **BT-01's `56` frame bytes 3-5** (`00 80 ff` vs our `00 01`) on analog |

Analysis: `census --around "08 19" / "08 39" / "56"`. Success = b7's low bits provably bracket
command-settle windows → replace `SIDE_SETTLE_MS` with the real barrier.

## Sitting 2 — frequency-write tails + VFO flag (P1.2; VFO-vs-MEM byte)
Setup: BT-01 in relay, radio in VFO mode.

| exp | stimulus | resolves |
|---|---|---|
| 2a | BT-01 direct-entry RX freq: 146.520, 147.330, 446.000, 462.5625 — ×2 each | **`2f 03` tail invariance** across bands (falsifies session-context risk) |
| 2b | set repeater offset/dir + TX-relevant changes on the same VFOs | **`2f 04` tail invariance** |
| 2c | VFO↔MEM toggle ×6, capturing the channel block each time | **the VFO-vs-memory flag byte** (diff `04 2c` beyond the name field) |

Fallback if the BT-01 lacks direct entry: drive `2f 03/04` from the v2 app across the same
freq set and verify ack + read-back per write (validation instead of capture-diff).

## Sitting 3 — DMR call decode (P2.6: 5e/58/59 layouts + call-type discriminator)
Setup: BT-01 in relay; hotspot with PARROT + a live talkgroup. Capture each call class
SEPARATELY, including hang time + teardown (`5c`/`5f`).

| exp | stimulus | resolves |
|---|---|---|
| 3a | private call to PARROT ×3 (TX + the echo RX) | 5e dest==own-id hypothesis; 58/59 private-call shape |
| 3b | group call on the selected TG ×3 | group-call shape → **the call-type discriminator by diff vs 3a** |
| 3c | incoming call on a NON-selected TG ×3 | the live-TG-badge fields (which bytes carry the foreign TG) |
| 3d | same call class, codeplug CC changed 1→5, slot 1→2 | pins CC/slot bit positions in `5e` b7/b12 |

Analysis: region diffs on 5e b2-6/b17, 58 b1-5/b10-20/b88-110, 59 b2-18/b34-38. Success =
enough of F2.2 to build the DMR caller/TG badges.

## Sitting 4 — scan + zone directory + paging (P2.7, P2.8; `04 4a` prefix words)
Setup: BT-01 in relay; a scan list with an active channel (trigger with the second HT).

| exp | stimulus | resolves |
|---|---|---|
| 4a | scan start → let it cycle 30s → force a lock → stop; ×3 | `57 48` start/stop variants, `2f 2b` ctx tail, scan-state fields in 5a/5e |
| 4b | open the BT-01 zone/channel list on a >48-channel zone; scroll ALL pages | `04 26`/`04 27` paging semantics |
| 4c | switch across 3 zones with known different member counts | **`04 4a` prefix words** (candidate: list-length/count fields) — compare against the known counts |

## Sitting 5 — sweep-diff archaeology (P3; no BT-01 needed, uses P0.3)
Each row: full register sweep → one manual change on the radio → sweep → diff.

| exp | change | resolves |
|---|---|---|
| 5a | toggle **power_save** | the block it actually lives in (proven NOT 05/06/09) |
| 5b | toggle **DigiMon** off/single/dual | the missing DigiMon read-back offset |
| 5c | set clock **date** forward one day, then one month | `04 51` b6-9 = year/month/day confirmation |
| 5d | add then remove a zone (keypad/CPS) | `04 1b` b36 tracking + what b47/b50 do |
| 5e | walk the remaining unmapped menus (06 band/step region, 05/09 gaps), one item per sweep | settings-offsets.json completion; re-walk `am_fm_radio`, `vox_level`, `08 33` |
| 5f | change VOL knob on radio ± | whether volume appears in any block (`04 50`? `08 4a` correlate) |

## Sitting 6 — the `5a <sub>` host-command family (P1.3) + odds and ends
| exp | stimulus (BT-01, relay) | resolves |
|---|---|---|
| 6a | enter/exit the BT-01 menu ×5; navigate item-to-item slowly | `5a 0d` (and 00/07/09) sub + operand semantics vs UI actions |
| 6b | volume knob sweep on the BT-01 | confirm `08 4a` = volume; its range/ack |
| 6c | open the BT-01 contact list (if it has one) | **`04 39` length** — the last frame-table hole |

## Standing/passive
- ACK-status logger (P0.2) stays on across all sittings and normal use.
- Archive every capture; re-run the full census after each sitting (new variance = new leads).
- Any framing incident during a sitting: keep the capture, note the timestamp — those bytes are
  RE input too.

## Done criteria per unknown
An unknown is CLOSED when: (1) the offset/enum is documented in COMMAND_REFERENCE (+
settings-offsets.json if a setting), (2) a decode test pins it against real capture bytes, and
(3) UNKNOWNS.md drops the row. Priority order of value: 1b (readiness) > 3a-d (DMR) > 2a-b
(freq tails) > everything else.
