# ANYTONE_578_NOTES

AnyTone AT-D578UV-specific notes: what is implemented, what is intentionally
**not yet** implemented, and the markers to use. The protocol detail lives in
[./PROTOCOL.md](./PROTOCOL.md) (the bible) —
this file is the *project status* view of the radio integration.

## Markers / conventions for unfinished work

Use these consistently so future sessions (and grep) can find unfinished work:

- `TODO_ANYTONE:` — a known AnyTone feature gap, with a one-line "why/blocked by".
- `NotImplemented` / HTTP `501` — runtime surface for an unimplemented command.
- Never delete a placeholder just because it is incomplete. Mark its intent.

## Implemented & confirmed over Bluetooth SPP

| Capability | Mechanism | Confidence |
|---|---|---|
| Connect (HFP+SPP) | BlueALSA `hfp-hf` + `rfcomm connect` | confirmed |
| Read firmware/settings/zones/channels/clock | `04 <code> 07 00 00 00` reads | confirmed |
| Live S-meter / squelch | poll `5a`/`5e` + unsolicited `5b` | confirmed (uncalibrated) |
| PTT (TX key/unkey) | `56 01…` / `56 00…` (23-byte) | confirmed live |
| Select active side A/B | `08 19 00/01 …` raw write | confirmed live |
| Set RX frequency (selected side) | `2f 03 …` raw write | confirmed live |
| VFO/Memory mode toggle | `57 3d 01/00 …` raw write | confirmed live |

## NOT implemented (preserve, mark `TODO_ANYTONE`)

### Channel / zone stepping over Bluetooth — **blocked, no opcode**
- `UP`/`DN` → HTTP **501** in `/anytone/command` (intentional).
- `KEY_*` (`pressKey`) sends wired-mic `41`-frames and `56`-variants; the radio
  **ignores them over BT** (ACK or no-op). Kept as an experiment harness.
- Every channel-change candidate from the known BT vocabulary is exhausted (see
  PROTOCOL.md "Key events"). Finding it needs either a real BT-01 button-press
  btsnoop capture, or the **wired mic-port UART** path (115200 8N1, accepts `41`
  frames) — a future hardware route, not BT.
- **Do not** remove `pressKey`, `keyFrameVariant`, `KEY_CODES`, or `/raw/keytest`
  — they are the in-place tooling to crack this.

### Not-yet-implemented UI features
These proxy to backend routes that do not exist; mark `TODO_ANYTONE` (implement
or stub `501`), do not delete the UI affordances yet:
- `preset-execute.post.ts` → `/preset` (preset macro execution).
- `memory-write.post.ts` → `/memory-write` (write a memory channel).
- `pseudo-scan.post.ts` → `/pseudo-scan` (software channel scan).
  - Memory-channel **write** is the natural backend for `memory-write`; the write
    family is proven (`08`/`2f`/`57`) but no channel-number SET opcode is known
    yet — this is the same blocker as stepping.

### Permanently-null state fields (radio lacks them or unreadable)
`anytoneToState` hardcodes `null` for: scope/spectrum, preAmp HF/VHF/UHF,
RF/AF gain, AGC, VOX, speech processor, USB out/mod levels, ant select, func
knob, lock. These are not bugs — they are features with no known AnyTone
equivalent. Leave them null; do not invent values.

Exception for future work: `amc/mic gain` is no longer assumed impossible. Relay
captures confirmed write opcodes for Radio Mic Gain, Radio Speaker Gain, and
BT-01 Speaker Gain (`08 47`/`08 48`/`08 49`, value byte = display gain - 1), but
no read/state/UI mapping has been implemented yet.

Additional confirmed-but-unimplemented menu writes: Noise Reduction Receive
(`08 6b`), Noise Reduction Transmit (`08 6c`), and DigiMon (`08 3f`, values
`00` Off / `01` Single Slot / `02` Double Slot). See `PROTOCOL.md` before adding
state/UI mappings.

## Calibration / open questions (from PROTOCOL.md)
- RSSI `5a` levels 0–4 are uncalibrated → `meterFor` is a guess.
- Channel-block bytes 10–11, 61, 66–67 partially unknown.
- Zone tail bytes (`29`/`2a`), `4a` directory structure not fully resolved.

## If you extend channel/zone writes later
1. Add the opcode to `PROTOCOL.md` with evidence.
2. Implement in `selectSide`-style: enqueue → write/read response → refresh state.
3. Verify on hardware and run `npm run typecheck` / `npm run build`.
