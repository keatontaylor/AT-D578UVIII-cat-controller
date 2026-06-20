import { getRecordingsManager } from '../../utils/recordings'

export default defineEventHandler(async (event) => {
  const { serialServerUrl } = useRuntimeConfig()
  const query = getQuery(event)
  const manager = await getRecordingsManager(serialServerUrl)
  return manager.query({
    from: query.from == null ? undefined : Number(query.from),
    to: query.to == null ? undefined : Number(query.to),
  })
})
