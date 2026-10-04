/**
 * Extension UI request 生命周期管理（无超时）。
 * per-session 挂起单表：session 跟踪与 pending request 缓存由同一 entry 承载——
 * [pi1-disposition-chat-flow D7②/E 组] bridge 登记语义（isBridge 标记 / addBridgeRequest /
 * isBridgeRequest）随 plugin-bridge 整体退役删除；普通插件对话框的登记/缓存/失效语义保留。
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
 * getPendingRequests 返回值类型：原始字段 + payload 解包到顶层（`{ ...r, ...r.payload }`）。
 * payload 字段不固定（ask/confirm/select 各自不同），故解包部分用索引签名收纳——
 * 消费方（renderer 经类型守卫收窄为 ExtensionUIRequest）按 dialogKind 取具体字段。
 */
export type PendingUIRequestResolved = PendingUIRequest & Record<string, unknown>

export class ExtensionTimeoutManager {
  /**
   * 挂起单表：sessionId → (requestId → entry)。唯一存储结构——
   * 登记写表，清理摘 entry。
   *
   * 命名债：类名与消费方字段名（extensionTimeoutMgr）保留历史超时语义，现职责 =
   * 挂起请求登记处（本文件头注「生命周期管理（无超时）」口径，超时链已整体删除）。
   * 改名横跨 19+ 消费方，设计 D-B2-2 裁决只收敛方法名（clearTimeout 族 →
   * removeRequest，已落地），类名/字段名留后续清理批（候选形态 = 职责名如
   * PendingRequestRegistry），非本设计义务。
   */
  private requests = new Map<string, Map<string, PendingUIRequest>>()

  /**
   * 应答清理单点：按 requestId 从挂起单表摘除 entry（session 跟踪与 pending 缓存一体
   * 摘除）。requestId 全局唯一，命中即 break；幂等。
   *
   * ui_response 应答点共用本原语——双表时代「一个请求两次清理、两处对账」随单表消失
   * （D-B2-2：旧公开方法按职责收敛为本原语，超时机制已删，方法名不再残留超时语义）。
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
   * 探针：指定 session 的挂起单表登记条数（A5 验收「应答后归零」/单测断言用；
   * 只读，无副作用）。
   */
  sessionRequestCount(sessionId: string): number {
    return this.requests.get(sessionId)?.size ?? 0
  }

  /** Clear all pending request tracking for a session */
  clearForSession(sessionId: string): void {
    this.requests.delete(sessionId)
  }

  /**
   * 摘除指定 session 的全部挂起 UI 请求并返回清单（P2-2 失效链的唯一摘除口）。
   *
   * 非 respond 方式终结挂起请求（abort turn / 退出 plan / 回收）时，select 已随
   * controller.abort 解散、响应永不可达——保留缓存只会让 renderer 渲染「僵尸 ready
   * 审批条/表单」（点击后响应发到死 id 被 pi 静默丢弃）。摘除后由调用方广播失效帧，
   * renderer 据此移除本屏请求。与 clearForSession 的区别：本方法返回被摘清单供广播；
   * 单表摘除即跟踪/缓存一体清空，失效清单不再残留死 id（旧双表形态下跟踪表残留到
   * session 销毁）。
   */
  invalidatePendingForSession(sessionId: string): PendingUIRequestResolved[] {
    const sessionCache = this.requests.get(sessionId)
    if (!sessionCache || sessionCache.size === 0) return []
    const invalidated: PendingUIRequestResolved[] = []
    for (const [requestId, entry] of sessionCache) {
      invalidated.push(this.toResolved(entry))
      sessionCache.delete(requestId)
    }
    if (sessionCache.size === 0) this.requests.delete(sessionId)
    return invalidated
  }

  /**
   * 获取指定 session 的所有 pending 请求（非破坏性只读快照）。
   *
   * 用于方案2 的 session 级状态快照模型：pending UI 请求是 session 固有状态，
   * 多次拉取都返回完整列表（与 session.commands 快照语义同构）。
   * 移除时机由 removeRequest（respond 后）或 clearForSession（session 销毁）控制，
   * 不由拉取动作控制。
   */
  getPendingRequests(sessionId: string): PendingUIRequestResolved[] {
    const sessionCache = this.requests.get(sessionId)
    if (!sessionCache || sessionCache.size === 0) return []
    const requests: PendingUIRequestResolved[] = []
    for (const entry of sessionCache.values()) {
      requests.push(this.toResolved(entry))
    }
    return requests
  }

  /**
   * 挂起单表登记原语（唯一写表点）：upsert entry，session 跟踪与 pending 载荷缓存由
   * 同一 entry 承载——同一请求不再双表各写一份（D-B2-2：旧公开方法 trackUiRequest /
   * cachePendingRequest 按职责收敛为本原语，调用方一次登记）。
   *
   * [HISTORICAL] 2026-07-16 取消所有 extension UI 超时：confirm/select/input/editor/ask-user
   * 统一不超时，block 等待用户决策，登记只为 session 跟踪以便 clearForSession 清理。
   * 旧 bridge 通道的登记分支（addBridgeRequest / isBridge 标记）随 plugin-bridge 整体
   * 退役删除（pi1-disposition-chat-flow D7②/E 组）；notify 早退分支同批删除：notify 类
   * 不产 dialog 帧（event-adapter 翻译收窄，生产不可达）。
   */
  registerRequest(sessionId: string, requestId: string, method: string, payload: Record<string, unknown> = {}): void {
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
    })
  }

  /** entry → 对外解析形态：payload 解包到顶层（键序与旧 `{ ...r, ...r.payload }` 一致） */
  private toResolved(entry: PendingUIRequest): PendingUIRequestResolved {
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
