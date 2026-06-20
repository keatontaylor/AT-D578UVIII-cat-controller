import { readScanGroups } from '../utils/scan-groups'

export default defineEventHandler(async () => {
  try {
    return await readScanGroups()
  } catch (err: any) {
    throw createError({ statusCode: 500, message: `Cannot read scan groups: ${err.message}` })
  }
})
