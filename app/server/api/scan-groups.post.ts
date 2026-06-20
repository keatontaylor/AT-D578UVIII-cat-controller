import { upsertScanGroup } from '../utils/scan-groups'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  try {
    return await upsertScanGroup(body)
  } catch (err: any) {
    throw createError({ statusCode: 400, message: err.message })
  }
})
