// Proxy: pair + trust a radio (specific address, or auto-discover when omitted).
export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const body = await readBody(event).catch(() => ({}))
  try {
    return await $fetch(`${serialServerUrl}/bt/pair`, { method: 'POST', body })
  } catch (e: any) {
    throw createError({ statusCode: e.status ?? 500, message: e.data?.error ?? e.message })
  }
})
