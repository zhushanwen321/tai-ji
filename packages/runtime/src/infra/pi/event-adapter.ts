/**
 * EventAdapter — 纯翻译器：pi subprocess RPC 事件 → PiTranslatedEvent[]。
 *
 * [R1 重构] 本文件是 infra 层，只做「翻译」，不做任何业务编排副作用：
 *   ✗ 不调 plugin hook（onBeforeToolCall/onAfterToolResult）
 *   ✗ 不做 file_changes baseline diff（snapshotGitStatus/diffSnapshots）
 *   ✗ 不回写 session 状态（context.update / thinkingLevel 缓存）
 *   ✗ 不路由 status/bridge/extension-ui 到 server
 *   ✗ 不持有可变态（currentMessageId/writeContents/diffChain 帧序态全在 interpreter）
 *   ✓ 只产出结构化中间事件（PiTranslatedEvent[]），交由 service 层 EventInterpreter 编排。
 *
 * [D5 例外登记，u7b] subagent 在途上报（marker = SUBAGENT_INFLIGHT_MARKER）是本文件唯一的
 * 显式副作用例外：帧在 **EventAdapter 监听器旁路**就地消费（写 inflight-mirror + 经注入的
 * client 回 INFLIGHT_REPORT_ACK，见 consumeInflightReport），translate() 保持无副作用——
 * 仅保留一条守卫分支（marker 帧恒不产出前端广播）。设计依据 docs/design/
 * crash-forensics-and-watchdog.md §3.3 D5「extension 聚合上报」+「marker 路由不得广播前端」
 *（[HISTORICAL] 广播前端 → 前端无人应答 runtime 内部消费的 select → pending 泄漏，
 * session-manager 分支同类教训）。
 *
 * pi RPC events have this structure:
 * - `message_update` = `{type, assistantMessageEvent, usage?}`（wire 恒无顶层 message——RPC
 *   toJsonEvent 剥离，见 pi-protocol.ts PiMessageUpdateEvent 注释）with nested
 *   `assistantMessageEvent` containing `type`, `delta`, `contentIndex`
 *   - sub-types: text_start, text_delta, text_end, thinking_start, thinking_delta,
 *     thinking_end, toolcall_start, toolcall_delta, toolcall_end（toolCall.id 锚点）, error
 * - `message_start` / `message_end` with `message` containing role, content, usage, stopReason
 * - `agent_start` / `turn_start` / `turn_end` / `agent_end` for lifecycle
 * - `extension_ui_request` for tool approvals etc.
 *
 * Each session gets its own adapter instance. translate() is stateless（一个 pi 事件
 * 产出一组中间事件），可变态由 EventInterpreter 持有。
 */
import type { ServerMessage, ServerMessageType, ExtensionInteractMethod, PiMessageEntry, PiToolCallEntryForm } from '@xyz-agent/shared'
import { EXTENSION_EVENTS, SUBAGENT_RECORD_CUSTOM_TYPE, WORKFLOW_RECORD_CUSTOM_TYPE, SUBAGENT_DIRECTIVE_CUSTOM_TYPE, parseSubagentDirective } from '@xyz-agent/shared'
import { GUI_WIDGET_MARKER, ASK_USER_MARKER, SESSION_MANAGER_MARKER, SESSION_MANAGER_ACTIONS, BRIDGE_MARKER, BRIDGE_METHODS, SUBAGENT_INFLIGHT_MARKER, INFLIGHT_REPORT_ACK, isGuiComponent, isGuiRenderResult, isSubagentInFlightReport } from '@xyz-agent/extension-protocol'
import type { SessionManagerAction, BridgeRequest } from '@xyz-agent/extension-protocol'
import type { PiEventListener } from '../../services/ports/pi-engine.js'
import type { PiTranslatedEvent } from '../../services/session/types.js'
// [u7b D5 例外] 在途镜像单例：marker 旁路写、u7c 滚动重启判定读（见文件头例外登记）
import { inflightMirror } from '../../services/session/inflight-mirror.js'
import { randomUUID } from 'node:crypto'
import { stripAnsi, normalizePiToolResult } from './normalize-tool-result.js'
import type {
  PiEvent,
  PiMessageStartEvent,
  PiMessageUpdateEvent,
  PiMessageEndEvent,
  PiAgentEndEvent,
  PiToolExecutionStartEvent,
  PiToolExecutionUpdateEvent,
  PiToolExecutionEndEvent,
  PiTurnEndEvent,
  PiExtensionUiRequestEvent,
  PiExtensionErrorEvent,
  PiAutoRetryStartEvent,
  PiAutoRetryEndEvent,
  PiQueueUpdateEvent,
  PiSessionInfoChangedEvent,
  PiThinkingLevelChangedEvent,
  PiStatusEvent,
  PiErrorEvent,
  PiCompactionStartEvent,
  PiCompactionEndEvent,
  PiAgentSettledEvent,
  PiEntryAppendedEvent,
} from './pi-protocol.js'

// ── Sub-handler types ──────────────────────────────────────────────
//
// [ADR-0037] translate() 入参用 pi-protocol.ts 的 PiEvent 联合类型（真契约）。
// 每个 handler 入参窄化为对应的 Pi*Event interface（如 handleToolExecutionEnd →
// PiToolExecutionEndEvent）。pi 升级时若新增事件类型，PiEvent 联合的 exhaustive
// 检查会提示补 handler 或登记到 NULL_EVENTS。
// 对未知事件类型（联合外）translate() 走 default warn + return []（见文件末尾）。

const STOP_REASON_MAP: Record<string, string> = {
  stop: 'end_turn',
  end_turn: 'end_turn',
  length: 'max_tokens',
  max_tokens: 'max_tokens',
  toolUse: 'tool_use',
  tool_use: 'tool_use',
  error: 'error',
  aborted: 'aborted',
  cancelled: 'aborted',
  content_filter: 'content_filter',
}

/**
 * Interactive extension UI dialog methods that produce extension.ui_request WS events.
 * Must stay in sync with ExtensionInteractMethod SSOT (shared/extension.ts).
 *
 * notify 不在此列——它是 fire-and-forget（pi rpc-mode.ts notify 发后不等回复），
 * 走独立 extension.notify WS 帧 + 前端 toast 渲染（非阻塞）。
 * setStatus/setWidget/set_editor_text/bridge:* 也不在此列——它们走独立分支，不产 ui_request 帧。
 *
 * 用 `as const satisfies readonly ExtensionInteractMethod[]` 实现编译期穷举检查：
 * ExtensionInteractMethod 扩展新方法时，若此数组遗漏，tsc 报错（而非静默 noop 丢弃）。
 */
const INTERACTIVE_UI_METHODS = new Set(
  ['confirm', 'select', 'input', 'editor'] as const satisfies readonly ExtensionInteractMethod[]
)

/** Extension method constant for the editor UI */
const METHOD_EDITOR = 'editor' as const

/**
 * base-tool-enhance 后台任务的 custom 消息类型（权威源：extensions/universal/
 * base-tool-enhance/src/background/notify.ts BACKGROUND_BASH_CUSTOM_TYPE；runtime 侧
 * 不 import extension 源码，字面量 + 注释登记）。exit 边沿 notify（pi.sendMessage
 * customType background-bash）经 message_start 到达。
 */
const BACKGROUND_BASH_CUSTOM_TYPE = 'background-bash'
/** base-tool-enhance override 的 bash 工具名（spawn 路径的 tool_execution_end 锚点）。 */
const BASH_TOOL_NAME = 'bash'

// ── Sub-handlers（纯函数：PiEvent → PiTranslatedEvent[]，无副作用）────────

/** message_update.assistantMessageEvent 的 wire 局部形态（pi-protocol.ts PiMessageUpdateEvent 同源） */
type PiMessageUpdateSub = {
  type: string
  delta?: string
  content?: string
  contentIndex?: number
  toolCall?: { id?: string }
}

/**
 * contentIndex 可选锚点：undefined 时不产字段（payload 形态稳定）。
 * text/thinking delta 的 contentIndex 透传是 D-2 token coalescing（W12 DeltaBuffer 合帧）
 * 的有序插入锚点。
 */
function contentIndexAnchor(contentIndex: number | undefined): { contentIndex?: number } {
  return contentIndex !== undefined ? { contentIndex } : {}
}

/** text/thinking delta 帧（delta 缺省空串 + contentIndex 锚点，两 case 载荷形态同构） */
function deltaUpdateMessage(
  type: 'message.text_delta' | 'message.thinking_delta',
  sid: string,
  delta: string | undefined,
  contentIndex: number | undefined,
): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: { type, payload: { sessionId: sid, delta: delta ?? '', ...contentIndexAnchor(contentIndex) } },
  }]
}

/** message_update — streaming text/thinking deltas and stream errors */
function handleMessageUpdate(event: PiMessageUpdateEvent, sid: string): PiTranslatedEvent[] {
  const sub = event.assistantMessageEvent as PiMessageUpdateSub | undefined
  if (!sub) return [{ kind: 'noop' }]

  switch (sub.type) {
    case 'text_delta':
      return deltaUpdateMessage('message.text_delta', sid, sub.delta, sub.contentIndex)
    case 'thinking_start':
      return [{ kind: 'message', message: { type: 'message.thinking_start', payload: { sessionId: sid, ...contentIndexAnchor(sub.contentIndex) } } }]
    case 'thinking_delta':
      // 微项 1（wave:perf-w07）：contentIndex 透传对齐 text_delta——为 D-2 token coalescing（W12
      // DeltaBuffer 合帧）保住 thinking 块的有序插入锚点；renderer 现状 handler 未消费该字段，多余字段无害。
      return deltaUpdateMessage('message.thinking_delta', sid, sub.delta, sub.contentIndex)
    case 'thinking_end':
      return [{ kind: 'message', message: { type: 'message.thinking_end', payload: { sessionId: sid } } }]
    case 'toolcall_end':
      return handleToolcallEnd(sub)
    case 'toolcall_start': case 'toolcall_delta':
    case 'text_start': case 'text_end':
      return [{ kind: 'noop' }]
    // FR-5: streaming error — surface as message.stream_error
    // payload 形状与 protocol 契约对齐：content（人类可读）+ kind（分类，可选）
    case 'error':
      return [{ kind: 'message', message: { type: 'message.stream_error', payload: { sessionId: sid, content: sub.content ?? '', kind: 'error' } } }]
    default:
      console.warn('[EventAdapter] Unhandled message_update sub-type:', sub.type)
      return [{ kind: 'noop' }]
  }
}

/**
 * message_update.toolcall_end — toolCall 块顺序锚点（§11 检查点 3）。
 *
 * pi 在模型流输出 tool_use 时发 toolcall_*（带 contentIndex），远早于 tool_execution_start
 * （工具执行时，无 contentIndex）。toolCall 块若由 tool_execution_start 驱动，同 turn 内
 * text 在 tool 之后时顺序会错位（text_delta 先到、toolCall 后到）。
 *
 * 提取点 = toolcall_end（W3 修正，非 toolcall_start）：wire 上 toolcall_start 只有
 * {type, contentIndex}——pi-ai AssistantMessageEvent 的 partial（含 content[contentIndex].id）
 * 被 RPC toJsonEvent 剥离（dist/modes/json-event.js:6-10），旧代码从
 * event.message?.content?.[contentIndex]?.id 提取恒 undefined（wire 无顶层 message，
 * 单测 mock 自带该字段故测试绿生产死）。toolcall_end 携带完整 toolCall 对象
 * （{type:'toolCall', id, name, arguments}，pi-ai types.d.ts:405-409 + 244-250，非 partial
 * 字段不被剥离）。实测 0.84.1：toolCall.id 与后续 tool_execution_start.toolCallId 同值；
 * toolcall_end（LLM 流中工具参数输出完成）仍远早于 tool_execution_start（assistant
 * message 完成后才开始执行工具），顺序锚点语义不变。
 * 此处产出 tool-call-index 中间事件（toolCallId + contentIndex），interpreter 缓存后
 * 在 tool-call-start 到达时附到 tool_call_start WS 帧，前端按 contentIndex 有序插入。
 */
function handleToolcallEnd(sub: PiMessageUpdateSub): PiTranslatedEvent[] {
  const toolCallId = sub.toolCall?.id
  const contentIndex = sub.contentIndex
  if (toolCallId !== undefined && contentIndex !== undefined) {
    return [{ kind: 'tool-call-index', toolCallId, contentIndex }]
  }
  return [{ kind: 'noop' }]
}

/**
 * tool_execution_start — 重构 toolCall entry 形态（W21）+ 产出 tool-call-start 中间事件。
 * EventInterpreter 据此跑 onBeforeToolCall hook（可阻断 / 改写 input，改写同步回 entry.arguments）
 * 后产出 tool_call_start WS 帧（payload 为 entry 形态）；contentIndex/messageId 锚点由
 * interpreter 从缓存补进 entry（toolcall_start 产出顺序锚点 + currentMessageId 挂载目标）。
 *
 * entry 形态对齐 pi entry schema（字段风格见 shared/pi-entry.ts PiToolCallEntryForm）；
 * turnId 恒缺省（值填充归 fix-chat-flow-order 分组 wave，见 handleMessageEnd 同款注释）。
 * input 平铺字段保留：interpreter 的 hook 上下文消费（HookTransform 契约），WS 帧只发 entry。
 */
function handleToolExecutionStart(event: PiToolExecutionStartEvent, _sid: string): PiTranslatedEvent[] {
  const toolName = event.toolName
  // pi 用 args 是规范字段名（pi 从不发 input，ADR-0037）。
  const input = event.args
  const tsMs = Date.now()
  const entry: PiToolCallEntryForm = {
    type: 'toolCall',
    toolCallId: event.toolCallId,
    toolName,
    arguments: (input ?? {}) as Record<string, unknown>,
    timestamp: new Date(tsMs).toISOString(),
  }
  return [{
    kind: 'tool-call-start',
    toolCallId: event.toolCallId,
    toolName,
    input,
    entry,
  }]
}

/**
 * tool_execution_end — 重构 toolResult message entry 形态（W21）+ 产出 tool-call-end 中间事件。
 * EventInterpreter 据此跑 onAfterToolResult hook（改写 output，改写同步回 entry.message.content）
 * + 触发 file_changes baseline diff 后产出 tool_call_end WS 帧（payload 为 entry 形态）。
 *
 * entry 与 pi 持久化的 toolResult entry 同构（message.role='toolResult'，content 为原始/改写后
 * 的工具产出——归一化归消费方：core reducer / registry 各自 normalizePiToolResult，幂等），
 * 前端可直接喂 applyEntry（toolResult 窗口局部配对回填）。
 *
 * output/outputRaw/details/images 平铺字段保留：interpreter 的 hook 上下文与 subagent/workflow
 * 编排消费（HookTransform 契约），WS 帧只发 entry。
 *
 * [已知限制] pi tool_execution_end 从不发 args（pi types.ts:430 无此字段），故 write 工具的
 * content 无法在此提取。writeContent 提取逻辑已删除（原为恒 undefined 的死代码）。
 * EventInterpreter 的 writeContents Map 因此恒为空——untracked 行数回退当前不生效，
 * 待后续在 tool_execution_start 路径（该事件发 args）补齐后恢复。详见 pi-protocol.ts 相关注释。
 */
function handleToolExecutionEnd(event: PiToolExecutionEndEvent, _sid: string): PiTranslatedEvent[] {
  // pi 用 result 是规范字段名（pi 从不发 output，ADR-0037）。
  // 三态判定 + stripAnsi + images/details 提取统一委托 normalizePiToolResult（W1）。
  const raw = event.result
  const { output, outputRaw, details, images } = normalizePiToolResult(raw)

  const toolCallId = event.toolCallId
  const toolName = event.toolName
  const isError = event.isError
  const tsMs = Date.now()
  // content 归一为 content block 数组——对齐 pi 持久化形态（ToolResultMessage.content 恒为
  // (Text|Image)[]，messages.ts:398）：raw 的 .content 数组透传；string / null / 其他对象
  // 包成 text block（output 是 normalize 后文本，其他对象已 JSON.stringify 化）。
  // live entry 与 reload entry 同构 → 两侧 reducer 的 computeToolCallFill 走同一数组分支。
  const rawObj = raw as { content?: unknown } | null
  const content: unknown[] = Array.isArray(rawObj?.content)
    ? (rawObj.content as unknown[])
    : [{ type: 'text', text: output }]
  const entry: PiMessageEntry = {
    type: 'message',
    parentId: null,
    timestamp: new Date(tsMs).toISOString(),
    message: {
      role: 'toolResult',
      toolCallId,
      toolName,
      content,
      isError,
      ...(details !== undefined && { details }),
      timestamp: tsMs,
    },
  }

  return [{
    kind: 'tool-call-end',
    toolCallId,
    output,
    details,
    images,
    toolName,
    isError,
    outputRaw,
    entry,
  }]
}

/**
 * pi agent_end lastMsg 的运行时扩展字段（超出 PiAgentEndMessage 声明范围——pi 在此还附带
 * responseModel / diagnostics / errorMessage / content 等运行时字段，pi AgentMessage
 * 实际形态比声明的 union 更宽——用 as 提取）。
 */
interface AgentEndRuntimeExtras {
  responseModel?: string
  diagnostics?: Record<string, unknown>
  errorMessage?: string
  content?: unknown
}

/**
 * agent_end 空 messages 降级（W1）：messages 为空数组 / undefined 时降级为
 * turn-end{stopReason:'error'}，不抛 TypeError。
 * 异常会从 translate() 抛出 → 经 EventAdapter.attach 的整批 try-catch 被吞 →
 * agent_end 整批事件丢失 → isGenerating 永不复位 + message.complete 不送达。
 * messages 可能在 pi 内部异常 / 会话尚未产出任何 assistant 消息时为空。
 */
function emptyMessagesDegradedTurnEnd(sid: string): PiTranslatedEvent[] {
  console.warn(`[EventAdapter] agent_end with empty messages (degraded to turn-end{error}) sid=${sid}`)
  return [{
    kind: 'turn-end',
    message: { type: 'message.complete', payload: { sessionId: sid, stopReason: 'error' } },
    stopReason: 'error',
  }]
}

/**
 * 从 lastMsg 提取 stopReason / usage / responseModel / diagnostics / errorMessage。
 * errorMessage 仅在 error / tool_use 两种 stopReason 下透出（pi 契约，其余为 undefined）。
 */
function extractAgentEndFields(
  lastMsg: PiAgentEndEvent['messages'][number],
  extras: AgentEndRuntimeExtras,
): {
  rawReason: string
  usage: PiAgentEndEvent['messages'][number]['usage']
  responseModel: string | undefined
  diagnostics: Record<string, unknown> | undefined
  errorMessage: string | undefined
} {
  const rawReason = lastMsg.stopReason ?? 'stop'
  const usage = lastMsg.usage
  return {
    rawReason,
    usage,
    responseModel: extras.responseModel,
    diagnostics: extras.diagnostics,
    errorMessage: (rawReason === 'error' || rawReason === 'tool_use') ? extras.errorMessage : undefined,
  }
}

/**
 * 提取完整文本 content：pi agent_end 携带最终 AssistantMessage，content[] 含 streaming 全部文本。
 * 透出给前端用权威源覆盖客户端累积值，消除末尾 delta 的 async 渲染竞态（如 ** 未闭合不渲染加粗）。abort 路径为空不覆盖。
 * content 在 PiAgentEndMessage 中是 unknown，此处按 pi 运行时形态（content block 数组）提取。
 */
function extractFinalContent(extras: AgentEndRuntimeExtras): string {
  return (Array.isArray(extras.content) ? extras.content : [] as unknown[])
    .filter((c): c is { type: string; text?: string } => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text')
    .map((c) => c.text ?? '')
    .join('')
}

/** pi usage → WS payload usage（xyz-agent 字段名翻译：input/output/totalTokens → inputTokens/outputTokens/totalTokens，缺省 0）。 */
function toUsageTokens(usage: PiAgentEndEvent['messages'][number]['usage']): {
  inputTokens: number
  outputTokens: number
  totalTokens: number
} | undefined {
  return usage
    ? { inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0, totalTokens: usage.totalTokens ?? 0 }
    : undefined
}

/** agent_end — extract stop reason, usage, responseModel, diagnostics, errorMessage, content */
function handleAgentEnd(event: PiAgentEndEvent, sid: string): PiTranslatedEvent[] {
  if (!event.messages || event.messages.length === 0) {
    return emptyMessagesDegradedTurnEnd(sid)
  }
  // pi 事件是强类型契约（ADR-0037）。agent_end.messages 的 usage/stopReason 由 PiAgentEndMessage
  // 覆盖（PiUsage 已镜像 pi 字段名 input/output/cacheRead/cacheWrite）。运行时扩展字段经
  // AgentEndRuntimeExtras（as）提取。
  const lastMsg = event.messages[event.messages.length - 1]
  const extras = lastMsg as unknown as AgentEndRuntimeExtras
  const { rawReason, usage, responseModel, diagnostics, errorMessage } = extractAgentEndFields(lastMsg, extras)
  const finalContent = extractFinalContent(extras)
  const stopReason = STOP_REASON_MAP[rawReason] ?? rawReason
  const message: ServerMessage = {
    type: 'message.complete',
    payload: {
      sessionId: sid,
      stopReason,
      usage: toUsageTokens(usage),
      responseModel,
      diagnostics,
      errorMessage,
      ...(finalContent ? { content: finalContent } : {}),
    },
  }

  return [{
    kind: 'turn-end',
    message,
    // context 占用 = totalTokens（input+output+cacheRead+cacheWrite），与 pi calculateContextTokens 同源。
    // 不能用 usage.input——那是单 turn 增量 input（不含 cacheRead 的 context 大头），值很小。
    inputTokens: usage?.totalTokens,
    totalTokens: usage?.totalTokens ?? 0,
    stopReason,
    usage,
  }]
}

/**
 * turn_end — 单个 turn 结束时提取 usage，产出 turn-usage（只回写用量，不转发 message.complete）。
 *
 * pi 0.80.3 事件模型：1 个 agent 循环 = N 个 turn，每个 turn_end.message.usage 含本 turn 用量。
 * 与 handleAgentEnd（整个循环结束）的区别：本 handler 不产 message/stopReason/file_changes，
 * 避免每 turn 触发前端 message.complete → setStreaming(false) 闪烁。
 * totalTokens 缺失时返回空（纯工具结果 turn 可能无 usage）。
 *
 * composer-gen-stats（D1）：同时透传 gen-stats 扩展字段（output/cacheRead/cacheWrite/input/model/
 * provider，全来自 turn_end.message 的 AssistantMessage 自带结构——结构与通路已锚定 PS-25，
 * 探针 pi-semantics-turn-usage-model）。model/provider 是运行时字段
 * （超出 PiTurnEndMessage 声明范围，同 handleAgentEnd 的 responseModel 提取模式——pi AgentMessage
 * 实际形态比声明的 union 更宽），用 as 提取。字段缺省 → null（无值编码纪律 D4，禁 ?? 0——
 * 0 只允许作为真实测量值出现，null 由 interpreter/service 逐字段判定丢弃语义）。
 * PS-25 已验证（pi 0.84.4 实装）：message.model = 请求侧 model.id（必填恒有；gen-stats 分桶
 * 裁定采它，不采 responseModel——后者仅 openai-completions 在路由结果 ≠ 请求 id 时才有，
 * 多数 provider 恒缺）；失败 turn 的 failureMessage.usage 为 EMPTY_USAGE（totalTokens=0），
 * 被下方 totalTokens gate 丢弃，不产样本。
 */
function handleTurnEndPi(event: PiTurnEndEvent, sid: string): PiTranslatedEvent[] {
  // pi turn_end 事件把 message 放在顶层 message 字段（ADR-0037 契约，pi 从不发 payload）。
  const message = event.message
  const usage = message?.usage
  if (!usage?.totalTokens) return []
  const msgExtra = message as unknown as { model?: unknown; provider?: unknown }
  return [{
    kind: 'turn-usage',
    sessionId: sid,
    inputTokens: usage.totalTokens,
    totalTokens: usage.totalTokens,
    // gen-stats 扩展字段（pi usage/output 结构 AssistantMessage 自带；缺省 null 禁 ?? 0）
    outputTokens: typeof usage.output === 'number' ? usage.output : null,
    cacheRead: typeof usage.cacheRead === 'number' ? usage.cacheRead : null,
    cacheWrite: typeof usage.cacheWrite === 'number' ? usage.cacheWrite : null,
    input: typeof usage.input === 'number' ? usage.input : null,
    model: typeof msgExtra.model === 'string' && msgExtra.model !== '' ? msgExtra.model : null,
    provider: typeof msgExtra.provider === 'string' && msgExtra.provider !== '' ? msgExtra.provider : null,
  }]
}

/**
 * 从 select 的 options[0] 提取 JSON payload（marker 通道约定：options 单元素、
 * 序列化 JSON）。非合法 JSON 或空 options 返回 undefined，由调用方决定降级路径
 * （session-manager 折叠 __malformed__ 哨兵 / ask-user 降级普通 select）。
 */
function parseSelectOptionsPayload(event: PiExtensionUiRequestEvent): unknown {
  const rawOptions = Array.isArray(event.options) ? event.options : []
  try {
    return rawOptions.length > 0 ? JSON.parse(String(rawOptions[0])) : undefined
  } catch {
    return undefined
  }
}

/** extension.ui_request 的前端 WS 广播消息事件（与内部路由事件成对发出）。 */
function extensionUiRequestBroadcast(payload: Record<string, unknown>): PiTranslatedEvent {
  return {
    kind: 'message',
    message: { type: 'extension.ui_request' as ServerMessageType, payload },
  }
}

/**
 * subagent 在途上报帧形状判定（select + title = SUBAGENT_INFLIGHT_MARKER，u7b）。
 *
 * translate() 的守卫分支与 EventAdapter 监听器旁路（consumeInflightReport）共用本判定，
 * 防「两处标记判定漂移」：translate 侧只保证不广播，旁路侧负责镜像 + ack。
 */
function isInflightReportFrame(event: PiEvent): boolean {
  const e = event as unknown as { type?: unknown; method?: unknown; title?: unknown }
  return e.type === 'extension_ui_request' && e.method === 'select' && e.title === SUBAGENT_INFLIGHT_MARKER
}

/**
 * extension_ui_request{method:'setStatus'} → status-set（interpreter 路由 server）+
 * status-broadcast（WS 帧）。审计项 B（协议 spec §8.1）：保留 text（stripAnsi 后纯文本，
 * 向后兼容）+ textRaw（原始 ANSI 文本），前端可选 textRaw 做 ANSI 着色渲染，text 作纯文本兜底。
 */
function translateStatusRequest(event: PiExtensionUiRequestEvent, sid: string): PiTranslatedEvent[] {
  const key = String(event.statusKey ?? '')
  const raw = String(event.statusText ?? '')
  const text = stripAnsi(raw)
  return [
    { kind: 'status-set', sessionId: sid, key, text, textRaw: raw },
    {
      kind: 'status-broadcast',
      message: {
        type: EXTENSION_EVENTS.STATUS as ServerMessageType,
        payload: { sessionId: sid, statusKey: key, text, textRaw: raw },
      },
    },
  ]
}

/**
 * setWidget 的 GUI 协议 marker 检测：单行以 NUL marker 开头 → 结构化 widget。
 * 命中且解码/校验成功返回 WS 事件数组；marker 未命中、形状校验失败或 JSON 解析失败
 * 返回 undefined（调用方降级纯文本 widget 路径），warn 输出与原实现逐字一致。
 */
function tryDecodeWidgetGui(sid: string, widgetKey: string, rawLines: unknown[]): PiTranslatedEvent[] | undefined {
  if (!(rawLines.length === 1 && typeof rawLines[0] === 'string' && (rawLines[0] as string).startsWith(GUI_WIDGET_MARKER))) {
    return undefined
  }
  try {
    const json = (rawLines[0] as string).slice(GUI_WIDGET_MARKER.length)
    const decoded: unknown = JSON.parse(json)
    // v1.1 wire：GuiRenderResult 信封 {v, component, meta?} → 解包 component + meta
    // （meta = widget 宿主元数据，前端 WidgetArea 渲染统一 head）
    if (isGuiRenderResult(decoded)) {
      return [{
        kind: 'message',
        message: {
          type: EXTENSION_EVENTS.WIDGET_GUI as ServerMessageType,
          payload: {
            sessionId: sid,
            widgetKey,
            gui: decoded.component,
            ...(decoded.meta !== undefined ? { meta: decoded.meta } : {}),
          },
        },
      }]
    }
    // v1 wire（兼容窗口）：裸 GuiComponent（旧版 extension 发出的格式）
    if (isGuiComponent(decoded)) {
      return [{
        kind: 'message',
        message: {
          type: EXTENSION_EVENTS.WIDGET_GUI as ServerMessageType,
          payload: { sessionId: sid, widgetKey, gui: decoded },
        },
      }]
    }
    console.warn('[EventAdapter] widgetGui marker decoded but not a valid GuiComponent, falling back to text widget', decoded)
    return undefined
  } catch (e) {
    // marker 检测命中但 JSON 解析失败 → 降级为纯文本 widget
    console.warn('[EventAdapter] widgetGui marker JSON parse failed, falling back to text widget', e)
    return undefined
  }
}

/** setWidget → WS event（检测 subagent streaming / GUI 协议 marker / 清除语义） */
function translateSetWidgetRequest(event: PiExtensionUiRequestEvent, sid: string): PiTranslatedEvent[] {
  const widgetKey = String(event.widgetKey ?? '')
  const rawLines = Array.isArray(event.widgetLines) ? event.widgetLines as unknown[] : []

  // subagent streaming（路径 A-1）：widgetKey 匹配 subagent-stream-<recordId> 前缀。
  // pi 扩展层合并 text_delta 后用此 key 转发累积全文。短路——不走后续 widget 逻辑。
  const streamMatch = widgetKey.match(/^subagent-stream-(.+)$/)
  if (streamMatch) {
    const recordId = streamMatch[1]
    const lines = rawLines.length > 0 ? rawLines.map((l) => String(l)) : undefined
    return [{ kind: 'subagent-stream', sessionId: sid, recordId, lines }]
  }

  // 清除语义：widgetLines 缺失或空数组 → extension 清除此 widget（guiSetWidget(key, undefined)）。
  // 发 extension:widgetGui 带 gui:null，前端据此删 guiWidgetsByTab 条目 + 清 lines。
  // 不能只发 extension:widget（lines:[]）——前端 widget handler 不触碰 guiWidgetsByTab，
  // 会导致结构化 widget 永驻。
  if (rawLines.length === 0) {
    return [{
      kind: 'message',
      message: {
        type: EXTENSION_EVENTS.WIDGET_GUI as ServerMessageType,
        payload: { sessionId: sid, widgetKey, gui: null },
      },
    }]
  }

  // GUI 协议 marker 检测：命中且解码成功短路返回；未命中/失败 → 降级纯文本 widget。
  const guiEvents = tryDecodeWidgetGui(sid, widgetKey, rawLines)
  if (guiEvents) return guiEvents

  // 原有行为：stripAnsi + string[]
  // marker 命中但校验/解析失败的行包含 NUL + marker 前缀（\x00XYZ_GUI_WIDGET:...），
  // 直接展示会给用户看乱码——剥离 marker 前缀后显示剩余 JSON 文本（或空行）。
  const widgetPayload = {
    sessionId: sid,
    widgetKey,
    lines: rawLines.map(l => {
      const s = String(l)
      const stripped = s.startsWith(GUI_WIDGET_MARKER) ? s.slice(GUI_WIDGET_MARKER.length) : s
      return stripAnsi(stripped)
    }),
  }
  return [{ kind: 'message', message: { type: EXTENSION_EVENTS.WIDGET as ServerMessageType, payload: widgetPayload } }]
}

/**
 * notify → extension.notify（fire-and-forget，pi 不等回复）。
 * pi rpc-mode.ts notify 发出 extension_ui_request{method:'notify'} 后不注册 pending、不等 response。
 * 不走 INTERACTIVE_UI_METHODS（不产 extension-ui kind → 不注册 timeout → 不弹模态对话框）。
 * 前端用 toast 渲染（非阻塞）。
 */
function translateNotifyRequest(event: PiExtensionUiRequestEvent, sid: string): PiTranslatedEvent[] {
  const rawType = String(event.notifyType ?? 'info')
  const level: 'info' | 'warn' | 'error' =
    rawType === 'error' ? 'error' : rawType === 'warning' ? 'warn' : 'info'
  return [{
    kind: 'message',
    message: {
      type: EXTENSION_EVENTS.NOTIFY as ServerMessageType,
      payload: {
        sessionId: sid,
        message: String(event.message ?? ''),
        level,
      },
    },
  }]
}

/**
 * session-manager 请求检测：select title 为 SESSION_MANAGER_MARKER → options[0] 是 JSON payload
 * （session-manager extension 序列化的 { action, params }）。
 * 检测成功后不走前端 UI，由 runtime SessionManagerHandler 直接处理并回写 response。
 * [HISTORICAL] 不发前端广播：曾照抄 ask-user/普通 select 模板附带 extension.ui_request
 * 广播，前端 CompanionBand 按 select 渲染出无 options 的空壳对话框且 pending 泄漏
 * （session-manager 请求由 handler 应答，前端永远无人 respond）——本通道纯 runtime 内部消化。
 */
function translateSessionManagerSelect(
  event: PiExtensionUiRequestEvent,
  sid: string,
  requestId: string,
): PiTranslatedEvent[] {
  const sessionManagerData = parseSelectOptionsPayload(event) as { action?: unknown; params?: unknown } | undefined
  // 集合守卫把解析出的 action 收窄为协议联合；非法/缺失值折叠为 '__malformed__'
  // 哨兵（handler 的 malformed 与 default 分支同走 cancelled 回 null）。
  const rawAction = sessionManagerData?.action
  const action = typeof rawAction === 'string' && (SESSION_MANAGER_ACTIONS as readonly string[]).includes(rawAction)
    ? (rawAction as SessionManagerAction)
    : '__malformed__'
  // params 收窄（与 action 侧集合守卫同款防线；handler 侧另有逐 action 类型守卫）
  const rawParams = sessionManagerData?.params
  const params = typeof rawParams === 'object' && rawParams !== null
    ? (rawParams as Record<string, unknown>)
    : {}

  return [{ kind: 'session-manager-ui', requestId, sessionId: sid, action, params }]
}

/**
 * bridge 请求检测（设计 bridge-rewrite-pi-0.84 §3.3-D6）：select title 为 BRIDGE_MARKER →
 * options[0] 是 JSON 序列化的 BridgeRequest（协议 v2）。识别成功产出既有 bridge-ui kind
 * 交 interpreter 路由 bridge-handler（method 分派逻辑不动）。
 * 与 session-manager 分支同构：不产 extension-ui kind（不弹前端、不注册弹窗超时）。
 * 解析失败（非 JSON / 缺 method / method 不在 BRIDGE_METHODS 集合）折叠为
 * 'bridge:malformed' 哨兵请求——event-adapter 是纯翻译层无 client 句柄，回包必须经
 * handler（bridge:malformed case 回 E5 错误，不静默丢弃——失败要出声）。
 */
function translateBridgeSelect(
  event: PiExtensionUiRequestEvent,
  sid: string,
  requestId: string,
): PiTranslatedEvent[] {
  const rawBridge = parseSelectOptionsPayload(event) as Partial<BridgeRequest> | undefined
  const rawBridgeMethod = rawBridge?.method
  // method 集合守卫（与 session-manager action 守卫同款防线）：判别字段合法才走正常分派
  if (typeof rawBridgeMethod === 'string' && (BRIDGE_METHODS as readonly string[]).includes(rawBridgeMethod)) {
    // data = BridgeRequest 除 method 外的字段集，照 bridge-handler 的消费形状组装
    //（tool_execute 读 toolName/toolCallId/params，event/intercept 读 eventName/data）
    const bridgeData: Record<string, unknown> = {}
    const bridgeFieldKeys = ['toolName', 'toolCallId', 'params', 'sessionId', 'eventName', 'data'] as const
    for (const key of bridgeFieldKeys) {
      if (rawBridge?.[key] !== undefined) bridgeData[key] = rawBridge[key]
    }
    return [{ kind: 'bridge-ui', requestId, sessionId: sid, method: rawBridgeMethod, data: bridgeData }]
  }
  // malformed 哨兵：raw 带原始 payload 供 handler 日志留痕（非 JSON 时回退原始 options 字符串）
  const rawOptions = Array.isArray(event.options) && event.options.length > 0 ? String(event.options[0]) : ''
  return [{
    kind: 'bridge-ui',
    requestId,
    sessionId: sid,
    method: 'bridge:malformed',
    data: { raw: rawBridge ?? rawOptions },
  }]
}

/**
 * ask-user 富交互请求检测：select title 为 ASK_USER_MARKER → options[0] 是 JSON payload
 * （askUserInteract helper 序列化的 { questions, allowCancel }）。
 * 检测成功后透传 questions 等字段，前端路由到 AskUserOverlay；检测失败（非合法 JSON /
 * questions 空）返回 undefined，由调用方降级为普通 select。
 */
function tryTranslateAskUserSelect(
  event: PiExtensionUiRequestEvent,
  sid: string,
  requestId: string,
  dialogMethod: ExtensionInteractMethod,
): PiTranslatedEvent[] | undefined {
  const askUserData = parseSelectOptionsPayload(event) as { questions?: unknown; allowCancel?: boolean } | undefined
  if (!(Array.isArray(askUserData?.questions) && askUserData.questions.length > 0)) {
    return undefined
  }
  const requestPayload = {
    sessionId: sid,
    requestId,
    method: 'select',              // 仍是 select（复用回传通道）
    askUser: true,                 // 标记 ask-user 富交互，前端据此路由到 AskUserOverlay
    askUserQuestions: askUserData.questions,
    allowCancel: askUserData.allowCancel ?? true,
  }
  return [
    // ★ extension-ui kind 事件：EventInterpreter 据此暂停 watchdog，并通知 server 跟踪请求 + 缓存 pending 请求。
    // 2026-07-16 后 extension UI 不超时，block 等待用户响应。
    { kind: 'extension-ui', requestId, sessionId: sid, method: dialogMethod, payload: requestPayload },
    extensionUiRequestBroadcast(requestPayload),
  ]
}

/**
 * 普通 select / confirm / input / editor（无 marker 命中，或 ask-user 检测失败降级到此）。
 * [HISTORICAL] options 透传修复：pi select 严格传 string[]（types.ts select 签名 +
 * rpc-mode.js 原样透传），旧代码把 rawOptions 断言为 Array<{label,value}> 后 .map(o=>o.label)
 * 对 string 元素调 .label 产出 undefined[]——普通 select 在前端是坏的。改为 .map(String) 透传。
 */
function translatePlainDialogRequest(
  event: PiExtensionUiRequestEvent,
  sid: string,
  requestId: string,
  dialogMethod: ExtensionInteractMethod,
): PiTranslatedEvent[] {
  const method = event.method as string
  const rawOptions = Array.isArray(event.options) ? event.options : undefined
  const requestPayload = {
    sessionId: sid,
    requestId,
    method,
    title: event.title,
    message: event.message,
    options: rawOptions ? rawOptions.map(String) : undefined,
    default: event.default as string | undefined,
    level: event.level as 'info' | 'warn' | 'error' | undefined,
    prefill: method === METHOD_EDITOR ? (event.prefill as string | undefined) : undefined,
  }
  return [
    { kind: 'extension-ui', requestId, sessionId: sid, method: dialogMethod, payload: requestPayload },
    extensionUiRequestBroadcast(requestPayload),
  ]
}

/**
 * Interactive dialog methods: confirm, select, input, editor (notify 已在上方独立分支处理)。
 * [HISTORICAL] 旧 bridge 通道的 method.startsWith('bridge:') 前缀分支已删除（设计
 * bridge-rewrite-pi-0.84 §3.3-D6 清理批）：pi 0.84.4 下 ExtensionAPI 无自定义
 * extension_ui_request method 能力，旧通道永不可达；新通道 method 恒为 'select'，
 * 经 BRIDGE_MARKER 识别进入 bridge-ui kind。
 */
function translateInteractiveRequest(event: PiExtensionUiRequestEvent, sid: string): PiTranslatedEvent[] {
  const method = event.method as string
  const dialogMethod = method as ExtensionInteractMethod
  const requestId = String(event.id ?? '')

  if (method === 'select' && event.title === SESSION_MANAGER_MARKER) {
    return translateSessionManagerSelect(event, sid, requestId)
  }
  if (method === 'select' && event.title === BRIDGE_MARKER) {
    return translateBridgeSelect(event, sid, requestId)
  }
  if (method === 'select' && event.title === ASK_USER_MARKER) {
    const askEvents = tryTranslateAskUserSelect(event, sid, requestId, dialogMethod)
    if (askEvents) return askEvents
    // 检测失败（非合法 JSON / questions 空）→ 降级普通 select（下方分支）
  }
  return translatePlainDialogRequest(event, sid, requestId, dialogMethod)
}

/** extension_ui_request — route by method (setStatus, setWidget, editor, etc.) */
function handleExtensionUIRequest(event: PiExtensionUiRequestEvent, sid: string): PiTranslatedEvent[] {
  const method = event.method as string

  if (method === 'setStatus') return translateStatusRequest(event, sid)

  if (method === 'setWidget') return translateSetWidgetRequest(event, sid)

  // setEditorText → extension:setEditorText
  if (method === 'set_editor_text') {
    return [{ kind: 'message', message: { type: 'extension:setEditorText', payload: { sessionId: sid, text: String(event.text ?? '') } } }]
  }

  if (method === 'notify') return translateNotifyRequest(event, sid)

  if (method && INTERACTIVE_UI_METHODS.has(method as ExtensionInteractMethod)) {
    return translateInteractiveRequest(event, sid)
  }

  return [{ kind: 'noop' }]
}

/** message_start — role-based routing for non-assistant messages */
function handleMessageStart(event: PiMessageStartEvent, sid: string): PiTranslatedEvent[] {
  // pi 事件是强类型契约（ADR-0037），但 message_start.message 含 pi 声明之外的运行时字段
  // （summary / tokensBefore / fromId / customType / details / display），且 assistant turn 开始时
  // message 缺省。此处局部放宽为 Record 提取这些超范围字段。
  const msg = event.message as unknown as Record<string, unknown> | undefined
  if (!msg) {
    // assistant turn 开始（无 role）。生成 messageId 供 file_changes 挂载，并跟踪到 interpreter 态。
    const messageId = `a-${randomUUID()}`
    return [
      { kind: 'turn-start', messageId },
      { kind: 'message', message: { type: 'message.message_start', payload: { sessionId: sid, messageId } } },
    ]
  }

  const role = msg.role as string | undefined

  // [HISTORICAL] user role 的 message_start 必须忽略（A-08，W3 时序注释更新）：
  // pi 0.84.1 实态 = **agent 循环开头 + turn 边界注入 pending 时**发射——pi-agent-core
  // agent-loop.js:52-54（runAgentLoop 入口：agent_start → turn_start → 逐 prompt emit
  // message_start/end{role:'user'}，先于首个 assistant 流）与 :95-99（runLoop turn 边界
  // 注入 pending（steering/followUp 转入的 user 消息）时 emit）。实测事件序：
  // agent_start → turn_start → message_start{user} → message_end{user} → message_start{assistant}
  // → message_update*...（旧注释「每个 turn 末尾 emit」描述的是 toolResult role 的 message_start，
  // agent-loop.js:550 emitToolResultMessage——turn 末尾发的是 toolResult，非 user）。
  // 若不过滤 user role，前端会为 user prompt 再建一个空气泡（渲染撕裂、findLastAssistantIndex
  // 错位）。fork 0.75.5 不发此事件；切 upstream 0.80.3（ac83b578）后出现。与 toolResult
  // 同属「内部记账」语义。过滤行为不变。
  if (role === 'user') return [{ kind: 'noop' }]

  // toolResult 是 pi agent-core 工具执行完毕的内部记账（agent-loop.js emitToolResultMessage：
  // executeToolCalls 后 emit message_start/end{role:'toolResult'}）。
  // 前端已通过 tool_execution_end 拿到 output，toolResult message_start 对前端是噪声——
  // 若转发，chat-chunk-processor 会建空 assistant message，干扰 findLastAssistantIndex
  // 导致后续 tool_call_end 匹配错位（toolCall 永久卡 running）。
  // 与历史路径 message-converter.ts:36（toolResult 合并进父 assistant，非独立消息）语义一致。
  if (role === 'toolResult') return [{ kind: 'noop' }]

  // [HISTORICAL] compactionSummary / branchSummary 的 message_start 分支已在 M5 删除——
  // grep 历史 session JSONL 确认 pi 从不 emit message_start{role:compactionSummary|branchSummary}
  //（死分支）。压缩/分支摘要改由 compaction_end 事件（event-interpreter.handleCompactionEnd）
  // 与 entry 树重建（mapSessionEntries → convertPiHistory）两条通路覆盖，不经 message_start。
  // custom message from pi.sendMessage（扩展注入的结构化通知，如 subagent-bg-notify）。
  // 用独立 type 'message.customStart'，与 assistant turn 的 message_start 区分——
  // 前端 message_start handler 默认建 role:'assistant' 气泡，custom 不应走那条路径。
  // subagent-directive 类 custom 消息在此仍走 generic 通路（display:false → 前端不可见），
  // 可见的定向气泡由 message_end 侧附加的 subagent.directive 广播驱动（见 handleMessageEnd），
  // 此处不特判——特判会产生第二条可见通路导致双气泡。
  // customType 字段经 typeof 收窄（type-safety review：来源是 extension 第三方代码，
  // 畸形值不得以谎报类型进 wire 帧）；content/details/display 同款守卫缺省。
  if (typeof msg.customType === 'string') {
    const customDetails = typeof msg.details === 'object' && msg.details !== null && !Array.isArray(msg.details)
      ? (msg.details as Record<string, unknown>)
      : undefined
    return [{
      kind: 'message',
      message: {
        type: 'message.customStart',
        payload: {
          sessionId: sid,
          customType: msg.customType,
          content: typeof msg.content === 'string' ? msg.content : undefined,
          details: customDetails,
          display: typeof msg.display === 'boolean' ? msg.display : undefined,
        },
      },
    }]
  }
  // 兜底：assistant turn（有 msg 但无 role）—— 同样生成 messageId 供 file_changes 挂载 + 采 baseline。
  const fallbackId = `a-${randomUUID()}`
  return [
    { kind: 'turn-start', messageId: fallbackId },
    { kind: 'message', message: { type: 'message.message_start', payload: { sessionId: sid, messageId: fallbackId } } },
  ]
}

/**
 * message_end 允许下发的 role 白名单（business-logic review S2 结构防线）。
 *
 * pi 0.84.1 实证（agent-session.js:380「Other message types (bashExecution, compactionSummary,
 * branchSummary) are persisted elsewhere」；recordBashResult :2225 直 appendMessage 不 emit）
 * 这些 role 不经 message_end 事件。但该假设此前只存在于注释——若未来 pi 版本对未建模
 * role 补发 message_end，registry 端会将其喂 applyEntry 的 append 分支，与 bashResultEffect
 * / compactionSummary effect 已各自喂入的一次构成 reducer messages 双计（正是「live ≡ reload」
 * 要消灭的 bug 形态）。此处白名单把协议假设升级为结构防线：未列 role warn + 跳过。
 *
 * custom 判定对齐 handleMessageStart（msg.customType 存在而非 role === 'custom'——pi custom
 * message 的权威标识是 customType 字段）。
 */
const MESSAGE_END_ALLOWED_ROLES = new Set(['user', 'assistant', 'toolResult'])

/**
 * message_end — 重构 message entry 作为实时 feed 载体（W21，D5 单一 reducer 双路喂入的实时侧）。
 *
 * pi 把 message_end 作为 user/assistant/toolResult/custom 四种 message 持久化的唯一触发点
 * （agent-session.ts:545-561：emit message_end → appendMessage/appendCustomMessageEntry），
 * 事件流顺序 ≡ entry 追加顺序——这是 live ≡ reload 的协议层依据（W5 实测）。
 *
 * entry 字段：
 * - id 恒缺省：pi 在 emit **之后**才 appendMessage 分配 uuidv7 entry id，事件上拿不到。
 *   reducer 按 `e<N>` 确定性派生；W22 权威对账（broadcast≡get_state）靠 get_entries。
 * - timestamp 取 message.timestamp（message 对象内字段，与持久化 entry 的 .message 同源），
 *   缺失时降级当前时间（与 liftHistoryToEntries 同点位，保 reducer 输入确定后输出确定）。
 * - turnId 不填：pi 事件不带 turn 边界信息，值填充归 fix-chat-flow-order 分组 wave（类型契约
 *   字段稳定存在即可，不写投机代码——pi 上游若补 turnId 只改本构造点，reducer 不动）。
 *
 * 与 message_start 的 role 过滤（[HISTORICAL] user/toolResult 记账噪声）不同：message_end 是
 * 权威 entry 流，已建模 role（user/assistant/toolResult/custom，见 MESSAGE_END_ALLOWED_ROLES）
 * 全量下发不过滤——user 消息与 appendUser 的乐观插入、toolResult 与 tool_execution_end 的
 * 回填，去重/合并归 core store 的 reducer 接入层编排。未建模 role（bashExecution 等）由
 * 白名单防线跳过（双计防线）。
 *
 * subagent-directive custom message 在本 handler 附加 subagent.directive 定向广播
 * （composer-symbol-system §3.3.3a live 链路）——挂 message_end 不挂 message_start 的
 * 原因见下方内联注释。
 */
function handleMessageEnd(event: PiMessageEndEvent, sid: string): PiTranslatedEvent[] {
  const msg = event.message as unknown as Record<string, unknown> | undefined
  if (msg === undefined || typeof msg.role !== 'string') {
    // 防御：message_end 恒带 message（pi 契约），缺失/畸形时降级丢弃（warn 可观测，不中断事件流）
    console.warn(`[EventAdapter] message_end without message or role, skipping sid=${sid}`)
    return [{ kind: 'noop' }]
  }
  const isCustom = typeof msg.customType === 'string'
  if (!isCustom && !MESSAGE_END_ALLOWED_ROLES.has(msg.role)) {
    // 未建模 role 防线：pi 当前不经 message_end 发这些 role，命中说明 pi 行为漂移——
    // warn 可观测 + 跳过（防 registry 端与既有 effect 双计），不中断事件流。
    console.warn(
      `[EventAdapter] message_end with unmodeled role '${msg.role}', skipping (dual-count guard, sid=${sid})`,
    )
    return [{ kind: 'noop' }]
  }
  const tsMs = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
  const entry: PiMessageEntry = {
    type: 'message',
    parentId: null,
    timestamp: new Date(tsMs).toISOString(),
    message: msg as PiMessageEntry['message'],
  }
  const events: PiTranslatedEvent[] = [{
    kind: 'message',
    message: {
      type: 'message.message_end' as ServerMessageType,
      payload: { sessionId: sid, entry },
    },
  }]
  // subagent-directive：附加定向广播（renderer U2b 聊天流插定向气泡的 live 信号）。
  // 为什么挂 message_end 而非 message_start：pi sendMessage（无 triggerTurn）对同一 custom
  // message 双发 message_start + message_end（0.84.1 dist agent-session.js:1093-1096，append
  // 后连发两事件），挂 start 会双广播；message_end 是持久化锚定事件（上方 W21 注释：live ≡
  // reload 的协议层依据），定向广播数据源即持久化 entry。payload 字段经
  // shared.parseSubagentDirective 单点解析（与 reload 链路 mapSessionEntries 同一解析器，
  // 字段一致性构造性成立）；details 畸形 → 不广播（降级为不可见 generic custom 消息，
  // 与 reload 侧 display 透传不覆写的降级行为对称）。
  if (isCustom && msg.customType === SUBAGENT_DIRECTIVE_CUSTOM_TYPE) {
    const directive = parseSubagentDirective(msg.content, msg.details)
    if (directive) {
      events.push({
        kind: 'message',
        message: {
          type: 'subagent.directive',
          payload: {
            sessionId: sid,
            subagentId: directive.subagentId,
            slug: directive.slug,
            direction: directive.direction,
            text: directive.text,
          },
        },
      })
    }
  }
  return events
}

/**
 * update 帧流式输出尾窗上限（设计 bash-running-stream-output §6.4 D4）：
 * message.tool_call_update 是 stream 类消息入 WS replay ring（1000 帧），不截断则
 * 单帧 output/outputRaw 双字段可至 pi 快照 50KB 量级 → ring 满载 ≈100MB 常驻。
 */
const STREAM_OUTPUT_CAP_BYTES = 8192

/** ANSI CSI 序列终止字节区间下界（ESC 序列以 0x40 收尾） */
const ANSI_TERMINATOR_MIN = 0x40
/** ANSI CSI 序列终止字节区间上界（ESC 序列以 0x7E 收尾） */
const ANSI_TERMINATOR_MAX = 0x7e
/** '[' 的 ASCII 码：CSI 引导字节，虽落在终止区间但判定时须排除（见 tailWindow 注释） */
const CSI_INTRODUCER = 0x5b
/** Unicode 低代理区下界（孤儿低代理 = 劈开代理对，起点前移一位） */
const LOW_SURROGATE_MIN = 0xdc00
/** Unicode 低代理区上界 */
const LOW_SURROGATE_MAX = 0xdfff

/** CSI 序列终止字节区间（ANSI ESC 序列以 0x40-0x7E 收尾，仅对 CSI 充分——OSC/DCS 残段按字面渲染为已接受代价）。 */
function isAnsiTerminator(code: number): boolean {
  return code >= ANSI_TERMINATOR_MIN && code <= ANSI_TERMINATOR_MAX
}

/**
 * 尾部保留截断（D4 两分支，不变式「截断后 ≤ cap 无例外」）：
 * - 换行锚分支：截断点（len - cap）之后存在换行 → 从首个换行起保留尾窗（整行起步，长度 < cap）；
 * - 硬切回退分支（三步管线）：① 在截断点硬切 → ② ANSI 残片推进（截断点落在 CSI 序列中段——
 *   向前最近 \x1b 到截断点无终止字节——则起点推进到残缺序列的 CSI 终止字节 +1）→
 *   ③ 码点边界回退（起点为孤儿低代理——前一码元是高代理 0xD800-0xDBFF——则前移一位，不劈开代理对）。
 * 步骤 ②③ 只会推进起点（丢弃更多），截断结果恒 ≤ cap。
 */
function tailWindow(text: string, cap: number): string {
  if (text.length <= cap) return text
  const cut = text.length - cap
  const newlineIdx = text.indexOf('\n', cut)
  if (newlineIdx !== -1) return text.slice(newlineIdx + 1)
  let start = cut
  // ANSI 残片推进：判定截断点是否落在残缺 CSI 序列内。
  // 注意：'['（0x5B）虽在终止字节区间，但它是 CSI 引导字节——判定时排除紧随 ESC 的 '['，
  // 否则任何 CSI 序列都被立即判“已终止”，中段检测永不可达（设计 D4 要求覆盖 CSI 中段用例）。
  const escIdx = text.lastIndexOf('\x1b', cut - 1)
  if (escIdx !== -1) {
    let terminated = false
    for (let i = escIdx + 1; i < cut; i++) {
      if (i === escIdx + 1 && text.charCodeAt(i) === CSI_INTRODUCER) continue
      if (isAnsiTerminator(text.charCodeAt(i))) {
        terminated = true
        break
      }
    }
    if (!terminated) {
      for (let i = start; i < text.length; i++) {
        if (isAnsiTerminator(text.charCodeAt(i))) {
          start = i + 1
          break
        }
      }
    }
  }
  // 码点边界回退：起点落在低代理区 = 前一高代理被劈开，前移一位
  if (start > 0 && start < text.length) {
    const code = text.charCodeAt(start)
    if (code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX) start += 1
  }
  return text.slice(start)
}

/**
 * content 数组形态（AgentToolResult 规范形态）partialResult → 流式文本归一 + 尾窗截断。
 * 截断发生在 stripAnsi 之前的原文上；截断后的原文重新包装走 normalizePiToolResult，
 * output（stripAnsi）/ outputRaw（含 ANSI 时）由构造同源派生——不变式
 * 「当 outputRaw 存在时 output === stripAnsi(outputRaw)」成立。images running 态不消费。
 */
function normalizeWithTailCap(raw: Record<string, unknown>): { output: string; outputRaw?: string } {
  const rawText = (raw.content as Array<Record<string, unknown>>)
    .filter((c) => c.type === 'text')
    .map((c) => (c.text as string) ?? '')
    .join('\n')
  const tail = tailWindow(rawText, STREAM_OUTPUT_CAP_BYTES)
  const { output, outputRaw } = normalizePiToolResult({ content: [{ type: 'text', text: tail }] })
  return outputRaw !== undefined ? { output, outputRaw } : { output }
}

/** tool_execution_update — forward detail (partialResult is unknown: string or object, extract details if present) */
function handleToolExecutionUpdate(event: PiToolExecutionUpdateEvent, sid: string): PiTranslatedEvent[] {
  // partialResult 是 unknown（pi 声明 any，运行时形态不定）。按 typeof 分流：
  //   object → 提取 .details（含 __gui__），无 details 时 fallback 用整个对象（兼容 subagent 扁平 progress）。
  //   string → 原样作 detail。
  const partialResult = event.partialResult
  const detail: string | Record<string, unknown> | undefined =
    partialResult != null && typeof partialResult === 'object'
      ? ((partialResult as Record<string, unknown>).details as Record<string, unknown> | undefined)
        ?? (partialResult as Record<string, unknown>)
      : (partialResult as string | undefined)
  // content 数组形态（pi bash 快照）→ 归一流式文本并尾窗截断；其余形态不产出 output（判别式防非规范形态污染）
  const normalized =
    partialResult != null &&
    typeof partialResult === 'object' &&
    Array.isArray((partialResult as Record<string, unknown>).content)
      ? normalizeWithTailCap(partialResult as Record<string, unknown>)
      : undefined
  return [{
    kind: 'message',
    message: {
      type: 'message.tool_call_update',
      payload: {
        sessionId: sid,
        toolCallId: event.toolCallId,
        detail,
        ...(normalized?.output !== undefined && { output: normalized.output }),
        ...(normalized?.outputRaw !== undefined && { outputRaw: normalized.outputRaw }),
      },
    },
  }]
}

/** extension_error — field rename extensionPath → extensionName + errorEvent */
function handleExtensionError(event: PiExtensionErrorEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'extension.error',
      payload: {
        sessionId: sid,
        extensionName: event.extensionPath,
        error: event.error,
        errorEvent: event.event,
      },
    },
  }]
}

/** auto_retry_start → message.auto_retry_start */
function handleAutoRetryStart(event: PiAutoRetryStartEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'message.auto_retry_start',
      payload: {
        sessionId: sid,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      },
    },
  }]
}

/** auto_retry_end → message.auto_retry_end */
function handleAutoRetryEnd(event: PiAutoRetryEndEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'message.auto_retry_end',
      payload: {
        sessionId: sid,
        success: event.success,
        attempt: event.attempt,
        finalError: event.finalError,
      },
    },
  }]
}

/**
 * queue_update → message.queue_update（W8 D6：输出附深度信息）。
 *
 * 深度 = pendingMessageCount = steering.length + followUp.length（pi agent-session.ts
 * `get pendingMessageCount()` 同源公式，rpc-mode get_state 的 pendingMessageCount 字段同值）。
 * 本帧附带的深度 = pi 队列深度的**推送投影**（与 get_state 快照同公式同源、数值恒等，
 * PR #185 MF2 定口径）：renderer 对账（core registry reconcilePending）直读帧内值，
 * 不经任何 runtime 侧快照缓存——原 queue ReplicatedState 实例及 markDirty 失效接线
 * 已撤销（.get() 生产零消费，防抖重拉 get_state 属无效 RPC，登记表 #6 修订）。
 */
function handleQueueUpdate(event: PiQueueUpdateEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'message.queue_update',
      payload: {
        sessionId: sid,
        steering: [...event.steering],
        followUp: [...event.followUp],
        pendingMessageCount: event.steering.length + event.followUp.length,
      },
    },
  }]
}

/** session_info_changed → session.renamed + 内存态 label 回写（interpreter 编排） */
function handleSessionInfoChanged(event: PiSessionInfoChangedEvent, sid: string): PiTranslatedEvent[] {
  return [
    // 回写 session.label 内存态（interpreter 调 sessionService.setLabelCache——事件路径
    // 唯一写方，PR #185 MF1；label ReplicatedState 实例已撤销，无失效接线）
    { kind: 'session-renamed', name: event.name },
    {
      kind: 'message',
      message: {
        type: 'session.renamed',
        payload: { sessionId: sid, name: event.name },
      },
    },
  ]
}

/** thinking_level_changed → session.thinkingLevelSet + thinkingLevel 实例失效（interpreter 编排） */
function handleThinkingLevelChanged(event: PiThinkingLevelChangedEvent, sid: string): PiTranslatedEvent[] {
  const level = event.level
  return [
    // thinkingLevel 实例失效（interpreter 调 thinkingLevelState()?.markDirty()，事件只做
    // 失效不回写）——session.thinkingLevel 的写方是 setThinkingLevel RPC 命令路径，
    // 事件路径不触碰该缓存；前端即时更新走下方 session.thinkingLevelSet 帧
    { kind: 'thinking-level', level },
    { kind: 'message', message: { type: 'session.thinkingLevelSet', payload: { sessionId: sid, level } } },
  ]
}

/** status → message.status passthrough */
function handleStatus(event: PiStatusEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'message.status',
      payload: { sessionId: sid, status: event.status, detail: event.detail },
    },
  }]
}

/** error → message.error passthrough */
function handleError(event: PiErrorEvent, sid: string): PiTranslatedEvent[] {
  return [{
    kind: 'message',
    message: {
      type: 'message.error',
      payload: { sessionId: sid, message: event.message },
    },
  }]
}

/**
 * compaction_start → compaction-start 中间事件（interpreter 编排 compaction 生命周期，M4 事件驱动）。
 *
 * pi 手动/自动 compact 都发此事件（agent-session.js:1370 手动 reason:'manual' / :1608 自动
 * reason:'threshold'|'overflow'）。reason 原样透传，interpreter 据此广播 session.compacting{reason}
 * 并驱动前端文案区分手动/自动。
 */
function handleCompactionStart(event: PiCompactionStartEvent, _sid: string): PiTranslatedEvent[] {
  return [{ kind: 'compaction-start', reason: event.reason }]
}

/**
 * compaction_end → compaction-end 中间事件（interpreter 唯一驱动 compaction 终态，M4 事件驱动）。
 *
 * result/aborted/errorMessage 原样透传，失败判据由 interpreter 以 errorMessage 真值为准
 * （非 aborted 字段——pi 三种 aborted:true 形态在 errorMessage 真值层面一致，都 falsy）。
 * result 类型已收紧为 PiCompactionResult（M5，S5），interpreter 运行时读 summary/tokensBefore/estimatedTokensAfter。
 */
function handleCompactionEnd(event: PiCompactionEndEvent, _sid: string): PiTranslatedEvent[] {
  return [
    {
      kind: 'compaction-end',
      reason: event.reason,
      result: event.result,
      aborted: event.aborted,
      ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
    },
  ]
}

/**
 * entry_appended → record-entry-appended 失效信号（W18，D4）。
 *
 * pi 只对 extension appendEntry 发射本事件（agent-session.ts appendEntry 回调唯一发射点，
 * message entry 不发射——W25 契约测试固化）。customType 过滤：只对 subagent-record /
 * workflow-record 自描述 entry 产出失效信号（interpreter → sessionService markDirty → 防抖
 * get_entries 增量重拉，唯一数据写路径），其他 custom type（含未来新增的 extension 自有
 * entry）no-op——避免无关 entry 触发拉取。
 *
 * 事件 payload（entry 对象）不进任何数据缓存：失效信号只携带 customType，数据本体由
 * get_entries 权威拉取获得（ReplicatedState「事件只做失效」核心不变量）。
 */
function handleEntryAppended(event: PiEntryAppendedEvent, _sid: string): PiTranslatedEvent[] {
  const entry = event.entry as { type?: unknown; customType?: unknown } | null
  if (!entry || entry.type !== 'custom') return [{ kind: 'noop' }]
  if (entry.customType === SUBAGENT_RECORD_CUSTOM_TYPE) {
    return [{ kind: 'record-entry-appended', customType: SUBAGENT_RECORD_CUSTOM_TYPE }]
  }
  if (entry.customType === WORKFLOW_RECORD_CUSTOM_TYPE) {
    return [{ kind: 'record-entry-appended', customType: WORKFLOW_RECORD_CUSTOM_TYPE }]
  }
  return [{ kind: 'noop' }]
}

/**
 * agent_settled —— run 级联结束信号（W1 fix-chat-flow-order，探针 ②）。
 *
 * pi 侧时序（0.84.1 dist 实测锚点）：_runAgentPrompt 的 finally 先
 * _flushPendingBashMessages()（agent-session.js:754，streaming 期间缓存的 bash entry
 * 此刻统一落盘）再 await _emitAgentSettled()（:755 → :327-336 emit agent_settled）。
 * 故本事件到达时，pi session 文件内 bash entry 已就位——dispatcher 据此 flush
 * per-session bash 待落列（message-dispatcher.flushPendingBashResults），xyz live
 * 入流位置构造性对齐 pi 落盘位置（级联末）。与 agent_end 的区别：followUp drain
 * 续跑发生在 _runAgentPrompt 内部 while 循环（同一次 settled 级联），agent_end 每
 * agent loop 迭代都发，不是级联边界。
 */
function handleAgentSettled(_event: PiAgentSettledEvent, _sid: string): PiTranslatedEvent[] {
  return [{ kind: 'agent-settled' }]
}

// ── Null-event types (lifecycle events not forwarded to frontend) ──
// 注意：turn_end 不在此列——它经 handleTurnEndPi 提取 usage 触发 context.update（见 DISPATCHER）。
// [W1 fix-chat-flow-order] agent_settled 移出此列（原「xyz-agent 不消费——显式登记忽略」）：
// bash entry 化（conversation-turn-attribution D2）需要它作「run 级联结束」信号——pi 在
// _runAgentPrompt 的 finally 先 _flushPendingBashMessages()（agent-session.js:744-756）再
// _emitAgentSettled()（:327-336），故 agent_settled 是唯一保证晚于 bash 落盘 flush 的可观测
// 信号（agent_end 不行：followUp drain 级联中每轮 agent loop 都发，非级联边界）。
// compaction_start/compaction_end 在 M4 移出此列（改事件驱动，interpreter 唯一编排 compaction 生命周期）。
// agent_start 在 M5 移出此列——其 hook 分支在 translate() 内单独消费（onPiEvent/agent_start hook，
// 消费方是插件 executeHooks，S1）。若放回 NULL_EVENTS 会被此处 short-circuit，hook 分支不可达。
// [W18] entry_appended 移出此列——对 subagent-record / workflow-record customType 产出失效信号
// （handleEntryAppended：subagent/workflow 派生缓存 markDirty → 防抖 get_entries 增量重拉），
// 其他 custom type no-op（W21 TODO(W18) 锚点在此兑现；message entry 不发射本事件，W25 契约）。
// [W21] message_end 移出此列——重构 message entry 喂前端 reducer（handleMessageEnd，实时 feed
// 权威载体）。pi 上游未来若为常规 message append 补发射 entry_appended：只换喂入源头
// （entry_appended → entry 构造），reducer 不动。
// [session-trace A33] agent_settled / message_end / entry_appended 同时追加 trace-trigger 输出
// （interpreter 调 onTraceSync 做追赶式 since 拉取）——与 W1/W18/W21 的 handler 经
// withTraceTrigger 组合注册，互不取代（见 DISPATCHER）。
// bash_execution_update：pi 0.84.1 新增 live bash 流事件（dist/core/agent-session.d.ts:103-106
// {type:"bash_execution_update", id?, delta}，emit 点 agent-session.js:2210 executeBash 的
// onChunk 回调），复用发起 bash RPC 的 id（docs/rpc.md:26）。rpc-client 的 resolve 守卫修复后
// 该事件正确流入本层，但 xyz 暂不做 live bash 流式 UI 消费（最终 output 经 bash RPC response
// 全量到达）——显式登记为已知 no-op，防止落入 default 分支被误判为「事件丢失」。
const NULL_EVENTS = new Set([
  'turn_start',
  'extension_config', 'extension_ui_response', 'response',
  'bash_execution_update',
])

/**
 * trace 增量腿触发事件（session-trace design D4 / A33）→ trace-trigger 中间事件。
 *
 * pi 无「每次 append 都广播」的 entry 事件（entry_appended 全仓唯一 emit 点在 extension
 * appendEntry 回调，agent-session.ts:2517），message / compaction / bash 的 append 均无
 * entry 级事件。改用三类现存事件作触发信号：message_end（每条消息 append 后）、
 * agent_settled（稳态兑底）、entry_appended（extension appendEntry）。payload 不需要——
 * interpreter 据此调 onTraceSync（get_entries(since) 追赶式拉取，pi 侧才是权威）。
 *
 * 这三类事件同时是 main 侧 W21（实时 feed）/ W1（bash flush）/ W18（派生缓存失效）的
 * 载体——DISPATCHER 单 handler 契约下用 withTraceTrigger 组合注册：原 handler 输出在前、
 * trace-trigger 追加在后，互不取代（曾因两组 DISPATCHER.set 叠加导致 Map 后写覆盖前写）。
 */
function withTraceTrigger(base: Handler): Handler {
  return (event, sid) => {
    const out = base(event, sid)
    // 运行时守卫收窄 trigger 字面量（组合点只注册这三个事件，守卫防未来误用扩大）
    return TRACE_TRIGGER_SOURCES.has(event.type)
      ? [...out, { kind: 'trace-trigger', trigger: event.type as 'message_end' | 'agent_settled' | 'entry_appended' }]
      : out
  }
}

const TRACE_TRIGGER_SOURCES = new Set(['message_end', 'agent_settled', 'entry_appended'])

// ── Dispatcher map ─────────────────────────────────────────────────
// handler 入参是窄类型（PiMessageUpdateEvent 等），DISPATCHER value 是联合入参签名。
// TS 逆变：窄入参 handler 不能直接赋给联合入参函数类型，注册处用 as 断言（运行时 event
// 已由 translate 按 type 分派，handler 只会收到匹配类型的 event）。
type Handler = (event: PiEvent, sid: string) => PiTranslatedEvent[]
const DISPATCHER = new Map<string, Handler>()
;(function registerHandlers() {
  DISPATCHER.set('message_update', handleMessageUpdate as Handler)
  DISPATCHER.set('tool_execution_start', handleToolExecutionStart as Handler)
  DISPATCHER.set('tool_execution_end', handleToolExecutionEnd as Handler)
  DISPATCHER.set('agent_end', handleAgentEnd as Handler)
  DISPATCHER.set('turn_end', handleTurnEndPi as Handler)
  DISPATCHER.set('extension_ui_request', handleExtensionUIRequest as Handler)
  DISPATCHER.set('message_start', handleMessageStart as Handler)
  // [W21] message_end：移出 NULL_EVENTS 后在此注册——重构 message entry 喂前端 reducer；
  // [session-trace A33] 组合追加 trace-trigger（interpreter onTraceSync 补拉）
  DISPATCHER.set('message_end', withTraceTrigger(handleMessageEnd as Handler))
  DISPATCHER.set('tool_execution_update', handleToolExecutionUpdate as Handler)
  DISPATCHER.set('extension_error', handleExtensionError as Handler)
  DISPATCHER.set('auto_retry_start', handleAutoRetryStart as Handler)
  DISPATCHER.set('auto_retry_end', handleAutoRetryEnd as Handler)
  DISPATCHER.set('queue_update', handleQueueUpdate as Handler)
  DISPATCHER.set('session_info_changed', handleSessionInfoChanged as Handler)
  DISPATCHER.set('thinking_level_changed', handleThinkingLevelChanged as Handler)
  // Simple passthrough handlers
  DISPATCHER.set('status', handleStatus as Handler)
  DISPATCHER.set('error', handleError as Handler)
  DISPATCHER.set('compaction_start', handleCompactionStart as Handler)
  DISPATCHER.set('compaction_end', handleCompactionEnd as Handler)
  // [W18] entry_appended：移出 NULL_EVENTS 后在此注册——subagent-record / workflow-record
  // 失效信号（handleEntryAppended），其他 custom type no-op；
  // [session-trace A33] 组合追加 trace-trigger
  DISPATCHER.set('entry_appended', withTraceTrigger(handleEntryAppended as Handler))
  // [W1 fix-chat-flow-order] agent_settled：run 级联结束信号（bash 待落列 flush 触发点，
  // 见 handleAgentSettled 注释）；[session-trace A33] 组合追加 trace-trigger
  DISPATCHER.set('agent_settled', withTraceTrigger(handleAgentSettled as Handler))
})()

/**
 * 诊断日志开关：`XYZ_DEBUG_PI_EVENTS=1` 时打印每个 pi 原始事件。
 *
 * 用途：定位「pi 卡死/坏 session」类问题（handoff 2026-07-04 P1）。坏 session 的特征
 * 是 JSONL 只有 session + session_info 两行、零 message——pi 接收了 prompt 创建了
 * session 但 LLM 调用从未成功产出 assistant 回复。开启此开关可观察坏 session 产生时
 * pi 到底发了什么事件（或什么都没发），从而区分：
 *   - 情况 A：pi 子进程静默卡死（无任何事件）→ 需 runtime 加 watchdog
 *   - 情况 B：pi 发了异常事件流（被 adapter 误吞/误译）→ adapter 逻辑修复
 *
 * 默认关闭，生产无噪声。复现步骤：dev 模式启动前 `export XYZ_DEBUG_PI_EVENTS=1`，
 * 复现坏 session 后查 runtime stdout 中该 sessionId 的事件序列。
 */
const DEBUG_PI_EVENTS = process.env.XYZ_DEBUG_PI_EVENTS === '1'

/**
 * 纯翻译：把单个 pi 事件翻译为 0~N 个中间事件。
 *
 * 无副作用、无可变态、不 import services 域类型。组合根负责把 translate 的结果
 * 喂给 EventInterpreter 做业务编排。
 */
export function translate(event: PiEvent, sessionId: string): PiTranslatedEvent[] {
  const eventType = event.type as string

  if (DEBUG_PI_EVENTS) {
    // 抓 pi 原始事件全貌：type + sessionId + 完整 JSON。安全起见不截断（复现场景事件量可控）。
    // JSON.stringify 对含循环引用的 pi 事件会 throw，降级打印对象本身（诊断目的已达成）。
    let serialized: string
    try {
      serialized = JSON.stringify(event)
    } catch {
      serialized = '(JSON.stringify failed)'
    }
    console.log(`[PiEvent:raw] type=${eventType} sid=${sessionId} ${serialized}`, serialized === '(JSON.stringify failed)' ? event : '')
  }

  // subagent 在途上报帧守卫（u7b，设计 §3.3 D5）：marker 帧恒不产出任何前端广播。
  // 生产路径上帧已被 EventAdapter 监听器旁路消费（consumeInflightReport，含镜像 + ack），
  // 此守卫覆盖直调 translate 的路径——结构性消灭「marker 帧落回普通 select 分支 →
  // 前端出现无人应答的弹窗 pending 泄漏」形态（[HISTORICAL] session-manager 同类教训）。
  if (isInflightReportFrame(event)) return []

  // Lifecycle events that produce no output
  if (NULL_EVENTS.has(eventType)) return []

  // agent_start — 仅产 hook 事件（interpreter 触发 onPiEvent/agent_start hook）
  if (eventType === 'agent_start') {
    return [{ kind: 'hook', eventType: 'agent_start', data: {} }]
  }

  // Dispatch to registered handler
  const handler = DISPATCHER.get(eventType)
  if (handler) return handler(event, sessionId)

  console.warn('[EventAdapter] Unhandled pi event type:', eventType)
  return []
}

/**
 * 记录 interpret 隔离失败：单批翻译事件的编排（hook/diff/WS 转发）抛错时调用。
 *
 * 设计决策——为何此处只记录而不 re-throw / 不向用户广播：
 * - 不 re-throw：listener 跑在 pi 事件订阅回调里，re-throw 会让后续事件
 *   （含 agent_end / 最终消息）无法投递，单条坏事件炸掉整条事件流。
 * - 不在此广播 error 事件给用户：EventAdapter 是 infra 纯翻译器，按设计不持有
 *   WS send 句柄（副作用收敛在 service 层 EventInterpreter）。用户可感知的错误
 *   反馈应由 interpreter 在其自身 try 边界内负责，而非本层。
 * 故此处仅做诊断日志 + 隔离（订阅保持存活，后续事件照常处理）。
 */
function logInterpretFailure(sessionId: string, eventCount: number, err: unknown): void {
  console.error(
    `[EventAdapter] interpret error (isolated; stream continues) sid=${sessionId} events=${eventCount}:`,
    err,
  )
}

// ── EventAdapter class ─────────────────────────────────────────────

export type WsSender = (msg: ServerMessage) => void

/**
 * pi 事件订阅端的最小能力面（EventAdapter.attach 入参，结构窄化）。
 *
 * sendExtensionUiResponse 可选（IPiEngine / RpcClient 天然满足）：仅 subagent 在途上报的
 * ack 回包用（u7b）；缺省时在途帧仍写镜像，仅不回 ack（reporter 按既有折叠重试）。
 */
export interface PiEventClient {
  onEvent(listener: PiEventListener): () => void
  sendExtensionUiResponse?(id: string, response: unknown, method?: string): void
}

/**
 * 绑定一个 pi session 的事件适配器：订阅事件 → 翻译 → 经 interpreter 回调消费。
 *
 * 纯订阅器：不持有业务态（currentMessageId/writeContents/diffChain 帧序态全部移到 interpreter），
 * 不直接 send —— 把翻译结果交给注入的 interpreter 回调（interpreter 决定副作用：转发/hook/diff/回写）。
 *
 * [u-runtime-svc] 第三个可选参数：后台任务变更检测的事件旁路（D2 触发面②）。customType
 * background-bash 消息（exit 边沿）与 bash 工具调用结束（spawn 路径）到达时，旁路回调
 * 被触发对 BackgroundTaskService 的 watched 集合跑一次变更检测（u-runtime-rpc 组合根
 * 接线到 service.checkForChanges）。旁路不进翻译输出（PiTranslatedEvent 零改动、纯旁路
 * 不改既有翻译），且消费端与 2s 轮询共享同一 last-seen mtime 状态——不是第二广播源，
 * 同一变化至多广播一次。
 */
export class EventAdapter {
  private unsub: (() => void) | null = null

  constructor(
    private sessionId: string,
    private interpret: (events: PiTranslatedEvent[]) => void,
    private onBackgroundTaskActivity?: (sessionId: string) => void,
    /** [定向复审缺陷 2] detach 转调（组合根传 interpreter.dispose）——销毁时清 interpreter 在途 timer + 置短路标志。 */
    private onDetach?: () => void,
  ) {}

  /** Start listening to events from a RpcClient. */
  attach(client: PiEventClient): void {
    this.unsub = client.onEvent((event) => {
      // [u-runtime-svc] 后台任务事件旁路：先于翻译独立判定（不改翻译输出），失败不干扰事件流
      this.notifyBackgroundTaskActivity(event)
      // [u7b D5 例外] subagent 在途上报旁路：marker 帧就地消费（镜像 + ack），识别即吞掉
      //（不进翻译 → 结构性零前端广播；translate 的守卫分支为第二道防线）。
      if (this.consumeInflightReport(event, client)) return
      // PiEventListener 的 event 是 unknown（pi 动态 JSON），断言为 PiEvent 联合翻译。
      const events = translate(event as unknown as PiEvent, this.sessionId)
      if (events.length === 0) return
      // interpret 同步执行（message/status WS 帧即时送出）；
      // 仅 tool-call-* 的 hook 改写异步（handler 内部 await），不阻塞本回调。
      try {
        this.interpret(events)
      } catch (err: unknown) {
        // 单批事件编排失败被隔离——订阅保持存活，后续事件（含 agent_end）照常投递。
        logInterpretFailure(this.sessionId, events.length, err)
      }
    })
  }

  /**
   * 后台任务旁路判定（D2 触发面②）：raw pi 事件形态直读（翻译层不动）——
   * ① customType background-bash 消息（exit 边沿，notify.ts → message_start custom）；
   * ② bash 工具调用结束（spawn 路径，tool_execution_end.toolName === 'bash'）。
   * spawn/exit 均先写 registry 后发事件（spawn-background.ts/poller.ts 时序），钩子
   * 触发的变更检测读到的已是终值，无双读竞态。未注入回调时零开销。
   */
  private notifyBackgroundTaskActivity(event: unknown): void {
    if (!this.onBackgroundTaskActivity) return
    try {
      const e = event as { type?: unknown; message?: { customType?: unknown }; toolName?: unknown }
      const isBashExitNotice = e.type === 'message_start' && e.message?.customType === BACKGROUND_BASH_CUSTOM_TYPE
      const isBashToolEnd = e.type === 'tool_execution_end' && e.toolName === BASH_TOOL_NAME
      if (isBashExitNotice || isBashToolEnd) this.onBackgroundTaskActivity(this.sessionId)
    } catch (err) {
      // 旁路永不干扰翻译/事件流（畸形事件形态/未知异常仅留诊断）
      console.debug('[EventAdapter] background-task activity bypass check failed:', err instanceof Error ? err.message : err)
    }
  }

  /**
   * subagent 在途上报旁路（u7b，设计 §3.3 D5「extension 聚合上报」）：识别
   * select + SUBAGENT_INFLIGHT_MARKER → 解析 → inflight-mirror 绝对计数覆盖（非增量）→
   * 经 client 回 INFLIGHT_REPORT_ACK。返回 true = 本帧已消费（调用方跳过翻译）。
   *
   * 坏帧 / 未知 schema / 缺 sessionId → 静默丢弃（仍返回 true，不抛不 ack）：不 ack 使
   * reporter 按既有折叠重试（问题可感知），单帧丢弃由绝对计数语义自愈。永不向调用方抛错。
   */
  private consumeInflightReport(event: unknown, client: PiEventClient): boolean {
    if (!isInflightReportFrame(event as PiEvent)) return false
    try {
      const report = parseSelectOptionsPayload(event as PiExtensionUiRequestEvent)
      if (!isSubagentInFlightReport(report)) {
        console.debug('[EventAdapter] subagent-inflight frame dropped: malformed payload')
        return true
      }
      if (typeof report.sessionId !== 'string' || report.sessionId === '') {
        // u7a 契约（extension-protocol subagent-inflight/types.ts）：sessionId 缺席 =
        // 无法归属 → 丢弃整帧（不镜像不 ack；pi 延迟写入窗口过后 reporter 重试即可归属）。
        // 不视为协议错误（与 plugin-bridge getSessionId 同款防御）。
        return true
      }
      // 归属用 adapter 的 sessionId（帧来自本 pi 进程，与 session-manager/bridge 同口径）；
      // report.sessionId 只作在场性判据，不比对——pi session id 与 runtime 会话键是两个 id 空间。
      inflightMirror.applyReport(this.sessionId, report)
      const requestId = String((event as PiExtensionUiRequestEvent).id ?? '')
      // fire-and-forget 的送达判定（D5 缺席语义②）：reporter 侧 resolve(undefined) 与超时
      // 不可区分，必须显式 ack 才能区分「已送达」与「无路由/通道故障」——reporter 据此
      // 停止重试（有界，2026-09-13 oe-audit 修订）。
      if (requestId !== '') client.sendExtensionUiResponse?.(requestId, INFLIGHT_REPORT_ACK, 'select')
    } catch (err) {
      // 旁路永不干扰翻译/事件流（畸形帧形态 / ack 通道异常仅留诊断）
      console.debug('[EventAdapter] subagent-inflight bypass failed:', err instanceof Error ? err.message : err)
    }
    return true
  }

  /** Stop listening. */
  detach(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
    // [定向复审缺陷 2] 转调宿主清理（interpreter.dispose）：detach 是全部销毁路径的收口
    // （forceQuit/exit/delete/restore 清场均经 adapter.detach），interpreter 的在途
    // settling 延迟 timer 与 disposed 短路在此一并收口。
    this.onDetach?.()
  }
}
