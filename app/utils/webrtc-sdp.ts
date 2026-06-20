export interface WebRtcOpusOptions {
  maxAverageBitrate: number
  maxPlaybackRate: number
  stereo: boolean
  spropStereo: boolean
  useinbandfec: boolean
  usedtx: boolean
  ptime: number
  maxptime: number
}

export const DEFAULT_WEBRTC_OPUS_OPTIONS: WebRtcOpusOptions = {
  maxAverageBitrate: 20000,
  maxPlaybackRate: 16000,
  stereo: false,
  spropStereo: false,
  useinbandfec: true,
  usedtx: false,
  ptime: 40,
  maxptime: 60,
}

interface SessionDescriptionLike {
  type?: string
  sdp?: string
}

export function normalizeWebRtcOpusOptions(options: Partial<WebRtcOpusOptions> | null | undefined): WebRtcOpusOptions {
  const merged = { ...DEFAULT_WEBRTC_OPUS_OPTIONS, ...(options ?? {}) }
  return {
    maxAverageBitrate: normalizeInt(merged.maxAverageBitrate, DEFAULT_WEBRTC_OPUS_OPTIONS.maxAverageBitrate, 6000, 128000),
    maxPlaybackRate: normalizeInt(merged.maxPlaybackRate, DEFAULT_WEBRTC_OPUS_OPTIONS.maxPlaybackRate, 8000, 48000),
    stereo: merged.stereo === true,
    spropStereo: merged.spropStereo === true,
    useinbandfec: merged.useinbandfec !== false,
    usedtx: merged.usedtx !== false,
    ptime: normalizeInt(merged.ptime, DEFAULT_WEBRTC_OPUS_OPTIONS.ptime, 10, 60),
    maxptime: normalizeInt(merged.maxptime, DEFAULT_WEBRTC_OPUS_OPTIONS.maxptime, 10, 120),
  }
}

export function tuneOpusSessionDescription<T extends SessionDescriptionLike>(description: T, options?: Partial<WebRtcOpusOptions>): T {
  if (!description?.sdp) return description
  return {
    type: description.type,
    sdp: tuneOpusSdp(description.sdp, normalizeWebRtcOpusOptions(options)),
  } as T
}

export function tuneOpusSdp(sdp: string, options: WebRtcOpusOptions = DEFAULT_WEBRTC_OPUS_OPTIONS) {
  const normalized = normalizeWebRtcOpusOptions(options)
  const lines = sdp.split(/\r?\n/)
  const output: string[] = []

  for (let start = 0; start < lines.length;) {
    const end = nextMediaSectionStart(lines, start + 1)
    const section = lines.slice(start, end)
    output.push(...(section[0]?.startsWith('m=audio') ? tuneOpusSection(section, normalized) : section))
    start = end
  }

  return output.join('\r\n')
}

export function summarizeOpusSdp(sdp: string | null | undefined) {
  if (!sdp) return { payloads: [], fmtp: [], ptime: null, maxptime: null }
  const lines = sdp.split(/\r?\n/)
  const payloads = lines
    .map(line => line.match(/^a=rtpmap:(\d+)\s+opus\/48000(?:\/\d+)?/i)?.[1])
    .filter((value): value is string => !!value)
  return {
    payloads,
    fmtp: payloads.map(payload => lines.find(line => line.startsWith(`a=fmtp:${payload} `)) ?? null),
    ptime: lines.find(line => line.startsWith('a=ptime:'))?.slice('a=ptime:'.length) ?? null,
    maxptime: lines.find(line => line.startsWith('a=maxptime:'))?.slice('a=maxptime:'.length) ?? null,
  }
}

function tuneOpusSection(section: string[], options: WebRtcOpusOptions) {
  const opusPayloads = section
    .map(line => line.match(/^a=rtpmap:(\d+)\s+opus\/48000(?:\/\d+)?/i)?.[1])
    .filter((value): value is string => !!value)
  if (opusPayloads.length === 0) return section

  let tuned = [...section]
  for (const payload of opusPayloads) tuned = tuneOpusFmtp(tuned, payload, options)
  tuned = upsertSectionAttribute(tuned, 'a=ptime:', String(options.ptime))
  tuned = upsertSectionAttribute(tuned, 'a=maxptime:', String(options.maxptime))
  return tuned
}

function tuneOpusFmtp(section: string[], payload: string, options: WebRtcOpusOptions) {
  const fmtpPrefix = `a=fmtp:${payload}`
  const fmtpIndex = section.findIndex(line => line.startsWith(`${fmtpPrefix} `))
  const params = parseFmtpParams(fmtpIndex >= 0 ? section[fmtpIndex].slice(fmtpPrefix.length).trim() : '')
  const updates: Record<string, string> = {
    maxaveragebitrate: String(options.maxAverageBitrate),
    maxplaybackrate: String(options.maxPlaybackRate),
    stereo: options.stereo ? '1' : '0',
    'sprop-stereo': options.spropStereo ? '1' : '0',
    useinbandfec: options.useinbandfec ? '1' : '0',
    usedtx: options.usedtx ? '1' : '0',
  }

  for (const [key, value] of Object.entries(updates)) params.set(key, value)

  const line = `${fmtpPrefix} ${formatFmtpParams(params)}`
  if (fmtpIndex >= 0) {
    const next = [...section]
    next[fmtpIndex] = line
    return next
  }

  const rtpmapIndex = section.findIndex(item => item.startsWith(`a=rtpmap:${payload} `))
  const insertAt = rtpmapIndex >= 0 ? rtpmapIndex + 1 : section.length
  return [...section.slice(0, insertAt), line, ...section.slice(insertAt)]
}

function parseFmtpParams(value: string) {
  const params = new Map<string, string>()
  const trimmed = value.replace(/^;/, '').trim()
  if (!trimmed) return params
  for (const part of trimmed.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=')
    const key = rawKey.trim().toLowerCase()
    if (!key) continue
    params.set(key, rawValue.join('=').trim())
  }
  return params
}

function formatFmtpParams(params: Map<string, string>) {
  return Array.from(params.entries())
    .map(([key, value]) => value ? `${key}=${value}` : key)
    .join(';')
}

function upsertSectionAttribute(section: string[], prefix: string, value: string) {
  const line = `${prefix}${value}`
  const existing = section.findIndex(item => item.startsWith(prefix))
  if (existing >= 0) {
    const next = [...section]
    next[existing] = line
    return next
  }

  let insertAt = lastIndexOf(section, item => item.startsWith('a=fmtp:') || item.startsWith('a=rtpmap:'))
  if (insertAt < 0) insertAt = lastIndexOf(section, item => item.startsWith('m=') || item.startsWith('c=') || item.startsWith('a=mid:'))
  return [...section.slice(0, insertAt + 1), line, ...section.slice(insertAt + 1)]
}

function lastIndexOf(values: string[], predicate: (value: string) => boolean) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (predicate(values[i])) return i
  }
  return -1
}

function nextMediaSectionStart(lines: string[], start: number) {
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].startsWith('m=')) return i
  }
  return lines.length
}

function normalizeInt(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}
