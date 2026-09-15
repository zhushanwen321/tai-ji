/**
 * subscription-state —— MessageBus 订阅状态管理（迁移自 renderer useMessageBusSubscription.ts，IF5）。
 *
 * 职责（DM2 + IF5 + ES2）：
 * - 维护 per-session 的 SubscriptionState（lastSeenSeq + subscribed 标记 + gap 簿记）
 * - seq 协议 SSOT（D1 归位，原 seq-gap.ts + route-inbound.applySeqGap 副作用段收编）：
 *   evalSeqGap 六分支判定（纯函数）+ seqGate（判定 + gap 簿记写入 + 基线推进一体）。
 *   route-inbound 的 applySeqGap 只剩 gate 调用 + reconcile fire-and-forget 触发
 *  （subscribeSession 持 RPC 端口）——MF-3 / PR #175 的交互层配对自此只读本模块
 * - subscribeSession：调 subscribe RPC（经注入端口 ports.subscribe）→ 把返回的 snapshot +
 *   stateSnapshot 依次经注入的 replay dispatcher 回放（routeInbound 共享语义：seq 去重 +
 *   ROUTE_TABLE effects + crossSession 分发，PR #175 review R1）→ 记 lastSeenSeq → 标记
 *   subscribed
 * - getSubscriptionState：routeInbound 用此判是否启用 gap 检测
 * - clearSubscription：session 销毁时清理（useChat.disposeSession 调用）
 * - updateLastSeenSeq：live push 收到合法递进 seq 时更新基线
 * - resubscribeAll：WS 重连后恢复全部订阅（M1/W09 follow-up，use-connection 在 connected
 *   false→true 迁移时调——runtime 侧 onDisconnect 已清空订阅，core 侧幂等守卫需外部触发重建）
 *
 * 为什么用模块级单例 Map 而非 useSessionScopedState（ADR-0049 例外）：
 * - routeInbound 在配置闭包需同步访问（不能依赖组件/实例生命周期）
 * - 这是 WS 订阅状态（数据完整性层），非 per-instance UI 状态——UI 经 events 通道消费消息，
 *   不直接读 lastSeenSeq（lastSeenSeq 变化不触发 UI 更新，无副作用）
 * - 参照 renderer useChat.streamSubscriptions 的模块级 Map 模式（会话级长订阅去重）
 * - 迁移约束：行为等价原实现（slice TO3），不套 useSessionScopedState 是原实现的既定设计
 *
 * 渐进迁移（T2）：gap 检测只对「已 subscribe（state 存在且 subscribed=true）」的 session 生效。
 * 未 subscribe 的 session（useChat.ensureStreamSubscription 旧路径未走 subscribeSession）不做
 * gap 检测，正常 dispatch。统一在 remove-bandaids wave 完成。
 *
 * 依赖方向：subscription-state → 注入端口（subscribe RPC + replay 回放 dispatcher，
 * 均由 configureRouteInbound 注入）。不依赖任何 store / renderer 模块。
 */
import type { ServerMessage } from '@taiji/shared'
import type * as sessionDomain from '../transport/api/domains/session'
import { createInflightDedup } from '../foundation/create-inflight-dedup'

/**
 * per-session 订阅状态。
 *
 * - lastSeenSeq：最后处理的 server-push seq（gap 检测基线）。0 表示无历史（首次订阅空 snapshot）。
 * - subscribed：是否已完成 subscribe RPC + snapshot 回放。true 后 routeInbound 启用 gap 检测。
 *   false 或 state 不存在 → 兼容路径（不 gap 检测，正常 dispatch）。
 */
export interface SubscriptionState {
  lastSeenSeq: number
  subscribed: boolean
  /**
   * gap 触发消息的已 dispatch 簿记（PR #175 review R1 MUST_FIX，MF-3 配套）。
   *
   * seqGate gap 分支 dispatch 了触发消息（seq > lastSeenSeq+1）但基线不推进（MF-3：
   * 提前推进会让 reconcile RPC 失败后缺失段永久不可恢复）。而 reconcile 的 subscribe
   * fromSeq 是排他下界，返回 snapshot 必含触发消息本身 → 回放经 routeInbound 时靠本
   * 集合 drop 已 dispatch 的 seq（seq <= lastSeenSeq 的常规去重覆盖不到超前于基线的它）。
   *
   * 生命周期：seqGate 写入；基线推进（updateLastSeenSeq / subscribeSession 收敛）时
   * 清理 <= 基线的条目（已被常规去重覆盖，无独立价值）；未发生 gap 时恒 undefined。
   */
  gapDispatchedSeqs?: Set<number>
}

/**
 * 模块级单例订阅状态表（sessionId → SubscriptionState）。
 *
 * 跨 routeInbound / subscribeSession 共享同一份（routeInbound 读 + 更新，subscribeSession 写，
 * 消费方 disposeSession 删）。与 renderer useChat.streamSubscriptions 同范式（会话级状态在模块顶层）。
 */
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：模块级单例订阅状态表（ADR-0049 全局 sid 协调器，上方注释已述与 useChat 同范式）
const subscriptionStates = new Map<string, SubscriptionState>()

/**
 * in-flight 订阅去重表（key → 进行中的 subscribeSession Promise）。
 *
 * MF-2：幂等守卫（subscribed 标记）与状态写入非原子——两个并发 initial subscribe
 * （fromSeq 均 undefined）会在第一个 await resolve 前双双通过守卫，导致重复 RPC +
 * 重复 snapshot 回放。本表把并发调用收敛到同一 Promise。
 *
 * key 必须含 fromSeq：gap backfill（fromSeq 显式）与 initial subscribe（fromSeq undefined）
 * 语义不同，不得互吞；同参并发（重复相同 backfill）则复用同一 Promise。
 *
 * 「Map + Promise 复用」生命周期（同 key 复用 / settle 即清失败可重试不残留死 Promise /
 * 引用比对防误删并发后到的新条目）收编于 createInflightDedup（D9 共享原语，
 * state-truth-sync §3.3）；本模块只负责 key 语义（subscribeKey）与订阅意图写入。
 */
// taste:allow-no-data-owner W24-EX-A（ADR-0049 全局 sid 协调器/订阅注册基建，登记草稿）：in-flight 订阅去重表（并发收敛到同一 Promise，非 GUI 数据）
const subscribeDedup = createInflightDedup<void>()

function subscribeKey(sessionId: string, fromSeq?: number): string {
  return fromSeq === undefined ? sessionId : `${sessionId}:${fromSeq}`
}

// ── 端口注入（C1：内部注入点，非公共 API） ─────────────────────────

/**
 * subscribe RPC 签名类型（D3 连带①）：直引 core transport/api/domains/session 的
 * subscribe（不再从 TransportPorts 派生——后者已降级为 route-inbound 的内部测试 seam）。
 */
export type SubscribeRpc = typeof sessionDomain.subscribe

/**
 * route-inbound 侧需要的最小端口面（subscribe RPC + 回放 dispatcher）。
 *
 * replay 是回放消息的完整分发入口（PR #175 review R1 MUST_FIX）：由 configureRouteInbound
 * 注入，实现 = routeInbound 的共享路由核心（seq gap 去重 + ROUTE_TABLE effects +
 * crossSession 分发），sid 固定为 subscribe 目标 session。回放与 live 共享同一语义，
 * 不再裸调 events.dispatchSession（那会绕过去重与全部 effect 兜底）。
 */
export type SubscriptionPorts = {
  subscribe: SubscribeRpc
  /** 回放分发：snapshot/stateSnapshot 内消息经此进入与 live 相同的路由管线。 */
  replay(sessionId: string, msg: ServerMessage): void
}

/**
 * 注入 subscribe RPC 与回放分发实现（内部注入点，非公共订阅 API）。
 *
 * 由 route-inbound.ts 的 configureRouteInbound 调用（TC2/TC3 一次性注入）：
 * subscribeSession 内部经 subscribeImpl 发 RPC、经 replayImpl 回放 snapshot/stateSnapshot
 * （回放走 routeInbound 语义：seq 去重 + effects + crossSession）。
 * 测试（F9）用本函数注入 spy。
 *
 * 未注入时 subscribeSession 调用会 console.warn 并 return（防御性，与 ES2 一致，不抛不挂起）。
 */
let subscribeImpl: SubscribeRpc | undefined
let replayImpl: SubscriptionPorts['replay'] | undefined

export function setSubscriptionPorts(ports: SubscriptionPorts): void {
  subscribeImpl = ports.subscribe
  replayImpl = ports.replay
}

/**
 * 记录 gap 触发消息的已 dispatch 簿记（seqGate gap 分支调用，见 SubscriptionState 注释）。
 * state 不存在时 no-op（gap 分支前提是 subscribed=true，state 必存在，防御兜底）。
 * 模块内私有（唯一调用点 = 同模块 seqGate）。
 */
function recordGapDispatchedSeq(sessionId: string, seq: number): void {
  const state = subscriptionStates.get(sessionId)
  if (!state) return
  ;(state.gapDispatchedSeqs ??= new Set<number>()).add(seq)
}

// ── seq 协议（D1 归位：判定 + 簿记 + 基线推进同处状态所有者，原三文件收编） ──

/**
 * seq-gap —— server-push 消息序号缺口检测（判定纯函数，原独立模块 seq-gap.ts 逐字内嵌）。
 *
 * 现状逻辑（main 基线）：
 *   - state 不存在或 subscribed=false → 不做 gap 检测，正常 dispatch（渐进迁移兼容路径）
 *   - seq <= lastSeenSeq → 丢弃（reconcile 回放的重复或乱序）
 *   - seq > lastSeenSeq+1 → 触发 subscribeSession(sid, lastSeenSeq) reconcile，当前消息仍 dispatch
 *   - seq === lastSeenSeq+1 → 正常递进，dispatch
 *
 * gap 触发消息去重（PR #175 review R1）：gap 分支 dispatch 了触发消息但基线不推进（MF-3），
 * 而 reconcile 的 subscribe(fromSeq=排他下界) 返回的 snapshot 必含触发消息本身 → 回放时
 * 该 seq 既不满足 seq<=lastSeenSeq（超前于基线）也不是正常递进（缺失段回放会先把基线
 * 推到 seq-1，触发消息恰好变成「递进」再次 dispatch）。靠 SubscriptionState.gapDispatchedSeqs
 * 簿记（seqGate gap 分支写入）识别「已 dispatch 但基线未覆盖」的 seq，drop 之。
 *
 * evalSeqGap 保持纯函数（零副作用、零 import 业务层）；副作用（gap 簿记写入 / 基线推进）
 * 由同模块的 seqGate 执行，reconcile 触发（fire-and-forget subscribeSession）由
 * route-inbound.ts 依据 gate 返回值执行（它持有 RPC 依赖）。
 */
/**
 * seq gap 判定结果（DM1 判别联合，穷举 3 种状态杜绝无效组合）：
 * - drop：丢弃，不 dispatch 不更新基线（reconcile 回放的重复/乱序）
 * - pass 无 reconcileFromSeq：正常递进（dispatch + 更新基线）
 * - pass 带 reconcileFromSeq：gap（dispatch 当前消息 + fire-and-forget subscribeSession(sid, reconcileFromSeq) 回拉）
 *   reconcileFromSeq = lastSeenSeq（runtime session.subscribe 的 fromSeq 是排他下界：只返
 *   seq > fromSeq 的消息（session-message-handler.ts filter），传 lastSeenSeq 恰好覆盖全部缺失段）
 */
export type SeqGapDecision = { action: 'drop' } | { action: 'pass'; reconcileFromSeq?: number }

/**
 * 判定一条带 seq 的 server-push 消息应如何处理（IF3 六分支）。
 *
 * @param msg 带可选 seq 的入站消息（仅读取 seq 字段，其余由调用方处理）
 * @param state 该 session 的订阅状态（undefined = 未订阅/无记录）
 * @returns SeqGapDecision
 */
export function evalSeqGap(
  msg: { seq?: number },
  state: SubscriptionState | undefined,
): SeqGapDecision {
  // 分支 1/2：state 不存在或 subscribed=false → 兼容路径，不做 gap 检测（无副作用）
  if (!state || !state.subscribed) {
    return { action: 'pass' }
  }
  // 分支 3：seq 非 number（undefined 或脏数据）→ 无 gap 语义，正常 dispatch
  if (typeof msg.seq !== 'number') {
    return { action: 'pass' }
  }
  // 分支 4：重复/乱序（reconcile 回放）→ 丢弃。两种形态：
  //   a) seq <= lastSeenSeq：基线已覆盖（正常递进路径 dispatch 时同步推进基线）
  //   b) seq ∈ gapDispatchedSeqs：gap 触发消息已 dispatch 但基线未推进（MF-3 禁止提前推进），
  //      reconcile 回放 / 重复 push 到达时靠簿记去重
  if (msg.seq <= state.lastSeenSeq || state.gapDispatchedSeqs?.has(msg.seq)) {
    return { action: 'drop' }
  }
  // 分支 5：seq > lastSeenSeq + 1 → gap，当前消息仍 dispatch + 回拉缺失段。
  // reconcileFromSeq 传 lastSeenSeq 而非 seq-1：subscribe 的 fromSeq 是排他下界（只返
  // seq > fromSeq），传 seq-1 会漏掉 lastSeenSeq+1..seq-1 整个缺失段（MF-1）。
  if (msg.seq > state.lastSeenSeq + 1) {
    return { action: 'pass', reconcileFromSeq: state.lastSeenSeq }
  }
  // 分支 6：seq === lastSeenSeq + 1 → 正常递进
  return { action: 'pass' }
}

/**
 * seq gate 判定结果（对外 gate 面）：action 用 dispatch/drop 表达路由侧语义
 * （evalSeqGap 的 pass ↔ 消息继续分发），reconcileFromSeq 为 gap 时的回拉意图。
 */
export type SeqGateResult = { action: 'drop' } | { action: 'dispatch'; reconcileFromSeq?: number }

/**
 * seq 协议 gate——判定 + 簿记写入 + 基线推进一体（D1 归位后的协议入口）。
 *
 * route-inbound 的 applySeqGap 对每条带 sid 的入站消息调用本函数：
 * - drop → 调用方直接 return（不 dispatch 不触发兜底）
 * - dispatch 带 reconcileFromSeq → 调用方 void fire-and-forget subscribeSession(sid,
 *   reconcileFromSeq) 回拉缺失段（失败由 subscribeSession 内部 console.warn 消化，ES2；
 *   基线不在此推进，见下）
 * - dispatch 无 reconcileFromSeq → 正常递进，本函数内部已推进基线
 * - 未 subscribe（state 不存在或 subscribed=false）→ 兼容路径（不更新基线）
 *
 * @returns 是否继续 dispatch 及 reconcile 意图
 */
export function seqGate(sessionId: string, msg: { seq?: number }): SeqGateResult {
  const state = getSubscriptionState(sessionId)
  const decision = evalSeqGap(msg, state)
  if (decision.action === 'drop') {
    return { action: 'drop' }
  }
  if (decision.reconcileFromSeq !== undefined) {
    // gap detected：中间 seq 缺失 → 回拉缺失段（fromSeq = lastSeenSeq，排他下界覆盖全部缺失段）。
    // 当前消息仍返回 dispatch（gap 期间尽量不丢，reconcile 负责补齐缺失段）。
    // [MF-3] 基线不在此推进：若 reconcile 成功前把基线推进到 msg.seq，subscribe RPC 失败
    // （网络抖动/重连窗口）后缺失段永久不可恢复。推进时机由 subscribeSession 内部负责——
    // 成功后其 max() 收敛把基线推进到 max(reply.lastSeq, snapshot seqs)（>= msg.seq，不回退）；
    // 失败则基线保持原位，后续 live 消息再次触发 reconcile 形成自愈重试（无无限循环：
    // 每次新消息至多 1 次 RPC，in-flight 去重收敛并发）。
    //
    // [PR #175 review R1] gap 触发消息去重簿记：本消息即将 dispatch 但基线不推进，而
    // reconcile 的 subscribe(fromSeq=排他下界) 返回的 snapshot 必含本消息本身 → 回放时
    // 靠 gapDispatchedSeqs drop（见 evalSeqGap 分支 4b），否则 message_start 双实体 /
    // customStart 双 system notice。
    if (typeof msg.seq === 'number') {
      recordGapDispatchedSeq(sessionId, msg.seq)
    }
    return { action: 'dispatch', reconcileFromSeq: decision.reconcileFromSeq }
  }
  if (state && state.subscribed && typeof msg.seq === 'number') {
    // 正常递进（seq === lastSeenSeq+1）：更新基线 + 继续 dispatch。
    updateLastSeenSeq(sessionId, msg.seq)
  }
  return { action: 'dispatch' }
}

/**
 * 订阅指定 session 的 live 事件流（幂等：已 subscribed 则 no-op）。
 *
 * 流程（行为等价原 useMessageBusSubscription.subscribeSession）：
 *   1. 幂等守卫：state.subscribed=true 直接 return（重复 subscribe 不重复 RPC、不重放 snapshot）
 *   2. 调 subscribe(sessionId, fromSeq) → reply { snapshot, stateSnapshot, lastSeq, gap? }
 *   3. applySnapshot：snapshot 内每条 ServerMessage 依次 dispatchSession（回放历史，
 *      与 live push 同一通道消费）；stateSnapshot（state topic last-value）同样 dispatchSession
 *   4. 记 lastSeenSeq=max(reply.lastSeq, maxSnapshotSeq, maxStateSnapshotSeq, prevLastSeen)
 *      + 标记 subscribed=true
 *
 * @param sessionId 目标 session
 * @param fromSeq 可选，gap reconcile 时指定起始 seq 回拉缺失段（首次订阅不传）
 *
 * 失败处理（ES2）：subscribe RPC 失败时 console.warn，不标记 subscribed（下次可重试）。
 * 调用方（routeInbound gap reconcile / renderer ensureStreamSubscription）fire-and-forget
 * 不 await，失败属连接级故障，WS 重连后重建。不抛——抛出变 unhandled rejection。
 */
export async function subscribeSession(sessionId: string, fromSeq?: number): Promise<void> {
  // 端口捕获为局部 const（非空守卫的 narrowing 跨 run 回调闭包保留；模块级 let 的收窄
  // 在传参回调内失效）。fn 于 run() 调用的同一同步帧执行到首个 await，捕获值与实时读取恒等。
  const subscribe = subscribeImpl
  const replay = replayImpl
  if (!subscribe || !replay) {
    // 防御：端口未注入（configureRouteInbound 未调用 / 测试未 setSubscriptionPorts）
    console.warn(`[core/subscription-state] subscribe ports not injected, skip subscribe for ${sessionId}`)
    return
  }

  // 幂等守卫：已 subscribed 不重复订阅（避免 reconcile 期间重复 RPC + snapshot 二次回放）。
  // 但 fromSeq 显式传入时（gap 检测触发 reconcile）跳过守卫——这是显式 backfill 请求，
  // 必须发 RPC 回拉缺失段（即使已 subscribed）。
  const existing = subscriptionStates.get(sessionId)
  if (existing?.subscribed && fromSeq === undefined) return

  // in-flight 去重（MF-2）：守卫通过后、await 前的窗口内并发调用复用同一 Promise，
  // 避免重复 RPC + 重复 snapshot 回放。key 含 fromSeq（gap backfill 不吞 initial subscribe）。
  // settle 即清（成败都清：失败可重试，成功靠 subscribed 守卫拦截后续调用）由 factory 内建。
  const key = subscribeKey(sessionId, fromSeq)
  return subscribeDedup.run(key, async (): Promise<void> => {
    // 登记「订阅意图」条目（M1/W09 follow-up）：RPC 失败时留存 subscribed=false 的意图记录，
    // 供 WS 重连后 resubscribeAll 重发（否则断线期间新 session 的订阅意图丢失——
    // useChat 侧 streamSubscriptions 已同步记录，core 侧无条目则重连恢复遍历不到该 sid）。
    // subscribed=false 走 gap 检测兼容路径（evalSeqGap 分支 1/2），行为与「无条目」一致。
    if (!subscriptionStates.has(sessionId)) {
      subscriptionStates.set(sessionId, { lastSeenSeq: 0, subscribed: false })
    }
    let reply: { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number; gap?: boolean }
    try {
      reply = await subscribe(sessionId, fromSeq)
    } catch (e) {
      // subscribe 失败：不标记 subscribed（下次可重试）。不抛——调用方 fire-and-forget。
      console.warn(`[core/subscription-state] subscribe failed for session ${sessionId}:`, e)
      return
    }

    // applySnapshot：回放历史经 replay dispatcher 进入 routeInbound 共享路由管线
    // （PR #175 review R1 MUST_FIX）——与 live push 同一语义：
    // - seq 去重：已 subscribed 的 session（gap reconcile）回放消息过 seqGate，
    //   gap 触发消息（live 已 dispatch、基线未推进）靠 gapDispatchedSeqs 簿记 drop，
    //   缺失段逐条递进 dispatch 并推进基线；未 subscribed（initial/resubscribe）走兼容
    //   路径全量回放。
    // - ROUTE_TABLE effects + crossSession：回放的 session.subagents / message.complete /
    //   session.exited / extension:* 帧与 live 一样触发 onSubagents 等兜底与
    //   dispatchCrossSession——重连/gap 后非活跃 session 的 subagent 终态不再丢失。
    //
    // snapshot 元素是带 seq 的 ServerMessage（bus ring 内当前事件序列），逐条 replay
    // 让订阅端（useChat/useSessionEvents 等）复现已发生事件。回放循环内收集已回放
    // seq（含被 drop 的——drop 意味着该消息此前已经处理过），供 stateSnapshot 重叠去重。
    const replayedSeqs = new Set<number>()
    for (const msg of reply.snapshot) {
      replay(sessionId, msg)
      if (typeof msg.seq === 'number') replayedSeqs.add(msg.seq)
    }

    // stateSnapshot（wave:remove-bandaids）：5 个 state topic
    // （commands/context/subagents/workflows/state_changed，见 message-bus STATE_TYPE_KEY_MAP）
    // 的 last-value 数组，逐条 replay 让 routeInbound 兜底分支据此更新对应 store。
    // stateSnapshot 与 snapshot 独立（snapshot 受 fromSeq 增量过滤，stateSnapshot 是
    // last-value 不受影响），同一条消息（同 seq）可能同时出现在两者——ring 内未溢出时
    // snapshot 已回放过，skip 防二连击；ring 溢出后只剩 last-value 的旧消息不在
    // replayedSeqs 内，正常回放（ADR-0055 stateSnapshot 注入语义）。
    for (const msg of reply.stateSnapshot) {
      if (typeof msg.seq === 'number' && replayedSeqs.has(msg.seq)) continue
      replay(sessionId, msg)
    }

    // 记基线 + 标记 subscribed（后续 routeInbound 启用 gap 检测）。
    // lastSeq 可能小于已 dispatch 的某条 snapshot seq（ring 溢出场景）或小于 routeInbound 已更新
    // 的 lastSeenSeq（reconcile 期间 live 消息已推进基线），取 max 保证基线不回退。
    // stateSnapshot 内消息的 seq 也纳入 max 计算——state topic 消息同样占用 bus seqCounter。
    // （MF-3：gap 触发后基线推进在此发生——reconcile 成功才推进，失败则保持原位可重试）
    // [M1/W09 follow-up] 新 bus（runtime 重启，seqCounter 归零）的基线收缩不在此处理——
    // 「reply.lastSeq < prevLastSeen」无法区分「新 seq 空间」与「同 bus RPC 快照落后于 live 推进」
    //（后者取 min 会错误回退基线），由 resubscribeAll 在发 RPC 前重置条目解决（prevLastSeen=0）。
    const existingNow = subscriptionStates.get(sessionId)
    const prevLastSeen = existingNow?.lastSeenSeq ?? 0
    const maxSnapshotSeq = reply.snapshot.reduce((max, m) => (typeof m.seq === 'number' && m.seq > max ? m.seq : max), 0)
    const maxStateSnapshotSeq = reply.stateSnapshot.reduce((max, m) => (typeof m.seq === 'number' && m.seq > max ? m.seq : max), 0)
    const lastSeenSeq = Math.max(reply.lastSeq, maxSnapshotSeq, maxStateSnapshotSeq, prevLastSeen)
    // gap 簿记清理：基线已覆盖的条目（<= lastSeenSeq）此后由常规 seq 去重接管，无独立
    // 价值，清理防慢增长；超前条目保留（live gap dispatch 的消息可能晚于本 reply 的
    // lastSeq，仍需簿记去重直到下次收敛/递进覆盖）。无残留时不写字段（state 形状最小）。
    const carriedGapSeqs = existingNow?.gapDispatchedSeqs
      ? new Set([...existingNow.gapDispatchedSeqs].filter((s) => s > lastSeenSeq))
      : undefined
    subscriptionStates.set(
      sessionId,
      carriedGapSeqs && carriedGapSeqs.size > 0
        ? { lastSeenSeq, subscribed: true, gapDispatchedSeqs: carriedGapSeqs }
        : { lastSeenSeq, subscribed: true },
    )
  }).promise
}

/**
 * 读取 session 的订阅状态。
 *
 * seqGate 用此判是否启用 gap 检测：
 * - 返回 undefined 或 subscribed=false → 兼容路径（未 subscribe，不做 gap 检测，正常 dispatch）
 * - 返回 subscribed=true → 启用 gap 检测（seq<=lastSeenSeq 丢弃，seq>lastSeenSeq+1 触发 reconcile）
 *
 * @returns state 或 undefined（未订阅）
 */
export function getSubscriptionState(sessionId: string): SubscriptionState | undefined {
  return subscriptionStates.get(sessionId)
}

/**
 * 清除 session 的订阅状态（session 销毁时调用）。
 *
 * 消费方（renderer useChat.disposeSession）调用（session 删除/销毁）：清除此 session 的
 * SubscriptionState，后续该 session 的带 seq 消息走兼容路径（不 gap 检测）。
 * 与 renderer streamSubscriptions.delete 配对。
 */
export function clearSubscription(sessionId: string): void {
  subscriptionStates.delete(sessionId)
}

/**
 * 失效指定 session 的全部订阅簿记（状态条目 + in-flight 去重条目），session.exited 时调用。
 *
 * 与 clearSubscription 的差异：额外清 subscribeDedup 里该 session 的条目。残留的
 * in-flight Promise 对应死 session 的 subscribe RPC（runtime 侧 session 已删，reply 要么
 * 报错要么 65s 超时），不清会让 respawn 后首次 ensureStreamSubscription 被 in-flight
 * 去重收敛到死 Promise——不重发 subscribe RPC，新 pi 的流式推送无订阅者。
 *
 * 被清的旧 Promise 自身无害：resolve 路径（订阅真实成功）才写回状态条目，reject 路径
 * 不写；其 settle 清理经引用比对对本表 delete 是 no-op（factory 内建，不误删后续新条目）。
 */
export function invalidateSubscription(sessionId: string): void {
  subscriptionStates.delete(sessionId)
  // keys() 快照副本后前缀匹配删除（factory 契约：迭代中删除安全）
  for (const key of subscribeDedup.keys()) {
    if (key === sessionId || key.startsWith(`${sessionId}:`)) {
      subscribeDedup.delete(key)
    }
  }
}

/**
 * 更新 session 的 lastSeenSeq（seqGate 正常递进分支调用）。
 *
 * state 不存在时 no-op（兼容路径不维护基线）。仅更新 lastSeenSeq，不动 subscribed 标记。
 * 基线推进时顺带清理已被覆盖的 gap 簿记条目（<= 新基线的 seq 此后由常规 seq 去重接管）。
 */
export function updateLastSeenSeq(sessionId: string, seq: number): void {
  const state = subscriptionStates.get(sessionId)
  if (!state) return
  state.lastSeenSeq = seq
  const gap = state.gapDispatchedSeqs
  if (gap) {
    // 快照迭代后删除：Set 迭代中删除未访问元素会跳过迭代，先展开再删保证全量清理
    for (const s of [...gap]) {
      if (s <= seq) gap.delete(s)
    }
  }
}

/**
 * WS 重连后恢复全部订阅（M1 / W09 follow-up，connected false→true 迁移时由 use-connection 调）。
 *
 * 背景：runtime 侧 ws onDisconnect → bus.unsubscribeAll(ws) 清空该连接全部订阅；而 core 侧
 * 幂等守卫（subscribed 标记 / useChat.streamSubscriptions）在重连后依然短路，导致订阅永不
 * 重建、session 级消息（含不可回放的 transient 类）永久丢失。W09 删除 broadcast 兜底腿后
 * 此问题升级为 critical——publish 定向推送是唯一通道。
 *
 * 恢复语义（按条目状态分流）：
 * - subscribed=true：捕获 fromSeq=lastSeenSeq 后**先把条目重置为 {lastSeenSeq: 0, subscribed:
 *   false}** 再发 subscribe(sid, fromSeq)。重置的目的：
 *   a) 绕过「已 subscribed 不重订」幂等守卫（带显式 fromSeq 本也绕过，重置是双保险）；
 *   b) 让收敛公式的 prevLastSeen=0——新 bus（runtime 重启，seqCounter 归零）场景 reply.lastSeq
 *      远小于断线前基线，若 prevLastSeen 保留旧值，max() 收敛会把基线钉在旧 seq 空间，后续
 *      新消息 seq(1..) <= 旧基线被 evalSeqGap 永久 drop。重置后：同一 bus → 基线收敛到
 *      reply.lastSeq（增量回放断线期间消息）；新 bus → 基线收敛到新空间原点。
 *   c) RPC in-flight 窗口内（subscribed=false）live 消息走 evalSeqGap 兼容路径正常 dispatch，
 *      不丢消息（真实时序下 runtime 单线程串行保证 snapshot 与后续 live push 不相交；
 *      异常重叠由回放侧 seq 去重/簿记兜底）。
 * - subscribed=false：断线期间订阅失败的意图条目（subscribeSession 失败时登记），无 fromSeq
 *   正常（重）发（守卫对 subscribed=false 不拦截）。
 *
 * fire-and-forget（对齐 subscribeSession 调用约定）：失败由 subscribeSession 内部 console.warn
 * 消化，条目保持 subscribed=false，下次重连或 gap 消息可再触发。
 */
export function resubscribeAll(): void {
  for (const [sessionId, state] of subscriptionStates) {
    if (state.subscribed) {
      const fromSeq = state.lastSeenSeq
      subscriptionStates.set(sessionId, { lastSeenSeq: 0, subscribed: false })
      void subscribeSession(sessionId, fromSeq).catch((e) =>
        console.warn(`[core/subscription-state] resubscribe failed for session ${sessionId}:`, e),
      )
    } else {
      void subscribeSession(sessionId).catch((e) =>
        console.warn(`[core/subscription-state] resubscribe failed for session ${sessionId}:`, e),
      )
    }
  }
}

/**
 * 重置所有订阅状态（测试隔离用）。
 *
 * 生产代码无需调用（session 切换/删除时各自清理：消费方 disposeSession 调 clearSubscription）。
 * 测试间不 reset 会泄漏到下一用例（subscriptionStates 残留 → gap 检测误判）。
 * 测试需在 beforeEach 调用本函数清空 Map（与 renderer resetChatModuleState 配合）。
 */
export function resetSubscriptionStates(): void {
  subscriptionStates.clear()
  // in-flight 去重表同步清空（测试隔离；生产代码 in-flight 条目由 factory settle 自清理）
  subscribeDedup.clear()
}
