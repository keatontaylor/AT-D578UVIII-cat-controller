import { renegotiateWebRtcAudioSession } from '../../../../utils/webrtc-audio'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Session id is required.' })

  const body = await readBody<{ sdp?: string }>(event)
  if (!body.sdp) throw createError({ statusCode: 400, message: 'SDP is required for renegotiation.' })

  try {
    return await renegotiateWebRtcAudioSession(id, { type: 'offer', sdp: body.sdp })
  } catch (err: any) {
    throw createError({ statusCode: 404, message: err.message ?? 'Renegotiation failed.' })
  }
})
