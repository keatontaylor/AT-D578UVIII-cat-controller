// TODO_ANYTONE: memory-channel write is not implemented for the AnyTone 578.
//
// This endpoint is a dead scaffold leftover. It used to proxy to a backend
// `/memory-write` route that does not exist (neither anytone-server.mjs nor the
// Python server), so it always failed with an opaque proxied error. The AnyTone write
// command family (08 / 2f / 57) is proven over BT, but no channel-number SET
// opcode has been found yet (see docs/ANYTONE_578_NOTES.md and docs/PROTOCOL.md).
//
// Kept as an explicit, discoverable stub rather than deleted so the UI affordance
// and this seam survive until the write opcode is reverse-engineered. When it is:
// add the backend route, then restore the proxy.
export default defineEventHandler(() => {
  throw createError({
    statusCode: 501,
    message: 'Memory-channel write is not yet implemented for AnyTone 578 (no known BT write opcode). See docs/ANYTONE_578_NOTES.md.',
  })
})
