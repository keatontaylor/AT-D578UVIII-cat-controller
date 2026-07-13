// JSON-RPC 2.0 envelope (UI_PROTOCOL, NF7). Zod is the single source of truth for the wire
// contract; malformed traffic is rejected with a spec error code.

import { z } from 'zod'

export const RpcId = z.union([z.string(), z.number()])
export type RpcId = z.infer<typeof RpcId>

export const RpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: RpcId.optional(), // absent ⇒ notification (no response)
  method: z.string(),
  params: z.unknown().optional(),
})
export type RpcRequest = z.infer<typeof RpcRequest>

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

export interface RpcResponse {
  jsonrpc: '2.0'
  id: RpcId | null
  result?: unknown
  error?: RpcError
}

export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export function ok(id: RpcId, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export function fail(id: RpcId | null, code: number, message: string, data?: unknown): RpcResponse {
  const error: RpcError = data === undefined ? { code, message } : { code, message, data }
  return { jsonrpc: '2.0', id, error }
}

export function notify(method: string, params: unknown): RpcNotification {
  return { jsonrpc: '2.0', method, params }
}

/** Best-effort id extraction from a malformed request, for the error response. */
export function idOf(raw: unknown): RpcId | null {
  if (raw && typeof raw === 'object' && 'id' in raw) {
    const id = (raw as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}
