import { getActiveAudioConfig, getAudioStatus } from '../../utils/audio'

export default defineEventHandler(async () => {
  const { serialServerUrl } = useRuntimeConfig()
  return await getAudioStatus(await getActiveAudioConfig(serialServerUrl))
})
