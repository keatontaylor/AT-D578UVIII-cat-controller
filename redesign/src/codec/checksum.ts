// AnyTone frame checksum (LINK_PROTOCOL §1, COMMAND_REFERENCE):
// the final byte of a frame equals the 8-bit additive sum of all preceding bytes.
// No length field, no sequence number — the checksum is the only integrity signal,
// and (with the length-by-type table) the framing boundary for variable-length registers.

/** 8-bit additive sum of `bytes[start, endExclusive)`. */
export function additiveSum(bytes: Uint8Array, start: number, endExclusive: number): number {
  let sum = 0
  for (let i = start; i < endExclusive; i += 1) sum = (sum + (bytes[i] ?? 0)) & 0xff
  return sum
}

/** True when the complete candidate frame `bytes[start, endExclusive)` carries a valid
 * trailing checksum (last byte == additive sum of the rest). */
export function checksumOk(bytes: Uint8Array, start: number, endExclusive: number): boolean {
  if (endExclusive - start < 2) return false
  return additiveSum(bytes, start, endExclusive - 1) === (bytes[endExclusive - 1] ?? -1)
}
