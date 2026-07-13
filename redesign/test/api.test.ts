import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMergePatch, generateMergePatch, isEmptyPatch } from '../src/api/merge-patch'
import { RpcRequest } from '../src/api/jsonrpc'
import { StateBroadcaster } from '../src/api/broadcast'
import { initialState } from '../src/domain/state'

// ── RFC 7396 (apply — verbatim Appendix A cases) ────────────────────────────
test('applyMergePatch matches RFC 7396 Appendix A', () => {
  assert.deepEqual(applyMergePatch({ a: 'b' }, { a: 'c' }), { a: 'c' })
  assert.deepEqual(applyMergePatch({ a: 'b' }, { b: 'c' }), { a: 'b', b: 'c' })
  assert.deepEqual(applyMergePatch({ a: 'b' }, { a: null }), {})
  assert.deepEqual(applyMergePatch({ a: 'b', b: 'c' }, { a: null }), { b: 'c' })
  assert.deepEqual(applyMergePatch({ a: ['b'] }, { a: 'c' }), { a: 'c' })
  assert.deepEqual(applyMergePatch({ a: 'c' }, { a: ['b'] }), { a: ['b'] })
  assert.deepEqual(applyMergePatch({ a: { b: 'c' } }, { a: { b: 'd', c: null } }), { a: { b: 'd' } })
  assert.deepEqual(applyMergePatch({ a: [{ b: 'c' }] }, { a: [1] }), { a: [1] })
  assert.deepEqual(applyMergePatch(['a', 'b'], ['c', 'd']), ['c', 'd'])
  assert.deepEqual(applyMergePatch({ a: 'b' }, ['c']), ['c'])
  assert.equal(applyMergePatch({ a: 'foo' }, null), null)
  assert.equal(applyMergePatch({ a: 'foo' }, 'bar'), 'bar')
  assert.deepEqual(applyMergePatch({ e: null }, { a: 1 }), { e: null, a: 1 })
  assert.deepEqual(applyMergePatch([1, 2], { a: 'b', c: null }), { a: 'b' })
  assert.deepEqual(applyMergePatch({}, { a: { bb: { ccc: null } } }), { a: { bb: {} } })
})

test('generate then apply round-trips (and emits a minimal, change-only patch)', () => {
  const before = { a: 1, b: { x: 1, y: 2 }, c: 'keep' }
  const after = { a: 1, b: { x: 9, y: 2 }, d: 'new' } // b.x changed, c removed, d added
  const patch = generateMergePatch(before, after)
  assert.deepEqual(patch, { b: { x: 9 }, c: null, d: 'new' })
  assert.deepEqual(applyMergePatch(before, patch), after)
  assert.ok(isEmptyPatch(generateMergePatch(after, after)))
})

// ── envelope validation ─────────────────────────────────────────────────────
test('RpcRequest rejects malformed envelopes', () => {
  assert.ok(RpcRequest.safeParse({ jsonrpc: '2.0', id: 1, method: 'x' }).success)
  assert.ok(!RpcRequest.safeParse({ jsonrpc: '1.0', method: 'x' }).success)
  assert.ok(!RpcRequest.safeParse({ jsonrpc: '2.0' }).success) // no method
  assert.ok(RpcRequest.safeParse({ jsonrpc: '2.0', method: 'x' }).success) // notification
})

// ── broadcaster ─────────────────────────────────────────────────────────────
test('broadcaster sends a snapshot on subscribe and change-only patches', () => {
  const b = new StateBroadcaster(initialState())
  const msgs: { method: string; params: unknown }[] = []
  b.subscribe((m) => msgs.push({ method: m.method, params: m.params }))
  assert.equal(msgs[0]!.method, 'state.snapshot')

  const next = { ...initialState(), ptt: 'keying' as const }
  b.publish(next)
  assert.equal(msgs[1]!.method, 'state.patch')
  assert.deepEqual(msgs[1]!.params, { ptt: 'keying' }) // only the changed field

  b.publish(next) // no change
  assert.equal(msgs.length, 2, 'no patch when nothing changed')
})
