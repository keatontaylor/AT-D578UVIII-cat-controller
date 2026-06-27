# AnyTone AT-D578UV ⇄ BT-01 Head-Bus Protocol (over Bluetooth SPP)

This documents the serial "head-bus" protocol spoken between the AnyTone **BT-01**
remote-control head and the **D578UV** radio body, as reverse-engineered by sitting
a Raspberry Pi between a real BT-01 and a real radio and relaying/logging the SPP
(RFCOMM) traffic, plus by impersonating the radio to a real BT-01.

> IDs / callsigns in examples are **generic placeholders** (e.g. DMR ID `3101234`,
> alias `CALLSGN`, TG `9990`). Real personal values live only in gitignored
> `captures/`.

> For the **link-layer transaction discipline** (one-command-in-flight, the ACK
> exception, retransmission, read modes, edge cases, and the serial-core contract),
> see [`RADIO_LINK_CONTRACT.md`](RADIO_LINK_CONTRACT.md). This doc is the opcode/push
> catalogue; that one is the rules for *how* to exchange these frames safely.

## 1. Transport

- The radio and the BT-01 each expose a `BRCM SPP SERVER` on **RFCOMM channel 2**.
- For the control channel the **radio is the SPP client that dials the BT-01's
  SPP server** (the BT-01 is the server and, once connected, *pushes* the protocol).
- HFP (Hands-Free) provides the audio path: the BT-01 is the HF unit, the radio is
  the Audio Gateway. The head will not go fully operational without an HFP link, but
  the SPP **control** path works independently of audio.
- Frames are **raw** over the air. (Through a BT-01's internal MCU↔module UART they
  appear wrapped as `+ADATA:00,<len>\r\n<payload>\r\n`, but that envelope is stripped
  before the air interface — never send it over a direct SPP link.)

## 2. Frame format & checksum

- A frame is `<opcode> <payload…> <checksum>`.
- **Checksum** = 8-bit additive sum of all preceding bytes, mod 256 (the last byte).
- Read requests are `04 <reg> <mode> 00 00 00` (mode `07` = normal read).
- Multi-byte numeric fields (DMR IDs, talkgroups) in **status pushes** are **BCD**
  (e.g. ID `3101234` → `03 10 12 34`). The manual-dial *target* ID in the PTT frame
  is the exception — it is **24-bit binary big-endian** (see §6).

## 3. Connection lifecycle

| Step | Head → radio | Radio → head |
|---|---|---|
| Wake / keepalive | `61` | *(no response)* |
| Enter COM mode | `01` + `"D578UV COM MODE"` (×2) | `03 01 00 00 04` |
| Register reads | `04 <reg> 07 00 00 00` | register block (see §4) |
| Finish handshake | `64` + `"COM CHECK END"` | `03 64 00 00 67` |

After `COM CHECK END` the radio enters streaming mode and pushes status frames (§5).

**ACK rule (critical):** every radio *status push* in the family **`58 59 5c 5e 5f`**
must be acknowledged by the head with a 4-byte **`03 <op> 00 00`** (no checksum byte).
The free-running **`5a` (RSSI)** and **`5b` (squelch)** pushes are **not** ACKed.
Failing to ACK `5e`/`58`/… makes the radio re-send the same frame forever and stop
streaming `5a`/`5b` — the historical "5e wedge". See §7.

## 4. Read registers (`04 <reg>`)

Reads return `04 <reg> <data…> <cksum>`. Notable registers:

| Reg | Contents |
|---|---|
| `02` | Firmware string |
| `05` | Settings block. byte11/12 = A/B squelch; byte25 = selected-side zone#; **byte37 = selected side (00=A,01=B)**; byte38 = dual-watch |
| `29` / `2a` | Zone A / Zone B name (16-byte ASCII name field at offset 2) |
| `2c` / `2d` | Current channel A / B block (freq BCD bytes 2–5, 16-byte name field, position byte ~71) |
| `2b` | **Zone-list browse by index**: `04 2b <1-based index> <ctx> 02 00` -> 32-byte zone-name block (used when entering Menu -> Zones); `<ctx>` observed as `00` during initial list draw and `05` while browsing from zone 5 |
| `2e` | **Channel-name browse/list**: `04 2e 00 <entry> 04 00` -> 16-byte channel-name block while browsing a zone's channels |
| `39` | **Talkgroup/contact-list browse**: `04 39 00 00 00 <0-based index>` -> 103-byte contact record; layout partial |
| `4a` | Favorites/scan list (contains channel indices + list name) |
| `51` | Clock |
| `5a` | Per-side RSSI/squelch snapshot |
| `5e` | Global squelch / link state |
| `52` | GPS / position |

## 5. Radio → head status pushes

| Push | ACK? | Meaning |
|---|---|---|
| `5a …` (16B) | no | RSSI/signal, per side (free stream) |
| `5b 00/01` | no | Squelch closed / open |
| **`5e`** | **yes** | **Link state** — byte1: `00` idle / `01` RX active / `02` TX active. **Source ID at bytes 8–11 (4-byte BCD)**, **dest ID/TG at bytes 13–16 (4-byte BCD)**. Private call → caller/called IDs; group call → both fields carry the TG. |
| **`58`** (112B) | **yes** | **Talker info** — byte1 `00`=RX talker / `81`=TX talker; other-party DMR ID (4-byte BCD) at bytes 6–9; **talker alias ASCII from byte 10** (e.g. `CALLSGN`). |
| **`59`** (57B) | **yes** | **Call info** — **TG at bytes 2–5 (4-byte BCD)**; **caller DMR ID at bytes 24–27 (4-byte BCD)**; byte55 = per-call sequence counter. |
| **`5c`** (12B) | **yes** | DMR call metadata (call start/end summary) |
| **`5f`** (5B) | **yes** | DMR call metadata |

### DMR caller-ID / TG (for UI display)
All numeric fields are **4-byte BCD** (up to 8 digits; confirmed by a 6-digit
private-call ID `00 31 09 97` = 310997 in the `5e` dest field).
- **Group call** → from `59`: **TG** = bytes 2–5 (`00 00 00 91` = 91), **caller DMR ID**
  = bytes 24–27 (`03 10 12 34` = 3101234).
- **Private call** → from `5e`: **source ID** = bytes 8–11, **called ID** = bytes 13–16.
- **Talker alias / callsign**: `58` ASCII from byte 10 (other-party ID at bytes 6–9).
- **RX/TX/idle state**: `5e` byte 1.

## 6. Head → radio commands

All `08`/`2f` write-family frames share a fixed tail
`88 1f 00 20 71 02 00 08 51 06 00 08 45 04 00 08 4d 06 00 08`.
Every command must be ACKed by the radio; the head re-sends until it is. The radio
ACKs with `03 <op> 00 00 <cksum>` (5-byte, e.g. `03 08 00 00 0b`, `03 56 00 00 59`).

### Navigation
| Action | Frame |
|---|---|
| Channel up/down (in-zone) | `04 2c 01 55 <target_pos> <dir>` (parametrized **read**; `01`=step mode, `55`=marker, dir `01`=up/`00`=down; target = current pos±1 from channel-block byte 71; side B = `04 2d`) |
| Zone up/down | `08 39 <absolute_zone_index>` (head computes current±1 from settings byte 25) |

### Front-panel controls (`08` / `2f` families)
| Control | Frame |
|---|---|
| Side toggle A/B | `08 19 00/01` (head then reads `04 5a`/`04 5e` for the new side) |
| Idle keepalive | `08 4b 00/01` (byte3 = active side) |
| TX power L/M/H/T | `2f 18 00 / 01 / 02 / 03` |
| VFO tuning (set freq) | `2f 03 00 <4-byte BCD freq> …` (absolute; e.g. `14 76 40 00` = 147.6400) |

### Audio gain settings (`08` family)

Confirmed via live BT-01 relay capture on 2026-06-19. All use the same fixed
20-byte `08` write-family tail shown above. Frame shape:
`08 <subcmd> <display_gain - 1> <tail>`. Display gain `1` encodes as `00`;
display gain `5` encodes as `04`. No backend/UI writer is implemented yet.

| Setting | Frame | Evidence |
|---|---|---|
| Radio Mic Gain | `08 47 <gain-1>` | set to 5 captured as `08 47 04 ...` |
| Radio Speaker Gain | `08 48 <gain-1>` | set to 1 captured as `08 48 00 ...` |
| BT-01 Speaker Gain | `08 49 <gain-1>` | set to 5 captured as `08 49 04 ...` |

### Other confirmed menu setting writes (`08` family)

These also use the fixed 20-byte `08` write-family tail. No backend/UI writers
are implemented yet.

| Setting | Frame | Evidence |
|---|---|---|
| DigiMon | `08 3f 00/01/02` | Off = `00`, Single Slot = `01`, Double Slot = `02` |
| Noise Reduction Receive | `08 6b <value>` | set to 3 captured as `08 6b 03 ...`; only value `03` confirmed so far |
| Noise Reduction Transmit | `08 6c <value>` | set to 3 captured as `08 6c 03 ...`; only value `03` confirmed so far |

### Keypad / menu (`5a <keycode> …`)
| Key | Frame |
|---|---|
| Menu / enter | `5a 0d <ctx> <lvl> <cursor>` |
| Exit | `5a 00 <ctx> <lvl> <cursor>` |

The head runs the menu UI **locally**; while scrolling it emits `5a` frames whose
trailing bytes track menu context/level/cursor, and only commits a real write
(`2f`/`57`) when a setting is saved.

### Channel parameter edits (`2f <sub>` = set channel parameter)
Each menu setting commits **one** `2f` write:

| Sub | Parameter |
|---|---|
| `01` | Channel mode (`00` analog / `01` digital / `02` A+D TX A) |
| `02` | TX DCS/CTCSS tone (e.g. `2f 02 02 00 04` = DCS 004N) |
| `03` | Frequency (BCD) |
| `16` | RX DCS/CTCSS tone |
| `18` | TX power (`00`L/`01`M/`02`H/`03`T) |
| `1b` | Squelch mode (`00` = SQ) |
| `24` | Channel name (ASCII inline) |
| `04` | *(unidentified — RX-related)* |

### Channel record write (`57 <sub>`)
| Sub | Action |
|---|---|
| `20` | **Write/save a full channel record** (145-byte frame: `57 20 <slot_idx> <flag> <hdr> <~140-byte channel block>`). Used when creating a new channel — block embeds freq (BCD), settings, and name. |
| `3d` | VFO / Memory mode select (`01`/`00`) |
| `04` | (all-zeros frame — slot clear/init?) |

### PTT & manual dial (`56`)
23-byte frame `56 <key> <…>`:

| Byte | Field |
|---|---|
| 1 | key: `01` down (TX) / `00` up |
| 4 | call mode: `06` = manual dial · `80` = normal-channel PTT |
| 5 | call type: `01` = Group/TG · `00` = Private |
| 7–9 | destination DMR ID, **24-bit binary big-endian** (`31 2f 8c` = 3223436) |
| 10–22 | padding |

- Normal channel PTT: `56 01 00 00 80 ff 00 …` (uses the channel's contact).
- Manual dial to a group: `56 01 00 00 06 01 00 <id> …`; to a private call: `… 06 00 00 <id> …`.
- Radio ACKs PTT with `03 56 00 00 59`.

## 7. The "5e wedge" and its fix

DMR RX/TX makes the radio push `5e`/`58`/`59`/`5c`/`5f`. These are **acknowledged**
pushes: the radio re-sends the same frame until the head replies `03 <op> 00 00`,
and will not advance to streaming `5a`/`5b` without it. An implementation that does
not ACK them sees the radio "stuck repeating one `5e`, RSSI dies" — only a full BT
reconnect clears it.

**Fix:** on any unsolicited `58/59/5c/5e/5f`, write back `03 <op> 00 00` (4 bytes,
no checksum); never ACK `5a`/`5b`. Validated by a full DMR PTT-TX → parrot-reply
cycle that completed with `5a` streaming throughout and no wedge.

## 8. Raw Diagnostic Bus

The backend also exposes a raw head-bus WebSocket for local diagnostics:

- `GET /raw/registers` — snapshot of the last raw `04 <reg>` read response per
  register, `{ "<hexCode>": "<hex>" }`.
- `WS /raw/ws` — bidirectional raw bus. On connect the server sends one
  `{type:'snapshot', registers, connected, transport}`. Inbound `{hex}` messages are
  injected to the radio through the existing serial queue. Every frame is mirrored
  out as `{dir:'rx'|'tx', hex, ts}`.

The public repository does not ship reverse-engineering tools; keep local tooling
under gitignored `tools/` or `experiments/` directories.
