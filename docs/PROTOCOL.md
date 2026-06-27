# AnyTone AT-D578UV Bluetooth (BT-01) Protocol Notes

Sources: jrobertfisher/AT-D578UV-software-mic, at-578uv-hex-scanner BT-01 capture
(firmware V10036), and live probing of a test radio
(firmware V200ET12_AQQX_V10043) over direct SPP — 2026-06-12.

> This doc covers **register/payload semantics**. For the **link-layer transaction
> discipline** (one-command-in-flight, ACK/retransmit rules, read modes, edge cases,
> serial-core contract) see [`RADIO_LINK_CONTRACT.md`](RADIO_LINK_CONTRACT.md).

## Transport

- Radio Classic BT MAC `AA:BB:CC:DD:EE:FF` (example — set yours via `ANYTONE_BT_ADDR`), SPP channel 2, HFP channel 1.
- The radio answers SPP reads **only while an HFP connection is established**
  (BlueALSA `hfp-hf` provides this; its SLC handshake is sufficient).
- Through a real BT-01, frames are wrapped in `+ADATA:00,NNN\r\n<payload>\r\n`.
  Over direct SPP there is no ADATA wrapper — raw payloads only.
- Last payload byte is a checksum: sum of all preceding bytes & 0xFF.

## Session commands

| Command | Bytes | Response |
|---|---|---|
| Wake / keepalive | `61` | `03 61 00 00 64` ACK |
| Enter COM mode | `01` + `"D578UV COM MODE"` (send 2×) | `03 01 00 00 04` ACK |
| Finish handshake | `64` + `"COM CHECK END"` | `03 64 00 00 67` ACK |

Reads are 6 bytes. Normal startup reads are `04 <code> 07 00 00 00` (code
`0x26` uses byte 2 as page: `04 26 <page> 00 00 00`). Menu/list browsing also
uses opcode `04`, but the four argument bytes are command-specific. Response
echoes `04 <code>` then payload then checksum.

## Read command map

| Code | Meaning | Status |
|---|---|---|
| 02 | BT/firmware version string (`V200ET12_AQQX_V10043`) | confirmed |
| 05,07 | settings blocks | unknown |
| 06 | Settings block (audio gains cluster near the tail). **byte[75] = BT Mic Gain** (`08 47` write), **byte[76] = BT Speaker Gain** (`08 48` write) — both stored **0-based** (raw `0–4` = on-screen `1–5`; read AND write are display−1; confirmed live 2026-06-19: byte 75 toggled raw 3↔2, byte 76 ran raw 3→0→2 where raw 0 = display 1; checksum byte 98 follows). byte[73]=`05` byte[74]=`03` constant in samples. Other offsets unknown. | confirmed (gains) |
| 09 | Settings block (confirmed live 2026-06-19; checksum byte 140 follows): **byte[71] = BT-01 Speaker Gain** (`08 49` write, 0-based: raw `0–4` = display `1–5`), **byte[80] = Noise Reduction Receive** (`08 6b` write, LITERAL `0–9`, 0=Off), **byte[85] = Noise Reduction Transmit** (`08 6c` write, LITERAL `0–9`), **byte[43] = Fan mode** (`00` PTT / `01` Temp / `02` Both — no known write opcode). **Voice Func / GPS items (confirmed live 2026-06-19):** byte[39]=Mic Speaker Set (0 Path Main/1 Path Sub; write `08 0b`), byte[40]=GPS Mode (0 GPS/1 BDS/2 GPS+BDS/3 GLONASS/4 GPS+GLONASS/5 BDS+GLONASS/6 ALL; write `08 3d`), byte[62]=Analog Idle (0/1; write `08 06`), byte[76]=GPS Area SQL (0 Off/1 On; write `08 3e`), byte[64]=Analog Mic Level (0-based, display=raw+1; write `08 24`; confirmed: set-4 = raw 3). Other offsets unknown. | confirmed (listed fields) |
| 0a,0b | bitmap/ff blocks | unknown |
| 0d | Analog APRS config (TOCALL, callsign, digi path ASCII) | confirmed (other capture) |
| 10 | contains `APRSCN` ASCII | partial |
| 13,14,15,1b,1d,1e | small settings blocks | unknown |
| 1c | SCT3258 DMR vocoder version ASCII | confirmed (other capture) |
| 1f | Roam zone ("Roam Zone 1" ASCII) | partial |
| 22,23 | list-ish records | unknown |
| 26 | paged data, page in byte 2 | unknown |
| 27 | **Zone channel index list** (paged): `04 27 <zoneIndex> <page> 00 00` → `04 27 <page> <LE16 channel indices…> 0xffff-terminated`. **Byte 2 = 0-based zone index** (zone 0 → `04 27 00 …`, zone 1 → `04 27 01 …`), byte 3 = page — so it reads ANY zone's channels directly WITHOUT selecting/committing it (no 08 39). **Order = in-zone scroll position** (pos 0 = the radio's first channel; matches 04 2c/2d selection), and each value = 0-based global channel index (= channel# − 1 = the 04 2e entry). Correct zone-channel enumeration (the 04 4a directory holds the same set in a DIFFERENT order). Decoded live 2026-06-20 from a "Zones → Edit Chan" relay capture. | confirmed |
| 29 / 2a | Zone name VFO A / B (offsets 2–17 ASCII) + offset 35 = channel scroll position within zone (same value as channel block byte 71, per side) | confirmed |
| 2b | Zone-list browse by index: `04 2b <1-based index> <ctx> 02 00` returns a 32-byte ASCII zone-name block | confirmed |
| 2c / 2d | **Channel block A / B** (layout below) | mostly decoded |
| 2e | Channel-name-by-index: `04 2e <hi> <lo> 04 00` returns a 16-byte ASCII channel name. **`<entry>` is the 0-based GLOBAL channel index = the value stored per-member in the `04 4a` zone directory** (so 04 4a indices feed straight into 04 2e to get a zone's channel names live). Walking it from 0 sequentially returns the whole codeplug — NOT zone-scoped on its own. Entry is 16-bit (hi byte at offset 2). | confirmed |
| 32 / 33 | Radio ID BCD + callsign ASCII | confirmed |
| 34 / 35 | unknown (same both sides: `91 0c 41 24`) | unknown |
| 37 / 38 | Contact record (name ASCII, then BCD id) | partial |
| 39 | Talkgroup/contact-list browse: `04 39 00 00 00 <0-based index>` returns a 103-byte contact record | partial |
| 4a | **Active-zone directory** (follows selected side): 16-byte ASCII zone name at offset 17, then a run of **LE16 member entries from offset 34**, terminated by `0xffff`. Each entry = the member's GLOBAL channel number **minus 1** (0-based); list order = in-zone position (the index `04 2c/2d` selection takes). Decoded live 2026-06-19 from FAVORITES (member+1 matched the CPS CSV exactly: ch 38/45/40/50/79/…). This is the correct zone-scoped channel source — `04 2e` is the GLOBAL list, not zone-scoped. | confirmed |
| 4d,4e,5a,5b,59 | status-ish | unknown |
| 4f | `16 25 50 00` = 162.550 BCD (NOAA WX ch 1? same on both radios) | hypothesis |
| 50 | tiny status | unknown |
| 51 | **Clock**: `hh mm ss 00 <year le16> <month> <day> 00` (binary, local) | confirmed |
| 52 | **GPS**: ASCII lat `12.345678N`, lon `098.765432W`, `V:0.0ft/S`, `H:100ft`, date `24-01-01` (example values), time UTC. All zeros when no fix. | confirmed (other capture) |
| 5e | Live status: byte[4] bit `0x20` = **any** squelch open (global, not per side; confirmed by keyed-carrier tests) | confirmed |
| 05 | Settings block: **byte[11] = main/A squelch level**, **byte[12] = sub/B squelch level** (literal 1-5 as shown on radio; confirmed by setting A to 5, byte 11 `02`->`05`). **byte[25] = selected side's zone number**, **byte[37] = selected TX/RX side** (`00` A/main, `01` B/sub), **byte[38] = dual watch / sub-channel RX flag** (`01` dual, `00` single; confirmed live with B/sub active; write `08 1b`). **Voice Func menu items (confirmed live 2026-06-19; `08 <subcmd> <raw>` writes — stored byte == written byte):** byte[2]=Key Tone (0 Off, 1-8; write `08 04`), byte[14]=Digital Mic Level (0-based, display=raw+1; `08 23`), byte[34]=SMS Notify (0 Off/1 Ring; `08 1c`), byte[40]=Call Ring (0 Off/1 Ring; `08 1d`), byte[42]=Talk Permit (0 Off/1 Digital/2 Analog/3 Both; `08 08`), byte[43]=D-Reset Tone (0/1; `08 09`), byte[44]=Digital Idle (0 Off/1-3 Type 1-3; `08 05`), byte[47]=Startup Sound (0/1; `08 07`), byte[49]=Max Vol Level (0 Indoor, 1-8; `08 10`), byte[65]=Enhance Sound (0 Normal/1 Mic Enhance/2 Indoor/3 Outdoor; `08 15`). **byte[33] = GPS** (0 Off/1 On; write `08 3c`). **byte[56] = DigiMon** (`00` Off / `01` Single Slot / `02` Dual Slot, literal; `08 3f` write; confirmed live 2026-06-19). NOTE: bytes 6-18 (which include squelch) can be clobbered by a stuck "COM CHECK END" echo — the radio stored that text in this region after heavy disconnect cycling and it persisted across reboot. Decode is field-level resilient: side/dual-watch (tail, byte 37/38) stay trusted; squelch nulled when bytes 11/12 are out of the 0-5 range. Do NOT send COM CHECK END at startup (was corrupting every settings poll). | confirmed |
| 5a | RX status relative to selected TX/RX side: **byte[2] = selected-side RSSI, byte[3] = other-side RSSI** (0 idle, ~4 active, uncalibrated), **byte[6] = open-squelch bitmask (0x02 selected side, 0x04 other side)**, byte[14] = any-active flag. Async push variant (no `04` prefix, 16 bytes) shifts all offsets down by 1. Confirmed with A selected and B selected; remap through settings byte 37 to get fixed main/sub status. | confirmed |
| 5b | Async push `5b <open> <ck>` (3 bytes): global any-squelch-open notification | confirmed |

## List/browse read shapes

Observed via real BT-01 relay capture on 2026-06-19 while entering list/menu
screens. Examples are intentionally structural only; contact and zone names are
not committed here.

| Read | Request shape | Response shape | Notes |
|---|---|---|---|
| Zone list | `04 2b <index> <ctx> 02 00` | 35 bytes: `04 2b <32-byte ASCII zone name> <cksum>` | Index is 1-based in the observed Menu -> Zones list. `<ctx>` is not part of the returned index; observed as `00` during initial list draw and `05` while browsing from zone 5. |
| Talkgroup/contact list | `04 39 00 00 00 <index>` | 103 bytes: `04 39 01 <record...> <cksum>` | Index appears 0-based. Name starts at byte 3; a BCD-like TG/DMR ID field follows the name/padding. Exact field lengths and ID trimming are still partial. |
| Channel names in zone | `04 2e 00 <entry> 04 00` | 20 bytes: `04 2e <16-byte ASCII channel name> <reserved?> <cksum>` | Used while browsing a selected zone's channels. Observed sequential entries; relationship to zone-member/global channel index still needs mapping. |

## Channel block layout (04 2c / 04 2d response)

Offsets relative to start of payload (byte 0 = `04`, byte 1 = `2c|2d`).
Verified against CPS CSV export, including live channels 45 `REPEATER-1` and 38 `REPEATER-3`, plus other user's capture.

| Offset | Size | Field | Evidence |
|---|---|---|---|
| 2–5 | 4 | RX frequency, BCD big-endian ×10 Hz units (`44 71 75 00` = 447.17500) | confirmed |
| 6–9 | 4 | TX offset, BCD (`00 50 00 00` = 5.000 MHz; `00 06 00 00` = 0.600) | confirmed |
| 10 | 1 | Bitfield: **bits 0–1 = channel type** (`0` A-Analog, `1` D-Digital, `2` A+D TX Analog, `3` D+A TX Digital; matches QDMR's D578 `channelMode`). **bits 2–3 = TX power** (`0` Low, `1` Mid, `2` High, `3` Turbo; confirmed via manual Mid→Turbo on REPEATER-2, `54`→`5c`). **Bit 4 = bandwidth** (set 25K, clear 12.5K; confirmed via manual 25K→12.5K on REPEATER-1 + REPEATER-3, `54`→`44`, and matches every CSV memory channel). Bits 6–7 likely repeater mode per codeplug layout. | confirmed (type + power + width) |
| 11 | 1 | **Tone-type selector**, low nibble = `(txType << 2) \| rxType`, where `0` Off / `1` CTCSS / `2` DCS. **Authoritative** — the CTCSS index (12/13) and DCS code (14-17) value bytes keep STALE values when the type changes, so decode tone type from here, not from value presence. Confirmed live 2026-06-20: TX Off/CTC/DCS → `01`/`05`/`09` (RX held at CTC=`1`). High bits carry other flags. | confirmed |
| 12 | 1 | CTCSS **encode** index, 1-based standard tone list (14 = 103.5), 0 = Off | confirmed |
| 13 | 1 | CTCSS **decode** index (9 = 88.5), 0 = Off | confirmed |
| 14–15 | 2 | DCS **encode** code, LE16 decimal value displayed as octal (`ad 00` = 173 decimal = D255; `65 00` = 101 decimal = D145) | confirmed |
| 16–17 | 2 | DCS **decode** code, LE16 decimal value displayed as octal (`32 01` = 306 decimal = D462; `1e 00` = 30 decimal = D036) | confirmed |
| 18–19 | 2 | Custom CTCSS ×10, LE (`cf 09` = 2511 = 251.1 Hz) | confirmed |
| 27 | 1 | Squelch mode: `00` Carrier, `10` CTCSS/DCS | confirmed |
| 37–52 | 16 | Channel name, ASCII zero-padded | confirmed |
| 61 | 1 | `0d` constant in all samples | unknown |
| 66–67 | 2 | `64 64` (100,100) constant | unknown |
| 71 | 1 | **0-based channel scroll position within current zone.** Confirmed by single channel-up steps: REPEATER-3=4, REPEATER-2=5, REPEATER-4=6 (+1 per click). Mirrored in zone block `29`/`2a` offset 35 (per side). | confirmed |
| 70 | 1 | Zone-directory lookup value = `block4a[byte71]` for the channel's position (REPEATER-4→82, REPEATER-3→79, REPEATER-2→77). Relationship to the `4a` channel-number list not fully resolved. | partial |
| 73–74 | 2 | LE16 channel index. Observed encodings: `0x100 + (channel# - 1)` on analog samples (`0125` -> ch38), and plain zero-based `(channel# - 1)` on DMR PARROT (`0049` -> ch74). | confirmed |
| 75–78 | 4 | Contact TG/DMR ID, BCD (`00 01 23 45` = 12345, example) | confirmed |
| 79–94 | 16 | Contact name ASCII (`CONTACT-1`) | confirmed |
| 96–99 | 4 | Radio ID, BCD (`01 23 45 67` = 1234567, example) | confirmed |
| 100–109 | ~10 | Radio callsign ASCII (`N0CALL`) | confirmed |

Standard CTCSS tone list (1-based index):
67.0 69.3 71.9 74.4 77.0 79.7 82.5 85.4 88.5 91.5 94.8 97.4 100.0 103.5 107.2
110.9 114.8 118.8 123.0 127.3 131.8 136.5 141.3 146.2 151.4 156.7 162.2 167.9
173.8 179.9 186.2 192.8 203.5 210.7 218.1 225.7 233.6 241.8 250.3

## Zone frame tail (04 29 / 04 2a)

After the 16-byte zone name there are 2 trailing data bytes before the checksum
(`0f 05`, `04 01`, `0d 05` observed). Likely zone index / channel-in-zone index.
Diff while stepping channels/zones to confirm.

## Key events / remote control (tested 2026-06-12)

Wired mic protocol (sniffed from RJ45 mic bus, per AT-D578UV-software-mic):
`41 <ptt> <pressed> <long> <keycode> 00 00 06` — keycodes: PTT via byte 1,
digits 0-9 = 01-0a, star/hash = 0b/0c, Sub A/B = 0d, UP = 10, DOWN = 11,
A/B/C/D = 1a-1d. **Not accepted over Bluetooth SPP** (no ACK, no action),
including with CRLF or `+ADATA` wrapping.

Bluetooth PTT (from BT-01-PTT.log): 23-byte frame `56 <ptt> 00*21`,
ACKed with `03 56 00 00 59`. The radio ACKs *any* 56-frame but tested key-code
placements at bytes 2/3/4/5 cause no action — **the BT interface appears to be
PTT-only**, matching the BT-01 hardware (a PTT fob). No BT channel-step
command is known. Retested with B/sub active on a memory channel: wired `41`
UP over raw/CRLF/ADATA framing, `56` placements, `_wake` variants that append
`61`, and dynamic `v56_pX_kY` placements all either produced no response or
ACKed (`03 56 00 00 59`) with no channel change after polling. Backend
`/raw/keytest` endpoint remains for experimenting (variants: raw41, crlf41,
adata41, v56, adata56, v56_k2, v56_k3, v56_k5, plus `_wake` suffix and
`v56_pX_kY`; the PTT byte is never set).

**BT-01 frame envelope (from jrobertfisher/AT-D578UV-software-mic BT-01 logs, 2026-06-12):** the real BT-01 wraps EVERY SPP frame as `+ADATA:00,<3-digit-len>\r\n<payload>\r\n` (len = payload byte count). Confirmed examples: wake `...,001\r\n\x61\r\n`; COM MODE `...,016\r\n\x01D578UV COM MODE\r\n`; read `...,006\r\n\x04\x29\x07\x00\x00\x00\r\n`; PTT `...,023\r\n\x56\x01<21x00>\r\n`. Our backend sends RAW (unwrapped) payloads and reads + PTT still work, so the radio accepts both. The BT-01's full observed vocabulary is ONLY: `61` wake, `01 D578UV COM MODE`, `04 <reg> 07 00 00 00` reads, `56 <ptt> 00*21` PTT, `64 COM CHECK END`, `61` keepalive. **No channel/zone/button command frame exists in any public capture** — the repo author never sniffed a BT-01 button press (BT button control was unimplemented/"theoretical"). The wired-mic `41 <b1> <pressed> <long> <code> 00 00 06` button frames (up=0x10, down=0x11, A/B/C/D=0x1a-0x1d, digits 0x01-0x0a) are NOT accepted over BT in raw OR `+ADATA`-wrapped form, and `56`-frame keycode placements at bytes 2-5 don't act. The BT-01 uses a dedicated `56` frame for PTT (not the wired `41 01`), so its button frames are likely also `56`-family but the encoding is uncaptured. ***** BT IS NOT READ-ONLY — WRITE COMMANDS WORK (2026-06-12) ***** Earlier "read-only" conclusion was WRONG; we just lacked the write opcodes. The write command family (from jrobertfisher/at-578uv-hex-scanner `atd578uv-cli.py`) works over Bluetooth SPP when sent **RAW (unwrapped)** — the `+ADATA:00,..\r\n..\r\n` wrapper does NOT work over BT, raw does. CONFIRMED live: `08 19 00 88 1f 00 20 71 02 00 08 51 06 00 08 45 04 00 08 4d 06 00 08` selects VFO/side A, `08 19 01 ...` selects side B (reproducibly toggled txVfo 0↔1 four times, no corruption, verified via settings byte 37). Other write commands from the same CLI (untested over BT but same family/transport, expect raw form): `57 3d 01/00 <long payload>` = VFO/Memory mode; `2f 03 00 <8-byte BCD freq> 15 50 00 00 0c 00 00 00 00 00 00 00 cf 09 00 00` = set VFO frequency (A uses `..0c..`, B uses `..00..` at that offset). No channel/zone-number SET command in that CLI yet, but the write channel is now PROVEN — hunt for it is feasible. Send via backend `/raw/send` (raw hex, no checksum/ADATA needed). Power-level read offset in CLI: bytes [50:52] 01/40=Low 05/44=Med 09/48=High 0d/4c=Turbo (matches our byte-10 power decode).

**Wired mic-bus serial = ALSO full control (digirig/VARA path), redundant now that BT writes work.** The `41` frame protocol IS accepted over the radio's RJ45 mic-port UART at **115200 8N1** (no flow control), with radio "Hand Type" set to UART/Uart-Det. This is what the physical hand mic, jrobertfisher's software mic, and digirig CAT cables use — and it supports full channel/zone/menu/VFO/PTT control. So channel/zone change is achievable over a WIRED serial link to the mic port, just not over Bluetooth. Practical path: Pi → USB-TTL (or digirig D578 cable's CAT line) → mic-port UART, send `41` frames. Open question: whether the wired UART works concurrently with the BT-01 emulation, or the radio honors only one hand-mic source at a time. Mic-port pin 1 shares serial-URX with hardware-PTT (use serial; keep PTT over BT).

Tested 2026-06-12 (live, user standing by, detecting changes by polling since the radio display is blank in COM MODE): byte-1 keycode hypothesis on `56` (up=0x10/down=0x11, raw + ADATA) = NO channel change; `41` button frames (up/down/subAB, raw + exact-ADATA `+ADATA:00,008\r\n...\r\n`) = NO channel change. So byte 1 of `56` is the PTT flag, not a keycode. Every channel-change candidate derivable from the known vocabulary is now exhausted with no effect. The actual button command is a frame type absent from all public captures; finding it requires either a real BT-01 button-press sniff (btsnoop) or blind first-byte command probing (risky: corruption/TX).

Retested 2026-06-13 for the manual's direct channel-number entry path while B/sub was active on memory 79 `REPEATER-5`: sent `0 0 8 2` (target global memory 82 `REPEATER-4`) as raw `41` press/release frames, exact `+ADATA`-wrapped `41` frames, and the safe non-PTT `56` placement variant (`56 00 <pressed> 00 <keycode> ...`). Results: raw/ADATA `41` produced no response; `56` ACKed each press/release with `03 56 00 00 59`; B stayed on memory 79 after polling. So numeric keypad entry over these known BT frame shapes is also rejected/no-op.

Confirmed 2026-06-13: `04 4a 07 00 00 00` follows the selected side. With A selected on `HOTSPOT`, it returned an all-`ff`/empty directory; with B selected on `FAVORITES`, it returned the active zone’s member list (`<channel numbers>`). This gives enough read-side data to compute a target zone position, but no write opcode for applying that cursor is known yet.

Tested 2026-06-13: the scanner repo's selected-side frequency write `2f 03 00 <4-byte BCD> 15 50 00 00 ...` is accepted in memory mode without first sending `57 3d 01` (VFO mode). Hypothesis was that replacing the frequency field with a channel number, e.g. `00000050`, might select memory 50. Actual result on B/sub memory 79: radio ACKed `03 2f 00 00 32`, and the next `04 2d` showed RX frequency bytes changed to `00 00 00 50` while channel name/number/cursor stayed `REPEATER-5` / memory 79 / position 0. Sending `2f 03 00 44 98 25 00 ...` restored the RX frequency to 449.82500. Conclusion: `2f 03` writes the selected side's working RX-frequency field even while in memory mode; it is not a memory-channel selector.

Confirmed 2026-06-13: selected-side VFO mode + frequency set works over raw BT writes. Test on B/sub: `08 19 01 ...` selected B, then `57 3d 01 00 00 88 1f ...` ACKed `03 57 3d 00 97` and `04 2d 01 00 00 00` changed to `Channel VFO B` with RX/TX frequency bytes `14 40 90 00` (144.09000). Sending `2f 03 00 14 53 10 00 15 50 00 00 00 00 00 00 00 00 00 00 cf 09 00 00` ACKed `03 2f 00 00 32`; subsequent `04 2d 01 00 00 00` showed RX frequency bytes `14 53 10 00` = 145.31000. The TX/offset bytes remained whatever VFO B already had (`14 40 90 00` in this test), so `2f 03` appears to set RX frequency only.

### `2f` per-channel setting writes (channel-edit family)

Confirmed 2026-06-20 from BT-01 channel-edit relay captures: the `2f <subcmd>`
family writes the **selected side's working channel**. The "simple" settings share
the **same envelope as the `08` menu write** — `2f <subcmd> <raw> <20-byte
MENU_WRITE_TAIL>` (the same `88 1f 00 20 71 02 00 08 51 06 00 08 45 04 00 08 4d 06
00 08` tail) — only the opcode differs. Radio ACKs `03 2f 00 00`. Implemented as the
`CHANNEL_SETTINGS` registry + `setChannelSetting` (`POST /anytone/channel-setting`).

| subcmd | setting | values (raw byte 2) |
|---|---|---|
| `01` | Channel Type | 0 Analog · 1 Digital · 2 A+D TX-A · 3 D+A TX-D |
| `18` | TX Power | 0 Low · 1 Medium · 2 High · 3 Turbo |
| `1c` | Bandwidth | 0 Narrow · 1 Wide |
| `1b` | Squelch Mode | 0 SQ · 1 CDT · 2 TONE · 3 C&T · 4 C\|T |
| `09` | Optional Signal | 0 Off · 1 DTMF · 2 2TONE · 3 5TONE |
| `21` | Color Code | 0–15 |
| `15` | Time Slot | 0 TS1 · 1 TS2 |
| `0f` | TX Interrupt | 0 Off · 1 Low · 2 High |
| `1f` | Busy Lock | 0 Off · 1 Different CDT · 2 Channel Free |
| `11` | Scrambler | 0 Off · 1 3.3k … 9 2.5k · 10 4.095k · 11 3.458k (12 user-define) |
| `1d` | Reverse | 0/1 |
| `10` | Compander | 0/1 |
| `1e` | Talkaround | 0/1 |
| `20` | TX Prohibit | 0/1 |
| `0d` | SMS Forbid | 0/1 |
| `0c` | DataAck Forbid | 0/1 |
| `0b` | APRS Receive | 0/1 |

**Read-back offsets in the `04 2c/2d` block** (decoded 2026-06-20 via controlled
write/read diffs on a live channel):

| Setting | Byte.bits | Decode |
|---|---|---|
| Channel Type / TX Power / Bandwidth | 10 (`0-1` / `2-3` / `4`) | bitfield |
| RX / TX tone type | 11 (`0-1` / `2-3`) | 0 Off / 1 CTCSS / 2 DCS |
| Reverse / TX Prohibit / Talkaround | 11 (bit 4 / 5 / 7) | 0/1 |
| TX / RX CTCSS index | 12 / 13 | 1-based tone (gated by byte-11 type) |
| TX / RX DCS code | 14-15 / 16-17 | LE16, `code = raw.toString(8)` (gated by type) |
| Squelch Mode | 27 (bits 4-6) | `(b27 >> 4) & 7` |
| Optional Signal | 28 (bits 4-5) | `(b28 >> 4) & 3` |
| Busy Lock | 28 (bits 0-1) | `b28 & 3` |
| Compander | 54 (bit 3) | `(b54 >> 3) & 1` |
| Scrambler | 60 (bits 0-3) | `b60 & 0xf` |
| Color Code | 34 (bits 0-3) | `b34 & 0xf` |
| Time Slot | 35 (bit 0) | `b35 & 1` |
| APRS Receive | 35 (bit 5) | `(b35 >> 5) & 1` |
| TX Interrupt | 54 (bits 4-5) | `(b54 >> 4) & 3` |
| SMS Forbid | 63 (bit 2) | `(b63 >> 2) & 1` |
| DataAck Forbid | 63 (bit 3) | `(b63 >> 3) & 1` |
| DMR Mode | 54 (bit 1) + 35 (bits 2-3) | direct flag (`0`=Repeater) + slot variant (`0` Simplex / `1` Double Slot / `2` Double Slot(D)) |

`2f` channel writes **persist to the stored codeplug** (not just the working copy;
re-selecting the channel does not revert them). **Reverse and Talkaround are mutually
exclusive** (byte 11 bits 4/7): enabling one clears the other on the radio — by design
(they are conflicting frequency modes), not a write bug. TX Prohibit (bit 5) is
independent and always preserved. Color Code / Time Slot / DMR Mode read offsets
(digital) are not yet mapped.

**Structured `2f` fields (non-menu-tail payloads):**
- `08` **DMR Mode** — option in bytes 3-4 over a fixed template: Repeater `(0,0)`,
  Simplex `(1,0)`, Double Slot `(1,1)`, Double Slot(D) `(1,2)`. **Implemented**
  (`dmrModeFrame`, registry key `dmrMode`).
- `24` **Name** — `2f 24 00 <20-byte ASCII field>`, <=16 visible chars, zero-padded.
  **Implemented** (`setChannelName`, alphanumeric+space, `POST /anytone/channel-name`).
- `04` **TX freq** — `2f 04 00 <BE32 of Hz/10> 00 00 00 00 05 05 05 05 9f 80 03 08
  00 00 00 00` (145.00000 -> `00 dd 40 a0`; 444.82500 -> `02 a6 bf c4`). Binary,
  NOT BCD (unlike RX `03`). **Decoded**; setter grouped with the RX-freq/offset
  work (pending offset captures).
- `02`/`16`/`17` **TCDT/RCDT/RTCDT** — `2f <s> <type> <b3> <b4> …`. type `0 Off /
  1 CTC / 2 DCS`. CTC: b3 = 1-based standard CTCSS index (67.0=1, 100.0=13,
  103.5=14, 254.1=50). DCS D023N = `02 00 13` (b4 = decimal of the octal code,
  023->19). CTC decodable; **DCS pending** D023I (inverted-flag byte) + D777N
  (high byte for codes whose octal->decimal > 255). Encoding shared across all 3.
- `14` **Offset** — direction in byte 2 (`+` = 00); magnitude location unknown.
  **Pending** -/Off + nonzero-magnitude captures.

Confirmed 2026-06-19 from real BT-01 relay captures: audio gain menu writes use
the same fixed `08` write-family tail as side/zone writes, with byte 2 holding a
zero-based display value (`display_gain - 1`). `08 47 <n>` = Radio Mic Gain
(set to 5 captured as `08 47 04 ...`), `08 48 <n>` = Radio Speaker Gain (set to
1 captured as `08 48 00 ...`), and `08 49 <n>` = BT-01 Speaker Gain (set to 5
captured as `08 49 04 ...`). Implementation deferred; no backend/UI writer yet.

Also confirmed 2026-06-19: `08 6b <n>` = Noise Reduction Receive (set to 3
captured as `08 6b 03 ...`), `08 6c <n>` = Noise Reduction Transmit (set to 3
captured as `08 6c 03 ...`), and `08 3f <n>` = DigiMon (`00` Off, `01` Single
Slot, `02` Double Slot). The noise-reduction capture proves raw value `03` for
menu value 3; the full range/base is not mapped yet. Implementation deferred.

**PTT confirmed working (2026-06-12):** sending `56 01 00*21` keys the
transmitter and `56 00 00*21` releases it; both ACK `03 56 00 00 59`. On
release the radio also pushes an async `5e` status frame. Exposed as
`POST /raw/ptttest` (`{"confirm":"TRANSMIT","holdMs":1000}`) and as live
`TX1`/`TX0` via `/anytone/command` with a watchdog auto-release
(`ANYTONE_PTT_MAX_MS`, default 60 s). TX mic audio goes to the BlueALSA HFP
sink `/org/bluealsa/hci0/dev_.../hfphf/sink` (8 kHz mono S16_LE) — full-duplex
with the RX capture on the matching `source` PCM.

**DMR PTT context tail (2026-06-16):** DMR channels use the same `56` opcode but
the extended 23-byte form. Key-down is `56 01 00 <side> 80 <tail[18]>`; unkey is
`56 00 00 <side> 00 <same-tail[18]>`. Do **not** use the all-zero simple release
after DMR key-down: it can leave the radio stuck flooding async `5e 00` / `58 00`
status frames until SPP reconnect. When a raw async `58` current-context frame is
available, derive the tail from the record after `58`: `tail[0]=record[1]`,
`tail[1..4]=record[5..8]`, `tail[5]=record[2]>>7`, `tail[6..17]=0`. DMR press
success should ACK as `03 56 00 01 5a`; DMR release normally ACKs
`03 56 00 00 59`, and success is verified by no continuing `5e`/`58` flood.

## Open questions

- RSSI level calibration — 5a levels observed 0–4 so far; capture a weak vs
  strong signal to map levels to dB/S-units
- Bytes 10–11, 61, 66–67 of channel block
- ~~Channel bandwidth byte~~ resolved: channel block byte 10 bit 4 (see layout); CSV fallback retired to short-frame cases only
- ~~TX power byte~~ resolved: channel block byte 10 bits 2–3 (see layout).
  `High`=2 inferred from enum order + a VFO capture; flip a channel to High to
  fully confirm. Side finding: off 29 = scan list (`08` index, `ff` none).
- Zone tail bytes; 4a structure (has zone name + counters?)
- Write/control commands (channel up/down, key events) — BT-01 mic buttons send
  these; not yet captured. Needed for remote channel stepping.
