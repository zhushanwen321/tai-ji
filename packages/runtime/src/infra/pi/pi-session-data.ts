/**
 * pi 会话数据模型（RPC 响应 data 字段的类型）。
 *
 * [pi-protocol.ts max-lines 拆分承载] 承载两个内聚区段：
 * - get_messages 响应的历史消息族（PiHistoryMessage*）；
 * - get_entries 响应的 session entry 树（PiSessionEntry* + GetEntriesCommand/GetEntriesResponse）。
 *
 * 与 pi-protocol.ts 主体的 wire 消息协议（input command / response / unsolicited event）
 * 是正交关注点：事件流协议与会话持久化数据模型各自演化。归属约束同 pi-protocol.ts
 * （R1 三层架构）：pi 外部系统的协议类型，只允许 infra/pi 层内部使用；既有消费方经
 * pi-protocol.ts 的 re-export 导入（import 路径不变）。
 */
// PiUsage（wire usage 结构）留驻 pi-protocol.ts；本文件纯类型，import type 保持零运行时依赖。
import type { PiUsage } from './pi-protocol.js'

// ── get_messages response data ─────────────────────────────────────

/**
 * Shape of the `data` field in a get_messages response.
 *
 * GOTCHA: pi puts the messages array under `data.messages`,
 * NOT under `payload.messages`. The top-level response has
 * type: 'response' and the history is nested in `data`.
 */
export interface PiGetMessagesData { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  messages: PiHistoryMessage[]
}

/** A single message in pi's conversation history.
 * pi 1.0.0 起 role 联合新增 'system'（系统提示词与工具集变更的持久化消息，
 * 经 message_end 事件 + appendMessage 落盘；锚点 agent-session.js message_end
 * 持久化分支 role==='system' 走 appendMessage）。taiji 对话流跳过 system 消息
 *（event-adapter message_start/end 分流 + apply-entry reducer 不产渲染项）。 */
export interface PiHistoryMessage {
  role: 'user' | 'assistant' | 'toolResult' | 'system'
  content: PiHistoryContentPart[]
  timestamp?: number
  stopReason?: string
}

/** Content parts within a pi history message. */
export type PiHistoryContentPart =
  | PiHistoryTextPart
  | PiHistoryThinkingPart
  | PiHistoryToolCallPart

export interface PiHistoryTextPart { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  type: 'text'
  text: string
}

export interface PiHistoryThinkingPart { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  type: 'thinking'
  thinking: string
}

export interface PiHistoryToolCallPart { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  type: 'toolCall' | 'tool_use'
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** toolResult messages represent tool execution outcomes in history. */
export interface PiHistoryToolResult extends PiHistoryMessage { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  role: 'toolResult'
  toolCallId: string
  toolName: string
  isError?: boolean
  /** pi 持久化了 details（ToolResultMessage.details），含 __gui__ 结构化渲染数据。
   *  类型声明补齐——pi JSONL 和 get_messages 都返回此字段。 */
  details?: Record<string, unknown>
}

// ── get_entries response data (pi session entry tree) ──────────────

/**
 * pi session entry 树的节点（get_entries RPC 返回的 entries 数组元素）。
 *
 * 对应 pi 源码 `SessionEntry` 联合（session-manager.ts:140-150）。pi 的 entry 树是
 * 会话的完整持久化形态：message/custom/label/compaction/branch_summary 等都作为
 * entry 节点存储，通过 parentId 串成树。
 *
 * taiji 当前只消费 message entry（重建历史）+ custom entry "taiji.client-msg-id"
 * （clientUuid ↔ userEntryId 映射），其余 entry 类型声明齐全以备未来扩展，
 * 但 rebuildHistoryFromEntries 当前跳过不处理。
 *
 * 类型以 pi 源码为准（session-manager.ts:46-149）。pi 还定义了 thinking_level_change /
 * model_change / custom_message / session_info 等 entry 类型——这里只建模 taiji
 * 可能消费的子集，未建模的 entry 在 rebuildHistoryFromEntries 中按 unknown 跳过。
 */
export type PiSessionEntry =
  | PiSessionMessageEntry
  | PiSessionCustomEntry
  | PiSessionLabelEntry
  | PiSessionCompactionEntry
  | PiSessionBranchSummaryEntry
  | PiSessionCustomMessageEntry
  | PiSessionUsageEntry
  | PiSessionContextEditEntry

/**
 * 所有 entry 的公共字段（对应 pi SessionEntryBase，session-manager.ts:46-51）。
 *
 * - id：pi 生成的随机 id。pi 源码用 uuidv7（session-manager.ts:1 import），不是早期文档
 *   说的 randomUUID slice(0,8)——以 pi 源码为准。session 内唯一，是 entry 树节点的主键。
 * - parentId：父节点 id，根 entry 为 null。pi 的 entry 是 append-only，parentId 构成树。
 * - timestamp：ISO string（pi 持久化格式），注意与 PiHistoryMessage.timestamp（number ms）不同。
 *
 * 注意：base.type 是 string（loose），但每个具体 entry 子接口都用字面量 type 重声明
 * （如 type: 'message'），使 PiSessionEntry 联合支持 discriminated union narrowing
 * （`entry.type === 'custom'` 后 TS 能收窄到 PiSessionCustomEntry）。
 */
export interface PiSessionEntryBase {
  type: string
  id: string
  parentId: string | null
  timestamp: string
}

/**
 * message entry（user/assistant/toolResult 消息）。对应 pi SessionMessageEntry。
 *
 * message 字段复用 PiHistoryMessage（pi AgentMessage 在 taiji 侧的镜像类型），
 * 形状与 get_messages 返回的 messages 元素一致（role/content/timestamp/...）。
 */
export interface PiSessionMessageEntry extends PiSessionEntryBase { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  type: 'message'
  message: PiHistoryMessage
}

/**
 * custom entry（extension 通过 pi.appendEntry 写入，不进 LLM 上下文）。
 * 对应 pi CustomEntry（session-manager.ts:106-114）。
 *
 * taiji 的 taiji.client-msg-id extension 写入的 custom entry data 结构：
 * `{ clientUuid: string, userEntryId: string }`，userEntryId 指向同一次提交的 user message entry。
 * 消费侧（entry-tree-builder）按 customType 过滤后断言 data 形状。
 *
 * pi 源码 data 字段是 `data?: T`（可选泛型），此处用 unknown + 必填，因为 taiji 写入的
 * custom entry 恒有 data；pi 其他 extension 写入的 custom entry 由消费侧自行断言。
 */
export interface PiSessionCustomEntry extends PiSessionEntryBase { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  type: 'custom'
  customType: string
  data: unknown
}

/**
 * label entry（pi setLabel 写入，用户书签/标记）。对应 pi LabelEntry（session-manager.ts:118-123）。
 *
 * pi 源码字段名是 targetId（指向被标记的 entry），不是 entryId——以 pi 源码为准。
 * 当前 taiji 不消费 label entry，声明齐全以备未来扩展。
 */
export interface PiSessionLabelEntry extends PiSessionEntryBase { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  type: 'label'
  label: string | undefined
  targetId: string
}

/**
 * compaction entry（compact 产生的摘要）。对应 pi CompactionEntry（session-manager.ts:74-86）。
 * type 是字面量 'compaction'（pi 源码定义），保证联合 narrowing 正确。
 * 当前 taiji 不消费此 entry（历史重建走 message entry + JSONL sidecar）。
 */
export interface PiSessionCompactionEntry extends PiSessionEntryBase { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  type: 'compaction'
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  /** Extension-specific data（如 ArtifactIndex、结构化 compaction 版本标记）。 */
  details?: unknown
  /** True if generated by an extension。 */
  fromHook?: boolean
}

/**
 * branch_summary entry（branch 产生的摘要）。对应 pi BranchSummaryEntry（session-manager.ts:88-96）。
 * type 是字面量 'branch_summary'（pi 源码定义），保证联合 narrowing 正确。
 * 当前 taiji 不消费此 entry。
 */
export interface PiSessionBranchSummaryEntry extends PiSessionEntryBase { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  type: 'branch_summary'
  fromId: string
  summary: string
  /** Extension-specific data（不进 LLM 上下文）。 */
  details?: unknown
  /** True if generated by an extension。 */
  fromHook?: boolean
}

/**
 * custom_message entry（扩展经 pi sendMessage 注入的结构化通知，持久化进 session JSONL）。
 * 对应 pi CustomMessageEntry（session-manager.ts:866）。
 *
 * 与 custom entry（type:'custom'）的区别：custom_message 进 LLM 上下文 + 对话流渲染，
 * custom entry 是纯扩展数据（不进 LLM 上下文）。mapSessionEntries 据此分流：
 * custom_message → messages（伪消息），custom → customDataEntries。
 *
 * display:false 时 taiji 不渲染（core message-turns 分组管线：display===false 消息透明跳过、
 * 不产出渲染项，完成通知类则作 turn 边界触发器）；完成通知类 customType
 *（subagent-bg-notify/workflow-result）由 mapSessionEntries 引用 COMPLETE_NOTIFY_CUSTOM_TYPES
 * 覆写为 display:false（pi 可能持久化 display:true，taiji 统一隐藏）。
 */
export interface PiSessionCustomMessageEntry extends PiSessionEntryBase { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  type: 'custom_message'
  customType: string
  content: string
  display?: boolean
  details?: Record<string, unknown>
}

/**
 * usage entry（pi 1.0.0 新增：模型产生的非对话操作用量，不进 LLM 上下文）。
 * 对应 pi UsageEntry（session-manager.js appendUsage 字面量：kind/provider/model/usage/note）。
 * 当前已知 kind = 'cache_warm'（缓存保活请求）。taiji 消费：usage-stats-service 第 ⑤ 分类
 * 计入用量页成本合计（不接入则 taiji 统计与 pi 自身统计口径出现缺口）；对话流不显示。
 */
export interface PiSessionUsageEntry extends PiSessionEntryBase { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  type: 'usage'
  kind: string
  provider: string
  model: string
  usage: PiUsage
  note?: string
}

/**
 * context_edit entry（pi 1.0.0 新增：branch 内对更早 model 可见 entry 的编辑记录，不进 LLM
 * 上下文——pi 官方语义是原始历史不变，重放时在投影层应用替换）。对应 pi ContextEditEntry
 *（session-manager.js appendContextEdit 字面量：targetId/replacement）。
 * replacement = null（删除语义）或 { content: string | content parts 数组 }。
 * taiji 当前对话流不显示（原始历史不变的投影语义，PS-60 树重放链路按 unknown 跳过）。
 */
export interface PiSessionContextEditEntry extends PiSessionEntryBase { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  type: 'context_edit'
  targetId: string
  replacement: null | { content: string | PiHistoryContentPart[] }
}

/**
 * get_entries RPC 请求（对应 pi rpc-types.ts:63 `{ type: "get_entries"; since?: string }`）。
 *
 * since 可选：传 entry id 时返回该 entry 之后的所有 entry（增量拉取，pi rpc-mode.ts:614-620
 * 用 findIndex + slice 实现，找不到 since id 时报错 "Entry not found"）。
 * 不传 since 时返回全部 entry（全量拉取）。
 */
export interface GetEntriesCommand { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  type: 'get_entries'
  since?: string
}

/**
 * get_entries RPC 响应的 data 字段（对应 pi rpc-mode.ts:622 返回结构）。
 *
 * - entries：session 所有 entry（since 指定时为该 entry 之后的子集），含全部 entry 类型。
 * - leafId：session 当前叶子 entry id（pi sessionManager.getLeafId()，branch 后指向新叶子，
 *   空 session 为 null）。
 */
export interface GetEntriesResponse { // oe-exempt:20261004:framework:存量 pi 会话数据模型接口随 max-lines 拆分迁移自 pi-protocol.ts，非新增单实现设计
  entries: PiSessionEntry[]
  leafId: string | null
}
