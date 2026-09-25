/**
 * message.* 事件 effect 注册表（消除 double-dispatch，架构审查候选 F2）。
 *
 * [归位] 迁自 renderer stores/chat-message-effects.ts（P3 chat 域绞杀 w3：AC3 达成——
 * domain/chat/effects 零跨域 import）。
 * [P4 s5 w2] tasks 路由（routeToolResultToTasks/routeToolStartToTasks）与
 * openTasksPanelOnFirstData 回调已随 tasks 域删除移除。
 *
 * 背景：原 chat-chunk-processor（21 case，更新 messages/retryStates/queueStates；[u5a] queueStates 维度已退役）
 * 与 useChat.ensureStreamSubscription（9 case，翻 isStreaming + applySnapshot）对同一
 * ServerMessage 流 switch 两次。新增 message.* type 必须两处同步改，易漏。
 *
 * 归一：本文件把「每个 message.* type 触发的全部副作用」集中到单一 handler：
 * (a) chunk 状态更新（原 applyChunk 逻辑）+ (b) 终态收口（finalizeSession，替代原 useChat
 * setStreaming 的 lifecycle flag 翻转）。useChat 收到 message.* 只调 store.applyMessageEvent（单一入口），
 * 不再自己 switch message.*。session.*（compacting/compacted/renamed/state_changed/
 * thinkingLevelSet）涉及跨 store（sessionStore.applySnapshot），
 * 保留在 useChat。
 *
 * 行为等价性：
 * - 状态更新顺序与原 applyChunk 逐 case 一致（handler 内先更新 chunk 状态，后收口，
 *   对应原 useChat 先 appendAssistantChunk 再 switch 翻 flag 的顺序）。
 * - 收口时机：complete/error/stream_error 调 finalizeSession 收口
 *   （status 由 streaming 派生 isGenerating，非手动 flag）。
 * - [设计裁决：坏 entry 静默丢弃（2026-09-17 错误处理审查 A5 登记；dev 观测后补，生产行为不变）]
 *   消息类 handler（构造点 = event-adapter tool-call-start / tool-call-end / handleMessageEnd）
 *   在 entry 缺失或形态不符时生产路径静默 return 是有意取舍：正常流经 event-adapter 构造的帧
 *   不会产生坏 entry（构造侧已守卫）；单帧异常静默丢弃换取异常帧不断流（主对话流不因
 *   协议漂移中断）。守卫触发即是 event-adapter 漂移信号——dev 下补一次/类型 warn（对齐
 *   RD-1#9 未注册 type 待遇，见 warnMalformedEntryDropped），排障入口 = 对齐
 *   event-adapter（runtime event-adapter.ts）对应构造点日志。坏帧行为由 effects.test.ts
 *   坏帧用例锁定（不抛错、零副作用）。各 handler 只留一行指针。
 *
 * 设计：dispatchMessageEvent(ctx, sessionId, msg) 查 messageEffects 表执行 handler；
 * 非 message.* 或未注册 type 直接 no-op。MessageEffectContext 含 store refs
 * 上下文 + finalizeSession/clearPendingSend 回调（由 store 注入，完成收口）。
 *
 * [W21 data-source-governance] entry 形态实时 feed：message.message_end /
 * message.tool_call_start / message.tool_call_end 的 handler 输入从「直译事件 payload」
 * 改为「重构 entry」（event-adapter 翻译时重构，字段对齐 pi entry schema）。状态类更新
 * 全走 reducer（ctx.applyEntryFrame 喂 store 内 per-session ChatViewState，与文件重放
 * 的 replayEntries 同一个 applyEntry——「live ≡ reload」构造性成立）；overlay 语义
 * （streaming 气泡 / running toolCall / delta 累积）保留 effect（transient 态 reducer
 * 无法表达，D5：partial content 不进 reducer，entry 提交时以 reducer 为权威）。
 */
import type {
  ContentBlock,
  Message,
  PiBranchSummaryEntry,
  PiCompactionEntry,
  PiCustomMessageEntry,
  PiEntry,
  PiMessageEntry,
  PiToolCallEntryForm,
  ServerMessage,
  ServerMessageType,
  ToolCall,
} from '@taiji/shared'
import { normalizePiToolResult } from '../apply-entry'
import { truncateEntryToolOutput } from '../apply-entry-utils'
import type { RetryState, FinalizeReason } from '../store-types'
import type { MessageEffectContext, MessageEffectHandler } from '../effect-types'
export type { MessageEffectContext, MessageEffectHandler } from '../effect-types'
import {
  readString,
  readNumber,
  readBool,
  readDetail,
  readCompactionSummary,
  readBranchSummary,
  readFileChanges,
  readChangeSetStatus,
} from '../readers'
import { findLastAssistantIndex, findToolCallOwner } from '../chunk-processor'
import { commitMessages, REASON_FALLBACK_ERROR_TEXT, terminalMessagePatch } from '../mutations'
import { truncateToolCall } from '../truncate-tool-output'
import { bashStartEffect, bashResultEffect, bashAbortedEffect } from '../bash-effects'
import { applyEntryFrameWithOverlay } from './entry-overlay'
import { isDevMode } from '../../../platform/dev-mode'
// [投递所有权内核 u3b] message_end(user) 送达回执（内核标记 id 匹配，C-data-08 修订方向）
// 归位 effects/user-delivery.ts；① 前身（defer 分区 FIFO 文本匹配）与 queue_update 计数腿
// （countDrained/drainN）已随内核整体退役（设计 §3.1 删除面），git 可追溯。
import { confirmKernelDeliveryOnMessageEnd } from './user-delivery'
// [TODO @i18n-migration] core/i18n 落地后恢复 i18n.global.t 调用（§0.3 列为后续迁移）。
// compactionSummary（W6）/ branchSummary（D13 renderer-deepening）均已 entry 化：两者的
// summary 兜底收敛到 reducer（compaction 中文 fallback「上下文已压缩」/ branchSummary
// 空串），live/reload 一致，本文件不再持有占位文案。

/**
 * [投递所有权内核 u3b] message_end(user) 投递确认/兜底显示（原三分支收敛为两分支）：
 *
 * - ① 内核送达回执（effects/user-delivery.ts confirmKernelDeliveryOnMessageEnd，最高
 *   优先级）：帧文本尾内核裸标记 id 命中 session.delivery 投影条目 → 投影转 delivered +
 *   morph 段按序入流 + inflight 占位回收 + 帧消费终止。C-data-08 修订方向：标记 id 精确
 *   匹配（身份非内容）取代计数 FIFO / 文本匹配。
 * - ② inflight > 0 → 纯计数 decrement → return（兜底：外来直发/帧缺失等无投影命中形态
 *   ——乐观气泡已显示，纯计数抵消防重复入流）。
 *
 * [HISTORICAL] ③ 腿 2 includes 兜底与 queue_update 计数腿（腿 1 countDrained/drainN）
 * 已随内核退役：queue_update 帧降级为内核内部回执（不再直驱 UI），队列区数据源 =
 * session.delivery 状态帧单一源（D7）。
 */
function confirmUserDeliveryOnMessageEnd(
  ctx: MessageEffectContext,
  sid: string,
  entry: PiMessageEntry,
): void {
  // ① 内核送达回执（标记 id 匹配）：命中即消费终止，不走 ②。
  if (confirmKernelDeliveryOnMessageEnd(ctx, sid, entry)) return
  // ② 计数兜底：乐观气泡已显示，纯计数抵消（本帧不重复入流）。
  if (ctx.getInflight(sid) > 0) {
    // [R2-b04-3] 兜底触发频率观测（dev 门）：① 未命中落 ② = 外来直发/帧缺失形态的接管
    // 频率，原先零痕迹（红线「兜底掩盖正常路径」的观测要求）。钳制幂等机制不变。
    logDeliveryCountingFallback(sid)
    ctx.decrementInflight(sid, 1)
    return
  }
}

/** [R2-b04-3] ② 计数兜底的 dev 计数/日志（生产零开销；计数跨 session 累计，供频率观察）。 */
let deliveryCountingFallbackCount = 0
function logDeliveryCountingFallback(sid: string): void {
  if (!isDevMode()) return
  deliveryCountingFallbackCount++
  console.warn(
    `[effects] message_end(user) ② counting fallback engaged (total=${deliveryCountingFallbackCount}, sid=${sid})` +
      ` — receipt missed ① marker match (foreign direct / marker-miss form), decrementing by count`,
  )
}

/**
 * message.* type → effect handler 注册表。
 *
 * 新增 message.* type 只在此表加一行，无需在两个 switch 同步改（消除 double-dispatch）。
 * 表内顺序仅作可读性，与执行顺序无关（每次 dispatch 单 case）。
 */
/**
 * 最后一条 assistant 是否仍 streaming（sealed guard helper，D-010）。
 * finalizeSession 后实体已终态 → 此函数返回 false → delta handler 早 return。
 */
function isLastAssistantStreaming(
  messages: Pick<MessageEffectContext, 'messages'>['messages'],
  sid: string,
): boolean {
  const list = messages.value.get(sid)?.value
  if (!list || list.length === 0) return false
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'assistant') return list[i].status === 'streaming'
  }
  return false
}

/**
 * [u6.2 D13 联动] sealed-guard + 定位 + commit 骨架（原 6 处 streaming 类 effect 内联
 * 重复：text_delta / thinking_start / thinking_end / thinking_delta / tool_call_start /
 * tool_call_update，行为逐字等价收敛）：
 *
 * 1. sealed guard（D-010）：最后一条 assistant 非 streaming（finalizeSession 已收口）→
 *    早 return，晚到的 delta/更新幂等丢弃。
 * 2. 定位：locate 在 prev 上找目标 assistant 下标（多数用 findLastAssistantIndex；
 *    tool_call_update 用 findToolCallOwner 按 toolCallId ID 锚定——见其调用点注释），
 *    无命中（idx < 0）→ return。
 * 3. 更新 + commit：update 返回新 message（copy-on-write）落盘；返回 undefined 表示
 *    本次不落盘（thinking_end 的空 thinking 分支——原实现该处直接 return 不 commit）。
 *
 * 副作用顺序说明：6 处调用点中 5 处（text_delta / thinking_start / thinking_delta /
 * tool_call_start / tool_call_update）的 payload 读取与派生构造（含 randomUUID 兜底 id、
 * Date.now 生成）整体前移到 guard 之前，与原内联顺序（guard → 定位 → 读 payload → 更新）
 * 相比是顺序前移而非一致——纯读取、无观察面调用，故与基线行为等价；留在 update 闭包内
 * 的读取仅 tool_call_update 的 readDetail（thinking_end 无 payload 读取）。约束：前移段
 * 不得加入有观察面的调用（console/log/事件 emit），否则破坏与基线的顺序等价。
 */
function updateStreamingAssistant(
  ctx: Pick<MessageEffectContext, 'messages'>,
  sid: string,
  locate: (prev: Message[]) => number,
  update: (msg: Message) => Message | undefined,
): void {
  if (!isLastAssistantStreaming(ctx.messages, sid)) return
  const prev = ctx.messages.value.get(sid)?.value ?? []
  const idx = locate(prev)
  if (idx < 0) return
  const updated = update(prev[idx])
  if (updated === undefined) return
  const next = [...prev]
  next[idx] = updated
  commitMessages(ctx.messages, sid, next)
}

/**
 * 按 pi contentIndex（产出顺序）有序插入 contentBlocks（§11 检查点 3 顺序语义统一）。
 *
 * 背景：streaming 事件到达顺序受 tool_execution_start 延迟扭曲（工具执行晚于模型输出），
 * 若纯 append，同 turn 内 text 在 tool 之后时 toolCall 块会排到 text 后面，与持久化路径
 * （按 pi content array 顺序 = contentIndex 顺序）错位。统一语义：contentBlocks 顺序 =
 * contentIndex 顺序（模型产出顺序），插入时找到第一个 contentIndex 更大的块插到其前。
 * 无 contentIndex（旧事件/兼容）时退化为 append 尾部。
 */
function insertContentBlockByIndex(blocks: ContentBlock[], block: ContentBlock): ContentBlock[] {
  const idx = block.contentIndex
  if (idx === undefined) return [...blocks, block]
  const insertAt = blocks.findIndex((b) => (b.contentIndex ?? Infinity) > idx)
  if (insertAt === -1) return [...blocks, block]
  const next = [...blocks]
  next.splice(insertAt, 0, block)
  return next
}

/**
 * [b05 候选1 收敛] 终态错误帧「帧语义 → (FinalizeReason, errorText)」唯一映射（纯函数）。
 *
 * 原先 handler 内与 dispatchMessageEvent 安全网各自持有一套映射（complete 的
 * stopReason→reason、error/stream_error 的错误字段来源），收敛为本函数；两处消费侧差异
 * 保留为显式语义，不在映射内吞掉：
 * - handler 对 error/stream_error 的 errorText 补字面量兜底（错误不得静默）；安全网透传
 *   undefined（兜底文案由 finalizeSession 出口的 REASON_FALLBACK_ERROR_TEXT 统一承担）。
 * - 安全网对 complete 把 'normal' 保守映射为 'error'（handler 中途抛错的正常完成帧
 *   不按干净完成收口）。
 */
function deriveTerminalFrameParams(
  type: string,
  payload: Record<string, unknown>,
): { reason: FinalizeReason; errorText: string | undefined } {
  if (type === 'message.complete') {
    const stopReason = readString(payload, 'stopReason')
    return {
      reason: stopReason === 'aborted' ? 'aborted' : stopReason === 'error' ? 'error' : 'normal',
      errorText: readString(payload, 'errorMessage'),
    }
  }
  if (type === 'message.stream_error') {
    return { reason: 'stream_error', errorText: readString(payload, 'content') }
  }
  return { reason: 'error', errorText: readString(payload, 'message') }
}

/**
 * [M2 形态统一 / b05 候选1 收敛] 兜底纯 error 气泡（错误文本只住 error 字段，content 空；
 * 开始/结束时刻取同一读数，秒级展示口径下一致）。原 3 处同款对象字面量（complete 秒败
 * 分支 / error / stream_error 的无前置 streaming entity 分支）收敛于此。store.ts
 * markSessionError 第 4 处同款字面量不在本收敛批（store.ts 非本批领地，登记）。
 */
function appendFallbackErrorBubble(
  messages: MessageEffectContext['messages'],
  sid: string,
  prev: Message[],
  errorText: string,
): void {
  const errNow = Date.now()
  commitMessages(messages, sid, [
    ...prev,
    { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: '', error: errorText, status: 'error', timestamp: errNow, endedAt: errNow },
  ])
}

/**
 * [b05 候选1 收敛] error / stream_error 终态 handler 骨架（原两 handler 逐行近似复制，
 * 仅差 reason 与错误字段来源，参数化收敛）：prev 读取 → hasStreaming 探测 →
 * finalizeSession → 无前置 streaming entity 时追加兜底纯 error 气泡。
 * 副作用顺序与原内联实现逐字一致。
 */
function terminalErrorEffect(
  type: 'message.error' | 'message.stream_error',
  fallbackErrorText: string,
): MessageEffectHandler {
  return (ctx, sid, payload) => {
    const { messages, finalizeSession } = ctx
    const { reason, errorText } = deriveTerminalFrameParams(type, payload)
    // 检查是否有前置 streaming assistant（finalizeSession 会收口它）
    const prev = messages.value.get(sid)?.value ?? []
    const idx = findLastAssistantIndex(prev)
    const hasStreaming = idx >= 0 && prev[idx].status === 'streaming'
    // 统一收口：finalizeSession 做 streaming entity error 化 + 清 pendingSend + 清 timer
    finalizeSession(sid, reason, errorText ?? fallbackErrorText)
    // 无前置 streaming entity 时 finalizeSession 不追加消息——需手动追加（错误不得静默）
    if (!hasStreaming) {
      appendFallbackErrorBubble(messages, sid, prev, errorText ?? fallbackErrorText)
    }
  }
}

/**
 * tool_call_end overlay 终态派生段（纯函数提取，复杂度门禁 Gate-1.5）：normalize +
 * 64KB 截断。三态归一在消费侧做：传 entry.message（body）——与 reducer
 * computeToolCallFill 同语义（content block 数组 → join text），entry.content 已由
 * adapter 归一为数组形态（W21）。content 缺失（mock/异常帧）三值全 undefined——
 * 上层条件写入保留 running 期间的旧值（迁移前 `?? c.output` 同语义）。
 * [D6-⑧] live overlay 与 reducer（computeToolCallFill）过同一 64KB 截断函数——
 * 非六类工具（write/edit/MCP）大结果 live 与 reload 形态一致（D3 代价 C 根治）。
 */
function deriveToolCallEndOverlay(message: PiMessageEntry['message']): {
  hasContent: boolean
  output: string | undefined
  outputRaw: string | undefined
  outputTruncated: boolean
  images: Array<{ data: string; mimeType: string }> | undefined
} {
  const hasContent = message.content !== undefined
  const { output: rawOutput, outputRaw: rawOutputRaw, images } = hasContent
    ? normalizePiToolResult(message)
    : { output: undefined, outputRaw: undefined, images: undefined }
  const outputT = rawOutput !== undefined ? truncateEntryToolOutput(rawOutput) : undefined
  const outputRawT = rawOutputRaw !== undefined ? truncateEntryToolOutput(rawOutputRaw) : undefined
  return {
    hasContent,
    output: outputT?.text,
    outputRaw: outputRawT?.text,
    outputTruncated: (outputT?.truncated ?? false) || (outputRawT?.truncated ?? false),
    images,
  }
}

const messageEffects: Partial<Record<ServerMessageType, MessageEffectHandler>> = {
  // ── 主流式生命周期（chunk 创建/收口 + isGenerating 派生）──
  'message.message_start': (ctx, sid, payload) => {
    const { messages, clearPendingSend } = ctx
    // [合并收口] premature-timeout 打标作废腿与 armStreamingTimer 随上游「streaming idle
    // timeout 移除」一并退役（main 侧已整体摘除，git 可追溯）。
    // [HISTORICAL] QueueBubble 快照条件清/僵尸清理（G-023）已随 queue_update 计数腿退役：
    // 队列区数据源 = session.delivery 状态帧（内核 state topic 快照，D7），queueStates
    // 不再是任何机制的工作前提。store 侧 queueStates 分区与其清理方法已随 u5a 退役（删除）
    // （store.ts 不在 u3b 领地）。
    const prev = messages.value.get(sid)?.value ?? []
    const messageId = readString(payload, 'messageId') ?? `a-${crypto.randomUUID()}`
    commitMessages(messages, sid, [
      ...prev,
      {
        id: messageId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        timestamp: Date.now(),
        contentBlocks: [],
      },
    ])
    // 空窗结束：clearPendingSend（接管 dispatching 语义）
    clearPendingSend(sid)
  },

  'message.complete': (ctx, sid, payload) => {
    const { messages, finalizeSession } = ctx
    const prev = messages.value.get(sid)?.value ?? []
    // [b05 候选1 收敛] stopReason→reason 与 errorMessage 提取走 deriveTerminalFrameParams
    // 单映射（与 dispatch 安全网共用；原先 handler 内独立推导一套）。
    const { reason, errorText: errorMessage } = deriveTerminalFrameParams('message.complete', payload)
    const isErrorStop = reason === 'error'
    // [HISTORICAL] pi turn 失败（stopReason='error'）时 runtime event-adapter 从 agent_end 提取
    // errorMessage 放进本 payload。曾经过往 handler 只读 stopReason/content/usage 把它丢弃——
    // 秒败 turn（如模型 400 拒绝首请求）content 为空，气泡仅剩一个空 error 态，用户完全不可见。
    // 消费双通道：
    // 有 streaming 气泡 → errorMessage 写最后一条 assistant 的 Message.error 字段（追加形态，
    // content 崩溃前正文不动）；无 streaming 气泡 → 追加纯 error 气泡（errorMessage 即全文）。
    // [HISTORICAL] 收口**所有** status==='streaming' 的 assistant 气泡，不只用
    // findLastAssistantIndex 收最后一条。一个 turn 可能产生多个 assistant 气泡
    // （工具调用气泡 + 文字总结气泡）：只转最后一条会让前面的 toolCall 气泡永远 streaming，
    // 内部 status 虽视觉无感（turn 整体收口），但状态机不一致且影响后续定位逻辑。
    // usage（W05-A turn 级聚合）只回填最后一条 assistant——回填到非末 assistant 语义错位。
    // [W4] toolCall 终态收口收敛到 finalizeSession 统一处（原局部 finalizeToolCalls 已删除，
    // 避免两套映射漂移）。此处只改 message status + 回填 usage，toolCalls 保持原样传入；
    // 紧接着的 finalizeSession(sid, reason) 会把 running toolCall 按 reason 统一收口。
    //
    // 权威 content 覆盖：runtime 从 pi agent_end 提取的完整文本 content（见
    // event-adapter handleAgentEnd）。streaming 期间通过 text_delta 逐块累积，但末尾
    // delta 的 async 渲染竞态可能导致 markdown 未正确渲染（如 ** 未闭合）。用权威源
    // 覆盖最后一条 assistant 的 content，强制 MarkdownRenderer watch 重新触发渲染。
    // 仅非空时覆盖（abort 路径 payload 无 content，保留客户端累积值）。
    const finalContent = readString(payload, 'content')
    const lastAssistantIdx = findLastAssistantIndex(prev)
    let changed = false
    const next = prev.map((m, i) => {
      if (m.role !== 'assistant' || m.status !== 'streaming') return m
      changed = true
      // 终态字段 patch 单源（S4-A6）：
      // usage/error/content/endedAt 只作用于末位 assistant，见 terminalMessagePatch 注释
      return terminalMessagePatch(m, i, { lastAssistantIdx, isErrorStop, errorMessage, finalContent, payload, endedAt: Date.now() })
    })
    if (changed) commitMessages(messages, sid, next)
    // 秒败 turn（message_start 丢失/未广播）无 streaming 气泡可收口：错误信息必须以纯 error
    // 气泡落进聊天流，否则 complete 事件被消费后错误只剩 stopReason 标志，用户不可见。
    // errorMessage 缺失（pi extras.errorMessage 可 undefined）走 error reason 兜底文案——
    // 条件只看 isErrorStop，文案用 errorMessage || 兜底，错误不得静默。
    if (isErrorStop && !changed) {
      // [M2 形态统一] 错误文本只住 error 字段，content 空（无崩溃前正文）
      appendFallbackErrorBubble(messages, sid, prev, errorMessage || REASON_FALLBACK_ERROR_TEXT.error)
    }
    // 统一收口（finalizeSession 幂等：entity 已改则 no-op，只清 pendingSend + timer）
    // 此处 message status 已改终态 → finalizeSession 内走「只补 toolCall 收口」分支。
    // [steer-bubble u2 / D4 → u3b/D10 修订] abort 只清 inflight（在 finalizeSession 之外显式
    // 做——finalizeSession 是通用收口，normal/error 不清）。D10：abort 不取消未送达消息——
    // 内核 queued/in-flight 条目按原 lane 规则继续投递（对账器/回执驱动），本清零只是确认
    // 基线复位：已显示未确认条目的 message_end 仍会到达，送达回执（① 标记匹配）按投影
    // 命中消费，② 纯计数兜底见 0 钳制 no-op，不会吞掉后续投递的确认。
    if (reason === 'aborted') {
      ctx.clearInflight(sid)
    }
    finalizeSession(sid, reason)
  },

  // [b05 候选1 收敛] error / stream_error 原 19 行/个的近似复制 handler 收敛为
  // terminalErrorEffect 参数化骨架；错误字段来源与字面量兜底差异由参数表达。
  'message.error': terminalErrorEffect('message.error', 'Unknown error'),

  'message.stream_error': terminalErrorEffect('message.stream_error', 'Stream error'),

  // B1（PR#86 review）：非终结性提示通道，与 stream_error 物理隔离——仅追加 system
  // 提示消息，不调 finalizeSession，session 保持 streaming 态。两个生产者：ping 探测
  // 的 pi 静默卡死 WARN（120s 无活动，pi 可能只是慢，130s 后恢复产出）与 EventAdapter
  // 的单帧翻译失败提示（MF-1-13：pi 流继续、turn 可能照常成功，失败帧不可终结 turn）。
  // [W2 fix-chat-flow-order D4] liveOnly 标记（全仓唯一写入点）：stream_warn 是 taiji runtime
  // 自产提示，pi 无对应 entry、重开即消失——无 entry 可构故不 entry 化（直插即本类
  // 消息的正确入流路径），分组层据此归 turn 内 notice（不切断 turn，W3 消费），不参与
  // 「live ≡ reload」等价性断言。
  'message.stream_warn': (ctx, sid, payload) => {
    const { messages } = ctx
    const warnContent = readString(payload, 'content') ?? '长时间无响应'
    const prev = messages.value.get(sid)?.value ?? []
    commitMessages(messages, sid, [
      ...prev,
      { id: `s-${crypto.randomUUID()}`, role: 'system', content: warnContent, status: 'complete', timestamp: Date.now(), liveOnly: true },
    ])
  },

  // ── 文本流（纯 chunk 更新，不翻 lifecycle flag）──
  'message.text_delta': (ctx, sid, payload) => {
    // [D-010 sealed] finalizeSession 后晚到 delta 幂等丢弃（guard 在骨架 helper 内）
    const delta = readString(payload, 'delta') ?? ''
    const contentIndex = readNumber(payload, 'contentIndex')
    updateStreamingAssistant(ctx, sid, findLastAssistantIndex, (m) => {
      // 首个 text_delta push text 块到 contentBlocks（幂等：已含 text 块则不重复 push）。
      // 插入位置按 contentIndex 有序插入（§11 检查点 3），无 index 时退化为 append。
      const prevBlocks = m.contentBlocks ?? []
      const contentBlocks = prevBlocks.some((b) => b.type === 'text')
        ? prevBlocks
        : insertContentBlockByIndex(prevBlocks, { type: 'text', refId: 'text', ...(contentIndex !== undefined ? { contentIndex } : {}) } satisfies ContentBlock)
      return { ...m, content: m.content + delta, contentBlocks }
    })
  },

  // ── thinking 流（折进 trace，W05 endTime）──
  'message.thinking_start': (ctx, sid, payload) => {
    // [D-010 sealed]
    const blockId = readString(payload, 'thinkingId') ?? `th-${crypto.randomUUID()}`
    const contentIndex = readNumber(payload, 'contentIndex')
    updateStreamingAssistant(ctx, sid, findLastAssistantIndex, (m) => {
      const thinking = [...(m.thinking ?? []), { id: blockId, content: '', collapsed: true, startTime: Date.now() }]
      // push 到 contentBlocks（refId 复用 blockId，防两处分别 randomUUID 断链）。
      // 按 contentIndex 有序插入（§11 检查点 3），无 index 时退化为 append。
      const contentBlocks = insertContentBlockByIndex(m.contentBlocks ?? [], { type: 'thinking', refId: blockId, ...(contentIndex !== undefined ? { contentIndex } : {}) } satisfies ContentBlock)
      return { ...m, thinking, contentBlocks }
    })
  },

  'message.thinking_end': (ctx, sid) => {
    // [D-010 sealed]
    // W05-A：给最后 ThinkingBlock 设 endTime（字段已存在 message.ts:30）。
    // payload 仅 {sessionId}（event-adapter thinking_end 不带额外字段）。
    updateStreamingAssistant(ctx, sid, findLastAssistantIndex, (m) => {
      const thinking = m.thinking
      if (!thinking || thinking.length === 0) return undefined // 空 thinking：不落盘（原 return 语义）
      const nextThinking = [...thinking]
      nextThinking[nextThinking.length - 1] = { ...nextThinking[nextThinking.length - 1], endTime: Date.now() }
      return { ...m, thinking: nextThinking }
    })
  },

  'message.thinking_delta': (ctx, sid, payload) => {
    // [D-010 sealed]
    const delta = readString(payload, 'delta') ?? ''
    updateStreamingAssistant(ctx, sid, findLastAssistantIndex, (m) => {
      const thinking = [...(m.thinking ?? [])]
      const last = thinking[thinking.length - 1]
      if (last) thinking[thinking.length - 1] = { ...last, content: last.content + delta }
      // last 不存在时仍写回 thinking（可能 undefined → []）——原实现同语义（无条件 commit）
      return { ...m, thinking }
    })
  },

  // ── tool_call 流（ID 锚定，W05 detail；[W21] 输入换 entry 形态）──
  'message.tool_call_start': (ctx, sid, payload) => {
    // [D-010 sealed]
    // [W21] 输入从直译平铺 payload 改为 toolCall entry 形态（event-adapter 翻译时重构，
    // interpreter 补 contentIndex/messageId 锚点）。
    // [坏 entry 静默丢弃 → 见文件头「行为等价性」设计裁决；构造点 = event-adapter tool-call-start]
    // toolCallId 缺失时 fallback 随机 id（迁移前同款宽容防御：异常事件不断流）。
    const entry = payload['entry'] as PiToolCallEntryForm | undefined
    if (entry === undefined) return warnMalformedEntryDropped('message.tool_call_start', sid)
    const callId = typeof entry.toolCallId === 'string' ? entry.toolCallId : `tc-${crypto.randomUUID()}`
    const toolName = typeof entry.toolName === 'string' ? entry.toolName : 'tool'
    const call: ToolCall = {
      id: callId,
      toolName,
      input: entry.arguments ?? {},
      status: 'running',
      startTime: Date.now(),
    }
    // goal_control create 的 input.objective 只在此刻可得（tool result details 不回传），提前提取。
    // [P4 s5 w2] tasks 域已删除（D5 存根过渡到期），objective 提取随 tasks store 一并移除。
    updateStreamingAssistant(ctx, sid, findLastAssistantIndex, (m) => {
      // push 到 contentBlocks（callId 复用，与 toolCalls[].id 一致）。
      // 按 contentIndex 有序插入（§11 检查点 3），无 index 时退化为 append。
      const toolCalls = [...(m.toolCalls ?? []), call]
      const contentBlocks = insertContentBlockByIndex(m.contentBlocks ?? [], { type: 'toolCall', refId: callId, ...(entry.contentIndex !== undefined ? { contentIndex: entry.contentIndex } : {}) } satisfies ContentBlock)
      return { ...m, toolCalls, contentBlocks }
    })
  },

  'message.tool_call_end': (ctx, sid, payload) => {
    const { messages } = ctx
    const prev = messages.value.get(sid)?.value ?? []
    // [W21] 输入从直译平铺 payload 改为 toolResult message entry 形态（与 pi 持久化
    // toolResult entry 同构）。overlay 收口（streaming 气泡上的 running toolCall → 终态）
    // 语义保留；权威回填经 ctx.applyEntryFrame 喂 reducer（先于 overlay 早 return——
    // ref 无 owner 时 reducer 喂入照常，ref 收敛归 W22）。
    // [坏 entry 静默丢弃 → 见文件头「行为等价性」设计裁决；构造点 = event-adapter tool-call-end]
    const entry = payload['entry'] as PiMessageEntry | undefined
    if (entry === undefined || entry.type !== 'message') return warnMalformedEntryDropped('message.tool_call_end', sid)
    // 状态类全走 reducer（w21）：toolResult entry 喂 per-session reducer state
    ctx.applyEntryFrame(sid, entry)
    const callId = typeof entry.message.toolCallId === 'string' ? entry.message.toolCallId : undefined
    // ID 锚定：按 toolCallId 精确定位所属 assistant message（见 findToolCallOwner 注释），
    // 不靠 findLastAssistantIndex（位置定位会被乱序/噪声 message 干扰）。
    // callId 缺失或未命中时降级为最后一条 assistant（防御：兼容异常事件）。
    const idx = callId ? findToolCallOwner(prev, callId) : findLastAssistantIndex(prev)
    if (idx < 0) return
    // details：pi tool_execution_end result.details（结构化扩展数据）。
    // subagent sync 模式的 progress 快照（currentTool/turn/tokens）在这里，前端 Block.vue 据此滚动更新。
    // 三态归一 / content 缺省保留旧值 / 64KB 截断的派生语义见 deriveToolCallEndOverlay
    //（纯派生段提取，条件写入语义不变——下方 spread 按字段缺省不触碰既有值）。
    const { hasContent, output, outputRaw, outputTruncated, images } = deriveToolCallEndOverlay(entry.message)
    const details = entry.message.details
    const isError = entry.message.isError === true
    const next = [...prev]
    const toolCalls = (next[idx].toolCalls ?? []).map((c) =>
      c.id === callId
        ? truncateToolCall({
          ...c,
          ...(output !== undefined && { output }),
          ...(outputTruncated && { outputTruncated: true }),
          // [D6-⑨] live 期 toolResult 图片回填（与重放路径 fillHostToolCall 同语义）：
          // 缺此回填则 live 期 toolCall.images 恒 undefined，设计「live 期新到图片在
          // 剩余额度内即写」无法成立（渲染层 ToolResultImages 无数据源）。
          ...(images !== undefined && images.length > 0 && { images }),
          // end 有 content 时无条件写入 outputRaw（含 undefined 显式清空）——running 期
          // tool_call_update 写入的 outputRaw 在 end 文本无 ANSI 时会残留，用户终态看到
          // 带色陈旧尾窗而非 end 文本（错误信息），且 live ≠ reload。
          ...(hasContent && { outputRaw }),
          // 与重放路径（reducer：isError → status:'error'）保持一致：实时失败的 tool call
          // 必须带 status:'error'，否则前端 Block.vue 的 isFailed 判定恒为 false（恒显示成功）。
          status: isError ? 'error' : 'completed',
          ...(isError && { error: output ?? c.error }),
          endTime: Date.now(),
          ...(details !== undefined && { details: details as Record<string, unknown> }),
        })
        : c,
    )
    next[idx] = { ...next[idx], toolCalls }
    commitMessages(messages, sid, next)
  },

  // ── [W21] message_end —— 重构 entry 喂 reducer（实时 feed 权威载体，reducer 薄封装）──
  'message.message_end': (ctx, sid, payload) => {
    const entry = payload['entry']
    // entry 形态守卫：message entry（type:'message'）才喂。
    // [坏 entry 静默丢弃 → 见文件头「行为等价性」设计裁决；构造点 = event-adapter handleMessageEnd]
    if (typeof entry !== 'object' || entry === null || (entry as { type?: unknown }).type !== 'message') {
      return warnMalformedEntryDropped('message.message_end', sid)
    }
    // custom role 去双计：pi 对同一条 custom message 双发 message_start + message_end（同一
    // message 对象——agent-loop.ts:112 prompt 路径 / agent-session sendCustomMessage no-trigger
    // 路径双发）。customStart effect 已在 message_start 时点以 custom_message entry 形态喂入
    // reducer + ref（display 覆写语义对齐重开 custom_message case），此处再喂会双计。
    if ((entry as { message?: { role?: unknown } }).message?.role === 'custom') return
    // toolResult role 不在此跳过（区别于 custom，R2-S1）：pi 对同一条 toolResult 双发
    // tool_execution_end + message_end{role:'toolResult'} 两事件，tool_call_end handler 与
    // 本 handler 各喂 reducer 一次——但任一帧单独到达（另一帧丢失）时本入口可能是该
    // toolResult 的唯一载体，无条件跳过会丢消息（破坏单入口契约）。去重由 reducer 的
    // deliveredToolResultIds 幂等承担（apply-entry applyToolResultMessage：同 toolCallId
    // 首次投递后二次 no-op），对齐 event-adapter handleMessageEnd「toolResult 与
    // tool_execution_end 的回填，去重/合并归 core store 的 reducer 接入层编排」的职责划分。
    ctx.applyEntryFrame(sid, entry as PiEntry)
    // [steer-bubble u1 / D1+D2] 腿 2：user role 时做投递确认/兜底消费（reducer 喂入
    // 无条件保留在前——腿 2 只是 overlay 显示侧的补充裁决，异常路径不阻断权威喂入）。
    if ((entry as PiMessageEntry).message?.role === 'user') {
      confirmUserDeliveryOnMessageEnd(ctx, sid, entry as PiMessageEntry)
    }
  },

  'message.tool_call_update': (ctx, sid, payload) => {
    // [D-010 sealed]
    // W05-A：Extension 工具调用进度更新。event-adapter tool_execution_update
    // 生产端只发 detail（string | object），消费对齐生产端（不臆造 progress）。
    const callId = readString(payload, 'toolCallId')
    if (!callId) return
    // ID 锚定（见 tool_call_end 注释），避免乱序命中错误 message。
    updateStreamingAssistant(ctx, sid, (prev) => findToolCallOwner(prev, callId), (m) => {
      const detail = readDetail(payload, 'detail')
      // [bash-running-stream-output U2] running 态流式输出复用 ToolCall.output/outputRaw：
      // 条件写入（字段缺省不触碰既有值）；readString 对非字符串返回 undefined 天然降级。
      const output = readString(payload, 'output')
      const outputRaw = readString(payload, 'outputRaw')
      const toolCalls = (m.toolCalls ?? []).map((c) =>
        c.id === callId
          ? { ...c, detail, ...(output !== undefined && { output }), ...(outputRaw !== undefined && { outputRaw }) }
          : c,
      )
      return { ...m, toolCalls }
    })
  },

  // ── Bash 执行（W1 fix-chat-flow-order：bashStart 写 ephemeral executingBash 不建消息项；
  //    bashResult 构造 bashExecution entry 走 applyEntryFrame——reducer 唯一入流通道，
  //    dispatcher 双分支延迟使帧时序构造性对齐 pi 落盘；bashAborted 为 abortBash 兜底终态
  //    独立帧（msg-pipeline-debloat D4-3），只清执行态不产 entry。实现提取于 bash-effects.ts
  //    避免本文件超行）──
  'message.bashStart': bashStartEffect,
  'message.bashResult': bashResultEffect,
  'message.bashAborted': bashAbortedEffect,

  // ── pi CustomMessage 注入（扩展向对话流注入结构化通知）──
  'message.customStart': (ctx, sid, payload) => {
    // [custom 双管线收敛（data-source-governance 审计问题 4）] 实时侧不再独立构造 system
    // 消息 + display 覆写：payload 重构为 custom_message entry（与 pi 持久化形态同构），
    // 经 ctx.applyEntryFrame 喂与文件重放（get_entries → replayEntries）同一个 applyEntry
    // ——display 覆写（完成通知类 COMPLETE_NOTIFY_CUSTOM_TYPES → false）、details/content
    // 窄化全部单点收敛在 reducer 的 custom_message case，实时与重开逐字段一致
    // （等价性断言见 __tests__/custom-start-equivalence.test.ts）。
    //
    // entry 构造点注入两个异源字段（与 message_end 实时重构同款语义，差异归一见测试）：
    // - id：cm-uuid 客户端生成（保证 ref 消息 id 唯一；reducer 从 entry.id 派生，ref 与
    //   reducer state 同 id。重开侧为 pi 持久化的 uuidv7 entry id——id 值异源属 W21 已裁决
    //   的 live/reload 差异类，等价性断言按字段归一）。
    // - timestamp：客户端时钟（customStart payload 不携带 timestamp——event-adapter 翻译
    //   不透传；重开侧为 pi 持久化时刻，差值为投递延迟）。
    // display 三态原样进 entry（true/false 显式透传，undefined 安全保留显示，ADR-0048
    // 决策点 3），覆写归 reducer——本文件不再是覆写点。
    const entry: PiCustomMessageEntry = {
      type: 'custom_message',
      id: `cm-${crypto.randomUUID()}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: readString(payload, 'customType') ?? '',
      content: readString(payload, 'content') ?? '',
      details: payload['details'],
      display: payload['display'] === true || payload['display'] === false ? payload['display'] : undefined,
    }
    // 权威喂入 + overlay 投影 + commit（骨架 helper）：渲染 ref 消费同一份派生
    //（W21 裁决：ref 不由 reducer state 直接投影，收敛归 W22）
    applyEntryFrameWithOverlay(ctx, sid, entry)
  },

  // ── 运行态 / 元信息（system 提示行，W05-A/W07-C）──
  // message.status（pi status 事件经 event-adapter 直推：steer/aborted/sent/queued 等运行态）
  // 未注册 handler——dispatchMessageEvent 对未注册 type 直接 no-op（保留事件接收，不消费）。
  // 运行态语义未用：streaming/complete/error 是消息生命周期（finalizeSession 收口），
  // 与 message.status 运行过程态正交（§3.3.6 死代码清理，原空 handler 删除）。

  'message.compactionSummary': (ctx, sid, payload) => {
    // [W6 fix-chat-flow-order] compaction 双路径收尾（最后一个未 entry 化的 live 消息类型）。
    // 判定依据（0.84.1 dist 实测）：帧数据源 = runtime event-interpreter 从 pi compaction_end
    // 事件 result 提取 { summary, tokensBefore, timestamp }（event-interpreter handleCompactionEnd），
    // 与 pi 落盘 compaction entry 同源同值——agent-session 手动（:1441 appendCompaction）与 auto
    //（:1670）两路都在 emit compaction_end 前以同一批局部变量先落盘（session-manager
    // appendCompaction，summary/tokensBefore 同值）。帧字段足以构造 PiCompactionEntry →
    // 改直插为构造 entry → applyEntryFrame（user/bash/custom 同款范式），reducer 的 compaction
    // case（apply-entry）自此 live/reload 共用——「live ≡ reload」全类型构造性成立
    // （等价性断言见 apply-entry-equivalence / effects 测试）。
    //
    // 已知窄差异（D2 closure 已消灭，登记 data-source-registry #7 例外④销案）：interpreter 曾
    // 只在 result.summary 真值时发帧（`if (r.summary)` 门），summary 缺失的 compaction live 无
    // 消息、重开有 fallback 行——现恒发帧（summary 缺省透传），两侧同走 reducer fallback
    // 「上下文已压缩」（等价性断言 E4b/E4c，含空串形态）。
    //
    // entry 注入两个异源字段（customStart 同款，差异归一见等价性测试）：id 客户端生成
    // `cmp-<uuid>`（重开侧为 pi uuidv7 entry id——id 值异源属 W21 已裁决差异类）；timestamp
    // 客户端时钟（帧 timestamp ?? Date.now() → ISO；重开侧为 pi 落盘时刻，差值为投递延迟）。
    const summary = readCompactionSummary(payload)
    const entry: PiCompactionEntry = {
      type: 'compaction',
      id: `cmp-${crypto.randomUUID()}`,
      parentId: null,
      timestamp: new Date(summary.timestamp ?? Date.now()).toISOString(),
      ...(summary.summary !== undefined && { summary: summary.summary }),
      ...(summary.tokensBefore !== undefined && { tokensBefore: summary.tokensBefore }),
    }
    // 权威喂入 + overlay 投影 + commit（骨架 helper）：compaction 投影不依赖前置 state
    //（reducer compaction case 无条件 append），空 state 派生即本条消息。
    applyEntryFrameWithOverlay(ctx, sid, entry)
  },

  'message.branchSummary': (ctx, sid, payload) => {
    // [D13 renderer-deepening] branchSummary live entry 化（该设计第二处有意行为变化）：
    // 原直插 Message（fallback 文案 'Branched'）改为构造 branch_summary entry 走
    // applyEntryFrame + overlay 投影（compactionSummary W6 同款范式）——live 与 reload
    // 共用 reducer 的 branch_summary case，fallback 收敛为 reducer 语义 `rawSummary ?? ''`
    // （live 'Branched' 字面 fallback 放弃；此前 live 显示 'Branched'、重开投影为空串的
    // 行为不一致消灭）。等价性断言见 __tests__/branch-summary-equivalence.test.ts
    //（live ≡ reload 逐字段一致）。
    //
    // entry 注入两个异源字段（customStart/compaction 同款，差异归一见等价性测试）：
    // id 客户端生成 `br-<uuid>`（重开侧为 pi uuidv7 entry id——id 值异源属 W21 已裁决
    // 差异类）；timestamp 帧值 ?? 客户端时钟（重开侧为 pi 落盘时刻，差值为投递延迟）。
    const summary = readBranchSummary(payload)
    const entry: PiBranchSummaryEntry = {
      type: 'branch_summary',
      id: `br-${crypto.randomUUID()}`,
      parentId: null,
      timestamp: new Date(summary.timestamp ?? Date.now()).toISOString(),
      ...(summary.summary !== undefined && { summary: summary.summary }),
      ...(summary.fromId !== undefined && { fromId: summary.fromId }),
    }
    // 权威喂入 + overlay 投影 + commit（骨架 helper）：branch_summary 投影不依赖前置
    // state（reducer branch_summary case 无条件 append），空 state 派生即本条消息。
    applyEntryFrameWithOverlay(ctx, sid, entry)
  },

  // ── 自动重试 / 队列（W06-B，store 级状态机）──
  'message.auto_retry_start': (ctx, sid, payload) => {
    const { retryStates } = ctx
    // W06-B：自动重试开始。写 retryStates[sessionId]（UI 据此显重试指示位）。
    const state: RetryState = {}
    const attempt = readNumber(payload, 'attempt')
    if (attempt !== undefined) state.attempt = attempt
    const maxAttempts = readNumber(payload, 'maxAttempts')
    if (maxAttempts !== undefined) state.maxAttempts = maxAttempts
    const delayMs = readNumber(payload, 'delayMs')
    if (delayMs !== undefined) state.delayMs = delayMs
    const errorMessage = readString(payload, 'errorMessage')
    if (errorMessage) state.errorMessage = errorMessage
    retryStates.value = new Map(retryStates.value).set(sid, state)
  },

  'message.auto_retry_end': (ctx, sid) => {
    const { retryStates } = ctx
    // W06-B：自动重试结束。清空 retryStates[sessionId]（不可变 delete）。
    if (retryStates.value.has(sid)) {
      const nextMap = new Map(retryStates.value)
      nextMap.delete(sid)
      retryStates.value = nextMap
    }
  },

  // ── [投递所有权内核 u3b] message.queue_update handler 已退役 ──
  // queue_update 帧降级为内核内部回执（runtime 侧消费），不再直驱 renderer UI（D7）：
  // 队列区数据源 = session.delivery 状态帧（内核 state topic 全量快照，useChat 消费）。
  // 前身计数腿（countDrained 差集 → drainN 计数 FIFO → appendUser + inflight +m）删除，
  // git 可追溯。未注册 type 经 dispatchMessageEvent 直接 no-op，无需占位 handler。

  // ── FileChanges 通道（W10，ADR-0024 D5 baseline diff）──
  'message.file_changes': (ctx, sid, payload) => {
    // W10：FileChanges 通道（ADR-0024 D5 重构：baseline diff）。isFullSet 恒 true，全集替换。
    const messageId = readString(payload, 'messageId')
    if (!messageId) return
    const fileChanges = readFileChanges(payload)
    const status = readChangeSetStatus(payload)
    const isFullSet = readBool(payload, 'isFullSet')
    ctx.applyFileChanges(sid, messageId, fileChanges, status, isFullSet)
  },

  'message.changeSetInvalidated': (ctx, sid) => {
    // D5 重构：commit 成功后工作区 diff 重置，旧 changeSet 卡片需标为已过期。
    // 前端按 payload.sessionId 路由，把该 session 非 resolved 态的 changeSet 推 superseded。
    ctx.markChangeSetsSuperseded(sid)
  },
}

/**
 * 终态帧 type 集合（收口在 handler 尾部执行的帧）：单帧异常安全网的裁决依据——
 * 这些帧的 finalizeSession 调用若被异常截断，session 的 streaming 实体永不收口
 * （isGenerating 恒 true，输入框永久禁用），必须在 dispatch 层补收口（RD-1#5）。
 */
const TERMINAL_FRAME_TYPES: ReadonlySet<string> = new Set([
  'message.complete',
  'message.error',
  'message.stream_error',
])

/**
 * [RD-1#9 / R1-B12 双轨收敛] dev 一次性帧观测 warn 工厂（isDevMode 门 + Set 去重一次/类型）。
 *
 * 原三段式（isDevMode 门 + 模块级 Set 去重 + console.warn）在本文件（未注册 message.* 帧
 * 观测）与 useChat（未列 session.* 帧观测）双轨维护，收敛为本工厂；前缀过滤与 warn 文案
 * 属调用方语义差异，由调用侧保留（工厂只管 dev 门 + 去重 + warn）。生产零开销（isDevMode 门）。
 * 返回 reset 供测试隔离（调用方配 __clearXxxForTest 导出，对齐 platform/dev-mode
 * __resetDevModeForTesting 模式）。
 */
export function createDevOnceFrameWarn(formatMessage: (type: string, sid: string) => string): {
  warn: (type: string, sid: string) => void
  reset: () => void
} {
  // taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：dev 观测去重集合（非 GUI 数据）
  const warnedTypes = new Set<string>()
  return {
    warn(type: string, sid: string): void {
      if (!isDevMode() || warnedTypes.has(type)) return
      warnedTypes.add(type)
      console.warn(formatMessage(type, sid))
    },
    reset(): void {
      warnedTypes.clear()
    },
  }
}

// 未注册 message.* 帧观测（RD-1#9：无构造点守卫，runtime 新增帧而注册表漏接的协议漂移）
// 与坏 entry 帧观测（A5 守卫触发 = event-adapter 漂移信号）各持独立实例——去重键同为
// 帧类型，但互不挤占对方的「一次/类型」配额。
const unregisteredFrameWarn = createDevOnceFrameWarn(
  (type, sessionId) =>
    `[effects] unhandled frame type ${type} (sid=${sessionId}) — no message effect registered; frame is a no-op (protocol drift or intentionally unhandled)`,
)
const malformedEntryWarn = createDevOnceFrameWarn(
  (type, sessionId) =>
    `[effects] malformed/missing entry in ${type} (sid=${sessionId}) — frame silently dropped (A5 guard: adapter-constructed frames should never be malformed; drift signal)`,
)

/** [RD-1#9] 未注册 type 的一次性 dev warn（观测补齐，no-op 行为不变）。 */
function warnUnregisteredFrame(type: string, sessionId: string): void {
  unregisteredFrameWarn.warn(type, sessionId)
}

/** [A5 守卫] 坏 entry 静默丢弃的一次性 dev warn（生产行为不变：静默丢弃保留）。 */
function warnMalformedEntryDropped(type: string, sessionId: string): void {
  malformedEntryWarn.warn(type, sessionId)
}

/** 测试专用：清空去重集合。 */
export function __clearUnhandledFrameTypeWarnForTest(): void {
  unregisteredFrameWarn.reset()
  malformedEntryWarn.reset()
}

/**
 * message.* 事件的单一入口（消除 double-dispatch）。
 *
 * useChat.ensureStreamSubscription 收到任意 ServerMessage 后：
 * - message.* → 调本函数（经 store.applyMessageEvent 转发），注册表执行全部 effect
 * - session.* → useChat 保留处理（跨 store：sessionStore.applySnapshot 等）
 *
 * 非 message.* 或未注册的 message.* type 直接 no-op（等价原 applyChunk 的 default return）。
 * [RD-1#9] 未注册 type 的 no-op 在 dev 下补一次/类型 warn（协议漂移零痕迹 → 可见）。
 *
 * 单帧异常隔离（RD-1#5）：handler 抛错仅记录不逆传（调用链上游 coalescer/events 各有
 * 隔离，但半执行帧的状态残留不能靠上游兜）；终态帧异常补 finalizeSession 收口——
 * 理由：非终态帧（delta/queue_update 等）半执行后下一帧自然继续，强行收口反而误杀
 * 进行中的流；终态帧的收口是 handler 的最后一步，被截断 = 永久卡 streaming，且
 * finalizeSession 幂等（handler 已收口则 no-op），补调安全。
 */
export function dispatchMessageEvent(
  ctx: MessageEffectContext,
  sessionId: string,
  msg: ServerMessage,
): void {
  const handler = messageEffects[msg.type as ServerMessageType]
  // msg.payload 是 ServerMessageMap 的联合（含 SystemPromptSnapshot 等 interface 类型，
  // 无 string index signature）。handler 内部统一用 readString 等安全窄化（见上方注释），
  // 不依赖 index signature，故 cast 到 Record<string, unknown> 是安全的。
  if (!handler) return warnUnregisteredFrame(msg.type, sessionId)
  const payload = msg.payload as Record<string, unknown>
  try {
    handler(ctx, sessionId, payload)
  } catch (e) {
    console.error(`[effects] handler threw for ${msg.type} (sid=${sessionId}) — frame side effects may be partial:`, e)
    if (!TERMINAL_FRAME_TYPES.has(msg.type)) return
    // 终态帧安全网：收口参数按 deriveTerminalFrameParams 单映射推导（与各 handler 共用，
    // b05 候选1）；complete 的 'normal' 保守映射为 'error'（handler 中途抛错的正常完成帧
    // 不按干净完成收口——安全网的失败语义见上方注释）。finalizeSession 本身抛错则放弃
    // 收口仅记录（不得让安全网成为新异常源）。
    const derived = deriveTerminalFrameParams(msg.type, payload)
    const reason: FinalizeReason = derived.reason === 'normal' ? 'error' : derived.reason
    const errorText = derived.errorText
    try {
      // [R2-b05-5] complete{aborted} 的 clearInflight 在安全网补做（幂等）：handler 中途
      // 抛错可能未执行到其 clearInflight，残留 inflight 会被后续 message_end 的 ② 计数
      // 兜底误消费。对齐 handler 内「abort 只清 inflight（finalizeSession 之外显式做）」
      // 的顺序与语义；clearInflight 自身失败同样落入下方 catch 仅记录（安全网不成新异常源）。
      if (reason === 'aborted') ctx.clearInflight(sessionId)
      ctx.finalizeSession(sessionId, reason, errorText)
    } catch (finalizeError) {
      // best-effort 降级：安全网自身失败时放弃收口仅记录——不得让安全网成为新异常源
      // （再抛会逆传到 events/coalescer 上游，把单帧故障放大成消费面崩溃）。
      console.error(`[effects] finalize safety net also failed for ${msg.type} (sid=${sessionId}):`, finalizeError)
    }
  }
}
