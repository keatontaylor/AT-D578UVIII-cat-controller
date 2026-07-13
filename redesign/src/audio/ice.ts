// ICE server provisioning. Two sources: a static list (ANYTONE_ICE_SERVERS) or Cloudflare's TURN
// service, whose short-lived credentials are minted on demand from the backend and cached against
// their TTL. The provider is the single source of truth for BOTH peers: the server-side wrtc
// session and (via the rtc.config RPC) the browser — they must gather from the same set or ICE
// can't pair the relayed candidates.

export interface IceServer {
  readonly urls: string | readonly string[]
  readonly username?: string
  readonly credential?: string
}

/** Async source of the ICE server set — consulted per rtc.config call / per new peer session. */
export type IceProvider = () => Promise<readonly IceServer[]>

export function staticIce(servers: readonly IceServer[]): IceProvider {
  return () => Promise.resolve(servers)
}

export interface CloudflareTurnOpts {
  /** The TURN app's Token ID (public-ish; names the key). */
  readonly keyId: string
  /** The TURN app's API token (secret — mints credentials; ANYTONE_CF_TURN_API_TOKEN). */
  readonly apiToken: string
  /** Credential lifetime in seconds. Must outlive the LONGEST listening session: TURN permission
   * refreshes reuse the credential mid-session, and an expired one drops the relay mid-audio.
   * Default 24 h. */
  readonly ttlSeconds?: number
  /** Served when minting fails and nothing valid is cached — a STUN-only set keeps LAN and
   * friendly-NAT clients working through a Cloudflare outage. */
  readonly fallback?: readonly IceServer[]
  readonly log?: (m: string) => void
  readonly fetchFn?: typeof fetch
  readonly now?: () => number
}

/** Re-mint once less than this fraction of the TTL remains — a session started just before
 * expiry would otherwise carry credentials that die under it. */
const REFRESH_FRACTION = 0.25

export function cloudflareTurn(opts: CloudflareTurnOpts): IceProvider {
  const ttl = opts.ttlSeconds ?? 86400
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${opts.keyId}/credentials/generate-ice-servers`
  const fetchFn = opts.fetchFn ?? fetch
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  let cached: { servers: readonly IceServer[]; expiresAt: number } | null = null
  let inflight: Promise<readonly IceServer[]> | null = null

  const mint = async (): Promise<readonly IceServer[]> => {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl }),
    })
    if (!res.ok) throw new Error(`cloudflare turn: HTTP ${res.status}`)
    const body = (await res.json()) as { iceServers?: IceServer | IceServer[] }
    // generate-ice-servers returns an array; the legacy generate endpoint a single object
    const servers = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : []
    if (servers.length === 0) throw new Error('cloudflare turn: empty iceServers in response')
    cached = { servers, expiresAt: now() + ttl * 1000 }
    log(`cloudflare TURN credentials minted (ttl ${ttl}s)`)
    return servers
  }

  return async () => {
    if (cached && cached.expiresAt - now() > ttl * 1000 * REFRESH_FRACTION) return cached.servers
    inflight ??= mint().finally(() => {
      inflight = null
    })
    try {
      return await inflight
    } catch (e) {
      log(`cloudflare TURN credential mint FAILED: ${(e as Error).message}`)
      if (cached && cached.expiresAt > now()) return cached.servers // aging but still valid
      return opts.fallback ?? []
    }
  }
}
