import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatch } from '../src/api/router'
import { RpcErrorCode } from '../src/api/jsonrpc'
import { ADDR, newController } from './controller-fakes'
import type { AppState } from '../src/services/radio-service'

test('state.get returns the AppState', async () => {
  const { c } = newController()
  const res = await dispatch(c, { jsonrpc: '2.0', id: 1, method: 'state.get' })
  assert.equal(res?.error, undefined)
  assert.equal((res?.result as AppState).connection, 'disconnected')
})

test('link.stats returns the self-contained link report', async () => {
  const { c } = newController()
  const res = await dispatch(c, { jsonrpc: '2.0', id: 9, method: 'link.stats' })
  assert.equal(res?.error, undefined)
  const report = res?.result as { connection: string; metrics: { retransmits: number; failed: number }; events: unknown[]; linkConfig: { timeoutMs: number }; generatedAt: string }
  assert.equal(report.connection, 'disconnected')
  assert.equal(report.metrics.failed, 0)
  assert.deepEqual(report.events, [])
  assert.ok(report.linkConfig.timeoutMs > 0)
  assert.ok(!Number.isNaN(Date.parse(report.generatedAt)))
})

test('connect reaches connected and returns the AppState', async () => {
  const { c } = newController()
  const res = await dispatch(c, { jsonrpc: '2.0', id: 1, method: 'connect', params: { address: ADDR } })
  assert.equal(res?.error, undefined)
  assert.equal((res?.result as AppState).connection, 'connected')
})

test('bt.scan / bt.list return candidate arrays', async () => {
  const { c } = newController()
  assert.equal(((await dispatch(c, { jsonrpc: '2.0', id: 1, method: 'bt.scan' }))?.result as unknown[]).length, 1)
  assert.equal(((await dispatch(c, { jsonrpc: '2.0', id: 2, method: 'bt.list' }))?.result as unknown[]).length, 1)
})

test('bt.pair returns the paired address', async () => {
  const { c } = newController()
  const res = await dispatch(c, { jsonrpc: '2.0', id: 1, method: 'bt.pair', params: { address: ADDR } })
  assert.deepEqual(res?.result, { address: ADDR })
})

test('bt.forget removes the bond', async () => {
  const { c, bt } = newController()
  const res = await dispatch(c, { jsonrpc: '2.0', id: 1, method: 'bt.forget', params: { address: ADDR } })
  assert.deepEqual(res?.result, { address: ADDR })
  assert.ok(bt.calls.includes(`forget:${ADDR}`))
})

test('a live op before connect → InvalidParams (not connected)', async () => {
  const { c } = newController()
  const res = await dispatch(c, { jsonrpc: '2.0', id: 1, method: 'ptt.key' })
  assert.equal(res?.error?.code, RpcErrorCode.InvalidParams)
})

test('setting.set applies once connected; missing params → InvalidParams', async () => {
  const { c } = newController()
  await dispatch(c, { jsonrpc: '2.0', id: 1, method: 'connect', params: { address: ADDR } })
  const okRes = await dispatch(c, { jsonrpc: '2.0', id: 2, method: 'setting.set', params: { name: 'key_tone', value: 'L1' } })
  assert.equal(okRes?.error, undefined)
  const badRes = await dispatch(c, { jsonrpc: '2.0', id: 3, method: 'setting.set', params: { name: 'key_tone' } })
  assert.equal(badRes?.error?.code, RpcErrorCode.InvalidParams)
})

test('settings.catalogue returns option tables (edit metadata, out of state)', async () => {
  const { c } = newController()
  const res = await dispatch(c, { jsonrpc: '2.0', id: 1, method: 'settings.catalogue' })
  const cat = res?.result as { name: string; options: string[] | null; description: string; menu: string }[]
  assert.ok(Array.isArray(cat) && cat.length > 0)
  assert.ok(cat.every((s) => typeof s.name === 'string'))
  // every setting carries a non-empty description + menu path (surfaced in the editor dialog)
  assert.ok(cat.every((s) => typeof s.description === 'string' && s.description.length > 0), 'all settings described')
  assert.ok(cat.every((s) => typeof s.menu === 'string' && s.menu.length > 0))
})

test('channelSettings.catalogue returns per-channel edit metadata (options + description + mode)', async () => {
  const { c } = newController()
  const res = await dispatch(c, { jsonrpc: '2.0', id: 1, method: 'channelSettings.catalogue' })
  const cat = res?.result as { key: string; label: string; options: string[]; description: string; modes: string | null }[]
  assert.ok(Array.isArray(cat) && cat.length > 0)
  assert.ok(cat.every((s) => s.key && s.label && Array.isArray(s.options) && s.description.length > 0))
  const power = cat.find((s) => s.key === 'txPower')
  assert.deepEqual(power?.options, ['Low', 'Medium', 'High', 'Turbo'])
})

test('unknown method + notification', async () => {
  const { c } = newController()
  assert.equal(
    (await dispatch(c, { jsonrpc: '2.0', id: 1, method: 'nope.nope' }))?.error?.code,
    RpcErrorCode.MethodNotFound,
  )
  assert.equal(await dispatch(c, { jsonrpc: '2.0', method: 'state.get' }), null) // notification → null
})
