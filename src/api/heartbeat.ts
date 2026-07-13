// Transport-level WebSocket keepalive (RFC 6455 ping/pong). Two jobs: keep the socket from being
// idle-timed-out by a proxy/LB (the ping traffic counts as activity), and reap a dead connection —
// a client that vanished without a clean close, which would otherwise leak its broadcaster
// subscription. The browser answers a ping with a pong automatically, so there is NOTHING app-level
// here and nothing added to the JSON-RPC contract.

export interface Pingable {
  ping(): void
  terminate(): void
}

/** Default heartbeat interval — comfortably under the common ~60s proxy/LB idle timeout. */
export const HEARTBEAT_MS = 25_000

/**
 * A per-socket heartbeat, kept pure + timer-free so it's unit-testable. Wire `pong()` to the
 * socket's `pong` event and call `tick()` on each interval:
 * - if no pong arrived since the previous tick → the peer is gone: `terminate()` (→ `false`),
 * - otherwise mark it un-alive and `ping()` (→ `true`); the pong flips it alive again.
 */
export function makeHeartbeat(socket: Pingable): { pong: () => void; tick: () => boolean } {
  let alive = true
  return {
    pong: () => {
      alive = true
    },
    tick: () => {
      if (!alive) {
        socket.terminate()
        return false
      }
      alive = false
      socket.ping()
      return true
    },
  }
}
