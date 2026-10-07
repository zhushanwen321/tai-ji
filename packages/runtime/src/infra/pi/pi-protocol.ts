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
// disposition 词表（PiMessage.disposition 同源；本文件 re-export 供既有 import 路径使用）。
import type { PiInputDisposition } from '@zhushanwen/pi-rpc'

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
 * 权威源 = @earendil-works/pi-ai 1.0.0 dist/types.d.ts AssistantMessageEvent 的 error 变体
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
  /** pi 1.0.0：嵌套调用（工具经 ctx.executeTool 调其他工具）时携带的父调用 id；顶层调用缺省。带该字段（非空串）的 start/end 被 event-adapter 按 codemode D4 过滤（live≡reload 对齐，见 isNestedToolExecutionBlockEvent）；update 豁免照常翻译、payload 不携带该字段。 */
  parentToolCallId?: string
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
  /** pi 1.0.0：嵌套调用时携带的父调用 id；顶层调用缺省。update 豁免不过滤（照常翻译，嵌套 update 不产工具块且是 subagent 活性信号载体；判据见 start 事件注释）。 */
  parentToolCallId?: string
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
  /** pi 1.0.0：嵌套调用时携带的父调用 id；顶层调用缺省。带该字段（非空串）的 end 与 start 同点同判被过滤（codemode D4，见 isNestedToolExecutionBlockEvent）。 */
  parentToolCallId?: string
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

/**
 * 压缩/分支摘要重试排定事件（pi1-disposition-chat-flow U3⑤，D12 登记三事件之一）。
 * pi 1.0.0 dist/core/agent-session.js `_summarizationRetryCallbacks` 实发：
 * onRetryScheduled → { type, attempt, maxAttempts, delayMs, errorMessage }。
 */
export interface PiSummarizationRetryScheduledEvent extends PiBaseMessage {
  type: 'summarization_retry_scheduled'
  attempt: number
  maxAttempts: number
  delayMs: number
  errorMessage: string
}

/**
 * 压缩/分支摘要重试单次尝试开始事件（D12 三事件之二）。pi 1.0.0 实发两变体
 * （agent-session.d.ts）：`{ source: 'branchSummary' }` 与
 * `{ source: 'compaction', reason }`——reason 仅 compaction 源携带，故可选。
 */
export interface PiSummarizationRetryAttemptStartEvent extends PiBaseMessage {
  type: 'summarization_retry_attempt_start'
  source: 'branchSummary' | 'compaction'
  /** compaction 源专有：触发压缩的原因（branchSummary 变体不携带）。 */
  reason?: PiCompactionReason
}

/**
 * 压缩/分支摘要重试收尾事件（D12 三事件之三）。pi 1.0.0 onRetryFinished →
 * `{ type }`（_summarizationRetryCallbacks 内），无载荷字段。
 */
export interface PiSummarizationRetryFinishedEvent extends PiBaseMessage {
  type: 'summarization_retry_finished'
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
   * Fire-and-forget 方法（独立 WS 帧，不等回复）：notify / setStatus / setWidget / set_editor_text / setTitle
   * notify 走 extension:notify WS 帧 + toast 渲染（非模态）；setStatus/setWidget 走各自独立帧；
   * set_editor_text 走 extension:setEditorText。setTitle 宿主不实现（pi fire-and-forget，
   * 丢弃无功能损失——event-adapter 落 default 分支 warn + noop，预决策只补类型不实现宿主）。
   * 全集对照 pi rpc-mode.js createExtensionUIContext 的 output 调用点（RT-2#7 补全
   * set_editor_text/setTitle——此前缺失使 `as string` 成为掩盖穷举缺口的必要转换）。
   * event-adapter.ts INTERACTIVE_UI_METHODS 只含 dialog 子集，与此类型保持同步。
   */
  method: 'confirm' | 'select' | 'input' | 'notify' | 'editor' | 'setStatus' | 'setWidget' | 'set_editor_text' | 'setTitle'
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

// ── get_messages / get_entries response data（拆分承载：pi-session-data.ts）──
//
// 会话数据模型（get_messages 历史消息族 + get_entries session entry 树）已拆至
// ./pi-session-data.ts（max-lines 拆分：与上方 wire 事件协议是正交关注点）。
// 此处 re-export 保持既有 import 路径——消费方从本文件导入这些符号的写法不变，
// 归属约束亦不变（services 只经本门面消费，不直连 infra/pi 内部文件）。
export type {
  GetEntriesCommand,
  GetEntriesResponse,
  PiGetMessagesData,
  PiHistoryContentPart,
  PiHistoryMessage,
  PiHistoryImagePart,
  PiHistoryTextPart,
  PiHistoryThinkingPart,
  PiHistoryToolCallPart,
  PiHistoryToolResult,
  PiSessionBranchSummaryEntry,
  PiSessionCompactionEntry,
  PiSessionContextEditEntry,
  PiSessionCustomEntry,
  PiSessionCustomMessageEntry,
  PiSessionEntry,
  PiSessionEntryBase,
  PiSessionLabelEntry,
  PiSessionMessageEntry,
  PiSessionUsageEntry,
} from './pi-session-data.js'

// ── Shared types ───────────────────────────────────────────────────

/**
 * pi 1.0.0 prompt/steer/follow_up 响应 data.disposition 的值域（'handled' 被扩展接管 /
 * 'queued' 排队 / 'started' 已开始执行）。词表 SSOT 在 @zhushanwen/pi-rpc（PiMessage.disposition
 * 字段同源），此处 re-export 保持既有 import 路径；字段语义见 pi-rpc types.ts。
 */
export type { PiInputDisposition }

/**
 * services 层消费用的内部别名（check_pi_type_leak 口径：PiXxx 标识符只许 infra/pi 内部驻留，
 * services 经此中性名消费同一词表——D5① 翻译口径的最小形态：值域与语义零变化，仅名字翻译）。
 */
export type InputDisposition = PiInputDisposition

/**
 * 从 RPC 响应解析 disposition（B3 兼容式）：pi < 1.0.0 或 mock 无该字段 → undefined
 *（调用方行为与现状完全一致）；非法值（协议漂移）→ undefined + warn 可观测。
 * 唯一调用点 = rpc-client sendCommand 出口（解析结果挂 PiMessage.disposition 透传上层）。
 */
export function parseInputDisposition(msg: PiMessageLike): PiInputDisposition | undefined {
  const value = msg.data?.disposition
  if (value === undefined) return undefined
  if (value === 'handled' || value === 'queued' || value === 'started') return value
  console.warn(`[pi-protocol] disposition 非法值: ${String(value)}（协议漂移？），按缺失处理`)
  return undefined
}

/** parseInputDisposition 的最小结构入参（PiMessage 的结构子集）。 */
export interface PiMessageLike {
  data?: Record<string, unknown>
}

/**
 * 从 get_commands 响应解析**扩展命令** name 集合（pi1-disposition-chat-flow D2①，P5 已核实）：
 * 响应 `data.commands` 含三类条目——`source:"extension"`（name = pi 侧 invocationName，同名
 * 扩展命令注册时带 `:N` 消歧后缀）/ `source:"prompt"` 模板 / `source:"skill"`（name 带
 * `skill:` 前缀）。命令识别集只收 extension 条目：pi 侧命令接管判定 `getCommand` 只查扩展
 * 注册命令（resolveRegisteredCommands），skill 与模板经展开走正常回合（started）不属接管——
 * source 过滤是「识别集两侧同一判定口径」的成立前提（D2①）。
 * 响应畸形（data.commands 非数组）→ 空集（调用方按清单缺失兜底：全量按普通消息出站）。
 */
export function extractExtensionCommandNames(msg: PiMessageLike): Set<string> {
  const out = new Set<string>()
  const commands = msg.data?.commands
  if (!Array.isArray(commands)) return out
  for (const item of commands) {
    const c = item as { name?: unknown; source?: unknown }
    if (c.source !== 'extension') continue
    if (typeof c.name === 'string' && c.name !== '') out.add(c.name)
  }
  return out
}

/**
 * 从 get_commands 响应解析 skill 与 prompt 模板条目 name 集合（skill-input-marker-pollution
 * 恢复通道：手打形态 source=skill/prompt 清单条目统一切 started 基终局——出站不注标、
 * pi 受理回执即终局。pi 侧对这两类输入展开为正常回合：_expandSkillCommand /
 * expandPromptTemplate（agent-session.ts prompt/steer 路径实读），不返回 handled 接管，
 * 终局由适配器按 disposition 受理事实驱动）。响应畸形（data.commands 非数组）→ 空集
 * （调用方按清单缺失兜底：全量按普通消息出站）。
 */
export function extractSkillTemplateCommandNames(msg: PiMessageLike): Set<string> {
  const out = new Set<string>()
  const commands = msg.data?.commands
  if (!Array.isArray(commands)) return out
  for (const item of commands) {
    const c = item as { name?: unknown; source?: unknown }
    if (c.source !== 'skill' && c.source !== 'prompt') continue
    if (typeof c.name === 'string' && c.name !== '') out.add(c.name)
  }
  return out
}

/**
 * 命令识别（D2①）：文本以 `/` 开头且首个空格前段剥去前导 `/` 后与清单 name **逐字精确匹配**
 * → 返回该 name；否则 undefined。两侧同口径剥斜杠：pi 侧命令名提取 = `text.slice(1, spaceIndex)`
 * （agent-session.js _tryExecuteExtensionCommand 实读），清单 name 无 `/` 前缀。清单 name 的
 * 非裸形态（同名扩展命令的 `:N` 消歧后缀）由逐字匹配自然覆盖：用户输入裸 name 时 pi 侧同样
 * miss（两侧行为一致），输入带后缀 name 时两侧同样命中——不发明归一化规则。
 */
export function matchCommandName(text: string, names: ReadonlySet<string>): string | undefined {
  if (!text.startsWith('/')) return undefined
  const spaceIndex = text.indexOf(' ')
  const candidate = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)
  return names.has(candidate) ? candidate : undefined
}

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
  // summarization_retry_* 三事件（U3⑤，D12 登记——压缩/分支摘要重试状态，呈现层已有
  // compaction 主链路覆盖，event-adapter 显式 no-op 不进 default warn）
  | PiSummarizationRetryScheduledEvent
  | PiSummarizationRetryAttemptStartEvent
  | PiSummarizationRetryFinishedEvent

// ── 事件名字面量常量表（pi1-disposition-chat-flow U3⑦，D5⑥ 字面量单点化）──────────

/**
 * pi 事件名字面量常量表——词表词字符串字面量在仓内的唯一驻留点（D5⑥：判别 / 派发载荷
 * 形态 = 字符串完整值 ∈ 词表，services 层引用一律经下方具名出口 `PI_EVENT`，字面量直写
 * 即违规；日志模板串内嵌 / 无引号对象键两形态不在检查面，见设计 D5⑤④口径边界登记）。
 *
 * 本表同时是 `check_pi_type_leak.py` 事件名项扫描词表的派生载体（D5⑤实装口径⑤：检查器
 * 启动时定位本导出符号、提取方括号内带引号字符串字面量建词表，定位失败或空表 fail-fast
 * 退出非 0；每次运行摘要行输出词表基数）。同形剔除词（下方 HomoglyphExempt）不进本表。
 *
 * 同源维护由两层编译期断言机器强制（D5⑥，非文件位置约定）：
 * - **子集层**：`as const satisfies readonly PiEvent['type'][]`——表内出现非联合判别值的
 *   词（手抄错词）即 tsc 红（TS2820，带 Did-you-mean）；
 * - **穷尽层**：`PiEventNameDriftGuard` 的 ExpectNever——联合扩成员而本表与剔除集均未
 *   收新成员时 Exclude 产物非 never，tsc 红（TS2344，错误消息点名缺失词）。
 * 联合新成员触发红灯时，须在「进本表（进扫描词表，检查面自动扩）」与「进剔除集（同形词，
 * 按界定规则②同步本文件剔除集类型与检查器头注 + ADR 登记）」之间显式裁决。
 */
export const PI_EVENT_NAMES = [
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'extension_ui_request',
  'compaction_start',
  'auto_retry_start',
  'auto_retry_end',
  'thinking_level_changed',
  'queue_update',
  'session_info_changed',
  'extension_error',
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
] as const satisfies readonly PiEvent['type'][]

/** 词表成员类型（常量表值域）。 */
export type PiEventName = (typeof PI_EVENT_NAMES)[number]

/**
 * 同形剔除集（事件名词表界定规则②，D5⑤）：与 taiji 内部词表同形的 6 词不进扫描词表
 * 防误报。构成（源码锚点逐项核实见设计 D5⑤②）：
 * - trace-trigger 联合判别值 3 词：message_end / agent_settled / entry_appended
 *  （services/session/types.ts PiTranslatedEvent 的 trigger 联合——pi 原始事件名作 taiji
 *   侧触发标签，已属 taiji 自有词表成员）；
 * - compaction_end 1 词（taiji 侧第四类触发信号 onTraceSync 传值；注意 taiji 侧判别值是
 *   连字符 'compaction-end'，pi 原词不是任何 taiji 类型的判别值）；
 * - 通用词 2 词：status / error（taiji 通用词汇大面积同形）。
 * 剔除代价：这 6 词上的 L2 型泄漏（services 层直听 pi 原始事件流）检不住——残余防线分档
 * 登记见设计 D5⑤②（trace-trigger 3 词有类型约束防线；compaction_end 无类型约束，防线
 * 强度最低，靠评审承接）。扩联合新增同形词时的归宿裁决入口 = 上方穷尽断言编译红。
 */
type PiEventNameHomoglyphExempt =
  | 'message_end'
  | 'agent_settled'
  | 'entry_appended'
  | 'compaction_end'
  | 'status'
  | 'error'

/**
 * 穷尽层断言（D5⑥ 双向断言的第二向；ExpectNever 形态沿本文件 ThinkingLevelDriftGuard
 * 先例——导出仅为编译期断言锚定，防 unused，运行时零存在）：联合判别值全集 − 表值域 −
 * 同形剔除集 ≡ never。表漏收联合新成员（且剔除集也未收）时 Exclude 产物非 never，编译红。
 */
export type PiEventNameDriftGuard = [
  Expect<typeof PI_EVENT_NAMES extends readonly PiEvent['type'][] ? true : false>,
  ExpectNever<Exclude<PiEvent['type'], PiEventName | PiEventNameHomoglyphExempt>>,
]

/**
 * 消费侧具名出口（services 层引用 pi 事件名经此导入，字面量直写即违规——U3⑦
 * event-interpreter 5 处字面量改导入常量的载体）。值恒为词表成员（`satisfies` 写错词即
 * 编译红）；键 = taiji 侧语义名。仅登记现存消费词，新消费点按需补行。
 */
export const PI_EVENT = {
  agentStart: 'agent_start',
  agentEnd: 'agent_end',
  turnEnd: 'turn_end',
  toolExecutionStart: 'tool_execution_start',
  toolExecutionEnd: 'tool_execution_end',
} satisfies Record<string, PiEventName>

/** Any message that can arrive from pi (response or event). */
export type PiAnyIncomingMessage =
  | PiResponse
  | PiEvent
