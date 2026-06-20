// Proxy: remove a radio's bond (forces a fresh pair next Connect).
export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const body = await readBody(event).catch(() => ({}))
  try {
    return await $fetch(`${serialServerUrl}/bt/forget`, { method: 'POST', body })
  } catch (e: any) {
    throw createError({ statusCode: e.status ?? 500, message: e.data?.error ?? e.message })
  }
})
