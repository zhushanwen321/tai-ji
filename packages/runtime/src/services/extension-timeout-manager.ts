/**
 * Extension UI request timeout manager.
 * Handles registration, clearing, and session-scoped cleanup of extension timeouts.
 *
 * Extension UI requests block indefinitely waiting for user response.
 * Interactive methods (confirm/select/input/editor/ask-user) no longer set a timer;
 * only session tracking is retained so clearForSession can clean up on session end.
 *
 * [2026-07-16] 新增 pending request 缓存：缓存 pending 的 ask-user 请求内容，
 * 当 session 重新激活时（前端重新订阅时），runtime 主动推送缓存的请求，
 * 解决「切换 session 后 ask-user 请求丢失」问题。
 *
 * TODO（死代码现状，待重新设计或彻底移除）：registerTimeout 改为同步 `void onTimeout`
 * 不排定时器后，下列字段/方法成了事实上的死代码——
 *   - extensionTimeouts Map：registerTimeout 不再写入，clearTimeout/clearForSession 内的
 *     `extensionTimeouts.get` 恒为 undefined（保留无害但无意义）
 *   - timedOutIds Set / markTimedOut / isTimedOut / clearTimedOut：由 transport/
 *     extension-message-handler.handleExtensionTimeout（经 server.ts 的 dead 回调闭包）
 *     调用，但该闭包随 registerTimeout 改为同步触发后永不再被调用，整条链不触发
 *   - handleExtensionTimeout / ui_timeout 广播分支：同上
 * 故意保留而非删除，原因：(1) TIMEOUT_MS / EXTENSION_UI_TIMEOUT_MS 仍被单测
 * （extension-timeout-manager.test.ts 用 advanceTimersByTime 验证「不触发」）引用；
 * (2) 超时编排链跨 transport/extension-message-handler.ts + server.ts 两个文件，
 * 整链移除需协同改动且超出本 PR scope。待超时机制重新设计或确认废弃后统一清理。
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

/**
 * 历史 5min UI 超时常量（300_000ms）。交互式 method 已不再排定时器，
 * 此常量仅保留供单测（extension-timeout-manager.test.ts 用 vi.advanceTimersByTime
 * 推进超大偏移验证回调不触发）使用——不得删除。
 */
const EXTENSION_UI_TIMEOUT_MS = 300_000

export class ExtensionTimeoutManager {
  private extensionTimeouts = new Map<string, NodeJS.Timeout>()
  private extensionSessionRequests = new Map<string, Set<string>>()
  private bridgeRequestIds = new Set<string>()
  /** 已超时的 requestId 集合——防止前端 race window 内迟到的 ui_response 再发一次（双响应） */
  private timedOutIds = new Set<string>()
  /** 缓存 pending 的 UI 请求（per-session），用于 session 重新激活时推送 */
  private pendingRequests = new Map<string, Map<string, PendingUIRequest>>()

  /**
   * 历史 5min UI 超时常量。交互式 method 已不再排定时器，
   * 此属性仅保留供单测使用——不得删除。值见模块级 EXTENSION_UI_TIMEOUT_MS。
   */
  readonly TIMEOUT_MS = EXTENSION_UI_TIMEOUT_MS

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
   * Register a timeout for an extension UI request.
   * Returns cleanup info or undefined if no timer needed (notify method).
   *
   * [2026-07-16] 取消所有 extension UI 超时：confirm/select/input/editor/ask-user
   * 统一不超时，block 等待用户决策。保留 session 跟踪以便 clearForSession 清理。
   * onTimeout 参数保留为 dead callback（不再被调用），维持调用点签名稳定。
   *
   * [HISTORICAL] 旧 bridge 通道的 `method.startsWith('bridge:')` 前缀登记分支已删除
   * （设计 bridge-rewrite-pi-0.84 §3.3-D6 清理批）：旧 event-adapter bridge:* 翻译分支
   * 删除后，本方法只由 extension-ui kind 触发，而 bridge 请求不产该 kind——该分支生产
   * 不可达。新通道（select+BRIDGE_MARKER）的登记在 BridgeHandler 入口经 addBridgeRequest。
   */
  registerTimeout(
    sessionId: string,
    requestId: string,
    method: string,
    onTimeout: () => void,
  ): void {
    void onTimeout // 不再排定时器，回调保留为签名稳定占位
    if (method === 'notify') return

    // 交互式 method（select/confirm/input/editor/ask-user）：只做 session 跟踪，不排超时定时器
    this.trackSessionRequest(sessionId, requestId)
  }

  /** Clear the timeout timer for a specific requestId */
  clearTimeout(requestId: string): void {
    const timer = this.extensionTimeouts.get(requestId)
    if (timer) {
      clearTimeout(timer)
      this.extensionTimeouts.delete(requestId)
    }
    for (const [sid, reqs] of this.extensionSessionRequests) {
      if (reqs.delete(requestId)) {
        if (reqs.size === 0) this.extensionSessionRequests.delete(sid)
        break
      }
    }
  }

  /** 标记 requestId 已超时（handleExtensionTimeout 调用，防止后续迟到的 ui_response 双响应） */
  markTimedOut(requestId: string): void {
    this.timedOutIds.add(requestId)
  }

  /** 检查 requestId 是否已超时（extension.ui_response handler 调用，丢弃迟到响应） */
  isTimedOut(requestId: string): boolean {
    return this.timedOutIds.has(requestId)
  }

  /** 清除已超时标记（丢弃迟到响应后调用，防止集合无限增长） */
  clearTimedOut(requestId: string): void {
    this.timedOutIds.delete(requestId)
  }

  /** Clear all pending timeouts for a session */
  clearForSession(sessionId: string): void {
    // 清除缓存的 pending 请求（必须在 extensionSessionRequests 早退之前执行，
    // 否则只 cachePendingRequest 而未 registerTimeout 的 session 会漏清 pending 缓存）
    this.pendingRequests.delete(sessionId)
    const requestIds = this.extensionSessionRequests.get(sessionId)
    if (!requestIds) return
    for (const reqId of requestIds) {
      const timer = this.extensionTimeouts.get(reqId)
      if (timer) {
        clearTimeout(timer)
        this.extensionTimeouts.delete(reqId)
      }
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
