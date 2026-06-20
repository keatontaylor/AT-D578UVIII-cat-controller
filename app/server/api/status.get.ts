// Disconnected fallback used ONLY when the backend HTTP server is unreachable.
// It must mirror the shape of anytoneToState() (anytone-server.mjs) so the UI
// never dereferences an undefined nested field (scope/firmware/*ByMode) exactly
// when the backend is down. Keep this in sync with anytoneToState; it is the
// disconnected projection of that contract. (Was previously ~15 fields with a
// stale baudRate:38400 — this radio is Bluetooth, baudRate is 0.)
function disconnectedState(error: string) {
  return {
    connected: false,
    transport: 'bt',
    transportLabel: 'Bluetooth',
    transportMode: 'EXTERNAL BT MODE',
    transportLink: 'rfcomm',
    transportFraming: 'raw',
    audio: null,
    port: null,
    baudRate: 0,
    autoInfo: false,
    mainFreq: null, subFreq: null, mainTxFreq: null, subTxFreq: null,
    mainMode: null, subMode: null,
    mainSmeter: null, subSmeter: null,
    txState: false, mox: false,
    split: false, memorySplit: false, rawSplit: null, vfoSplit: false,
    vfoSplitFreq: null, lock: null,
    agcMain: null, rfGainMain: null, afGainMain: null, sqMain: null,
    agcSub: null, rfGainSub: null, afGainSub: null, sqSub: null,
    sqlRfMode: null, powerLevel: null, radioInfo: null,
    amcLevel: null, micGain: null,
    settings: [],
    usbOutLevel: null, usbOutLevelByMode: { ssb: null, am: null, fm: null, data: null },
    usbModGain: null, usbModGainByMode: { ssb: null, am: null, fm: null, data: null },
    speechProc: null, speechProcLevel: null, funcKnob: null, vox: null, voxGain: null,
    txVfo: 0, rxMode: 'single',
    mainVfoMode: null, subVfoMode: null,
    mainMemoryChannel: null, subMemoryChannel: null,
    mainMemoryTag: null, subMemoryTag: null,
    mainZone: null, subZone: null,
    mainZonePosition: null, subZonePosition: null,
    radioMemories: [],
    radioMemoryScanActive: false, radioMemoryScanProgress: 0,
    radioMemoryScanTotal: 0, radioMemoryScanError: null,
    pseudoScanActive: false, pseudoScanVfo: null, pseudoScanChannels: [],
    pseudoScanIndex: 0, pseudoScanCurrentChannel: null, pseudoScanWaiting: false,
    pseudoScanBusy: false, pseudoScanLastMeter: null, pseudoScanLastSquelch: null,
    pseudoScanPauseReason: null, pseudoScanError: null,
    mainSqlType: null, subSqlType: null,
    mainCtcssTone: null, subCtcssTone: null,
    mainDcsCode: null, subDcsCode: null,
    dnrMain: null, dnrSub: null,
    mainBandwidth: null, subBandwidth: null,
    mainTxPower: null, subTxPower: null,
    mainShift: null, subShift: null,
    narrowMain: null, narrowSub: null,
    rfAttenuator: false,
    preAmpHf: null, preAmpVhf: null, preAmpUhf: null,
    scopeSide: false,
    scope: { mode: null, span: null, speed: null, level: null, att: null, color: null, marker: true },
    firmware: { main: null, display: null, sdr: null, dsp: null, spa1: null, fc80: null },
    antSelect: null,
    lastUpdate: Date.now(),
    error,
  }
}

export default defineEventHandler(async () => {
  const { serialServerUrl } = useRuntimeConfig()
  try {
    return await $fetch(`${serialServerUrl}/anytone/status`)
  } catch {
    // Backend not reachable — return the full disconnected contract shape.
    return disconnectedState('Serial server unavailable')
  }
})
