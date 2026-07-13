// Live smoke test for the native transport + Bluetooth seam — the only thing in the redesign
// that talks to the real radio. READ-ONLY: harvested BtManager does the BlueZ connection
// (pair/trust/connect all profiles), then the RFCOMM socket opens and we do the handshake +
// a couple of reads and stream. It NEVER keys PTT or writes a setting.
//
// Run on the Pi, with the anytone service stopped (the radio link is single-owner):
//   systemctl --user stop anytone
//   node --import tsx examples/rfcomm-smoke.ts [BT_ADDR] [SPP_CHANNEL]
//   systemctl --user start anytone

import { BluealsaHfp } from '../src/audio'
import { createBtManager } from '../src/bluetooth'
import { ensureRadioReady } from '../src/services/connect'
import { Session } from '../src/services/session'
import { RfcommTransport } from '../src/transport/rfcomm'

const mac = process.argv[2] ?? process.env['ANYTONE_BT_ADDR']
const channel = Number(process.argv[3] ?? process.env['ANYTONE_SPP_CHANNEL'] ?? 2)

if (!mac || mac === 'AA:BB:CC:DD:EE:FF') {
  console.error('usage: rfcomm-smoke.ts <BT_ADDR> [SPP_CHANNEL]   (or set ANYTONE_BT_ADDR)')
  process.exit(1)
}

const transport = new RfcommTransport(mac, channel, { debug: true })
const session = new Session(
  transport,
  { timeoutMs: 1000, maxAttempts: 10, gapMs: 10 },
  () => Date.now(),
  {
    onState: (s) => {
      console.log(
        `[state] fw=${s.firmware ?? '—'} clock=${s.clock ? `${s.clock.hour}:${s.clock.minute}:${s.clock.second}` : '—'}` +
          ` A=${s.sides.a.freqMHz ?? '—'}/${s.sides.a.channelName} B=${s.sides.b.freqMHz ?? '—'}/${s.sides.b.channelName}` +
          ` sql=${s.audioGate ? 'OPEN' : 'closed'} rssi A/B=${s.signal.aRssi}/${s.signal.bRssi}`,
      )
    },
    onFailed: (cmd, reason) => console.warn(`[cmd] op 0x${cmd.op.toString(16)} failed: ${reason}`),
  },
)

async function main(): Promise<void> {
  const bt = createBtManager({ address: mac!, log: (m) => console.log(m) })
  const audio = new BluealsaHfp((m) => console.log(`[audio] ${m}`))
  console.log('[bt] bringing radio ready (pair/trust → HFP → connect → confirm HFP PCM)…')
  const { pcm } = await ensureRadioReady(bt, audio)
  console.log(`[bt] ready — HFP audio live at ${pcm}`)

  console.log(`[rfcomm] opening SPP socket ${mac} ch${channel} …`)
  transport.connect()

  process.on('SIGINT', () => {
    session.close()
    transport.close()
    bt.close()
    console.log('\n[rfcomm] closed')
    process.exit(0)
  })

  console.log('[rfcomm] running startup enumeration …')
  await session.connect() // wake → COM_MODE → full enumeration → COM_CHECK_END
  console.log('[rfcomm] enumeration complete — streaming (Ctrl-C to stop)\n')
}

main().catch((e: unknown) => {
  console.error('[smoke] failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
