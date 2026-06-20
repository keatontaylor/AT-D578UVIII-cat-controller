import { deleteScanGroup } from '../../utils/scan-groups'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'scan group id is required' })
  try {
    return await deleteScanGroup(id)
  } catch (err: any) {
    throw createError({ statusCode: 500, message: `Cannot delete scan group: ${err.message}` })
  }
})
