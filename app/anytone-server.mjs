#!/usr/bin/env node
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { SerialPort } from 'serialport'
import { RfcommSocket } from './rfcomm-socket.mjs'
import { BtManager } from './bt-manager.mjs'
import { loadRadioid, lookupRadioid, downloadRadioid, radioidStatus, radioidPath } from './radioid.mjs'

const HTTP_PORT = Number(process.env.ANYTONE_SERVER_PORT || process.env.PORT || 3010)
const HTTP_HOST = process.env.ANYTONE_SERVER_HOST || '127.0.0.1'
// The radio's Bluetooth MAC. ANYTONE_BT_ADDR pins a specific radio; when it is
// unset (or the radio is swapped/re-paired) the BtManager discovers the radio by
// BT name and adopts it (see bt-manager.mjs). The placeholder lets the server boot
// so the UI loads; Connect resolves the real address at connect time.
const RADIO_ADDR_PLACEHOLDER = 'AA:BB:CC:DD:EE:FF'
const RADIO_ADDR = process.env.ANYTONE_BT_ADDR || RADIO_ADDR_PLACEHOLDER
// Discovery fallback: BT name pattern that identifies an AnyTone radio. Combined
// with the SPP+HFP-AG UUID check in bluez.mjs to disambiguate the radio from a head.
const RADIO_NAME_PATTERN = new RegExp(process.env.ANYTONE_BT_NAME_PATTERN || 'ELET_AGHF', 'i')
const BT_PAIRING_PIN = process.env.ANYTONE_BT_PIN || '0000'
const SPP_CHANNEL = Number(process.env.ANYTONE_SPP_CHANNEL || 2)
const RFCOMM_ID = Number(process.env.ANYTONE_RFCOMM_ID || 10)
const RFCOMM_PATH = process.env.ANYTONE_RFCOMM_PATH || `/dev/rfcomm${RFCOMM_ID}`
// BlueALSA HFP PCM path. The adapter index (hciN) and radio address are resolved
// at connect time (bluealsaPcm()), not hardcoded — survives adapter reindexing
// (hci0->hci1) and an adopted/swapped radio. This default is only a boot-time
// placeholder for the static transport descriptor; connect() overwrites it.
const BLUEALSA_PCM = process.env.ANYTONE_BLUEALSA_PCM || `/org/bluealsa/hci0/dev_${RADIO_ADDR.replace(/:/g, '_')}/hfphf/source`
// Resolve the BlueALSA HFP source PCM for a given radio address + BlueZ adapter
// path (e.g. /org/bluez/hci0). An explicit ANYTONE_BLUEALSA_PCM override wins.
function bluealsaPcm(address, adapterPath) {
  if (process.env.ANYTONE_BLUEALSA_PCM) return process.env.ANYTONE_BLUEALSA_PCM
  const hci = (adapterPath || '/org/bluez/hci0').split('/').pop() || 'hci0'
  return `/org/bluealsa/${hci}/dev_${String(address).replace(/:/g, '_')}/hfphf/source`
}
const BLUEALSA_KEEPALIVE = process.env.ANYTONE_BLUEALSA_KEEPALIVE || '30'
// Our app uses an ISOLATED BlueALSA instance under a private D-Bus name suffix
// (org.bluealsa.<suffix>) serving HFP only, installed as a managed unit by
// scripts/setup.sh. This keeps us from touching the system BlueALSA (A2DP for
// other apps) or PipeWire. All bluealsa-cli calls target this instance via -B.
const BLUEALSA_DBUS_SUFFIX = process.env.ANYTONE_BLUEALSA_DBUS ?? 'anytone'
const BLUEALSA_DBUS_NAME = `org.bluealsa${BLUEALSA_DBUS_SUFFIX ? `.${BLUEALSA_DBUS_SUFFIX}` : ''}`
const BLUEALSA_SERVICE = process.env.ANYTONE_BLUEALSA_SERVICE || `bluealsa-${BLUEALSA_DBUS_SUFFIX || 'anytone'}.service`
function bluealsaCli(args) {
  const pre = BLUEALSA_DBUS_SUFFIX ? ['-B', BLUEALSA_DBUS_SUFFIX] : []
  return spawnSync('bluealsa-cli', [...pre, ...args], { encoding: 'utf8' })
}
// Default wired serial device for the optional digirig/CAT path. Pin a stable
// device with ANYTONE_WIRED_SERIAL_PATH (e.g. /dev/serial/by-id/usb-...-port0).
const DEFAULT_WIRED_SERIAL_PATH = '/dev/ttyUSB0'
const WIRED_SERIAL_PATH = process.env.ANYTONE_WIRED_SERIAL_PATH || process.env.ANYTONE_SERIAL_PATH || DEFAULT_WIRED_SERIAL_PATH
const WIRED_SERIAL_FALLBACK_PATH = process.env.ANYTONE_WIRED_SERIAL_FALLBACK_PATH || '/dev/ttyUSB2'
const WIRED_BAUD_RATE = Number(process.env.ANYTONE_WIRED_BAUD || 115200)
const DIGIRIG_AUDIO_DEVICE = process.env.ANYTONE_DIGIRIG_AUDIO_DEVICE || process.env.CAT_AUDIO_WIRED_DEVICE || 'plughw:CARD=Device_1,DEV=0'
const DIGIRIG_AUDIO_INPUT = process.env.ANYTONE_DIGIRIG_AUDIO_INPUT || process.env.CAT_AUDIO_WIRED_INPUT || DIGIRIG_AUDIO_DEVICE
const DIGIRIG_AUDIO_OUTPUT = process.env.ANYTONE_DIGIRIG_AUDIO_OUTPUT || process.env.CAT_AUDIO_WIRED_OUTPUT || DIGIRIG_AUDIO_DEVICE
const DIGIRIG_AUDIO_SAMPLE_RATE = process.env.CAT_AUDIO_WIRED_SAMPLE_RATE || '48000'
const DIGIRIG_AUDIO_GAIN = process.env.CAT_AUDIO_WIRED_GAIN || '1.4'
const DIGIRIG_AUDIO_HIGHPASS = process.env.CAT_AUDIO_WIRED_HIGHPASS || '180'
const TRANSPORTS = {
  bt: {
    id: 'bt',
    label: 'Bluetooth',
    mode: 'EXTERNAL BT MODE',
    link: 'rfcomm',
    framing: 'raw',
    audio: {
      transport: 'bt',
      engine: 'bluealsa',
      backend: 'bluealsa',
      input: BLUEALSA_PCM,
      output: BLUEALSA_PCM.replace(/\/source$/, '/sink'),
      rxChannels: '1',
      txChannels: '1',
      sampleRate: '8000',
    },
  },
  wired: {
    id: 'wired',
    label: 'Wired digirig',
    mode: 'EXTERNAL CABLE MODE',
    link: 'serial',
    framing: 'adata',
    audio: {
      transport: 'wired',
      engine: 'alsa',
      backend: 'alsa',
      input: DIGIRIG_AUDIO_INPUT,
      output: DIGIRIG_AUDIO_OUTPUT,
      rxChannels: process.env.CAT_AUDIO_WIRED_RX_CHANNELS || '1',
      txChannels: process.env.CAT_AUDIO_WIRED_TX_CHANNELS || '1',
      sampleRate: DIGIRIG_AUDIO_SAMPLE_RATE,
      txSampleRate: process.env.CAT_AUDIO_WIRED_TX_SAMPLE_RATE || DIGIRIG_AUDIO_SAMPLE_RATE,
      gain: DIGIRIG_AUDIO_GAIN,
      highpass: DIGIRIG_AUDIO_HIGHPASS,
      squelchGate: process.env.CAT_AUDIO_WIRED_SQUELCH_GATE !== '0',
    },
  },
}
const PTT_KEEPALIVE_INTERVAL_MS = Number(process.env.ANYTONE_PTT_KEEPALIVE_INTERVAL_MS || 1000)
const SIGNAL_FRESH_MS = Number(process.env.ANYTONE_SIGNAL_FRESH_MS || 5000)
const WIRED_KEEPALIVE_INTERVAL_MS = Number(process.env.ANYTONE_WIRED_KEEPALIVE_INTERVAL_MS || 400)
const WIRED_KEEPALIVE_OPEN_INTERVAL_MS = Number(process.env.ANYTONE_WIRED_KEEPALIVE_OPEN_INTERVAL_MS || 1500)
const WIRED_PTT_KEEPALIVE_INTERVAL_MS = Number(process.env.ANYTONE_WIRED_PTT_KEEPALIVE_INTERVAL_MS || PTT_KEEPALIVE_INTERVAL_MS)
// Guard delay inserted BETWEEN the back-to-back keepalive writes (5a/5e/61). With
// no gap, our next frame can reach the radio while it is still transmitting its
// previous response; the frames coalesce in the radio's RX FIFO and desync its
// register parser, turning a poll read into a stray write (the long-session
// codeplug-corruption mechanism). A short gap keeps each transaction isolated.
const KEEPALIVE_FRAME_GAP_MS = Number(process.env.ANYTONE_KEEPALIVE_FRAME_GAP_MS || 35)
// Wired polling health window. BT does not use silence as a stale-link signal:
// the real BT-01 push stream can be quiet for a long time when nothing changes.
const LINK_STALE_MS = Number(process.env.ANYTONE_LINK_STALE_MS) || 4000
// The radio's status pushes 58/59/5c/5e/5f are ACKNOWLEDGED frames: it re-sends
// each one until the head replies `03 <op> 00 00` (4 bytes, no checksum) and will
// NOT keep streaming 5a/5b without it — the historical "5e wedge". The free 5a
// (RSSI) / 5b (squelch) pushes are NOT acked. Confirmed by relaying a real BT-01
// (a full DMR PTT→parrot-reply ran with 5a streaming and no wedge). Default ON;
// kill-switch ANYTONE_PUSH_ACK=0. See docs/BT01_HEAD_BUS_PROTOCOL.md §7.
const PUSH_ACK = !['0', 'false', 'no', 'off'].includes((process.env.ANYTONE_PUSH_ACK || '1').toLowerCase())
const ACK_PUSH_OPS = new Set([0x58, 0x59, 0x5c, 0x5e, 0x5f])
// Auto-reconnect the SPP control socket when it drops unexpectedly (the DMR-PTT
// wedge: a digital call makes the radio shed SPP while HFP audio + the BT ACL stay
// up). Re-opens ONLY the SPP socket — audio is untouched. Default ON. Settle delay
// dodges the post-drop race that makes an immediate manual reconnect flaky.
const AUTO_RECONNECT = !['0', 'false', 'no', 'off'].includes((process.env.ANYTONE_AUTO_RECONNECT || '1').toLowerCase())
const AUTO_RECONNECT_SETTLE_MS = Number(process.env.ANYTONE_AUTO_RECONNECT_SETTLE_MS || 900)
const AUTO_RECONNECT_MAX = Number(process.env.ANYTONE_AUTO_RECONNECT_MAX || 5)
// Streaming is the permanent BT model: COM CHECK END at startup enables the radio's
// unsolicited 5a/5b/5e push stream, and dispatch() ACKs the 58/59/5c/5e/5f pushes
// (PUSH_ACK) — which cured the post-TX 5e wedge the old polling model worked around.
// Matches the real BT-01 (no 61, no 5a/5e polling). Wired still polls its head-bus.
// (Formerly behind the ANYTONE_STREAM_MODE experiment toggle.)
// EXPERIMENT toggle: wrap the OUTBOUND read/keepalive family (04 reads, 61 wake,
// COM MODE) in the real BT-01's self-framing envelope `+ADATA:00,<len>\r\n..\r\n`
// instead of sending raw. The envelope carries an explicit byte count + CRLF
// delimiters, so the radio's parser counts bytes rather than relying on inter-
// byte timing — which Bluetooth SPP does not preserve. Hypothesis: this is why
// the real BT-01 runs for hours without the frame-sync desync that corrupts the
// codeplug on our raw long-session polling. ONLY the read/keepalive path is
// wrapped (via query()); the CAT write family (08 19 / 2f 03 / 57 3d) is left
// RAW because those are a different dialect that only actuates unwrapped.
const ADATA_FRAMING = ['1', 'true', 'yes', 'on'].includes((process.env.ANYTONE_ADATA_FRAMING || '').toLowerCase())
// EXPERIMENT toggle: use a raw RFCOMM socket (AF_BLUETOOTH, via FFI) instead of
// the kernel /dev/rfcommN TTY + serialport. The TTY is a byte stream that
// flattens RFCOMM packet boundaries; the raw socket sends one protocol frame per
// RFCOMM packet, reproducing the BT-01's framing. Hypothesis: this fixes the
// long-session frame-sync desync at its root (the transport layer) rather than
// papering over it with read heuristics. Default off = the proven TTY path.
const USE_RFCOMM_SOCKET = ['1', 'true', 'yes', 'on'].includes((process.env.ANYTONE_RFCOMM_SOCKET || '').toLowerCase())
const SERIAL_BAUD_RATE = Number(process.env.ANYTONE_RFCOMM_BAUD || 115200)
const CHANNELS_CSV_PATH = process.env.ANYTONE_CHANNELS_CSV || new URL('../channels.CSV', import.meta.url)
// Unsolicited-frame capture: the radio pushes status frames (squelch open/close,
// RSSI, and as-yet-unidentified messages) between polls. We log every one to an
// in-memory ring and an append-only NDJSON file for protocol investigation.
const ASYNC_LOG_LIMIT = Number(process.env.ANYTONE_ASYNC_LOG_LIMIT || 300)
const ASYNC_LOG_TO_FILE = !['0', 'false', 'no', 'off'].includes((process.env.ANYTONE_ASYNC_LOG_FILE || '1').toLowerCase())
// Default output is the gitignored ../captures/ dir (runtime/personal data must
// never be committed). Override with ANYTONE_ASYNC_LOG_PATH.
const ASYNC_LOG_PATH = process.env.ANYTONE_ASYNC_LOG_PATH
  || fileURLToPath(new URL('../captures/unsolicited.ndjson', import.meta.url))

const WAKE = Buffer.from([0x61])
// Side/VFO select write command (from jrobertfisher/at-578uv-hex-scanner).
// Confirmed working over BT SPP in RAW form (NOT +ADATA-wrapped): byte 2 = 0
// selects side A/main, 1 selects side B/sub. Toggles settings byte 37.
const SELECT_SIDE_A = Buffer.from('081900881f00207102000851060008450400084d060008', 'hex')
const SELECT_SIDE_B = Buffer.from('081901881f00207102000851060008450400084d060008', 'hex')
// Zone select (subcmd 0x39 of the 08 command family). Confirmed live over BT
// 2026-06-15 (BT-01 firmware RE): `08 39 <zero-based zone index> <20-byte tail>`
// selects that zone on the CURRENTLY-SELECTED side, and the radio loads that
// zone's stored channel. The 20-byte tail is the same template side-select (08
// 19) carries; radio ACKs `03 08 00 00 0b`. The index matches byte 34 of the
// 04 29/2a zone read (decoded as `zoneNumber`).
// Every `08 <subcmd> <value>` menu write (side-select 0x19, zone-select 0x39,
// and the audio/NR/DigiMon menu writes below) carries this same 20-byte tail —
// confirmed identical across side-select and 08 47 mic-gain captures.
const MENU_WRITE_TAIL = SELECT_SIDE_A.subarray(3) // 20-byte payload after `08 19 00`
function menuWriteFrame(subcmd, value) {
  return Buffer.concat([Buffer.from([0x08, subcmd & 0xff, value & 0xff]), MENU_WRITE_TAIL])
}
function zoneSelectFrame(zoneIndex) {
  return menuWriteFrame(0x39, zoneIndex)
}
// VFO/memory-mode write (57 3d). Same selected-side write family as the scanner
// repo; raw payload only, not ADATA-wrapped. Byte 2: 0 = memory, 1 = VFO. Radio
// ACKs `03 57 3d 00 97`. Confirmed live 2026-06-13 over BT SPP.
const VFO_MEMORY_MODE_TAIL = Buffer.from('0000881f00207102000851060008450400084d06000859030008e10c000800000000000000000000000000000000870b00080d04000800000000d5090008f90b00088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b0200088b020008', 'hex')
function vfoMemoryModeFrame(vfoMode) {
  return Buffer.concat([Buffer.from([0x57, 0x3d, vfoMode ? 0x01 : 0x00]), VFO_MEMORY_MODE_TAIL])
}
// Per-channel setting write. Same envelope as the 08 menu write but opcode 2f,
// which actuates the SELECTED SIDE's working channel (the dialect the BT-01's
// channel editor uses). Radio ACKs `03 2f 00 00`. Confirmed from BT-01 channel-
// edit relay captures (2026-06-20). See CHANNEL_SETTINGS below + docs/PROTOCOL.md.
function channelWriteFrame(subcmd, value) {
  return Buffer.concat([Buffer.from([0x2f, subcmd & 0xff, value & 0xff]), MENU_WRITE_TAIL])
}
// DMR Mode (2f 08) is structured — the option is encoded in bytes 3-4, not byte 2,
// over a fixed non-menu template. Captured (b3,b4): Simplex (1,0) · Repeater (0,0)
// · Double Slot (1,1) · Double Slot(D) (1,2). 2026-06-20 BT-01 relay.
const DMR_MODE_BYTES = { 0: [1, 0], 1: [0, 0], 2: [1, 1], 3: [1, 2] }
function dmrModeFrame(raw) {
  const [b3, b4] = DMR_MODE_BYTES[raw] ?? [0, 0]
  return Buffer.from([0x2f, 0x08, 0x00, b3, b4, 0x00, 0x00, 0x24, 0x00, 0x00, 0x00, 0x05, 0x05, 0x05, 0x05, 0x06, 0x06, 0x06, 0x06, 0x07, 0x07, 0x07, 0x07])
}
// Channel name write (2f 24): 20-byte ASCII field after `2f 24 00`, up to 16 visible
// chars (radio max), zero-padded. Confirmed from BT-01 relay (2026-06-20).
function channelNameFrame(name) {
  const field = Buffer.alloc(20)
  Buffer.from(String(name).slice(0, 16), 'ascii').copy(field)
  return Buffer.concat([Buffer.from([0x2f, 0x24, 0x00]), field])
}
// RX-frequency write (2f 03). The frequency is 4 BCD bytes of Hz/10 (the radio's
// native frequency unit), MSB first — e.g. 145.31000 MHz -> 14531000 -> `14 53 10
// 00` — followed by the captured 16-byte working-channel tail. Confirmed live
// 2026-06-13: `2f 03 00 14 53 10 00 15 50 00 00 00 00 00 00 00 00 00 00 cf 09 00 00`
// set VFO B to 145.31000. Writes the SELECTED side's working RX field. See PROTOCOL.md.
const RX_FREQ_TAIL = Buffer.from('155000000000000000000000cf090000', 'hex')
const RX_FREQ_MAX_HZ = 999_999_990
function bcd4FromHz(hz) {
  const units = Math.round(hz / 10)
  if (units < 0 || units > 99_999_999) throw new Error(`RX frequency ${hz} out of BCD range`)
  const digits = String(units).padStart(8, '0')
  const out = Buffer.alloc(4)
  for (let i = 0; i < 4; i++) out[i] = (Number(digits[i * 2]) << 4) | Number(digits[i * 2 + 1])
  return out
}
function receiveFrequencyFrame(hz) {
  return Buffer.concat([Buffer.from([0x2f, 0x03, 0x00]), bcd4FromHz(hz), RX_FREQ_TAIL])
}
// TX-frequency write (2f 04). Unlike RX (BCD), TX is a big-endian uint32 of Hz/10
// followed by a fixed tail — e.g. 145.00000 -> `00 dd 40 a0`, 444.82500 -> `02 a6
// bf c4`. Byte format decoded 2026-06-20 from BT-01 relay captures; NOT yet
// validated against a live write (offset interaction pending). See PROTOCOL.md.
const TX_FREQ_TAIL = Buffer.from('00000000050505059f80030800000000', 'hex')
function transmitFrequencyFrame(hz) {
  const be = Buffer.alloc(4)
  be.writeUInt32BE(Math.round(hz / 10) >>> 0, 0)
  return Buffer.concat([Buffer.from([0x2f, 0x04, 0x00]), be, TX_FREQ_TAIL])
}
// TX/RX CDT (CTCSS/DCS) tone write — 2f 02 TX / 16 RX / 17 RX+TX. Structured
// template `2f <sub> <type> <b3> <b4> 00 00 <b7> 00 00 00 05*4 06*4 07*4`; type
// 0 Off / 1 CTC / 2 DCS, b7=02 only for Off. CTC: b3 = 1-based CTCSS index.
// Confirmed from BT-01 relay (2026-06-20). DCS (type 2) pending more captures.
function toneFrameRaw(subcmd, type, b3, b4) {
  const b7 = type === 0 ? 0x02 : 0x00
  return Buffer.from([0x2f, subcmd & 0xff, type & 0xff, b3 & 0xff, b4 & 0xff, 0x00, 0x00, b7, 0x00, 0x00, 0x00, 0x05, 0x05, 0x05, 0x05, 0x06, 0x06, 0x06, 0x06, 0x07, 0x07, 0x07, 0x07])
}
function ctcssToneFrame(subcmd, raw) {
  return raw === 0 ? toneFrameRaw(subcmd, 0, 0, 0) : toneFrameRaw(subcmd, 1, raw, 0)
}

// Confirmed-writable global menu settings (2026-06-19 BT-01 relay capture). All
// share the `08 <subcmd> <raw> <tail>` shape and the radio only ACKs them — the
// displayed value is read back from the bulk settings blocks (Phase A offsets),
// not a dedicated read. `offset` maps the radio's on-screen value to the raw
// ── Unified radio-settings registry ──────────────────────────────────────────
// Single source of truth for every menu setting we read and (where known) write.
// Per entry:
//   block/offset : where the value is read in a settings block (05/06/09).
//   enum         : raw byte → display label; presence ⇒ enum (option-list editor).
//   add          : 0-based numeric — on-screen value = raw + add (e.g. gains/mic).
//   min/max      : on-screen range for the numeric editor (omit enum).
//   write        : 08 <subcmd> write opcode; ABSENT ⇒ read-only.
// Storage encoding is uniform: the byte we read == the byte we write (raw). The
// display value is enum[raw] or raw+add; writes convert display→raw via `add`.
// All offsets + write opcodes confirmed live 2026-06-19 (see PROTOCOL.md). To add
// a newly-mapped item: append ONE line — decode, state, projection, write, and UI
// all flow from this list. "Speaker Mode" (Voice Func item 7) is N/A on this radio.
const RADIO_SETTINGS = [
  // Dual watch / sub-channel RX (05 byte 38; also drives rxMode projection).
  { key: 'dualWatch',       label: 'Dual Watch',      block: 0x05, offset: 38, enum: { 0: 'Off', 1: 'On' }, write: 0x1b },
  // BT audio gains (0-based: display 1-5 = raw 0-4).
  { key: 'micGain',         label: 'BT Mic Gain',     block: 0x06, offset: 75, add: 1, min: 1, max: 5, write: 0x47 },
  { key: 'radioSpeakerGain',label: 'BT Speaker',      block: 0x06, offset: 76, add: 1, min: 1, max: 5, write: 0x48 },
  { key: 'bt01SpeakerGain', label: 'BT-01 Speaker',   block: 0x09, offset: 71, add: 1, min: 1, max: 5, write: 0x49 },
  // Noise reduction (literal 0-9, 0=Off) + DigiMon.
  { key: 'nrRx',            label: 'NR RX',           block: 0x09, offset: 80, min: 0, max: 9, write: 0x6b },
  { key: 'nrTx',            label: 'NR TX',           block: 0x09, offset: 85, min: 0, max: 9, write: 0x6c },
  { key: 'digiMon',         label: 'DigiMon',         block: 0x05, offset: 56, enum: { 0: 'Off', 1: 'Single', 2: 'Dual' }, write: 0x3f },
  // Voice Func menu (writes confirmed via BT-01 relay capture 2026-06-19).
  { key: 'keyTone',         label: 'Key Tone',        block: 0x05, offset: 2,  enum: { 0: 'Off' }, min: 0, max: 8, write: 0x04 }, // 0 Off, 1-8
  { key: 'digitalMicLevel', label: 'Dig Mic Lvl',     block: 0x05, offset: 14, add: 1, min: 1, max: 5, write: 0x23 },
  { key: 'smsNotify',       label: 'SMS Notify',      block: 0x05, offset: 34, enum: { 0: 'Off', 1: 'Ring' }, write: 0x1c },
  { key: 'callRing',        label: 'Call Ring',       block: 0x05, offset: 40, enum: { 0: 'Off', 1: 'Ring' }, write: 0x1d },
  { key: 'talkPermit',      label: 'Talk Permit',     block: 0x05, offset: 42, enum: { 0: 'Off', 1: 'Digital', 2: 'Analog', 3: 'Both' }, write: 0x08 },
  { key: 'dResetTone',      label: 'D-Reset Tone',    block: 0x05, offset: 43, enum: { 0: 'Off', 1: 'On' }, write: 0x09 },
  { key: 'digitalIdle',     label: 'Digital Idle',    block: 0x05, offset: 44, enum: { 0: 'Off', 1: 'Type 1', 2: 'Type 2', 3: 'Type 3' }, write: 0x05 },
  { key: 'startupSound',    label: 'Startup Sound',   block: 0x05, offset: 47, enum: { 0: 'Off', 1: 'On' }, write: 0x07 },
  { key: 'maxVolLevel',     label: 'Max Vol Lvl',     block: 0x05, offset: 49, enum: { 0: 'Indoor' }, min: 0, max: 8, write: 0x10 }, // 0 Indoor, 1-8
  { key: 'enhanceSound',    label: 'Enhance Sound',   block: 0x05, offset: 65, enum: { 0: 'Normal', 1: 'Mic Enhance', 2: 'Indoor', 3: 'Outdoor' }, write: 0x15 },
  { key: 'micSpeakerSet',   label: 'Mic Speaker Set', block: 0x09, offset: 39, enum: { 0: 'Path Main', 1: 'Path Sub' }, write: 0x0b },
  { key: 'analogIdle',      label: 'Analog Idle',     block: 0x09, offset: 62, enum: { 0: 'Off', 1: 'On' }, write: 0x06 },
  { key: 'analogMicLevel',  label: 'Ana Mic Lvl',     block: 0x09, offset: 64, add: 1, min: 1, max: 5, write: 0x24 },
  // GPS (writes 08 3c/3d/3e, contiguous with DigiMon 3f).
  { key: 'gps',             label: 'GPS',             block: 0x05, offset: 33, enum: { 0: 'Off', 1: 'On' }, write: 0x3c },
  { key: 'gpsMode',         label: 'GPS Mode',        block: 0x09, offset: 40, enum: { 0: 'GPS', 1: 'BDS', 2: 'GPS+BDS', 3: 'GLONASS', 4: 'GPS+GLONASS', 5: 'BDS+GLONASS', 6: 'ALL' }, write: 0x3d },
  { key: 'gpsAreaSql',      label: 'GPS Area SQL',    block: 0x09, offset: 76, enum: { 0: 'Off', 1: 'On' }, write: 0x3e },
  // Fan mode: write 08 16 (captured 2026-06-21; `08 16 01` = Temp). Stored raw == enum.
  { key: 'fanMode',         label: 'Fan',             block: 0x09, offset: 43, enum: { 0: 'PTT', 1: 'Temp', 2: 'Both' }, write: 0x16 },
]
const RADIO_SETTINGS_BY_KEY = Object.fromEntries(RADIO_SETTINGS.map(s => [s.key, s]))

// Standard CTCSS tone table; the radio stores tones as 1-based indexes into this
// list (0 = off). Matches the UI's CTCSS_TONES list so indexes map 1:1.
const CTCSS_TONES = [
  67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5,
  94.8, 97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3,
  131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9,
  171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5,
  203.5, 206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1,
]
// ── Per-channel settings registry (2f <subcmd> writes) ───────────────────────
// The 2f command family writes the SELECTED SIDE's working channel, byte-for-byte
// the same `<opcode> <subcmd> <raw> <20-byte MENU_WRITE_TAIL>` shape as the 08 menu
// write — only the opcode differs (2f vs 08). Radio ACKs `03 2f 00 00`. All subcmds
// + enums confirmed from BT-01 channel-edit relay captures (2026-06-20).
// Read-back for channelType/txPower/bandwidth comes from byte 10 of the 04 2c/2d
// channel block (channelSettingsRaw below); the rest are write-for-now until their
// read offsets are mapped (shown as "--"). Structured fields (TCDT/RCDT/RTCDT tones
// 02/16/17, offset 14, RX/TX freq 03/04, DMR mode 08, name 24) use non-menu-tail
// payloads and are intentionally NOT in this registry yet — they need more captures.
// `modes` gates which channel types show the setting in each VFO card:
// 'analog' hides it on digital-only channels, 'digital' hides it on analog
// channels, absent = both. (channelType 0 = analog, 1 = digital, 2/3 = A+D.)
const CHANNEL_SETTINGS = [
  { key: 'channelType',    label: 'Channel Type',    write: 0x01, enum: { 0: 'Analog', 1: 'Digital', 2: 'A+D TX-A', 3: 'D+A TX-D' } },
  { key: 'txPower',        label: 'TX Power',        write: 0x18, enum: { 0: 'Low', 1: 'Medium', 2: 'High', 3: 'Turbo' } },
  { key: 'bandwidth',      label: 'Bandwidth',       write: 0x1c, enum: { 0: 'Narrow', 1: 'Wide' }, modes: 'analog' },
  // RX/TX tone (CTCSS/DCS) are NOT in this registry — they use a dedicated tone
  // popup (type + value) and the /channel-tone endpoint. See setChannelTone.
  { key: 'squelchMode',    label: 'Squelch Mode',    write: 0x1b, enum: { 0: 'SQ', 1: 'CDT', 2: 'TONE', 3: 'C&T', 4: 'C|T' }, modes: 'analog' },
  { key: 'optionalSignal', label: 'Optional Signal', write: 0x09, enum: { 0: 'Off', 1: 'DTMF', 2: '2TONE', 3: '5TONE' }, modes: 'analog' },
  { key: 'colorCode',      label: 'Color Code',      write: 0x21, min: 0, max: 15, modes: 'digital' },
  { key: 'timeSlot',       label: 'Time Slot',       write: 0x15, enum: { 0: 'TS1', 1: 'TS2' }, modes: 'digital' },
  { key: 'txInterrupt',    label: 'TX Interrupt',    write: 0x0f, enum: { 0: 'Off', 1: 'Low Priority', 2: 'High Priority' }, modes: 'digital' },
  { key: 'busyLock',       label: 'Busy Lock',       write: 0x1f, enum: { 0: 'Off', 1: 'Different CDT', 2: 'Channel Free' } },
  { key: 'scrambler',      label: 'Scrambler',       write: 0x11, enum: { 0: 'Off', 1: '3.3k', 2: '3.2k', 3: '3.1k', 4: '3.0k', 5: '2.9k', 6: '2.8k', 7: '2.7k', 8: '2.6k', 9: '2.5k', 10: '4.095k', 11: '3.458k' }, modes: 'analog' },
  { key: 'reverse',        label: 'Reverse',         write: 0x1d, enum: { 0: 'Off', 1: 'On' }, modes: 'analog' },
  { key: 'compander',      label: 'Compander',       write: 0x10, enum: { 0: 'Off', 1: 'On' }, modes: 'analog' },
  { key: 'talkaround',     label: 'Talkaround',      write: 0x1e, enum: { 0: 'Off', 1: 'On' } },
  { key: 'txProhibit',     label: 'TX Prohibit',     write: 0x20, enum: { 0: 'Off', 1: 'On' } },
  { key: 'smsForbid',      label: 'SMS Forbid',      write: 0x0d, enum: { 0: 'Off', 1: 'On' }, modes: 'digital' },
  { key: 'dataAckForbid',  label: 'DataAck Forbid',  write: 0x0c, enum: { 0: 'Off', 1: 'On' }, modes: 'digital' },
  { key: 'aprsReceive',    label: 'APRS Receive',    write: 0x0b, enum: { 0: 'Off', 1: 'On' }, modes: 'digital' },
  // Structured: byte-2 enum, but the value lives in a custom frame (see dmrModeFrame).
  { key: 'dmrMode',        label: 'DMR Mode',        write: 0x08, enum: { 0: 'Simplex', 1: 'Repeater', 2: 'Double Slot', 3: 'Double Slot (D)' }, frame: dmrModeFrame, modes: 'digital' },
]
const CHANNEL_SETTINGS_BY_KEY = Object.fromEntries(CHANNEL_SETTINGS.map(s => [s.key, s]))
// Decode the channel-settings values we can read back from byte 10 of an 04 2c/2d
// channel block (the live type/power/bandwidth bitfield). Returns raw enum bytes.
function decodeChannelSettingsRaw(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 11) return {}
  const b10 = payload[10]
  const out = { channelType: b10 & 0x03, txPower: (b10 >> 2) & 0x03, bandwidth: (b10 >> 4) & 0x01 }
  if (payload.length >= 12) {
    // byte 11 packs the tone type (low nibble) plus three analog flags (high nibble):
    //   bits 0-1 = RX tone type, bits 2-3 = TX tone type (0 Off / 1 CTCSS / 2 DCS).
    //   The CTCSS index (12/13) and DCS code (14-17) value bytes keep STALE values
    //   when the type changes, so this byte — not their presence — is authoritative.
    //   bit 4 = Reverse, bit 5 = TX Prohibit, bit 7 = Talkaround.
    out.txToneType = (payload[11] >> 2) & 0x03
    out.rxToneType = payload[11] & 0x03
    out.reverse = (payload[11] >> 4) & 0x01
    out.txProhibit = (payload[11] >> 5) & 0x01
    out.talkaround = (payload[11] >> 7) & 0x01
  }
  // Remaining analog channel settings (offsets decoded 2026-06-20 via controlled
  // write/read diffs on a live channel — see docs/PROTOCOL.md).
  if (payload.length >= 61) {
    out.squelchMode = (payload[27] >> 4) & 0x07    // byte 27 bits 4-6
    out.optionalSignal = (payload[28] >> 4) & 0x03 // byte 28 bits 4-5
    out.busyLock = payload[28] & 0x03              // byte 28 bits 0-1
    out.compander = (payload[54] >> 3) & 0x01      // byte 54 bit 3
    out.scrambler = payload[60] & 0x0f             // byte 60 bits 0-3
  }
  // DMR (digital) channel settings (offsets decoded 2026-06-20 on a live DMR channel).
  if (payload.length >= 64) {
    out.colorCode = payload[34] & 0x0f             // byte 34 bits 0-3
    out.timeSlot = payload[35] & 0x01              // byte 35 bit 0
    out.aprsReceive = (payload[35] >> 5) & 0x01    // byte 35 bit 5
    out.txInterrupt = (payload[54] >> 4) & 0x03    // byte 54 bits 4-5
    out.smsForbid = (payload[63] >> 2) & 0x01      // byte 63 bit 2
    out.dataAckForbid = (payload[63] >> 3) & 0x01  // byte 63 bit 3
    // DMR Mode = byte 54 bit 1 (direct flag, 0 = Repeater) + byte 35 bits 2-3 (slot
    // variant: 0 Simplex / 1 Double Slot / 2 Double Slot(D)). Matches the write frame.
    const direct = (payload[54] >> 1) & 0x01
    const slot = (payload[35] >> 2) & 0x03
    out.dmrMode = direct === 0 ? 1 : (slot === 0 ? 0 : slot === 1 ? 2 : 3)
  }
  return out
}

// Per-side RX/TX tone state for the tone popup + badges, derived from the channel
// decode (CTCSS byte 12/13, DCS bytes 14-17). dir 'tx' = encode, 'rx' = decode.
// Returns null on a pure-digital channel (no analog tone) so the UI hides it.
function toneStateFor(side, dir) {
  if (side?.channelSettingsRaw?.channelType === 1) return null
  // byte 11 (txToneType/rxToneType) is authoritative; the value bytes can be stale.
  const type = dir === 'tx' ? side?.channelSettingsRaw?.txToneType : side?.channelSettingsRaw?.rxToneType
  if (type === 2) {
    const dcs = dir === 'tx' ? side?.dcsEncodeCode : side?.dcsDecodeCode
    if (dcs != null) return { type: 'dcs', value: dcs, inverted: false, display: `DCS D${String(dcs).padStart(3, '0')}` }
  } else if (type === 1) {
    const hz = dir === 'tx' ? side?.ctcssEncodeHz : side?.ctcssDecodeHz
    if (hz != null) return { type: 'ctc', value: CTCSS_TONES.indexOf(hz) + 1, display: `CTC ${hz.toFixed(1)}` }
  }
  return { type: 'off', value: 0, display: 'Off' }
}
// Build the display-ready CHANNEL_SETTINGS list for one side's raw values (same
// shape as the RADIO_SETTINGS projection). `value` is the raw byte, null = not yet
// read back (only type/power/bandwidth read back today).
function channelSettingsListFor(raws = {}) {
  // Hide settings that don't apply to this channel's type. Unknown type (not yet
  // read back) shows everything rather than over-hiding.
  const ct = raws?.channelType
  const hasDigital = ct == null || ct !== 0
  const hasAnalog = ct == null || ct !== 1
  return CHANNEL_SETTINGS.filter(f => {
    if (f.modes === 'digital') return hasDigital
    if (f.modes === 'analog') return hasAnalog
    return true
  }).map(f => {
    const raw = raws?.[f.key] ?? null
    return {
      key: f.key,
      label: f.label,
      value: raw,
      display: settingDisplay(f, raw),
      writable: true,
      type: f.enum ? 'enum' : 'num',
      min: f.min ?? null,
      max: f.max ?? null,
      editValue: raw == null ? null : raw + (f.add ?? 0),
      options: f.enum ? Object.entries(f.enum).map(([v, label]) => ({ value: Number(v), label })) : null,
    }
  })
}

// Decode every RADIO_SETTINGS value that lives in `block` out of a settings read.
// Range-guarded: enum value must be a defined key; numeric must be a plausible byte
// (≤ 60) — otherwise null (shown as "--"), so a clobbered read doesn't show garbage.
function decodeRadioSettings(block, payload) {
  const out = {}
  for (const f of RADIO_SETTINGS) {
    if (f.block !== block) continue
    const raw = payload.length > f.offset ? payload[f.offset] : null
    if (raw == null) { out[f.key] = null; continue }
    const valid = f.enum ? (f.enum[raw] !== undefined) : raw <= 60
    out[f.key] = valid ? raw : null
  }
  return out
}

// Display string for a setting's raw value (enum label, or raw+add, or "--").
function settingDisplay(f, raw) {
  if (raw == null) return '--'
  if (f.enum && f.enum[raw] !== undefined) return f.enum[raw]
  return String(raw + (f.add ?? 0))
}

// Channel select/step in the current zone. Confirmed live 2026-06-15:
// `04 2c/2d 07 55 <zero-based in-zone index> <signed dir>` selects and
// commits that channel on the currently-selected side, returning the new
// 04 2c/2d channel block. Byte 4 is the authoritative target index.
function channelSelectFrame(side, target, direction) {
  const command = side === 'B' ? 0x2d : 0x2c
  // Head-exact channel step: `04 2c/2d 01 55 <target> <dir>`, dir 0x01 up / 0x00
  // down (confirmed against real BT-01 head captures — byte 2 is 0x01, not 0x07,
  // and down uses 0x00, not 0xff). `target` is the absolute in-zone index. The
  // radio wraps a one-past index (target === channel count) back to 0 on its own,
  // so up-wrap needs no special handling. For DOWN past position 0 the head sends
  // 0xf9, the radio's "wrap to last channel in zone" sentinel — verified on two
  // codeplugs (7- and 15-channel zones both landed on the last channel), so it's a
  // constant, not 256 − count.
  const dir = direction < 0 ? 0x00 : 0x01
  return Buffer.from([0x04, command, 0x01, 0x55, target & 0xff, dir])
}

// Zone-list browse read. Confirmed shape (PROTOCOL list shapes, 2026-06-19 BT-01
// relay capture): `04 2b <1-based index> <ctx> 02 00` returns 35 bytes
// `04 2b <32-byte ASCII zone name> <cksum>`. `<ctx>` is not part of the index;
// observed `00` during the initial list draw, so we send `00`.
const ZONE_BROWSE_MAX = 250
function zoneBrowseFrame(index1) {
  return Buffer.from([0x04, 0x2b, index1 & 0xff, 0x00, 0x02, 0x00])
}
function parseZoneBrowseName(frame) {
  if (!frame || frame.length < 4 || frame[0] !== 0x04 || frame[1] !== 0x2b) return null
  return cleanFixedString(Buffer.from(frame.subarray(2, Math.min(frame.length - 1, 34))))
}

// Channel-name-by-index read: `04 2e <hi> <lo> 04 00` → 20 bytes
// `04 2e <16-byte ASCII channel name> <reserved> <cksum>`. `<entry>` is the GLOBAL
// channel index (0-based) — the SAME value the 04 4a directory stores per member,
// so 04 4a indices feed straight into 04 2e. (Walking 04 2e from 0 sequentially is
// what returned the whole codeplug before.) Entry is 16-bit (hi byte at offset 2).
function channelNameBrowseFrame(entry) {
  return Buffer.from([0x04, 0x2e, (entry >> 8) & 0xff, entry & 0xff, 0x04, 0x00])
}
function parseChannelBrowseName(frame) {
  if (!frame || frame.length < 4 || frame[0] !== 0x04 || frame[1] !== 0x2e) return null
  return cleanFixedString(Buffer.from(frame.subarray(2, Math.min(frame.length - 1, 18))))
}

// Zone channel-index list: `04 27 <zoneIndex> <page> 00 00` → `04 27 <page> <LE16
// channel indices…> 0xffff-terminated <ck>`. **Byte 2 is the 0-based zone index**
// (confirmed via BT-01 "Zones → Edit Chan" relay capture: zone 0 used `04 27 00 …`,
// zone 1 `04 27 01 …`), so this reads ANY zone's channels directly WITHOUT selecting
// it (no 08 39). Order = in-zone scroll position (position 0 = the radio's first
// channel; matches 04 2c/2d selection). Each value = 0-based global channel index
// (= channel# − 1 = 04 2e entry).
function zoneChannelsPageFrame(zoneIndex, page) {
  return Buffer.from([0x04, 0x27, zoneIndex & 0xff, page & 0xff, 0x00, 0x00])
}
function parseZoneChannelIndices(frame) {
  // Returns { indices, terminated } — terminated=true when a 0xffff marker ended the
  // list (no further pages). Bytes 0-1 = 04 27, byte 2 = page, indices from byte 3,
  // last byte is the checksum.
  if (!frame || frame.length < 4 || frame[0] !== 0x04 || frame[1] !== 0x27) return { indices: [], terminated: true }
  const indices = []
  let terminated = false
  for (let i = 3; i + 1 <= frame.length - 2; i += 2) {
    const v = frame[i] | (frame[i + 1] << 8)
    if (v === 0xffff) { terminated = true; break }
    indices.push(v)
  }
  return { indices, terminated }
}

// Active-zone directory (04 4a). Layout decoded live 2026-06-19 from a FAVORITES
// capture (member+1 matched the CPS CSV exactly): 16-byte ASCII zone name at
// offset 17, then a run of LE16 member entries from offset 34 terminated by
// 0xffff. Each entry is a 0-based GLOBAL channel index (= channel number − 1, and
// = the 04 2e entry); list order IS the in-zone position (the index 04 2c/2d
// selection takes).
function parseZoneMembers(frame) {
  if (!frame || frame.length < 36 || frame[0] !== 0x04 || frame[1] !== 0x4a) return null
  const name = cleanFixedString(Buffer.from(frame.subarray(17, 33)))
  const members = []
  for (let i = 34; i + 1 < frame.length; i += 2) {
    const v = frame[i] | (frame[i + 1] << 8)
    if (v === 0xffff) break // first 0xffff terminates the list (trailing data follows)
    members.push({ position: members.length, channelIndex: v, channelNumber: v + 1 })
  }
  return { name, members }
}

const COM_MODE = Buffer.from([0x01, ...Buffer.from('D578UV COM MODE', 'ascii')])
const COM_CHECK_END = Buffer.from([0x64, ...Buffer.from('COM CHECK END', 'ascii')])

// BT-01 mic key events: 41 <ptt> <pressed> <long> <keycode> 00 00 06.
// PTT byte is always 0 here — TX stays disabled.
const KEY_CODES = {
  up: 0x10,
  down: 0x11,
  subab: 0x0d,
  a: 0x1a,
  b: 0x1b,
  c: 0x1c,
  d: 0x1d,
  star: 0x0b,
  hash: 0x0c,
  0: 0x01, 1: 0x02, 2: 0x03, 3: 0x04, 4: 0x05,
  5: 0x06, 6: 0x07, 7: 0x08, 8: 0x09, 9: 0x0a,
}

function keyFrame(pressed, code) {
  return Buffer.from([0x41, 0x00, pressed ? 0x01 : 0x00, 0x00, code, 0x00, 0x00, 0x06])
}

// PTT uses opcode 0x56 for both analog and DMR. Analog/non-digital channels use
// the simple 23-byte form. DMR uses a structured 18-byte context tail. The BT-01
// preserves that same tail on unkey; sending an all-zero DMR release can leave
// the radio stuck in its post-TX 5e/58 status loop.
const DMR_EXTENDED_PTT = !['0', 'false', 'no', 'off'].includes((process.env.ANYTONE_DMR_EXTENDED_PTT || '1').toLowerCase())
const DMR_PTT_CALL_CLASS_OVERRIDE = parseOptionalByte(process.env.ANYTONE_DMR_PTT_CALL_CLASS)
const DMR_PTT_FLAG0_OVERRIDE = parseOptionalByte(process.env.ANYTONE_DMR_PTT_FLAG0)

function simplePttFrame(on) {
  const frame = Buffer.alloc(23)
  frame[0] = 0x56
  frame[1] = on ? 0x01 : 0x00
  return frame
}

function dmrPttTail(context) {
  if (Buffer.isBuffer(context?.dmrTail) && context.dmrTail.length === 18) return Buffer.from(context.dmrTail)
  if (Array.isArray(context?.dmrTail) && context.dmrTail.length === 18) return Buffer.from(context.dmrTail)
  const tail = Buffer.alloc(18)
  tail[0] = context.callClass & 0xff
  Buffer.from(context.contextBytes ?? []).copy(tail, 1, 0, 4)
  tail[5] = context.flag0 & 0xff
  return tail
}

function dmrPttFrame(on, context) {
  const frame = simplePttFrame(on)
  frame[3] = context.sideContext & 0xff
  // byte4 = key-down call-setup type: 0x80 for a normal channel-contact PTT, but
  // 0x06 for a manual-dial / new-address call (matches the real BT-01 head's
  // 56 01 frame — sending 0x80 with a manual target made the radio do a normal
  // channel PTT instead). Release is 0x00 for both. Decoded 2026-06-21.
  frame[4] = on ? (context.manualDial ? 0x06 : 0x80) : 0x00
  dmrPttTail(context).copy(frame, 5)
  return frame
}

function pttFrame(on, context = null) {
  if (context?.dmr && DMR_EXTENDED_PTT) return dmrPttFrame(on, context)
  return simplePttFrame(on)
}

// Build the 18-byte DMR PTT context tail from the 6 raw bytes captured at
// 04 2c/2d payload offsets 0x49-0x4e (raw = [p49, p4a, p4b, p4c, p4d, p4e]).
// This is the pre-key, validator-correct source: tail[0] = call-class byte
// (p4a), tail[1..4] = the 4 context bytes (p4b..p4e), tail[5] = the high bit of
// p49. Validated byte-exact against the radio's own 0x58 keyed-context push.
function dmrTailFrom04Raw(raw) {
  if (!Array.isArray(raw) || raw.length < 6) return null
  const tail = Buffer.alloc(18)
  tail[0] = raw[1] & 0xff
  tail[1] = raw[2] & 0xff
  tail[2] = raw[3] & 0xff
  tail[3] = raw[4] & 0xff
  tail[4] = raw[5] & 0xff
  tail[5] = (raw[0] >> 7) & 0x01
  return tail
}

// Manual-dial DMR target → 18-byte PTT context tail. This tail lands at frame[5..]
// of the 56 PTT frame (see dmrPttFrame), so it reproduces the real BT-01 head's
// manual-dial 56 layout decoded 2026-06-21 from H→R relay captures:
//   frame[5] (tail[0]) = call class — group 0x01 / private 0x00
//   frame[6] (tail[1]) = 0x00
//   frame[7..9] (tail[2..4]) = target ID/TG as 24-bit BIG-ENDIAN HEX
//        (3223436 → 0x31 0x2F 0x8C — NOT BCD; the earlier BCD guess transmitted
//        to the channel contact instead because the radio couldn't parse it.)
// A programmed channel instead uses frame[5]=0xff; manual dial carries the target.
// Returns null if the target isn't a valid 24-bit DMR ID/TG.
function manualDialPttTail(target, callType) {
  const id = Number(String(target ?? '').replace(/\D/g, ''))
  if (!Number.isInteger(id) || id <= 0 || id > 0xffffff) return null
  const group = String(callType).toLowerCase() !== 'private'
  const tail = Buffer.alloc(18)
  tail[0] = group ? 0x01 : 0x00
  tail[2] = (id >> 16) & 0xff
  tail[3] = (id >> 8) & 0xff
  tail[4] = id & 0xff
  return tail
}

function dmrTailFrom58Payload(payload) {
  if (!Buffer.isBuffer(payload) || payload[0] !== 0x58 || payload.length < 11) return null
  const record = payload.subarray(1, -1)
  if ((record[0] & 0x80) === 0) return null
  const tail = Buffer.alloc(18)
  tail[0] = record[1]
  tail[1] = record[5]
  tail[2] = record[6]
  tail[3] = record[7]
  tail[4] = record[8]
  tail[5] = (record[2] >> 7) & 0x01
  return tail
}

// Hard ceiling on a single PTT hold; the watchdog forces release if the UI
// never sends TX0 (closed tab, lost network, crashed browser).
const PTT_MAX_MS = Math.max(2000, Number(process.env.ANYTONE_PTT_MAX_MS) || 60000)

// Experimental BT key-frame variants. Only PTT over BT is documented (23-byte
// 56-frame); these probe how the wired 41-frame maps onto the BT link.
// PTT bytes are always zero in every variant.
function keyFrameVariant(variant, pressed, code) {
  if (variant.endsWith('_wake')) {
    const base = keyFrameVariant(variant.slice(0, -5), pressed, code)
    return Buffer.concat([base, Buffer.from([0x61])])
  }
  const raw41 = keyFrame(pressed, code)
  if (variant === 'raw41') return raw41
  if (variant === 'crlf41') return Buffer.concat([raw41, Buffer.from('\r\n')])
  if (variant === 'adata41') return adataWrap(raw41)
  if (variant === 'v56') {
    const frame = Buffer.alloc(23)
    frame[0] = 0x56
    frame[2] = pressed ? 0x01 : 0x00
    frame[4] = code
    return frame
  }
  const v56Pos = variant.match(/^v56_p(\d+)_k(\d+)$/)
  if (v56Pos) {
    const pressIndex = Number(v56Pos[1])
    const keyIndex = Number(v56Pos[2])
    if (pressIndex === 1 || keyIndex === 1 || pressIndex < 2 || pressIndex > 22 || keyIndex < 2 || keyIndex > 22) {
      throw new Error(`unsafe v56 position variant '${variant}'`)
    }
    const frame = Buffer.alloc(23)
    frame[0] = 0x56
    frame[pressIndex] = pressed ? 0x01 : 0x00
    frame[keyIndex] = code
    return frame
  }
  if (variant === 'adata56') {
    const frame = keyFrameVariant('v56', pressed, code)
    return adataWrap(frame)
  }
  if (variant === 'v56_k2') {
    const frame = Buffer.alloc(23)
    frame[0] = 0x56
    frame[2] = pressed ? code : 0x00
    return frame
  }
  if (variant === 'v56_k3') {
    const frame = Buffer.alloc(23)
    frame[0] = 0x56
    frame[2] = pressed ? 0x01 : 0x00
    frame[3] = code
    return frame
  }
  if (variant === 'v56_k5') {
    const frame = Buffer.alloc(23)
    frame[0] = 0x56
    frame[3] = pressed ? 0x01 : 0x00
    frame[5] = code
    return frame
  }
  throw new Error(`unknown key variant '${variant}'`)
}

function adataWrap(payload) {
  const header = `+ADATA:00,${String(payload.length).padStart(3, '0')}\r\n`
  return Buffer.concat([Buffer.from(header, 'ascii'), payload, Buffer.from('\r\n')])
}

function isAdataEnvelope(payload) {
  return Buffer.isBuffer(payload) && payload.subarray(0, 10).toString('ascii') === '+ADATA:00,'
}

function adataUnwrap(buffer) {
  const payloads = []
  const marker = Buffer.from('+ADATA:00,', 'ascii')
  let offset = 0

  while (offset < buffer.length) {
    const start = buffer.indexOf(marker, offset)
    if (start < 0) return { payloads, remainder: buffer.subarray(offset) }

    const headerEnd = buffer.indexOf('\r\n', start)
    if (headerEnd < 0) return { payloads, remainder: buffer.subarray(start) }

    const lengthText = buffer.subarray(start + marker.length, headerEnd).toString('ascii').trim()
    const length = Number.parseInt(lengthText, 10)
    if (!Number.isFinite(length) || length < 0) {
      offset = headerEnd + 2
      continue
    }

    const payloadStart = headerEnd + 2
    const payloadEnd = payloadStart + length
    if (buffer.length < payloadEnd) return { payloads, remainder: buffer.subarray(start) }

    payloads.push(Buffer.from(buffer.subarray(payloadStart, payloadEnd)))
    offset = payloadEnd
    if (buffer[offset] === 0x0d && buffer[offset + 1] === 0x0a) offset += 2
  }

  return { payloads, remainder: Buffer.alloc(0) }
}
const READ_FIRMWARE = Buffer.from('040207000000', 'hex')
const READ_SETTINGS = Buffer.from('040507000000', 'hex')
// Global menu-settings blocks: 06 = BT mic/speaker gain, 09 = BT-01 gain + noise
// reduction + fan mode (offsets confirmed 2026-06-19; see PROTOCOL.md).
const READ_SETTINGS_06 = Buffer.from('040607000000', 'hex')
const READ_SETTINGS_09 = Buffer.from('040907000000', 'hex')
// Maps a settings block code → its read frame (for the post-write re-read).
const SETTINGS_READ_FRAME = { 0x05: READ_SETTINGS, 0x06: READ_SETTINGS_06, 0x09: READ_SETTINGS_09 }
const READ_ZONE_A = Buffer.from('042907000000', 'hex')
const READ_ZONE_B = Buffer.from('042a07000000', 'hex')
const READ_CHANNEL_A = Buffer.from('042c07000000', 'hex')
const READ_CHANNEL_B = Buffer.from('042d07000000', 'hex')
// Active-zone directory (follows the selected side): the member channel list of
// whatever zone is active on the selected side. See parseZoneMembers.
const READ_ZONE_DIR = Buffer.from('044a07000000', 'hex')
const READ_CLOCK = Buffer.from('045107000000', 'hex')
const READ_STATUS_4D = Buffer.from('044d07000000', 'hex')
const READ_STATUS_5A = Buffer.from('045a07000000', 'hex')
const READ_STATUS_4E = Buffer.from('044e07000000', 'hex')
const READ_STATUS_5B = Buffer.from('045b07000000', 'hex')
const READ_STATUS_5E = Buffer.from('045e07000000', 'hex')

const STARTUP_READS = [
  ['firmware', READ_FIRMWARE],
  ['settings', READ_SETTINGS],
  ['settings 06', READ_SETTINGS_06],
  ['settings 09', READ_SETTINGS_09],
  ['zone A', READ_ZONE_A],
  ['zone B', READ_ZONE_B],
  ['channel A', READ_CHANNEL_A],
  ['channel B', READ_CHANNEL_B],
  ['status 4d', READ_STATUS_4D],
  ['status 4e', READ_STATUS_4E],
  ['clock', READ_CLOCK],
  ['status 5a', READ_STATUS_5A],
  ['status 5b', READ_STATUS_5B],
  ['status 5e', READ_STATUS_5E],
]

// One-shot re-read set used after a state-changing command (side swap, key
// press) and once at connect. NOT polled on a timer — live RSSI/squelch come
// from the radio's unsolicited 5a/5b pushes (see dispatch). These
// blocks (zone/channel/settings) are only re-read on demand because the radio
// does not reliably push them.
const REFRESH_READS = [
  ['zone A', READ_ZONE_A],
  ['zone B', READ_ZONE_B],
  ['channel A', READ_CHANNEL_A],
  ['channel B', READ_CHANNEL_B],
  ['settings', READ_SETTINGS],
  ['settings 06', READ_SETTINGS_06],
  ['settings 09', READ_SETTINGS_09],
]

const DCS_CODES = [
   23,  25,  26,  31,  32,  36,  43,  47,  51,  53,  54,  65,  71,  72,  73,
   74, 114, 115, 116, 122, 125, 131, 132, 134, 143, 145, 152, 155, 156, 162,
  165, 172, 174, 205, 212, 223, 225, 226, 243, 244, 245, 246, 251, 252, 255,
  261, 263, 265, 266, 271, 274, 306, 311, 315, 325, 331, 332, 343, 346, 351,
  356, 364, 365, 371, 411, 412, 413, 423, 431, 432, 445, 446, 452, 454, 455,
  462, 464, 465, 466, 503, 506, 516, 523, 526, 532, 546, 565, 606, 612, 624,
  627, 631, 632, 654, 662, 664, 703, 712, 723, 731, 732, 734, 743, 754,
]

const TX_POWER_LEVELS = ['LOW', 'MID', 'HIGH', 'TURBO']

const CHANNEL_PROGRAM = loadChannelProgram()

class AnyToneBackend extends EventEmitter {
  constructor() {
    super()
    this.state = emptyState()
    this.transport = TRANSPORTS.bt
    this.port = null
    this.rfcomm = null
    this.bluealsa = null
    this.wirePlumberStopped = false
    this.rxBuffer = Buffer.alloc(0)
    // Demux serial core: one continuous reader (ingest -> extractFrames ->
    // dispatch) routes every frame to (a) a waiting command, (b) the async
    // status bus, (c) liveness. `pending` holds in-flight command waiters;
    // `lastValidFrameAt` feeds the desync watchdog from the push stream.
    this.pending = []
    this.frameTaps = []            // raw-capture windows for /raw/query and /raw/send
    // Raw head-bus mirror for local BT-01 relay clients:
    // registerCache snapshots the last raw 04-read response per register so the
    // relay can answer a head's startup handshake from cached state instead of
    // re-driving the radio; rawStreamClients is the set of WebSocket subscribers
    // that receive every rx/tx frame (the /raw/ws firehose). See docs §9.
    this.registerCache = new Map()
    this.rawStreamClients = new Set()
    // Cached zone list (04 2b walk) for the picker; codeplug is static while
    // connected. Cleared on link reset so a reconnect re-enumerates.
    this.zoneListCache = null
    // Full zone→channels map (every zone's 04 4a members + 04 2e names), built in
    // the background at connect and on a forced refresh. `version` bumps when it
    // changes so the UI re-fetches; `inProgress` guards against overlapping runs.
    this.zoneChannelsCache = null
    this.zoneEnumVersion = 0
    this.zoneEnumInProgress = false
    this.lastValidFrameAt = null
    this.keepaliveTimer = null
    this.busy = Promise.resolve()
    this.connecting = false
    this.pttWatchdog = null
    this.pollPausedForPtt = false
    this.latestDmrContext = null
    this.latestDmrStatusTail = null
    this.sppReconnectPending = false
    // Owns the BT connection chain (adapter/scan/pair/trust/ACL) over BlueZ D-Bus.
    this.btManager = new BtManager({
      address: RADIO_ADDR === RADIO_ADDR_PLACEHOLDER ? null : RADIO_ADDR,
      namePattern: RADIO_NAME_PATTERN,
      pin: BT_PAIRING_PIN,
      log: msg => this.log(msg),
    })
    this.btManager.on('step', s => this.patch({ btStep: s.step, btStepDetail: s.detail, btAddress: s.address, error: null }))
  }

  // The resolved radio address (configured, persisted, or adopted by discovery).
  radioAddr() {
    return this.btManager?.address || RADIO_ADDR
  }

  // Adapter + known-radio snapshot for the UI pairing panel. Best-effort: returns
  // an error field rather than throwing if BlueZ is unreachable.
  async btStatus() {
    try {
      const [adapter, radios] = await Promise.all([this.btManager.adapterInfo(), this.btManager.listRadios()])
      return {
        ok: true,
        connected: !!this.state.connected,
        address: this.radioAddr(),
        configuredAddress: this.btManager.configuredAddress,
        step: this.state.btStep ?? null,
        adapter,
        radios,
      }
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) }
    }
  }

  getState() {
    return JSON.parse(JSON.stringify(this.state))
  }

  getState() {
    return anytoneToState(this.state)
  }

  // Bring the radio's BT link to a ready state, fully automatic over BlueZ D-Bus:
  //   1. adapter on, find radio (configured MAC or name-fallback), pair + trust
  //   2. point audio at this radio's HFP PCM on the active adapter
  //   3. start the BlueALSA HFP handler (must precede the profile connect)
  //   4. connect the ACL/HFP profile, then confirm the HFP source PCM appears
  // Returns the resolved address. The SPP control socket is opened separately.
  async ensureRadioReady() {
    const address = await this.btManager.ensureReady()
    const source = bluealsaPcm(address, this.btManager.bluez?.adapter)
    this.state.audio = { ...this.state.audio, input: source, output: source.replace(/\/source$/, '/sink') }
    await this.ensureBluealsaDaemon()
    await this.btManager.connectAcl()
    await this.waitForBluealsaPcm(15000)
    return address
  }

  async connect(options = {}) {
    if (this.state.connected || this.connecting) return this.getState()
    const transport = resolveTransport(options.transport)
    this.setTransport(transport.id)
    // A specific paired radio may be chosen in the dropdown; target it this session.
    if (this.transport.id === 'bt' && options.address) this.btManager.setTarget(options.address)
    this.connecting = true
    this.patch({ connecting: true, error: null })
    try {
      if (this.transport.id === 'bt') {
        await this.ensureRadioReady()
      }
      await this.openLink(options)
      this.latestDmrContext = null
      this.latestDmrStatusTail = null
      await this.runStartup()
      this.patch({ connected: true, connecting: false, error: null })
      // Clear any frame-sync watchdog state from a prior session (singleton).
      Object.assign(this.state, { linkHalted: false, linkHealthy: true, desyncStreak: 0, lastValidPollAt: null })
      // Initial full read happened in runStartup; BT is event-driven from here.
      // Wired has no push stream, so only wired schedules a status poll timer.
      if (this.transport.id === 'wired') this.scheduleKeepalive()
      return this.getState()
    } catch (err) {
      await this.disconnect(false)
      this.patch({ connected: false, connecting: false, error: err?.message ?? String(err) })
      throw err
    } finally {
      this.connecting = false
    }
  }

  // Schedule an SPP-only reconnect after an unexpected drop (settle delay first to
  // dodge the post-drop race, then exponential backoff). The HFP audio + BT ACL are
  // still up, so we re-open ONLY the SPP socket.
  scheduleSppReconnect(attempt) {
    if (attempt > AUTO_RECONNECT_MAX) {
      this.log(`SPP auto-reconnect gave up after ${AUTO_RECONNECT_MAX} attempts`)
      this.patch({ error: 'SPP control link dropped (DMR PTT?) and auto-reconnect failed — reconnect manually.' })
      return
    }
    const delayMs = attempt === 1 ? AUTO_RECONNECT_SETTLE_MS : Math.min(4000, AUTO_RECONNECT_SETTLE_MS * (2 ** (attempt - 1)))
    this.log(`SPP dropped — auto-reconnect attempt ${attempt}/${AUTO_RECONNECT_MAX} in ${delayMs}ms`)
    setTimeout(() => { void this.attemptSppReconnect(attempt) }, delayMs)
  }

  async attemptSppReconnect(attempt) {
    if (this.state.connected || this.connecting) return
    this.connecting = true
    this.patch({ connecting: true })
    try {
      try { if (this.port?.isOpen) await new Promise(r => this.port.close(() => r())) } catch {}
      this.port = null
      this.rxBuffer = Buffer.alloc(0)
      this.clearPending('reconnect')
      await this.openLink()          // re-creates + opens the SPP socket, re-registers handlers
      this.latestDmrContext = null
      this.latestDmrStatusTail = null
      await this.runStartup()        // re-read state + COM MODE (+ COM CHECK END in stream)
      this.patch({ connected: true, connecting: false, error: null })
      Object.assign(this.state, { linkHalted: false, linkHealthy: true, desyncStreak: 0, lastValidPollAt: null })
      if (this.transport.id === 'wired') this.scheduleKeepalive()
      this.log(`SPP auto-reconnect succeeded (attempt ${attempt})`)
    } catch (err) {
      this.log(`SPP auto-reconnect attempt ${attempt} failed: ${err?.message ?? err}`)
      this.connecting = false
      this.scheduleSppReconnect(attempt + 1)
    } finally {
      this.connecting = false
    }
  }

  // Clean disconnect = stop SPP, then drop the radio's Bluetooth ACL. Dropping
  // the BT link is the radio's normal way out of COM MODE — it returns to normal
  // operation on its own. We deliberately do NOT send COM CHECK END (the BT drop
  // is the clean terminator, and COM CHECK END corrupted the settings block under
  // heavy connect/disconnect cycling). The BlueALSA daemon + wireplumber are left
  // running for a fast, clean reconnect; POST /bt/teardown does the full release.
  async disconnect(update = true) {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer)
    this.keepaliveTimer = null
    if (this.pttWatchdog) clearTimeout(this.pttWatchdog)
    this.pttWatchdog = null
    this.pollPausedForPtt = false
    // Mark down up-front so the port 'close' / rfcomm + bluealsa 'exit' handlers
    // don't post spurious errors during this intentional teardown.
    this.state.connected = false
    // Best-effort: release PTT so we never leave the radio keyed.
    if (this.port?.isOpen) {
      await this.busy.catch(() => {})
      try {
        if (this.state.pttActive) {
          await this.sendOnly(pttFrame(false, this.latestDmrContext))
          this.state.pttActive = false
        }
      } catch (err) { this.log(`PTT release on disconnect failed (best effort): ${err?.message ?? err}`) }
    }
    if (this.port?.isOpen) await new Promise(resolve => this.port.close(() => resolve()))
    this.port = null
    this.rxBuffer = Buffer.alloc(0)
    // Full teardown (not an auto-reconnect): drop the codeplug zone/channel cache.
    this.zoneChannelsCache = null
    this.clearPending('disconnect')
    const wasBt = this.transport.id === 'bt' || !!this.rfcomm
    if (this.rfcomm && !this.rfcomm.killed) this.rfcomm.kill('SIGTERM')
    this.rfcomm = null
    if (wasBt) {
      if (!USE_RFCOMM_SOCKET) spawnSync('sudo', ['-n', 'rfcomm', 'release', String(RFCOMM_ID)], { stdio: 'ignore' })
      // Drop the radio's Bluetooth ACL -> radio leaves COM MODE, back to normal.
      await this.btManager.disconnectAcl()
      this.log('Bluetooth disconnected (radio returns to normal mode)')
    } else {
      this.log('Wired serial disconnected')
    }
    if (update) this.patch({ connected: false, connecting: false, error: null })
    return this.getState()
  }

  setTransport(id) {
    this.transport = resolveTransport(id)
    Object.assign(this.state, transportState(this.transport), { lastUpdate: Date.now() })
  }

  // Ensure OUR isolated BlueALSA instance (org.bluealsa.<suffix>, HFP-only) is up so
  // BlueZ has an HFP handler to route the radio's audio gateway to before connectAcl.
  // Cooperative by design: we only ever touch our own suffixed instance — never the
  // system BlueALSA (which may serve A2DP for other apps) and never PipeWire. The
  // instance is normally an always-on systemd unit (scripts/setup.sh); if it isn't
  // running we make a best-effort start of that unit, then fail with a clear message.
  async ensureBluealsaDaemon() {
    if (bluealsaCli(['status']).status === 0) { this.log(`BlueALSA instance ${BLUEALSA_DBUS_NAME} ready`); return }
    this.log(`BlueALSA instance ${BLUEALSA_DBUS_NAME} not running — starting ${BLUEALSA_SERVICE}`)
    spawnSync('sudo', ['-n', 'systemctl', 'start', BLUEALSA_SERVICE], { stdio: 'ignore' })
    const deadline = Date.now() + 6000
    while (Date.now() < deadline) {
      if (bluealsaCli(['status']).status === 0) { this.log(`BlueALSA instance ${BLUEALSA_DBUS_NAME} ready`); return }
      await delay(300)
    }
    throw new Error(`BlueALSA instance ${BLUEALSA_DBUS_NAME} is not available — run scripts/setup.sh to install it (it never touches the system BlueALSA).`)
  }

  // Wait for THIS radio's HFP source PCM (resolved dynamically into state.audio) to
  // register on our instance after the profile connect.
  async waitForBluealsaPcm(ms) {
    const pcm = this.state.audio?.input || BLUEALSA_PCM
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const r = bluealsaCli(['list-pcms'])
      if (r.status === 0 && `${r.stdout || ''}`.includes(pcm)) { this.log(`BlueALSA HFP ready: ${pcm}`); return }
      await delay(350)
    }
    throw new Error(`BlueALSA HFP PCM did not appear on ${BLUEALSA_DBUS_NAME}: ${pcm}`)
  }

  // Nothing to stop: our instance is a shared, always-on service (and never the
  // system daemon). Dropping the ACL in disconnect() already releases the HFP PCM.
  stopBluealsaHfp() {}

  async openLink() {
    if (this.transport.link === 'serial') {
      const path = wiredSerialPath()
      this.port = new SerialPort({ path, baudRate: WIRED_BAUD_RATE, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false })
      this.log(`Opening wired digirig serial link: ${path} @ ${WIRED_BAUD_RATE}`)
    } else if (USE_RFCOMM_SOCKET) {
      // Raw RFCOMM socket: no kernel rfcomm bind / TTY. One write => one RFCOMM
      // packet, preserving frame boundaries (see rfcomm-socket.mjs).
      this.port = new RfcommSocket(this.radioAddr(), SPP_CHANNEL, { connectTimeoutMs: 12000 })
    } else {
      spawnSync('sudo', ['-n', 'rfcomm', 'release', String(RFCOMM_ID)], { stdio: 'ignore' })
      await delay(250)
      const args = ['-n', 'rfcomm', 'connect', RFCOMM_PATH, this.radioAddr(), String(SPP_CHANNEL)]
      this.rfcomm = spawn('sudo', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let rfcommLog = ''
      this.rfcomm.stdout?.on('data', chunk => { rfcommLog += chunk.toString() })
      this.rfcomm.stderr?.on('data', chunk => { rfcommLog += chunk.toString() })
      this.rfcomm.on('exit', (code, signal) => {
        if (this.state.connected) {
          this.patch({ connected: false, error: `RFCOMM closed (${signal ?? code})` })
        }
      })

      const deadline = Date.now() + 12000
      while (!existsSync(RFCOMM_PATH) && Date.now() < deadline) await delay(100)
      if (!existsSync(RFCOMM_PATH)) throw new Error(`RFCOMM device did not appear: ${rfcommLog.trim() || RFCOMM_PATH}`)

      this.port = new SerialPort({ path: RFCOMM_PATH, baudRate: SERIAL_BAUD_RATE, autoOpen: false })
    }
    this.port.on('data', chunk => this.ingest(Buffer.from(chunk)))
    this.port.on('error', err => this.patch({ error: err.message }))
    this.port.on('close', () => {
      // connected===false already => intentional disconnect (or mid-reconnect): ignore.
      if (!this.state.connected) return
      this.patch({ connected: false, error: this.transport.link === 'serial' ? 'Wired serial port closed' : USE_RFCOMM_SOCKET ? 'RFCOMM socket closed' : 'SPP serial port closed' })
      if (AUTO_RECONNECT && this.transport.id === 'bt' && !this.connecting) this.scheduleSppReconnect(1)
    })
    await new Promise((resolve, reject) => this.port.open(err => err ? reject(err) : resolve()))
    if (this.transport.link === 'serial' && typeof this.port.set === 'function') {
      await new Promise((resolve, reject) => this.port.set({ rts: false, dtr: false }, err => err ? reject(err) : resolve()))
    }
  }

  // Initial full read of everything static-ish (firmware, settings, zones,
  // channels, clock, status) - done once at connect. BT live RSSI/squelch are
  // push-driven after this; wired polls 04 5a because it has no push stream.
  async runStartup() {
    await this.enqueue(async () => {
      for (let i = 0; i < 3; i += 1) {
        await this.sendOnly(WAKE)
        await delay(120)
      }
      await this.sendCommand(COM_MODE, { match: matchAck(0x01), timeoutMs: 900, label: 'COM MODE' }).catch(err => this.log(`COM MODE: ${err?.message ?? err}`))
      await delay(120)
      await this.sendCommand(COM_MODE, { match: matchAck(0x01), timeoutMs: 900, label: 'COM MODE' }).catch(err => this.log(`COM MODE: ${err?.message ?? err}`))
      for (const [label, payload] of STARTUP_READS) {
        await delay(90)
        // dispatch() applies every read response to state; the match just confirms arrival.
        await this.sendCommand(payload, { match: matchHead(0x04, payload[1]), timeoutMs: 1100, label }).catch(err => this.log(`startup read ${label}: ${err?.message ?? err}`))
      }
      // Enumerate every zone's channels into the cache, BEFORE COM CHECK END enables
      // the push stream — so the heavy zone-stepping reads run on a quiet link and
      // don't fight unsolicited 5a/5b pushes. Skipped if already cached (e.g. an SPP
      // auto-reconnect keeps the static codeplug cache). Best-effort.
      if (!this.zoneChannelsCache) {
        await this.enumerateAllZonesInline().catch(err => this.log(`startup zone enumeration: ${err?.message ?? err}`))
      }
      // Enable the radio's unsolicited 5a/5b/5e push stream (BT only). Sent LAST so
      // its echo can't bleed into the clean 04 05 read. The pushes are ACKed in
      // dispatch() (PUSH_ACK), which is what prevents the post-TX 5e wedge; wired has
      // no native stream and polls 04 5a instead.
      if (this.transport.id !== 'wired') {
        await delay(90)
        await this.sendCommand(COM_CHECK_END, { match: matchAck(0x64), timeoutMs: 900, label: 'COM CHECK END (enable streaming)' }).catch(err => this.log(`COM CHECK END: ${err?.message ?? err}`))
      }
      await delay(150)
    })
  }

  keepaliveDelayMs() {
    if (this.transport.id !== 'wired') return null
    if (this.state.pttActive || this.pollingPausedForPtt()) return WIRED_PTT_KEEPALIVE_INTERVAL_MS
    return this.state.signal?.squelchOpen ? WIRED_KEEPALIVE_OPEN_INTERVAL_MS : WIRED_KEEPALIVE_INTERVAL_MS
  }

  scheduleKeepalive(delayMs = this.keepaliveDelayMs()) {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer)
    if (delayMs == null) { this.keepaliveTimer = null; return }
    this.keepaliveTimer = setTimeout(() => void this.keepaliveTick(), delayMs)
  }

  pollingPausedForPtt() {
    return this.pollPausedForPtt || this.state.pttActive
  }

  // Recurring wired liveness/status tick. BT has no steady-state keepalive: the
  // radio pushes signal/status and the socket close handler reports real drops.
  // Wired has no native stream, so it polls 04 5a for the smeter (paused during
  // a key-down). Zone/channel/settings are read once at connect + on command.
  async keepaliveTick() {
    if (!this.port?.isOpen || this.state.linkHalted || this.transport.id !== 'wired') return
    try {
      await this.enqueue(async () => {
        if (this.pollingPausedForPtt()) await this.sendOnly(WAKE)
        else await this.sendCommand(READ_STATUS_5A, { match: matchHead(0x04, 0x5a), timeoutMs: 600, label: 'status 5a' }).catch(() => {})
        this.state.pollCount += 1
        this.state.lastPollAt = Date.now()
        const fresh = this.lastValidFrameAt != null && (Date.now() - this.lastValidFrameAt) < LINK_STALE_MS
        this.assessLinkHealth(fresh ? 1 : 0)
        this.emitState()
      })
    } catch (err) {
      this.patch({ error: err?.message ?? String(err) })
    } finally {
      if (this.state.connected && !this.state.linkHalted && this.transport.id === 'wired') this.scheduleKeepalive()
    }
  }

  // Wired poll-health tracking only. BT silence is normal; real BT drops are
  // reported by the socket 'close' handler instead of inferred from missing pushes.
  assessLinkHealth(validReads) {
    if (validReads > 0) {
      if (this.state.desyncStreak > 0) this.log(`link resynced after ${this.state.desyncStreak} stale tick(s)`)
      this.state.desyncStreak = 0
      this.state.linkHealthy = true
      this.state.lastValidPollAt = Date.now()
      return
    }
    this.state.desyncStreak += 1
    this.state.linkHealthy = false
  }

  // One-shot re-read of zone/channel/settings after a state-changing command.
  // Event-driven, not a timer. Any unsolicited frames the radio pushes in
  // response to the command are also captured by the continuous reader / async log.
  async refreshState() {
    if (!this.port?.isOpen) return
    try {
      await this.enqueue(async () => {
        for (const [label, payload] of REFRESH_READS) {
          await this.sendCommand(payload, { match: matchHead(0x04, payload[1]), timeoutMs: 800, label }).catch(err => this.log(`refresh read ${label}: ${err?.message ?? err}`))
          await delay(45)
        }
        this.emitState()
      })
    } catch (err) {
      this.patch({ error: err?.message ?? String(err) })
    }
  }

  async enqueue(fn) {
    const next = this.busy.then(fn, fn)
    this.busy = next.catch(() => {})
    return next
  }

  async writeOnly(payload, options = {}) {
    if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
    const outbound = this.encodeOutbound(payload, options)
    // Mirror the host→radio frame to raw subscribers BEFORE the wire write so the
    // relay log preserves causal order (tx then the radio's rx response). We emit
    // the logical payload, not the (optionally ADATA-wrapped) on-wire bytes.
    this.broadcastRaw('tx', payload)
    await new Promise((resolve, reject) => this.port.write(outbound, err => err ? reject(err) : this.port.drain(err2 => err2 ? reject(err2) : resolve())))
  }

  // Send one raw head-bus frame to every /raw/ws subscriber. JSON is built once;
  // a client that has gone away (readyState !== OPEN) is dropped from the set so a
  // dead relay can't accumulate or wedge the radio path. Never throws.
  broadcastRaw(dir, frame) {
    if (!this.rawStreamClients.size) return
    const msg = JSON.stringify({ dir, hex: Buffer.from(frame).toString('hex'), ts: Date.now() })
    for (const ws of this.rawStreamClients) {
      if (ws.readyState !== 1 /* OPEN */) { this.rawStreamClients.delete(ws); continue }
      try { ws.send(msg) } catch { this.rawStreamClients.delete(ws) }
    }
  }

  // Write a head-originated frame to the radio through the single-writer queue so
  // it interleaves safely with backend reads/keepalive and PUSH_ACK writes. No
  // matcher: the radio's response returns asynchronously on the rx firehose.
  async injectRaw(frame) {
    return this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      await this.writeOnly(Buffer.from(frame), { allowBtAdata: true })
    })
  }

  encodeOutbound(payload, options = {}) {
    if (this.transport.framing === 'adata') return isAdataEnvelope(payload) ? payload : adataWrap(payload)
    if (options.allowBtAdata && ADATA_FRAMING) return isAdataEnvelope(payload) ? payload : adataWrap(payload)
    return payload
  }

  // ── Demux serial core ────────────────────────────────────────────────────
  // Transport-aware incremental framer: complete frames + trailing remainder.
  extractFrames(buffer) {
    if (this.transport.framing !== 'adata') return extractRawFrames(buffer)
    const { payloads, remainder } = adataUnwrap(buffer)
    return { frames: payloads.flatMap(payload => splitFrames(payload)), remainder, dropped: 0 }
  }

  // Continuous reader: append bytes, pull every complete frame, dispatch each.
  // rxBuffer holds ONLY the trailing partial frame and is never cleared by a
  // command — so unsolicited pushes are never dropped mid-transaction.
  ingest(chunk) {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk])
    const { frames, remainder } = this.extractFrames(this.rxBuffer)
    this.rxBuffer = remainder
    let emit = false
    for (const frame of frames) {
      if (this.dispatch(frame)) emit = true
    }
    if (emit) this.emitState()
  }

  // Route one frame: always refresh live state + liveness, then resolve the
  // first waiting command whose predicate matches. Command responses also carry
  // state (e.g. 04 2c channel), so they pass through applyDecoded here too.
  // Returns true if the frame warrants a UI push.
  dispatch(frame) {
    const now = Date.now()
    const decoded = decodePayload(frame)
    this.recordAsyncFrame(decoded, now)
    if (checksumOk(frame) === true) this.lastValidFrameAt = now
    // Mirror every inbound frame to the raw head-bus subscribers (relay firehose),
    // and snapshot read responses (04 <reg> …) so the relay can serve a head's
    // startup from cached state. Cheap + side-effect-free for the normal path.
    this.broadcastRaw('rx', frame)
    if (frame.length >= 2 && frame[0] === 0x04) this.registerCache.set(frame[1], Buffer.from(frame))
    // Wedge fix: ACK the radio's acknowledged status pushes (58/59/5c/5e/5f) with
    // `03 <op> 00 00`, or it re-sends the same frame forever and stops streaming
    // 5a/5b. These opcodes only appear as a frame head on a bare push (read
    // responses start 0x04), so the head byte alone identifies them; 5a/5b are
    // intentionally excluded. Fire-and-forget — never block dispatch on the write.
    if (PUSH_ACK && ACK_PUSH_OPS.has(frame[0])) {
      this.writeOnly(Buffer.from([0x03, frame[0], 0x00, 0x00])).catch(() => {})
    }
    // Classify: a frame matching a pending waiter is a COMMAND RESPONSE; anything
    // else is an UNSOLICITED push. Match first so we can apply state accordingly.
    let matched = null
    for (let k = 0; k < this.pending.length; k += 1) {
      if (this.pending[k].match(decoded, frame)) { matched = this.pending.splice(k, 1)[0]; break }
    }
    const prevDmrId = this.state.dmrActivity?.id
    const prevDmrActive = this.state.dmrActivity?.active
    const prevDmrTg = this.state.dmrActivity?.talkgroup
    // Command responses update ALL state. Unsolicited frames update ONLY the live
    // status types (signal/rx-status/async-status) — same as the pre-refactor
    // async path. This stops an unsolicited 04 05/zone/channel push from silently
    // flipping selectedSide (which the radio reports as RX auto-focuses a side)
    // and corrupting the per-side smeter mapping.
    const liveStatus = decoded.type === 'signal' || decoded.type === 'rx-status' || decoded.type === 'async-status'
    if (matched || liveStatus) applyDecoded(this.state, decoded, now)
    // Feed any raw-capture taps (the /raw/query, /raw/send experimental reads).
    for (const tap of this.frameTaps) tap.frames.push(frame)
    if (matched) { clearTimeout(matched.timer); matched.resolve({ frame, decoded }) }
    // 0x58 DMR context can arrive several times/second; only push to the UI when
    // the caller id/active state actually changed (matches prior gating).
    if (decoded.type === 'async-status') {
      return this.state.dmrActivity?.id !== prevDmrId || this.state.dmrActivity?.active !== prevDmrActive || this.state.dmrActivity?.talkgroup !== prevDmrTg
    }
    return EMIT_TYPES.has(decoded.type) && (matched != null || liveStatus)
  }

  // Write a frame and resolve when a frame matching `match(decoded, frame)`
  // arrives, or reject on timeout (replaces the old idle-window readResponse).
  // Call inside enqueue() so only one command is in flight; async pushes still
  // flow through dispatch concurrently.
  sendCommand(frame, { match, timeoutMs = 800, label, onSent } = {}) {
    if (!this.port?.isOpen) return Promise.reject(new Error(`${this.transport.label} link is not connected`))
    return new Promise((resolve, reject) => {
      // Register the waiter BEFORE writing so a fast ACK can't race the listener.
      const waiter = { match: match || (() => true), resolve, reject, timer: null }
      const remove = () => { const i = this.pending.indexOf(waiter); if (i >= 0) this.pending.splice(i, 1) }
      waiter.timer = setTimeout(() => { remove(); reject(new Error(`timeout waiting for ${label ?? hexdump(frame)}`)) }, timeoutMs)
      this.pending.push(waiter)
      this.writeOnly(frame, { allowBtAdata: true }).then(() => { if (onSent) onSent() }, err => { remove(); clearTimeout(waiter.timer); reject(err) })
    })
  }

  // Convenience: send and ignore the response (still flows through dispatch).
  async sendOnly(frame) {
    await this.writeOnly(frame, { allowBtAdata: true })
  }

  // Reject any in-flight command waiters and drop capture taps (on link reset).
  clearPending(reason) {
    for (const waiter of this.pending) { clearTimeout(waiter.timer); waiter.reject(new Error(`link reset: ${reason}`)) }
    this.pending = []
    this.frameTaps = []
    // Drop the register snapshot on link reset so the relay never serves a head's
    // startup from stale state; the backend re-reads on reconnect (runStartup).
    this.registerCache.clear()
    this.zoneListCache = null
    // NOTE: zoneChannelsCache is NOT cleared here — it's static codeplug data that
    // should survive an SPP auto-reconnect (so we don't re-enumerate on every drop).
    // It is cleared on a full disconnect instead.
    this.lastValidFrameAt = null
  }

  // Optionally write `frame`, then collect every dispatched frame for an
  // idle-bounded window and return the concatenated bytes. Used by the
  // experimental capture endpoints (/raw/query, /raw/send, keytest, ptttest)
  // that want "whatever the radio said," not a single matched response.
  async captureWindow(frame, { timeoutMs = 800, idleMs = 120 } = {}) {
    const tap = { frames: [] }
    this.frameTaps.push(tap)
    try {
      if (frame) await this.writeOnly(frame, { allowBtAdata: true })
      const start = Date.now()
      let lastLen = 0
      let lastChange = Date.now()
      while (Date.now() - start < timeoutMs) {
        if (tap.frames.length !== lastLen) { lastLen = tap.frames.length; lastChange = Date.now() }
        if (tap.frames.length && Date.now() - lastChange >= idleMs) break
        await delay(15)
      }
      return Buffer.concat(tap.frames)
    } finally {
      this.frameTaps = this.frameTaps.filter(t => t !== tap)
    }
  }

  async pressKey(code, { holdMs = 120, variant = 'raw41' } = {}) {
    const responses = await this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      const pressResp = await this.captureWindow(keyFrameVariant(variant, true, code), { timeoutMs: 400, idleMs: 100 })
      await delay(holdMs)
      const releaseResp = await this.captureWindow(keyFrameVariant(variant, false, code), { timeoutMs: 400, idleMs: 100 })
      return { press: hexdump(pressResp), release: hexdump(releaseResp) }
    })
    this.log(`key 0x${code.toString(16).padStart(2, '0')} (${variant}) press resp: ${responses.press || '<none>'} | release resp: ${responses.release || '<none>'}`)
    // A key press can change zone/channel — re-read those blocks once.
    void this.refreshState()
    return responses
  }

  async selectSideInTransaction(side) {
    const frame = side === 'B' ? SELECT_SIDE_B : SELECT_SIDE_A
    await this.sendOnly(frame)
    await delay(90)
    // Authoritative: we just commanded this side active, so set it directly rather
    // than reading 04 05 back (which races + would re-read settings unnecessarily).
    // This also keeps the 5a per-side smeter mapping (relative to active side) right.
    this.state.selectedSide = side
  }

  // Select the active TX/RX side (A/main or B/sub) over BT. Confirmed write.
  // Mirrors the real BT-01 head's side-swap sequence: write 08 19, then re-read
  // BOTH channel blocks (04 2c + 04 2d) so each VFO readout is current. We do NOT
  // re-read the settings/zone blocks — the head doesn't, and settings are confirmed
  // at write time by their ACK (the 04 05 read here used to race + clobber).
  async selectSide(side) {
    await this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      await this.selectSideInTransaction(side)
      for (const [label, payload, matchSide] of [['channel A', READ_CHANNEL_A, 'A'], ['channel B', READ_CHANNEL_B, 'B']]) {
        await this.sendCommand(payload, { match: matchChannel(matchSide), timeoutMs: 700, label }).catch(err => this.log(`side-select ${label} read: ${err?.message ?? err}`))
        await delay(45)
      }
    })
    this.log(`select side ${side}`)
    this.emitState()
    return this.getState()
  }

  // Toggle selected side between VFO and memory mode using confirmed 57 3d writes.
  async setVfoMemoryMode(vfoMode, targetSide = null) {
    const side = targetSide === 'B' ? 'B' : targetSide === 'A' ? 'A' : (this.state.selectedSide === 'B' ? 'B' : 'A')
    if (this.state.selectedSide !== side) await this.selectSide(side)
    const channelRead = side === 'B' ? READ_CHANNEL_B : READ_CHANNEL_A
    await this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      await this.sendCommand(vfoMemoryModeFrame(!!vfoMode), { match: (_d, f) => f[0] === 0x03 && f[1] === 0x57 && f[2] === 0x3d, timeoutMs: 900, label: `set ${side} ${vfoMode ? 'VFO' : 'memory'} mode` })
      await delay(200)
      await this.sendCommand(channelRead, { match: matchChannel(side), timeoutMs: 800, label: `re-read channel ${side}` }).catch(err => this.log(`VFO/memory re-read ${side}: ${err?.message ?? err}`))
    })
    const sideObj = this.state.sides?.[side]
    if (sideObj) sideObj.vfoMode = vfoMode ? 'VFO' : 'MEMORY'
    this.log(`set ${side} ${vfoMode ? 'VFO' : 'memory'} mode (57 3d ${vfoMode ? '01' : '00'})`)
    this.emitState()
    return this.getState()
  }

  // Select a zone (zero-based index) on the currently-active side. Confirmed BT
  // write `08 39 <idx> <tail>`. The radio does NOT push zone/channel unsolicited,
  // so we re-read this side's zone + channel inline and emit, giving an immediate
  // event-driven UI update with no polling.
  async selectZone(zoneIndex) {
    const side = this.state.selectedSide === 'B' ? 'B' : 'A'
    const idx = Math.max(0, Number(zoneIndex) | 0)
    const reads = side === 'B' ? [READ_ZONE_B, READ_CHANNEL_B] : [READ_ZONE_A, READ_CHANNEL_A]
    await this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      await this.sendOnly(zoneSelectFrame(idx))
      // The radio loads the new zone's channel a beat after ACKing 08 39; settle
      // briefly so the channel re-read below reflects the new zone's channel.
      await delay(200)
      for (const payload of reads) {
        await delay(KEEPALIVE_FRAME_GAP_MS)
        // dispatch() applies the zone/channel response to state.
        await this.sendCommand(payload, { match: matchHead(0x04, payload[1]), timeoutMs: 700, label: `read 04${payload[1].toString(16)}` }).catch(err => this.log(`zone re-read 04${payload[1].toString(16)}: ${err?.message ?? err}`))
      }
    })
    this.log(`select zone ${idx} on side ${side}`)
    this.emitState()
    return this.getState()
  }

  // Step a side's zone up (+1) or down (-1) from its current index. Defaults to
  // the selected side; a targetSide selects that side first so the per-panel
  // Zone +/- buttons act on their own side (mirrors stepChannel). The host owns
  // all wrap math because 08 39 does not safely wrap out-of-range indices.
  async stepZone(direction, targetSide = null) {
    const side = targetSide === 'B' ? 'B' : targetSide === 'A' ? 'A' : (this.state.selectedSide === 'B' ? 'B' : 'A')
    if (this.state.selectedSide !== side) await this.selectSide(side)
    const sideState = this.state.sides?.[side]
    const cur = sideState?.zoneNumber
    if (cur == null) throw new Error('current zone unknown — read state before stepping')
    // Recovery: if we're sitting on a phantom (out-of-range) zone — e.g. left there
    // before the host owned bounds — its name reads blank. Any step bounces back to
    // the first real zone rather than wandering deeper or mislearning the count.
    if (!(sideState.zone ?? '').trim() && cur > 0) return this.selectZone(0)
    // Unlike channels (where 04 2c has a real one-past wrap and a 0xf9 sentinel),
    // 08 39 does NOT safely wrap: the real BT-01 head only ever sends valid in-range
    // indices and computes wrap-around itself. Selecting an out-of-range index lands
    // on a phantom zone, so the host must own all zone bounds. We learn the zone
    // count the first time an up-step crosses the end (the new zone reads back blank
    // / non-matching), then bounce to zone 0; thereafter wraps are exact both ways.
    // Authoritative count: the host enumerates every zone (04 2b walk) at connect,
    // so zoneListCache.length is the true total even before any up-step has probed
    // the end. Prefer the per-side learned count, then the enumerated list, and only
    // then the looser zoneMaxSeen fallback. Without this, a zone-down at index 0 had
    // no count to wrap against and silently stayed put (channels avoid this via the
    // radio's own 0xf9 "last channel" sentinel; 08 39 has no equivalent).
    const knownZoneCount = sideState.zoneCount ?? (this.zoneListCache?.length || null)
    if (direction < 0) {
      if (cur > 0) return this.selectZone(cur - 1)
      const last = knownZoneCount != null ? knownZoneCount - 1 : (sideState.zoneMaxSeen ?? 0)
      return this.selectZone(last)
    }
    // Up. If we already know the count, wrap cleanly without ever overshooting.
    if (knownZoneCount != null) {
      return this.selectZone(cur + 1 >= knownZoneCount ? 0 : cur + 1)
    }
    // Count unknown: probe one-past and validate the read-back. A real zone reports
    // its own index with a non-empty name; a phantom zone past the end does not, so
    // cur was the last real zone — record the count and wrap to the first zone.
    const target = cur + 1
    await this.selectZone(target)
    const landed = sideState.zoneNumber
    const name = (sideState.zone ?? '').trim()
    if (landed === target && name.length > 0) return this.getState()
    sideState.zoneCount = target
    this.log(`learned ${target} zones on side ${side} (up past end → wrap to 0)`)
    return this.selectZone(0)
  }

  // Step the selected side's channel within the current zone. The command itself
  // returns the new channel block, so we apply that response directly and emit
  // state without a follow-up poll. If a target side is supplied, select it first
  // inside the same transaction because the selector only commits on the active side.
  async stepChannel(direction, targetSide = null) {
    const side = targetSide === 'B' ? 'B' : targetSide === 'A' ? 'A' : (this.state.selectedSide === 'B' ? 'B' : 'A')
    const cur = this.state.sides?.[side]?.channelPosition
    if (cur == null) throw new Error('current channel position unknown — read state before stepping')
    // Up: absolute cur+1 (radio wraps one-past back to 0). Down: absolute cur-1,
    // except wrapping down from position 0 uses the 0xf9 "last channel" sentinel,
    // which the radio resolves to the last channel in the zone with no count needed.
    const next = direction < 0 ? (cur === 0 ? 0xf9 : cur - 1) : (cur + 1) & 0xff
    let updated = false
    await this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      if (this.state.selectedSide !== side) await this.selectSideInTransaction(side)
      // The selector returns the new channel block; dispatch() applies it.
      const r = await this.sendCommand(channelSelectFrame(side, next, direction), { match: matchChannel(side), timeoutMs: 900, label: `channel step ${side}` }).catch(() => null)
      updated = r?.decoded?.type === 'channel'
      if (!updated) {
        await delay(KEEPALIVE_FRAME_GAP_MS)
        const fb = await this.sendCommand(side === 'B' ? READ_CHANNEL_B : READ_CHANNEL_A, { match: matchChannel(side), timeoutMs: 700, label: `re-read channel ${side}` }).catch(() => null)
        updated = fb?.decoded?.type === 'channel'
      }
    })
    // Stepping a channel commits on (and makes active) the stepped side, so keep
    // selectedSide/txVfo consistent with it — the UI active highlight and the 5a
    // smeter mapping both key off this.
    this.state.selectedSide = side
    this.log(`step channel ${direction < 0 ? 'down' : 'up'} to index ${next} on side ${side}${updated ? '' : ' (no channel response)'}`)
    this.emitState()
    return this.getState()
  }

  // Jump the active (or given) side directly to an absolute in-zone channel index
  // — the picker's "click a channel" path. Reuses channelSelectFrame (byte 4 is
  // the authoritative target); direction is derived from the current position so
  // the radio's up/down wrap behaviour stays consistent with stepChannel.
  async selectChannel(targetIndex, targetSide = null) {
    const side = targetSide || this.state.selectedSide || 'A'
    const idx = Math.max(0, Number(targetIndex) | 0)
    const cur = this.state.sides?.[side]?.channelPosition ?? 0
    const direction = idx >= cur ? 1 : -1
    await this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      const r = await this.sendCommand(channelSelectFrame(side, idx, direction), { match: matchChannel(side), timeoutMs: 900, label: `channel select ${side} ${idx}` }).catch(() => null)
      if (r?.decoded?.type !== 'channel') {
        await this.sendCommand(side === 'B' ? READ_CHANNEL_B : READ_CHANNEL_A, { match: matchChannel(side), timeoutMs: 700, label: `re-read channel ${side}` }).catch(() => null)
      }
    })
    // Selecting a channel commits on + makes active the stepped side (mirrors stepChannel).
    this.state.selectedSide = side
    this.log(`select channel index ${idx} on side ${side}`)
    this.emitState()
    return this.getState()
  }

  // Jump directly to a zone + in-zone channel position on a side (the channel-list
  // "click a channel" path). Switches the side active if needed, selects the zone
  // (08 39), then the channel (04 2c/2d). One user action → zone + channel.
  async selectZoneChannel(zoneIndex, position, targetSide = null) {
    const side = targetSide === 'B' ? 'B' : targetSide === 'A' ? 'A' : (this.state.selectedSide === 'B' ? 'B' : 'A')
    if (this.state.selectedSide !== side) await this.selectSide(side)
    await this.selectZone(zoneIndex)
    await this.selectChannel(position, side)
    this.log(`jump to zone ${zoneIndex} channel ${position} on side ${side}`)
    return this.getState()
  }

  // Walk the zone list via 04 2b until a blank name or a wrap back to the first
  // zone, or the safety cap. Returns [{ index (0-based), name }]. The browse index
  // is 0-based and matches the 08 39 select index (zone 0 = e.g. FAVORITES — an
  // earlier 1-based loop skipped it). Cached for the session (codeplug is static
  // while connected); invalidated on link reset. Pure browse — does NOT change
  // the radio's active zone.
  async enumerateZones({ force = false } = {}) {
    if (!force && this.zoneListCache) return this.zoneListCache
    const zones = await this.enqueue(async () => {
      const out = []
      for (let i = 0; i < ZONE_BROWSE_MAX; i += 1) {
        const r = await this.sendCommand(zoneBrowseFrame(i), { match: matchHead(0x04, 0x2b), timeoutMs: 700, label: `zone browse ${i}` }).catch(() => null)
        const name = r ? parseZoneBrowseName(r.frame) : null
        // Stop on blank, or a wrap (radio repeats the first zone past the end).
        if (!name) break
        if (out.length && name === out[0].name) break
        out.push({ index: i, name })
      }
      return out
    })
    this.zoneListCache = zones
    this.log(`enumerated ${zones.length} zones`)
    return zones
  }

  // Read a zone's channel index list via 04 27 (paged, by zone index). Returns the
  // indices in in-zone position order. NOT enqueued.
  async readZoneChannelIndices(zoneIndex) {
    const indices = []
    for (let page = 0; page < 16; page += 1) {
      const r = await this.sendCommand(zoneChannelsPageFrame(zoneIndex, page), { match: matchHead(0x04, 0x27), timeoutMs: 800, label: `zone ${zoneIndex} channels page ${page}` }).catch(() => null)
      if (!r) break
      const { indices: pageIndices, terminated } = parseZoneChannelIndices(r.frame)
      for (const v of pageIndices) indices.push(v)
      if (terminated || pageIndices.length === 0) break
    }
    return indices
  }

  // Enumerate EVERY zone's channels into zoneChannelsCache — fully NON-DESTRUCTIVE
  // (no 08 39 zone select, so no navigation/race). For each zone i: 04 2b <i> reads
  // the name, 04 27 <i> reads that zone's channel index list (in position order), and
  // 04 2e resolves each name. Mirrors the BT-01 head's "Zones → Edit Chan" sequence.
  // NOT enqueued — runs inside runStartup's enqueue block (before COM CHECK END).
  async enumerateAllZonesInline() {
    const zones = []
    for (let i = 0; i < ZONE_BROWSE_MAX; i += 1) {
      if (!this.port?.isOpen) break
      const r = await this.sendCommand(zoneBrowseFrame(i), { match: matchHead(0x04, 0x2b), timeoutMs: 700, label: `zone browse ${i}` }).catch(() => null)
      const name = r ? parseZoneBrowseName(r.frame) : null
      if (!name) break
      if (zones.length && name === zones[0].name) break // wrapped past the last zone
      const indices = await this.readZoneChannelIndices(i)
      const channels = []
      for (let pos = 0; pos < indices.length; pos += 1) {
        const idx = indices[pos]
        const nr = await this.sendCommand(channelNameBrowseFrame(idx), { match: matchHead(0x04, 0x2e), timeoutMs: 700, label: `ch name ${idx}` }).catch(() => null)
        const cname = nr ? parseChannelBrowseName(nr.frame) : null
        // pos = in-zone position (CH:<side>:<pos> selection); channel# = idx + 1.
        channels.push({ index: pos, channelNumber: idx + 1, name: cname || `MEM ${String(idx + 1).padStart(5, '0')}` })
        await delay(12)
      }
      zones.push({ index: i, name, channels })
    }
    this.zoneListCache = zones.map(z => ({ index: z.index, name: z.name }))
    this.zoneChannelsCache = zones
    this.zoneEnumVersion += 1
    this.log(`enumerated channels for ${zones.length} zones (non-destructive 04 2b/27/2e)`)
  }

  // Enqueued wrapper for a post-connect refresh (the Zones "Refresh" button). Holds
  // the queue for the full re-enumeration — an explicit, user-initiated action.
  async enumerateAllZones({ force = false } = {}) {
    if (this.zoneEnumInProgress) return this.zoneChannelsCache ?? []
    if (!force && this.zoneChannelsCache) return this.zoneChannelsCache
    this.zoneEnumInProgress = true
    try {
      await this.enqueue(() => this.enumerateAllZonesInline())
    } finally {
      this.zoneEnumInProgress = false
    }
    this.emitState()
    return this.zoneChannelsCache ?? []
  }

  // Write a RADIO_SETTINGS value via its 08 <subcmd> opcode. `value` is the radio's
  // on-screen value (enum: the raw option value; numeric: display, converted to raw
  // via `add`). The stored byte == the written byte (raw). We wait for the radio's
  // `03 08 …` ACK — that confirms the change — then apply the value OPTIMISTICALLY.
  // We do NOT re-read the block here: the radio commits the menu change a beat after
  // ACKing, so an immediate re-read races and returns the stale value (clobbering it).
  // The next natural settings read (side swap / refresh) reconciles.
  async setRadioSetting(key, value) {
    const spec = RADIO_SETTINGS_BY_KEY[key]
    if (!spec) throw new Error(`unknown setting '${key}'`)
    if (spec.write == null) throw new Error(`setting '${key}' is read-only`)
    let raw
    if (spec.enum) {
      raw = Number(value) | 0
      if (spec.enum[raw] === undefined) throw new Error(`invalid option ${value} for ${key}`)
    } else {
      const display = Math.max(spec.min, Math.min(spec.max, Number(value) | 0))
      raw = display - (spec.add ?? 0)
    }
    if (raw < 0 || raw > 0xff) throw new Error(`encoded value ${raw} out of range for ${key}`)
    await this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      // The 08-write family all ACK `03 08 00 00 0b`; serialized via enqueue so the
      // ACK we see belongs to this write.
      await this.sendCommand(menuWriteFrame(spec.write, raw), { match: (_d, f) => f[0] === 0x03 && f[1] === 0x08, timeoutMs: 800, label: `set ${key}` })
    })
    // ACK received → trust it and apply optimistically.
    this.state.settings = { ...this.state.settings, [key]: raw }
    if (key === 'dualWatch') this.state.dualWatch = raw === 1
    this.log(`set ${key} = ${value} (08 ${spec.write.toString(16)} ${raw.toString(16).padStart(2, '0')})`)
    this.emitState()
    return this.getState()
  }

  // Write a CHANNEL_SETTINGS value via its 2f <subcmd> opcode. The 2f family
  // actuates the radio's currently-SELECTED side's working channel, so writes
  // implicitly target whichever side is active (select the side first to edit the
  // other one). Same optimistic-after-ACK model as setRadioSetting; the 2f family
  // ACKs `03 2f 00 00`. The next 04 2c/2d channel read reconciles the displayed value.
  async setChannelSetting(key, value, side = null) {
    const spec = CHANNEL_SETTINGS_BY_KEY[key]
    if (!spec) throw new Error(`unknown channel setting '${key}'`)
    let raw
    if (spec.enum) {
      raw = Number(value) | 0
      if (spec.enum[raw] === undefined) throw new Error(`invalid option ${value} for ${key}`)
    } else {
      const display = Math.max(spec.min, Math.min(spec.max, Number(value) | 0))
      raw = display - (spec.add ?? 0)
    }
    if (raw < 0 || raw > 0xff) throw new Error(`encoded value ${raw} out of range for ${key}`)
    // The 2f family writes the SELECTED side; select the target side first if asked.
    if ((side === 'A' || side === 'B') && this.state.selectedSide !== side) await this.selectSide(side)
    const frame = spec.frame ? spec.frame(raw) : channelWriteFrame(spec.write, raw)
    await this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      await this.sendCommand(frame, { match: (_d, f) => f[0] === 0x03 && f[1] === 0x2f, timeoutMs: 800, label: `set channel ${key}` })
    })
    // ACK received → apply optimistically to the selected side's channel-settings map.
    const sideName = this.state.selectedSide === 'B' ? 'B' : 'A'
    const sideObj = this.state.sides?.[sideName]
    if (sideObj) {
      const upd = { [key]: raw }
      // Reverse and Talkaround are mutually exclusive on the radio (byte 11 bits 4/7):
      // enabling one clears the other. Mirror that in our optimistic state so the UI
      // stays consistent with what the radio actually did.
      if (key === 'reverse' && raw === 1) upd.talkaround = 0
      if (key === 'talkaround' && raw === 1) upd.reverse = 0
      sideObj.channelSettingsRaw = { ...(sideObj.channelSettingsRaw ?? {}), ...upd }
    }
    this.log(`set channel ${key} = ${value} (2f ${spec.write.toString(16)} ${raw.toString(16).padStart(2, '0')}) on ${sideName}`)
    this.emitState()
    return this.getState()
  }

  // Write the selected side's channel name (2f 24). Restricted to the radio's
  // alphanumeric+space set and 16 chars. Optimistic-after-ACK like setChannelSetting;
  // read-back reconciles on the next 04 2c/2d channel read.
  async setChannelName(name, side = null) {
    const clean = String(name ?? '').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 16).trimEnd()
    if (!clean) throw new Error('channel name must contain at least one letter or number')
    if ((side === 'A' || side === 'B') && this.state.selectedSide !== side) await this.selectSide(side)
    await this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      await this.sendCommand(channelNameFrame(clean), { match: (_d, f) => f[0] === 0x03 && f[1] === 0x2f, timeoutMs: 800, label: 'set channel name' })
    })
    const sideName = this.state.selectedSide === 'B' ? 'B' : 'A'
    const sideObj = this.state.sides?.[sideName]
    if (sideObj) sideObj.channelName = clean
    this.log(`set channel name = "${clean}" (2f 24) on ${sideName}`)
    this.emitState()
    return this.getState()
  }

  // Write the selected side's working RX frequency (2f 03, BCD of Hz/10). Same
  // select-side-then-write + optimistic-after-ACK model as setChannelName; the 2f
  // family ACKs `03 2f 00 00`. The next 04 2c/2d read reconciles the displayed value.
  async setReceiveFrequency(hz, side = null) {
    const freq = Math.round(Number(hz))
    if (!Number.isFinite(freq) || freq < 100_000 || freq > RX_FREQ_MAX_HZ) throw new Error(`RX frequency ${hz} out of range`)
    if ((side === 'A' || side === 'B') && this.state.selectedSide !== side) await this.selectSide(side)
    await this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      await this.sendCommand(receiveFrequencyFrame(freq), { match: (_d, f) => f[0] === 0x03 && f[1] === 0x2f, timeoutMs: 800, label: 'set RX frequency' })
    })
    const sideName = this.state.selectedSide === 'B' ? 'B' : 'A'
    const sideObj = this.state.sides?.[sideName]
    if (sideObj) sideObj.frequencyMhz = freq / 1_000_000
    this.log(`set RX frequency = ${(freq / 1e6).toFixed(5)} MHz (2f 03) on ${sideName}`)
    this.emitState()
    return this.getState()
  }

  // Write the selected side's working TX frequency (2f 04, BE32 of Hz/10). Byte
  // format decoded but NOT yet validated live — see PROTOCOL.md and transmitFrequencyFrame.
  async setTransmitFrequency(hz, side = null) {
    const freq = Math.round(Number(hz))
    if (!Number.isFinite(freq) || freq < 30_000 || freq > 470_000_000) throw new Error(`TX frequency ${hz} out of range`)
    if ((side === 'A' || side === 'B') && this.state.selectedSide !== side) await this.selectSide(side)
    await this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      await this.sendCommand(transmitFrequencyFrame(freq), { match: (_d, f) => f[0] === 0x03 && f[1] === 0x2f, timeoutMs: 800, label: 'set TX frequency' })
    })
    const sideName = this.state.selectedSide === 'B' ? 'B' : 'A'
    const sideObj = this.state.sides?.[sideName]
    if (sideObj) sideObj.txFrequencyMhz = freq / 1_000_000
    this.log(`set TX frequency = ${(freq / 1e6).toFixed(5)} MHz (2f 04) on ${sideName}`)
    this.emitState()
    return this.getState()
  }

  // Write an RX or TX tone (CTCSS/DCS). field 'rx' = RCDT (2f 16), 'tx' = TCDT
  // (2f 02). type 'off' | 'ctc' (value = 1-based CTCSS index) | 'dcs' (value = DCS
  // code, e.g. 23; inverted = I-variant). DCS encoding (type 2 N / 3 I, b3:b4 =
  // 16-bit of parseInt(code,8)) is byte-exact for D023N; inverted + codes > 0o377
  // are a hypothesis pending D023I/D777N captures. Read-back reconciles on next read.
  async setChannelTone(field, type, value, inverted = false, side = null) {
    const subcmd = field === 'rx' ? 0x16 : field === 'tx' ? 0x02 : null
    if (subcmd == null) throw new Error(`unknown tone field '${field}' (use rx/tx)`)
    let frame
    let hz = null, code = null // optimistic read-back values applied after ACK
    if (type === 'off') {
      frame = toneFrameRaw(subcmd, 0, 0, 0)
    } else if (type === 'ctc') {
      const idx = Number(value) | 0
      if (idx < 1 || idx > CTCSS_TONES.length) throw new Error(`invalid CTCSS index ${value}`)
      frame = toneFrameRaw(subcmd, 1, idx, 0)
      hz = CTCSS_TONES[idx - 1]
    } else if (type === 'dcs') {
      code = Number(value) | 0
      if (!DCS_CODES.includes(code)) throw new Error(`invalid DCS code ${value}`)
      const raw = parseInt(String(code), 8) // code label is octal; radio stores its value
      frame = toneFrameRaw(subcmd, inverted ? 3 : 2, (raw >> 8) & 0xff, raw & 0xff)
    } else {
      throw new Error(`unknown tone type '${type}' (use off/ctc/dcs)`)
    }
    if ((side === 'A' || side === 'B') && this.state.selectedSide !== side) await this.selectSide(side)
    await this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      await this.sendCommand(frame, { match: (_d, f) => f[0] === 0x03 && f[1] === 0x2f, timeoutMs: 800, label: `set ${field} tone` })
    })
    // ACK received → apply optimistically to the selected side's tone fields (what
    // toneStateFor reads). No re-read: the radio commits a beat after ACK, so an
    // immediate read races it (same optimistic model as setChannelSetting).
    const sideObj = this.state.sides?.[this.state.selectedSide === 'B' ? 'B' : 'A']
    if (sideObj) {
      const toneType = type === 'dcs' ? 2 : type === 'ctc' ? 1 : 0
      sideObj.channelSettingsRaw = { ...(sideObj.channelSettingsRaw ?? {}), [field === 'tx' ? 'txToneType' : 'rxToneType']: toneType }
      if (field === 'tx') { sideObj.ctcssEncodeHz = hz; sideObj.dcsEncodeCode = code }
      else { sideObj.ctcssDecodeHz = hz; sideObj.dcsDecodeCode = code }
    }
    this.log(`set ${field} tone = ${type}${type === 'off' ? '' : ' ' + value}${type === 'dcs' && inverted ? ' (I)' : ''} on ${this.state.selectedSide}`)
    this.emitState()
    return this.getState()
  }

  pttContextForCurrentChannel() {
    const sideName = this.state.selectedSide === 'B' ? 'B' : 'A'
    const side = this.state.sides?.[sideName] ?? {}
    const programmed = channelProgramFor(side.channelNumber, side.channelName)
    const dmr = side.txDigital === true
    // Manual dial overrides the channel's programmed contact while it is set and
    // the active side is DMR. group → call class 0x01 / private → 0x00.
    const manual = dmr && this.state.manualDial?.target ? this.state.manualDial : null
    const manualGroup = manual ? String(manual.callType).toLowerCase() !== 'private' : false
    const context = {
      side: sideName,
      sideContext: sideName === 'B' ? 0x01 : 0x00,
      dmr,
      callClass: manual ? (manualGroup ? 0x01 : 0x00) : dmrCallClass(programmed),
      contextBytes: manual ? (bcdBytesFromNumber(manual.target, 4) ?? [0x00, 0x00, 0x00, 0x00]) : dmrContextBytes(side, programmed),
      flag0: manual ? (manualGroup ? 0x01 : 0x00) : dmrFlag0(programmed),
      channelNumber: side.channelNumber ?? null,
      channelName: side.channelName ?? null,
      contactName: manual ? null : (side.contactName ?? programmed?.contactName ?? null),
      contactTg: manual ? manual.target : (side.contactTg ?? programmed?.contactTg ?? null),
    }
    // Tail source priority for the extended DMR key-down:
    //   0. manual dial (synthetic tail from the dialed target — overrides all)
    //   1. 04 2c/2d channel read (pre-key, validator-correct, byte-exact)
    //   2. cached 0x58 keyed-context push (only available after a prior key)
    //   3. CPS-guessed call-class/TG (last resort; got tail[0] wrong and wedged)
    const tail04 = dmr && !manual ? dmrTailFrom04Raw(side.dmrTailRaw) : null
    if (manual) {
      context.dmrTail = [...(manualDialPttTail(manual.target, manual.callType) ?? Buffer.alloc(18))]
      context.dmrTailSource = 'manual'
      context.manualDial = { target: manual.target, callType: manualGroup ? 'group' : 'private' }
    } else if (dmr && tail04) {
      context.dmrTail = [...tail04]
      context.dmrTailSource = '04'
    } else if (dmr && Array.isArray(this.latestDmrStatusTail?.tail) && this.latestDmrStatusTail.tail.length === 18) {
      context.dmrTail = [...this.latestDmrStatusTail.tail]
      context.dmrTailSource = '58'
    } else if (dmr) {
      context.dmrTail = [...dmrPttTail(context)]
      context.dmrTailSource = 'channel'
    }
    return context
  }

  // Manual dial: set a sticky DMR target that overrides the channel's programmed
  // contact on the next PTT(s) until cleared. callType 'group' (default) | 'private'.
  setManualDial(target, callType = 'group') {
    const digits = String(target ?? '').replace(/\D/g, '')
    if (!digits) throw new Error('manual dial target is required')
    if (!manualDialPttTail(digits, callType)) throw new Error(`invalid manual-dial target ${target}`)
    const type = String(callType).toLowerCase() === 'private' ? 'private' : 'group'
    this.state.manualDial = { target: digits, callType: type }
    this.log(`manual dial set: ${type} call to ${digits}`)
    this.emitState()
    return this.getState()
  }

  clearManualDial() {
    if (this.state.manualDial) this.log('manual dial cleared')
    this.state.manualDial = null
    this.emitState()
    return this.getState()
  }

  // Live PTT used by the UI (TX1/TX0). Release is best-effort even when the
  // link is degraded; the watchdog guarantees an upper bound on key-down time.
  async setPtt(on) {
    const want = !!on
    if (this.pttWatchdog) clearTimeout(this.pttWatchdog)
    this.pttWatchdog = null
    if (want && !this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
    const pauseWiredPolling = this.transport.id === 'wired'
    if (pauseWiredPolling) {
      this.pollPausedForPtt = true
      if (this.keepaliveTimer) { clearTimeout(this.keepaliveTimer); this.keepaliveTimer = null }
    }
    let pttContext = null
    let ackStatus = null
    try {
      await this.enqueue(async () => {
        if (!this.port?.isOpen) {
          if (want) throw new Error(`${this.transport.label} link is not connected`)
          return
        }
        let sent = false
        try {
          pttContext = want ? this.pttContextForCurrentChannel() : (this.latestDmrContext?.dmr ? this.latestDmrContext : this.pttContextForCurrentChannel())
          if (want) this.latestDmrContext = pttContext.dmr ? pttContext : null
          // Send 56 and wait for the 03 56 ACK. The release 5e/58 burst now flows
          // through dispatch() (status bus) on its own — no idle-window draining.
          // `sent` is set only once the write actually drained (so the safety
          // release fires only on a mid-send failure, never as a duplicate).
          const r = await this.sendCommand(pttFrame(want, pttContext), { match: matchAck(0x56), timeoutMs: want ? (pttContext.dmr ? 500 : 300) : 500, label: 'PTT 56', onSent: () => { sent = true } }).catch(() => null)
          ackStatus = r?.decoded?.status ?? null
        } finally {
          // Safety release ONLY if the write never went out (error mid-send) — never
          // a duplicate on the happy path. A second 56 00 re-triggers the radio's
          // release-5e push and can wedge its status stream into a stuck-5e loop.
          if (!sent) { try { await this.sendOnly(pttFrame(false, pttContext?.dmr ? pttContext : this.latestDmrContext)) } catch (err) { this.log(`PTT safety-release failed: ${err?.message ?? err}`) } }
        }
      })
    } catch (err) {
      if (pauseWiredPolling && want) this.pollPausedForPtt = false
      throw err
    }
    if (pauseWiredPolling && !want) this.pollPausedForPtt = false
    this.patch({ pttActive: want })
    const pttMode = pttContext?.dmr && DMR_EXTENDED_PTT ? (want ? `DMR extended/${pttContext.dmrTailSource || 'tail'}` : 'DMR context release') : 'simple'
    const ackText = ackStatus == null ? 'no ACK' : `ACK status=${ackStatus}`
    this.log(`PTT ${want ? 'keyed' : 'released'} (${pttMode}, ${ackText})`)
    if (want && pttContext?.dmr && DMR_EXTENDED_PTT && ackStatus !== 1) {
      this.log(`DMR extended PTT did not return expected success ACK status=1 on ${pttContext.side} ${pttContext.channelNumber ?? ''} ${pttContext.channelName ?? ''}`.trim())
    }
    if (want) {
      this.pttWatchdog = setTimeout(() => {
        this.log(`PTT watchdog: forcing release after ${PTT_MAX_MS}ms`)
        this.setPtt(false).catch(err => this.log(`PTT watchdog release failed: ${err?.message ?? err}`))
      }, PTT_MAX_MS)
      if (pauseWiredPolling && this.state.connected && !this.state.linkHalted) this.scheduleKeepalive(WIRED_PTT_KEEPALIVE_INTERVAL_MS)
    } else if (pauseWiredPolling && this.state.connected && !this.state.linkHalted) {
      this.scheduleKeepalive()
    }
    // BT signal status resumes via pushes; wired resumes via the 5a poll loop.
    return this.getState()
  }

  // One-shot keyed test — only reachable via the explicit /raw/ptttest
  // endpoint. Release is always sent, even on error.
  async pttTest(holdMs = 1000) {
    const hold = Math.max(100, Math.min(1500, Number(holdMs) || 1000))
    const responses = await this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      let released = false
      let pttContext = null
      try {
        pttContext = this.pttContextForCurrentChannel()
        const pressResp = await this.captureWindow(pttFrame(true, pttContext), { timeoutMs: 400, idleMs: 100 })
        await delay(hold)
        const releaseResp = await this.captureWindow(pttFrame(false, pttContext), { timeoutMs: 500, idleMs: 150 })
        released = true
        return { press: hexdump(pressResp), release: hexdump(releaseResp) }
      } finally {
        // Only release if we didn't already — a duplicate 56 00 re-triggers the
        // radio's async release-5e push and can wedge its status stream.
        if (!released) { try { await this.sendOnly(pttFrame(false, pttContext)) } catch (err) { this.log(`PTT-test safety-release failed: ${err?.message ?? err}`) } }
      }
    })
    this.log(`PTT test hold=${hold}ms press resp: ${responses.press || '<none>'} | release resp: ${responses.release || '<none>'}`)
    return { holdMs: hold, ...responses }
  }

  async rawQuery(payload, options = {}) {
    return this.enqueue(async () => {
      if (!this.port?.isOpen) throw new Error(`${this.transport.label} link is not connected`)
      return this.captureWindow(payload, { timeoutMs: options.timeoutMs ?? 1200, idleMs: options.idleMs ?? 150 })
    })
  }

  // Capture every unsolicited frame the radio pushes between polls. Previously
  // this only looked at 5a/5b and silently dropped everything else (e.g.
  // squelch-open/close pushes in other formats accumulated unlogged in the rx
  // buffer). Now we split + decode ALL pending bytes, log each frame for
  // investigation, and still apply the known signal/rx-status types to state.
  // Log one unsolicited frame to the in-memory ring + NDJSON file. Carries
  // through any decoded summary fields that help identify what the frame is.
  recordAsyncFrame(decoded, timestamp) {
    if (Array.isArray(decoded.dmrTail) && decoded.dmrTail.length === 18) {
      this.latestDmrStatusTail = { at: timestamp, tail: decoded.dmrTail, raw: decoded.raw }
    }
    const entry = {
      at: timestamp,
      iso: new Date(timestamp).toISOString(),
      type: decoded.type,
      head: decoded.raw.split(' ').slice(0, 2).join(' '),
      length: decoded.length,
      checksumOk: decoded.checksumOk,
      raw: decoded.raw,
    }
    for (const key of ['command', 'statusCode', 'statusByte', 'squelchOpen', 'activeRssi', 'inactiveRssi', 'activeOpen', 'inactiveOpen', 'bytes', 'strings', 'dmrTailHex']) {
      if (decoded[key] !== undefined) entry[key] = decoded[key]
    }
    this.state.asyncFrames.push(entry)
    this.state.asyncFrames = this.state.asyncFrames.slice(-ASYNC_LOG_LIMIT)
    this.log(`ASYNC ${decoded.type} [${entry.head}] ${decoded.raw}`)
    appendAsyncLog(entry)
  }

  patch(patch) {
    Object.assign(this.state, patch, { lastUpdate: Date.now() })
    this.emitState()
  }

  log(message) {
    this.state.logs.push({ at: Date.now(), message })
    this.state.logs = this.state.logs.slice(-80)
  }

  emitState() {
    this.emit('stateChange', this.getState())
  }
}

function emptySide(label) {
  return {
    label,
    zone: null,
    zoneNumber: null,
    zoneCount: null,
    zoneMaxSeen: 0,
    channelPosition: null,
    frequencyMhz: null,
    frequencyDisplay: null,
    channelName: null,
    channelNumber: null,
    txOffsetMhz: null,
    txFrequencyMhz: null,
    bandwidthKhz: null,
    txPower: null,
    channelType: null,
    channelTypeName: null,
    vfoMode: null,
    txDigital: null,
    rawRecord08: null,
    rawRecord09: null,
    ctcssEncodeHz: null,
    ctcssDecodeHz: null,
    dcsEncodeCode: null,
    dcsDecodeCode: null,
    customCtcssHz: null,
    squelchMode: null,
    contactName: null,
    contactTg: null,
    contactTgBytes: null,
    dmrTailRaw: null,
    radioId: null,
    callsign: null,
    strings: [],
    rawZone: null,
    rawChannel: null,
    lastUpdate: null,
  }
}

function resolveTransport(value) {
  const id = String(value || 'bt').trim().toLowerCase()
  if (id === 'bt' || id === 'bluetooth') return TRANSPORTS.bt
  if (id === 'wired' || id === 'digirig' || id === 'serial') return TRANSPORTS.wired
  throw new Error(`Unsupported transport '${value}'. Use 'bt' or 'wired'.`)
}

function transportState(transport) {
  return {
    transport: transport.id,
    transportLabel: transport.label,
    transportMode: transport.mode,
    transportLink: transport.link,
    transportFraming: transport.framing,
    audio: { ...transport.audio },
  }
}

function wiredSerialPath() {
  if (existsSync(WIRED_SERIAL_PATH)) return WIRED_SERIAL_PATH
  if (!process.env.ANYTONE_WIRED_SERIAL_PATH && !process.env.ANYTONE_SERIAL_PATH && existsSync(WIRED_SERIAL_FALLBACK_PATH)) return WIRED_SERIAL_FALLBACK_PATH
  return WIRED_SERIAL_PATH
}

function emptyState() {
  return {
    connected: false,
    connecting: false,
    ...transportState(TRANSPORTS.bt),
    addr: RADIO_ADDR,
    sppChannel: SPP_CHANNEL,
    error: null,
    lastUpdate: Date.now(),
    lastPollAt: null,
    pollCount: 0,
    pollIntervalMs: null,
    // SPP frame-sync health (instrumentation + watchdog state).
    linkHealthy: true,        // last keepalive returned a checksum-valid 5a/5e
    linkHalted: false,        // polling stopped after sustained desync
    desyncStreak: 0,          // consecutive ticks with no checksum-valid frame
    checksumFailTotal: 0,     // lifetime count of malformed keepalive reads
    lastValidPollAt: null,    // last time a checksum-valid poll frame arrived
    pttActive: false,
    firmware: null,
    firmwareStrings: [],
    selectedSide: null,
    sides: { A: emptySide('A'), B: emptySide('B') },
    dualWatch: null,
    mainSquelch: null,
    subSquelch: null,
    // Global menu settings decoded from blocks 06/09 (mic/speaker/BT-01 gain,
    // noise reduction, fan mode). Null until read; digiMon write opcode known but
    // its read offset is not mapped yet.
    // RADIO_SETTINGS raw values keyed by setting key (null until read).
    settings: Object.fromEntries(RADIO_SETTINGS.map(s => [s.key, null])),
    signal: { smeter: null, squelchOpen: null, activeRssi: null, inactiveRssi: null, activeOpen: null, inactiveOpen: null, mainRssi: null, subRssi: null, mainOpen: null, subOpen: null, dmrRxOpen: false, dmrLatchSide: null, dmrCallCc: null, dmrCallSlot: null, dmrCallTg: null, dmrCallDest: null, dmrCallPrivate: null, dmrActiveAt: null, lastSignalAt: null, lastRxStatusAt: null, rawStatus: null, note: '5a RSSI/open mask is per-side FOR ANALOG (0x02 selected / 0x04 other); for DMR that mask is the TIMESLOT not the side. DMR call side comes from matching the call identity (TG/CC/slot) to the programmed channel: dmrLatchSide is resolved ONCE when the call locks (5b audio gate opens after 5e RX), held until the 5e gate closes. dmrCallCc/Slot/Tg are the live call match keys. Levels uncalibrated.' },
    clock: null,
    dmrActivity: null,
    // Sticky manual-dial DMR target: { target: '<digits>', callType: 'group'|'private' }.
    // Overrides the PTT contact tail until cleared. Null = use the channel's contact.
    manualDial: null,
    rawFrames: [],
    asyncFrames: [],
    logs: [],
  }
}

// Append-only NDJSON sink for unsolicited frames — tail with `tail -f` while
// keying squelch on the radio to see what each push frame looks like. Best
// effort: a log-write failure must never disrupt the serial data path.
let asyncLogDirReady = false
function appendAsyncLog(entry) {
  if (!ASYNC_LOG_TO_FILE) return
  try {
    if (!asyncLogDirReady) { mkdirSync(dirname(ASYNC_LOG_PATH), { recursive: true }); asyncLogDirReady = true }
    appendFileSync(ASYNC_LOG_PATH, `${JSON.stringify(entry)}\n`)
  } catch { /* ignore */ }
}

function bcdNumber(raw) {
  let digits = ''
  for (const value of raw) {
    if ((value >> 4) > 9 || (value & 0x0f) > 9) return null
    digits += value.toString(16).padStart(2, '0')
  }
  return Number(digits)
}

function toneFromIndex(index) {
  return index >= 1 && index <= CTCSS_TONES.length ? CTCSS_TONES[index - 1] : null
}

function dcsCodeFromRaw(raw) {
  if (!raw) return null
  const code = Number(raw.toString(8))
  return DCS_CODES.includes(code) ? code : null
}

function channelProgramFor(channelNumber, channelName) {
  return (channelNumber != null ? CHANNEL_PROGRAM.byNumber.get(String(channelNumber)) : null)
    || (channelName ? CHANNEL_PROGRAM.byName.get(channelName.toUpperCase()) : null)
    || null
}

function decodeChannelNumberWord(channelWord) {
  if (channelWord == null) return null
  if (channelWord >= 0x100 && channelWord < 0x1000) return channelWord - 0x100 + 1
  if (channelWord >= 0 && channelWord < 0x100) return channelWord + 1
  return null
}

function loadChannelProgram() {
  const program = { byNumber: new Map(), byName: new Map() }
  // The CSV is the source for per-channel power/bandwidth enrichment (no live
  // protocol byte for power). It is gitignored personal data; a fresh checkout
  // won't have it. Degrade to an empty program and tell the operator why.
  if (!existsSync(CHANNELS_CSV_PATH)) {
    console.warn(`[anytone] channels CSV not found at ${CHANNELS_CSV_PATH}; channel power/bandwidth enrichment disabled. Set ANYTONE_CHANNELS_CSV to override.`)
    return program
  }

  const lines = readFileSync(CHANNELS_CSV_PATH, 'utf8').split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return program

  const header = parseCsvLine(lines[0])
  const numberIndex = header.indexOf('No.')
  const nameIndex = header.indexOf('Channel Name')
  const transmitIndex = header.indexOf('Transmit Frequency')
  const bandwidthIndex = header.indexOf('Band Width')
  const powerIndex = header.indexOf('Transmit Power')
  const channelTypeIndex = header.indexOf('Channel Type')
  const contactIndex = header.indexOf('Contact')
  const contactCallTypeIndex = header.indexOf('Contact Call Type')
  const contactTgIndex = header.indexOf('Contact TG/DMR ID')
  const colorCodeIndex = header.indexOf('Color Code')
  const slotIndex = header.indexOf('Slot')
  const dmrModeIndex = header.indexOf('DMR MODE')
  if (numberIndex < 0 || nameIndex < 0 || transmitIndex < 0 || bandwidthIndex < 0) return program

  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line)
    const number = fields[numberIndex]?.trim()
    const name = fields[nameIndex]?.trim()
    const transmitFrequencyMhz = Number.parseFloat(fields[transmitIndex])
    const bandwidth = Number.parseFloat(fields[bandwidthIndex])
    if (!number || !name || !Number.isFinite(transmitFrequencyMhz) || !Number.isFinite(bandwidth)) continue

    // CPS power values: Low / Mid / High / Turbo. No live protocol byte found
    // for power (checked Low/Mid/Turbo channel blocks), so CSV is the source.
    const txPower = powerIndex >= 0 ? (fields[powerIndex]?.trim().toUpperCase() || null) : null
    const entry = {
      number,
      name,
      transmitFrequencyMhz,
      bandwidthKhz: bandwidth,
      txPower,
      channelType: channelTypeIndex >= 0 ? (fields[channelTypeIndex]?.trim() || null) : null,
      contactName: contactIndex >= 0 ? (fields[contactIndex]?.trim() || null) : null,
      contactCallType: contactCallTypeIndex >= 0 ? (fields[contactCallTypeIndex]?.trim() || null) : null,
      contactTg: contactTgIndex >= 0 ? (fields[contactTgIndex]?.trim() || null) : null,
      colorCode: colorCodeIndex >= 0 ? (fields[colorCodeIndex]?.trim() || null) : null,
      slot: slotIndex >= 0 ? (fields[slotIndex]?.trim() || null) : null,
      dmrMode: dmrModeIndex >= 0 ? (fields[dmrModeIndex]?.trim() || null) : null,
    }
    program.byNumber.set(number, entry)
    program.byName.set(name.toUpperCase(), entry)
  }

  return program
}

function parseCsvLine(line) {
  const fields = []
  let field = ''
  let quoted = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
    } else if (char === '"' && field === '') {
      quoted = true
    } else if (char === ',') {
      fields.push(field)
      field = ''
    } else {
      field += char
    }
  }

  fields.push(field)
  return fields
}

function parseOptionalByte(value) {
  if (value == null || value === '') return null
  const text = String(value).trim()
  const parsed = Number.parseInt(text.startsWith('0x') ? text.slice(2) : text, text.startsWith('0x') ? 16 : 10)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0xff ? parsed : null
}

function specialMixedCase(record) {
  if (!record || record.length <= 0x08) return null
  return record[0x08] & 0x03
}

function decodeAnytoneChannelTypeFromRecord(record, selector = 1) {
  if (selector !== 1) return null
  const type = specialMixedCase(record)
  return type != null && type >= 0 && type <= 3 ? type : null
}

function channelTypeName(type) {
  return ['A-Analog', 'D-Digital', 'A+D TX A', 'D+A TX D'][type] ?? null
}

function txIsDigital(type) {
  if (type == null) return null
  return type === 1 || type === 3
}

function classify04CurrentChannelPayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 12 || payload[0] !== 0x04 || ![0x2c, 0x2d].includes(payload[1])) {
    return { channelType: null, channelTypeName: null, txDigital: null, rawRecord08: null, rawRecord09: null }
  }
  const record = payload.subarray(2, Math.max(2, payload.length - 1))
  const channelType = decodeAnytoneChannelTypeFromRecord(record)
  return {
    channelType,
    channelTypeName: channelTypeName(channelType),
    txDigital: txIsDigital(channelType),
    rawRecord08: record.length > 0x08 ? record[0x08] : null,
    rawRecord09: record.length > 0x09 ? record[0x09] : null,
  }
}

function isDmrChannel(side) {
  return side?.txDigital === true || txIsDigital(side?.channelType) === true
}

// Decide which side a live DMR call is on — run ONCE when the call locks (5b audio
// gate opens), then held for the whole call. A lone DMR side wins outright. With
// both sides DMR, the PRIMARY key is the call's DESTINATION (5e bytes 13-16 — the
// TG for a group call, the contact unit-id for a private call) matched against each
// side's programmed contact: a unique contact match wins. This is what makes a
// PARROT private call land on its own side (dest == that side's contact) even when
// the OTHER side is active. Slot is only a tiebreak (it's unreliable under Digital
// Monitor dual-slot), and the active side is the last resort.
function resolveDmrCallSide(state) {
  const A = state.sides?.A, B = state.sides?.B
  const aDmr = A?.txDigital === true, bDmr = B?.txDigital === true
  const active = state.selectedSide === 'B' ? 'B' : 'A'
  if (aDmr && !bDmr) return 'A'
  if (bDmr && !aDmr) return 'B'
  if (!aDmr && !bDmr) return active

  const dest = state.signal?.dmrCallDest
  const contactHit = side => dest != null && side?.contactTg != null && Number(side.contactTg) === Number(dest)
  const cA = contactHit(A), cB = contactHit(B)
  if (cA && !cB) return 'A'
  if (cB && !cA) return 'B'

  const slot = state.signal?.dmrCallSlot
  const slotHit = side => slot != null && side?.channelSettingsRaw?.timeSlot != null && side.channelSettingsRaw.timeSlot === slot
  const sA = slotHit(A), sB = slotHit(B)
  if (sA && !sB) return 'A'
  if (sB && !sA) return 'B'

  return active
}

// Map the side-relative 5a fields (active = selected side, inactive = other) to
// main/sub using the CURRENT selectedSide. Run on every 5a AND again when the first
// settings read establishes selectedSide — so activity that arrives during the
// startup race (before selectedSide is known) gets re-attributed to the right side
// instead of being frozen on the wrong one.
function mapSignalSides(state) {
  const s = state.signal
  if (s.activeRssi == null && s.activeOpen == null) return
  const selectedIsSub = state.selectedSide === 'B'
  s.mainRssi = selectedIsSub ? s.inactiveRssi : s.activeRssi
  s.subRssi = selectedIsSub ? s.activeRssi : s.inactiveRssi
  s.mainOpen = selectedIsSub ? s.inactiveOpen : s.activeOpen
  s.subOpen = selectedIsSub ? s.activeOpen : s.inactiveOpen
  s.squelchOpen = s.mainOpen || s.subOpen
}

function dmrCallClass(programmed) {
  if (DMR_PTT_CALL_CLASS_OVERRIDE != null) return DMR_PTT_CALL_CLASS_OVERRIDE
  const callType = String(programmed?.contactCallType || '').toLowerCase()
  if (callType.includes('private')) return 0x00
  if (callType.includes('all')) return 0x02
  return 0x01 // Group Call, the common CPS default for talkgroups.
}

function dmrFlag0(programmed) {
  if (DMR_PTT_FLAG0_OVERRIDE != null) return DMR_PTT_FLAG0_OVERRIDE
  return 0x00
}

function bcdBytesFromNumber(value, length) {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (!digits) return null
  const padded = digits.padStart(length * 2, '0').slice(-(length * 2))
  const bytes = []
  for (let idx = 0; idx < padded.length; idx += 2) {
    const hi = Number(padded[idx])
    const lo = Number(padded[idx + 1])
    if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi > 9 || lo > 9) return null
    bytes.push((hi << 4) | lo)
  }
  return bytes
}

function dmrContextBytes(side, programmed) {
  if (Array.isArray(side?.contactTgBytes) && side.contactTgBytes.length === 4) return side.contactTgBytes
  return bcdBytesFromNumber(side?.contactTg ?? programmed?.contactTg, 4) ?? [0x00, 0x00, 0x00, 0x00]
}

function modeForSide(side) {
  if (side?.frequencyMhz == null) return null
  if (isDmrChannel(side)) return 'DMR'
  return narrowForSide(side) === true ? 'FM-N' : 'FM'
}

function narrowForSide(side) {
  if (side?.bandwidthKhz == null) return null
  return side.bandwidthKhz <= 12.5
}

function dcsCodeIndexForSide(side) {
  const code = side?.dcsDecodeCode ?? side?.dcsEncodeCode
  if (code == null) return null
  const index = DCS_CODES.indexOf(code)
  return index >= 0 ? index : null
}

function txFrequencyForSide(side) {
  if (side?.txFrequencyMhz != null) return mhzToHz(side.txFrequencyMhz)
  return null
}

function isVfoChannelName(name) {
  return /^Channel VFO [AB]$/i.test(String(name ?? '').trim())
}

function vfoModeForSide(side) {
  if (side?.vfoMode) return side.vfoMode
  if (isVfoChannelName(side?.channelName)) return 'VFO'
  if (side?.zone || side?.channelNumber || side?.channelName) return 'MEMORY'
  return null
}

function txFrequencyFromOffset(rxMhz, txOffsetMhz, programmed) {
  // txOffsetMhz is the SIGNED repeater shift decoded straight from the channel
  // block (direction = byte10 bits 6-7; see the 04 2c/2d decoder). Prefer the
  // live radio value; the CSV's absolute TX is only a fallback for when the
  // offset couldn't be read. (Previously the CSV won unconditionally and the
  // live path assumed a +offset, so negative-shift channels read backwards.)
  if (rxMhz != null && txOffsetMhz != null) return rxMhz + txOffsetMhz
  return programmed?.transmitFrequencyMhz ?? null
}

function decodePayload(payload) {
  const decoded = { type: 'unknown', raw: hexdump(payload), length: payload.length, checksumOk: checksumOk(payload) }
  if (!payload.length) return { ...decoded, type: 'empty' }
  if (payload.length >= 5 && payload[0] === 0x03) {
    const label = payload[1] === 0x01 ? 'COM MODE ACK' : payload[1] === 0x61 ? 'keepalive ACK' : payload[1] === 0x64 ? 'COM CHECK END ACK' : undefined
    return { ...decoded, type: 'ack', code: payload[1], status: payload[3], label }
  }
  if (payload.length >= 2 && payload[0] === 0x04) {
    const command = payload[1]
    if (command === 0x02) {
      const strings = extractAsciiStrings(payload, 2)
      return { ...decoded, type: 'firmware', command, strings, firmware: strings[0] ?? null }
    }
    if (command === 0x29 || command === 0x2a) {
      const strings = extractAsciiStrings(payload, 2)
      // Confirmed via zone/channel stop-motion: offset 34 = zone number
      // (FAVORITES 0, RMHAM DMR 9), offset 35 = 0-based channel scroll
      // position within the zone (mirrors channel block byte 71).
      return {
        ...decoded,
        type: 'zone',
        command,
        side: command === 0x29 ? 'A' : 'B',
        zone: strings[0] ?? null,
        zoneNumber: payload.length >= 35 ? payload[34] : null,
        channelPosition: payload.length >= 36 ? payload[35] : null,
        strings,
      }
    }
    if (command === 0x2c || command === 0x2d) {
      const mhz = payload.length >= 6 ? decodeBcdFrequency(payload.subarray(2, 6)) : null
      if (mhz == null) return { ...decoded, type: 'status-probe', command, statusCode: `04${command.toString(16).padStart(2, '0')}`, bytes: [...payload.subarray(2, -1)] }
      const strings = extractAsciiStrings(payload, 37)
      // TX offset field [6..9] = shift MAGNITUDE, BCD (0.600 / 5.000 etc; equals
      // RX on simplex). Direction is byte10 bits 6-7: 0 simplex / 1 positive /
      // 2 negative (decoded 2026-06-21 across the full codeplug — every channel's
      // signed TX matched). Yields a SIGNED txOffsetMhz so negative repeaters
      // (most ham) no longer read as RX+offset.
      let txOffsetMhz = null
      if (payload.length >= 11) {
        const offsetDir = (payload[10] >> 6) & 0x03
        if (offsetDir === 0) {
          txOffsetMhz = 0
        } else {
          const offsetValue = bcdNumber(payload.subarray(6, 10))
          if (offsetValue != null) {
            const offsetMhz = offsetValue / 100000
            if (offsetMhz > 0 && offsetMhz <= 12) txOffsetMhz = offsetDir === 2 ? -offsetMhz : offsetMhz
          }
        }
      }
      const customRaw = payload.length >= 20 ? payload[18] | (payload[19] << 8) : 0
      const channelWord = payload.length >= 75 ? payload[73] | (payload[74] << 8) : null
      const channelNumber = decodeChannelNumberWord(channelWord)
      const channelName = payload.length >= 53 ? cleanFixedString(payload.subarray(37, 53)) : strings[0] ?? null
      const dcsEncodeCode = payload.length >= 16 ? dcsCodeFromRaw(payload[14] | (payload[15] << 8)) : null
      const dcsDecodeCode = payload.length >= 18 ? dcsCodeFromRaw(payload[16] | (payload[17] << 8)) : null
      const programmed = channelProgramFor(channelNumber, channelName)
      const txFrequencyMhz = txFrequencyFromOffset(mhz, txOffsetMhz, programmed)
      const tg = payload.length >= 79 ? bcdNumber(payload.subarray(75, 79)) : null
      const contactTgBytes = payload.length >= 79 ? [...payload.subarray(75, 79)] : null
      const contactName = payload.length >= 95 ? cleanFixedString(payload.subarray(79, 95)) : null
      const radioId = payload.length >= 101 ? bcdNumber(payload.subarray(97, 101)) : null
      const callsign = payload.length >= 111 ? cleanFixedString(payload.subarray(101, 111)) : null
      const channelTypeInfo = classify04CurrentChannelPayload(payload)
      // DMR contact call class is byte 0x4a — the byte immediately before the
      // 4-byte BCD contact target (bytes 0x4b-0x4e): 0x00 Private / 0x01 Group /
      // 0x02 All Call. (0x49 is a record marker, not the class — confirmed against
      // the live PARROT record: 0x49=0x49, 0x4a=0x00, target 00 31 09 97.) Gated to
      // digital channels so an analog channel's leftover contact bytes don't show.
      const contactCallType = (payload.length > 0x4a && channelTypeInfo?.txDigital === true)
        ? (payload[0x4a] === 0x01 ? 'group' : payload[0x4a] === 0x02 ? 'all' : 'private')
        : null
      return {
        ...decoded,
        type: 'channel',
        command,
        side: command === 0x2c ? 'A' : 'B',
        frequencyMhz: mhz,
        frequencyDisplay: mhz == null ? null : mhz.toFixed(5),
        channelName,
        channelNumber,
        channelPosition: payload.length >= 72 ? payload[71] : null,
        txOffsetMhz,
        txFrequencyMhz,
        // Byte 10 is a live bitfield: bits 0-1 = channel type, bits 2-3 =
        // TX power (0 Low, 1 Mid, 2 High, 3 Turbo), bit 4 = bandwidth
        // (set 25K, clear 12.5K). CSV is only a short-frame fallback.
        bandwidthKhz: payload.length >= 11 ? ((payload[10] & 0x10) ? 25 : 12.5) : (programmed?.bandwidthKhz ?? null),
        txPower: payload.length >= 11 ? TX_POWER_LEVELS[(payload[10] >> 2) & 3] : (programmed?.txPower ?? null),
        // Raw CHANNEL_SETTINGS bytes we can read back (type/power/bandwidth from byte 10).
        channelSettingsRaw: decodeChannelSettingsRaw(payload),
        ...channelTypeInfo,
        ctcssEncodeHz: payload.length >= 14 ? toneFromIndex(payload[12]) : null,
        ctcssDecodeHz: payload.length >= 14 ? toneFromIndex(payload[13]) : null,
        dcsEncodeCode,
        dcsDecodeCode,
        customCtcssHz: customRaw > 0 ? customRaw / 10 : null,
        squelchMode: payload.length >= 28 ? (payload[27] & 0x10 ? (dcsDecodeCode != null || dcsEncodeCode != null ? 'dcs' : 'ctcss') : 'carrier') : null,
        contactName,
        contactTg: tg,
        contactTgBytes,
        contactCallType,
        // Authoritative DMR PTT context, straight from the radio. Bytes
        // 0x49-0x4e hold the live call-class flag + 5 context bytes that the
        // D578 COM-mode extended-PTT validator compares on key-down. Capturing
        // them here lets us build a correct extended 0x56 frame BEFORE keying,
        // instead of guessing call-class from CPS (which sent tail[0]=0x01 for a
        // channel the radio wanted 0x00, failing the validator and wedging the
        // 5e/58 status loop). Validated byte-exact against the radio's own 0x58
        // keyed-context push for PARROT (tail = 00 00 31 09 97).
        dmrTailRaw: payload.length >= 0x4f ? [...payload.subarray(0x49, 0x4f)] : null,
        radioId,
        callsign,
        strings,
      }
    }
    if (command === 0x05 && payload.length >= 39) {
      // Settings block; byte 37 = selected TX/RX side, byte 38 = dual watch
      // (both single bits, in the stable tail region). Bytes 11/12 = main/sub
      // squelch level (1-5 as shown on radio; confirmed by setting A to 5).
      // Field-level validation: bytes 6-18 can be clobbered by a stuck "COM
      // CHECK END" echo, so null squelch when out of range but still trust
      // side/dual-watch from the tail. Reject only if the tail is also bad.
      if (payload[37] > 1 || payload[38] > 1) {
        return { ...decoded, type: 'status-probe', command, statusCode: '0405', invalid: true, bytes: [...payload.subarray(2, -1)] }
      }
      const sqOk = payload[11] <= 5 && payload[12] <= 5
      return {
        ...decoded,
        type: 'settings',
        selectedSide: payload[37] === 1 ? 'B' : 'A',
        dualWatch: payload[38] === 1,
        mainSquelch: sqOk ? payload[11] : null,
        subSquelch: sqOk ? payload[12] : null,
        // All RADIO_SETTINGS that live in block 05 (DigiMon, Key Tone, Voice Func…),
        // as RAW values; the projection formats display + write conversion.
        radioSettings: decodeRadioSettings(0x05, payload),
      }
    }
    // Settings block 06: BT mic/speaker gains (raw values; offsets confirmed live).
    if (command === 0x06 && payload.length >= 99) {
      return { ...decoded, type: 'settings-06', radioSettings: decodeRadioSettings(0x06, payload) }
    }
    // Settings block 09: BT-01 gain, noise reduction, fan, GPS, Voice Func levels.
    if (command === 0x09 && payload.length >= 140) {
      return { ...decoded, type: 'settings-09', radioSettings: decodeRadioSettings(0x09, payload) }
    }
    if (command === 0x51 && payload.length >= 11) {
      const year = payload[6] | (payload[7] << 8)
      return {
        ...decoded,
        type: 'clock',
        clock: {
          iso: `${year}-${String(payload[8]).padStart(2, '0')}-${String(payload[9]).padStart(2, '0')}T${String(payload[2]).padStart(2, '0')}:${String(payload[3]).padStart(2, '0')}:${String(payload[4]).padStart(2, '0')}`,
        },
      }
    }
    if (command === 0x5a && payload.length >= 16) {
      // 5a layout is relative to selected side: [2]/0x02 = selected, [3]/0x04 = other.
      return { ...decoded, type: 'signal', activeRssi: payload[2], inactiveRssi: payload[3], activeOpen: (payload[6] & 0x02) !== 0, inactiveOpen: (payload[6] & 0x04) !== 0 }
    }
    if (command === 0x5b && payload.length >= 4) {
      return { ...decoded, type: 'rx-status', command, statusCode: '045b', squelchOpen: payload[2] === 1, bytes: [...payload.subarray(2, -1)] }
    }
    if (command === 0x5e && payload.length >= 5) {
      return { ...decoded, type: 'rx-status', command, statusCode: '045e', squelchOpen: (payload[4] & 0x20) !== 0, bytes: [...payload.subarray(2, -1)] }
    }
    if ([0x4d, 0x4e].includes(command)) return { ...decoded, type: 'status-probe', command, statusCode: `04${command.toString(16).padStart(2, '0')}`, bytes: [...payload.subarray(2, -1)] }
  }
  if (payload[0] === 0x5b && payload.length >= 3) return { ...decoded, type: 'rx-status', statusCode: '5b', squelchOpen: payload[1] === 1 }
  if (payload[0] === 0x5a && payload.length >= 15) return { ...decoded, type: 'signal', activeRssi: payload[1], inactiveRssi: payload[2], activeOpen: (payload[5] & 0x02) !== 0, inactiveOpen: (payload[5] & 0x04) !== 0 }
  if (payload[0] === 0x5e && payload.length >= 18) {
    // 18-byte async link-state push. byte1: 00 idle / 01 RX / 02 TX. byte2 is the
    // superframe type: bit 0x40 set (0x61) = VOICE frame carrying valid Link
    // Control — Color Code (byte 7, 0-15) + Time Slot (byte 12, 0=TS1/1=TS2) are
    // only trustworthy here. byte2 0x21 (bit clear) = terminator/control frame,
    // where byte7 holds an unrelated LC/reason code (seen as 0x0d at call end —
    // previously misdecoded as ColorCode 13). bytes 8-11 = SOURCE id, bytes 13-16
    // = DEST id (both 4-byte BCD). GROUP vs PRIVATE falls straight out of these: a
    // group call carries the TG in BOTH slots (source == dest), a private call is
    // unit→unit so they differ. Confirmed 2026-06-22: group 67498/5067498 had
    // src==dst, PARROT (private) had src 3223436 != dst 310997.
    const active = payload[1] !== 0
    const voiceFrame = (payload[2] & 0x40) !== 0
    const cc = payload[7]
    const ts = payload[12]
    const src = active && voiceFrame ? bcdNumber(payload.subarray(8, 12)) : null
    const dst = active && voiceFrame ? bcdNumber(payload.subarray(13, 17)) : null
    return {
      ...decoded,
      type: 'rx-status',
      statusCode: '5e',
      squelchOpen: payload[1] !== 0,
      statusByte: payload[1],
      dmrVoiceFrame: voiceFrame,
      dmrColorCode: active && voiceFrame && cc <= 15 ? cc : null,
      dmrSlot: active && voiceFrame && ts <= 1 ? ts : null,
      dmrSource: src,
      dmrDest: dst,
      // null until a voice frame lands; group => same id in both slots.
      dmrCallPrivate: (src != null && dst != null) ? src !== dst : null,
      bytes: [...payload.subarray(1, -1)],
    }
  }
  if (payload[0] === 0x58) {
    const dmrTail = dmrTailFrom58Payload(payload)
    // DMR talker context: byte 1 is direction/context (`00` RX talker, `81` TX
    // talker), bytes 6-9 = a 4-byte BCD DMR ID (caller source during RX, or the
    // destination contact/TG during our own TX), bytes 0x0a-0x19 = a 16-char
    // ASCII alias the radio carries for that ID (from its contact list).
    const dmrId = payload.length >= 10 ? bcdNumber(payload.subarray(6, 10)) : null
    const dmrAlias = payload.length >= 26 ? cleanFixedString(payload.subarray(10, 26)) : null
    return {
      ...decoded,
      type: 'async-status',
      statusCode: '58',
      callState: payload[1],
      dmrId: dmrId || null,
      dmrAlias: dmrAlias || null,
      bytes: [...payload.subarray(1, -1)],
      ...(dmrTail ? { dmrTail: [...dmrTail], dmrTailHex: hexdump(dmrTail) } : {}),
    }
  }
  if (payload[0] === 0x59 && payload.length >= 28) {
    // DMR call-info push: talkgroup at bytes 2-5 (4-byte BCD), caller DMR ID at
    // bytes 24-27 (4-byte BCD). Pairs with the 58 talker/alias frame for a group
    // call. See docs/BT01_HEAD_BUS_PROTOCOL.md §5.
    const talkgroup = bcdNumber(payload.subarray(2, 6))
    const callerId = bcdNumber(payload.subarray(24, 28))
    return { ...decoded, type: 'async-status', statusCode: '59', talkgroup: talkgroup || null, dmrId: callerId || null, bytes: [...payload.subarray(1, -1)] }
  }
  if (payload[0] === 0x5c) return { ...decoded, type: 'async-status', statusCode: '5c', bytes: [...payload.subarray(1, -1)] }
  if (payload[0] === 0x5e) return { ...decoded, type: 'async-status', statusCode: '5e', bytes: [...payload.subarray(1, -1)] }
  if (payload[0] === 0x5f) return { ...decoded, type: 'async-status', statusCode: '5f', bytes: [...payload.subarray(1, -1)] }
  const strings = extractAsciiStrings(payload, 0)
  return strings.length ? { ...decoded, strings } : decoded
}

// Responses can arrive concatenated with unsolicited 5a (signal) and 5b
// (squelch) push frames; split on checksum-validated boundaries.
function splitFrames(buffer) {
  const frames = []
  let i = 0
  while (i < buffer.length) {
    const head = buffer[i]
    let consumed = 0
    if (head === 0x03 && i + 5 <= buffer.length && checksumOk(buffer.subarray(i, i + 5))) consumed = 5
    else if (head === 0x5b && i + 3 <= buffer.length && checksumOk(buffer.subarray(i, i + 3))) consumed = 3
    else if (head === 0x59 && i + 57 <= buffer.length && checksumOk(buffer.subarray(i, i + 57))) consumed = 57
    else if (head === 0x5a && i + 16 <= buffer.length && checksumOk(buffer.subarray(i, i + 16))) consumed = 16
    else if (head === 0x5e && i + 18 <= buffer.length && checksumOk(buffer.subarray(i, i + 18))) consumed = 18
    else if (head === 0x5c && i + 12 <= buffer.length && checksumOk(buffer.subarray(i, i + 12))) consumed = 12
    else if (head === 0x5f && i + 5 <= buffer.length && checksumOk(buffer.subarray(i, i + 5))) consumed = 5
    else if (head === 0x58 && i + 112 <= buffer.length && checksumOk(buffer.subarray(i, i + 112))) consumed = 112
    else if (head === 0x04) {
      for (let len = 4; i + len <= buffer.length; len += 1) {
        const end = i + len
        if (!checksumOk(buffer.subarray(i, end))) continue
        if (end === buffer.length || FRAME_HEADS.includes(buffer[end])) {
          consumed = len
          break
        }
      }
    }
    if (consumed === 0) {
      if (frames.length === 0) return [buffer]
      break
    }
    frames.push(Buffer.from(buffer.subarray(i, i + consumed)))
    i += consumed
  }
  return frames.length ? frames : [buffer]
}

// Frame layout for the incremental reader. Fixed-length frames by head byte;
// 0x04 is variable (length found by scanning for a checksum-valid boundary
// followed by a known next-head or end-of-stream — same rule as splitFrames).
const FIXED_FRAME_LENS = { 0x03: 5, 0x58: 112, 0x59: 57, 0x5a: 16, 0x5b: 3, 0x5c: 12, 0x5e: 18, 0x5f: 5 }
const FRAME_HEADS = [0x03, 0x04, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5e, 0x5f]
const MAX_04_FRAME_LEN = 130

// Pull complete frames off the FRONT of a continuous raw byte stream, returning
// the trailing partial frame as `remainder` (kept until more bytes arrive).
// Unlike splitFrames (which gives up and returns the whole buffer), this never
// loses bytes: a partial frame waits, and unrecognizable bytes are dropped one
// at a time to resync. `dropped` counts resync bytes (a desync signal).
function extractRawFrames(buffer) {
  const frames = []
  let i = 0
  let dropped = 0
  while (i < buffer.length) {
    const head = buffer[i]
    const fixed = FIXED_FRAME_LENS[head]
    if (fixed != null) {
      if (i + fixed > buffer.length) break // incomplete fixed frame: wait for more
      if (checksumOk(buffer.subarray(i, i + fixed)) === true) {
        frames.push(Buffer.from(buffer.subarray(i, i + fixed)))
        i += fixed
        continue
      }
      i += 1; dropped += 1; continue // bad checksum on a fixed frame: resync
    }
    if (head === 0x04) {
      let consumed = 0
      for (let len = 4; i + len <= buffer.length; len += 1) {
        const end = i + len
        if (checksumOk(buffer.subarray(i, end)) !== true) continue
        if (end === buffer.length || FRAME_HEADS.includes(buffer[end])) { consumed = len; break }
      }
      if (consumed > 0) { frames.push(Buffer.from(buffer.subarray(i, i + consumed))); i += consumed; continue }
      if (buffer.length - i <= MAX_04_FRAME_LEN) break // still arriving: wait for more
      i += 1; dropped += 1; continue // over the cap with no boundary: resync
    }
    i += 1; dropped += 1 // unknown head byte: resync
  }
  return { frames, remainder: Buffer.from(buffer.subarray(i)), dropped }
}

// Decoded frame types that warrant pushing fresh state to the UI (everything
// except bare acks / probes / unknowns).
const EMIT_TYPES = new Set(['signal', 'rx-status', 'channel', 'zone', 'settings', 'settings-06', 'settings-09', 'clock', 'firmware', 'async-status'])

// Command response matchers for sendCommand(). matchHead is the workhorse:
// command reads have a deterministic 2-byte head (e.g. 04 2c = channel A).
const matchAck = code => decoded => decoded.type === 'ack' && decoded.code === code
const matchHead = (b0, b1) => (_decoded, frame) => frame[0] === b0 && (b1 == null || frame[1] === b1)
const matchChannel = side => decoded => decoded.type === 'channel' && decoded.side === side

function cleanFixedString(raw) {
  const text = raw.toString('ascii').replace(/\0.*$/s, '').replace(/[^\x20-\x7e]/g, '').trim()
  return text || null
}

function signalFreshWindowMs(source) {
  return source?.transport === 'bt' ? Number.POSITIVE_INFINITY : SIGNAL_FRESH_MS
}

function applyDecoded(state, decoded, timestamp) {
  state.lastUpdate = timestamp
  state.rawFrames.push({ at: timestamp, type: decoded.type, raw: decoded.raw, checksumOk: decoded.checksumOk })
  state.rawFrames = state.rawFrames.slice(-20)
  if (decoded.type === 'firmware') {
    state.firmware = decoded.firmware
    state.firmwareStrings = decoded.strings ?? []
  } else if (decoded.type === 'zone' && state.sides[decoded.side]) {
    const side = state.sides[decoded.side]
    side.zone = decoded.zone
    side.zoneNumber = decoded.zoneNumber
    // Track the highest REAL zone index observed — a lower-bound fallback for the
    // down-from-0 wrap until stepZone learns the exact count. Only count zones with a
    // non-empty name so a phantom (out-of-range) zone can't inflate the fallback.
    if (decoded.zoneNumber != null && (decoded.zone ?? '').trim()) {
      side.zoneMaxSeen = Math.max(side.zoneMaxSeen ?? 0, decoded.zoneNumber)
    }
    side.channelPosition = decoded.channelPosition
    side.strings = decoded.strings ?? []
    side.rawZone = decoded.raw
    side.lastUpdate = timestamp
  } else if (decoded.type === 'channel' && state.sides[decoded.side]) {
    const side = state.sides[decoded.side]
    for (const key of ['frequencyMhz', 'frequencyDisplay', 'channelName', 'channelNumber', 'channelPosition', 'txOffsetMhz', 'txFrequencyMhz', 'bandwidthKhz', 'txPower', 'channelType', 'channelTypeName', 'txDigital', 'rawRecord08', 'rawRecord09', 'ctcssEncodeHz', 'ctcssDecodeHz', 'dcsEncodeCode', 'dcsDecodeCode', 'customCtcssHz', 'squelchMode', 'contactName', 'contactTg', 'contactTgBytes', 'contactCallType', 'dmrTailRaw', 'radioId', 'callsign', 'strings', 'channelSettingsRaw']) side[key] = decoded[key]
    side.vfoMode = isVfoChannelName(decoded.channelName) ? 'VFO' : 'MEMORY'
    side.rawChannel = decoded.raw
    side.lastUpdate = timestamp
  } else if (decoded.type === 'rx-status') {
    // 5e/5b carry only a global any-squelch-open flag; per-side comes from 5a.
    state.signal.squelchOpen = decoded.squelchOpen
    state.signal.lastRxStatusAt = timestamp
    if (decoded.statusCode === '5e') {
      // 5e = the DMR link-state GATE (byte1: 00 idle / 01 RX / 02 TX). It fires
      // ONLY on state changes — one open, then (after a long quiet) one close — so
      // we LATCH it. The DMR side's meter then holds for the whole call instead of
      // a 700ms time-hold that died mid-transmission. Per-side analog RSSI/open is
      // owned by the continuously-streamed 5a frames, so we do NOT clear it here
      // (a 5e/5b close used to zero BOTH sides and kill the analog smeter too).
      state.signal.dmrRxOpen = (decoded.statusByte ?? 0) !== 0
      // Capture the live call's match keys + group/private as voice frames stream
      // them (independent of dmrActivity, which the 58 frame creates a beat later).
      if (decoded.dmrColorCode != null) state.signal.dmrCallCc = decoded.dmrColorCode
      if (decoded.dmrSlot != null) state.signal.dmrCallSlot = decoded.dmrSlot
      if (decoded.dmrDest != null) state.signal.dmrCallDest = decoded.dmrDest
      if (decoded.dmrCallPrivate != null) state.signal.dmrCallPrivate = decoded.dmrCallPrivate
      if (state.signal.dmrRxOpen) state.signal.dmrActiveAt = timestamp
      else {
        // Gate closed = call over (the radio always sends this). Drop the latch +
        // match keys so the next call resolves its side cleanly from scratch.
        state.signal.dmrLatchSide = null
        state.signal.dmrCallCc = null
        state.signal.dmrCallSlot = null
        state.signal.dmrCallTg = null
        state.signal.dmrCallDest = null
        state.signal.dmrCallPrivate = null
      }
      if (state.dmrActivity) state.dmrActivity = {
        ...state.dmrActivity,
        active: state.signal.dmrRxOpen,
        at: timestamp,
        // CC/slot ride the 5e stream; keep the last good values for the call.
        ...(decoded.dmrColorCode != null ? { colorCode: decoded.dmrColorCode } : {}),
        ...(decoded.dmrSlot != null ? { slot: decoded.dmrSlot } : {}),
      }
    } else if (decoded.statusCode === '5b') {
      // 5b = the DMR audio gate (the radio's green→blue LED transition). The FIRST
      // open during a call is our lock: we now have the identity frames, so resolve
      // the side ONCE and latch it for the whole call (no per-frame re-eval = no
      // flapping between sides). Held until the 5e gate closes (above).
      if (decoded.squelchOpen === true && state.signal.dmrRxOpen === true && state.signal.dmrLatchSide == null) {
        state.signal.dmrLatchSide = resolveDmrCallSide(state)
      }
    } else if (decoded.statusCode === '045e') {
      // Polled 04 5e only says "some squelch is open". Use it as a DMR fallback
      // only when there is a DMR side and 5a is not already identifying an analog
      // side as open; bare 5e pushes remain authoritative.
      const hasDmrSide = isDmrChannel(state.sides?.A) || isDmrChannel(state.sides?.B)
      const signalFresh = state.signal.lastSignalAt != null && (timestamp - state.signal.lastSignalAt) < signalFreshWindowMs(state)
      const analogOpen = signalFresh && ((state.sides?.A?.txDigital !== true && state.signal.mainOpen === true)
        || (state.sides?.B?.txDigital !== true && state.signal.subOpen === true)
      )
      if (hasDmrSide && decoded.squelchOpen === true && !analogOpen) {
        state.signal.dmrRxOpen = true
        state.signal.dmrActiveAt = timestamp
        if (state.dmrActivity) state.dmrActivity = { ...state.dmrActivity, active: true, at: timestamp }
      } else if (decoded.squelchOpen === false) {
        state.signal.dmrRxOpen = false
        state.signal.dmrLatchSide = null
        state.signal.dmrCallCc = null
        state.signal.dmrCallSlot = null
        state.signal.dmrCallTg = null
        state.signal.dmrCallDest = null
        state.signal.dmrCallPrivate = null
        if (state.dmrActivity) state.dmrActivity = { ...state.dmrActivity, active: false, at: timestamp }
      }
    }
  } else if (decoded.type === 'signal') {
    // Keep the raw side-relative values; map to main/sub via the current
    // selectedSide (re-mappable once selectedSide is known — startup race).
    state.signal.activeRssi = decoded.activeRssi
    state.signal.inactiveRssi = decoded.inactiveRssi
    state.signal.activeOpen = decoded.activeOpen
    state.signal.inactiveOpen = decoded.inactiveOpen
    state.signal.lastSignalAt = timestamp
    mapSignalSides(state)
  } else if (decoded.type === 'clock') {
    state.clock = decoded.clock
  } else if (decoded.type === 'settings') {
    const firstSelect = state.selectedSide == null && decoded.selectedSide != null
    state.selectedSide = decoded.selectedSide
    state.dualWatch = decoded.dualWatch
    state.mainSquelch = decoded.mainSquelch
    state.subSquelch = decoded.subSquelch
    if (decoded.radioSettings) state.settings = { ...state.settings, ...decoded.radioSettings }
    if (firstSelect) {
      // selectedSide just became known — re-attribute anything captured during the
      // startup race (activity that arrived before the first settings read). Only on
      // the FIRST establishment, so a mid-call user side-switch doesn't re-guess.
      mapSignalSides(state)
      if (state.signal.dmrLatchSide != null) state.signal.dmrLatchSide = resolveDmrCallSide(state)
    }
  } else if (decoded.type === 'settings-06' || decoded.type === 'settings-09') {
    // Merge the block's RADIO_SETTINGS raw values (each block carries a subset).
    if (decoded.radioSettings) state.settings = { ...state.settings, ...decoded.radioSettings }
  } else if (decoded.type === 'status-probe' || decoded.type === 'async-status') {
    state.signal.rawStatus = decoded
    // Track live DMR call context from 0x58 frames. Enrich the ID via the
    // RadioID dump: a real caller resolves to a callsign (person), a talkgroup
    // does not. Keep the last seen context; `active` reflects the call state.
    if (decoded.statusCode === '58' && decoded.dmrId) {
      const op = lookupRadioid(decoded.dmrId)
      // Carry forward the in-call talkgroup (set by 59) when this is the same
      // caller (or the call context only had a TG so far); reset on a new caller.
      const prev = state.dmrActivity ?? {}
      const carry = (prev.id == null || prev.id === decoded.dmrId) ? prev : {}
      state.dmrActivity = {
        ...carry,
        id: decoded.dmrId,
        alias: decoded.dmrAlias || null,
        // 58 byte 1 is a talker-direction/context byte (`00` is valid RX talker,
        // `81` is TX talker), not a reliable call-open flag. The 5e gate owns the
        // DMR meter; 58 only carries identity/alias and refreshes the active latch
        // while 5e says a call is already open.
        active: state.signal.dmrRxOpen === true || (((decoded.callState ?? 0) & 0x80) !== 0),
        isUser: !!op,
        callsign: op?.callsign ?? null,
        name: op?.name ?? null,
        location: op?.location ?? null,
        // group/private from the 5e (source==dest ⇒ group) — set here too so the
        // private flag is known even for a call that never sends a 59.
        private: state.signal.dmrCallPrivate === true,
        at: timestamp,
      }
      if (state.signal.dmrRxOpen === true) state.signal.dmrActiveAt = timestamp
    } else if (decoded.statusCode === '59') {
      // 59 record-1 id (bytes 2-5) is the call destination = the talkgroup for a
      // GROUP call. For a PRIVATE call there's no incoming TG (it's a unit→unit
      // call), so we suppress it. Group/private comes from the 5e voice frame
      // (source==dest ⇒ group; see dmrCallPrivate), which streams before the 59.
      const dest = decoded.talkgroup
      const isPrivate = state.signal.dmrCallPrivate === true
      const tg = isPrivate ? null : dest
      if (dest != null) state.signal.dmrCallTg = tg
      const base = state.dmrActivity ?? {}
      state.dmrActivity = {
        ...base,
        ...(dest != null ? { talkgroup: tg, private: isPrivate } : {}),
        ...(decoded.dmrId && base.id == null ? { id: decoded.dmrId } : {}),
        at: timestamp,
      }
    }
  }
}

function anytoneToState(source) {
  const main = source.sides?.A ?? {}
  const sub = source.sides?.B ?? {}
  const connected = !!source.connected
  const firmware = source.firmware
  // Uncalibrated: 5a levels grow with RX activity (0 idle, ~4 active).
  const meterFor = (open, rssi) => (open ? Math.min(255, 48 + (rssi ?? 0) * 24) : 0)
  // 5a's main/sub mapping is meaningless until the first settings read tells us
  // which side is selected — suppress the analog meter until then so startup
  // activity never lights the wrong side (it re-attributes once selectedSide lands).
  const sideKnown = source.selectedSide != null
  const signalFresh = sideKnown && source.signal?.lastSignalAt != null && (Date.now() - source.signal.lastSignalAt) < signalFreshWindowMs(source)
  // DMR meter is driven by the call LATCH, not the raw 5e gate: we show NOTHING
  // until the call locks (5b audio gate opens after 5e RX), at which point the side
  // is resolved once and stored in `dmrLatchSide` (held until 5e closes — the radio
  // always sends the close, so no backstop). This skips the green/carrier phase and
  // the bursty 5a entirely. `dmrLatchSide` is the matched/active side or null.
  const DMR_RX_METER = 200
  const dmrSide = source.signal?.dmrLatchSide ?? null
  const mainMeter = main.txDigital === true
    ? (dmrSide === 'A' ? DMR_RX_METER : 0)
    : meterFor(signalFresh && source.signal?.mainOpen === true, source.signal?.mainRssi)
  const subMeter = sub.txDigital === true
    ? (dmrSide === 'B' ? DMR_RX_METER : 0)
    : meterFor(signalFresh && source.signal?.subOpen === true, source.signal?.subRssi)
  const mainVfoMode = vfoModeForSide(main)
  const subVfoMode = vfoModeForSide(sub)
  const transmitting = connected && !!source.pttActive
  return {
    connected,
    connecting: !!source.connecting,
    // BT connection-chain progress for the UI (adapter/discover/pair/trust/connect/ready).
    btStep: source.btStep ?? null,
    btStepDetail: source.btStepDetail ?? null,
    btAddress: source.btAddress ?? null,
    transport: source.transport || 'bt',
    transportLabel: source.transportLabel || 'Bluetooth',
    transportMode: source.transportMode || 'EXTERNAL BT MODE',
    transportLink: source.transportLink || 'rfcomm',
    transportFraming: source.transportFraming || 'raw',
    audio: source.audio || TRANSPORTS.bt.audio,
    port: source.transport === 'wired' ? wiredSerialPath() : `BT-01 ${source.addr || RADIO_ADDR}`,
    baudRate: source.transport === 'wired' ? WIRED_BAUD_RATE : 0,
    autoInfo: connected,
    mainFreq: mhzToHz(main.frequencyMhz),
    subFreq: mhzToHz(sub.frequencyMhz),
    mainTxFreq: txFrequencyForSide(main),
    subTxFreq: txFrequencyForSide(sub),
    mainMode: modeForSide(main),
    subMode: modeForSide(sub),
    // While transmitting (PTT active) the radio isn't receiving, so the RX
    // S-meter is meaningless — zero both meters until PTT releases.
    mainSmeter: connected ? (transmitting ? 0 : mainMeter) : null,
    subSmeter: connected ? (transmitting ? 0 : subMeter) : null,
    txState: transmitting,
    mox: false,
    split: false,
    memorySplit: false,
    rawSplit: null,
    vfoSplit: false,
    vfoSplitFreq: null,
    lock: null,
    agcMain: null,
    rfGainMain: null,
    afGainMain: null,
    sqMain: connected ? (source.mainSquelch ?? null) : null,
    agcSub: null,
    rfGainSub: null,
    afGainSub: null,
    sqSub: connected ? (source.subSquelch ?? null) : null,
    sqlRfMode: null,
    powerLevel: null,
    radioInfo: connected ? `AnyTone AT-D578UVIII ${source.transportLabel || 'Bluetooth'}` : null,
    amcLevel: null,
    micGain: connected ? (source.settings?.micGain ?? null) : null,
    // All radio settings as a display-ready list. `writable` items render as
    // click-to-edit boxes (enum → option list, else numeric stepper); read-only
    // items (Fan/GPS) render as plain badges. `value` is the raw byte; `editValue`
    // is the numeric on-screen value seeding the stepper (raw + add).
    settings: connected
      ? RADIO_SETTINGS.map(f => {
          const raw = source.settings?.[f.key] ?? null
          return {
            key: f.key,
            label: f.label,
            value: raw,
            display: settingDisplay(f, raw),
            writable: f.write != null,
            type: f.enum ? 'enum' : 'num',
            min: f.min ?? null,
            max: f.max ?? null,
            editValue: raw == null ? null : raw + (f.add ?? 0),
            options: f.enum ? Object.entries(f.enum).map(([v, label]) => ({ value: Number(v), label })) : null,
          }
        })
      : [],
    // Per-channel settings (2f writes), one list per side, rendered inside each
    // VFO card. Same display-list shape as `settings`; `value` is the raw byte
    // (null = not yet read back — only type/power/bandwidth read back today, the
    // rest are write-then-reconcile). `channelSettingsSide` = the active/editable
    // side (the 2f family writes the selected side; editing the other selects it).
    mainChannelSettings: connected ? channelSettingsListFor(main.channelSettingsRaw) : [],
    subChannelSettings: connected ? channelSettingsListFor(sub.channelSettingsRaw) : [],
    channelSettingsSide: connected ? (source.selectedSide === 'B' ? 'B' : 'A') : null,
    // RX/TX tone (CTCSS/DCS) per side for the dedicated tone popup (null = hidden,
    // e.g. on a pure-digital channel). Edited via /channel-tone.
    mainRxTone: connected ? toneStateFor(main, 'rx') : null,
    mainTxTone: connected ? toneStateFor(main, 'tx') : null,
    subRxTone: connected ? toneStateFor(sub, 'rx') : null,
    subTxTone: connected ? toneStateFor(sub, 'tx') : null,
    usbOutLevel: null,
    usbOutLevelByMode: { ssb: null, am: null, fm: null, data: null },
    usbModGain: null,
    usbModGainByMode: { ssb: null, am: null, fm: null, data: null },
    speechProc: null,
    speechProcLevel: null,
    funcKnob: null,
    vox: null,
    voxGain: null,
    txVfo: source.selectedSide === 'B' ? 1 : 0,
    // TX Prohibit (channel byte 11 bit 5) on the side PTT would key (the selected
    // side) — the UI greys out PTT when set so we don't try to TX on an RX-only
    // channel. Per-side too, for completeness.
    mainTxProhibit: main.channelSettingsRaw?.txProhibit === 1,
    subTxProhibit: sub.channelSettingsRaw?.txProhibit === 1,
    txProhibited: connected && (source.selectedSide === 'B' ? sub : main).channelSettingsRaw?.txProhibit === 1,
    rxMode: source.dualWatch === true ? 'dual' : 'single',
    mainVfoMode,
    subVfoMode,
    mainMemoryChannel: main.channelNumber ?? main.zone ?? null,
    subMemoryChannel: sub.channelNumber ?? sub.zone ?? null,
    mainMemoryTag: main.channelName ?? null,
    subMemoryTag: sub.channelName ?? null,
    mainZone: main.zone ?? null,
    subZone: sub.zone ?? null,
    // Channel scroll position within the zone, 1-based for display.
    mainZonePosition: main.channelPosition != null ? main.channelPosition + 1 : null,
    subZonePosition: sub.channelPosition != null ? sub.channelPosition + 1 : null,
    // DMR contact programmed on the selected channel (talkgroup / private call).
    mainContactName: main.contactName ?? null,
    mainContactTg: main.contactTg ?? null,
    mainContactCallType: main.contactCallType ?? null,
    subContactName: sub.contactName ?? null,
    subContactTg: sub.contactTg ?? null,
    subContactCallType: sub.contactCallType ?? null,
    // Live DMR call context (caller during RX), enriched from the RadioID dump.
    // CC/slot come from the reliably-captured live keys (dmrCallCc/Slot): the 58
    // creates dmrActivity a beat AFTER the first 5e voice frame, so dmrActivity's
    // own merge intermittently misses them while the TG (from 59) is always set.
    // Fall back to whatever dmrActivity merged once the call ends + keys clear.
    dmrActivity: connected && source.dmrActivity
      ? { ...source.dmrActivity,
          colorCode: source.signal?.dmrCallCc ?? source.dmrActivity.colorCode ?? null,
          slot: source.signal?.dmrCallSlot ?? source.dmrActivity.slot ?? null }
      : null,
    // The vfo (0=main/A, 1=sub/B) the live DMR call is attributed to — the latched
    // side from resolveDmrCallSide (match else active). Null until a call locks.
    // Live-call badges follow this so they appear ONLY on the resolved side.
    dmrCallVfo: dmrSide === 'A' ? 0 : dmrSide === 'B' ? 1 : null,
    // Sticky manual-dial DMR target overriding the PTT contact (null = channel contact).
    manualDial: source.manualDial ?? null,
    radioMemories: [],
    radioMemoryScanActive: false,
    radioMemoryScanProgress: 0,
    radioMemoryScanTotal: 0,
    radioMemoryScanError: null,
    pseudoScanActive: false,
    pseudoScanVfo: null,
    pseudoScanChannels: [],
    pseudoScanIndex: 0,
    pseudoScanCurrentChannel: null,
    pseudoScanWaiting: false,
    pseudoScanBusy: false,
    pseudoScanLastMeter: null,
    pseudoScanLastSquelch: null,
    pseudoScanPauseReason: null,
    pseudoScanError: null,
    mainSqlType: sqlTypeForSide(main),
    subSqlType: sqlTypeForSide(sub),
    mainCtcssTone: ctcssToneIndexForSide(main),
    subCtcssTone: ctcssToneIndexForSide(sub),
    mainDcsCode: dcsCodeIndexForSide(main),
    subDcsCode: dcsCodeIndexForSide(sub),
    dnrMain: null,
    dnrSub: null,
    mainBandwidth: main.bandwidthKhz ?? null,
    subBandwidth: sub.bandwidthKhz ?? null,
    mainTxPower: main.txPower ?? null,
    subTxPower: sub.txPower ?? null,
    mainShift: null,
    subShift: null,
    narrowMain: narrowForSide(main),
    narrowSub: narrowForSide(sub),
    rfAttenuator: false,
    preAmpHf: null,
    preAmpVhf: null,
    preAmpUhf: null,
    scopeSide: false,
    scope: { mode: null, span: null, speed: null, level: null, att: null, color: null, marker: true },
    firmware: { main: firmware, display: null, sdr: null, dsp: null, spa1: null, fc80: null },
    antSelect: null,
    lastUpdate: source.lastUpdate || Date.now(),
    error: source.error,
  }
}

// UI SQL type codes: 0 OFF, 1 CTCSS ENC, 2 CTCSS SQL, 3 DCS
function sqlTypeForSide(side) {
  if (!side || side.squelchMode == null) return null
  if (side.squelchMode === 'dcs') return 3
  if (side.squelchMode === 'ctcss') return 2
  return side.ctcssEncodeHz != null ? 1 : 0
}

// UI displays CTCSS_TONES[index]; prefer the decode tone when tone squelch is
// active, otherwise show the encode tone.
function ctcssToneIndexForSide(side) {
  const hz = side?.squelchMode === 'ctcss' ? (side.ctcssDecodeHz ?? side.ctcssEncodeHz) : side?.ctcssEncodeHz
  if (hz == null) return null
  const index = CTCSS_TONES.indexOf(hz)
  return index >= 0 ? index : null
}

function checksumOk(payload) {
  if (payload.length < 2) return null
  let sum = 0
  for (let i = 0; i < payload.length - 1; i += 1) sum = (sum + payload[i]) & 0xff
  return sum === payload[payload.length - 1]
}

// How many checksum-valid frames a buffer splits into. Used by the keepalive
function decodeBcdFrequency(raw) {
  if (raw.length !== 4 || [...raw].some(value => ((value >> 4) > 9) || ((value & 0x0f) > 9))) return null
  const mhz = Number([...raw].map(value => value.toString(16).padStart(2, '0')).join('')) / 100000
  return isD578FrequencyMhz(mhz) ? mhz : null
}

function isD578FrequencyMhz(mhz) {
  return (mhz >= 108 && mhz <= 180) || (mhz >= 200 && mhz <= 260) || (mhz >= 350 && mhz <= 530)
}

function extractAsciiStrings(payload, start, minLen = 4) {
  const strings = []
  let current = []
  for (const value of payload.subarray(start)) {
    if (value >= 32 && value <= 126) current.push(value)
    else {
      if (current.length >= minLen) strings.push(Buffer.from(current).toString('ascii').trim())
      current = []
    }
  }
  if (current.length >= minLen) strings.push(Buffer.from(current).toString('ascii').trim())
  const cleaned = []
  for (const value of strings.map(cleanAsciiString)) {
    if (value && !cleaned.includes(value)) cleaned.push(value)
  }
  return cleaned
}

function cleanAsciiString(value) {
  let clean = String(value).replace(/\s+/g, ' ').trim().replace(/^["'`~!@#$%^&*()_+=[\]{}|;:,<>?/]+/, '')
  if (clean.length > 1 && /[a-z]/.test(clean[0]) && /[A-Z]/.test(clean[1])) clean = clean.slice(1)
  const callsign = clean.match(/\b[A-Z]{1,3}\d[A-Z0-9]{1,4}\b/)
  if (callsign && clean.length - callsign[0].length <= 3) return callsign[0]
  return clean.trim()
}

function mhzToHz(value) {
  if (value == null) return null
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number * 1000000) : null
}

function hexdump(payload) {
  return [...payload].map(value => value.toString(16).padStart(2, '0')).join(' ')
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const backend = new AnyToneBackend()

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch(err => sendJson(res, err.statusCode || 500, { error: err.message || String(err) }))
})

// /raw/ws — bidirectional raw head-bus channel for local BT-01 relay clients.
// The backend stays the single owner of the radio link:
// inbound WS messages are injected through the serial queue (injectRaw), and every
// rx/tx frame is mirrored out (broadcastRaw). On connect the client gets a one-shot
// register snapshot so it can answer a head's startup without touching the radio.
const rawWss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (pathname !== '/raw/ws') { socket.destroy(); return }
  rawWss.handleUpgrade(req, socket, head, ws => rawWss.emit('connection', ws, req))
})
rawWss.on('connection', ws => {
  backend.rawStreamClients.add(ws)
  const registers = {}
  for (const [reg, frame] of backend.registerCache) registers[reg.toString(16).padStart(2, '0')] = frame.toString('hex')
  try {
    ws.send(JSON.stringify({ type: 'snapshot', connected: backend.state.connected, transport: backend.transport.id, registers }))
  } catch {}
  ws.on('message', data => {
    let frame
    try {
      const msg = JSON.parse(data.toString())
      const hex = String(msg.hex || '').replace(/[^0-9a-fA-F]/g, '')
      if (!hex || hex.length % 2) return
      frame = Buffer.from(hex, 'hex')
    } catch { return }
    backend.injectRaw(frame).catch(err => {
      try { ws.send(JSON.stringify({ type: 'error', error: err?.message ?? String(err) })) } catch {}
    })
  })
  ws.on('close', () => backend.rawStreamClients.delete(ws))
  ws.on('error', () => backend.rawStreamClients.delete(ws))
})

server.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`AnyTone Node server listening on http://${HTTP_HOST}:${HTTP_PORT}`)
  console.log(`[anytone] transports: bt=${USE_RFCOMM_SOCKET ? 'raw RFCOMM socket' : 'rfcomm TTY'} raw, wired=${wiredSerialPath()} ADATA @ ${WIRED_BAUD_RATE} | bt=streaming+pushACK${PUSH_ACK ? '' : ' (OFF)'}, link-health informational`)
  // Load the RadioID DMR user dump for caller lookups (non-fatal if missing).
  try {
    const st = loadRadioid()
    console.log(st.loaded ? `[anytone] RadioID dump loaded: ${st.count} users from ${st.path}` : `[anytone] RadioID dump not found at ${st.path} — POST /radioid/refresh to download`)
  } catch (err) {
    console.log(`[anytone] RadioID load failed: ${err?.message ?? err}`)
  }
})

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

async function shutdown() {
  await backend.disconnect(false).catch(() => {})
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (req.method === 'GET' && (url.pathname === '/status' || url.pathname === '/anytone/status')) return sendJson(res, 200, backend.getState())
  if (req.method === 'GET' && url.pathname === '/raw/status') return sendJson(res, 200, backend.getState())
  if (req.method === 'GET' && url.pathname === '/raw/registers') {
    // Snapshot of the last raw 04-read response per register, keyed by hex code
    // (e.g. "05","29","2c"). The relay seeds a head's startup from this.
    const registers = {}
    for (const [reg, frame] of backend.registerCache) registers[reg.toString(16).padStart(2, '0')] = frame.toString('hex')
    return sendJson(res, 200, { connected: backend.state.connected, transport: backend.transport.id, registers })
  }
  if (req.method === 'GET' && url.pathname === '/raw/async') {
    const frames = backend.getState().asyncFrames
    const limit = Math.max(1, Math.min(ASYNC_LOG_LIMIT, Number(url.searchParams.get('limit')) || ASYNC_LOG_LIMIT))
    return sendJson(res, 200, { logPath: ASYNC_LOG_PATH, logToFile: ASYNC_LOG_TO_FILE, count: frames.length, frames: frames.slice(-limit) })
  }
  if (req.method === 'POST' && url.pathname === '/raw/async/clear') {
    backend.state.asyncFrames = []
    return sendJson(res, 200, { ok: true })
  }
  if (req.method === 'GET' && url.pathname === '/radioid/status') {
    return sendJson(res, 200, radioidStatus())
  }
  if (req.method === 'GET' && url.pathname === '/radioid/lookup') {
    const id = url.searchParams.get('id')
    return sendJson(res, 200, { id, record: lookupRadioid(id) })
  }
  if (req.method === 'POST' && url.pathname === '/radioid/refresh') {
    try {
      const st = await downloadRadioid()
      return sendJson(res, 200, { ok: true, ...st })
    } catch (err) {
      return sendJson(res, 500, { error: err?.message ?? String(err) })
    }
  }
  // Zone selector: every zone with its channels, enumerated once at connect into
  // zoneChannelsCache (04 2b zones → per-zone 08 39 + 04 4a members + 04 2e names).
  // `?force=1` re-enumerates everything (the Refresh button; blocks while it runs).
  // Selection goes through /anytone/command: ZONE:<i> / CH:<side>:<i> / ZC:<side>:<z>:<c>.
  if (req.method === 'GET' && (url.pathname === '/zones' || url.pathname === '/anytone/zones')) {
    try {
      if (url.searchParams.get('force') === '1') await backend.enumerateAllZones({ force: true })
      // Prefer the full zone→channels cache; fall back to bare zone names if a
      // (re)enumeration hasn't completed yet.
      const zones = backend.zoneChannelsCache
        ?? (backend.zoneListCache ?? []).map(z => ({ index: z.index, name: z.name, channels: [] }))
      return sendJson(res, 200, { zones, version: backend.zoneEnumVersion })
    } catch (err) { return sendJson(res, 500, { error: err?.message ?? String(err) }) }
  }
  // Global menu setting write (mic/speaker gain, NR, DigiMon). { key, value }
  // where value is the radio's on-screen value. Write-only on the radio side;
  // readback comes from the settings-block decode once Phase A maps the offsets.
  if (req.method === 'POST' && (url.pathname === '/setting' || url.pathname === '/anytone/setting')) {
    const body = await readJson(req)
    try {
      const state = await backend.setRadioSetting(String(body.key || ''), body.value)
      return sendJson(res, 200, { ok: true, state })
    } catch (err) { return sendJson(res, 400, { error: err?.message ?? String(err) }) }
  }
  // Per-channel setting write (2f family) on the currently-selected side. { key, value }
  // where value is the raw enum/numeric byte. See CHANNEL_SETTINGS / setChannelSetting.
  if (req.method === 'POST' && (url.pathname === '/channel-setting' || url.pathname === '/anytone/channel-setting')) {
    const body = await readJson(req)
    try {
      const state = await backend.setChannelSetting(String(body.key || ''), body.value, body.side ?? null)
      return sendJson(res, 200, { ok: true, state })
    } catch (err) { return sendJson(res, 400, { error: err?.message ?? String(err) }) }
  }
  // Per-channel name write (2f 24). { name, side? } — side selects A/B first.
  if (req.method === 'POST' && (url.pathname === '/channel-name' || url.pathname === '/anytone/channel-name')) {
    const body = await readJson(req)
    try {
      const state = await backend.setChannelName(String(body.name ?? ''), body.side ?? null)
      return sendJson(res, 200, { ok: true, state })
    } catch (err) { return sendJson(res, 400, { error: err?.message ?? String(err) }) }
  }
  // RX/TX frequency write (2f 03 / 2f 04) on a side's working channel.
  // { band:'rx'|'tx', hz, side? } — hz in Hz; side selects A/B first.
  if (req.method === 'POST' && (url.pathname === '/frequency' || url.pathname === '/anytone/frequency')) {
    const body = await readJson(req)
    try {
      const band = String(body.band ?? '').toLowerCase()
      if (band !== 'rx' && band !== 'tx') throw new Error("band must be 'rx' or 'tx'")
      const side = body.side ?? null
      const state = band === 'tx'
        ? await backend.setTransmitFrequency(body.hz, side)
        : await backend.setReceiveFrequency(body.hz, side)
      return sendJson(res, 200, { ok: true, state })
    } catch (err) { return sendJson(res, 400, { error: err?.message ?? String(err) }) }
  }
  // RX/TX tone (CTCSS/DCS) write. { field:'rx'|'tx', type:'off'|'ctc'|'dcs', value, inverted?, side? }
  if (req.method === 'POST' && (url.pathname === '/channel-tone' || url.pathname === '/anytone/channel-tone')) {
    const body = await readJson(req)
    try {
      const state = await backend.setChannelTone(String(body.field ?? ''), String(body.type ?? ''), body.value, !!body.inverted, body.side ?? null)
      return sendJson(res, 200, { ok: true, state })
    } catch (err) { return sendJson(res, 400, { error: err?.message ?? String(err) }) }
  }
  if (req.method === 'GET' && (url.pathname === '/events' || url.pathname === '/anytone/events')) return handleEvents(req, res)
  if (req.method === 'GET' && url.pathname === '/anytone/ports') {
    // One dropdown entry per PAIRED radio so multiple D578s can be told apart and
    // picked individually; fall back to a generic BT entry when none are paired yet.
    let btPorts = []
    try {
      const radios = (await backend.btManager.listRadios()).filter(r => r.paired)
      btPorts = radios.map(r => ({ path: r.address, label: r.name || 'AnyTone radio', manufacturer: r.address, serialNumber: r.address, vendorId: null, productId: null, transport: 'bt', address: r.address }))
    } catch (err) { backend.log(`ports: radio enumeration failed: ${err?.message ?? err}`) }
    if (!btPorts.length) btPorts = [{ path: 'bt', label: 'Bluetooth (scan to pair a radio)', manufacturer: 'AnyTone Bluetooth', serialNumber: RADIO_ADDR, vendorId: null, productId: null, transport: 'bt', address: null }]
    return sendJson(res, 200, { ports: [
      ...btPorts,
      { path: 'wired', label: 'Wired digirig', manufacturer: 'Digirig serial + ALSA', serialNumber: wiredSerialPath(), vendorId: '10c4', productId: 'ea60', transport: 'wired' },
    ] })
  }
  if (req.method === 'POST' && (url.pathname === '/connect' || url.pathname === '/anytone/connect')) {
    const state = await backend.connect(await readJson(req))
    return sendJson(res, 200, { ok: true, state })
  }
  if (req.method === 'POST' && (url.pathname === '/disconnect' || url.pathname === '/anytone/disconnect')) {
    const state = await backend.disconnect()
    return sendJson(res, 200, { ok: true, state })
  }
  if (req.method === 'POST' && url.pathname === '/bt/teardown') {
    const state = await backend.disconnect()
    backend.stopBluealsaHfp()
    return sendJson(res, 200, { ok: true, state })
  }
  // BT pairing/discovery management (BlueZ over D-Bus). Lets the UI find, pair, and
  // forget radios without dropping to a terminal — the manual fallback to the
  // automatic scan→pair→trust that Connect already performs.
  if (req.method === 'GET' && url.pathname === '/bt/status') {
    return sendJson(res, 200, await backend.btStatus())
  }
  if (req.method === 'POST' && url.pathname === '/bt/scan') {
    const radios = await backend.btManager.scanForRadios({ timeoutMs: Number((await readJson(req)).timeoutMs) || undefined })
    return sendJson(res, 200, { ok: true, radios })
  }
  if (req.method === 'POST' && url.pathname === '/bt/pair') {
    const body = await readJson(req)
    const address = await (body.address ? backend.btManager.pairAddress(body.address) : backend.btManager.ensureReady())
    return sendJson(res, 200, { ok: true, address, status: backend.btManager.statusSnapshot() })
  }
  if (req.method === 'POST' && url.pathname === '/bt/forget') {
    const body = await readJson(req)
    await backend.btManager.forget(body.address)
    return sendJson(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/raw/query') {
    const body = await readJson(req)
    const hex = String(body.hex || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
    const payload = Buffer.from(hex, 'hex')
    // Read-only safety: allow 6-byte 0x04 reads and the 0x61 keepalive, nothing else.
    const isRead = payload.length === 6 && payload[0] === 0x04
    const isWake = payload.length === 1 && payload[0] === 0x61
    if (!isRead && !isWake) return sendJson(res, 400, { error: 'only 6-byte 04-xx read frames or 61 keepalive are allowed' })
    const response = await backend.rawQuery(payload, { timeoutMs: Number(body.timeoutMs) || 1200, idleMs: Number(body.idleMs) || 150 })
    return sendJson(res, 200, { request: hexdump(payload), response: hexdump(response), length: response.length })
  }
  if (req.method === 'POST' && url.pathname === '/raw/send') {
    // EXPERIMENTAL write/command primitive for channel/zone-change research.
    // Sends an arbitrary frame and returns the response. Guarded by a confirm
    // token; optionally appends an additive checksum byte. Can corrupt the
    // codeplug — recover by re-flashing from CPS.
    const body = await readJson(req)
    if (body.confirm !== 'WRITE') return sendJson(res, 400, { error: 'pass {"confirm":"WRITE","hex":"..."} — this can corrupt the codeplug' })
    const hex = String(body.hex || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
    let payload = Buffer.from(hex, 'hex')
    if (!payload.length) return sendJson(res, 400, { error: 'hex required' })
    if (body.appendChecksum) {
      let sum = 0
      for (const b of payload) sum = (sum + b) & 0xff
      payload = Buffer.concat([payload, Buffer.from([sum])])
    }
    const response = await backend.rawQuery(payload, { timeoutMs: Number(body.timeoutMs) || 1200, idleMs: Number(body.idleMs) || 150 })
    return sendJson(res, 200, { request: hexdump(payload), response: hexdump(response), length: response.length })
  }
  if (req.method === 'POST' && url.pathname === '/raw/ptttest') {
    const body = await readJson(req)
    if (body.confirm !== 'TRANSMIT') return sendJson(res, 400, { error: 'PTT test keys the transmitter. Pass {"confirm":"TRANSMIT","holdMs":1000} to proceed.' })
    const result = await backend.pttTest(body.holdMs)
    return sendJson(res, 200, { ok: true, ...result })
  }
  if (req.method === 'POST' && url.pathname === '/raw/keytest') {
    const body = await readJson(req)
    const code = KEY_CODES[String(body.key || 'up').toLowerCase()]
    if (code == null) return sendJson(res, 400, { error: `unknown key '${body.key}'` })
    const holdMs = body.holdMs == null ? undefined : Math.max(20, Math.min(3000, Number(body.holdMs) || 120))
    const responses = await backend.pressKey(code, { variant: String(body.variant || 'raw41'), holdMs })
    return sendJson(res, 200, { ok: true, variant: body.variant, responses })
  }
  if (req.method === 'POST' && url.pathname === '/anytone/dmr-dial') {
    const body = await readJson(req)
    try {
      if (body?.clear === true || body?.target == null || String(body.target).trim() === '') {
        return sendJson(res, 200, { state: backend.clearManualDial() })
      }
      const state = backend.setManualDial(body.target, body.callType)
      return sendJson(res, 200, { state })
    } catch (err) {
      return sendJson(res, 400, { error: err?.message ?? 'manual dial failed' })
    }
  }
  if (req.method === 'POST' && url.pathname === '/anytone/command') {
    const body = await readJson(req)
    const command = String(body.command || '').trim().toUpperCase()
    const commandSide = body.side === 'B' || body.vfo === '1' ? 'B' : body.side === 'A' || body.vfo === '0' ? 'A' : null
    if (command === 'TX1' || command === 'TX2') {
      const state = await backend.setPtt(true)
      return sendJson(res, 200, { response: '', state })
    }
    if (command === 'TX0' || command === 'TX' || command === 'RX') {
      const state = await backend.setPtt(false)
      return sendJson(res, 200, { response: '', state })
    }
    if (command.startsWith('TX') || command.includes('PTT')) return sendJson(res, 403, { error: 'Unsupported TX/PTT command for AnyTone Bluetooth mode' })
    // FT0/FT1 = select active TX/RX side A/B (UI VFO-card click). Confirmed BT write.
    if (command === 'FT0') {
      const state = await backend.selectSide('A')
      return sendJson(res, 200, { response: '', state })
    }
    if (command === 'FT1') {
      const state = await backend.selectSide('B')
      return sendJson(res, 200, { response: '', state })
    }
    // VM0/VM1 mode writes using CAT/UI semantics: VMx00 = VFO, VMx11 = memory.
    // Accept VMx01 as VFO too, because the underlying raw 57 3d value is 01.
    const vmSet = command.match(/^VM([01])(00|01|11)$/)
    if (vmSet) {
      const side = vmSet[1] === '1' ? 'B' : 'A'
      const vfoMode = vmSet[2] !== '11'
      const state = await backend.setVfoMemoryMode(vfoMode, side)
      return sendJson(res, 200, { response: '', state })
    }
    // Zone up/down on the selected side — confirmed BT write (08 39). Optional
    // explicit select via "ZONE:<zero-based index>".
    if (command === 'ZONE_UP' || command === 'ZONEUP') {
      const state = await backend.stepZone(1, commandSide)
      return sendJson(res, 200, { response: '', state })
    }
    if (command === 'ZONE_DN' || command === 'ZONE_DOWN' || command === 'ZONEDN') {
      const state = await backend.stepZone(-1, commandSide)
      return sendJson(res, 200, { response: '', state })
    }
    const zoneSet = command.match(/^ZONE[ _:=-]?(\d+)$/)
    if (zoneSet) {
      const state = await backend.selectZone(Number(zoneSet[1]))
      return sendJson(res, 200, { response: '', state })
    }
    if (command === 'UP' || command === 'DN') {
      const state = await backend.stepChannel(command === 'UP' ? 1 : -1, commandSide)
      return sendJson(res, 200, { response: '', state })
    }
    // ZC:<side>:<zone index>:<in-zone position> — channel-list jump to a zone+channel.
    const zcSet = command.match(/^ZC:([AB]):(\d+):(\d+)$/)
    if (zcSet) {
      const state = await backend.selectZoneChannel(Number(zcSet[2]), Number(zcSet[3]), zcSet[1])
      return sendJson(res, 200, { response: '', state })
    }
    // CH:<side?>:<absolute in-zone index> — "click a channel" within the active zone.
    // Forms: "CH:5", "CH:A:5", "CH:B:5"; side falls back to commandSide / active.
    const chSet = command.match(/^CH[ _:=-]?(?:([AB])[ _:=-]?)?(\d+)$/)
    if (chSet) {
      const side = chSet[1] || commandSide
      const state = await backend.selectChannel(Number(chSet[2]), side)
      return sendJson(res, 200, { response: '', state })
    }
    const keyMatch = command.match(/^KEY[ _:-]?(.+)$/)
    if (keyMatch) {
      const code = KEY_CODES[keyMatch[1].toLowerCase()]
      if (code == null) return sendJson(res, 400, { error: `unknown key '${keyMatch[1]}'` })
      await backend.pressKey(code)
      return sendJson(res, 200, { response: '', state: backend.getState() })
    }
    return sendJson(res, 200, { response: '', state: backend.getState() })
  }
  sendJson(res, 404, { error: 'not found' })
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = state => res.write(`data: ${JSON.stringify(state)}\n\n`)
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000)
  backend.on('stateChange', send)
  send(backend.getState())
  req.on('close', () => {
    clearInterval(keepalive)
    backend.off('stateChange', send)
  })
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) })
  res.end(data)
}

function readJson(req) {
  return new Promise(resolve => {
    const chunks = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { resolve({}) }
    })
  })
}
