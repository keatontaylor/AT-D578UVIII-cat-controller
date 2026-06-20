import { setWebRtcAudioRxMix, type WebRtcRxMix } from '../../../../utils/webrtc-audio'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Session id is required.' })

  const body = await readBody<Partial<WebRtcRxMix>>(event)
  try {
    return setWebRtcAudioRxMix(id, body)
  } catch (err: any) {
    throw createError({ statusCode: 404, message: err.message ?? 'WebRTC audio session not found.' })
  }
})
