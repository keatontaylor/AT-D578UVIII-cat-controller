// State broadcaster (UI_PROTOCOL): each subscriber gets a full `state.snapshot` on join, then
// `state.patch` (RFC 7396) notifications carrying only what changed. The server holds one
// current state; patches are computed once and fanned out to all subscribers.

import { generateMergePatch, isEmptyPatch } from './merge-patch'
import { notify, type RpcNotification } from './jsonrpc'

export type Subscriber = (message: RpcNotification) => void

/** Broadcasts a single current state to subscribers: a full `state.snapshot` on join, then
 * change-only `state.patch` (RFC 7396) notifications. Generic over the state shape. */
export class StateBroadcaster<T> {
  private current: T
  private readonly subscribers = new Set<Subscriber>()

  constructor(initial: T) {
    this.current = initial
  }

  /** Add a subscriber; immediately sends the current snapshot. Returns an unsubscribe fn. */
  subscribe(send: Subscriber): () => void {
    this.subscribers.add(send)
    send(notify('state.snapshot', this.current))
    return () => {
      this.subscribers.delete(send)
    }
  }

  /** Record a new state and fan out a patch (skipped when nothing changed). */
  publish(next: T): void {
    const patch = generateMergePatch(this.current, next)
    this.current = next
    if (isEmptyPatch(patch)) return
    const message = notify('state.patch', patch)
    for (const send of this.subscribers) send(message)
  }

  get state(): T {
    return this.current
  }

  get subscriberCount(): number {
    return this.subscribers.size
  }
}
