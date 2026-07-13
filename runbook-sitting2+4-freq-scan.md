# Runbook — Sitting 2+4: frequency-write tails, VFO flag, scan, paging

Combined ~40 min session. Same stack as Sitting 1 (which worked); lessons applied: the relay's
`--log` is ignored — **the record is the PoC backend's `captures/wire.ndjson`**, so just note
your wall-clock start/end. All stimuli in this sitting are SELF-LABELLING (frequencies appear
as their own bytes; scan lists identify themselves), so strict timing/annotation is optional.

Resolves: UNKNOWNS §B freq-tail invariance (protects the shipped freq editor), the
VFO-vs-memory flag byte, the scan command family (`57 48`, `2f 2b`, lock-follow) for the scan
feature build, and `04 26/27` paging (channel-picker prerequisite).

## Setup (same as Sitting 1)
```bash
cd ~/anytone
systemctl --user stop anytone-v2
# PoC UI (:3030) → Transport Bluetooth → Connect; wait for live state.
python3 tools/bt01_relay.pyc --bt01 00:1B:10:B2:14:49 --log /dev/null
# Note the wall-clock time relay goes operational:  START = ____:____
```
Second HT available for Part C (scan lock trigger).

## Part A — frequency entry (~10 min) [Sitting 2a/2b]
Radio in **VFO mode** (toggle via the BT-01 if needed). Using the BT-01's direct frequency
entry, enter each RX frequency **twice** (re-enter the same value; the repeat proves the frame
is deterministic):

1. `146.520`
2. `147.330`
3. `446.000`
4. `462.5625`
5. If the head offers TX/offset entry or repeater-shift setting, set: `+0.600` on 147.330 and
   `+5.000` on 446.000 (or direct-enter TX frequencies if that's the head's model) — this is
   the `2f 04` sample set.

Then retune between two of them a few times at ~5 s spacing. If the BT-01 has no direct entry,
skip Part A entirely and tell me — fallback is app-driven validation instead.

## Part B — VFO/MEM flag hunt (~5 min) [Sitting 2c]
On one side, toggle VFO ↔ Memory **6×**, ~5 s apart, ending in Memory mode. (Diffing the
channel blocks across the toggle hunts the real mode flag byte — today we infer it from the
channel NAME, which is fragile.)

## Part C — native scan (~15 min) [Sitting 4a]
Note which scan list you use: LIST = ____________
1. Start scan from the BT-01 on that list.
2. Let it cycle ~30 s untouched.
3. Key the second HT on a member channel; hold ~5 s so the scan locks; unkey; let scan resume.
4. Repeat the lock ×2 more.
5. Stop the scan from the head.
6. Do the whole cycle a second time on a DIFFERENT list if one exists: LIST2 = ____________

## Part D — zone/channel list paging (~5 min) [Sitting 4b]
Note your largest zone: ZONE = ____________ (channel count if known: ____)
1. On the BT-01, open the zone list and scroll it end to end.
2. Open the channel list for the largest zone and scroll ALL the way through, top to bottom.
   (Paging semantics need a >48-channel zone to force page 2 — if no zone is that big, do it
   anyway; single-page termination is still informative. Say so in the notes.)

## Teardown
```bash
# Ctrl-C the relay; Disconnect in the PoC UI.
systemctl --user start anytone-v2
# Note END = ____:____
```

## Deliverables
1. START/END wall-clock times (that's how I window wire.ndjson).
2. The filled-in blanks above: frequencies actually entered (if different), LIST/LIST2, ZONE.
3. Anything odd (entry rejected by the head, scan wouldn't lock, etc.).

## What happens with the results
- Part A: diff every `2f 03`/`2f 04` against our encoders — either the constant tails are
  confirmed across bands (risk closed) or the tail is context-dependent and the freq editor
  gets fixed before it bites.
- Part B: channel-block diff across the mode toggle → pin the VFO flag byte, replace the
  name-pattern inference.
- Part C: validated `57 48`/`2f 2b` frames + measured lock/resume behavior → the scan feature
  gets built directly against this capture (capture-replay test included).
- Part D: `04 26/27` page walk → the channel picker's read path.
