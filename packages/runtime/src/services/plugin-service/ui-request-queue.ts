/**
 * UI 请求串行队列（UiRequestQueue）
 *
 * 把插件发起的 UI 弹窗请求（confirm / select / input）串行派发给前端，在前端响应、
 * 到期取消通知（cancelRequest）或防泄漏兜底到期后收尾。
 *
 * 行为契约（timeout-plugin-service D2：语义计时权威在 Worker 侧 ui-api，本层退为
 * 防泄漏兜底——见 docs/design/timeout-plugin-service-granularity.md §6.2）：
 * - 同时只允许一个弹窗活跃（activeUiRequest），后续请求进 uiRequestQueue 排队。
 * - 语义超时由 Worker 侧 ui-api 计（opts.timeout 或默认 30min，全程含排队）；本层
 *   不再做语义裁决、不再替答（旧 60s resolve defaultResult 已删——替答会把「没回答」
 *   伪造成「回答了不要」，且真实生效的是更早的 client 30s 报错）。
 * - 到期取消：Worker 侧 timer 到期 → UI_TIMEOUT reject 插件 + cancel notification →
 *   cancelRequest(requestId)：删 pending/排队项 + 无条件广播 plugin:uiRequestExpired
 *   （前端撤窗，未展示/已关闭弹窗的撤窗 miss 由前端 noop）+ 活跃请求放行下一个。
 * - 防泄漏兜底：收到请求即挂 min(effective + 60_000, MAX_TIMER_DELAY_MS) timer
 *   （入队起算，与 Worker 侧语义 timer 同起点；仅在 cancel 通知丢失 / Worker 死亡时
 *   收尾）。min() 防 effective 被 clamp 到 timer 域上界时 +60s 超域塌缩 1ms 反客为主
 *   提前触发；effective 恰达上界时兜底与语义同刻到期，两路径清理幂等可重入。
 * - requestId 尊重 Worker 侧来方值（params.requestId）；重复 id warn + 丢弃后到者
 *   （防御性——共享 Worker 内 id 碰撞会误删他方 pending / 错撤他人弹窗）。
 *
 * 依赖：仅依赖一个 broadcast 回调（type + payload），不耦合 broker / broadcastFn 细节。
 */

import { randomSuffix } from '../../utils/ids.js'
import { MAX_TIMER_DELAY_MS, resolveUiRequestTimeoutMs } from './api/ui-api.js'

/** 兜底 timer 在语义 effective 之外的防泄漏余量：覆盖一条 cancel 通知的传播（秒级）。 */
const FALLBACK_MARGIN_MS = 60_000

/** 排队中的请求条目（兜底 timer 入队即挂，dispatch 时所有权移交 pendingUiRequests）。 */
interface QueuedRequest {
  requestId: string
  method: string
  pluginId: string
  params: Record<string, unknown>
  resolve: (v: unknown) => void
  fallbackTimer: ReturnType<typeof setTimeout>
}

/** 等待前端响应的活跃请求。entry 是请求元数据（pluginId 供到期广播定位）。 */
interface PendingRequest {
  entry: QueuedRequest
  timer: ReturnType<typeof setTimeout>
}

/** 本队列可广播的消息类型（与 shared ServerMessageMap 契约对齐）。 */
export type UiBroadcastType = 'plugin:uiRequest' | 'plugin:uiRequestExpired'

/**
 * 广播回调：把 UI 请求推给前端 / 通知前端撤回到期弹窗。payload requestId 必带
 * （dispatch 与 cancelRequest 均恒含）——与 shared ServerMessageMap['plugin:uiRequest' /
 * 'plugin:uiRequestExpired'] 契约对齐，消费方（plugin-service 广播回调）可免
 * `as ServerMessage` 断言直接构造类型化消息。
 */
export type UiBroadcastFn = (
  type: UiBroadcastType,
  payload: { requestId: string; pluginId?: string } & Record<string, unknown>,
) => void

export class UiRequestQueue {
  /** 当前活跃的 UI 请求 ID（串行排队，同一时刻仅一个） */
  activeUiRequest: string | null = null

  /** 等待中的 UI 请求队列 */
  uiRequestQueue: Array<QueuedRequest> = []

  /** 等待前端响应的 UI 请求 */
  pendingUiRequests = new Map<string, PendingRequest>()

  private readonly broadcast: UiBroadcastFn

  constructor(broadcast: UiBroadcastFn) {
    this.broadcast = broadcast
  }

  /**
   * 处理 UI 弹窗请求（串行排队）。
   * 同时只允许一个弹窗显示在前端，后续请求排队等待。
   * 语义超时由 Worker 侧计（params.timeoutMs），本层挂防泄漏兜底 timer（收尾不清算语义）。
   */
  async handleRequest(method: string, params: Record<string, unknown>, pluginId: string): Promise<unknown> {
    // D2：requestId 生成权在 Worker 侧 ui-api，本层尊重来方值（cancel 通知按它匹配）。
    // 来方缺失（旧版 Worker / 直接调用）时本地生成，保持可用（取消语义退化为兜底收尾）。
    const requestId = typeof params.requestId === 'string' && params.requestId.length > 0
      ? params.requestId
      : `${pluginId}_${Date.now()}_${randomSuffix()}`

    // 重复 id 防御：warn + 丢弃后到者（纯 Error → dispatch 回 INTERNAL_ERROR，
    // 不用 string code 保持 JSON-RPC error.code 线协议形状）
    if (
      this.pendingUiRequests.has(requestId)
      || requestId === this.activeUiRequest
      || this.uiRequestQueue.some(q => q.requestId === requestId)
    ) {
      console.warn(
        `[ui-request-queue] duplicate ui requestId=${requestId} (plugin=${pluginId}) — dropping the late duplicate`,
      )
      throw new Error(
        `duplicate ui request id '${requestId}' — an unresolved dialog with this id already exists; re-issue with a fresh request`,
      )
    }

    // effective 从 params 读（Worker 侧直传的语义值）；缺失/非法回落默认——
    // 兜底语义（防泄漏）不因断链拆掉
    const effective = resolveUiRequestTimeoutMs(typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined)
    const fallbackTimer = setTimeout(
      () => this.expireFallback(requestId),
      resolveFallbackDelayMs(effective),
    )

    const entry: QueuedRequest = { requestId, method, pluginId, params, resolve: () => {}, fallbackTimer }
    return new Promise<unknown>((resolve) => {
      entry.resolve = resolve
      if (this.activeUiRequest !== null) {
        this.uiRequestQueue.push(entry)
        return
      }
      this.activeUiRequest = requestId
      this.dispatch(entry)
    })
  }

  /** 处理前端返回的 UI 响应（供 server.ts / plugin-message-handler 调用） */
  handleResponse(requestId: string, result: unknown): void {
    const pending = this.pendingUiRequests.get(requestId)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pendingUiRequests.delete(requestId)
    pending.entry.resolve(result)
    this.processNext()
  }

  /**
   * 取消一个 UI 请求（D2 到期取消语义；由 Worker 侧 cancel notification 触发）：
   * 删 pending/排队项 + 无条件广播 plugin:uiRequestExpired（撤窗——排队中从未展示的
   * 请求也发，前端对未展示/已关闭弹窗的撤窗 miss 须 noop 幂等）+ 活跃请求 processNext
   * 放行（串行防死锁保留）。对已 settle 请求 miss-safe（找不到即 return，不重复广播）。
   */
  cancelRequest(requestId: string): void {
    const pending = this.pendingUiRequests.get(requestId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingUiRequests.delete(requestId)
      pending.entry.resolve(undefined)
      this.broadcast('plugin:uiRequestExpired', { requestId, pluginId: pending.entry.pluginId })
      if (this.activeUiRequest === requestId) this.processNext()
      return
    }

    const queuedIdx = this.uiRequestQueue.findIndex(q => q.requestId === requestId)
    if (queuedIdx >= 0) {
      const entry = this.uiRequestQueue[queuedIdx]
      clearTimeout(entry.fallbackTimer)
      this.uiRequestQueue.splice(queuedIdx, 1)
      entry.resolve(undefined)
      this.broadcast('plugin:uiRequestExpired', { requestId, pluginId: entry.pluginId })
      return
    }
    // miss：请求已 settle（响应/取消/兜底先行）→ noop
  }

  /**
   * 防泄漏兜底到期（仅 cancel 通知丢失 / Worker 死亡时触发）：与 cancelRequest 同样
   * 的清理（删项 + 撤窗广播 + 放行），resolve(undefined) 仅收口 promise——Worker 侧
   * 早已 UI_TIMEOUT reject 或已死亡，无幽灵替答。warn 标注兜底触发原因。
   */
  private expireFallback(requestId: string): void {
    const pending = this.pendingUiRequests.get(requestId)
    if (pending) {
      this.pendingUiRequests.delete(requestId)
      pending.entry.resolve(undefined)
      console.warn(
        `[ui-request-queue] fallback cleanup fired for requestId=${requestId} (plugin=${pending.entry.pluginId}) ` +
          `— cancel notification was lost or the worker died; broadcasting expiry and advancing the queue`,
      )
      this.broadcast('plugin:uiRequestExpired', { requestId, pluginId: pending.entry.pluginId })
      if (this.activeUiRequest === requestId) this.processNext()
      return
    }

    const queuedIdx = this.uiRequestQueue.findIndex(q => q.requestId === requestId)
    if (queuedIdx >= 0) {
      const entry = this.uiRequestQueue[queuedIdx]
      this.uiRequestQueue.splice(queuedIdx, 1)
      entry.resolve(undefined)
      console.warn(
        `[ui-request-queue] fallback cleanup fired for queued requestId=${requestId} (plugin=${entry.pluginId}) ` +
          `— cancel notification was lost or the worker died; broadcasting expiry`,
      )
      this.broadcast('plugin:uiRequestExpired', { requestId, pluginId: entry.pluginId })
    }
  }

  /** 发送 UI 请求到前端（兜底 timer 随 entry 从排队态移交 pending 态）。 */
  private dispatch(entry: QueuedRequest): void {
    this.pendingUiRequests.set(entry.requestId, { entry, timer: entry.fallbackTimer })

    // 广播给前端（requestId 以本层裁决值为准，覆盖来方 params 缺失场景）
    const broadcastPayload = {
      ...entry.params,
      requestId: entry.requestId,
      pluginId: entry.pluginId,
      method: entry.method,
    }
    this.broadcast('plugin:uiRequest', broadcastPayload)
  }

  /** 处理队列中的下一个 UI 请求 */
  private processNext(): void {
    if (this.uiRequestQueue.length === 0) {
      this.activeUiRequest = null
      return
    }
    const next = this.uiRequestQueue.shift()!
    this.activeUiRequest = next.requestId
    this.dispatch(next)
  }
}

/** 兜底取值口径的单测观测面：min(effective + 60s, MAX)（与 handleRequest 内一致）。 */
export function resolveFallbackDelayMs(effective: number): number {
  return Math.min(effective + FALLBACK_MARGIN_MS, MAX_TIMER_DELAY_MS)
}
