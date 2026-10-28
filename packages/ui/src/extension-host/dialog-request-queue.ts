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
import { computed, onScopeDispose, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import {
  registerSessionCleanup,
  useSessionScopedState,
} from '@taiji/core/foundation/use-session-scoped-state'

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
  /**
   * pi 源回传：method 必须透传（runtime 按 method 构建 pi 响应格式）。
   * 返回 boolean（false = WS 非 OPEN 未送出）——respond 据此保留请求供连接恢复后重发
   * （M1/RD-3#1：重发同 requestId 幂等，runtime/pi 两侧 pending miss 均静默忽略）。
   */
  sendPiResponse(sessionId: string, requestId: string, method: string, result: boolean | string | null): boolean
  /** plugin 源回传（runtime UiRequestQueue.handleResponse 消费）。返回语义同 sendPiResponse。 */
  sendPluginResponse(requestId: string, result: unknown): boolean
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
  /**
   * 跨分区 pending 计数（remote-use-mobile-v2 §6.18 待办聚合半：「需要你处理」区与导航
   * 计数要聚合全部会话的 dialog 待答，而 currentRequest/pendingCount 只读当前活跃分区）。
   * 键 = 有非空 pending 队列的会话 id，值 = 该分区 pending 条数；不可变替换触发响应式。
   * 计数登记与分区写点同函数同步维护（enqueue/dequeueByRequestId/resetFor/session 销毁
   * 清理四点封闭），请求内容权威仍在分区——本读口只承载计数，不做内容镜像（禁双轨副本）。
   *
   * 模式取舍（对照 form 通道 mobileFormPendingCounts 的 computed 派生）：本队列分区由
   * useSessionScopedState 工厂承载，工厂分区表是 plain Map 且不提供分区遍历入口，跨分区
   * computed 建立不了依赖，计数只能由登记表手工维护；form 通道载体是模块级 reactive Map
   * （companion-bridge formRequestsBySid），computed 迭代即可派生。两轨差异源于分区载体
   * 的响应性，不是可归并的重复实现。
   */
  readonly pendingCountBySession: Readonly<Ref<ReadonlyMap<string, number>>>
  /** 当前 session 是否有匹配的 pending 请求（filter 可选；非响应式查询） */
  hasRequest(filter?: (r: DialogRequest) => boolean): boolean
  /** 用户回复指定请求（按 requestId 精确定位，不假设队首；找不到静默忽略 ERR1） */
  respond(requestId: string, result: boolean | string | null): void
  /** 用户取消（等价 respond(requestId, null)） */
  cancel(requestId: string): void
  /**
   * 清空指定 session 分区内容（pending/responding 写入空态；remote-use D5/U6 exited 分通道重置）。
   *
   * 重置语义非销毁：不进 deletedSids，重置后同 sid 新请求照常入队（exited ≠ 删除——会话
   * 崩溃后继续存在并恢复，恢复期新请求合法，V18 负面变体）；销毁语义（cleanup → 迟到写
   * 拦截）留给删除路径 triggerSessionCleanups，两者不得混用。
   *
   * 前置分区存在性检查：分区不存在则 no-op 不建分区——updateFor 经 getOrCreatePartition
   * 惰性建分区，照搬会让清理动作本身制造常驻空分区（无清理路径，与 S7 内存有界相悖）。
   */
  resetFor(sessionId: string): void
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

  // 跨分区 pending 计数登记（pendingCountBySession 的承载；与分区写点同函数同步维护，
  // 漂移面封闭于本文件四个写点——见接口成员注释）。不可变替换触发响应式。
  const pendingCountBySid = ref(new Map<string, number>())

  function shiftPendingCount(sid: string, delta: number): void {
    const next = new Map(pendingCountBySid.value)
    const count = (next.get(sid) ?? 0) + delta
    if (count <= 0) next.delete(sid)
    else next.set(sid, count)
    pendingCountBySid.value = next
  }

  // 第四写点（session 删除路径）：分区由 useSessionScopedState 自动注册的 cleanup 删除
  // （triggerSessionCleanups 驱动），计数登记表是分区外辅助表，须同口径挂清理——否则
  // 删除后 resetFor 被 hasPartition 早退、dequeueByRequestId 被 deletedSids 拦截，残留计数
  // 永久无法清除（「需要你处理」区与导航计数聚合到已删会话的僵尸待办）。模块级单例无
  // scope 时条目保留（与 useSessionScopedState 自身注册同语义）。
  const unregisterCountCleanup = registerSessionCleanup((sid) => {
    const count = pendingCountBySid.value.get(sid)
    if (count) shiftPendingCount(sid, -count)
  })

  // ── 出队工具：按 requestId 精确移除（不假设队首）+ 刷新队首 ──
  function dequeueByRequestId(sid: string, requestId: string): void {
    state.updateFor(sid, (s) => {
      const next = s.pending.filter((r) => r.requestId !== requestId)
      if (next.length === s.pending.length) return // 无目标：静默忽略（ERR1），不触发响应性
      const removed = s.pending.length - next.length
      s.pending = next
      s.responding = next[0]
      // 计数登记与分区同步递减（实际移除才调——ERR1 早退分支不触）
      shiftPendingCount(sid, -removed)
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
      // 计数登记与分区同步递增（dedup 早退分支不触——重复投递不加计）
      shiftPendingCount(req.sessionId, 1)
    })
  }

  // ── 订阅（M1 竞态修复：handler 捕获事件 sid，updateFor 写入事件所属分区） ──
  const unsubUiRequest = source.onUiRequest(enqueue)
  // D2 超时撤窗：plugin:uiRequestExpired 到达 → 按 (sessionId, requestId) 出队，
  // 不发回传（插件侧已收 UI_TIMEOUT reject；回传会命中已删 pending 或伪装成用户应答）。
  // 无匹配 pending 时 dequeueByRequestId 内建静默忽略（ERR1，miss noop 幂等）。
  const unsubUiRequestExpired = source.onUiRequestExpired((e) => dequeueByRequestId(e.sessionId, e.requestId))

  // scope dispose 退订（防 listener 翻倍，项目规则 #2）；计数清理注册同点反注册
  // （无 scope 上下文时 onScopeDispose 落空、条目保留，与 useSessionScopedState 同语义）
  onScopeDispose(() => {
    unsubUiRequest()
    unsubUiRequestExpired()
    unregisterCountCleanup()
  })

  /** 当前待响应的请求（队首；null sid 时为 undefined） */
  const currentRequest = computed<DialogRequest | undefined>(() => current.value.responding)

  /** 跨分区 pending 计数读口（登记 ref 的只读视图；登记是不可变替换，直返无需复制） */
  const pendingCountBySession = computed(() => pendingCountBySid.value)

  /** 当前 session 的 pending 请求数 */
  const pendingCount = computed<number>(() => current.value.pending.length)

  /**
   * 用户回复指定请求：按 requestId 在当前 session 分区精确定位（不假设队首），
   * 按 source 路由回传通道；找不到 → 静默忽略（ERR1：迟到响应是正常时序，
   * uiRequestExpired 已出队但用户点击残留；旧 useExtensionUI 同语义）。
   *
   * 回传未送达（transport 返 false）→ 保留请求不出队（M1/RD-3#1）：断连期用户应答
   * 丢失且弹窗消失 = pi 侧 Promise 永挂；保留后连接恢复可再次 respond 重投（同
   * requestId 幂等）。未送达的提示由壳层 transport 实现负责（本队列 headless 无 UI）。
   */
  function respond(requestId: string, result: boolean | string | null): void {
    const sid = sessionIdRef.value
    if (!sid) return // 无活跃 session：不操作任何分区
    const target = current.value.pending.find((r) => r.requestId === requestId)
    if (!target) return // ERR1 静默忽略（不抛错不警告，不发回传）

    const delivered = target.source === 'pi'
      ? transport.sendPiResponse(target.sessionId, target.requestId, target.method, result)
      : transport.sendPluginResponse(target.requestId, result)
    if (!delivered) return // 保留请求（pending/responding 不动），供连接恢复后重发
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

  /**
   * exited 分通道重置（remote-use D5/U6）：先查后清——hasPartition 前置检查，分区不存在
   * 则整体跳过（不建分区）；存在则经 updateFor 写入空态（不进 deletedSids，重置语义）。
   */
  function resetFor(sessionId: string): void {
    if (!state.hasPartition(sessionId)) return
    state.updateFor(sessionId, (s) => {
      // 计数登记随重置归零（分区写点同函数同步；清空后才写，用旧长度计 delta）
      if (s.pending.length > 0) shiftPendingCount(sessionId, -s.pending.length)
      s.pending = []
      s.responding = undefined
    })
  }

  return {
    currentRequest,
    pendingCount,
    pendingCountBySession,
    hasRequest,
    respond,
    cancel,
    resetFor,
  }
}
