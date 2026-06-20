import { getRecordingsManager } from '../../utils/recordings'

export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const body = await readBody(event)
  const manager = await getRecordingsManager(serialServerUrl)
  if (body?.enabled !== undefined) return manager.setEnabled(body.enabled === true)
  return manager.updateSettings({ tailMs: body?.tailMs, minDurationMs: body?.minDurationMs })
})
