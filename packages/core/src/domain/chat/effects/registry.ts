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
 * - 收口时机：complete/error/stream_error 调 finalizeSession 收口
 *   （status 由 streaming 派生 isGenerating，非手动 flag）。
 * - [设计裁决：坏 entry 静默丢弃（2026-09-17 错误处理审查 A5 登记）] 消息类 handler
 *   （构造点 = event-adapter tool-call-start / tool-call-end / handleMessageEnd）在 entry
 *   缺失或形态不符时静默 return 是有意取舍，不加 warn：正常流经 event-adapter 构造的帧
 *   不会产生坏 entry（构造侧已守卫）；单帧异常静默丢弃换取异常帧不断流（主对话流不因
 *   协议漂移中断）。若本分支被触发即是 event-adapter 漂移信号，排障入口 = 对齐
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
  Segment,
  ServerMessage,
  ServerMessageType,
  SteerFollowUpMode,
  ToolCall,
} from '@taiji/shared'
import { normalizePiToolResult } from '../apply-entry'
import { truncateEntryToolOutput } from '../apply-entry-utils'
import type { RetryState, QueueState, FinalizeReason } from '../store-types'
import type { MessageEffectContext, MessageEffectHandler } from '../effect-types'
export type { MessageEffectContext, MessageEffectHandler } from '../effect-types'
import {
  readString,
  readNumber,
  readBool,
  readStringArray,
  readDetail,
  readCompactionSummary,
  readBranchSummary,
  readFileChanges,
  readChangeSetStatus,
} from '../readers'
import { findLastAssistantIndex, findToolCallOwner } from '../chunk-processor'
import { commitMessages, REASON_FALLBACK_ERROR_TEXT, terminalMessagePatch } from '../mutations'
import { truncateToolCall } from '../truncate-tool-output'
import { bashStartEffect, bashResultEffect } from '../bash-effects'
import { applyEntryFrameWithOverlay } from './entry-overlay'
// [session-occupancy u4a] message_end(user) 三分支 ①（defer 分区 FIFO 匹配）与 ①③ 共用
// helper 归位 effects/user-delivery.ts（机制独立成模块，u4b flush 确认驱动只扩展该文件）
import { confirmDeferQueueEntry, extractUserContentText, removeQueuedTextFromSnapshot } from './user-delivery'
// [TODO @i18n-migration] core/i18n 落地后恢复 i18n.global.t 调用（§0.3 列为后续迁移）。
// compactionSummary（W6）/ branchSummary（D13 renderer-deepening）均已 entry 化：两者的
// summary 兜底收敛到 reducer（compaction 中文 fallback「上下文已压缩」/ branchSummary
// 空串），live/reload 一致，本文件不再持有占位文案。

/**
 * 计数差集：返回 prev 比 next 多出的元素（按出现次数，非子串匹配）。
 *
 * [B1] queue_update drain 驱动 pending→complete 用。pi drain 一条 steer 时 splice 移除一项，
 * prev=['A','A'] → next=['A'] → 差集 ['A']（drain 了一条）。用 includes 会因 'A' 仍在 next 里
 * 漏判，导致第二条 pending 永久卡住。计数差集精确匹配出现次数差。
 *
 * [W14] 与 drainN 计数 FIFO 配合：countDrained 返回数组的 length = 被投递条数 N →
 * drainN(sid, mode, N) 按入队顺序取 N 条（FIFO，与 pi splice 顺序一致），不按文本找——
 * pi 入队存 skill 展开后文本 ≠ 提交原文，文本匹配在该场景必挂（D6）。
 */
function countDrained(prev: string[], next: string[]): string[] {
  const remaining = [...next]
  const drained: string[] = []
  for (const text of prev) {
    const idx = remaining.indexOf(text)
    if (idx !== -1) {
      remaining.splice(idx, 1) // 仍在队列，消掉一个名额
    } else {
      drained.push(text) // prev 有但 next 没有/少了 → 被 drain
    }
  }
  return drained
}

/** W06-B：帧数组 → 快照 state（空数组视为无内容，不设维度字段）。 */
function queueStateOf(steering: string[] | undefined, followUp: string[] | undefined): QueueState {
  const state: QueueState = {}
  if (steering?.length) state.steering = steering
  if (followUp?.length) state.followUp = followUp
  return state
}

/**
 * [steer-bubble u2 / D2 维护点 1] pending→complete 驱动的腿 1 消费：计数差集找出「被 drain
 * 投递的」条数（prev 比 new 多出的元素）。
 * [B1] 不能用 includes（子串语义）——重复文本 'A' 入队两条、drain 一条后 new=['A']，
 * includes('A')===true 会漏判，第二条 pending 永久卡住。计数差集按出现次数精确匹配。
 * [W14] 差集数组的 length = N，drainN 计数 FIFO 取前 N 条（不按文本匹配——pi 入队存
 * skill 展开后文本 ≠ 提交原文，文本相等匹配在该场景必丢消息，D1 表末行 + D6）。
 * steer / follow-up 各自差集各自计数（sendMode 隔离，防跨类型同文本误取——W5 语义保留）。
 * 调用时序与原内联逐字一致：steer drain → steer appendUser 循环 → followUp drain →
 * followUp appendUser 循环 → 两维度 inflight 各按实取数累加。
 *
 * 腿 1 消费点 inflight += 实取数（m = drainN 实际返回数组长度，两维度各算各的）：
 * drain 帧是投递证据，这些气泡「已显示待 message_end 确认」。按实取数 m 计而非差集
 * N——m < N 的差额 = 扩展注入等 buffer 无货条目，未显示即不确认，其 message_end
 * 到达时走腿 2 includes 兜底。m = 0 时 incrementInflight no-op（不产生零值条目）。
 *
 * [steer-bubble Gate B AC-4 / dev 验证开关] globalThis.__TAIJI_STEER_SKIP_LEG1__ = true 时
 * 跳过腿 1 消费（模拟 drain 帧丢失——真实链路其余部分不动，快照照常写入），用于 AC-4
 * 确定性触发验证腿 2 独立承担显示（devtools console 设置；产线无人设置恒 false）。
 */
function drainDeliveredByDiff(
  ctx: MessageEffectContext,
  sid: string,
  prev: QueueState | undefined,
  steering: string[] | undefined,
  followUp: string[] | undefined,
): void {
  const skipLeg1 =
    (globalThis as { __TAIJI_STEER_SKIP_LEG1__?: boolean }).__TAIJI_STEER_SKIP_LEG1__ === true
  if (!prev || skipLeg1) return
  const steerN = countDrained(prev.steering ?? [], steering ?? []).length
  const steerDrained = ctx.drainN(sid, 'steer', steerN)
  for (const segs of steerDrained) ctx.appendUser(sid, segs)
  const followN = countDrained(prev.followUp ?? [], followUp ?? []).length
  const followDrained = ctx.drainN(sid, 'follow-up', followN)
  for (const segs of followDrained) ctx.appendUser(sid, segs)
  ctx.incrementInflight(sid, steerDrained.length)
  ctx.incrementInflight(sid, followDrained.length)
}

/**
 * [steer-bubble u2 / D4] 快照写入/删条目：帧数组（steering/followUp）驱动 QueueBubble 快照。
 * 投递侧 reconcilePending 裁剪已移除（见 queue_update handler 注释）；帧内
 * pendingMessageCount 字段投递侧裁剪移除后前端已无消费方（仅 event-adapter 翻译附带，
 * 与帧数组等值——W14 D6 的同源公式）。
 */
function commitQueueSnapshot(
  queueStates: MessageEffectContext['queueStates'],
  sid: string,
  state: QueueState,
): void {
  const hasContent = !!state.steering?.length || !!state.followUp?.length
  if (!hasContent) {
    if (queueStates.value.has(sid)) {
      const nextMap = new Map(queueStates.value)
      nextMap.delete(sid)
      queueStates.value = nextMap
    }
  } else {
    queueStates.value = new Map(queueStates.value).set(sid, state)
  }
}

/**
 * [steer-bubble u1 / D1 + D2] message_end(user) 腿 2：投递事实驱动的用户气泡兜底显示。
 *
 * [session-occupancy-send-closure u4a / D5.3] 处理序升级为三分支（单一入口内，逐级下落）：
 * - ① defer 分区 FIFO 文本匹配（effects/user-delivery.ts，新增，最高优先级）：命中 →
 *   确认回调出队 + 剔一个快照实例 + 仅 send 条目 decrementInflight 回收占位 + 帧消费
 *   终止；未命中 → 逐级下落。
 * - ② inflight > 0 → 纯计数 decrement → return（现状零改动——恢复计数语义，不作出队信号）
 * - ③ inflight == 0 → includes 兜底（现状零改动——腿 2 正常 steer 路径，defer 帧未命中
 *   ① 时的数量守恒兜底：drainN 无货则降级 appendUser，帧不丢气泡不丢）。
 *
 * 腿 2 双腿互斥裁决原文（D2，P1 探针保证 drain 帧恒先于 message_end(user) 到达）：
 * - inflight > 0 → 本帧对应**已显示**的投递（腿 1 消费 +m / send 乐观 +1 的确认通道）
 *   → decrementInflight 抵消后跳过。不查 includes——同文本下数组可能还剩未投递条目，
 *   includes 不可判定，计数优先裁决。
 * - inflight == 0 → includes 兜底：contentText ∈ 最后 queue_update 帧快照（steering /
 *   followUp 两维度分别查）。这是 **pi 帧文本 ↔ pi 帧文本** 同源比对（P2 探针三处同源
 *   恒等），与 W14 否决的「前端提交原文 ↔ pi 展开文本」跨源匹配不是同一命题；唯一
 *   职责 = 排除 send（文本从不在数组）与确认曾入队。
 *   - 无快照（断连清了 queueStates / drain 空帧已删条目）→ 无据跳过，漏显由 D3
 *     快照收敛兜底。
 *   - 命中 → 消费 1 条：drainN(1) 回填 segments，暂存空（扩展注入等 buffer 无货）
 *     → 帧内文本纯文本降级插入（G2：降级可见不静默）。**消费后不加 inflight**——
 *     显示即完成，本帧就是自己的确认帧。
 *   - 双维度同文本命中（跨 mode）：按 steering → followUp 顺序取**有货**的一方
 *     （pi 投递序 steering 先于 followUp，同文本双命中时已投递更可能是 steering 条目；
 *     顺序 fallback 后仅剩「两 mode 暂存全空」才降级，比设计 D2 已知边界①的单 mode
 *     误指降级更强，内容同质无视觉差）。消费剔快照剔实际取货维度的一个实例。
 */
function confirmUserDeliveryOnMessageEnd(
  ctx: MessageEffectContext,
  sid: string,
  entry: PiMessageEntry,
): void {
  // ① defer 分区 FIFO 文本匹配（session-occupancy D5.3）：命中即消费终止，不走 ②③。
  if (confirmDeferQueueEntry(ctx, sid, entry)) return
  if (ctx.getInflight(sid) > 0) {
    ctx.decrementInflight(sid, 1)
    return
  }
  const snapshot = ctx.queueStates.value.get(sid)
  // 无快照 → includes 无据 → 跳过（D2：漏显由 D3 reconcile 快照收敛兜底）
  if (!snapshot) return
  const text = extractUserContentText(entry)
  // 空文本（纯 image 等无文字内容）无入队比对语义，跳过
  if (!text) return
  const hitSteer = snapshot.steering?.includes(text) === true
  const hitFollow = snapshot.followUp?.includes(text) === true
  // 未命中 = send 路径（send 文本从不在数组，其乐观插入已在 send 点显示）→ 跳过
  if (!hitSteer && !hitFollow) return
  const candidates: Array<{ mode: SteerFollowUpMode; dimension: 'steering' | 'followUp' }> = []
  if (hitSteer) candidates.push({ mode: 'steer', dimension: 'steering' })
  if (hitFollow) candidates.push({ mode: 'follow-up', dimension: 'followUp' })
  let consumed: Segment[] | undefined
  let consumedDimension = candidates[0]!.dimension
  // 全空降级路径（两命中维度暂存全无货）下 consumedDimension 停留在最后尝试维度——
  // 同文本剔一实例即完成深度对齐，维度选择不影响后续 countDrained 正确性（一致性审查
  // doc_error #3：该子路径无取货发生，「剔实际取货维度」名不副实但行为等价）。
  for (const candidate of candidates) {
    consumedDimension = candidate.dimension
    const drained = ctx.drainN(sid, candidate.mode, 1)
    if (drained.length > 0) {
      consumed = drained[0]
      break
    }
    // 该 mode 暂存无货 → 试下一命中维度（双维度同文本场景取有货方，见函数头注释）
  }
  ctx.appendUser(sid, consumed ?? [{ type: 'text', text }])
  removeQueuedTextFromSnapshot(ctx.queueStates, sid, consumedDimension, text)
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
    const { messages, queueStates, clearPendingSend, reconcilePending } = ctx
    // G-023: message_start 清 QueueBubble。只清 queueStates 显示态——pending→complete 的
    // 转换完全由 queue_update 的 countDrained 精确驱动（pi 保证 queue_update(drain) 先于
    // message_start 到达，见 agent-session.ts:515-536 注释 "remove it BEFORE emitting"）。
    // 此前有个 W2 flush（把残留 pending 强转 complete），基于错误前提「queue_update 可能
    // 晚于 message_start 乱序」——pi 同步保证不会乱序，且 abort 清空队列时强转会把
    // 「被丢弃」误标成「已投递」。已删除。
    //
    // [steer-bubble u2 / D4 + §2 F4]
    // 无条件清改**条件清**（F4 修复）：先读快照深度（steering + followUp 数组长度和），
    // 深度 == 0（无条目或数组全空）→ 删条目（QueueBubble 随深度归零消失，现状语义）；
    // 深度 > 0 → **保留**——混合提交常态路径下 steering 已 drain、followUp 待 turn 边界
    // 投递，该快照是未投递 followUp 的投递判据（腿 1 的 prev 差集与腿 2 的 includes 都
    // 读它），无条件删会断两腿（F4：f1 永久漏显）。QueueBubble 消失语义从「新回合启动」
    // （edge，混合提交时误删未投递快照）归正为「队列深度归零」（level，幂等、丢帧可由
    // 下一帧收敛）。保真前提（P3 探针 ✅）：本时点快照深度 == pi 真实队列深度 ==
    // 未投递 followUp 数。
    const snapshot = queueStates.value.get(sid)
    const queueDepth = (snapshot?.steering?.length ?? 0) + (snapshot?.followUp?.length ?? 0)
    if (queueDepth === 0) queueStates.value.delete(sid)
    // [steer-bubble u2 / D4] 同点僵尸清理（与条件清同帧同据，先读后清）：pendingBuffer
    // 存量 > 快照深度 → 裁残量（reconcilePending 内建判断：存量 <= 深度 no-op）。
    // 投递侧每帧裁剪已移除（见 queue_update handler 注释），僵尸隔离收敛到本时点——
    // 清残量防 FIFO 错位污染后续 steer。
    reconcilePending(sid, queueDepth)
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
    const stopReason = readString(payload, 'stopReason')
    const isErrorStop = stopReason === 'error'
    // [HISTORICAL] pi turn 失败（stopReason='error'）时 runtime event-adapter 从 agent_end 提取
    // errorMessage 放进本 payload。曾经过往 handler 只读 stopReason/content/usage 把它丢弃——
    // 秒败 turn（如模型 400 拒绝首请求）content 为空，气泡仅剩一个空 error 态，用户完全不可见。
    // 消费双通道：
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
      // 同帧气泡：开始/结束时刻取同一读数（秒级展示口径下一致，避免 1ms 漂移）
      const errNow = Date.now()
      commitMessages(messages, sid, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: '', error: errorMessage || REASON_FALLBACK_ERROR_TEXT.error, status: 'error', timestamp: errNow, endedAt: errNow },
      ])
    }
    // 统一收口（finalizeSession 幂等：entity 已改则 no-op，只清 pendingSend + timer）
    // 此处 message status 已改终态 → finalizeSession 内走「只补 toolCall 收口」分支。
    const reason: FinalizeReason = isErrorStop ? 'error' : (stopReason === 'aborted' ? 'aborted' : 'normal')
    // [steer-bubble u2 / D4] abort 只清
    // inflight（在 finalizeSession 之外显式做——finalizeSession 是通用收口，normal/error
    // 不清）。D4 初版按「pi abort 确定性清队列」假设做三项清，Gate B 实测（2026-08-30）
    // 证伪：pi abort() 不调 clearQueue 也不 emit queue_update，队列跨 abort 存活并在下一
    // prompt 照常投递（残余投递已被模型收到）。pendingBuffer 与 queueStates 是 pi 存活
    // 队列的前端镜像，随 pi 保留——下一 prompt 的 drain/message_end 帧到达时两腿正常
    // 消费（腿 1 回填完整 segments），QueueBubble 在 abort 后持续显示 = 真实队列深度；
    // 快照/暂存的偏差收敛出口仍是 G-023 条件清 + 僵尸清理（帧驱动对账，不依赖 abort
    // 全清）。inflight 必须清：abort 后已显示未确认的条目不会再有 message_end，残留
    // 计数会吞掉后续投递的确认配额。
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
      // [M2 形态统一] 错误文本只住 error 字段，content 空；开始/结束同读数
      const errNow = Date.now()
      commitMessages(messages, sid, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: '', error: errorText, status: 'error', timestamp: errNow, endedAt: errNow },
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
      // [M2 形态统一] 错误文本只住 error 字段，content 空；开始/结束同读数
      const errNow = Date.now()
      commitMessages(messages, sid, [
        ...prev,
        { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: '', error: streamErrContent, status: 'error', timestamp: errNow, endedAt: errNow },
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
    // interpreter 补 contentIndex/messageId 锚点）。
    // [坏 entry 静默丢弃 → 见文件头「行为等价性」设计裁决；构造点 = event-adapter tool-call-start]
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
    // [坏 entry 静默丢弃 → 见文件头「行为等价性」设计裁决；构造点 = event-adapter tool-call-end]
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
    // entry 形态守卫：message entry（type:'message'）才喂。
    // [坏 entry 静默丢弃 → 见文件头「行为等价性」设计裁决；构造点 = event-adapter handleMessageEnd]
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

  'message.queue_update': (ctx, sid, payload) => {
    // W06-B：消息队列更新。payload（event-adapter）：{ steering?, followUp? }。
    // pi 发空数组 []（_emitQueueUpdate 总展开为数组），空数组视为无内容（length 判断）。
    // 分三阶段 helper（读取 / 腿 1 消费 / 快照落盘），编排顺序与原内联一致。
    const steering = readStringArray(payload, 'steering')
    const followUp = readStringArray(payload, 'followUp')
    const state = queueStateOf(steering, followUp)
    const prev = ctx.queueStates.value.get(sid)
    drainDeliveredByDiff(ctx, sid, prev, steering, followUp)

    // [steer-bubble u2 / D4] 投递侧 reconcilePending 裁剪已移除：drain 后立即裁到深度会
    // 吃掉腿 2（message_end(user)）还没回填的 segments——pi 时序保证 drain 帧先于
    // message_end（P1 探针），立即裁剪会让腿 2 的 segments 回填在正常路径下永远失效；
    // 且断连等场景 prev 缺失时以本帧深度裁空 buffer 是丢消息的不可逆放大器（F3）。
    // buffer 存活到 message_end 是 D2 双腿的工作前提；僵尸改由 G-023 时点
    // （message_start(assistant)）条件清理（见该 handler）。
    commitQueueSnapshot(ctx.queueStates, sid, state)
  },

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
