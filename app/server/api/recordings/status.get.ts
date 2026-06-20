import { getRecordingsManager } from '../../utils/recordings'

export default defineEventHandler(async () => {
  const { serialServerUrl } = useRuntimeConfig()
  const manager = await getRecordingsManager(serialServerUrl)
  return manager.status()
})
