/**
 * Worker 侧 JSON-RPC 2.0 客户端
 *
 * Worker 通过 parentPort 发送 RpcRequest 到主线程，
 * 主线程的 PluginHost 接收后转发给 PluginRpcServer.dispatch()，
 * 响应通过 HostToWorkerMessage.rpc.response 回传，由本 client 处理。
 */

import type { RpcResponse, RpcNotification, RpcRequest } from './plugin-types.js'
import { PluginRpcErrorCodes } from './plugin-types.js'
import { PendingTracker } from '../../utils/async/pending-tracker.js'
import { errorWithCode } from '../../utils/errors.js'
import { getOrCreate } from '../../utils/collections.js'

const DEFAULT_TIMEOUT_MS = 30_000

/** Worker 通信端口的抽象（MessagePort / parentPort 均可适配） */
export interface ClientPort {
  postMessage(message: unknown): void
}

export class PluginRpcClient {
  private nextId = 1
  // D15/D25: 请求/回复登记表收编为 PendingTracker（超时 reject 带 .code）。
  private pending = new PendingTracker<number, unknown>()
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>()
  private port: ClientPort | null = null

  /** 绑定通信端口（Worker 中通常为 parentPort） */
  attach(port: ClientPort): void {
    this.port = port
  }

  /**
   * 发送 RPC 请求并等待响应。
   *
   * 消息格式为 WorkerToHostMessage 的 rpc 变体：
   * `{ type: 'rpc', jsonrpc: '2.0', id, method, params }`
   */
  request(method: string, params: Record<string, unknown>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.port) {
      return Promise.reject(new Error('RPC client not attached'))
    }

    const id = this.nextId++
    const timeoutError = Object.assign(
      new Error(`RPC timeout: ${method}`),
      { code: PluginRpcErrorCodes.RPC_TIMEOUT },
    )

    // 先登记 pending（含超时 timer），再 postMessage。
    const promise = this.pending.register(id, timeoutMs, timeoutError)

    // WorkerToHostMessage: { type: 'rpc' } & RpcRequest
    const message: RpcRequest & { type: 'rpc' } = {
      type: 'rpc',
      jsonrpc: '2.0',
      id,
      method,
      params,
    }
    this.port.postMessage(message)

    return promise
  }

  /** 发送通知（无 id，不期望响应） */
  notify(method: string, params: Record<string, unknown>): void {
    if (!this.port) return
    // WorkerToHostMessage: { type: 'rpc' } & RpcNotification
    const message: RpcNotification & { type: 'rpc' } = {
      type: 'rpc',
      jsonrpc: '2.0',
      method,
      params,
    }
    this.port.postMessage(message)
  }

  /**
   * 注册通知处理器，返回取消注册的函数。
   * 主线程通过 HostToWorkerMessage.rpc.notification 发送通知。
   */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const handlers = getOrCreate(this.notificationHandlers, method, () => new Set())
    handlers.add(handler)
    return () => {
      handlers!.delete(handler)
      if (handlers!.size === 0) this.notificationHandlers.delete(method)
    }
  }

  /** 处理来自主线程的 RPC 响应（PluginHost 从 HostToWorkerMessage 中提取后调用） */
  handleResponse(response: RpcResponse): void {
    if ('error' in response) {
      // reply-error：code 来自响应，由调用方构造 error 后交给 tracker 拒绝。
      // reply-error：code 来自响应，由调用方构造 error 后交给 tracker 拒绝。
      this.pending.reject(response.id, errorWithCode(response.error.message, response.error.code))
    } else {
      this.pending.resolve(response.id, response.result)
    }
  }

  /** 处理来自主线程的 RPC 通知 */
  handleNotification(notification: RpcNotification): void {
    const handlers = this.notificationHandlers.get(notification.method)
    if (!handlers) return
    for (const handler of handlers) {
      // D6/W4 per-handler 兜底：同一 Worker/子进程承载多个插件（trusted ≤10 共享；
      // sessions/hooks 通知按 handler 分发），单插件 handler 抛错若冒泡，会沿
      // bootstrap 的 handleMessage catch 升级为 fatal_error → 整 Worker 崩溃连坐。
      // 逐 handler try/catch：记日志（含归属 pluginId）后继续分发后续 handler。
      try {
        handler(notification.params)
      } catch (e: unknown) {
        const p = notification.params
        const pluginId = typeof p === 'object' && p !== null && !Array.isArray(p)
          ? String((p as Record<string, unknown>).pluginId ?? 'unknown')
          : 'unknown'
        console.error(
          `[plugin-rpc-client] notification handler error (method=${notification.method}, pluginId=${pluginId}):`,
          e,
        )
      }
    }
  }

  dispose(): void {
    this.pending.rejectAll(new Error('RPC client disposed'))
    this.notificationHandlers.clear()
    this.port = null
  }
}
