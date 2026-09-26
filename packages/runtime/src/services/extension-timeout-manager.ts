/**
 * Extension UI request 生命周期管理（无超时）。
 * per-session 挂起单表：session 跟踪、pending request 缓存与 bridge 请求登记合一，
 * entry 级 isBridge 标记字段承载 bridge 语义——旧三张平行表（extensionSessionRequests /
 * bridgeRequestIds / pendingRequests）对同一请求重复登记、应答需两步对账清理、失效后
 * 跟踪表残留死 id，是本类对抗复杂度的根源（plan-mode-audit-remediation D-B2-2）。
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
 * 缓存的 pending UI 请求（对外解析形态，未解包原文 + 解包键见 Resolved）。
 * 存于挂起单表，registerRequest 写入、removeRequest/clearForSession/invalidatePendingForSession 清理。
 */
export interface PendingUIRequest {
  requestId: string
  sessionId: string
  method: string
  payload: Record<string, unknown>
  receivedAt: number
}

/**
 * 单表 entry：PendingUIRequest + bridge 标记字段。跟踪、缓存与 bridge 三语义由同一
 * entry 承载——条目存在性即 session 跟踪，isBridge 即 bridge 登记标记。
 */
interface PendingRequestEntry extends PendingUIRequest {
  /** bridge 请求由 runtime 内部消化（不进前端快照/失效链，应答即删 B6），method/payload 无业务语义 */
  isBridge: boolean
}

/**
 * getPendingRequests 返回值类型：原始字段 + payload 解包到顶层（`{ ...r, ...r.payload }`）。
 * payload 字段不固定（ask/confirm/select 各自不同），故解包部分用索引签名收纳——
 * 消费方（renderer 经类型守卫收窄为 ExtensionUIRequest）按 method 取具体字段。
 */
export type PendingUIRequestResolved = PendingUIRequest & Record<string, unknown>

export class ExtensionTimeoutManager {
  /**
   * 挂起单表：sessionId → (requestId → entry)。唯一存储结构——
   * 登记写表，清理摘 entry。
   */
  private requests = new Map<string, Map<string, PendingRequestEntry>>()

  /** Check if a requestId is a bridge request */
  isBridgeRequest(requestId: string): boolean {
    for (const sessionCache of this.requests.values()) {
      const entry = sessionCache.get(requestId)
      if (entry) return entry.isBridge
    }
    return false
  }

  /**
   * 应答清理单点：按 requestId 从挂起单表摘除 entry（session 跟踪、pending 缓存与
   * bridge 标记一体摘除）。requestId 全局唯一，命中即 break；幂等。
   *
   * 旧公开方法 clearTimeout / removePendingRequest / removeBridgeRequest 均收敛为
   * 本原语的语义别名（薄门面，见各方法注释）——双表时代「一个请求两次清理、两处
   * 对账」随单表消失。
   */
  removeRequest(requestId: string): void {
    for (const [sid, sessionCache] of this.requests) {
      if (sessionCache.delete(requestId)) {
        if (sessionCache.size === 0) this.requests.delete(sid)
        break
      }
    }
  }

  /**
   * B6 探针：指定 session 的挂起单表登记条数（A5 验收「应答后归零」/单测断言用；
   * 只读，无副作用）。
   */
  sessionRequestCount(sessionId: string): number {
    return this.requests.get(sessionId)?.size ?? 0
  }

  /**
   * 登记 marker 通道（select+BRIDGE_MARKER，设计 bridge-rewrite-pi-0.84 §3.3-D6）识别出的
   * bridge 请求（isBridge=true entry 进挂起单表）：供前端误发 ui_response 的拦截判定
   * （isBridgeRequest）与 clearForSession 清理；不排定时器——bridge 请求由 runtime 内部
   * 消化，无前端弹窗超时，应答即删由 BridgeHandler 尾部 finally 调 removeRequest（B6）。
   */
  addBridgeRequest(sessionId: string, requestId: string): void {
    let sessionCache = this.requests.get(sessionId)
    if (!sessionCache) {
      sessionCache = new Map()
      this.requests.set(sessionId, sessionCache)
    }
    sessionCache.set(requestId, {
      requestId,
      sessionId,
      method: 'bridge',
      payload: {},
      receivedAt: Date.now(),
      isBridge: true,
    })
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
   *
   * 单表门面：非 notify 即建 entry（session 跟踪语义）；pending 载荷由成对调用的
   * cachePendingRequest 补齐。方法名保留旧称——消费方调用点在单元领地外，改名
   * （D-B2-2 原案）需领地扩展后统一收敛到 registerRequest。
   */
  trackUiRequest(sessionId: string, requestId: string, method: string): void {
    if (method === 'notify') return
    this.registerRequest(sessionId, requestId, method, {})
  }

  /** 清除指定 requestId 的登记（ui_response 应答后调；单表门面，见 removeRequest）。
   * 方法名保留旧称——超时机制已删，现职责是摘除挂起登记，改名需消费方领地同步。 */
  clearTimeout(requestId: string): void {
    this.removeRequest(requestId)
  }

  /** Clear all pending request tracking for a session */
  clearForSession(sessionId: string): void {
    this.requests.delete(sessionId)
  }

  // ── Pending request 缓存（解决切换 session 后 ask-user 请求丢失问题）──

  /**
   * 缓存 pending 的 UI 请求（ask-user 等阻塞式请求）。
   * 当 session 重新激活时（前端重新订阅时），runtime 主动推送缓存的请求。
   * 单表门面：upsert entry（pending 载荷语义）；方法名保留旧称原因同 trackUiRequest。
   */
  cachePendingRequest(
    sessionId: string,
    requestId: string,
    method: string,
    payload: Record<string, unknown>,
  ): void {
    this.registerRequest(sessionId, requestId, method, payload)
  }

  /**
   * 移除缓存的 pending 请求（用户响应后调用）。
   * 单表门面：跟踪与缓存同 entry，摘除即全清（与成对调用的 clearTimeout 收敛到
   * 同一原语）；方法名保留旧称原因同 trackUiRequest。
   */
  removePendingRequest(sessionId: string, requestId: string): void {
    this.removeRequest(requestId)
  }

  /**
   * Remove a bridge request ID from tracking（B6 应答即删，memory-leak-remediation §3.2-B6）。
   * 单表门面：bridge 标记随 entry 一体摘除，无需双集合对账；幂等。
   * 方法名保留旧称——消费方（bridge-handler 结构类型 / extension-message-handler）在
   * 单元领地外，改名需领地扩展后统一收敛到 removeRequest。
   */
  removeBridgeRequest(requestId: string): void {
    this.removeRequest(requestId)
  }

  /**
   * 摘除指定 session 的全部挂起 UI 请求并返回清单（P2-2 失效链的唯一摘除口）。
   *
   * 非 respond 方式终结挂起请求（abort turn / 退出 plan / 回收）时，select 已随
   * controller.abort 解散、响应永不可达——保留缓存只会让 renderer 渲染「僵尸 ready
   * 审批条/表单」（点击后响应发到死 id 被 pi 静默丢弃）。摘除后由调用方广播失效帧，
   * renderer 据此移除本屏请求。与 clearForSession 的区别：本方法返回被摘清单供广播。
   * isBridge=true 的 entry 不摘（bridge 请求由内部通道应答，不走用户 respond，无僵尸
   * 点击问题，应答即删归 B6）——失效链只覆盖前端可点击面；单表摘除即跟踪/缓存一体
   * 清空，失效清单不再残留死 id（旧双表形态下跟踪表残留到 session 销毁）。
   */
  invalidatePendingForSession(sessionId: string): PendingUIRequestResolved[] {
    const sessionCache = this.requests.get(sessionId)
    if (!sessionCache || sessionCache.size === 0) return []
    const invalidated: PendingUIRequestResolved[] = []
    for (const [requestId, entry] of sessionCache) {
      if (entry.isBridge) continue
      invalidated.push(this.toResolved(entry))
      sessionCache.delete(requestId)
    }
    if (sessionCache.size === 0) this.requests.delete(sessionId)
    return invalidated
  }

  /**
   * 获取指定 session 的所有 pending 请求（非破坏性只读快照；bridge entry 不出现）。
   *
   * 用于方案2 的 session 级状态快照模型：pending UI 请求是 session 固有状态，
   * 多次拉取都返回完整列表（与 session.commands 快照语义同构）。
   * 移除时机由 removePendingRequest（respond 后）或 clearForSession（session 销毁）控制，
   * 不由拉取动作控制。
   */
  getPendingRequests(sessionId: string): PendingUIRequestResolved[] {
    const sessionCache = this.requests.get(sessionId)
    if (!sessionCache || sessionCache.size === 0) return []
    const requests: PendingUIRequestResolved[] = []
    for (const entry of sessionCache.values()) {
      if (entry.isBridge) continue
      requests.push(this.toResolved(entry))
    }
    return requests
  }

  /**
   * 单表登记原语（唯一写表点）：upsert 一个 isBridge=false entry。
   * trackUiRequest / cachePendingRequest 两步登记经此处合一——同一请求不再双表各写一份。
   */
  private registerRequest(sessionId: string, requestId: string, method: string, payload: Record<string, unknown>): void {
    let sessionCache = this.requests.get(sessionId)
    if (!sessionCache) {
      sessionCache = new Map()
      this.requests.set(sessionId, sessionCache)
    }
    sessionCache.set(requestId, {
      requestId,
      sessionId,
      method,
      payload,
      receivedAt: Date.now(),
      isBridge: false,
    })
  }

  /** entry → 对外解析形态：剥内部 isBridge 标记 + payload 解包到顶层（键序与旧 `{ ...r, ...r.payload }` 一致） */
  private toResolved(entry: PendingRequestEntry): PendingUIRequestResolved {
    return {
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      method: entry.method,
      payload: entry.payload,
      receivedAt: entry.receivedAt,
      ...entry.payload,
    }
  }
}
