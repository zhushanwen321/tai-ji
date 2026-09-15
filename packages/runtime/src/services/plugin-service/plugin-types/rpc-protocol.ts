// ── RPC 线协议类型（Wire Protocol）────────────────────────────────────
//
// 本文件仅包含 RPC 层的线协议类型与错误码，无跨域依赖——是 plugin-types
// 拆分中最独立的一个域。

export interface RpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown>
}

export interface RpcSuccessResponse {
  jsonrpc: '2.0'
  id: number
  result: unknown
}

export interface RpcErrorResponse {
  jsonrpc: '2.0'
  id: number
  error: { code: number; message: string; data?: unknown }
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse

export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params: Record<string, unknown>
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification

// ── Error Codes ──────────────────────────────────────────────────

/**
 * @stable — RPC 错误码常量，SDK 契约面。
 *
 * 经 Object.freeze 冻结：插件与 runtime 均不可在运行时修改错误码，
 * 保证错误判定（code 比较）的确定性。
 */
export const PluginRpcErrorCodes = Object.freeze({
  RPC_TIMEOUT: -32000,
  PERMISSION_DENIED: -32001,
  PLUGIN_NOT_FOUND: -32010,
  PLUGIN_NOT_ACTIVE: -32011,
  STORAGE_FULL: -32040,
  PAYLOAD_TOO_LARGE: -32021,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
} as const)

export type PluginRpcErrorCode = (typeof PluginRpcErrorCodes)[keyof typeof PluginRpcErrorCodes]
