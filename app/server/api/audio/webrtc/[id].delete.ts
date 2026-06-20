import { closeWebRtcAudioSession } from '../../../utils/webrtc-audio'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Session id is required.' })
  return { ok: closeWebRtcAudioSession(id) }
})
