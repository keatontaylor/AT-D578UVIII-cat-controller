import { createWebRtcAudioSession } from '../../utils/webrtc-audio'
import { getActiveAudioConfig } from '../../utils/audio'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ type?: string; sdp?: string }>(event)

  if (body?.type !== 'offer' || !body.sdp) {
    throw createError({ statusCode: 400, message: 'WebRTC offer with SDP is required.' })
  }

  try {
    const { serialServerUrl } = useRuntimeConfig()
    return await createWebRtcAudioSession({ type: 'offer', sdp: body.sdp }, await getActiveAudioConfig(serialServerUrl))
  } catch (err: any) {
    throw createError({ statusCode: 503, message: err.message ?? 'Cannot start WebRTC audio.' })
  }
})
