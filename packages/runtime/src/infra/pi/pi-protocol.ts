/**
 * pi RPC protocol type definitions.
 *
 * pi communicates via JSONL over stdin/stdout in --mode rpc.
 * Each line is a JSON object with an `id` (for request/response correlation)
 * or no `id` (for unsolicited events).
 *
 * 🔒 **归属（R1，三层架构）**：这是 pi 外部系统的协议类型，只允许在
 * `infra/` 层内部使用。services/transport 不得 import 此文件——它们只见
 * 翻译后的内部类型。从根级 `types.ts` 迁入（原 444 行拆分）。
 *
 * GOTCHAS (field naming — these are pi's canonical field names, not drift):
 * - prompt command uses `message` field, NOT `content`
 * - get_messages response puts history in `data` field, NOT `payload`
 * - tool_execution_start uses `args` (pi 的规范字段名，非漂移——pi 从不发 input)
 * - tool_execution_end uses `result` (pi 的规范字段名，非漂移——pi 从不发 output)
 * - message_update.toolcall_* events are incomplete; prefer tool_execution_* instead
 *   (唯一例外：toolcall_end.toolCall.id 供 contentIndex 顺序锚点提取)
 *
 * 本文件是 pi 协议的真契约（ADR-0037）。PiEvent 联合覆盖 AgentSessionEvent 全部事件类型，
 * pi 升级时需同步维护（编译器 exhaustive check 会提示）。
 */
// ThinkingLevel 值域双向防漂移锁的比对对象（import type：类型位置消费，保持本文件零运行时依赖）。
import type { PI_THINKING_LEVELS } from '@taiji/shared'

// ── Base types ─────────────────────────────────────────────────────

/** Every RPC message has at least a `type` discriminator. */
export interface PiBaseMessage {
  /** Correlation id — present on request/response pairs, absent on events. */
  id?: string
  type: string
}

// ── Input messages (client → pi via stdin) ─────────────────────────

export interface PiPromptCommand extends PiBaseMessage {
  id: string
  type: 'prompt'
  /** pi uses "message" here, NOT "content". */
  message: string
}

export interface PiAbortCommand extends PiBaseMessage {
  id: string
  type: 'abort'
}

export interface PiSetModelCommand extends PiBaseMessage {
  id: string
  type: 'set_model'
  provider: string
  modelId: string
}

export interface PiGetAvailableModelsCommand extends PiBaseMessage {
  id: string
  type: 'get_available_models'
}

export interface PiGetMessagesCommand extends PiBaseMessage {
  id: string
  type: 'get_messages'
}

export interface PiNewSessionCommand extends PiBaseMessage {
  id: string
  type: 'new_session'
}

export interface PiSwitchSessionCommand extends PiBaseMessage {
  id: string
  type: 'switch_session'
  sessionPath: string
}

export type PiInputMessage =
  | PiPromptCommand
  | PiAbortCommand
  | PiSetModelCommand
  | PiGetAvailableModelsCommand
  | PiGetMessagesCommand
  | PiNewSessionCommand
  | PiSwitchSessionCommand

// ── Response messages (pi → client) ────────────────────────────────

export interface PiResponse extends PiBaseMessage {
  id: string
  type: 'response'
  /** The original command type that triggered this response. */
  command: string
  success: boolean
  error?: string
  /** Response payload. For get_messages, the history lives here under `data.messages`. */
  data?: unknown
}

// ── Event messages: agent lifecycle ────────────────────────────────

export interface PiAgentStartEvent extends PiBaseMessage {
  type: 'agent_start'
}

export interface PiAgentEndEvent extends PiBaseMessage {
  type: 'agent_end'
  /** All messages accumulated during this agent run. */
  messages: PiAgentEndMessage[]
  /** pi 始终发送：本次 agent 循环结束是否将自动重试（pi agent-session.ts AgentSessionEvent.agent_end）。 */
  willRetry: boolean
  // [W6 A-10 探针 2026-08-20] taiji 不消费 willRetry 是安全的：真实 pi 0.84.1 实测（rpc + 500 provider
  // 触发 auto-retry，退避窗口内抢发 prompt），retry 全程 session.isStreaming=true（isStreaming =
  // _isAgentRunActive，仅 _runAgentPrompt finally 的 _emitAgentSettled 复位——agent-session.js:327-328,744-754），
  // 窗口内新 prompt 被 pi 拒绝（"Agent is already processing..."，agent-session.js:831-836）→ runtime prompt
  // catch 按拒绝分型收口（message-dispatcher.ts handlePromptFailure，无数据竞争）：busy 类（'processing' /
  // 'compacting'）转 send.rejected 广播，非 busy 真失败才走 message.error + isGenerating 复位；
  // [session-dead 2026-09-10] 'processing'（本条窗口）不视为空闲——以 pi 的拒绝为权威信号恢复占用
  //（isGenerating=true + occupancy turn:'generating'），前端占用短路生效、defer 队列不再按 idle 1s 重投。
  // 原「已知 UX 瑕疵（登记不修）：retry 窗口内 UI 视为空闲（isGenerating 已被首个 agent_end 复位），
  // 用户发消息会收到 pi 英文错误而非 busy 拒绝」[session-dead 2026-09-10 已收口]：该窗口内的发送尝试现经
  // 上述分型处理（中文拒绝提示 + 占用转 generating，由前端排队等待 pi 真正 settle），不再泄漏 pi 英文
  // 错误、也不再产生 idle 帧驱动的 1s 重投环。注：0.80.3 旧版 isStreaming = agent.state.isStreaming（loop 级），
  // retry 窗口为 false——审计 A-10 的竞争前提来自旧 clone 语义，0.84.1 已不可复现。
}

/** A message object within agent_end — mirrors the shape from message_end. */
export interface PiAgentEndMessage {
  role: string
  content: unknown
  stopReason?: string
  usage?: PiUsage
}

export interface PiTurnStartEvent extends PiBaseMessage {
  type: 'turn_start'
}

/**
 * turn_end — 单个 turn 结束。pi 0.80.3 事件模型：1 agent 循环 = N 个 turn，
 * 每 turn_end 带 message.usage（本 turn 用量）+ toolResults（本 turn 的工具产出）。
 */
export interface PiTurnEndEvent extends PiBaseMessage {
  type: 'turn_end'
  /** 本 turn 的 assistant 消息（含 usage）。形状与 PiAgentEndMessage 一致。 */
  message: PiTurnEndMessage
  /** 本 turn 内执行完成的工具结果列表。 */
  toolResults: PiToolResultMessage[]
}

/** Assistant message carried by turn_end — mirrors PiAgentEndMessage shape. */
export interface PiTurnEndMessage {
  role: string
  content: unknown
  usage?: PiUsage
  stopReason?: string
}

/**
 * Tool result message carried by turn_end.toolResults — lightweight declaration.
 * content 用 unknown[] 逃生（taiji 不消费 turn_end 的 toolResults 内容字段）。
 */
export interface PiToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: unknown[]
  isError?: boolean
  details?: Record<string, unknown>
}

// ── Event messages: message lifecycle ──────────────────────────────

export interface PiMessageStartEvent extends PiBaseMessage {
  type: 'message_start'
  message: {
    role: string
    content: unknown
    usage?: PiUsage
    stopReason?: string
  }
}

export interface PiMessageEndEvent extends PiBaseMessage {
  type: 'message_end'
  message: {
    role: string
    content: unknown
    usage?: PiUsage
    stopReason?: string
  }
}

// ── Event messages: streaming content (message_update) ─────────────

/**
 * message_update wraps an inner assistantMessageEvent.
 *
 * IMPORTANT: toolcall_start/toolcall_delta/toolcall_end sub-types carry
 * INCOMPLETE data (missing full arguments). Always use tool_execution_*
 * events instead for tool call information——唯一例外：toolcall_end.toolCall.id
 * 是 contentIndex 顺序锚点的来源（tool_execution_* 无 contentIndex，见
 * event-adapter handleMessageUpdate 的 toolcall_end 分支）。
 */
export interface PiMessageUpdateEvent extends PiBaseMessage {
  type: 'message_update'
  /**
   * wire 形态（W3 实测锁定）：`{type, assistantMessageEvent, usage?}`——顶层 message 恒不存在。
   * pi 内部事件确带完整 partial message（agent-session.js:473-479），但 RPC wire 经
   * toJsonEvent（dist/modes/json-event.js:3-15）对 message_update 只输出 {type, assistantMessageEvent}
   * 并剥离 assistantMessageEvent.partial。旧声明 `message?: {...}`（供 toolcall_start 提取
   * toolCallId）据此写成——生产恒 undefined，tool-call-index 恒不产出（单测 mock 自带 message
   * 字段故测试绿生产死，W3 审计 A-01）。toolCallId 的真实提取点 = toolcall_end 的
   * toolCall.id（见 PiToolcallEndSubEvent）。
   */
  usage?: PiUsage
  assistantMessageEvent: PiAssistantMessageSubEvent
}

export type PiAssistantMessageSubEvent =
  | PiTextStartSubEvent
  | PiTextDeltaSubEvent
  | PiTextEndSubEvent
  | PiThinkingStartSubEvent
  | PiThinkingDeltaSubEvent
  | PiThinkingEndSubEvent
  | PiToolcallStartSubEvent
  | PiToolcallDeltaSubEvent
  | PiToolcallEndSubEvent
  | PiErrorSubEvent

export interface PiTextStartSubEvent {
  type: 'text_start'
  contentIndex?: number
}

export interface PiTextDeltaSubEvent {
  type: 'text_delta'
  delta: string
  contentIndex?: number
}

export interface PiTextEndSubEvent {
  type: 'text_end'
  contentIndex?: number
}

export interface PiThinkingStartSubEvent {
  type: 'thinking_start'
  contentIndex?: number
}

export interface PiThinkingDeltaSubEvent {
  type: 'thinking_delta'
  delta: string
  contentIndex?: number
}

export interface PiThinkingEndSubEvent {
  type: 'thinking_end'
  contentIndex?: number
}

/**
 * INCOMPLETE: use tool_execution_end instead.
 * The toolCall object here may not have complete arguments.
 */
export interface PiToolcallStartSubEvent {
  type: 'toolcall_start'
  /**
   * wire 形态（W3 实测锁定）：{type, contentIndex}——无 id。
   * pi-ai AssistantMessageEvent.toolcall_start 声明带 partial（AssistantMessage，id 在
   * partial.content[contentIndex].id，pi-ai types.d.ts:397-400），但 RPC wire 的 toJsonEvent
   * 剥离 partial（dist/modes/json-event.js:6-10）→ 此事件上拿不到 toolCallId。
   * toolCallId 提取点 = toolcall_end（见 PiToolcallEndSubEvent）。
   */
  contentIndex?: number
}

/** INCOMPLETE: use tool_execution_* instead. */
export interface PiToolcallDeltaSubEvent {
  type: 'toolcall_delta'
  delta: string
  contentIndex?: number
}

/**
 * INCOMPLETE: use tool_execution_end instead.
 * The toolCall object here may not have complete arguments.
 *
 * toolCallId 顺序锚点的唯一 wire 提取点（W3）：toolCall 是非 partial 字段，toJsonEvent
 * 剥离 partial 时保留（pi-ai types.d.ts:405-409 `{type:'toolcall_end', contentIndex,
 * toolCall: ToolCall, partial}`，ToolCall 含 id/name/arguments，types.d.ts:244-250）。
 * 实测 0.84.1：toolCall.id 与后续 tool_execution_start.toolCallId 同值。
 */
export interface PiToolcallEndSubEvent {
  type: 'toolcall_end'
  contentIndex?: number
  toolCall?: {
    id: string
    name: string
    arguments: Record<string, unknown>
  }
}

/**
 * 流式错误/中止终结事件（code-harden RT-2#2）：wire 实发 `{type:'error', reason, error}`，
 * 权威源 = @earendil-works/pi-ai 0.84.4 dist/types.d.ts AssistantMessageEvent 的 error 变体
 * （`reason: 'aborted'|'error'`，`error` 是终态 AssistantMessage，人类可读文本在其
 * `errorMessage` 字段）。RPC wire 的 toJsonEvent 只剥 `partial`，error 变体无 partial
 * 不受影响。wire 上没有 `content` 字段——旧本地声明 `content?: string` 使恒 undefined
 * 的读取被 as 转换掩盖，provider 真错文本（401/限流/上下文溢出）永不显形。
 * `error?` 局部形态 = 仅登记 adapter 消费的 errorMessage（完整 AssistantMessage 见 pi-ai），
 * 可选风格对齐 PiToolcallEndSubEvent.toolCall 的局部形态先例。
 */
export interface PiErrorSubEvent {
  type: 'error'
  reason: 'aborted' | 'error'
  error?: {
    errorMessage?: string
  }
}

// ── Event messages: tool execution ─────────────────────────────────

/**
 * Tool execution start — provides the canonical tool call info.
 * pi 用 `args` 是规范字段名（非漂移，ADR-0037）。
 */
export interface PiToolExecutionStartEvent extends PiBaseMessage {
  type: 'tool_execution_start'
  toolCallId: string
  toolName: string
  /** pi 的规范字段名（pi 从不发 input）。 */
  args: Record<string, unknown>
}

export interface PiToolExecutionUpdateEvent extends PiBaseMessage {
  type: 'tool_execution_update'
  toolCallId: string
  toolName: string
  /**
   * pi 声明为 any（types.ts），运行时形态不定：可能是 string，也可能是 AgentToolResult 对象。
   * event-adapter handleToolExecutionUpdate 按 typeof 判定两种形态。用 unknown 镜像 any 语义，
   * 不强制具体类型（pi 不保证形态）。
   */
  partialResult: unknown
}

/**
 * Tool execution end — provides the canonical tool result.
 * pi 用 `result` 是规范字段名（非漂移，ADR-0037）。pi 从不发 output。
 *
 * 注意：pi tool_execution_end **从不发 args**（pi types.ts:430 定义无此字段）。
 * write 工具的 content 在 tool_execution_start 事件里（types.ts:428 args: any）。
 * event-adapter handleToolExecutionEnd 曾据此提取 writeContent 但恒为 undefined，死代码已删除
 * （W-R2）。EventInterpreter 的 writeContents 累积因此不生效，待后续迁移到 tool_execution_start 路径恢复。
 */
export interface PiToolExecutionEndEvent extends PiBaseMessage {
  type: 'tool_execution_end'
  toolCallId: string
  toolName: string
  /** pi 的规范字段名（pi 从不发 output）。 */
  result: PiToolExecutionResult
  /** pi 必填字段（agent-session.ts 始终发送）。 */
  isError: boolean
}

/**
 * pi's tool result shape — mirrors pi AgentToolResult<T>（types.ts:350-362）。
 * content 是 TextContent|ImageContent 块数组；details 是工具自定义结构（泛型 T 的实参，
 * taiji 不消费其字段，故用 unknown）；addedToolNames/terminate 为可选控制字段。
 */
export interface PiToolExecutionResult {
  content: Array<PiTextContentBlock | PiImageContentBlock>
  /** 工具自定义结构化数据（对应 AgentToolResult.details: T）。 */
  details: unknown
  /** 工具动态注册的新工具名（对应 AgentToolResult.addedToolNames）。 */
  addedToolNames?: string[]
  /** 是否终止 agent 循环（对应 AgentToolResult.terminate）。 */
  terminate?: boolean
}

/** Text content block in a tool result. */
export interface PiTextContentBlock {
  type: 'text'
  text: string
}

/** Image content block in a tool result. */
export interface PiImageContentBlock {
  type: 'image'
  data: string
  mimeType: string
}

// ── Event messages: session / agent lifecycle (pi 0.80.3+) ─────────

/** Compaction 触发原因。 */
export type PiCompactionReason = 'manual' | 'threshold' | 'overflow'

/** Compaction 开始事件。 */
export interface PiCompactionStartEvent extends PiBaseMessage {
  type: 'compaction_start'
  reason: PiCompactionReason
}

/**
 * pi CompactionResult 的协议镜像（compaction_end 事件的 result 字段形状）。
 *
 * 字段全可选——事件路径下 aborted/error 时 result 可能缺失或部分字段未填；
 * event-interpreter.handleCompactionEnd 用 `if (ev.result)` 守卫后读
 * summary/tokensBefore/estimatedTokensAfter（M4 事件驱动）。
 *
 * 与 services/ports/pi-engine.ts 的 PiCompactionResult 区别：后者是 compact RPC
 * 成功返回契约（summary/firstKeptEntryId/tokensBefore 必填），本类型是事件路径
 * 的宽松形状（全可选，兼容 aborted）。两者镜像同一个 pi 内部 CompactionResult。
 */
export interface PiCompactionResult {
  summary?: string
  firstKeptEntryId?: string
  tokensBefore?: number
  estimatedTokensAfter?: number
  usage?: unknown
  details?: unknown
}

/**
 * Compaction 结束事件。result 收紧为 PiCompactionResult（M5，S5）——event-adapter
 * handleCompactionEnd 原样透传，event-interpreter 读 summary/tokensBefore/estimatedTokensAfter。
 */
export interface PiCompactionEndEvent extends PiBaseMessage {
  type: 'compaction_end'
  reason: PiCompactionReason
  result?: PiCompactionResult
  aborted: boolean
  willRetry: boolean
  errorMessage?: string
}

/** 自动重试开始事件。 */
export interface PiAutoRetryStartEvent extends PiBaseMessage {
  type: 'auto_retry_start'
  attempt: number
  maxAttempts: number
  delayMs: number
  errorMessage: string
}

/** 自动重试结束事件。 */
export interface PiAutoRetryEndEvent extends PiBaseMessage {
  type: 'auto_retry_end'
  success: boolean
  attempt: number
  finalError?: string
}

/** Thinking level 取值（pi thinking 配置）。 */
export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * ThinkingLevel 值域双向防漂移锁（S6 自 services/session/session-lifecycle.ts 迁入——比对双方
 * 是本文件的 Pi 侧类型与 shared 常量，概念自然家在 Pi 边界镜像文件；launch-params.ts
 * 从未承载此锁）。锁定的两个漂移方向：
 * - 方向①（Expect<typeof PI_THINKING_LEVELS extends readonly PiThinkingLevel[]>）：
 *   shared 常量出现 pi-protocol 之外的值（shared 手改常量与本手写 union 漂移）→ 违
 *   Expect 的 true 约束 → 编译错；
 * - 方向②（ExpectNever<Exclude<...>>）：pi 升级加档位、本镜像 union 更新而 shared 常量
 *   未跟 → Exclude 产物非 never → 违 ExpectNever 的 never 约束 → 编译错
 *  （C-proc-08 版本门禁不含 ThinkingLevel 值域比对，此锁补位）。
 * 导出仅为编译期断言锚定（防 unused），非消费 API——运行时零存在（纯类型）。
 */
type Expect<T extends true> = T
type ExpectNever<T extends never> = T
export type ThinkingLevelDriftGuard = [
  Expect<typeof PI_THINKING_LEVELS extends readonly PiThinkingLevel[] ? true : false>,
  ExpectNever<Exclude<PiThinkingLevel, (typeof PI_THINKING_LEVELS)[number]>>,
]

/** Thinking level 变更事件。 */
export interface PiThinkingLevelChangedEvent extends PiBaseMessage {
  type: 'thinking_level_changed'
  level: PiThinkingLevel
}

/** Steering/follow-up 队列变更事件。 */
export interface PiQueueUpdateEvent extends PiBaseMessage {
  type: 'queue_update'
  steering: readonly string[]
  followUp: readonly string[]
}

/** 会话条目追加事件（pi 内部 entry 结构，taiji 不消费字段，故 Record）。 */
export interface PiEntryAppendedEvent extends PiBaseMessage {
  type: 'entry_appended'
  entry: Record<string, unknown>
}

/** 会话元信息变更事件（主要是 session name）。 */
export interface PiSessionInfoChangedEvent extends PiBaseMessage {
  type: 'session_info_changed'
  name: string | undefined
}

/** Agent 进入稳态（无待处理工具/消息）事件。 */
export interface PiAgentSettledEvent extends PiBaseMessage {
  type: 'agent_settled'
}

/**
 * Extension 报错事件。由 rpc-mode 发送，event-adapter:512 已处理但类型此前未声明。
 * 注意：event-adapter 转发时把 extensionPath 重命名为 extensionName（字段名映射，非 pi 协议字段）。
 */
export interface PiExtensionErrorEvent extends PiBaseMessage {
  type: 'extension_error'
  extensionPath: string
  event: string
  error: string
}

// ── Event messages: extension UI ───────────────────────────────────

/**
 * Extension UI request — used for tool approvals, confirmations, etc.
 * Sent by pi when a tool needs user approval or interactive input.
 */
export interface PiExtensionUiRequestEvent extends PiBaseMessage {
  type: 'extension_ui_request'
  /**
   * Request method — determines the UI interaction type.
   *
   * 交互式 dialog 方法（产生 extension.ui_request WS 帧，需前端回复）：confirm / select / input / editor
   * Fire-and-forget 方法（独立 WS 帧，不等回复）：notify / setStatus / setWidget / set_editor_text / bridge:*
   * notify 走 extension.notify WS 帧 + toast 渲染（非模态）；setStatus/setWidget 走各自独立帧。
   * event-adapter.ts INTERACTIVE_UI_METHODS 只含 dialog 子集，与此类型保持同步。
   */
  method: 'confirm' | 'select' | 'input' | 'notify' | 'editor' | 'setStatus' | 'setWidget'
  /** Unique id for correlating the response back. */
  id?: string
  /** Display title (often used as tool name). */
  title?: string
  /** Message body shown to the user. */
  message?: string
  /** Options for 'select' method. pi 严格传 `string[]`（dist/core/extensions/types.d.ts:70
   *  `select(title: string, options: string[], ...)`，rpc-mode 原样透传；W3 修正——旧声明
   *  `Array<{label,value}>` 与 pi 实态不符）。渲染侧 label=value 归一在 renderer
   *  normalizeOptions（双形状归一，兼容历史 plugin 源对象形态）。 */
  options?: string[]
  /** The original tool call context (forwarded to frontend for approval UI). */
  [key: string]: unknown
}

// ── Event messages: status / error ─────────────────────────────────

export interface PiStatusEvent extends PiBaseMessage {
  type: 'status'
  status: string
  detail?: string
}

export interface PiErrorEvent extends PiBaseMessage {
  type: 'error'
  message: string
}

// ── get_messages response data ─────────────────────────────────────

/**
 * Shape of the `data` field in a get_messages response.
 *
 * GOTCHA: pi puts the messages array under `data.messages`,
 * NOT under `payload.messages`. The top-level response has
 * type: 'response' and the history is nested in `data`.
 */
export interface PiGetMessagesData {
  messages: PiHistoryMessage[]
}

/** A single message in pi's conversation history. */
export interface PiHistoryMessage {
  role: 'user' | 'assistant' | 'toolResult'
  content: PiHistoryContentPart[]
  timestamp?: number
  stopReason?: string
}

/** Content parts within a pi history message. */
export type PiHistoryContentPart =
  | PiHistoryTextPart
  | PiHistoryThinkingPart
  | PiHistoryToolCallPart

export interface PiHistoryTextPart {
  type: 'text'
  text: string
}

export interface PiHistoryThinkingPart {
  type: 'thinking'
  thinking: string
}

export interface PiHistoryToolCallPart {
  type: 'toolCall' | 'tool_use'
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** toolResult messages represent tool execution outcomes in history. */
export interface PiHistoryToolResult extends PiHistoryMessage {
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
export interface PiSessionMessageEntry extends PiSessionEntryBase {
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
export interface PiSessionCustomEntry extends PiSessionEntryBase {
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
export interface PiSessionLabelEntry extends PiSessionEntryBase {
  type: 'label'
  label: string | undefined
  targetId: string
}

/**
 * compaction entry（compact 产生的摘要）。对应 pi CompactionEntry（session-manager.ts:74-86）。
 * type 是字面量 'compaction'（pi 源码定义），保证联合 narrowing 正确。
 * 当前 taiji 不消费此 entry（历史重建走 message entry + JSONL sidecar）。
 */
export interface PiSessionCompactionEntry extends PiSessionEntryBase {
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
export interface PiSessionBranchSummaryEntry extends PiSessionEntryBase {
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
 * display:false 时 taiji 不渲染（filterDisplayableMessages）；完成通知类 customType
 *（subagent-bg-notify/workflow-result）由 mapSessionEntries 引用 COMPLETE_NOTIFY_CUSTOM_TYPES
 * 覆写为 display:false（pi 可能持久化 display:true，taiji 统一隐藏）。
 */
export interface PiSessionCustomMessageEntry extends PiSessionEntryBase {
  type: 'custom_message'
  customType: string
  content: string
  display?: boolean
  details?: Record<string, unknown>
}

/**
 * get_entries RPC 请求（对应 pi rpc-types.ts:63 `{ type: "get_entries"; since?: string }`）。
 *
 * since 可选：传 entry id 时返回该 entry 之后的所有 entry（增量拉取，pi rpc-mode.ts:614-620
 * 用 findIndex + slice 实现，找不到 since id 时报错 "Entry not found"）。
 * 不传 since 时返回全部 entry（全量拉取）。
 */
export interface GetEntriesCommand {
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
export interface GetEntriesResponse {
  entries: PiSessionEntry[]
  leafId: string | null
}

// ── Shared types ───────────────────────────────────────────────────

/**
 * pi Usage type — mirrors pi 源码字段名（input/output/cacheRead/cacheWrite/totalTokens）。
 *
 * pi-protocol 作为 pi 协议的真契约（ADR-0037），字段名镜像 pi 实际发出的，
 * 不用 taiji 的 inputTokens/outputTokens（那是 event-adapter 翻译时的职责）。
 */
export interface PiUsage {
  input?: number
  output?: number
  totalTokens?: number
  cacheRead?: number
  cacheWrite?: number
}

// ── Union types for the adapter layer ──────────────────────────────

/** Union of all unsolicited event types from pi (mirrors AgentSessionEvent, ADR-0037). */
export type PiEvent =
  | PiAgentStartEvent
  | PiAgentEndEvent
  | PiTurnStartEvent
  | PiTurnEndEvent
  | PiMessageStartEvent
  | PiMessageEndEvent
  | PiMessageUpdateEvent
  | PiToolExecutionStartEvent
  | PiToolExecutionUpdateEvent
  | PiToolExecutionEndEvent
  | PiExtensionUiRequestEvent
  | PiStatusEvent
  | PiErrorEvent
  | PiCompactionStartEvent
  | PiCompactionEndEvent
  | PiAutoRetryStartEvent
  | PiAutoRetryEndEvent
  | PiThinkingLevelChangedEvent
  | PiQueueUpdateEvent
  | PiEntryAppendedEvent
  | PiSessionInfoChangedEvent
  | PiAgentSettledEvent
  | PiExtensionErrorEvent

/** Any message that can arrive from pi (response or event). */
export type PiAnyIncomingMessage =
  | PiResponse
  | PiEvent
