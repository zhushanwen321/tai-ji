/**
 * streaming 状态机深模块（B6 *Impl 消除，ADR-0058 深模块化范式）。
 *
 * 从 chat store 提取「messages ref 的 streaming→终态 mutate + 断连瞬态清理」内聚逻辑：
 * - applySubagentStreamDelta：subagent streaming delta 吸收（替换非追加，contentBlock 幂等）
 * - finalizeSubagentStream：subagent streaming 收口（sealed 守卫，幂等 no-op）
 * - [B2 subagent-stream-chunk §4.3] per (virtualId, recordId) 增量 chunk 消费状态机：
 *   applySubagentStreamChunk（chunk 优先序四步）/ applySubagentStreamState（拉取响应
 *   按序判定四分支 + 水位回放）/ requestSubagentStreamState（拉取统一入口，在途去重）/
 *   sealSubagentStream（sealedMsgSeq 单调水位）/ clearSubagentChunkState[ForSession]
 *   （分区生命周期清除；拉取执行器经 deps.subagentStreamPull 注入）
 * - finalizeMessages：finalizeSession 的 message 终态映射（bash 跳过 / toolCall 收口 / endTime 条件）
 * - collectFinalizeCandidates：finalizeAllStreaming 候选 session 并集（6 源 refs）
 * - clearIndependentTransient：resetTransientStates 的 session 级独立瞬态清理
 *
 * 形态：factory 函数（createStreamingStateMachine）闭包持有 refs + helpers，方法签名只留
 * 业务参数。store.ts 仅做 ref 委托（纯转发，无逻辑），不再有模块级 *Impl 反模式
 * （原为绕 max-lines-per-function 拆分）。
 */
import type { ContentBlock, Message, ServerMessageMap, ToolCall } from '@taiji/shared'
import { extractMainSessionId, isSubagentVirtualId } from '@taiji/shared'
import {
  commitMessages,
  isErrorFinalizeReason,
  REASON_FALLBACK_ERROR_TEXT,
  type MessagesRef,
} from './mutations'
import { findLastAssistantIndex } from './chunk-processor'
import type { FinalizeReason } from './store-types'
import type { SessionOccupancyState } from './store'
import { createInflightDedup } from '../../foundation/create-inflight-dedup'
import { randomUuid } from '../../utils/random-uuid'

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

// ── [B2 subagent-stream-chunk §4.3] subagent 增量 chunk 消费状态机 ──────────────────

/** subagent.stream_chunk 消息的消费侧载荷（协议字段投影，见 shared ServerMessageMap['subagent.stream_chunk']）。 */
export interface SubagentStreamChunk {
  msgSeq: number
  deltaSeq: number
  delta: string
}

/**
 * session.getSubagentStreamState reply 快照（shared 协议投影别名）：RelayTee 既有内存
 * 状态的只读视图。found=false = 该 record 当前无进行中流（未开始或已定稿）。
 */
export type SubagentStreamStateSnapshot = ServerMessageMap['session.getSubagentStreamState']

/**
 * per (virtualId, recordId) 分区状态机（设计 §4.3，禁全局槽位——record 切换互不污染）。
 * 非 Vue 响应式状态（[ADR-0049 例外]：纯流式簿记，渲染只走 messages ref overlay 路径）。
 * 仅本模块内部分区表使用（不进 domain/chat 出口，消费面 = createStreamingStateMachine 闭包）。
 */
interface SubagentChunkPartitionState {
  /** 当前流式消息序号（消费端初始 0，§4.1；随 chunk 边界推进 / 响应重置推进） */
  msgSeq: number
  /** 期望的下一条 delta 序号（== 追加；> 失步；< 丢弃） */
  expectedDeltaSeq: number
  /** 失步缓冲（跳号 chunk 等拉取响应回放；边界推进 / 响应重置时丢弃） */
  buffer: SubagentStreamChunk[]
  /** 已定稿最高消息序号（单调水位，从不重置；清除消息按携带 msgSeq 置位） */
  sealedMsgSeq: number
}

/** 工厂依赖注入接口：全部 refs + setter + helpers 由 store 装配，本模块不直连外部状态。
 *  [u5b] compactingSessions Set / setCompacting 退役——occupancy 投影（session.occupancy
 *  帧驱动）是 compacting membership 唯一来源，clearOccupancy 承接断连收口。 */
export interface StreamingStateMachineDeps {
  messages: MessagesRef
  occupancies: { value: Map<string, SessionOccupancyState> }
  handingOffSessions: { value: Set<string> }
  retryStates: { value: Map<string, unknown> }
  pendingSend: { value: Set<string> }
  clearOccupancy: (sessionId: string) => void
  setHandingOff: (sessionId: string, value: boolean) => void
  /**
   * [B2 subagent-stream-chunk §4.3] subagent 流状态拉取执行器（core 不直接发 RPC，renderer
   * 层经 ChatStoreOptions.subagentStreamPull 注入——对齐 agentCallEvictionsOf 回调注入模式）。
   * 入参 (virtualId, recordId)；renderer 侧实现按 extractMainSessionId(virtualId) 解析主
   * session 后调 api.session.getSubagentStreamState。reject = 连接断开 / 显式错误回执。
   * 缺省（未接线）＝失步拉取 no-op（core 单测 / 未装配环境，缓冲保留、下一条 chunk 重触发）。
   */
  subagentStreamPull?: (virtualId: string, recordId: string) => Promise<SubagentStreamStateSnapshot>
}

/**
 * 构造 streaming 状态机。逻辑体与 store.ts 迁移前模块级函数逐字等价（仅去掉 refs 显式参数，
 * 由闭包持有），行为由 streaming-state-machine.test.ts + store.test.ts 双锁。
 */
export function createStreamingStateMachine(deps: StreamingStateMachineDeps) {
  const { messages, occupancies, handingOffSessions, retryStates, pendingSend, clearOccupancy, setHandingOff, subagentStreamPull } = deps

  /**
   * subagent streaming delta 吸收纯逻辑（W4，模块作用域）：
   * 虚拟 session 有 streaming assistant 时替换其 content，无 streaming assistant 时 push 新的。
   * 吸收自原 subagent store applyStreamDelta（去 getMessages/setMessages 回调参数，直接操作
   * 传入的 messages ref），让 chat store 成为所有 assistant content mutation 的唯一入口。
   *
   * 扩展层传的 lines 是 buffer 的 split('\n')，每次都是完整文本 → 用替换而非追加。
   * contentBlock 幂等：已有 text 块则不重复 push（与主流式 text_delta handler 对齐）。
   */
  /**
   * subagent 流式 assistant 写点的共用本体（applySubagentStreamDelta / appendSubagentStreamText
   * 的单点，两者只差 content 来源——全文替换 vs 增量追加）：末位 assistant 仍在 streaming 时
   * 写其 content（contentBlock 幂等），否则 push 新的 streaming assistant。resolveContent
   * 参数 = 既有消息 content（新建分支为 undefined）。
   */
  function upsertStreamingAssistantText(virtualId: string, resolveContent: (existing: Message['content'] | undefined) => string): void {
    const prev = messages.value.get(virtualId)?.value ?? []
    const lastAssistantIdx = findLastAssistantIndex(prev)
    const next = [...prev]
    if (lastAssistantIdx >= 0 && next[lastAssistantIdx].status === 'streaming') {
      const prevMsg = next[lastAssistantIdx]
      // 不可变写法（W1）：shallowRef 下不依赖字段级 mutate，整体构造新对象
      const contentBlocks: ContentBlock[] = prevMsg.contentBlocks?.some((b) => b.type === 'text')
        ? prevMsg.contentBlocks
        : [...(prevMsg.contentBlocks ?? []), { type: 'text', refId: 'text' }]
      next[lastAssistantIdx] = { ...prevMsg, content: resolveContent(prevMsg.content), contentBlocks }
    } else {
      next.push({
        id: `sa-${randomUuid()}`,
        role: 'assistant',
        content: resolveContent(undefined),
        status: 'streaming',
        contentBlocks: [{ type: 'text', refId: 'text' }],
        timestamp: Date.now(),
      })
    }
    commitMessages(messages, virtualId, next)
  }

  function applySubagentStreamDelta(virtualId: string, lines: string[]): void {
    const fullText = lines.join('\n')
    upsertStreamingAssistantText(virtualId, () => fullText)
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

  // ── [B2 subagent-stream-chunk §4.3] subagent 增量 chunk 消费状态机 ────────────────
  // 契约权威 = 设计文档 §4.3（chunk 处理优先序四步 / 拉取响应按序判定四分支 /
  // sealedMsgSeq 单调水位 / 在途拉取 settle 即清）。拉取执行器由 renderer 注入
  // （deps.subagentStreamPull，core 不直接发 RPC）；无定时器/宽限窗（ADR-0122）——
  // 失败重触发 = 事件驱动（下一条 chunk 到达）。

  /** per (virtualId, recordId) 分区表（禁全局槽位；非响应式，ADR-0049 例外同 entryStates 判据） */
  const chunkPartitions = new Map<string, Map<string, SubagentChunkPartitionState>>()

  /**
   * 同 record 在途拉取去重（C-data-18：禁止手写「同 key 并发异步去重 + settle 清理」
   * 同构实现，一律组装 createInflightDedup；key = `${virtualId}::${recordId}`）。
   * 槽独立于分区实例：分区清除/重建不弃在途拉取，其 settle（成功/失败）照常由 factory
   * 引用比对清槽——修复前手写 boolean 位存在「旧拉取 rejection 清到重建后新分区」的
   * 瞬时去重击穿，factory 槽位与分区生命周期解耦后该窗口不存在。
   */
  const pullDedup = createInflightDedup<SubagentStreamStateSnapshot>()

  function createChunkPartition(): SubagentChunkPartitionState {
    return { msgSeq: 0, expectedDeltaSeq: 0, buffer: [], sealedMsgSeq: 0 }
  }

  function getOrCreateChunkPartition(virtualId: string, recordId: string): SubagentChunkPartitionState {
    let byRecord = chunkPartitions.get(virtualId)
    if (!byRecord) {
      byRecord = new Map()
      chunkPartitions.set(virtualId, byRecord)
    }
    let state = byRecord.get(recordId)
    if (!state) {
      state = createChunkPartition()
      byRecord.set(recordId, state)
    }
    return state
  }

  /**
   * 增量追加当前流式消息（chunk 优先序第 2 步「追加」的本体，与主流 message.text_delta
   * effect 同型：O(1) 摊销字符串拼接，非全量替换）。末位 assistant streaming → content
   * 追加 + text block 幂等；否则 push sa- 新 streaming assistant（与 applySubagentStreamDelta
   * 共用 upsertStreamingAssistantText 本体，只差 content 来源 = 本条增量而非全文）。
   */
  function appendSubagentStreamText(virtualId: string, delta: string): void {
    upsertStreamingAssistantText(virtualId, (existing) => (existing === undefined ? delta : `${existing}${delta}`))
  }

  /**
   * 消息边界推进的「开新 streaming 消息」（§4.3 优先序第 1 步）：末位 assistant 仍在
   * streaming 时就地收口（旧消息已随 message_end 经 entry 权威定稿，此处只做显示层
   * 对齐，终态由 entry 链覆盖——§6.2 定稿取代语义）+ push 新的空 streaming assistant，
   * 保证新消息的增量不并进旧消息实体。
   */
  function openNewStreamingMessage(virtualId: string): void {
    const prev = messages.value.get(virtualId)?.value ?? []
    const lastAssistantIdx = findLastAssistantIndex(prev)
    const next = [...prev]
    if (lastAssistantIdx >= 0 && next[lastAssistantIdx].status === 'streaming') {
      const oldMsg = next[lastAssistantIdx]
      next[lastAssistantIdx] = {
        ...oldMsg,
        status: 'complete',
        ...(oldMsg.endedAt === undefined ? { endedAt: Date.now() } : {}),
      }
    }
    next.push({
      id: `sa-${randomUuid()}`,
      role: 'assistant',
      content: '',
      status: 'streaming',
      contentBlocks: [{ type: 'text', refId: 'text' }],
      timestamp: Date.now(),
    })
    commitMessages(messages, virtualId, next)
  }

  /**
   * chunk 处理（chunk 入口与 buffer 回放共用的单一管线，§4.3 优先序，先边界后序号）：
   * 1. msgSeq 边界推进（> 当前）：重置 expectedDeltaSeq = 0、丢弃旧 buffer、开新 streaming
   *    消息（旧消息已随 message_end 经 entry 权威定稿，缓冲残留不再有意义）；跨多条消息的
   *    前向跳号同理——中间消息的全文由 entry 链承载，无需逐条推进。
   *    msgSeq < 当前 → 陈旧 chunk 丢弃（理由见方法尾注）。
   * 2. deltaSeq == expected → 追加，expected++。
   * 3. deltaSeq > expected → 失步：入 buffer，发起拉取（同 record 在途去重由 pullDedup 承接）。
   * 4. deltaSeq < expected → 已含于最近一次拉取结果，丢弃。
   *
   * [msgSeq < 当前丢弃的理由]（设计 §4.3 第 1 步同文登记）与拉取响应分支 1/2 的陈旧
   * 防护同一原则：回退 chunk 若推进边界会用旧消息内容覆写当前 streaming 实体（复活定稿
   * 内容），且响应分支 4 的 buffer 回放会把边界推进前缓冲的旧消息 chunk 重新喂回本管线。
   * 设计不变量「单条 WS 连接内广播有序」（§4.3）下正常 chunk 流只出现前向序号，该分支
   * 不改变任何可达形态的行为。
   */
  function processSubagentStreamChunk(virtualId: string, recordId: string, state: SubagentChunkPartitionState, chunk: SubagentStreamChunk): void {
    // 1. 消息边界（先边界后序号）
    if (chunk.msgSeq < state.msgSeq) return // 陈旧 chunk（含回放中的旧消息残留），丢弃
    if (chunk.msgSeq > state.msgSeq) {
      state.msgSeq = chunk.msgSeq
      state.expectedDeltaSeq = 0
      state.buffer = [] // 丢弃旧 buffer（旧消息已定稿，残留无意义）
      openNewStreamingMessage(virtualId)
    }
    // 2. == expected → 追加
    if (chunk.deltaSeq === state.expectedDeltaSeq) {
      state.expectedDeltaSeq++
      appendSubagentStreamText(virtualId, chunk.delta)
      return
    }
    // 3. > expected → 失步：入 buffer，发起拉取（在途去重在 requestSubagentStreamState 内）
    if (chunk.deltaSeq > state.expectedDeltaSeq) {
      state.buffer.push(chunk)
      requestSubagentStreamState(virtualId, recordId)
      return
    }
    // 4. < expected → 已含于最近一次拉取结果，丢弃
  }

  /**
   * 发起拉取（§4.3 触发点 ②③ 的执行本体 + renderer 接入拉取（触发点 ①）的统一入口）：
   * 同一 record 同时至多一个在途拉取（pullDedup 去重，C-data-18 factory）；响应经
   * applySubagentStreamState 按序判定；失败（连接断开 / 显式错误回执，executor reject）
   * 即 settle 清槽（factory 内建）、保持失步态，下一条 chunk 到达时重新触发（事件驱动，
   * 无定时重试——ADR-0122）。
   * 未注入执行器（deps.subagentStreamPull 缺省）→ no-op（缓冲保留）。
   */
  function requestSubagentStreamState(virtualId: string, recordId: string): void {
    if (!subagentStreamPull) return
    const key = `${virtualId}::${recordId}`
    // 在途即返回（单消费者）：响应消费由首次发起方的 then 单点承接。复用路径不得再
    // attach then——factory 复用语义是「复用者拿到同一 promise、各自 attach 各自消费」，
    // 而本处消费（applySubagentStreamState）非幂等读，同响应双应用会把回放推进过的
    // expected 重置回响应水位（状态回退）。
    if (pullDedup.has(key)) return
    const { promise } = pullDedup.run(key, () => subagentStreamPull(virtualId, recordId))
    void promise
      .then((response) => {
        applySubagentStreamState(virtualId, recordId, response)
      })
      .catch(() => {
        // 失败保持失步态（设计 §4.3「拉取失败与无应答」），定稿不受影响（entry 权威兜底）。
        // 静默收窄：失败信号由失步态本身承载，下一条 chunk 重触发。在途槽已由 factory
        // settle 即清（清理回调注册先于本 catch），无需手动清位。
      })
  }

  /**
   * 拉取响应按序判定（§4.3 四分支；在途标记清理由 pullDedup settle 即清承接——factory
   * 的清理回调注册先于调用方 then，进入本函数时在途槽已清）：
   * 1. response.msgSeq <= sealedMsgSeq → 内容已定稿：丢弃（晚到响应不得复活定稿消息）。
   * 2. response.msgSeq < 当前 msgSeq → 陈旧响应：丢弃（RPC 应答与广播推进的交错窗口）。
   * 3. found: false → 无进行中流：不动作（定稿内容由 entry 权威链与既有回放承载）。
   * 4. 判定通过（含 response.msgSeq 超前于当前 msgSeq 的跨边界恢复——按响应重置状态本身
   *    就是边界推进）→ lines 全量替换（复用 applySubagentStreamDelta）+ 按
   *    (response.msgSeq, lastDeltaSeq) 重置状态 + 按序回放 buffer 中 deltaSeq >= expected
   *    的 chunk（回放复用同一 chunk 管线；回放中再遇跳号 → 再次拉取）。
   *
   * [回放与在途去重的时序] 槽已随本次响应 settle 清除，回放中再触发的拉取 run 的是
   * 新槽，语义「确有新的在途拉取」——去重不被击穿（原手写位须手动「回放前先清」的
   * 顺序约束由 factory 时序契约构造性保证）。
   *
   * [去重即水位]（§4.3）：lastDeltaSeq 标记这份全文含到第几条 delta——重置后
   * expected = lastDeltaSeq + 1，回放过滤条件 deltaSeq >= expected 即「> 水位回放、
   * <= 水位丢弃」。
   */
  function applySubagentStreamState(virtualId: string, recordId: string, response: SubagentStreamStateSnapshot): void {
    const state = getOrCreateChunkPartition(virtualId, recordId)
    // 1. ≤ sealedMsgSeq → 已定稿，丢弃
    if (response.msgSeq <= state.sealedMsgSeq) return
    // 2. < 当前 msgSeq → 陈旧响应，丢弃
    if (response.msgSeq < state.msgSeq) return
    // 3. found: false → 无进行中流，不动作
    if (!response.found) return
    // 4. 判定通过：全量替换 + 状态重置 + buffer 按序回放（在途槽已由 factory settle 清，
    //    回放再触发的拉取自行 run 新槽）
    applySubagentStreamDelta(virtualId, response.lines)
    state.msgSeq = response.msgSeq
    state.expectedDeltaSeq = response.lastDeltaSeq + 1
    const replay = state.buffer
    state.buffer = []
    for (const chunk of replay) {
      processSubagentStreamChunk(virtualId, recordId, state, chunk)
    }
  }

  /**
   * chunk 入口（renderer subscribeStream handler 分派调用）：per (virtualId, recordId)
   * 取或建分区后走单一 chunk 管线。触发点 ②（首见缺前缀）由「新建分区 + 第 3 步失步」
   * 组合承载：无状态机首条 chunk 若 deltaSeq > 0，边界推进后 expected = 0 必失步入
   * buffer 并触发拉取；「无状态机 + deltaSeq = 0」= 干净起步，直接建状态机追加、不拉取
   * （§4.3，否则每条 record 流式启动都多一次稳态冗余 RPC）。
   */
  function applySubagentStreamChunk(virtualId: string, recordId: string, msgSeq: number, deltaSeq: number, delta: string): void {
    const state = getOrCreateChunkPartition(virtualId, recordId)
    processSubagentStreamChunk(virtualId, recordId, state, { msgSeq, deltaSeq, delta })
  }

  /**
   * 定稿标记（§4.3 sealedMsgSeq）：清除消息（subagent.stream_delta lines: undefined）
   * 按其携带的 msgSeq 置位——单调推进（取 max）、从不重置。分区不存在时创建（只置水位
   * 不动消息）——缺前缀晚接入场景下，access 拉取响应的分支 1 判定依赖该水位已在清除时
   * 落账。W 路径清除消息不带 msgSeq、不进本状态机（§4.1，renderer 分派侧保证）。
   */
  function sealSubagentStream(virtualId: string, recordId: string, msgSeq: number): void {
    const state = getOrCreateChunkPartition(virtualId, recordId)
    if (msgSeq > state.sealedMsgSeq) state.sealedMsgSeq = msgSeq
  }

  /**
   * 分区/record 级清除（生命周期挂点：record 删除 / 虚拟分区删除路径由 renderer 接线，
   * ADR-0049 分区范式）。recordId 缺省删整个 virtualId 名下全部分区。
   */
  function clearSubagentChunkState(virtualId: string, recordId?: string): void {
    const byRecord = chunkPartitions.get(virtualId)
    if (!byRecord) return
    if (recordId === undefined) {
      chunkPartitions.delete(virtualId)
      return
    }
    byRecord.delete(recordId)
    if (byRecord.size === 0) chunkPartitions.delete(virtualId)
  }

  /**
   * session 级清除（生命周期挂点：双壳删除编排归入 core triggerSessionCleanups，由
   * renderer 注册 cleanup 调用）。subagent 虚拟键三段式内嵌 mainSessionId
   * （shared extractMainSessionId 单一实现），按第二段归属匹配删除（结构判定复用
   * shared isSubagentVirtualId——非三段键不属于任何 main session 名下）。
   */
  function clearSubagentChunkStateForSession(sessionId: string): void {
    for (const virtualId of [...chunkPartitions.keys()]) {
      if (isSubagentVirtualId(virtualId) && extractMainSessionId(virtualId) === sessionId) {
        chunkPartitions.delete(virtualId)
      }
    }
  }

  /**
   * finalizeAllStreaming 的候选 session 集合构造（W3 / W-S3，模块作用域）。
   *
   * 遍历所有可能持有瞬态态的 session 的 key 并集：messages.keys() ∪ occupancy 分区中
   * compacting 的 sid ∪ handingOffSessions ∪ retryStates ∪ pendingSend。
   * 不能只遍历 messages.keys()——compacting / retry / pendingSend 可能独立于消息
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
    for (const sid of pendingSend.value) candidateSids.add(sid)
    return candidateSids
  }

  /**
   * resetTransientStates 的 session 级独立瞬态清理（W3，模块作用域）。
   * 清 occupancy 分区 / handingOff / retry（断连兜底：这些态在断连后无事件驱动清理）。
   * [u5a] queue 维度已随 queueStates 分区退役（分区删除，无清理对象）。
   *
   * [u5b] occupancy 分区删除（替代原 setCompacting(false)）：派生回落全 idle，重连后
   * resubscribeAll 的 stateSnapshot 回放恢复真实值（G4）。
   *
   * [steer-bubble D4 豁免声明] 本断连收口点刻意**不**清 inflight 计数
   * （steer-bubble D4「刻意保留」）——与「清理信号
   * 到达即清全部瞬态」的直觉不一致是有意为之：occupancy/retry 是重建型状态（重连 ring 回放
   * 帧即可重建）故随收口清理；inflight 确认基线是**不可重建状态**（仅存在于前端，清了即
   * 永久丢失/漂移），断连重连后标记回执回收与 ② 纯计数兜底仍依赖它。LRU 驱逐回调
   * （store lruEvictDeps）同理豁免，见该处注释。后续维护勿顺手在本方法补清本项。
   */
  function clearIndependentTransient(sessionId: string): void {
    clearOccupancy(sessionId)
    setHandingOff(sessionId, false)
    if (retryStates.value.has(sessionId)) {
      const next = new Map(retryStates.value)
      next.delete(sessionId)
      retryStates.value = next
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
    // ── [B2 subagent-stream-chunk §4.3] chunk 消费状态机入口（store 逐一委托）──
    applySubagentStreamChunk,
    applySubagentStreamState,
    requestSubagentStreamState,
    sealSubagentStream,
    clearSubagentChunkState,
    clearSubagentChunkStateForSession,
    finalizeMessages,
    collectFinalizeCandidates,
    clearIndependentTransient,
    /** [测试逃生舱] 分区表只读引用（状态机四分支/水位/在途拉取断言用，生产代码勿读）。 */
    _chunkPartitionsForTest: chunkPartitions,
    /** [测试逃生舱] 在途拉取去重表只读引用（has(key) 断言在途/settle 即清，生产代码勿读）。 */
    _pullDedupForTest: pullDedup,
  }
}
