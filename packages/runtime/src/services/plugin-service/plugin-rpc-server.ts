/**
 * 主线程侧 JSON-RPC 2.0 服务端
 *
 * 接收来自 Worker 的 RPC 请求，分发到注册的 handler，
 * 并支持向特定 Worker 发送通知或广播通知。
 */

import type { RpcRequest, RpcResponse, RpcNotification } from './plugin-types.js'
import { PluginRpcErrorCodes } from './plugin-types.js'
import { PendingTracker } from '../../utils/async/pending-tracker.js'
import { toErrorMessage } from '../../utils/errors.js'

/**
 * handler 分发上下文（S3-W2）：需要回溯消息来源通道的 handler 使用
 * （如 plugin.sessions.registerCreate 按 handlerId 记录 workerId，事件
 * 发生时按注册表定向投递）。workerId 来自宿主消息回调闭包捕获，不可伪造。
 */
export interface RpcDispatchContext {
  workerId: string
  identity: RpcIdentity | undefined
}

/**
 * RPC 方法 handler。ctx 可选使用（既有 handler 单参数定义依然兼容——
 * 参数逆变：少参数函数可赋给多参数签名）。
 */
export type RpcMethodHandler = (
  params: Record<string, unknown>,
  ctx: RpcDispatchContext,
) => Promise<unknown>

/**
 * 通道绑定的 RPC 身份（宿主 registerWorker 时注册，安全判定的唯一身份来源）。
 *
 * 来自消息回调闭包捕获的 workerId → 身份映射，插件进程不可伪造；
 * 消息体内 params.pluginId 是插件自报值，任何安全判定不得引用（显示/诊断除外）。
 */
export interface RpcIdentity {
  /** worker 级信任级（宿主句柄的权威值，非 manifest 声明） */
  trustLevel: 'trusted' | 'sandbox'
  /**
   * 通道唯一归属的插件 id。sandbox 通道必有（processId = `sandbox-<pluginId>` 一对一）；
   * trusted Worker/进程可共享多插件（≤10），无唯一归属 → undefined（身份是 worker 级
   * 「trusted」，鉴权按 trusted 放行，dispatch 不做 pluginId 覆写——trusted 插件间
   * 互不设防是设计语义：同进程 JS 对等体物理上无法隔离）。
   */
  pluginId?: string
}

/** 权限检查函数签名 — 返回 true 表示放行，false 表示拒绝。身份来自通道反查，非消息体自报 */
export type PermissionCheckFn = (identity: RpcIdentity, method: string) => boolean

/** Worker 通信端口的抽象（MessagePort / parentPort 均可适配） */
export interface WorkerPort {
  postMessage(message: unknown): void
}

export class PluginRpcServer {
  private methods = new Map<string, RpcMethodHandler>()
  private workers = new Map<string, WorkerPort>()
  /** workerId → 通道身份（registerWorker 时由宿关注册；与 workers 表同生共死） */
  private identities = new Map<string, RpcIdentity>()
  private permissionCheck: PermissionCheckFn | null = null
  private nextRequestId = 1
  // D15/D25: 主动 invoke 的回复登记表收编为 PendingTracker。
  private pendingInvokes = new PendingTracker<number, unknown>()

  /** 设置权限检查钩子，dispatch 前调用（签名接收通道反查身份，非消息体 pluginId） */
  setPermissionChecker(checker: PermissionCheckFn): void {
    this.permissionCheck = checker
  }

  registerMethod(method: string, handler: RpcMethodHandler): void {
    this.methods.set(method, handler)
  }

  unregisterMethod(method: string): void {
    this.methods.delete(method)
  }

  /** 已注册的 RPC 方法名全集（映射完整性测试用：防 SSOT 方法表与真实注册表漂移） */
  listMethods(): string[] {
    return [...this.methods.keys()]
  }

  /**
   * 注册 Worker 通信端口，可选同步注册通道身份。
   *
   * @param identity 宿主权威身份元数据；省略时仅注册端口（身份缺失的 Worker 在
   *   装有 permissionCheck 时 dispatch 会被 fail-closed 拒绝）
   */
  registerWorker(workerId: string, port: WorkerPort, identity?: RpcIdentity): void {
    this.workers.set(workerId, port)
    if (identity) this.identities.set(workerId, identity)
  }

  /** 独立注册/更新通道身份（与 registerWorker 解耦的注入口） */
  registerIdentity(workerId: string, identity: RpcIdentity): void {
    this.identities.set(workerId, identity)
  }

  /**
   * 按通道反查身份：dispatch 鉴权与 params.pluginId 覆写的唯一身份来源。
   * 未注册的 workerId 返回 undefined → dispatch fail-closed 拒绝。
   */
  resolveIdentity(workerId: string): RpcIdentity | undefined {
    return this.identities.get(workerId)
  }

  unregisterWorker(workerId: string): void {
    this.workers.delete(workerId)
    this.identities.delete(workerId)
  }

  /** 向指定 Worker 发送通知（无 id，不期望响应） */
  notify(workerId: string, method: string, params: Record<string, unknown>): void {
    const worker = this.workers.get(workerId)
    if (!worker) return
    const notification: RpcNotification = { jsonrpc: '2.0', method, params }
    worker.postMessage({ type: 'rpc', notification })
  }

  /** 向所有已注册 Worker 广播通知 */
  broadcast(method: string, params: Record<string, unknown>): void {
    for (const worker of this.workers.values()) {
      const notification: RpcNotification = { jsonrpc: '2.0', method, params }
      worker.postMessage({ type: 'rpc', notification })
    }
  }

  /**
   * 发起 RPC 请求到指定 Worker，等待响应。
   *
   * 用于主线程主动调用 Worker 的方法（如 plugin.tool.execute）。
   * 创建 pending entry，发送请求到 Worker port，等待 handleResponse 匹配。
   *
   * @param workerId - 目标 Worker ID
   * @param method - RPC 方法名
   * @param params - 请求参数
   * @param timeoutMs - 超时时间（毫秒）
   */
  invoke(workerId: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const worker = this.workers.get(workerId)
    if (!worker) {
      return Promise.reject(new Error(`Worker not found: ${workerId}`))
    }

    const id = this.nextRequestId++
    const promise = this.pendingInvokes.register(id, timeoutMs, new Error('RPC timeout'))

    const request: RpcRequest = { jsonrpc: '2.0', id, method, params }
    worker.postMessage({ type: 'rpc', request })

    return promise
  }

  /**
   * 处理来自 Worker 的 RPC 响应（对应 invoke 发出的请求）。
   *
   * 当 PluginHost 收到 type: 'rpc' 消息且包含 id + (result | error) 时调用。
   * 如果 id 匹配 pendingInvokes，resolve/reject 对应的 Promise。
   * 如果不匹配（属于 Worker 主动发起的请求），返回 false。
   */
  handleResponse(response: import('./plugin-types.js').RpcResponse): boolean {
    if ('error' in response) {
      return this.pendingInvokes.reject(response.id, new Error(response.error.message))
    }
    return this.pendingInvokes.resolve(response.id, response.result)
  }

  /**
   * 处理来自 Worker 的 RPC 请求，调用对应 handler 并回复结果。
   *
   * 调用方（PluginHost）从 WorkerToHostMessage 中提取 RpcRequest 后传入。
   * 无 id 消息（notification，如 plugin.notify 经 rpcClient.notify 发出的扁平消息）
   * 按 JSON-RPC 语义不回包——handler 照常执行，错误记日志。
   *
   * 鉴权（通道反查）：身份取 workerId → identities 映射（宿主注册，不可伪造），
   * 消息体内 params.pluginId 不参与任何安全判定。来源无法解析身份 → fail-closed 拒绝。
   *
   * 身份覆写：sandbox 通道唯一归属插件强制覆写 params.pluginId（分区键 storage/
   * sessionData 均取此值——只改鉴权不改分区键是半吊子修复）。覆写发生在进入
   * handler 之前，即 api 层入口校验（W5）之前。trusted 通道多插件共享，无唯一
   * 归属，不覆写（trusted 插件间互不设防是设计语义）。
   */
  async dispatch(workerId: string, message: RpcRequest): Promise<void> {
    const worker = this.workers.get(workerId)
    if (!worker) return

    // notification（无 id）：执行但不回包（JSON-RPC 2.0 语义，与 Worker 侧
    // rpcClient.notify / 主线程侧 rpcServer.notify 对偶）
    const isNotification = message.id === undefined || message.id === null

    const handler = this.methods.get(message.method)
    if (!handler) {
      if (!isNotification) {
        worker.postMessage({ type: 'rpc', response: this.makeErrorResponse(message.id, PluginRpcErrorCodes.METHOD_NOT_FOUND, `Method not found: ${message.method}`) })
      }
      return
    }

    // 权限检查（通道身份，非消息体自报）
    const identity = this.identities.get(workerId)
    const claimedPluginId = typeof message.params?.pluginId === 'string' ? message.params.pluginId : undefined
    const deniedReason = this.evaluatePermission(workerId, message.method, identity, claimedPluginId)
    if (deniedReason !== null) {
      this.handleDenied(worker, workerId, message, identity, claimedPluginId, deniedReason, isNotification)
      return
    }

    // 身份覆写（在 api 入口校验之前）：sandbox 通道唯一归属插件强制覆写，
    // 消息体自报 pluginId 从鉴权/分区/事件归属整条信任链移除
    this.overwriteSandboxPluginId(identity, message)

    try {
      const result = await handler(message.params, { workerId, identity })
      if (!isNotification) {
        worker.postMessage({ type: 'rpc', response: this.makeSuccessResponse(message.id, result) })
      }
    } catch (e: unknown) {
      this.replyHandlerError(worker, message, isNotification, e)
    }
  }

  /**
   * 权限门判定：未装 permissionCheck → null（放行）；来源无法解析身份 →
   * fail-closed 拒绝文案；权限检查不过 → describeDenial 文案。
   * 返回 null = 放行，非 null = 拒绝原因。
   */
  private evaluatePermission(
    workerId: string,
    method: string,
    identity: RpcIdentity | undefined,
    claimedPluginId: string | undefined,
  ): string | null {
    if (!this.permissionCheck) return null
    if (!identity) {
      // fail-closed：装有权限检查时，来源无法解析身份的消息一律拒绝
      return `cannot resolve worker identity for '${workerId}' (fail-closed)`
    }
    if (!this.permissionCheck(identity, method)) {
      return this.describeDenial(identity, claimedPluginId, method)
    }
    return null
  }

  /**
   * 拒绝处置：notification 被拒无回包通道（JSON-RPC 语义），拒绝必须落日志——
   * 否则插件通知静默消失，排查时无迹可循（Fix-4）；request 被拒回
   * PERMISSION_DENIED 错误响应。
   */
  private handleDenied(
    worker: WorkerPort,
    workerId: string,
    message: RpcRequest,
    identity: RpcIdentity | undefined,
    claimedPluginId: string | undefined,
    deniedReason: string,
    isNotification: boolean,
  ): void {
    if (isNotification) {
      console.warn(`[plugin-rpc-server] notification denied (PERMISSION_DENIED): worker=${workerId} identity=${identity ? this.identityLabel(identity) : 'unresolved'}${claimedPluginId ? ` claimed=${claimedPluginId}` : ''} method=${message.method}`)
      return
    }
    worker.postMessage({ type: 'rpc', response: this.makeErrorResponse(message.id, PluginRpcErrorCodes.PERMISSION_DENIED, `PERMISSION_DENIED: ${deniedReason}`) })
  }

  /** sandbox 通道唯一归属插件强制覆写 params.pluginId（trusted 多插件共享不覆写） */
  private overwriteSandboxPluginId(identity: RpcIdentity | undefined, message: RpcRequest): void {
    if (identity?.trustLevel === 'sandbox' && identity.pluginId) {
      if (!message.params || typeof message.params !== 'object') {
        message.params = {}
      }
      message.params.pluginId = identity.pluginId
    }
  }

  /** handler 执行异常的回包：notification 无回包通道只能落日志，request 回错误响应 */
  private replyHandlerError(worker: WorkerPort, message: RpcRequest, isNotification: boolean, e: unknown): void {
    const errorMessage = toErrorMessage(e)
    if (isNotification) {
      // notification 无回包通道，错误只能落日志
      console.error(`[plugin-rpc-server] notification handler error (${message.method}):`, errorMessage)
      return
    }
    const code = (e as { code?: number })?.code ?? PluginRpcErrorCodes.INTERNAL_ERROR
    worker.postMessage({ type: 'rpc', response: this.makeErrorResponse(message.id, code, errorMessage) })
  }

  dispose(): void {
    this.pendingInvokes.rejectAll(new Error('RPC server disposed'))
    this.methods.clear()
    this.workers.clear()
    this.identities.clear()
  }

  /** 拒绝原因文案：sandbox 伪冒他人 id 时显式标注 identity mismatch（可直接指导排查） */
  private describeDenial(identity: RpcIdentity, claimedPluginId: string | undefined, method: string): string {
    if (identity.trustLevel === 'sandbox' && identity.pluginId) {
      if (claimedPluginId !== undefined && claimedPluginId !== identity.pluginId) {
        return `${method} (identity mismatch: message claimed '${claimedPluginId}' but channel identity is '${identity.pluginId}')`
      }
      return `${method} (not granted to '${identity.pluginId}')`
    }
    return `${method} (denied for ${this.identityLabel(identity)})`
  }

  private identityLabel(identity: RpcIdentity): string {
    return identity.pluginId ? `${identity.trustLevel}:${identity.pluginId}` : identity.trustLevel
  }

  private makeSuccessResponse(id: number, result: unknown): RpcResponse {
    return { jsonrpc: '2.0', id, result }
  }

  private makeErrorResponse(id: number, code: number, message: string, data?: unknown): RpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message, data } }
  }
}
