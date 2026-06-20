export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const body = await readBody(event)
  const hex = String(body?.hex ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()

  if (!hex) {
    throw createError({ statusCode: 400, message: 'hex is required' })
  }
  if (hex.length % 2 !== 0) {
    throw createError({ statusCode: 400, message: 'hex must contain complete bytes' })
  }

  try {
    return await $fetch(`${serialServerUrl}/raw/query`, {
      method: 'POST',
      body: {
        hex,
        timeoutMs: body?.timeoutMs,
        idleMs: body?.idleMs,
      },
    })
  } catch (e: any) {
    throw createError({ statusCode: e.status ?? 500, message: e.data?.error ?? e.message })
  }
})
