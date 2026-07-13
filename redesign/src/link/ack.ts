// The push-ACK we emit for required inbound pushes {5e,58,59,5c,5f}.
//
// Asymmetry (COMMAND_REFERENCE, confirmed from relay captures): the ACK we SEND is a fixed
// 4-byte `03 <op> 00 00` and is NOT additive-checksum-valid (byte[3] is 0, not the sum) —
// distinct from the 5-byte `03 <op> 00 <status> <ck>` command-ACK the radio sends us. Emit
// the literal; do not checksum it.

export function pushAck(op: number): Uint8Array {
  return Uint8Array.of(0x03, op & 0xff, 0x00, 0x00)
}
