// The transport seam (ARCHITECTURE transport layer). A minimal duplex byte interface — the
// one place that touches real I/O. v1's implementation is the native AF_BLUETOOTH RFCOMM
// socket (SOCK_STREAM: a byte stream with no frame boundaries — the codec frames it). Tests
// use a scripted in-memory transport behind this same interface; the native socket is a
// later, hardware-only binding.

export interface Transport {
  /** Put bytes on the wire (one small write ≈ one RFCOMM packet — a clean frame boundary). */
  write(bytes: Uint8Array): void
  /** Register the inbound byte-stream handler. */
  onData(handler: (chunk: Uint8Array) => void): void
  /** Register the close handler. */
  onClose(handler: () => void): void
  /** Tear down the link. */
  close(): void
}
