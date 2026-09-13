/**
 * applyEntry —— chat 视图态 reducer（data-source-governance W20，D5「单一 reducer 双路喂入」重放侧）。
 *
 * 职责：把 pi session entry（get_entries 返回 / 实时事件重构，W21）逐条投影为 chat 视图态切片。
 * 消息列表 = entry 日志的纯函数——同 entry 序列必得同 state，「live ≡ reload」从构造上成立。
 *
 * 纯度契约（验收权威 w20-acceptance.md 规格锁定 1）：
 * - 无副作用、无时序依赖：不读 Date.now / crypto.randomUUID / Math.random，
 *   消息 id 与缺失 timestamp 全部从 entry 派生（确定性），两次喂入同一序列 state 全等。
 * - 不 mutate 输入 state / entry：toolResult 回填等就地变更点全部 copy-on-write。
 *   [transient fold] replayEntries 的 fold 路径内部经 mutable collector 原地累积（见下方
 *   collector 叙事），输入 state / entry 同样不被 mutate——可变性只存在于 fold 过程内。
 * - console.warn 是可观测性（未知 role / 孤儿 toolResult），不影响确定性——与迁移前行为对齐。
 *
 * [transient fold，collector 拆段] handler 拆两段：「派生段」（deriveXxxMessage 纯函数，构造
 * Message / ToolCall）+「commit 段」（ChatStateCollector 落账）。两个 collector 实现共享同一
 * 派生段与 dispatch 骨架（ADR-0062「实时帧与文件重放喂同一 reducer」的结构性保证——分组/构造
 * 规则只有一份，防 W20/W21 曾发生的 reducer 分叉漂移）：
 * - applyEntry 单条对外 API → copy-on-write collector：每操作产新 state 引用、未变字段共享
 *   引用、no-op 返回原 state 引用——单条幂等/纯度契约逐字不变（R2-S1 断言锚定）。
 * - replayEntries fold → mutable collector：原地累积（push/add/set），n 条 entry 从每步全量
 *   拷贝的 O(n²) 降为 O(n)（runtime convertPiHistory = lift + replayEntries，getHistory 冷切入
 *   与历史 load-more 在 10k entry 会话上的真实痛点）。mutable 中间态只存在于 fold
 *   过程内，snapshot 组装产物后不再写——「内部累积、产物同构」约定，产物与 copy-on-write 路径
 *   deep-equal（元断言测试 apply-entry-fold-equivalence.test.ts 守卫），不加运行时冻结开销。
 *
 * 规则迁移源：packages/runtime/src/infra/pi/message-converter.ts 重放路径
 * （convertSinglePiMessage 的 content parts 解析 / skill block 剖离 / usage / fileChanges 静态提取、
 * convertPiHistory 的 toolResult 窗口局部配对 / compactionSummary / custom / branchSummary /
 * bashExecution 分支）。runtime 保留 wire 层职责（RPC reply → entry 列表 → 喂本 reducer，
 * 见 message-converter.ts liftHistoryToEntries），派生规则唯一实现在此（D7 投影一次）。
 *
 * [已知分叉，收敛待后续 wave] stripAnsi/normalizePiToolResult 与 runtime
 * infra/pi/normalize-tool-result.ts（event-adapter 实时路径 hook 上下文消费）仍为两份：
 * core 不依赖 runtime（包依赖方向）。W21 起 core 版已导出（effects/registry 的
 * tool_call_end overlay 收口消费，输入语义 = toolResult message body），shared 收敛
 * 留待后续 wave 统一处理。W5（2026-08-20）images 提取差异已消除——两份行为对齐
 * （此前 core 副本丢 toolResult content 的 ImageContent → 图片工具结果重开消失，
 * 破 live≡replay；审计 #3，pi-assumption-remediation）。
 *
 * 本模块群自包含约束（runtime tsup 打包 / renderer vite 消费双重入口）：本模块群
 * （apply-entry.ts + apply-entry-convert.ts + apply-entry-utils.ts）只 import
 * '@xyz-agent/shared' 与群内文件，不 import core 内群外模块（防 vue 依赖渗入 runtime bundle）。
 * 拆分布局（依赖单向 convert → utils、本文件 → utils + convert，禁止循环 import）：
 * - apply-entry-utils.ts：共享底层（normalizePiToolResult / toMs / Record 守卫 / 常量类型）
 * - apply-entry-convert.ts：message body 转换群（convertMessageBody / computeToolCallFill 等）
 * - 本文件：reducer 本体（派生段 deriveXxx / commit 段 handler / dispatch 骨架 /
 *   ChatStateCollector 两实现 / applyEntry / replayEntries）+ 对外导出面。
 */
import type {
  Message,
  PiBranchSummaryEntry,
  PiCompactionEntry,
  PiCustomEntry,
  PiCustomMessageEntry,
  PiEntry,
  PiEntryBase,
  PiMessageBody,
  PiMessageEntry,
  ToolCall,
} from '@xyz-agent/shared'
import { COMPLETE_NOTIFY_CUSTOM_TYPES } from '@xyz-agent/shared'
import { computeToolCallFill, convertMessageBody } from './apply-entry-convert'
import { CLIENT_MSG_ID_TYPE, isLooseRecord, isPlainRecord, toMs } from './apply-entry-utils'
import type { PiToolResultBody } from './apply-entry-utils'

// ── pi entry 类型（W21 下沉 shared/pi-entry.ts，此处 re-export 保持 core API 兼容）───────
//
// 下沉动机：entry 形态成为三方共用 wire 契约（runtime event-adapter 实时重构 /
// protocol.ts message.* payload 类型 / 本 reducer 输入），shared 是唯一不破坏包依赖
// 方向的归属地。类型定义与注释见 @xyz-agent/shared/pi-entry.ts。
//
// 与 runtime infra/pi/pi-protocol.ts 的 PiSessionEntry 结构兼容（TS 结构类型，runtime 侧
// 无需 import 本文件类型即可喂入）。pi 还有 thinking_level_change / model_change /
// session_info 三个 entry 类型，xyz-agent 未建模——reducer 对未建模 type 走 default no-op
// （不丢弃 entry 语义 = 不崩溃不吞整个重放，见 default 分支注释）。
//
// id 可选的原因：pi 真实 entry 恒有 id（uuidv7）；wire 层 lift 无真实 entry id 的伪消息
// （get_messages 扁平列表 / __entryId 缺失）与实时路径 message_end 重构（pi 在 emit 之后才
// appendMessage 分配 id）均为 undefined——此时 piEntryId 不回填（对齐迁移前 convertPiHistory
// 的 entryIds?.[i] ?? __entryId 解析语义），reducer 按 `e<N>` 确定性派生。
export type {
  PiEntry,
  PiEntryBase,
  PiMessageEntry,
  PiMessageBody,
  PiCustomEntry,
  PiLabelEntry,
  PiCompactionEntry,
  PiBranchSummaryEntry,
  PiCustomMessageEntry,
} from '@xyz-agent/shared'

// normalizePiToolResult 实体在 apply-entry-utils.ts（convert 侧 computeToolCallFill 同源
// 调用，依赖单向 convert → utils——实体放本文件会成环），此处 re-export 维持既有 core API
// 不变（effects/registry 继续从本模块 import，见文件头分叉注释）。NormalizedToolResult 类型
// re-export 已删（无消费方——registry 只用函数值，返回类型经推断；Gate-1.5 unused_types）。
export { normalizePiToolResult } from './apply-entry-utils'

// ── chat 视图态切片 ─────────────────────────────────────────────────

/**
 * reducer 的 state：chat 视图态切片（plan W20 步骤 1）。
 *
 * W20 重放侧从 entry 日志可推导的字段集：messages + clientUuidMap + orphanToolResults。
 * queueDepth / subagents 等 runtime 实时态不可从 entry 重放推导（W21+ 实时喂入侧扩展），
 * 按「不加推测性功能」原则不预置空字段。
 *
 * state 结构是本模块内部实现细节：构造入口只有 createInitialChatViewState 与两条 fold
 * 路径（applyEntry 单条 / replayEntries 序列），全部调用方从空 state 出发 fold。
 */
export interface ChatViewState {
  /** 重建出的消息列表（entry 日志的投影，按 apply 顺序追加） */
  messages: Message[]
  /** userEntryId → clientUuid（"xyz.client-msg-id" custom entry 累积，badge 回填查表用） */
  clientUuidMap: Map<string, string>
  /**
   * 窗口内无法配对的孤儿 toolResult。消费方在 runtime 侧增量合并阶段（session-service
   * getHistory since 增量路径：rebuildHistoryFromEntries 透出本字段 →
   * message-converter applyOrphanToolResults 按 toolCallId 回填缓存中 assistant 的
   * toolCall，W20 review Fix-1）。renderer live 链路无读取方——孤儿仅簿记残留，
   * 一致性由下次 hydrate 全量重建兜底。
   */
  orphanToolResults: PiToolResultBody[]
  /**
   * reducer 簿记：已投递过 toolResult 的 toolCallId 集合（双入口幂等去重键，R2-S1）。
   * 首次投递后记账（回填 / orphan 两分支都记），同 toolCallId 后续投递 no-op——pi 对同一
   * toolResult 双发两个事件、xyz 两条帧各喂本 reducer 一次（见 commitToolResultMessage
   * 注释），双喂入序列的效果构造性收敛为单喂入。依赖 pi 会话内 toolCallId 唯一
   * （agent-loop 以 toolCallId 索引 pending toolCalls，同 id 本身即协议异常）；reload 侧
   * pi 文件每 toolResult 只存一份 entry，簿记对重放路径无行为影响。
   */
  deliveredToolResultIds: Set<string>
  /**
   * reducer 簿记：最近一条带 toolCalls 的消息在 messages 中的下标（-1 = 无）。
   * toolResult 窗口局部配对的查找锚点（迁移前 convertPiHistory 同名局部变量语义）。
   */
  lastAssistantWithToolCalls: number
}

/** 初始 state（重放起点）。 */
export function createInitialChatViewState(): ChatViewState {
  return {
    messages: [],
    clientUuidMap: new Map(),
    orphanToolResults: [],
    deliveredToolResultIds: new Set(),
    lastAssistantWithToolCalls: -1,
  }
}

// ── 确定性派生工具（toMs / Record 守卫在 apply-entry-utils.ts）────────────────

/**
 * 本条 entry 派生 Message 的确定性 id 基。
 * entry.id 缺失（lift 的无 id 伪消息）时用「即将追加的消息下标」——同一序列内确定性且唯一
 * （真实 entry.id 是 uuidv7，与 'e<N>' 命名空间无碰撞）。
 */
function deriveBaseId(entry: PiEntryBase, messageCount: number): string {
  return entry.id ?? `e${messageCount}`
}

// ── commit 段：ChatStateCollector（state 落账抽象，两条 fold 路径的唯一分叉点）──────

/**
 * ChatViewState 落账抽象：派生段构造 Message / ToolCall 后经此提交，读口供 handler 的
 * 窗口配对 / 幂等去重 / 冲突检测查询。两个实现差异只在落账方式（copy-on-write vs 原地），
 * 派生与 dispatch 完全共享——「同一 reducer 双路喂入」的构造性保证。
 *
 * 不导出（模块内部 seam）：state 结构经 collector 收口，外部无法绕过 fold 构造 ChatViewState。
 */
interface ChatStateCollector {
  /** 当前消息数（deriveBaseId 的 `e<N>` 下标基；两实现在同一 fold 时序下值恒一致） */
  readonly messageCount: number
  /** [R2-S1] 该 toolCallId 的 toolResult 是否已投递过（双入口幂等去重键） */
  hasDeliveredToolResult(toolCallId: string): boolean
  /** 窗口局部配对锚点：最近一条带 toolCalls 的消息及其下标（无 → undefined） */
  peekLastAssistantWithToolCalls(): { index: number; message: Message } | undefined
  /** clientUuidMap 冲突检测读口：现有映射值（无 → undefined） */
  peekClientUuid(userEntryId: string): string | undefined
  /** 对话流追加一条投影消息 */
  appendMessage(msg: Message): void
  /** toolResult 回填：原位替换 host 消息（copy-on-write 下其余元素保留引用） */
  replaceMessageAt(index: number, msg: Message): void
  /** 孤儿 toolResult 收集（增量合并阶段回填消费） */
  addOrphanToolResult(orphan: PiToolResultBody): void
  /** [R2-S1] 投递记账（无 toolCallId 的畸形 body 由 handler 侧守卫不调） */
  recordDeliveredToolResult(toolCallId: string): void
  /** "xyz.client-msg-id" 映射累积（later-wins 由 handler 侧 warn 后覆写） */
  putClientUuid(userEntryId: string, clientUuid: string): void
  /** 追加的 assistant 消息带非空 toolCalls 时更新配对锚点下标 */
  markLastAssistantWithToolCalls(index: number): void
  /** fold 终点：当前累积态（copy-on-write = 链末端引用；mutable = 内部容器组装） */
  snapshot(): ChatViewState
}

/**
 * copy-on-write 实现（applyEntry 单条对外 API）：每 commit 产新 state 引用、未变字段共享
 * 引用、无 commit（no-op）时 snapshot 返回原 state 引用——与拆段前逐 handler 手写
 * `{ ...state, messages }` 形态逐字同构（幂等/纯度契约的 toBe 断言锚点）。
 */
function createCopyOnWriteCollector(state: ChatViewState): ChatStateCollector {
  let cur = state
  const commit = (patch: Partial<ChatViewState>): void => {
    cur = { ...cur, ...patch }
  }
  return {
    get messageCount() {
      return cur.messages.length
    },
    hasDeliveredToolResult(toolCallId) {
      return cur.deliveredToolResultIds.has(toolCallId)
    },
    peekLastAssistantWithToolCalls() {
      const last = cur.lastAssistantWithToolCalls
      const host = last >= 0 ? cur.messages[last] : undefined
      return host !== undefined ? { index: last, message: host } : undefined
    },
    peekClientUuid(userEntryId) {
      return cur.clientUuidMap.get(userEntryId)
    },
    appendMessage(msg) {
      commit({ messages: [...cur.messages, msg] })
    },
    replaceMessageAt(index, msg) {
      commit({ messages: cur.messages.map((m, i) => (i === index ? msg : m)) })
    },
    addOrphanToolResult(orphan) {
      commit({ orphanToolResults: [...cur.orphanToolResults, orphan] })
    },
    recordDeliveredToolResult(toolCallId) {
      commit({ deliveredToolResultIds: new Set(cur.deliveredToolResultIds).add(toolCallId) })
    },
    putClientUuid(userEntryId, clientUuid) {
      const clientUuidMap = new Map(cur.clientUuidMap)
      clientUuidMap.set(userEntryId, clientUuid)
      commit({ clientUuidMap })
    },
    markLastAssistantWithToolCalls(index) {
      commit({ lastAssistantWithToolCalls: index })
    },
    snapshot() {
      return cur
    },
  }
}

/**
 * mutable 实现（replayEntries fold）：容器原地累积，n 条 entry 的 fold 从每步全量拷贝的
 * O(n²) 降为 O(n)。构造时从 initial 浅拷贝容器——replayEntries 的 initial 参数保持「调用方
 * 持有态不被 mutate」的既有契约（copy-on-write fold 的可观察行为）；生产主路径无 initial
 * （从空 state 出发），四个空容器拷贝零成本。可变性只存在于 fold 过程内：snapshot 组装
 * 产物后 collector 即弃，产物容器不再被本模块写（内部累积、产物同构约定）。
 */
function createMutableCollector(initial: ChatViewState): ChatStateCollector {
  const messages = [...initial.messages]
  const clientUuidMap = new Map(initial.clientUuidMap)
  const orphanToolResults = [...initial.orphanToolResults]
  const deliveredToolResultIds = new Set(initial.deliveredToolResultIds)
  let lastAssistantWithToolCalls = initial.lastAssistantWithToolCalls
  return {
    get messageCount() {
      return messages.length
    },
    hasDeliveredToolResult(toolCallId) {
      return deliveredToolResultIds.has(toolCallId)
    },
    peekLastAssistantWithToolCalls() {
      const host = lastAssistantWithToolCalls >= 0 ? messages[lastAssistantWithToolCalls] : undefined
      return host !== undefined ? { index: lastAssistantWithToolCalls, message: host } : undefined
    },
    peekClientUuid(userEntryId) {
      return clientUuidMap.get(userEntryId)
    },
    appendMessage(msg) {
      messages.push(msg)
    },
    replaceMessageAt(index, msg) {
      messages[index] = msg
    },
    addOrphanToolResult(orphan) {
      orphanToolResults.push(orphan)
    },
    recordDeliveredToolResult(toolCallId) {
      deliveredToolResultIds.add(toolCallId)
    },
    putClientUuid(userEntryId, clientUuid) {
      clientUuidMap.set(userEntryId, clientUuid)
    },
    markLastAssistantWithToolCalls(index) {
      lastAssistantWithToolCalls = index
    },
    snapshot() {
      return {
        messages,
        clientUuidMap,
        orphanToolResults,
        deliveredToolResultIds,
        lastAssistantWithToolCalls,
      }
    },
  }
}

// ── 派生段（Message / ToolCall 构造纯函数，两条 fold 路径共享——分组与构造规则的唯一实现）──

/**
 * toolResult 的派生段：host 消息的回填副本（matched toolCall 换入 filled 版本，其余
 * toolCall 保留引用——迁移前 fillToolCallOutput 的 copy-on-write 形态）。
 */
function fillHostToolCall(host: Message, matched: ToolCall, body: PiMessageBody): Message {
  const fill = computeToolCallFill(body)
  const filled: ToolCall = {
    ...matched,
    output: fill.output,
    ...(fill.outputRaw !== undefined && { outputRaw: fill.outputRaw }),
    // [D6-⑧] 累积态 64KB 截断标记（computeToolCallFill 与 live overlay 同函数，live≡reload）
    ...(fill.outputTruncated && { outputTruncated: true }),
    ...(fill.isError && { status: 'error' as const }),
    ...(fill.details !== undefined && { details: fill.details }),
    ...(fill.images !== undefined && { images: fill.images }),
    // [chat-flow-timestamp U1] endTime 权威回填（= toolResult body.timestamp，缺失不设字段）：
    // live（tool_call_end/message_end 帧经 commitToolResultMessage）与 reload（replayEntries）
    // 两通路共用本函数，同源覆盖 live overlay 的 Date.now() 即时值（设计 §2.1）。
    ...(fill.endTime !== undefined && { endTime: fill.endTime }),
  }
  // matched 恒取自 host.toolCalls（调用点配对保证）；undefined 分支不可达，防御保引用
  const tcs = host.toolCalls
  if (tcs === undefined) return host
  return { ...host, toolCalls: tcs.map((t) => (t === matched ? filled : t)) }
}

/** bashExecution role：bash 是元信息非用户输入（W3 WC5）→ 带 bashExecution 字段的 system 消息。 */
function deriveBashExecutionMessage(body: PiMessageBody, baseId: string, fallbackTs: number): Message {
  // exitCode undefined → null（防 JSON 丢值，与 dispatcher 广播对称）。
  const ts = body.timestamp ?? fallbackTs
  return {
    id: baseId,
    role: 'system',
    content: '',
    status: 'complete',
    timestamp: ts,
    bashExecution: {
      command: typeof body.command === 'string' ? body.command : '',
      output: typeof body.output === 'string' ? body.output : '',
      exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
      cancelled: body.cancelled === true,
      truncated: body.truncated === true,
      excludeFromContext: body.excludeFromContext === true,
      timestamp: ts,
      ...(typeof body.fullOutputPath === 'string' && { fullOutputPath: body.fullOutputPath }),
    },
  }
}

// ── compaction / branchSummary 双形态共享构造核心（D13 联动 u6.2，行为逐字等价收敛）──
//
// message entry 的特殊 role（compactionSummary / branchSummary）与专用 entry 类型
// （compaction / branch_summary）双形态存储（见 applyMessageEntry 注释）——两对派生段
// 仅「id / ts 来源 + 字段归一」异源（调用方算好传入），Message 构造逐字同构，收敛为
// 共享构造核心；fromId 归一留在调用方（role 形态 typeof 收窄 vs entry 形态类型直传，
// 两形态语义刻意不同构）。append 由 collector 落账段统一承担（transient fold 架构）。

/** compaction 构造核心（双形态共用）：summary 缺失 → 中文 fallback「上下文已压缩」。 */
function deriveCompactionSummaryMessageCore(
  baseId: string,
  ts: number,
  summary: string | undefined,
  tokensBefore: number | undefined,
): Message {
  return {
    id: baseId,
    role: 'system',
    content: summary ?? '上下文已压缩',
    status: 'complete',
    compactionSummary: { summary, tokensBefore, timestamp: ts },
    timestamp: ts,
  }
}

/** compactionSummary role 的派生段 → system 消息 + compactionSummary 字段。 */
function deriveCompactionSummaryMessage(body: PiMessageBody, baseId: string, fallbackTs: number): Message {
  return deriveCompactionSummaryMessageCore(
    baseId,
    body.timestamp ?? fallbackTs,
    typeof body.summary === 'string' ? body.summary : undefined,
    typeof body.tokensBefore === 'number' ? body.tokensBefore : undefined,
  )
}

/**
 * custom role（pi CustomMessage，扩展经 sendMessage 注入）的派生段。details 原始透传
 * （__gui__ 等由前端消费）；display 透传（不覆写——见 dispatchMessageEntry 形态差异注释）。
 */
function deriveCustomRoleMessage(body: PiMessageBody, baseId: string, fallbackTs: number): Message {
  const ts = body.timestamp ?? fallbackTs
  return {
    id: baseId,
    role: 'system',
    content: typeof body.content === 'string' ? body.content : '',
    status: 'complete',
    customType: typeof body.customType === 'string' ? body.customType : '',
    details: isLooseRecord(body.details) ? body.details : undefined,
    timestamp: ts,
    display: body.display === true || body.display === false ? body.display : undefined,
  }
}

/** branchSummary 构造核心（双形态共用）：content 缺失 fallback 空串（summary 原值透传，'' 保留 ''）。 */
function deriveBranchSummaryMessageCore(
  baseId: string,
  ts: number,
  rawSummary: string | undefined,
  fromId: string | undefined,
): Message {
  return {
    id: baseId,
    role: 'system',
    content: rawSummary ?? '',
    status: 'complete',
    branchSummary: { summary: rawSummary, fromId, timestamp: ts },
    timestamp: ts,
  }
}

/** branchSummary role 的派生段 → system 消息 + branchSummary 字段。 */
function deriveBranchSummaryRoleMessage(body: PiMessageBody, baseId: string, fallbackTs: number): Message {
  return deriveBranchSummaryMessageCore(
    baseId,
    body.timestamp ?? fallbackTs,
    typeof body.summary === 'string' ? body.summary : undefined,
    typeof body.fromId === 'string' ? body.fromId : undefined,
  )
}

/** compaction entry 的派生段：pi 压缩记录 → system 消息 + compactionSummary 字段（SystemNotice「上下文已压缩」）。 */
function deriveCompactionEntryMessage(entry: PiCompactionEntry, baseId: string): Message {
  return deriveCompactionSummaryMessageCore(
    baseId,
    toMs(entry.timestamp),
    typeof entry.summary === 'string' ? entry.summary : undefined,
    typeof entry.tokensBefore === 'number' ? entry.tokensBefore : undefined,
  )
}

/** branch_summary entry 的派生段：summary 原值透传（'' 保留 ''，缺失 → undefined），content 缺失 fallback 空字符串。 */
function deriveBranchSummaryEntryMessage(entry: PiBranchSummaryEntry, baseId: string): Message {
  return deriveBranchSummaryMessageCore(
    baseId,
    toMs(entry.timestamp),
    typeof entry.summary === 'string' ? entry.summary : undefined,
    entry.fromId,
  )
}

/**
 * custom_message entry 的派生段：扩展经 sendMessage 注入的结构化通知 → system 消息（details
 * 原始透传，__gui__ 前端消费）。完成通知类 customType display 覆写 false（pi 可能持久化 true，
 * xyz-agent 统一隐藏——与 mapSessionEntries 引用同一 SSOT，覆写幂等）。
 */
function deriveCustomMessageEntryMessage(entry: PiCustomMessageEntry, baseId: string): Message {
  const ts = toMs(entry.timestamp)
  const isCompleteNotify = COMPLETE_NOTIFY_CUSTOM_TYPES.has(entry.customType)
  const display = entry.display === true || entry.display === false ? entry.display : undefined
  return {
    id: baseId,
    role: 'system',
    content: typeof entry.content === 'string' ? entry.content : '',
    status: 'complete',
    customType: entry.customType,
    details: isLooseRecord(entry.details) ? entry.details : undefined,
    timestamp: ts,
    display: isCompleteNotify ? false : display,
  }
}

// ── commit 段 handler（读口判定 + 派生段 → collector 落账，顺序语义与拆段前一致）────────

/**
 * toolResult role：窗口局部配对回填 host toolCall，配不上 → 孤儿收集；同 toolCallId 幂等。
 */
function commitToolResultMessage(c: ChatStateCollector, body: PiMessageBody): void {
  // [R2-S1 双入口幂等] pi 0.84.1 对同一条 toolResult 双发 tool_execution_end + message_end
  // {role:'toolResult'} 两个事件，xyz 翻译为 message.tool_call_end / message.message_end
  // 两条帧，effects/registry 两个 handler 各喂本函数一次。去重键 = deliveredToolResultIds
  // （「已投递过该 toolCallId 的 toolResult」）而非「存在该 toolCallId」：任一帧单独到达
  // （另一帧丢失）时是首次投递，照常投影——两入口任一单独到达仍正常投影的单入口契约；
  // 第二条同 id 帧整体 no-op（回填不重放、orphan 不重复收集），保留首条版本（tool_call_end
  // 恒先到，其 entry 含 hook 改写后内容、与 overlay 收口同值），故双喂入 [t_end, m_end] ≡
  // 单喂入 [t_end] 对任意帧序/丢失组合构造成立——异常时序下不再产生重复孤儿永久残留
  // （live/reload 漂移源消灭）。无 toolCallId 的畸形 toolResult 无键可去重，维持原语义。
  // [chat-flow-timestamp U3] endTime 例外（last-wins）：首条帧（tool_call_end 重构）的
  // body.timestamp 是客户端时钟，后到的 message_end 才携带 pi 权威落盘时刻——endTime 若
  // 跟随首条则 live ≠ reload（Gate A 实测：runtime 等价性 4 用例 endTime deep-equal 红）。
  // 故去重命中分支放行 endTime 单字段覆盖（copy-on-write 保持），其余字段维持首条版本
  // （两帧内容同值，见上）。
  if (typeof body.toolCallId === 'string' && c.hasDeliveredToolResult(body.toolCallId)) {
    const anchor = c.peekLastAssistantWithToolCalls()
    const matched = anchor?.message.toolCalls?.find((t) => t.id === body.toolCallId)
    if (anchor !== undefined && matched !== undefined && typeof body.timestamp === 'number') {
      const tcs = anchor.message.toolCalls
      if (tcs !== undefined) {
        c.replaceMessageAt(anchor.index, {
          ...anchor.message,
          toolCalls: tcs.map((t) => (t === matched ? { ...matched, endTime: body.timestamp } : t)),
        })
      }
    }
    return
  }
  // 窗口局部配对：只查最近一条带 toolCalls 的消息（迁移前 lastAssistantWithToolCalls 语义）
  const anchor = c.peekLastAssistantWithToolCalls()
  const matched = anchor?.message.toolCalls?.find((t) => t.id === body.toolCallId)
  if (anchor !== undefined && matched !== undefined) {
    c.replaceMessageAt(anchor.index, fillHostToolCall(anchor.message, matched, body))
  } else {
    // 孤儿：窗口内无 preceding assistant 或 toolCallId 无匹配——收集给增量合并阶段回填
    console.warn(`[apply-entry] toolResult has no matching toolCall in window: ${String(body.toolCallId)}`)
    c.addOrphanToolResult({ ...body, role: 'toolResult' })
  }
  // 投递记账：无 toolCallId 无键可去重，不记账（集合保持不变，原语义）
  if (typeof body.toolCallId === 'string') {
    c.recordDeliveredToolResult(body.toolCallId)
  }
}

/** user/assistant role：convertMessageBody 转换（convert 侧 SSOT）+ lastAssistantWithToolCalls 簿记更新。 */
function commitUserAssistantMessage(
  c: ChatStateCollector,
  body: PiMessageBody,
  entryId: string | undefined,
  baseId: string,
  fallbackTs: number,
): void {
  const msg = convertMessageBody(body, entryId, baseId, fallbackTs)
  if (!msg) return
  c.appendMessage(msg)
  if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
    c.markLastAssistantWithToolCalls(c.messageCount - 1)
  }
}

/**
 * custom entry：纯数据 entry 不进对话流。xyz.client-msg-id 累积 clientUuidMap（badge
 * 回填查表）。data 形状不匹配（缺字段/类型错）→ 跳过（降级不崩溃）；冲突 later-wins
 * （warn 防御）。
 */
function commitClientMsgIdEntry(c: ChatStateCollector, entry: PiCustomEntry): void {
  if (entry.customType !== CLIENT_MSG_ID_TYPE) return
  const data = entry.data
  if (!isPlainRecord(data) || typeof data.clientUuid !== 'string' || typeof data.userEntryId !== 'string') {
    return
  }
  const existing = c.peekClientUuid(data.userEntryId)
  if (existing !== undefined && existing !== data.clientUuid) {
    console.warn(
      `[apply-entry] clientUuidMap conflict for userEntryId=${data.userEntryId}: ` +
        `existing=${existing}, new=${data.clientUuid} (later wins)`,
    )
  }
  c.putClientUuid(data.userEntryId, data.clientUuid)
}

// ── dispatch 骨架（entry → 派生段/commit 段分派，两条 fold 路径的唯一入口）────────────

/**
 * message entry 的 role 细分分派。
 *
 * pi AgentMessage 联合镜像：user/assistant/toolResult/bashExecution/compactionSummary/
 * custom/branchSummary。后三个特殊 role 与专用 entry 类型（compaction/branch_summary/
 * custom_message）双形态存储（session-manager 持久化为 message entry / 专用 entry 均存在；
 * get_messages / mapSessionEntries 的 message-entry 透传路径会以本形态到达）。
 * 语义与专用 entry case 的差异只有一点：display 覆写归专用 custom_message entry case
 * （mapSessionEntries SSOT 同规则），message-role 形态到达时上游已完成或不适用覆写——
 * 迁移前 convertPiHistory 同行为。
 */
function dispatchMessageEntry(c: ChatStateCollector, entry: PiMessageEntry): void {
  const body = entry.message
  const entryId = entry.id
  const baseId = deriveBaseId(entry, c.messageCount)
  const fallbackTs = toMs(entry.timestamp)
  switch (body.role) {
    case 'toolResult':
      commitToolResultMessage(c, body)
      return
    case 'bashExecution':
      c.appendMessage(deriveBashExecutionMessage(body, baseId, fallbackTs))
      return
    case 'compactionSummary':
      c.appendMessage(deriveCompactionSummaryMessage(body, baseId, fallbackTs))
      return
    case 'custom':
      c.appendMessage(deriveCustomRoleMessage(body, baseId, fallbackTs))
      return
    case 'branchSummary':
      c.appendMessage(deriveBranchSummaryRoleMessage(body, baseId, fallbackTs))
      return
    case 'user':
    case 'assistant':
      commitUserAssistantMessage(c, body, entryId, baseId, fallbackTs)
      return
    default: {
      // 显式拒绝未知 role（W11 语义）：非已建模 role 不默认归 assistant，防数据异常被掩盖
      console.warn(`[apply-entry] unknown role: ${String(body.role)}, skipping`)
      return
    }
  }
}

/**
 * 单条 pi entry → chat 视图态切片的投影 dispatch（D5）。
 *
 * 按 entry type 分派（message 经 dispatchMessageEntry 按 role 细分），applyEntry /
 * replayEntries 两条 fold 路径共用——「live ≡ reload」两条链路共用同一 dispatch 与派生段。
 *
 * case 覆盖（pi SessionEntry 全集）：message（role 细分 user/assistant/toolResult/
 * bashExecution/compactionSummary/custom/branchSummary）/ custom / label / compaction /
 * branch_summary / custom_message；未建模类型（thinking_level_change / model_change /
 * session_info / 未来的新类型）走 default no-op——「converter 不丢弃任何 pi entry 类型」
 * （父文档规则 #9）指不崩溃、不中断重放、不静默吞掉后续 entry；元数据类 entry 本身不产出
 * 对话流消息。
 */
function dispatchEntry(c: ChatStateCollector, entry: PiEntry): void {
  switch (entry.type) {
    case 'message':
      dispatchMessageEntry(c, entry)
      return
    case 'compaction':
      c.appendMessage(deriveCompactionEntryMessage(entry, deriveBaseId(entry, c.messageCount)))
      return
    case 'branch_summary':
      c.appendMessage(deriveBranchSummaryEntryMessage(entry, deriveBaseId(entry, c.messageCount)))
      return
    case 'custom_message':
      c.appendMessage(deriveCustomMessageEntryMessage(entry, deriveBaseId(entry, c.messageCount)))
      return
    case 'custom':
      commitClientMsgIdEntry(c, entry)
      return
    case 'label': {
      // 用户书签/标记：重放侧无对话流投影，显式 no-op（规则 #9：有 case、不丢弃、不崩溃）。
      return
    }
    default: {
      // 未建模 entry 类型（thinking_level_change / model_change / session_info / pi 未来新增）
      // → no-op。重放不中断，后续 entry 照常投影；类型清单见 pi session-manager.ts SessionEntry。
      return
    }
  }
}

// ── 对外 API（签名与产物结构不变；两条 fold 路径只差 collector 实现）────────────────

/**
 * 单条 pi entry → chat 视图态切片的纯函数投影（D5）。
 *
 * 对外契约不变——applyEntry 仍是唯一单条喂入入口，「live ≡ reload」两条链路共用本入口。
 * copy-on-write：输入 state / entry 不被 mutate；no-op entry（label / 未建模类型 / 幂等去重
 * 命中 / custom 形状不匹配）返回原 state 引用。
 */
export function applyEntry(state: ChatViewState, entry: PiEntry): ChatViewState {
  const collector = createCopyOnWriteCollector(state)
  dispatchEntry(collector, entry)
  return collector.snapshot()
}

/**
 * 逐条 fold entry 序列 → 最终视图态（重放驱动器）。
 *
 * 文件重放路径（getHistory → hydrate，W20）与实时 feed（W21）共用的喂入形态：
 * `entries.reduce(applyEntry, initial ?? createInitialChatViewState())` 的显式封装。
 *
 * [transient fold] 内部经 mutable collector 原地累积（O(n)，见文件头 collector 叙事），
 * 与 `entries.reduce(applyEntry, ...)`（copy-on-write 路径）产物 deep-equal——元断言测试
 * apply-entry-fold-equivalence.test.ts 守卫。输入 entries / initial 不被 mutate。
 */
export function replayEntries(entries: PiEntry[], initial?: ChatViewState): ChatViewState {
  const collector = createMutableCollector(initial ?? createInitialChatViewState())
  for (const entry of entries) {
    dispatchEntry(collector, entry)
  }
  return collector.snapshot()
}
