// Proxy: set or clear the sticky manual-dial DMR target that overrides the PTT
// contact. Body { target: '<digits>', callType?: 'group'|'private' } to set, or
// { clear: true } / empty target to clear. See the backend's setManualDial.
export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const body = await readBody(event)
  try {
    return await $fetch(`${serialServerUrl}/anytone/dmr-dial`, { method: 'POST', body })
  } catch (e: any) {
    throw createError({ statusCode: e.status ?? 500, message: e.data?.error ?? e.message })
  }
})
