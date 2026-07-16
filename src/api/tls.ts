// Direct-HTTPS TLS material for the app server. Browsers only grant microphone access on a
// secure origin, so a LAN-facing install (hit by IP/hostname, not localhost) needs HTTPS for PTT
// voice — and we'd rather not force an nginx dependency for that. This resolves a key+cert to
// serve HTTPS ourselves, self-signing once (cached) when the operator hasn't supplied their own.
//
// Disable with ANYTONE_TLS=0 (dev on localhost — a secure origin already — or behind a
// TLS-terminating proxy that talks plain HTTP to us).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface TlsMaterial {
  key: Buffer
  cert: Buffer
}

export interface ResolveTlsOptions {
  /** Master switch (ANYTONE_TLS). Off → plain HTTP. */
  enabled: boolean
  /** Operator-supplied PEM paths (ANYTONE_TLS_CERT / _KEY). Both set → used verbatim. */
  certPath?: string | undefined
  keyPath?: string | undefined
  /** Where to cache the auto self-signed pair (cert.pem / key.pem). */
  dir: string
  log: (m: string) => void
}

/** Resolve TLS material for direct HTTPS, or null to serve plain HTTP.
 *  - disabled → null
 *  - explicit cert+key paths → read them (a wrong explicit path THROWS — an operator who named a
 *    cert wants it, not a silent downgrade to HTTP)
 *  - otherwise self-sign into `dir` once (cached across restarts) via openssl; if openssl is
 *    missing or generation fails, warn and return null so the app still starts on HTTP. */
export function resolveTls(opts: ResolveTlsOptions): TlsMaterial | null {
  if (!opts.enabled) return null
  if (opts.certPath && opts.keyPath) {
    return { cert: readFileSync(opts.certPath), key: readFileSync(opts.keyPath) }
  }
  const cert = join(opts.dir, 'cert.pem')
  const key = join(opts.dir, 'key.pem')
  try {
    if (!existsSync(cert) || !existsSync(key)) {
      mkdirSync(opts.dir, { recursive: true })
      opts.log(`no cert found — generating a self-signed pair → ${opts.dir}`)
      execFileSync(
        'openssl',
        ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '3650', '-keyout', key, '-out', cert, '-subj', '/CN=anytone-controller'],
        { stdio: 'ignore' },
      )
    }
    return { cert: readFileSync(cert), key: readFileSync(key) }
  } catch (e) {
    opts.log(`self-signed TLS setup failed (${(e as Error).message}) — falling back to plain HTTP (install openssl, or set ANYTONE_TLS=0)`)
    return null
  }
}
