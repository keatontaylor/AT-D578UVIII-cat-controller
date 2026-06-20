// Proxy: write a per-channel setting (2f family) on the currently-selected side.
// Body { key, value } where value is the raw enum/numeric byte. See the backend's
// CHANNEL_SETTINGS registry / setChannelSetting.
export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const body = await readBody(event)
  if (!body?.key) {
    throw createError({ statusCode: 400, message: 'key is required' })
  }
  try {
    return await $fetch(`${serialServerUrl}/anytone/channel-setting`, { method: 'POST', body })
  } catch (e: any) {
    throw createError({ statusCode: e.status ?? 500, message: e.data?.error ?? e.message })
  }
})
