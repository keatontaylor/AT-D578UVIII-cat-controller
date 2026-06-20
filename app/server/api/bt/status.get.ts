// Proxy: adapter + known-radio snapshot for the BT pairing panel.
export default defineEventHandler(async () => {
  const { serialServerUrl } = useRuntimeConfig()
  try {
    return await $fetch(`${serialServerUrl}/bt/status`)
  } catch (e: any) {
    throw createError({ statusCode: e.status ?? 503, message: e.data?.error ?? e.message })
  }
})
