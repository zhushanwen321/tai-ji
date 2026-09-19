/**
 * DialogRequestQueue —— FR4 核心：统一对话框请求队列（headless，无 DOM）。
 *
 * 位置：ui 层 extension-host/（S4 slice TC1 裁决：pending 队列归 ui 侧，S2 bridge 只做归一映射与分发）。
 *
 * 数据流：S2 MessageBusBridge 归一 plugin:uiRequest + extension.ui_request → InternalEventBus
 * ui-request 事件 → 壳适配为 DialogRequestSource.onUiRequest 注入 → 本队列按 session 分区入队 →
 * W2 CompanionBand 消费 currentRequest 渲染 → 用户操作 → respond/cancel 按 requestId 精确出队
 * → 按 source 路由回传（pi → sendPiResponse，plugin → sendPluginResponse）。
 *
 * 契约来源：S4 slice plan IF1（DialogRequest 形状）/ IF2（队列 API）/ DM1（RequestState 分区）/
 * DM2（UiResponseTransport）/ ERR1（迟到 requestId 静默忽略）/ ERR2（重复入队 dedup）。
 * clarify Q1-Q4 修订：工厂签名加第三参数 source（注入事件源，不依赖 S2 物理存在）；
 * onUiRequestExpired 事件携带 sessionId（超时撤窗按分区路由）。
 *
 * 范式：ADR-0049 Map 分区派（useSessionScopedState 工厂）——切 session 切分区、切回恢复、
 * session 销毁经 triggerSessionCleanups 清理分区。事件 handler 用 updateFor(事件 sid) 写入
 * 「消息所属 sid」的分区（M1 竞态修复：切 sid 后旧 sid 迟到消息不污染新分区）。
 */
import { computed, onScopeDispose, reactive } from 'vue'
import type { Ref } from 'vue'
import { useSessionScopedState } from '@taiji/core/foundation/use-session-scoped-state'

// ── IF1: DialogRequest（统一内部协议，bridge → queue 的契约，ui 包本地定义） ──

export interface DialogRequestOption {
  label: string
  value: string
  description?: string
}

export interface DialogRequest {
  /** 来源打标：S2 bridge 归一 extension.ui_request → 'pi'、plugin:uiRequest → 'plugin'，queue 按此路由回传通道 */
  source: 'pi' | 'plugin'
  sessionId: string
  /** 全局唯一（pi 侧由 runtime 生成，plugin 侧由 runtime UiRequestQueue 生成，两族天然不冲突） */
  requestId: string
  method: 'confirm' | 'select' | 'input' | 'editor'
  title?: string
  message?: string
  options?: DialogRequestOption[]
  default?: string
  prefill?: string
  level?: 'info' | 'warn' | 'error'
  allowCancel?: boolean
  /** 队列接收时间戳（倒计时基准） */
  receivedAt: number
}

// ── C1: DialogRequestSource（事件源注入接口，clarify Q1/Q2 新增） ──

export interface UiTimeoutEvent {
  sessionId: string
  requestId: string
}

export interface DialogRequestSource {
  /** 订阅 ui-request 事件（S2 InternalEventBus ui-request 的适配入口）。返回退订函数 */
  onUiRequest(handler: (req: DialogRequest) => void): () => void
  /**
   * 订阅 plugin dialog 超时撤窗事件（timeout-plugin-service D2：runtime 广播
   * plugin:uiRequestExpired，插件收到 UI_TIMEOUT reject，无替答）。返回退订函数。
   * 与「按 requestId 出队、不发回传」语义一致；requestId 无匹配 pending
   * 时静默忽略（ERR1 幂等——广播无条件发出，未展示/已关闭弹窗的撤窗 miss 走这里）。
   */
  onUiRequestExpired(handler: (e: UiTimeoutEvent) => void): () => void
}

// ── DM2: UiResponseTransport（响应回传注入接口，壳提供实现，单测传 mock） ──

export interface UiResponseTransport {
  /** pi 源回传：method 必须透传（runtime 按 method 构建 pi 响应格式） */
  sendPiResponse(sessionId: string, requestId: string, method: string, result: boolean | string | null): void
  /** plugin 源回传（runtime UiRequestQueue.handleResponse 消费） */
  sendPluginResponse(requestId: string, result: unknown): void
}

// ── DM1: RequestState（per-session 队列分区状态） ──

interface RequestState {
  /** 全量 pending 队列（含当前展示的队首；pi 无串行保证，超时的不一定在队首，故存全量） */
  pending: DialogRequest[]
  /** 当前待响应的请求（队首） */
  responding: DialogRequest | undefined
}

// ── IF2: DialogRequestQueue API ──

export interface DialogRequestQueue {
  /** 当前待响应的请求（队首，只读） */
  readonly currentRequest: Readonly<Ref<DialogRequest | undefined>>
  /** 当前 session 的 pending 请求数（只读） */
  readonly pendingCount: Readonly<Ref<number>>
  /** 当前 session 是否有匹配的 pending 请求（filter 可选；非响应式查询） */
  hasRequest(filter?: (r: DialogRequest) => boolean): boolean
  /** 用户回复指定请求（按 requestId 精确定位，不假设队首；找不到静默忽略 ERR1） */
  respond(requestId: string, result: boolean | string | null): void
  /** 用户取消（等价 respond(requestId, null)） */
  cancel(requestId: string): void
}

/**
 * 工厂：创建 DialogRequestQueue。
 *
 * @param transport 响应回传实现（壳注入；单测传 mock）
 * @param sessionIdRef 当前活跃 session id（null = 无活跃 session）
 * @param source 事件源注入（壳把 InternalEventBus.on('ui-request') / WS plugin:uiRequestExpired 适配成它；
 *   W1 不依赖 S2 物理存在，单测注入 MockSource）
 */
export function createDialogRequestQueue(
  transport: UiResponseTransport,
  sessionIdRef: Ref<string | null>,
  source: DialogRequestSource,
): DialogRequestQueue {
  // per-session Map 分区（ADR-0049）：init 必须返回 reactive 容器（响应式契约，
  // 否则 pending/responding 的 mutate 不触发下游 computed 重算）。
  const state = useSessionScopedState<RequestState>(
    sessionIdRef,
    () => reactive({ pending: [] as DialogRequest[], responding: undefined as DialogRequest | undefined }),
  )

  /** 当前 session 分区（null sid 返回临时默认实例，不写 Map） */
  const current = state.current

  // ── 出队工具：按 requestId 精确移除（不假设队首）+ 刷新队首 ──
  function dequeueByRequestId(sid: string, requestId: string): void {
    state.updateFor(sid, (s) => {
      const next = s.pending.filter((r) => r.requestId !== requestId)
      if (next.length === s.pending.length) return // 无目标：静默忽略（ERR1），不触发响应性
      s.pending = next
      s.responding = next[0]
    })
  }

  // ── 入队：requestId dedup 单一入口（ERR2） ──
  function enqueue(req: DialogRequest): void {
    state.updateFor(req.sessionId, (s) => {
      const existing = s.pending.find((r) => r.requestId === req.requestId)
      if (existing) {
        // 重复投递（实时帧 + 快照拉取双源）：更新 receivedAt 为最新时间戳，不入队重复项
        existing.receivedAt = req.receivedAt
        return
      }
      s.pending.push(req)
      s.responding = s.pending[0]
    })
  }

  // ── 订阅（M1 竞态修复：handler 捕获事件 sid，updateFor 写入事件所属分区） ──
  const unsubUiRequest = source.onUiRequest(enqueue)
  // D2 超时撤窗：plugin:uiRequestExpired 到达 → 按 (sessionId, requestId) 出队，
  // 不发回传（插件侧已收 UI_TIMEOUT reject；回传会命中已删 pending 或伪装成用户应答）。
  // 无匹配 pending 时 dequeueByRequestId 内建静默忽略（ERR1，miss noop 幂等）。
  const unsubUiRequestExpired = source.onUiRequestExpired((e) => dequeueByRequestId(e.sessionId, e.requestId))

  // scope dispose 退订（防 listener 翻倍，项目规则 #2）
  onScopeDispose(() => {
    unsubUiRequest()
    unsubUiRequestExpired()
  })

  /** 当前待响应的请求（队首；null sid 时为 undefined） */
  const currentRequest = computed<DialogRequest | undefined>(() => current.value.responding)

  /** 当前 session 的 pending 请求数 */
  const pendingCount = computed<number>(() => current.value.pending.length)

  /**
   * 用户回复指定请求：按 requestId 在当前 session 分区精确定位（不假设队首），
   * 按 source 路由回传通道；找不到 → 静默忽略（ERR1：迟到响应是正常时序，
   * uiRequestExpired 已出队但用户点击残留；旧 useExtensionUI 同语义）。
   */
  function respond(requestId: string, result: boolean | string | null): void {
    const sid = sessionIdRef.value
    if (!sid) return // 无活跃 session：不操作任何分区
    const target = current.value.pending.find((r) => r.requestId === requestId)
    if (!target) return // ERR1 静默忽略（不抛错不警告，不发回传）

    if (target.source === 'pi') {
      transport.sendPiResponse(target.sessionId, target.requestId, target.method, result)
    } else {
      transport.sendPluginResponse(target.requestId, result)
    }
    dequeueByRequestId(sid, requestId)
  }

  /** 用户取消（等价 respond(requestId, null)） */
  function cancel(requestId: string): void {
    respond(requestId, null)
  }

  /** 当前 session 是否有匹配的 pending 请求（filter 可选；非响应式查询） */
  function hasRequest(filter?: (r: DialogRequest) => boolean): boolean {
    const pending = current.value.pending
    return filter ? pending.some(filter) : pending.length > 0
  }

  return {
    currentRequest,
    pendingCount,
    hasRequest,
    respond,
    cancel,
  }
}
