/**
 * message.* 事件 effect 注册表（消除 double-dispatch，架构审查候选 F2）。
 *
 * [归位] 迁自 renderer stores/chat-message-effects.ts（P3 chat 域绞杀 w3：AC3 达成——
 * domain/chat/effects 零跨域 import）。
 * [P4 s5 w2] tasks 路由（routeToolResultToTasks/routeToolStartToTasks）与
 * openTasksPanelOnFirstData 回调已随 tasks 域删除移除。
 *
 * 背景：原 chat-chunk-processor（21 case，更新 messages/retryStates/queueStates）
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
 * - 收口时机：message_start 挂载超时兜底 timer、complete/error/stream_error 调
 *   finalizeSession 收口（status 由 streaming 派生 isGenerating，非手动 flag）。
 *
 * 设计：dispatchMessageEvent(ctx, sessionId, msg) 查 messageEffects 表执行 handler；
 * 非 message.* 或未注册 type 直接 no-op。MessageEffectContext 含 store refs
 * 上下文 + finalizeSession/clearPendingSend/armStreamingTimer 回调（由 store 注入，
 * 完成收口与超时兜底）。
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
import { recoverPrematureTimeoutMessages } from './complete-recovery'
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
import { commitMessages, terminalMessagePatch } from '../mutations'
import { truncateToolCall } from '../truncate-tool-output'
import { bashStartEffect, bashResultEffect } from '../bash-effects'
import { applyEntryFrameWithOverlay } from './entry-overlay'
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
    ctx.decrementInflight(sid, 1)
    return
  }
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
    const { messages, clearPendingSend, armStreamingTimer, clearPrematureTimeoutIds } = ctx
    // [premature-timeout §5.2 D2 时机③] 新 turn 开始 → 旧 turn 的 timeout 打标作废
    //（防跨 turn 错配：turn A 超时打标未恢复 → 用户发新 prompt → 本帧到达 → 清 A 标，
    // turn B 的 complete 不命中任何标记，无误恢复旧气泡——设计 §5.2 反例重演第 2 条）。
    // 快照与实体字段的清扫都在 clearPrematureTimeoutIds 内闭环（streaming-state-machine）。
    clearPrematureTimeoutIds(sid)
    // [HISTORICAL] QueueBubble 快照条件清/僵尸清理（G-023）已随 queue_update 计数腿退役：
    // 队列区数据源 = session.delivery 状态帧（内核 state topic 快照，D7），queueStates
    // 不再是任何机制的工作前提。store 侧 queueStates 分区与其清理方法的最终退役归 u5
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
    // 挂载 streaming 超时兜底 timer：防 message.complete 永不到的 pi 静默卡死。
    armStreamingTimer(sid)
  },

  'message.complete': (ctx, sid, payload) => {
    const { messages, finalizeSession } = ctx
    const prev = messages.value.get(sid)?.value ?? []
    const stopReason = readString(payload, 'stopReason')
    const isErrorStop = stopReason === 'error'
    // [HISTORICAL] pi turn 失败（stopReason='error'）时 runtime event-adapter 从 agent_end 提取
    // errorMessage 放进本 payload。曾经过往 handler 只读 stopReason/content/usage 把它丢弃——
    // 秒败 turn（如模型 400 拒绝首请求）content 为空，气泡仅剩一个空 error 态，用户完全不可见。
    // 消费双通道（SSOT docs/architecture/conversation-error-visibility.md §3.3.2）：
    // 有 streaming 气泡 → errorMessage 写最后一条 assistant 的 Message.error 字段（追加形态，
    // content 崩溃前正文不动）；无 streaming 气泡 → 追加纯 error 气泡（errorMessage 即全文）。
    const errorMessage = readString(payload, 'errorMessage')
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
      // 终态字段 patch 单源（与 complete-recovery 恢复分支同语义，S4-A6）：
      // usage/error/content 只作用于末位 assistant，见 terminalMessagePatch 注释
      return terminalMessagePatch(m, i, { lastAssistantIdx, isErrorStop, errorMessage, finalContent, payload })
    })
    // ── [premature-timeout §5.2 D2] 误判收口自愈：恢复分支（实现见 ./complete-recovery.ts）──
    if (changed) commitMessages(messages, sid, next)
    const recovered = recoverPrematureTimeoutMessages({
      messages, sessionId: sid, base: changed ? next : prev, stopReason, errorMessage, finalContent, payload, lastAssistantIdx,
      takePrematureTimeoutIds: ctx.takePrematureTimeoutIds,
    })
    // 秒败 turn（message_start 丢失/未广播）无 streaming 气泡可收口：错误信息必须以纯 error
    // 气泡落进聊天流，否则 complete 事件被消费后错误只剩 stopReason 标志，用户不可见。
    // [premature-timeout] 恢复命中时抑制追加——errorMessage 已按追加形态双通道写进命中实体，
    // 再追加纯 error 气泡会重复展示同一错误。
    if (isErrorStop && errorMessage && !changed && !recovered) {
      commitMessages(messages, sid, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorMessage, status: 'error', timestamp: Date.now() },
      ])
    }
    // 统一收口（finalizeSession 幂等：entity 已改则 no-op，只清 pendingSend + timer）
    // 此处 message status 已改终态 → finalizeSession 内走「只补 toolCall 收口」分支。
    const reason: FinalizeReason = isErrorStop ? 'error' : (stopReason === 'aborted' ? 'aborted' : 'normal')
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

  'message.error': (ctx, sid, payload) => {
    const { messages, finalizeSession } = ctx
    const errorText = readString(payload, 'message') ?? 'Unknown error'
    // 检查是否有前置 streaming assistant（finalizeSession 会收口它）
    const prev = messages.value.get(sid)?.value ?? []
    const idx = findLastAssistantIndex(prev)
    const hasStreaming = idx >= 0 && prev[idx].status === 'streaming'
    // 统一收口：finalizeSession 做 streaming entity error 化 + 清 pendingSend + 清 timer
    finalizeSession(sid, 'error', errorText)
    // 无前置 streaming entity 时 finalizeSession 不追加消息——需手动追加
    if (!hasStreaming) {
      commitMessages(messages, sid, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorText, status: 'error', timestamp: Date.now() },
      ])
    }
  },

  'message.stream_error': (ctx, sid, payload) => {
    const { messages, finalizeSession } = ctx
    const streamErrContent = readString(payload, 'content') ?? 'Stream error'
    const prev = messages.value.get(sid)?.value ?? []
    const idx = findLastAssistantIndex(prev)
    const hasStreaming = idx >= 0 && prev[idx].status === 'streaming'
    // 统一收口
    finalizeSession(sid, 'stream_error', streamErrContent)
    // 无前置 streaming entity 时需手动追加
    if (!hasStreaming) {
      commitMessages(messages, sid, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: streamErrContent, status: 'error', timestamp: Date.now() },
      ])
    }
  },

  // B1（PR#86 review）：pi 静默卡死 WARN（120s 无活动，提示性，不中断流）。
  // 与 stream_error 物理隔离——仅追加 system 提示消息，不调 finalizeSession，
  // session 保持 streaming 态（pi 可能只是慢，130s 后恢复产出）。
  // [W2 fix-chat-flow-order D4] liveOnly 标记（全仓唯一写入点）：stream_warn 是 taiji runtime
  // 自产健康警告，pi 无对应 entry、重开即消失——无 entry 可构故不 entry 化（直插即本类
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
    // interpreter 补 contentIndex/messageId 锚点）。entry 缺失（异常帧）降级丢弃；
    // toolCallId 缺失时 fallback 随机 id（迁移前同款宽容防御：异常事件不断流）。
    const entry = payload['entry'] as PiToolCallEntryForm | undefined
    if (entry === undefined) return
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
    const entry = payload['entry'] as PiMessageEntry | undefined
    if (entry === undefined || entry.type !== 'message') return
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
    // entry 形态守卫：message entry（type:'message'）才喂（协议契约，异常帧降级丢弃）
    if (typeof entry !== 'object' || entry === null || (entry as { type?: unknown }).type !== 'message') return
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
  //    dispatcher 双分支延迟使帧时序构造性对齐 pi 落盘。实现提取于 bash-effects.ts 避免本文件超行）──
  'message.bashStart': bashStartEffect,
  'message.bashResult': bashResultEffect,

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
 * message.* 事件的单一入口（消除 double-dispatch）。
 *
 * useChat.ensureStreamSubscription 收到任意 ServerMessage 后：
 * - message.* → 调本函数（经 store.applyMessageEvent 转发），注册表执行全部 effect
 * - session.* → useChat 保留处理（跨 store：sessionStore.applySnapshot 等）
 *
 * 非 message.* 或未注册的 message.* type 直接 no-op（等价原 applyChunk 的 default return）。
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
  if (handler) handler(ctx, sessionId, msg.payload as Record<string, unknown>)
}
