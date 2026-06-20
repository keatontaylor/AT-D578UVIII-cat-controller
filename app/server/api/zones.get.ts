// Proxy: enumerate the radio's zone list (04 2b walk, cached on the backend).
// Pass ?force=1 to re-enumerate. Returns { zones: [{ index, name }] }.
export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const force = getQuery(event).force === '1' ? '?force=1' : ''
  try {
    return await $fetch(`${serialServerUrl}/anytone/zones${force}`)
  } catch (e: any) {
    throw createError({ statusCode: e.status ?? 500, message: e.data?.error ?? e.message })
  }
})
