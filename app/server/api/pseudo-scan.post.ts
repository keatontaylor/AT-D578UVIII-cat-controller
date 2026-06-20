// TODO_ANYTONE: software ("pseudo") channel scan is not implemented for the
// AnyTone 578.
//
// Dead scaffold endpoint: this proxied to a backend `/pseudo-scan` route that
// does not exist, so it always failed with an opaque proxied error. A pseudo
// scan needs a confirmed channel-step / memory-select write over BT, which is
// not yet known (same blocker as memory-write; see docs/ANYTONE_578_NOTES.md).
//
// Kept as an explicit stub (not deleted) so the UI seam survives until the
// underlying write opcode is reverse-engineered.
export default defineEventHandler(() => {
  throw createError({
    statusCode: 501,
    message: 'Pseudo-scan is not yet implemented for AnyTone 578 (needs a BT channel-step opcode). See docs/ANYTONE_578_NOTES.md.',
  })
})
