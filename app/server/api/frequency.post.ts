// Proxy: write a side's working RX or TX frequency (2f 03 / 2f 04).
// Body { band: 'rx' | 'tx', hz, side? }. See the backend's setReceiveFrequency /
// setTransmitFrequency.
export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const body = await readBody(event)
  if (body?.hz == null) {
    throw createError({ statusCode: 400, message: 'hz is required' })
  }
  const band = String(body?.band ?? '').toLowerCase()
  if (band !== 'rx' && band !== 'tx') {
    throw createError({ statusCode: 400, message: "band must be 'rx' or 'tx'" })
  }
  try {
    return await $fetch(`${serialServerUrl}/anytone/frequency`, { method: 'POST', body })
  } catch (e: any) {
    throw createError({ statusCode: e.status ?? 500, message: e.data?.error ?? e.message })
  }
})
