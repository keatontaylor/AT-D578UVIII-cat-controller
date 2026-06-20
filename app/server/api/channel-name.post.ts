// Proxy: write the selected side's channel name (2f 24). Body { name }.
export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const body = await readBody(event)
  if (typeof body?.name !== 'string') {
    throw createError({ statusCode: 400, message: 'name is required' })
  }
  try {
    return await $fetch(`${serialServerUrl}/anytone/channel-name`, { method: 'POST', body })
  } catch (e: any) {
    throw createError({ statusCode: e.status ?? 500, message: e.data?.error ?? e.message })
  }
})
