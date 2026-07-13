// Scan for AnyTone radios via the harvested BtManager (read-only — no pair/connect). Proves
// the bluez.ts D-Bus layer + the Classic-vs-shadow dedupe against the real adapter.
//
//   node --import tsx examples/bt-scan.ts [BT_ADDR] [TIMEOUT_MS]

import { createBtManager, HFP_AG_UUID, SPP_UUID } from '../src/bluetooth'

const mac = process.argv[2] ?? process.env['ANYTONE_BT_ADDR']
const timeoutMs = Number(process.argv[3] ?? 8000)
const haveMac = !!mac && mac !== 'AA:BB:CC:DD:EE:FF'

async function main(): Promise<void> {
  const bt = createBtManager(haveMac ? { address: mac!, log: (m) => console.log(m) } : { log: (m) => console.log(m) })
  const adapter = await bt.adapterInfo()
  console.log(`[scan] adapter ${adapter.address} powered=${adapter.powered}; discovering for ${timeoutMs}ms …`)

  const radios = await bt.scanForRadios({ timeoutMs })
  if (radios.length === 0) {
    console.log('[scan] no radios found — power the radio on / put it in range')
  }
  for (const r of radios) {
    const spp = r.uuids.includes(SPP_UUID) ? 'SPP' : '·'
    const hfp = r.uuids.includes(HFP_AG_UUID) ? 'HFP-AG' : '·'
    console.log(
      `  ${r.address}  ${(r.name ?? '?').padEnd(20)} paired=${r.paired} trusted=${r.trusted} connected=${r.connected}  [${spp} ${hfp}]${r.configured ? '  (configured)' : ''}`,
    )
  }
  bt.close()
}

main().catch((e: unknown) => {
  console.error('[scan] failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
