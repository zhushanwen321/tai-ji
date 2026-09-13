/**
 * route-inbound —— 入站消息分发器（迁移自 renderer useConnection.ts routeInbound，IF1/IF2/IF4 + DM3）。
 *
 * 对每条入站 ServerMessage：
 *   1. 若 msg.id 命中 pending → resolveEnvelope 委托 pending 层（envelope 展开，ES1）→ return（D7）
 *   2. 查 ROUTE_TABLE 精确 type 条目——条目为声明式 schema（D2，error 单条目已合并）：
 *      { sessionEffect?, globalEffect?, crossSession?, payloadGuard? }，dispatchRouted
 *      持有唯一路由序言（prologue）：
 *      - 有 sid → seqGate（subscription-state.seqGate）→ dispatchSession → crossSession?
 *        → payloadGuard 过 → sessionEffect?.()
 *      - 无 sid → dispatchGlobal → globalEffect?.() → L9 前缀 warn（session./message.）
 *   3. 未命中条目走 dispatcher 默认路径（语义 = 原 FALLBACK 恒真兜底，纯兜底零特判）：
 *      有 sid 只做 seqGate + dispatchSession；无 sid → dispatchGlobal + L9 warn。
 *      'error' 的完整生命周期收敛在单条目内：sessionEffect=onSessionError（有 sid）、
 *      globalEffect=无 sid + 无 id 的 onGlobalError 兜底（阶段 B 合并，原默认路径
 *      特判删除）
 *
 * session 隔离规则不变（CLAUDE.md line 98）：session 级消息按 sessionId 路由到 session 通道，
 * 无 sessionId 走 global 通道（config.* 及 model.list 等广播）。两通道互不串扰。
 *
 * seq gap 检测（D7 id/seq 互斥；D1 后协议归 subscription-state）：msg.seq 是 server-push
 * live 事件的序号（per-session，bus.publish 分配）。判定 + gap 簿记写入 + 基线推进收在
 * subscription-state.seqGate（状态所有者持有协议，MF-3/PR#175 时序论证在其注释内）；
 * 本模块 applySeqGap 只做 gate 调用 + reconcile 的 fire-and-forget 触发（subscribeSession
 * 持 RPC 端口）。对已 subscribe 的 session（SubscriptionState.subscribed=true）：
 *   - seq <= lastSeenSeq → 丢弃（reconcile 回放的重复或乱序）
 *   - seq > lastSeenSeq+1 → 触发 subscribeSession(sid, lastSeenSeq) reconcile（ES2 失败兜底），
 *     当前 msg 仍 dispatch（基线不在此推进，MF-3：reconcile 成功后才推进）
 *   - seq === lastSeenSeq+1 → 正常递进，dispatch + 更新 lastSeenSeq
 * 未 subscribe 的 session（state 不存在或 subscribed=false）不做 gap 检测，正常 dispatch
 * （渐进迁移，remove-bandaids wave 统一）。pending 路径（msg.id 分支）不受 seq 影响——
 * id/seq 来源互斥（D7）。
 *
 * core 零 import renderer（D3 降级后形态）：pending/events/subscribe 三件套已下沉
 * core/transport/api，生产路径由 configureRouteInbound 缺省直连真实模块（defaultPorts）；
 * TransportPorts 仅作 core 内部测试 seam（测试注入 fake，不出现在壳装配面）。
 * effect 兜底经 InboundEffects 注入（undefined 跳过）。
 */
import type { PiEntry, PiToolCallEntryForm, ServerMessage, ServerMessageMap, SubagentRecord } from '@xyz-agent/shared'
import {
  seqGate,
  subscribeSession,
  setSubscriptionPorts,
} from './subscription-state'
import * as pendingApi from '../transport/api/pending'
import * as eventsApi from '../transport/api/events'

// ── 端口契约（IF1） ────────────────────────────────────────────────

/**
 * 入站分发依赖的 WS 能力面（IF1）——D3 后为 **core 内部测试 seam**。
 *
 * 生产路径不经本接口：configureRouteInbound 缺省用 defaultPorts（真实模块直连）：
 * - pending → transport/api/pending 的 resolve/reject/rejectAll/has/resolveEnvelope
 * - events → transport/api/events 的 dispatchSession/dispatchGlobal/dispatchCrossSession
 * - subscribe → transport/api/domains/session.subscribe
 *
 * 仅 core 测试注入 fake 实现替换以上三件套（vi.mock 模块或显式传参均可）。
 * 所有字段必填（subscribe 必须提供，gap 检测副作用依赖它）。
 */
export interface TransportPorts {
  pending: {
    resolve(id: string, payload: unknown): void
    reject(id: string, error: unknown): void
    rejectAll(error: unknown): void
    /** 该 id 是否对应一个 pending 请求（区分 RPC reply 与带 id 的广播，见 routeInbound 注释）。 */
    has(id: string): boolean
    /**
     * 按 envelope 语义 settle pending 请求（收尾 6：envelope 展开下沉 pending 层，R2/ES1）。
     *
     * 接受原始 ServerMessage：id 命中 pending 时——
     * - type==='error'：展开 error envelope（code 提取 + details.detail 展开到 Error）后 reject；
     * - 其他 type：resolve msg.payload 原样。
     * id 缺失或未命中 pending（如带 nextPushId 的广播）→ no-op，绝不吞广播。
     * 实现位于 renderer api/pending（route-inbound 的 pending 分流出口）。
     */
    resolveEnvelope(msg: ServerMessage): void
  }
  events: {
    dispatchSession(sessionId: string, msg: ServerMessage): void
    dispatchGlobal(msg: ServerMessage): void
    /** 带 sid 消息的全局消费者分发（ADR-0060 crossSession 通道）。 */
    dispatchCrossSession(msg: ServerMessage): void
  }
  subscribe(
    sessionId: string,
    fromSeq?: number,
  ): Promise<{ snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number; gap?: boolean }>
}

/**
 * 路由表命中的 effect 类兜底回调集（IF2，全部可选）。
 *
 * 路由表条目在 dispatchSession/dispatchGlobal 之后调用对应回调；undefined 跳过。
 * renderer 侧（W2）把现有 useConnection 实现
 * （handleSessionExited/handleCompletion/applyRecords/triggerWorkflowReload/toast）注册进来，
 * 行为与现状一致。
 */
export interface InboundEffects {
  onSessionExited?(sessionId: string, payload: { code: number | null; reason: string }): void
  /**
   * [u8] pi 崩溃自动恢复成功（session.restored，crash-resilience D7）。
   * renderer 实现：恢复 dead 态标记 + 对话流插入恢复提示条（T4 文案）。
   * frame 经 ring 回放到达（恢复发生时 renderer 订阅已被 bus.clearSession 清除），
   * 回放路径（dispatchRouted replay）同样触发本回调——session.exited 兜底同款挂法。
   */
  onSessionRestored?(sessionId: string, payload: { sessionId: string; attempts: number }): void
  /**
   * [u8] pi 崩溃自动恢复失败（session.restoreFailed）。willRetry=false（连续 2 次熔断）时
   * renderer 把提示条切失败态（重试按钮）；willRetry=true 的中间失败仅日志，不渲染。
   */
  onSessionRestoreFailed?(
    sessionId: string,
    payload: { sessionId: string; attempts: number; willRetry: boolean; reason: string },
  ): void
  /**
   * [retry-sound] willRetry=true 表示「本次 error 是 pi auto-retry 的中间失败，turn 未结束」
   * （pi agent_end 恒发该字段，runtime event-adapter 透传）。renderer 完成提示音据此静音中间失败：
   * 只有 willRetry=false/缺省 的终态才发声/标未读。语义先例：session.restoreFailed.willRetry。
   */
  onMessageComplete?(sessionId: string, payload: { sessionId?: string; stopReason?: string; willRetry?: boolean }): void
  onSubagents?(sessionId: string, subagents: SubagentRecord[]): void
  /**
   * [E-4] subagent entry 帧兜底消费（session.subagentEntriesAppended，relay tee 产出）。
   *
   * 与 onSubagents 同定位：在所有 session（含非活跃）生效——帧先于 drawer 打开到达时
   * 也要写虚拟分区（§6.1 分区惰性创建），不能依赖 per-focus 订阅。renderer 实现经
   * subagentVirtualId(sessionId, subagentId) 构造虚拟分区 id 后调 chatStore.applySubagentEntries。
   */
  onSubagentEntries?(
    sessionId: string,
    subagentId: string,
    entries: Array<PiEntry | PiToolCallEntryForm>,
  ): void
  onWorkflowUpdate?(sessionId: string, update: ServerMessageMap['session.workflowUpdate']['update']): void
  /**
   * [idle-refresh] subagent.stream_delta 帧桥接（docs/design/timeout-streaming-ui-idle.md §5.1 D1 / §6）。
   *
   * sync subagent/workflow 编排期父 session 的 message.* 帧构造性为零（生产端
   * executeSubagent 不消费 onUpdate），子代理活跃信号走本帧旁路（relay tee / 旧
   * widget 通道，不经 chat store.applyMessageEvent）。本回调在 routeInbound 有 sid 的
   * 默认兜底路径（原 FALLBACK，现收编进 dispatchRouted）按 type 识别后调用（该 type 不在
   * ROUTE_TABLE/CROSS_SESSION_TYPES，帧与
   * payload.sessionId 在挂载点完全可见；pending 分流不拦截（旁路帧无 pending id），seq gap 与 session 通道同 gate——gap drop 帧不触发刷新，route-inbound.test.ts 锁定）。
   *
   * 实现方（renderer 装配层，useMessageEffects 范本）：解析 payload.sessionId
   * （shared resolveSubagentParentSessionId——三段式虚拟 id `subagent:<mainSessionId>:<subagentId>`
   * 提取父 sid / 旧 widget 通道主 sid 原样，双形态兼容，纯字符串函数零失败模式）
   * → 调 chatStore.refreshStreamingTimer(父sid)，防「子面板在打字、父气泡被判无进展」。
   * 非 subagent.stream_delta 类型帧不调用（type guard 在默认兜底挂载点）。
   */
  onSubagentStreamDelta?(frame: ServerMessage): void
  onGlobalError?(message: string): void
  /**
   * 带 sessionId、未命中 pending 的 error envelope 兜底（D6b，integrity-hardening §3.6）。
   *
   * 到达此处的只剩 fire-and-forget 路径的失败（请求级失败带 msg.id，已在 pending 分流
   * reject）——典型：extension.ui_response 目标 session 无进程（pi 死后残留弹窗的作答）。
   * 此前这类消息落 session 通道后被静默丢弃（无 'error' type 消费者），用户作答石沉大海；
   * 现经 effect 进消息流 error 展示。
   */
  onSessionError?(sessionId: string, payload: { code?: string; message?: string }): void
}

// ── ROUTE_TABLE（DM3，D2 阶段 A 声明式） ────────────────────────────

/**
 * 声明式路由表条目（D2 阶段 A）——条目只声明「分发之后发生什么」，路由序言
 * （seqGate → dispatchSession/crossSession → 守卫 → effect）由 dispatchRouted 统一执行，
 * 条目不再各持 handle 函数体：「type ∧ 有 sid」合取在 dispatcher 判定，条目无
 * `if (!sid) return` 防御（sessionEffect 只在有 sid 分支被消费）。
 *
 * 守卫归宿（两类语义不同，分置）：
 * - **跳过型**（payloadGuard）：坏形状 → 不调 effect、dispatchSession/crossSession 分发
 *   照常（per-session 订阅者可能自带消费逻辑）——布尔门，由 dispatcher 在分发之后、
 *   effect 之前统一执行，只门控 effect 调用、不门控分发。
 * - **整形型**（'error' 的 `typeof payload.message === 'string' ? … : 'Unknown error'`）：
 *   message 非法时**仍调** effect 传兜底值，非跳过——布尔门承载不了参数兜底，留在
 *   sessionEffect 的参数构造处，不入 payloadGuard。
 */
export interface RouteTableEntry {
  /** 有 sid 分支的 effect 回调（dispatcher 在 dispatchSession/crossSession 与 payloadGuard 之后调用）。 */
  sessionEffect?(sid: string, payload: ServerMessage['payload'], effects: InboundEffects): void
  /**
   * 无 sid 分支的 effect 回调（dispatcher 在 dispatchGlobal 之后、L9 warn 之前调用）。
   * 生产使用方：'error' 条目（无 sid + 无 id 的 onGlobalError 兜底，守卫语义内迁条目）。
   */
  globalEffect?(msg: ServerMessage, effects: InboundEffects): void
  /** 带 sid 但需同时分发到全局消费者（原 CROSS_SESSION_TYPES 白名单的声明式形态，ADR-0060 决策1）。 */
  crossSession?: boolean
  /** 跳过型守卫：返回 false → 只跳过 effect 调用，dispatchSession/crossSession 分发照常。 */
  payloadGuard?(payload: ServerMessage['payload']): boolean
}

/**
 * seq gate 调用 + reconcile 触发（IF3 副作用编排点，D1 后形态）。
 *
 * 判定、gap 簿记写入（recordGapDispatchedSeq）、基线推进（updateLastSeenSeq）全部收在
 * subscription-state.seqGate——状态所有者持有协议，MF-3 / PR #175 的时序论证见其 gap
 * 分支注释。本函数只追加 reconcile 的 fire-and-forget 触发：subscribeSession 持 RPC
 * 端口（subscribeImpl，由 configureRouteInbound 经 setSubscriptionPorts 注入），失败由
 * 其内部 console.warn 消化（ES2），基线推进时机由其 max() 收敛负责。
 *
 * @returns 是否继续 dispatch（false = drop，调用方直接 return）
 */
function applySeqGap(sid: string, msg: ServerMessage): boolean {
  const gate = seqGate(sid, msg)
  if (gate.action === 'drop') {
    return false
  }
  if (gate.reconcileFromSeq !== undefined) {
    // gap detected：回拉缺失段（fromSeq = reconcileFromSeq，排他下界覆盖全部缺失段）。
    // 当前消息仍 dispatch（gate 已返回 dispatch + 写入去重簿记）。
    void subscribeSession(sid, gate.reconcileFromSeq)
  }
  return true
}

/**
 * 路由序言的 session 半边（dispatchRouted 有 sid 分支提取，行为零改变）：
 * seqGate → dispatchSession → crossSession? → payloadGuard → sessionEffect → stream_delta 桥接。
 * 闭包变量 resolved.events / effectsCtx 改经参数注入。
 */
function dispatchSessionRouted(
  entry: RouteTableEntry | undefined,
  msg: ServerMessage,
  sid: string,
  events: TransportPorts['events'],
  effectsCtx: InboundEffects,
): void {
  if (!applySeqGap(sid, msg)) return
  events.dispatchSession(sid, msg)
  // ADR-0060：crossSession 声明条目（原白名单）在 seqGate 之后、dispatchSession 之后
  // 额外分发到全局消费者——gate drop 的重复消息 crossSession 也不发（防 ExtensionHost
  // 重复处理，与 session 通道 drop 语义一致）。
  if (entry?.crossSession) {
    events.dispatchCrossSession(msg)
  }
  // 跳过型守卫（D2 守卫两类分置）：只门控 effect 调用，不门控 dispatchSession/
  // crossSession 分发（per-session 订阅者可能自带消费逻辑）。
  if (entry?.payloadGuard && !entry.payloadGuard(msg.payload)) return
  entry?.sessionEffect?.(sid, msg.payload, effectsCtx)
  // [idle-refresh] subagent.stream_delta 桥接（§5.1 D1）：该 type 不在 ROUTE_TABLE /
  // CROSS_SESSION_TYPES（唯一关切是活跃信号，无需独立路由条目），恒走默认兜底路径
  // （原 FALLBACK）——此处按 type 识别后透传原始 frame，父 sid 解析与
  // refreshStreamingTimer 调用由 effects 实现方完成（见 InboundEffects.onSubagentStreamDelta
  // 注释）。非本 type 帧不调用（no-op）；未注册回调时跳过（生产接线前行为与现状一致）。
  if (msg.type === 'subagent.stream_delta') {
    effectsCtx.onSubagentStreamDelta?.(msg)
  }
}

/**
 * 路由序言的 global 半边（dispatchRouted 无 sid 分支提取，行为零改变）：
 * dispatchGlobal → globalEffect? → L9 前缀 warn。默认路径为纯兜底（阶段 B 后
 * 零 type 特判）：'error' 的无 sid 兜底已并入条目 globalEffect（含 !msg.id 守卫），
 * 未命中条目的消息只做通道分发 + L9 warn。
 */
function dispatchGlobalRouted(
  entry: RouteTableEntry | undefined,
  msg: ServerMessage,
  events: TransportPorts['events'],
  effectsCtx: InboundEffects,
): void {
  events.dispatchGlobal(msg)
  entry?.globalEffect?.(msg, effectsCtx)
  // L9：session 级消息（type 以 session./message. 开头）缺失 sessionId 时 warn，
  // 让 runtime bug 可见（违反隔离要求应有 fail-fast 信号，而非静默降级到 global 丢弃）
  if (msg.type.startsWith('session.') || msg.type.startsWith('message.')) {
    console.warn('[core/coordination] session-level message missing sessionId, routed to global:', msg.type)
  }
}

/**
 * ROUTE_TABLE —— 精确 type 匹配的声明式条目表（DM3，TC1；Q1-4：Record 直查 O(1)）。
 *
 * type 即 Record key（type 互斥，精确匹配同一消息只命中一条）。查表必须经
 * hasOwnProperty.call 判定自有键（见 dispatchRouted 内 [Q1-4] 注释）。
 *
 * 收编 effect 类 type（session.exited / message.complete / session.subagents /
 * session.workflowUpdate / error-with-sid）：
 * remote-use 的 busy/idle/presence/deleting/deleted 分支未迁入（feat-remote-use 未合并），
 * 由 connection-lifecycle slice 承接（届时作为新条目追加，不修改路由核心）。
 *
 * crossSession-only 骨架条目（原 CROSS_SESSION_TYPES 白名单 8 type）：这些 type 虽带
 * sessionId（走 session 通道），但 ExtensionHost 是全局单例消费者（ViewHostStore 按
 * per-session Map 分区，需收所有 session 的下行，不随 session 切换退订），故 dispatcher
 * 在 dispatchSession 后额外 dispatchCrossSession。声明式形态下无需 effect 回调，
 * 只含 crossSession 字段的骨架条目即可表达（原「不进 ROUTE_TABLE……硬塞会产出雷同
 * handle 函数」的表达力缺陷由此消除）。
 *
 * type 分隔符与 runtime wire 实际格式一致（shared/protocol.ts ServerMessageType）：
 * extension:widget/widgetGui/status/notify 用冒号；extension.ui_request 用**点号**
 * （runtime event-adapter.ts 实发 'extension.ui_request'，ADR-0060 文档里的冒号为笔误，
 * 以 protocol.ts + MessageBusBridge EXTENSION_HANDLERS 为准）。
 *
 * 导出面说明：导出供 route-inbound.test.ts 注册探针条目（payloadGuard「不门控分发」
 * 契约的接口级验证——生产 payloadGuard 条目均无 crossSession 声明，需注入探针才可
 * 组合验证）与声明形状锁定；生产消费方只读，不 mutate（与 subscription-state 的
 * resetSubscriptionStates 同类测试支撑导出）。globalEffect 自阶段 B 起有生产条目
 *（'error'），其行为直接经 dispatcher 断言，无需注入。
 */
export const ROUTE_TABLE: Record<string, RouteTableEntry> = {
  'session.exited': {
    // session.exited 兜底：进程退出必须标记 dead + toast，不能只依赖惰性的 session
    // 通道订阅（首次 send 前可能无订阅者 → dispatchSession no-op → 错误丢弃）。
    sessionEffect(sid, payload, effects) {
      effects.onSessionExited?.(sid, payload as { code: number | null; reason: string })
    },
  },
  // [u8] pi 崩溃自动恢复结果（crash-resilience D7）：与 session.exited 同款兜底挂法——
  // 恢复发生时 renderer 订阅已被 bus.clearSession 清除，帧主要经 ring 回放到达
  //（dispatchRouted replay 共享 ROUTE_TABLE effects），必须有条目才能触发 effect。
  'session.restored': {
    // payload 锚定 protocol SSOT（runtime 改形状时此处编译报错，session.workflowUpdate 同款）。
    sessionEffect(sid, payload, effects) {
      effects.onSessionRestored?.(sid, payload as ServerMessageMap['session.restored'])
    },
  },
  'session.restoreFailed': {
    sessionEffect(sid, payload, effects) {
      effects.onSessionRestoreFailed?.(sid, payload as ServerMessageMap['session.restoreFailed'])
    },
  },
  'message.complete': {
    // message.complete 兜底：后台完成时提示音 + 未读标记（renderer 注册回调内实现）。
    // payload 整体透传（含 [retry-sound] willRetry——中间失败静音判据，见 InboundEffects 注释）。
    sessionEffect(sid, payload, effects) {
      effects.onMessageComplete?.(sid, payload as { sessionId?: string; stopReason?: string; willRetry?: boolean })
    },
  },
  'session.subagents': {
    // session.subagents 兜底：subagent 终态推送必须在所有 session 生效（含非活跃），
    // 不能只依赖 per-focus 订阅（切走即退订 → 终态丢弃 → 侧栏卡 running）。
    // 跳过型守卫（D2）：subagents 非数组 → 跳过 effect、dispatch 照常。
    payloadGuard: (payload) => Array.isArray((payload as { subagents?: unknown }).subagents),
    sessionEffect(sid, payload, effects) {
      effects.onSubagents?.(sid, (payload as { subagents: SubagentRecord[] }).subagents)
    },
  },
  'session.subagentEntriesAppended': {
    // [E-4] subagent entry 帧兜底：写 chatStore 虚拟分区必须在所有 session 生效
    //（帧先于 drawer 打开——分区惰性创建不依赖订阅，§6.1）。跳过型守卫对齐
    // session.subagents 条目（subagentId 非空 + entries 数组，坏形状跳过 effect 但
    // dispatch 照常——per-session 订阅者可能自带消费逻辑）。
    payloadGuard: (payload) => {
      const p = payload as { subagentId?: unknown; entries?: unknown }
      return typeof p.subagentId === 'string' && p.subagentId !== '' && Array.isArray(p.entries)
    },
    sessionEffect(sid, payload, effects) {
      const p = payload as { subagentId: string; entries: Array<PiEntry | PiToolCallEntryForm> }
      effects.onSubagentEntries?.(sid, p.subagentId, p.entries)
    },
  },
  'session.workflowUpdate': {
    // session.workflowUpdate 兜底：workflow 增量信号触发 loadWorkflows + running 延迟重试，
    // 同样在所有 session（含非活跃）生效，不依赖 per-focus 订阅。
    // payload 锚定 protocol SSOT（ServerMessageMap['session.workflowUpdate']，MF-4）：
    // update.status/runId 必填，runtime 改形状时此处编译报错，不再静默收 undefined。
    sessionEffect(sid, payload, effects) {
      effects.onWorkflowUpdate?.(sid, (payload as ServerMessageMap['session.workflowUpdate']).update)
    },
  },
  'error': {
    // D6b：带 sid 的 error envelope 兜底（见 InboundEffects.onSessionError 注释）。
    // 整形型守卫留 sessionEffect 参数构造处（D2 守卫两类分置）：payload.message 缺失时
    // 兜底通用文案，防御运行时坏形状。error envelope 无 seq（broker.send 直发，非
    // bus.publish live 帧）→ seqGate 无 seq 分支正常放行，不触发 gap reconcile。
    sessionEffect(sid, payload, effects) {
      const p = payload as { code?: string; message?: string }
      effects.onSessionError?.(sid, {
        code: p.code,
        message: typeof p.message === 'string' ? p.message : 'Unknown error',
      })
    },
    // 无 sid 兜底（阶段 B 自 dispatcher 默认路径特判 `msg.type === 'error' && !msg.id`
    // 逐字迁入）：!msg.id 守卫保留——带 id 的 error 若未命中 pending（如 reply 超时后
    // 迟到），只 dispatchGlobal 不 toast；无 id 的 server-push 全局 error（如 config
    // 加载失败）才 toast（renderer 注册 onGlobalError 实现 toast）。
    globalEffect(msg, effects) {
      if (msg.id) return
      const p = msg.payload as { message?: string }
      effects.onGlobalError?.(typeof p.message === 'string' ? p.message : 'Unknown error')
    },
  },

  // ── crossSession-only 骨架条目（原 CROSS_SESSION_TYPES 白名单 8 type，ADR-0060 决策1）──
  'extension:widget': { crossSession: true },
  'extension:widgetGui': { crossSession: true },
  'extension:status': { crossSession: true },
  'extension:notify': { crossSession: true },
  'extension.ui_request': { crossSession: true }, // 点号：runtime wire 实际格式（见 ROUTE_TABLE 注释）
  // 带 sid 的 ui 超时广播：DialogRequestQueue onUiTimeout 经 crossSession 通道订阅（MF-6）
  'extension.ui_timeout': { crossSession: true },
  // plugin:* 带 sid 下行（runtime 广播注入 sessionId）：ExtensionHost 全局单例消费者需同时收
  // session 通道 + crossSession 通道（ViewHostStore / DialogRequestQueue 按 per-session 分区）
  'plugin:uiRequest': { crossSession: true },
  'plugin:viewUpdate': { crossSession: true },
}

// ── configureRouteInbound（IF4） ───────────────────────────────────

/**
 * 生产默认端口（D3）：直连 core transport/api 真实模块（模块级单例，与 request 层 /
 * renderer 壳桥解析到同一实例）。configureRouteInbound 不传 ports 时使用。
 *
 * subscribe 经动态 import 惰性解析：顶层静态值使用 domains/session 会把
 * session→request→ws-client 链拉进本模块静态图，破坏外部测试（renderer api 层
 * mock send 的 8 文件 39 用例，清单见下方 [HISTORICAL]）对 ws-client 的 vi.mock 拦截——u4 实证无论 mock 说明符
 * 用 package 子路径还是跨包相对路径均失效；pending/events 无 ws-client 下游链，
 * 静态值使用无害。subscribe 是低频 RPC 路径（首次订阅 + gap reconcile），模块
 * 缓存后动态 import 零成本。
 *
 * [HISTORICAL] D9 曾按设计尝试回直静态 import 并回退：即便 use-connection 测试
 * 已改经 dispatcher 注入（不再依赖 mock 拦截 defaultPorts），P5 探针（renderer
 * 全量测试）仍红 8 文件 39 用例——renderer api 层测试 mock 的 send 经
 * core/transport/api（barrel 静态图）解析，与本模块静态拉入的 ws-client 实例
 * 分属两个模块身份，mock 拦截不到（api/composer-domain、preset-domain、
 * quota-domain、session-removebycwd、t4-api-layer、usage-forcequit-domains、
 * extension-upgrade、new-task/session-api）。renderer mock 链收口前，动态
 * import 是静态依赖图与测试面的唯一兼容形态（设计 D9 附带降级路径）。
 */
const defaultPorts: TransportPorts = {
  pending: pendingApi,
  events: eventsApi,
  subscribe: (sessionId, fromSeq) =>
    import('../transport/api/domains/session').then((m) => m.subscribe(sessionId, fromSeq)),
}

/**
 * 构造并返回入站 dispatcher（IF4）。
 *
 * ports 缺省 = 真实模块直连（生产路径，D3）；显式传入仅供 core 测试替换三件套。
 * 可选 effects（TC2/TC3）：
 * - setSubscriptionPorts 注入 subscribe RPC + replay 回放 dispatcher（C1，PR #175 review R1）
 * - 幂等由调用方 ensureDispatcher 保证（use-connection 侧只安装一次）
 *
 * 处理顺序（live dispatcher）：
 *   1. msg.id 命中 pending → resolveEnvelope 委托 pending 层（error envelope 展开 code+details
 *      到 Error，收尾 6 R2/ES1），return 不再进路由表（id/seq 来源互斥 D7）
 *   2. dispatchRouted 唯一序言消费 ROUTE_TABLE 声明式条目：有 sid → seqGate →
 *      dispatchSession → crossSession? → payloadGuard 过 → sessionEffect?.()；无 sid →
 *      dispatchGlobal → globalEffect?.() → L9 warn
 *   3. 未命中条目走同一序言的默认行为（语义 = 原 FALLBACK 恒真兜底，纯兜底零特判）：
 *      有 sid 只做 seqGate + dispatchSession；无 sid → dispatchGlobal + L9 warn
 *
 * 步骤 2+3 抽成共享核心 dispatchRouted——subscription-state 的 snapshot/stateSnapshot
 * 回放经注入的 replay 走同一条路径（sid 固定为 subscribe 目标，跳过步骤 1 的 pending
 * 分流：回放消息来自 bus ring 广播而非 RPC reply），使回放与 live 共享 seq 去重 +
 * effects + crossSession 语义。此前回放裸调 events.dispatchSession 绕过全部三样，导致
 * gap 触发消息重复实体 + 回放帧不触发 subagent 终态兜底（PR #175 review R1 MUST_FIX）。
 *
 * @param ports 可选 WS 能力注入（缺省 = 真实模块；测试 seam）
 * @param effects 可选 effect 回调集（undefined 跳过）
 * @returns 入站消息 dispatcher：dispatcher(msg: ServerMessage)
 */
export function configureRouteInbound(
  ports?: TransportPorts,
  effects?: InboundEffects,
): (msg: ServerMessage) => void {
  const resolved: TransportPorts = ports ?? defaultPorts
  const effectsCtx: InboundEffects = effects ?? {}

  // 共享路由核心（步骤 2+3）：live 与回放同一条路径，行为差异只在 sid 来源与 pending 分流。
  // D2：dispatchRouted 是唯一路由序言，条目只声明副作用（error 单条目阶段 B 已合并）——
  //   有 sid → seqGate → dispatchSession → crossSession? → payloadGuard 过 → sessionEffect?.()
  //   无 sid → dispatchGlobal → globalEffect?.() → L9 前缀 warn（默认路径纯兜底，零特判）
  function dispatchRouted(msg: ServerMessage, sid: string | undefined): void {
    // [Q1-4] Record 直查（O(1)）。hasOwnProperty.call 守卫原型成员名（'constructor' 等），
    // 语义与旧数组 .find 严格等价（只匹配自有 type 键）。不用 Object.hasOwn：renderer
    // vue-tsc 的 lib 不含 ES2022（TS2550）。「type ∧ 有 sid」合取在此判定——条目查表
    // 与 sid 分支持有，条目声明无需各自 `if (!sid) return` 防御。
    const entry = Object.prototype.hasOwnProperty.call(ROUTE_TABLE, msg.type)
      ? ROUTE_TABLE[msg.type]
      : undefined

    if (typeof sid === 'string' && sid) {
      dispatchSessionRouted(entry, msg, sid, resolved.events, effectsCtx)
      return
    }
    dispatchGlobalRouted(entry, msg, resolved.events, effectsCtx)
  }

  // 回放 dispatcher：subscription-state 的 subscribeSession 回放入口（C1 注入）。
  // 与 live dispatcher 的差异仅两点（见上方注释），其余（seq gap 去重 + ROUTE_TABLE
  // effects + crossSession 分发）完全共享。
  setSubscriptionPorts({
    subscribe: resolved.subscribe,
    replay: (sid, msg) => dispatchRouted(msg, sid),
  })

  return function routeInbound(msg: ServerMessage): void {
    // ── 1. pending 分流（D7：id/seq 互斥，命中 pending 的 RPC reply 不进路由表） ──
    // [HISTORICAL] 必须用 ports.pending.has(msg.id) 收紧判定，不能只看 msg.id 是否存在：
    // runtime 的 broadcast（config.skills/agents/providers/dirs/defaults 等）也携带 nextPushId
    // 作为 id（message-broker.buildXxxMsg 给所有广播加 `id: nextPushId()`）。若只凭 msg.id
    // 存在就判为 reply，广播会被 pending 分流吞掉（pendingMap 无 push_* 条目 → resolve/reject
    // 静默 no-op），消息不进 ROUTE_TABLE/FALLBACK → dispatchGlobal 永不调用 → 靠广播推送的
    // settingsStore.skills/agents（无 refresh RPC 兜底，区别于有 refresh 的 providers/models）
    // 永空。2026-08 审查报告 R5 问题 9 根因。
    if (msg.id && resolved.pending.has(msg.id)) {
      // envelope 展开（code 提取 + details.detail → Error）委托 pending 层（收尾 6，R2/ES1），
      // 实现见 transport/api/pending.ts resolveEnvelope。行为与内联版零差异。
      resolved.pending.resolveEnvelope(msg)
      return // D7：pending 分流后不再进路由表
    }

    // payload 跨多种 type：有的含 sessionId（session 通道），有的不含（global 通道）。
    // 联合类型无法直接 .sessionId，窄断言为可选字段做路由判定（隔离规则不变）。
    const sid = (msg.payload as { sessionId?: string }).sessionId
    dispatchRouted(msg, sid)
  }
}
