// Proxy: enumerate the radio's NATIVE scan lists (04 4b directory → 04 2e names,
// cached on the backend). Pass ?force=1 to re-enumerate. Returns
// { scanLists: [{ index, name, channels: [{ channelNumber, name }] }], version }.
export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const force = getQuery(event).force === '1' ? '?force=1' : ''
  try {
    return await $fetch(`${serialServerUrl}/anytone/scan-lists${force}`)
  } catch (e: any) {
    throw createError({ statusCode: e.status ?? 500, message: e.data?.error ?? e.message })
  }
})
