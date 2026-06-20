import { getRecordingsManager } from '../../utils/recordings'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'recording id is required' })
  const { serialServerUrl } = useRuntimeConfig()
  const manager = await getRecordingsManager(serialServerUrl)
  return manager.delete(id)
})
