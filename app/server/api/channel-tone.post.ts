// Proxy: write an RX or TX tone (CTCSS/DCS) on a side's channel.
// Body { field:'rx'|'tx', type:'off'|'ctc'|'dcs', value, inverted?, side? }.
export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const body = await readBody(event)
  if (!body?.field || !body?.type) {
    throw createError({ statusCode: 400, message: 'field and type are required' })
  }
  try {
    return await $fetch(`${serialServerUrl}/anytone/channel-tone`, { method: 'POST', body })
  } catch (e: any) {
    throw createError({ statusCode: e.status ?? 500, message: e.data?.error ?? e.message })
  }
})
