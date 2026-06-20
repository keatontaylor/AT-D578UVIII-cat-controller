export default defineEventHandler(async () => {
  const { serialServerUrl } = useRuntimeConfig()
  try {
    return await $fetch(`${serialServerUrl}/anytone/ports`)
  } catch {
    throw createError({ statusCode: 503, message: 'Backend unavailable. Make sure anytone-server.mjs is running.' })
  }
})
