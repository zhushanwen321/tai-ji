/**
 * streaming 状态机深模块（B6 *Impl 消除，ADR-0058 深模块化范式）。
 *
 * 从 chat store 提取「messages ref 的 streaming→终态 mutate + 断连瞬态清理」内聚逻辑：
 * - applySubagentStreamDelta：subagent streaming delta 吸收（替换非追加，contentBlock 幂等）
 * - finalizeSubagentStream：subagent streaming 收口（sealed 守卫，幂等 no-op）
 * - finalizeMessages：finalizeSession 的 message 终态映射（bash 跳过 / toolCall 收口 / endTime 条件）
 * - collectFinalizeCandidates：finalizeAllStreaming 候选 session 并集（6 源 refs）
 * - clearIndependentTransient：resetTransientStates 的 session 级独立瞬态清理
 *
 * 形态：factory 函数（createStreamingStateMachine）闭包持有 refs + helpers，方法签名只留
 * 业务参数。store.ts 仅做 ref 委托（6 处调用点），不再有模块级 *Impl 反模式
 * （原为绕 max-lines-per-function 拆分）。
 */
import type { ContentBlock, Message, ToolCall } from '@taiji/shared'
import {
  commitMessages,
  isErrorFinalizeReason,
  REASON_FALLBACK_ERROR_TEXT,
  type MessagesRef,
} from './mutations'
import { findLastAssistantIndex } from './chunk-processor'
import type { FinalizeReason } from './store-types'
import type { SessionOccupancyState } from './store'

/**
 * finalizeMessages 的 per-message 终态映射助手（模块作用域纯函数，不依赖工厂闭包；
 * 从原 map 回调按职责拆出——bash 跳过 → toolCall 收口 → 终态实体清扫 / streaming 收口，
 * 分支条件与原实现逐字节等价，行为由 streaming-state-machine.test.ts + store.test.ts 锁）。
 */
function finalizeMessage(
  m: Message,
  reason: FinalizeReason,
  errorText: string | undefined,
): Message {
  // [M1 PR#116 review] 跳过 bash 消息：bash 消息（role:'system' + bashExecution）的生命周期
  // 由 bashResultEffect / markBashError 独立管理（W1 timer-decouple 解耦）。
  // 若此处统一翻终态，L1 放宽 bash↔assistant 并发后，assistant error → finalizeSession('error')
  // 会把共存中的 streaming bash 一并翻成 error，bashResult 到达时找不到 streaming bash →
  // 真实结果被丢弃。
  if (m.bashExecution) return m
  // toolCall 收口对终态/streaming 两分支共用，只算一次（与原实现一致）
  const toolCalls = finalizeToolCalls(reason, m.toolCalls)
  const isStreaming = m.status === 'streaming'
  if (!isStreaming) return sweepFinalizedMessage(m, toolCalls)
  return finalizeStreamingMessage(m, reason, errorText, toolCalls)
}

/** toolCall 统一收口（无论 message 是否还 streaming；[W4] 收敛到单一路径，避免
 * message.complete 局部 finalizeToolCalls 与此两套映射漂移）。
 * - error/stream_error → toolCall 'error'；其它非 normal/aborted → 'end_not_received'（设 endTime）；
 *   normal/aborted 不设 endTime（与原逻辑一致）。
 * - 延迟到达的真实 tool_call_end 会用真实 output 覆盖收口值（end_not_received → completed）。
 * - toolCalls 为 undefined 时保持 undefined（等价原 `?.map`）。 */
function finalizeToolCalls(reason: FinalizeReason, toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
  if (!toolCalls) return undefined
  return toolCalls.map((tc): typeof tc => {
    if (tc.status !== 'running') return tc
    const tcIsError = reason === 'error' || reason === 'stream_error'
    return {
      ...tc,
      status: tcIsError ? 'error' : 'end_not_received',
      ...(reason !== 'normal' && reason !== 'aborted' ? { endTime: Date.now() } : {}),
    }
  })
}

/** message 已终态（如 message.complete handler 已改 status）时只补 toolCall 收口。
 * 无 running toolCall 则原样返回（保持引用稳定，避免无谓 re-render）。 */
function sweepFinalizedMessage(m: Message, toolCalls: ToolCall[] | undefined): Message {
  const needsToolCalls = m.toolCalls?.some((tc) => tc.status === 'running') ?? false
  if (needsToolCalls) {
    return { ...m, toolCalls }
  }
  return m
}

/** message 仍 streaming → 转终态 + 收口 toolCall.
 * [M2 error-visibility] 追加形态双通道：
 * errorText 写 Message.error 字段（message.ts:269 注释明确用途对口），content 保持崩溃前正常正文不动。
 * 旧 `${content}\n\n${errorText}` 拼接把 errorText 混进 content，渲染层无法区分哪段是错误。
 * 仅 assistant 消息写 error；非 assistant（user 提问等）保持 m.error 原值不写。
 * errorText 缺失/空串时按 reason 走共享兜底（REASON_FALLBACK_ERROR_TEXT，mutations.ts
 * 单一实现——与 terminalMessagePatch 共守「error 终态必有 error 文本」不变量）。 */
function finalizeStreamingMessage(
  m: Message,
  reason: FinalizeReason,
  errorText: string | undefined,
  toolCalls: ToolCall[] | undefined,
): Message {
  const isErrorReason = isErrorFinalizeReason(reason)
  const finalStatus = isErrorReason ? 'error' : 'complete'
  const fallback = isErrorReason ? REASON_FALLBACK_ERROR_TEXT[reason] : undefined
  // errorText 空串视同缺失（空 error 字段同样破坏形态判定信号），用 || 而非 ??
  const finalError = m.role === 'assistant' ? (errorText || fallback || m.error) : m.error
  return {
    ...m,
    status: finalStatus,
    content: m.content,
    error: finalError,
    toolCalls,
    // 产出结束时刻（turn 聚合时间轴右端）：收口即本消息产出结束。终端 patch 已写过
    // （message.complete 正常路径）则不动——幂等，迟到收口不覆写真实结束时刻。
    ...(m.role === 'assistant' && m.endedAt === undefined ? { endedAt: Date.now() } : {}),
  }
}

/** 工厂依赖注入接口：全部 refs + setter + helpers 由 store 装配，本模块不直连外部状态。
 *  [u5b] compactingSessions Set / setCompacting 退役——occupancy 投影（session.occupancy
 *  帧驱动）是 compacting membership 唯一来源，clearOccupancy 承接断连收口。 */
export interface StreamingStateMachineDeps {
  messages: MessagesRef
  occupancies: { value: Map<string, SessionOccupancyState> }
  handingOffSessions: { value: Set<string> }
  retryStates: { value: Map<string, unknown> }
  queueStates: { value: Map<string, unknown> }
  pendingSend: { value: Set<string> }
  clearOccupancy: (sessionId: string) => void
  setHandingOff: (sessionId: string, value: boolean) => void
}

/**
 * 构造 streaming 状态机。逻辑体与 store.ts 迁移前模块级函数逐字等价（仅去掉 refs 显式参数，
 * 由闭包持有），行为由 streaming-state-machine.test.ts + store.test.ts 双锁。
 */
export function createStreamingStateMachine(deps: StreamingStateMachineDeps) {
  const { messages, occupancies, handingOffSessions, retryStates, queueStates, pendingSend, clearOccupancy, setHandingOff } = deps

  /**
   * subagent streaming delta 吸收纯逻辑（W4，模块作用域）：
   * 虚拟 session 有 streaming assistant 时替换其 content，无 streaming assistant 时 push 新的。
   * 吸收自原 subagent store applyStreamDelta（去 getMessages/setMessages 回调参数，直接操作
   * 传入的 messages ref），让 chat store 成为所有 assistant content mutation 的唯一入口。
   *
   * 扩展层传的 lines 是 buffer 的 split('\n')，每次都是完整文本 → 用替换而非追加。
   * contentBlock 幂等：已有 text 块则不重复 push（与主流式 text_delta handler 对齐）。
   */
  function applySubagentStreamDelta(virtualId: string, lines: string[]): void {
    const fullText = lines.join('\n')
    const prev = messages.value.get(virtualId)?.value ?? []
    const lastAssistantIdx = findLastAssistantIndex(prev)
    const next = [...prev]
    if (lastAssistantIdx >= 0 && next[lastAssistantIdx].status === 'streaming') {
      const prevMsg = next[lastAssistantIdx]
      // 不可变写法（W1）：shallowRef 下不依赖字段级 mutate，整体构造新对象
      const contentBlocks: ContentBlock[] = prevMsg.contentBlocks?.some((b) => b.type === 'text')
        ? prevMsg.contentBlocks
        : [...(prevMsg.contentBlocks ?? []), { type: 'text', refId: 'text' }]
      next[lastAssistantIdx] = { ...prevMsg, content: fullText, contentBlocks }
    } else {
      next.push({
        id: `sa-${crypto.randomUUID()}`,
        role: 'assistant',
        content: fullText,
        status: 'streaming',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: Date.now(),
      })
    }
    commitMessages(messages, virtualId, next)
  }

  /**
   * subagent streaming 收口纯逻辑（W4，模块作用域）：把虚拟 session 最后一条 streaming
   * assistant 翻成 complete。
   *
   * sealed 守卫对齐（D-010 parity）：实体一旦 complete 不再被后续 delta 污染。无 streaming
   * 实体时幂等 no-op。不走 finalizeSession：subagent 虚拟 session 无 pendingSend / streaming
   * timer 生命周期（由 subagent store 的 panelStreamUnsub 管理），只翻 status。
   */
  function finalizeSubagentStream(virtualId: string): void {
    const prev = messages.value.get(virtualId)?.value
    if (!prev || prev.length === 0) return
    const lastAssistantIdx = findLastAssistantIndex(prev)
    if (lastAssistantIdx < 0 || prev[lastAssistantIdx].status !== 'streaming') return
    const next = [...prev]
    // 产出结束时刻：subagent 镜像流同样经 TurnMeta 展示时长/字符，与主链路同口径
    next[lastAssistantIdx] = {
      ...next[lastAssistantIdx],
      status: 'complete',
      ...(next[lastAssistantIdx].endedAt === undefined ? { endedAt: Date.now() } : {}),
    }
    commitMessages(messages, virtualId, next)
  }

  /**
   * finalizeAllStreaming 的候选 session 集合构造（W3 / W-S3，模块作用域）。
   *
   * 遍历所有可能持有瞬态态的 session 的 key 并集：messages.keys() ∪ occupancy 分区中
   * compacting 的 sid ∪ handingOffSessions ∪ retryStates ∪ queueStates ∪ pendingSend。
   * 不能只遍历 messages.keys()——compacting / retry / queue / pendingSend 可能独立于消息
   * 存在，仅遍历 messages 会漏掉这些 session。
   *
   * [u5b] compacting 候选来源从 compactingSessions Set 改为 occupancy 投影过滤（membership
   * 单一来源）。
   *
   * [W3 / W-S3] pendingSend 并入：纯 pendingSend 态（用户已发起、message_start 空窗、无消息实体）
   * 不在 messages.keys() 内，断连时不会立即收口，UI 卡「发送中」。
   */
  function collectFinalizeCandidates(): Set<string> {
    const candidateSids = new Set<string>(messages.value.keys())
    for (const [sid, occ] of occupancies.value) {
      if (occ.compacting) candidateSids.add(sid)
    }
    for (const sid of handingOffSessions.value) candidateSids.add(sid)
    for (const sid of retryStates.value.keys()) candidateSids.add(sid)
    for (const sid of queueStates.value.keys()) candidateSids.add(sid)
    for (const sid of pendingSend.value) candidateSids.add(sid)
    return candidateSids
  }

  /**
   * resetTransientStates 的 session 级独立瞬态清理（W3，模块作用域）。
   * 清 occupancy 分区 / handingOff / retry / queue（断连兜底：这些态在断连后无事件驱动清理）。
   *
   * [u5b] occupancy 分区删除（替代原 setCompacting(false)）：派生回落全 idle，重连后
   * resubscribeAll 的 stateSnapshot 回放恢复真实值（G4）。
   *
   * [steer-bubble D4 豁免声明] 本断连收口点刻意**不**清 pendingBuffer 与 inflight 计数
   * （D4「刻意保留」）——与「清理信号
   * 到达即清全部瞬态」的直觉不一致是有意为之：queueStates 是重建型状态（重连 ring 回放
   * 入队帧即可重建）故随收口清理；pendingBuffer 的 segments 暂存与 inflight 确认基线是
   * **不可重建状态**（仅存在于前端，清了即永久丢失/漂移），断连重连后腿 1 暂存消费与
   * 腿 2 inflight 判定仍依赖它们。LRU 驱逐回调（store lruEvictDeps）同理豁免，见该处
   * 注释。后续维护勿顺手在本方法补清这两项。
   */
  function clearIndependentTransient(sessionId: string): void {
    clearOccupancy(sessionId)
    setHandingOff(sessionId, false)
    if (retryStates.value.has(sessionId)) {
      const next = new Map(retryStates.value)
      next.delete(sessionId)
      retryStates.value = next
    }
    if (queueStates.value.has(sessionId)) {
      const next = new Map(queueStates.value)
      next.delete(sessionId)
      queueStates.value = next
    }
  }

  /**
   * finalizeSession 的 message 终态映射纯逻辑（模块作用域）。
   *
   * 把 streaming/running 实体推到终态（reason 决定 message.status + toolCall.status 映射），
   * 同步收口 running toolCall。幂等（sealed 后实体不变）。
   */
  function finalizeMessages(sessionId: string, reason: FinalizeReason, errorText?: string): void {
    const prev = messages.value.get(sessionId)?.value
    if (!prev) return
    const next = prev.map((m) => finalizeMessage(m, reason, errorText))
    commitMessages(messages, sessionId, next)
  }

  return {
    applySubagentStreamDelta,
    finalizeSubagentStream,
    finalizeMessages,
    collectFinalizeCandidates,
    clearIndependentTransient,
  }
}
