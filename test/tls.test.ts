// resolveTls — direct-HTTPS material for the app server. Disabled → null; explicit paths →
// read verbatim (wrong path throws, no silent downgrade); otherwise self-sign once into a cache
// dir via openssl and reuse it. Keeps the mic (secure-origin) working without an nginx dep.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolveTls } from '../src/api/tls'

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test('disabled → null (plain HTTP)', () => {
  assert.equal(resolveTls({ enabled: false, dir: '/nonexistent', log: () => {} }), null)
})

test('explicit cert+key paths are read verbatim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tls-explicit-'))
  try {
    writeFileSync(join(dir, 'c.pem'), 'CERTDATA')
    writeFileSync(join(dir, 'k.pem'), 'KEYDATA')
    const m = resolveTls({ enabled: true, certPath: join(dir, 'c.pem'), keyPath: join(dir, 'k.pem'), dir, log: () => {} })
    assert.equal(m?.cert.toString(), 'CERTDATA')
    assert.equal(m?.key.toString(), 'KEYDATA')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a wrong explicit path throws (no silent downgrade)', () => {
  assert.throws(() => resolveTls({ enabled: true, certPath: '/no/such/cert', keyPath: '/no/such/key', dir: '/x', log: () => {} }))
})

test('auto self-sign generates once and reuses the cached pair', { skip: !hasOpenssl }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tls-auto-'))
  try {
    let genLogs = 0
    const log = (m: string): void => {
      if (m.includes('generating')) genLogs += 1
    }
    const first = resolveTls({ enabled: true, dir, log })
    assert.ok(first && first.cert.length > 0 && first.key.length > 0, 'material returned')
    assert.ok(existsSync(join(dir, 'cert.pem')) && existsSync(join(dir, 'key.pem')), 'pair cached')
    assert.ok(first.cert.toString().includes('BEGIN CERTIFICATE'), 'PEM cert')
    const second = resolveTls({ enabled: true, dir, log })
    assert.equal(second?.cert.toString(), first.cert.toString(), 'reused, not regenerated')
    assert.equal(genLogs, 1, 'generated exactly once')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('openssl missing (bad PATH) → null, app still starts on HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tls-noopenssl-'))
  const savedPath = process.env['PATH']
  try {
    process.env['PATH'] = '/nonexistent-bin' // no openssl reachable
    const m = resolveTls({ enabled: true, dir, log: () => {} })
    assert.equal(m, null)
  } finally {
    process.env['PATH'] = savedPath
    rmSync(dir, { recursive: true, force: true })
  }
})
