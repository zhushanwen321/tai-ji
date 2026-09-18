/**
 * Extension UI request 生命周期管理（无超时）。
 * per-session 请求跟踪 + pending request 缓存 + bridge 请求登记。
 *
 * Extension UI requests block indefinitely waiting for user response.
 * Interactive methods (confirm/select/input/editor/ask-user) set no timer;
 * session tracking lets clearForSession clean up on session end.
 *
 * [HISTORICAL] 2026-07-16 取消所有 extension UI 超时（原 5min）；2026-09-17 死代码
 * 清理：随超时取消而恒不触发的整条编排链（extensionTimeouts Map / timedOutIds Set /
 * markTimedOut / isTimedOut / clearTimedOut / handleExtensionTimeout / extension.ui_timeout
 * 广播 + 前端 onUITimeout 消费链）已整体删除，本类只保留活职责。
 *
 * [2026-07-16] pending request 缓存：缓存 pending 的 ask-user 请求内容，
 * 当 session 重新激活时（前端重新订阅时），runtime 主动推送缓存的请求，
 * 解决「切换 session 后 ask-user 请求丢失」问题。
 */

/**
 * 缓存的 pending UI 请求（内部原始结构，未解包）。
 * 存于 pendingRequests Map，cachePendingRequest 写入、removePendingRequest/clearForSession 清理。
 */
export interface PendingUIRequest {
  requestId: string
  sessionId: string
  method: string
  payload: Record<string, unknown>
  receivedAt: number
}

/**
 * getPendingRequests 返回值类型：原始字段 + payload 解包到顶层（`{ ...r, ...r.payload }`）。
 * payload 字段不固定（ask/confirm/select 各自不同），故解包部分用索引签名收纳——
 * 消费方（renderer 经类型守卫收窄为 ExtensionUIRequest）按 method 取具体字段。
 */
export type PendingUIRequestResolved = PendingUIRequest & Record<string, unknown>

export class ExtensionTimeoutManager {
  private extensionSessionRequests = new Map<string, Set<string>>()
  private bridgeRequestIds = new Set<string>()
  /** 缓存 pending 的 UI 请求（per-session），用于 session 重新激活时推送 */
  private pendingRequests = new Map<string, Map<string, PendingUIRequest>>()

  /** Check if a requestId is a bridge request */
  isBridgeRequest(requestId: string): boolean {
    return this.bridgeRequestIds.has(requestId)
  }

  /**
   * Remove a bridge request ID from tracking（B6 应答即删，memory-leak-remediation §3.2-B6）。
   *
   * 除 bridgeRequestIds 外同步清 per-session Set（trackSessionRequest 的对偶——只删全局
   * Set 不删 session Set 会留下空 Set 条目驻留到 session 销毁）。全 session 扫描定位
   * （同本类 clearTimeout 既有模式；requestId 全局唯一，命中即 break，活跃 session 数
   * 量级下成本可忽略），无需调用方传 sessionId——保持既有单参签名兼容
   * extension-message-handler 的防御分支调用。幂等。
   */
  removeBridgeRequest(requestId: string): void {
    this.bridgeRequestIds.delete(requestId)
    for (const [sid, reqs] of this.extensionSessionRequests) {
      if (reqs.delete(requestId)) {
        if (reqs.size === 0) this.extensionSessionRequests.delete(sid)
        break
      }
    }
  }

  /**
   * B6 探针：指定 session 的在途请求跟踪条数（A5 验收「应答后 Set 归零」/单测断言用；
   * 只读，无副作用）。
   */
  sessionRequestCount(sessionId: string): number {
    return this.extensionSessionRequests.get(sessionId)?.size ?? 0
  }

  /**
   * 登记 marker 通道（select+BRIDGE_MARKER，设计 bridge-rewrite-pi-0.84 §3.3-D6）识别出的
   * bridge 请求——marker 通道唯一的 bridgeRequestIds 登记入口（识别出的请求到达
   * BridgeHandler 时经此方法显式登记）：bridgeRequestIds + session 跟踪，供
   * clearForSession 清理；不排定时器——bridge 请求由 runtime 内部消化，无前端弹窗超时。
   */
  addBridgeRequest(sessionId: string, requestId: string): void {
    this.bridgeRequestIds.add(requestId)
    this.trackSessionRequest(sessionId, requestId)
  }

  /**
   * 登记一个 extension UI 请求的 session 跟踪（notify method 无 UI 生命周期，跳过）。
   *
   * [HISTORICAL] 2026-07-16 取消所有 extension UI 超时：confirm/select/input/editor/ask-user
   * 统一不超时，block 等待用户决策，本方法只保留 session 跟踪以便 clearForSession 清理。
   *
   * [HISTORICAL] 旧 bridge 通道的 `method.startsWith('bridge:')` 前缀登记分支已删除
   * （设计 bridge-rewrite-pi-0.84 §3.3-D6 清理批）：旧 event-adapter bridge:* 翻译分支
   * 删除后，本方法只由 extension-ui kind 触发，而 bridge 请求不产该 kind——该分支生产
   * 不可达。新通道（select+BRIDGE_MARKER）的登记在 BridgeHandler 入口经 addBridgeRequest。
   */
  trackUiRequest(sessionId: string, requestId: string, method: string): void {
    if (method === 'notify') return

    // 交互式 method（select/confirm/input/editor/ask-user）：只做 session 跟踪
    this.trackSessionRequest(sessionId, requestId)
  }

  /** 清除指定 requestId 的 session 跟踪（ui_response 应答后调） */
  clearTimeout(requestId: string): void {
    for (const [sid, reqs] of this.extensionSessionRequests) {
      if (reqs.delete(requestId)) {
        if (reqs.size === 0) this.extensionSessionRequests.delete(sid)
        break
      }
    }
  }

  /** Clear all pending request tracking for a session */
  clearForSession(sessionId: string): void {
    // 清除缓存的 pending 请求（必须在 extensionSessionRequests 早退之前执行，
    // 否则只 cachePendingRequest 而未 trackUiRequest 的 session 会漏清 pending 缓存）
    this.pendingRequests.delete(sessionId)
    const requestIds = this.extensionSessionRequests.get(sessionId)
    if (!requestIds) return
    for (const reqId of requestIds) {
      this.bridgeRequestIds.delete(reqId)
    }
    this.extensionSessionRequests.delete(sessionId)
  }

  private trackSessionRequest(sessionId: string, requestId: string): void {
    let requestSet = this.extensionSessionRequests.get(sessionId)
    if (!requestSet) {
      requestSet = new Set()
      this.extensionSessionRequests.set(sessionId, requestSet)
    }
    requestSet.add(requestId)
  }

  // ── Pending request 缓存（解决切换 session 后 ask-user 请求丢失问题）──

  /**
   * 缓存 pending 的 UI 请求（ask-user 等阻塞式请求）。
   * 当 session 重新激活时（前端重新订阅时），runtime 主动推送缓存的请求。
   */
  cachePendingRequest(
    sessionId: string,
    requestId: string,
    method: string,
    payload: Record<string, unknown>,
  ): void {
    let sessionCache = this.pendingRequests.get(sessionId)
    if (!sessionCache) {
      sessionCache = new Map()
      this.pendingRequests.set(sessionId, sessionCache)
    }
    sessionCache.set(requestId, {
      requestId,
      sessionId,
      method,
      payload,
      receivedAt: Date.now(),
    })
  }

  /**
   * 移除缓存的 pending 请求（用户响应后调用）。
   */
  removePendingRequest(sessionId: string, requestId: string): void {
    const sessionCache = this.pendingRequests.get(sessionId)
    if (!sessionCache) return
    sessionCache.delete(requestId)
    if (sessionCache.size === 0) {
      this.pendingRequests.delete(sessionId)
    }
  }

  /**
   * 获取指定 session 的所有 pending 请求（非破坏性只读快照）。
   *
   * 用于方案2 的 session 级状态快照模型：pending UI 请求是 session 固有状态，
   * 多次拉取都返回完整列表（与 session.commands 快照语义同构）。
   * 移除时机由 removePendingRequest（respond 后）或 clearForSession（session 销毁）控制，
   * 不由拉取动作控制。
   */
  getPendingRequests(sessionId: string): PendingUIRequestResolved[] {
    const sessionCache = this.pendingRequests.get(sessionId)
    if (!sessionCache || sessionCache.size === 0) return []
    const requests = Array.from(sessionCache.values())
    return requests.map(r => ({ ...r, ...r.payload }))
  }
}
