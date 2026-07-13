# Command / Frame Reference

The catalogue of frame types. Framing rules live in [LINK_PROTOCOL](LINK_PROTOCOL.md); this is
the *data*: head bytes, lengths, and meanings. **Lengths are confirmed empirically** from
captures (the `length-by-type` table LINK_PROTOCOL §2 depends on).

> **Decode status: in progress.** Completing the remaining UNKNOWNs and the per-field offset
> maps is a pre-rewrite task — the rewrite implements against a *complete* reference. Field-level
> offsets are not duplicated here (they live in the harvested `docs/PROTOCOL.md`); this is the
> opcode/length/meaning index + the decode TODO.

## Frame format
`<head> <payload…> <checksum>` — checksum = additive sum of all prior bytes, mod 256. No length
field, no sequence number, no delimiter. (LINK_PROTOCOL §1.)

## Host → radio commands
| Head | Form | Meaning |
|---|---|---|
| `61` | `61` | wake / keepalive (no response) |
| `01` | `01` + "D578UV COM MODE" | enter COM mode (handshake) |
| `64` | `64` + "COM CHECK END" | finish handshake → start streaming |
| `04` | `04 <reg> <mode> 00 00 00` | register **read** (mode `07` startup / `01` live) |
| `08` | `08 <sub> <val> <tail>` | menu setting **write** (absolute) |
| `2f` | `2f <sub> <val|payload>` | channel-parameter **write** (absolute) |
| `57` | `57 <sub> …` | channel-record / mode / scan write |
| `56` | `56 <key> …` | PTT (keydown/unkey) + manual dial |

## Radio → host fixed-length frames (length by head byte)
| Head | Len | Class | Meaning |
|---|---|---|---|
| `03` | 5 | ack (R→H) | **inbound command-ACK** `03 <op> 00 <status> <ck>` — checksum-valid; status byte[3]=`00`=success (confirmed for `08`/`64`/`01`/`5a`) |
| `03` | 4 | ack (H→R) | **outbound push-ACK** `03 <op> 00 00` for required pushes `{5e,58,59,5c,5f}` — fixed 4 bytes, **NOT checksum-valid** (byte[3]=`00`, not the additive sum). Emit literal; do not checksum |
| `5a` | 16 | free push | RSSI / squelch per side (not acked) |
| `5b` | 3 | free push | squelch open/close (not acked) |
| `5e` | 18 | **acked push** | DMR call state. byte1 `01`=active/`00`=ending; byte2 `60`/`64`=active `20`/`24`=hang; dest=bytes 8-11 (group→TG, private→own ID), src=bytes 13-16 (caller) |
| `58` | 112 | **acked push** | talker info: caller ID bytes 6-9, alias ASCII (e.g. `PARROT`); tail target + a call-type bit (`0x80`, *provisional* — one sample) |
| `59` | 57 | **acked push** | call info: caller DMR ID @off24, alias @off28. byte55 = **per-call sequence counter** (observed 01-04), **NOT call-type** (earlier 01/02 reading was coincidental). **Call-type discriminator: TBD** — needs the DMR slice (likely `5e` dest==own-id ⇒ private) |
| `5c` | 12 | **acked push** | DMR call metadata — **emitted at call teardown** (`5c 07 …`) |
| `5f` | 5 | **acked push** | DMR call metadata — **emitted at call teardown** (`5f 34 …`) |

## `04 <reg>` read responses — confirmed lengths + meaning
Lengths verified across many samples (single fixed length unless noted).

| reg | len | meaning | grade |
|---|---|---|---|
| 02 | 33 | firmware/model string | CONFIRMED |
| 05 | 99 | **settings A (core)** — squelch A/B, selected side, dual-watch, zone#, many menu items | CONFIRMED |
| 06 | 99 | **settings B** — audio gains (+ a band/step table) | CONFIRMED (gains) |
| 07 | 39 | key/menu assignment map | partial |
| 09 | 141 | **settings C** — BT-01 gain, noise reduction RX/TX, fan, GPS, analog mic | CONFIRMED (listed fields) |
| 0a,0b | 131 | bitmap/list tables (0xff = unused) | confirmed-empty |
| 0c | 36 | table (zeros) | confirmed-empty |
| 0d | 123 | analog APRS config (callsign, path) | CONFIRMED |
| 0e | 87 | settings block | OPEN |
| 10 | 64 | APRS channel name | partial |
| 11 | 67 | table/flags | OPEN |
| 12 | 35 | config flag | OPEN |
| 13,14,15 | 17/35/35 | small settings/timers | OPEN |
| 16 | 103 | **serial/auth blob** — non-zero entropy in an FF field | **OPEN** (serial/key?) |
| 17,18,19,1a | 103 | tables (zeros) | confirmed-empty |
| 1b | 60 | settings block | OPEN |
| 1c | 119 | DMR vocoder version string | CONFIRMED |
| 1d | 18 | settings block | OPEN |
| 1e | 25 | level/timer pairs | OPEN |
| 1f | 109 | roam zone name + members | partial |
| 22,23 | 147 | roam channel records | partial |
| 24 | 35 | table (zeros) | confirmed-empty |
| 26 | 172 | **paged zone/group member list** (page in req byte 2; LE16 channel indices) | partial |
| 27 | 104 | zone channel-index list (paged, by zone) | CONFIRMED |
| 28 | 35 | zone config record | OPEN |
| 29,2a | 37 | zone name A/B (+ in-zone scroll pos) | CONFIRMED |
| 2b | 35 | zone-list browse by index (ASCII name) | CONFIRMED |
| 2c,2d | **72 / 118·121** | **channel block A/B** (freq, type/power/bw, tones, name, contact, radio id). **Variable**: 72 = compact form (pushed on main/sub switch), 118/121 = full record | CONFIRMED |
| 2e | 20 | channel-name-by-index (browse) | CONFIRMED |
| 30,31 | 35 | tables (zeros) | confirmed-empty |
| 32,33 | 35 | radio ID + callsign A/B | CONFIRMED |
| 34,35 | 35 | id-ish, identical both sides (`91 0c 41 24`) | **OPEN** |
| 37,38 | 103 | DMR TX contact A/B (name + BCD id) | partial |
| 45 | 81 | (seen rarely) | OPEN |
| 4a | 135 | **active-zone scan directory** (follows selected side) | CONFIRMED |
| 4b | **18 / 135** | scan-list directory browse (**18 = empty slot**, 135 = populated) | CONFIRMED |
| 4d | 29 | config/status | OPEN |
| 4e | 7 | tiny status word (`00 88 00 00`) | **OPEN** |
| 4f | 70 | WX/fixed channel? (`16 25 50` = 162.550 BCD) | HYPOTHESIS |
| 50 | 5 | tiny status (`02 02`) — read at audio-up | **OPEN** (volume?) |
| 51 | 12 | **clock (RTC)** — hh:mm:ss binary | CONFIRMED |
| 52 | 94 | GPS / position (ASCII; all-zero = no fix) | CONFIRMED |
| 59 | 59 | table (zeros) | confirmed-empty |
| 5a | 17 | RSSI/squelch snapshot (read form of the `5a` push) | CONFIRMED |
| 5b | 4 | squelch snapshot | CONFIRMED |
| 5e | 19 | link/DMR status snapshot | CONFIRMED |

## Browse/paged family (the §2 framing exception)
**Generated from the corpus (`redesign/data/frame-lengths.json`): three registers are variable** —
`04 4b` (18 empty-slot / 135 populated), `04 2c` (72 / 118), `04 2d` (72 / 121) — framed by
checksum + next-head (LINK_PROTOCOL §2). (`2c`/`2d` push a 72-byte compact channel record on a
main/sub switch and the full record otherwise.) The other browse reads are **fixed length** —
`04 2b`=35, `04 2e`=20, `04 27`=104 — because an empty record is a *same-length* frame of `ff`,
not a shorter one. **`04 39` (contact browse) was not in
the corpus** → length OPEN, needs a contact-list-browse capture. The empty/short `04 4b` response
is a **first-class valid frame**, not an error — do not design around avoiding it.

## Decode TODO

**Sequencing (review 2026-06-27): decode the critical path before/with the rewrite; finish the
non-critical OPENs in parallel.** The rewrite does not block on the nice-to-have unknowns.

### Critical — needed for the v1 live path (do before/with the rewrite)
1. ~~**Generate the canonical length table**~~ **DONE** → `redesign/data/frame-lengths.json`
   (via `redesign/tools/gen-frame-lengths.mjs`): fixed registers + 8 fixed push/ack heads + 3
   variable (`04 4b`/`04 2c`/`04 2d`); 0 bad-checksum across 30k frames. **Remaining gap: `04 39`
   length** (not in
   the corpus — capture a contact-list browse to fill it).
2. **ACK status codes** — map the `03 <op> 00 <status>` result byte per opcode (success/NAK); the
   command lifecycle's done-vs-failed depends on it (UI_PROTOCOL §3, LINK_PROTOCOL §7).
3. **Settings-block field offsets** — **substantially DONE** → `redesign/data/settings-offsets.json`
   (35 menu items across voice/display/other, harvested via menu-walk write/read diff). Confirms:
   `08 <sub> <val>` writes with a **constant 20-byte tail**, **literal-index value encoding**, ACK
   status byte[3]=`00`. Block 05 = core (most items), 06 = gains + font color, 09 = NR/VOX/colors/
   fan/mic. **Remaining gaps:** `power_save` is *not* in 05/06/09 (changed with no `08` write / no
   diff — lives elsewhere); `08 33` (channel color A?) ambiguous; `am_fm_radio` + first `vox_level`
   captures failed → re-walk those three. Band/step sub-tables in 06/09 still unmapped.

### Non-critical — decode in parallel / later (documented-unknown is fine for v1)
4. **OPEN registers** — `16` (auth/serial?), `34/35`, `4e`, `50`, `0e/11/12/13/14/15/1b/1d/1e`.
5. **`04 26` paging semantics** — what each page/bank means (page 0 == page 5 was observed).
6. **`04 4f`** — confirm WX-channel hypothesis.
