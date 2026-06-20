import { setWebRtcTxPttActive } from '../utils/webrtc-audio'

export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const body = await readBody(event)
  if (!body?.command) {
    throw createError({ statusCode: 400, message: 'command is required' })
  }
  // Gate TX mic audio on PTT: open the HFP sink feed on key, close it on release
  // so the sink buffer can't accumulate latency while unkeyed.
  const cmd = String(body.command).trim().toUpperCase()
  if (cmd === 'TX1' || cmd === 'TX2') setWebRtcTxPttActive(true)
  else if (cmd === 'TX0' || cmd === 'TX' || cmd === 'RX') setWebRtcTxPttActive(false)
  try {
    return await $fetch(`${serialServerUrl}/anytone/command`, { method: 'POST', body })
  } catch (e: any) {
    if (cmd === 'TX1' || cmd === 'TX2') setWebRtcTxPttActive(false)
    throw createError({ statusCode: e.status ?? 500, message: e.data?.error ?? e.message })
  }
})
