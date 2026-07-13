# Connection Establishment & External Components

This is the **under-documented system glue** the redesign philosophy says to *transplant*
rather than rewrite. This doc captures what it does so the port has a spec to port *to*.
Much of it is graded DOCUMENTED — it works in the PoC and is to be lifted behind clean
interfaces (ARCHITECTURE → `services/`, `transport/`).

## 1. Bluetooth connection establishment (BT transport)

The control link and audio link are **separate** Bluetooth profiles to the same radio:
- **SPP control link — a native AF_BLUETOOTH RFCOMM socket** (no `rfcomm` CLI, no
  `/dev/rfcommN` kernel TTY). RFCOMM channel is SDP-discovered. [CONFIRMED — live config]
- **HFP (Hands-Free)** — the audio link; the radio is the Audio Gateway, we are the HF unit.
  The radio answers SPP reads **only while an HFP link is established**. [DOCUMENTED]

> **Native socket, not a TTY (important — with a caveat).** The socket is `SOCK_STREAM` over
> `BTPROTO_RFCOMM`, via libc FFI (Node has no AF_BLUETOOTH). Two things follow:
> - **Send side (the win):** one small `write()`, paced by one-in-flight, leaves as ~one RFCOMM
>   packet, so the *radio* sees one clean frame to parse. The old kernel-TTY path (`rfcomm bind` +
>   serialport) merged our writes and flattened boundaries — the source of the long-session
>   desync/corruption. The redesign drops the TTY path entirely.
> - **Receive side (the caveat):** `SOCK_STREAM` is a **byte stream** — the kernel exposes **no
>   RFCOMM packet lengths or boundaries** (RFCOMM doesn't support `SOCK_SEQPACKET`; raw L2CAP
>   would, but the radio's SPP is RFCOMM). So we get **no length from the radio** and must frame
>   the inbound stream ourselves (LINK_PROTOCOL §2). A single `read()` *usually* yields one frame
>   here, but only as a tendency, not a guarantee.

### Bring-up sequence (PoC `ensureRadioReady` + `runStartup`)
```
1. BlueZ (D-Bus): power adapter on; find radio (configured MAC or name-pattern fallback);
   pair + trust if needed.
2. Point audio at this radio's HFP PCM on the active adapter (BlueALSA).
3. Start the isolated BlueALSA HFP handler (must precede the profile connect).
4. Connect the ACL/HFP profile; confirm the HFP source PCM appears.
5. Open the **native RFCOMM socket** (AF_BLUETOOTH) to the SDP-discovered channel.
6. COM-MODE handshake on the control link (LINK_PROTOCOL streaming handshake):
     61 (wake) · 01 "D578UV COM MODE" (x2) · register enumeration · 64 "COM CHECK END"
   After COM CHECK END the radio streams 5a/5b + the acknowledged push classes.
```

**Load strategy: full enumeration at connect.** Step 6 reads the entire config/codeplug up-front
(~55 reads: settings, every zone→channels, scan lists) so `RadioState` is complete the moment the
UI attaches — matching the BT-01. Connect is slightly slower; the state model stays simple (no
partial-state handling). [decision]

### Link health & reconnect (resilience — not a DMR workaround)
The control link is continuously health-tracked and **automatically (re)established with capped
backoff, indefinitely — including retrying the INITIAL connection**, not just post-drop. On a
reconnect, only the control socket is reopened (audio untouched), then the COM-MODE handshake +
re-enumeration re-run, and the UI gets a fresh state snapshot. [improvement]

> **Correction vs the PoC:** the PoC framed reconnect around "a DMR call sheds SPP." That causal
> story appears to be a **misdiagnosis** (behavior we were chasing under wrong assumptions), so
> the redesign makes **no assumption about why** a link drops — it just keeps the link healthy
> and redials. Drop the DMR-shed rationale; keep the robust health+redial behavior. [decision]

> Classic-vs-BLE pitfall (transplant as-is): pick the Classic device by SPP/HFP-AG support then
> lower address; SDP-discover the RFCOMM channel rather than assuming 2.

## 2. Wired transport — DEFERRED
A wired mic-port UART transport (ADATA-framed, polled) exists in the PoC but is **out of scope
for v1.** BT-only for now; the `transport/` seam (ARCHITECTURE) leaves room to re-adopt it later
without disturbing the layers above. [deferred]

## 3. Relay mode (RE)
Open the radio link but inject nothing and emit no ACKs; a real BT-01 connects (over a local
WS) and drives the bus, with all frames forwarded + logged. This is how the protocol is
validated and how `captures/wire.ndjson` is produced. Keep it. [CONFIRMED]

## 4. External component inventory

| Component | Role | Notes / grade |
|---|---|---|
| **BlueZ** (`bluetoothd`, D-Bus) | adapter control, pair/trust/connect, SDP | via `dbus-next`; auto scan/pair/connect. [CONFIRMED] |
| **BlueALSA** (`bluealsa`, `bluealsa-cli`) | HFP/SCO audio PCM bridge | runs as an **isolated instance** (`org.bluealsa.<suffix>`) to coexist with system BlueALSA. [DOCUMENTED] |
| **RFCOMM socket** (AF_BLUETOOTH `SOCK_STREAM`, koffi FFI) | SPP control byte pipe | **native socket — no `rfcomm` CLI, no kernel TTY**; clean send-side framing, but recv is a byte stream (we frame). [CONFIRMED — live] |
| **ffmpeg** | RX audio capture / encode (recordings) | spawned by `services/`. [DOCUMENTED] |
| **WebRTC** peer | browser audio peer (RX out, TX mic in) | media only; signaling on the WS. **Lib choice TBD** — transplant the pipeline, but revisit `@roamhq/wrtc` (maintenance/alternatives) before committing behind `RtcPeer`. [to revisit] |
| **nginx** | reverse proxy, TLS/mTLS termination, WS upgrade | proxies `…/anytone/` to the app; already proxies a WS path. [DOCUMENTED] |
| **systemd (user service)** | supervision, restart-forever | `Restart=always`, `StartLimitIntervalSec=0`. [CONFIRMED] |
| **sudoers (scoped)** | the few privileged BT/rfcomm commands | least-privilege; installed by the one-shot installer. [DOCUMENTED] |
| **RadioID dump** | DMR caller-ID → callsign/name lookup | local CSV, optional. [CONFIRMED] |
| **CPS CSV (optional)** | channel power/bandwidth enrichment | app runs fine without it. [DOCUMENTED] |

## 5. Interfaces to define (so the glue is transplantable)
- `Transport` — `write(bytes)`, `onData`, `onClose`, `open`, `close` (native RFCOMM socket;
  wired is a future second implementation behind this same seam).
- `AudioLink` — establish/teardown the HFP PCM for a radio; expose source/sink PCM handles.
- `Recorder` — start/stop squelch-triggered recording; consumes `domain` squelch state.
- `RtcPeer` — negotiate (signaling over WS) and pump RX out / TX mic in.
- `BtManager` — adapter/pair/trust/connect/SDP over BlueZ.

Each is a narrow seam the PoC implementation drops into, keeping `link/`/`codec/` free of
system concerns and satisfying the testability + modularity requirements.

## Open / to validate
- **WebRTC lib evaluation** — assess `@roamhq/wrtc` (maintenance, build, alternatives) before
  committing it behind `RtcPeer`; the rest of the audio pipeline (BlueALSA HFP/SCO, ffmpeg) is a
  straight transplant.
- Confirm the native RFCOMM socket eliminates the long-session frame desync the TTY path showed
  (the socket's founding hypothesis — likely, given clean send-side packetization, but validate over a long
  session). [HYPOTHESIS]
- Exact BlueALSA isolation + D-Bus policy needed on a clean install (capture from the installer).
