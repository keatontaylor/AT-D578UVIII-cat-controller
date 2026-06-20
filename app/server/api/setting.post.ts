// Proxy: write a global menu setting (mic/speaker gain, NR, DigiMon).
// Body { key, value } where value is the radio's on-screen value.
export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const body = await readBody(event)
  if (!body?.key) {
    throw createError({ statusCode: 400, message: 'key is required' })
  }
  try {
    return await $fetch(`${serialServerUrl}/anytone/setting`, { method: 'POST', body })
  } catch (e: any) {
    throw createError({ statusCode: e.status ?? 500, message: e.data?.error ?? e.message })
  }
})
