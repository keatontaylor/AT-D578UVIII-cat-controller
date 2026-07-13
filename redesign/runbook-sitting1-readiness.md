# Runbook — Sitting 1: the readiness field (`5a` b7 / read b8)

Bench-followable, every command concrete. Goal: capture BT-01-driven side swaps, zone steps,
channel steps, and PTT with enough repetition and annotation to pin whether `5a` byte 7
(read-form byte 8) is the radio-readiness field the BT-01 firmware gates on (`status[8]&3==0`)
— and to measure the 5a reference-settle window directly. Resolves UNKNOWNS §A `5a` b7 (top
target), `04 29` b35, and the BT-01 PTT bytes, in one sitting.

**Known values for this bench:**
- Radio: `00:1B:10:1C:FA:C3` (ELET_AGHF_LEFAC3, from `.env`)
- BT-01 head: `00:1B:10:B2:14:49`
- Pi adapter: hci0 `2C:CF:67:F7:FA:8C`
- PoC backend `:3010` / UI `:3030` (already running as services on this Pi)
- Relay tool: `tools/bt01_relay.pyc` (recovered sourceless build — the `.py` is gone; runs fine)

## 1. Equipment
- BT-01 head, charged/powered.
- A second HT (or any carrier source) on a simplex frequency you can program/select — we need
  REAL signal on exactly ONE side so the reference flip is visible in the data.
- ~45 minutes.

## 2. Preflight (10 min)
```bash
cd ~/anytone

# 1. Stop the v2 service — it must not touch BlueZ during the sitting.
systemctl --user stop anytone-v2

# 2. Confirm the PoC stack is up (both must show LISTEN):
ss -tln | grep -E '3010|3030'

# 3. Confirm the radio is paired (should list ELET_AGHF…):
bluetoothctl devices

# 4. BT-01 pairing — it is NOT currently in the paired list (verified 2026-07-03), so pair it:
#    put the BT-01 in pairing mode, then:
bluetoothctl
#   scan on                      → wait for 00:1B:10:B2:14:49
#   pair 00:1B:10:B2:14:49       → PIN 0000 if asked
#   trust 00:1B:10:B2:14:49
#   scan off / exit

# 5. Radio ON, volume up, on an ANALOG channel. Set MAIN to the frequency your second HT will
#    transmit on; set SUB to a quiet channel. (Signal on ONE side only — this is what makes the
#    reference flip observable.)
```

## 3. Start the capture stack (5 min)
Three terminals (or tmux panes):

**T1 — backend link:** open the PoC UI `http://ftx-control:3030` (or `localhost:3030` at the
Pi), Transport = Bluetooth, press **Connect** (plain connect, NOT relay — the relay tool needs
the backend live-connected or the head stalls at "ALL DATA CHECKING"). Wait until the UI shows
connected state + live smeter.

**T2 — the relay:**
```bash
cd ~/anytone
STAMP=$(date +%Y%m%d-%H%M%S)
python3 tools/bt01_relay.pyc --bt01 00:1B:10:B2:14:49 \
  --log captures/exp-1-readiness-$STAMP.ndjson
```
Power the BT-01 on if it isn't. Watch for the head's startup sweep to complete — the BT-01's
screen should come alive and mirror the radio (channel names, smeter). If audio-gateway errors
scroll by but the head is operational, ignore them; if the head won't go operational, retry
with the default audio (no flag) vs `--no-audio` — June captures used defaults.

**T3 — annotations (do not skip):**
```bash
cd ~/anytone
tools/annotate.sh captures/exp-1-readiness-$STAMP-notes.md
```
Type a label + Enter at the MOMENT you do each action below (e.g. `swap A>B`, `key HT`, `ptt`).

## 4. The experiment script (~20 min)
Do the blocks in order. Between every action: **~5 s pause**. Announce each in T3 first.

**Block 0 — baseline (3 min):** touch nothing. After 1 min, key the second HT for ~5 s, then
off, ×3 (annotate `HT on` / `HT off`). This baselines b7/b12/b13 against pure squelch activity.

**Block 1 — side swaps, quiet (×6):** with the HT silent, swap MAIN/SUB on the BT-01, wait 5 s,
swap back. Annotate each `swap`.

**Block 2 — side swaps under signal (×6):** key the second HT continuously (or long carriers),
and repeat 6 swaps while RSSI is up. Annotate `swap+sig`. *This is the money block: the
reference flip is directly visible in b1/b2/b5, and b7's behavior around each `08 19` is the
readiness answer.*

**Block 3 — zone steps (×8):** HT off. Zone up ×4, zone down ×4 on the BT-01, 5 s apart.
Annotate `zone+`/`zone-`.

**Block 4 — channel steps (×8):** channel up ×4, down ×4 within one zone, 5 s apart. Annotate
`ch+`/`ch-`. (Feeds `04 29` b35 = in-zone-position hypothesis and channel-block b70/b73.)

**Block 5 — PTT (×5):** on the analog channel (confirm nothing on frequency), PTT on the BT-01
for ~2 s, release, 10 s apart. Annotate `ptt`. (Captures the head's real `56` frames — bytes
3-5 — and b7 during TX.)

**Block 6 — cooldown (1 min):** touch nothing. Ctrl-D in T3, Ctrl-C in T2.

## 5. Teardown
```bash
# Disconnect in the PoC UI, then restore v2:
systemctl --user start anytone-v2
ls -la ~/anytone/captures/exp-1-readiness-*
```

## 6. Deliverables (what I need back)
1. `captures/exp-1-readiness-<stamp>.ndjson`
2. `captures/exp-1-readiness-<stamp>-notes.md`
3. Anything odd you noticed (head froze, radio beeped, UI glitched) with rough time.

Analysis (mine, after): census on this capture alone, then per-offset transition windows around
every `08 19`/`08 39`/`56` H>R frame, cross-referenced with your annotations. Success criterion:
b7's low 2 bits are non-zero in a window that brackets each command and returns to 0 — that's
the commit barrier, and `SIDE_SETTLE_MS` dies.

## 7. Troubleshooting
| symptom | fix |
|---|---|
| Head stalls at "ALL DATA CHECKING" | backend not connected — do T1 first, then restart the relay |
| Relay can't dial the head | BT-01 not powered/paired; re-run the pairing block; check `bluetoothctl info 00:1B:10:B2:14:49` shows `Paired: yes, Trusted: yes` |
| Pairing bonds but immediately fails auth | you bonded an LE shadow — `bluetoothctl remove` it and re-pair after `menu scan` → `transport bredr` (same gotcha as the radio) |
| PoC UI won't connect to the radio | make sure v2 is stopped (`systemctl --user status anytone-v2` → inactive); power-cycle the radio's BT (menu) |
| Capture file empty | **KNOWN (Sitting 1): the relay's `--log` file stayed empty — the session record lands in the PoC backend's `captures/wire.ndjson` instead** (every frame routes through the backend raw bus, which logs it). Note your session start/end wall-clock time; analysis windows wire.ndjson by timestamp. |
