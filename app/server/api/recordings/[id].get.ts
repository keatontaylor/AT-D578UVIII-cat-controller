import { getRecordingsManager } from '../../utils/recordings'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'recording id is required' })
  const { serialServerUrl } = useRuntimeConfig()
  const manager = await getRecordingsManager(serialServerUrl)
  const item = await manager.audioStream(id)
  if (!item) throw createError({ statusCode: 404, message: 'recording not found' })
  setHeader(event, 'Content-Type', item.clip.contentType)
  if (item.clip.bytes) setHeader(event, 'Content-Length', item.clip.bytes)
  setHeader(event, 'Cache-Control', 'private, max-age=3600')
  setHeader(event, 'Content-Disposition', `inline; filename="${item.clip.fileName}"`)
  return sendStream(event, item.stream)
})
