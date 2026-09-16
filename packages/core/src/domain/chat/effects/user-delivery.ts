/**
 * message_end(user) 投递确认子域（投递所有权内核 D2/D7——delivery-ownership-kernel u3b）。
 *
 * 承载两块职责：
 * 1. **session.delivery 帧投影**（D7 单一数据源）：内核状态帧（state topic 全量快照）
 *    的 per-session 投影，队列区/气泡 morph（u3c QueueBubble 单源化）读这里；
 *    steer/queued 条目 morph 时捕获的 segments 暂存于此，送达回执时按原段入流。
 * 2. **送达回执消费**（①a 泛化，C-data-08 修订方向）：message_end(user) 帧文本尾的
 *    内核裸标记 id 命中投影条目 → 投影转 delivered + morph 段按序入流 + inflight 占位
 *    回收，帧消费终止。
 *
 * [HISTORICAL] 前身：defer 队列 provider（compactQueueProvider + confirmDeferQueueEntry
 * + removeQueuedTextFromSnapshot）——defer 队列状态机已随投递所有权内核整体退役
 * （设计 §3.1 删除面），确认通道由「队列 FIFO 文本匹配」升级为「内核条目 id 标记匹配」，
 * git 可追溯。
 *
 * 投影落位说明：session.delivery 投影的理想宿主是 chat store 分区（对齐 queueStates
 * 惯例），但 store.ts 不在 u3b 领地——本模块级 ref 为 interim 承载（taste:allow-no-data-owner
 * 同类豁免：内核状态帧是 runtime 投影数据，非本地 UI 输入），store 分区收编归 u3c/u5
 * 评估；per-session 键控 + disposeSession/resetChatModuleStateForTest 双清理点 + 测试
 * reset 钩子已按 ADR-0049 分区纪律对齐。
 */
import { ref } from 'vue'
import { textToSegments } from '@taiji/shared'
import type { PiMessageEntry, Segment } from '@taiji/shared'
import type { MessageEffectContext } from '../effect-types'
import type { DeliveryFrameEntry } from '../api-port'
import { DEFER_FLUSH_MARKER_RE } from '../apply-entry-convert'

/**
 * [簇 A2 沿用] 内核出站裸标记的显示层剥标记正则——SSOT 在 apply-entry-convert.ts（剥标记
 * 消费点，显示投影同源），本文件 re-export 供 renderer QueueBubble 等显示侧 import。
 */
export { DEFER_FLUSH_MARKER_RE }

/**
 * [u3b 契约桥] 回执标记提取正则（双形态，只服务送达回执匹配）：内核出站标记 id 期望 =
 * 条目 clientUuid 去 `u-` 前缀的裸 uuid（与显示剥标记 SSOT 同空间——裸标记不被
 * msg-id-mapper input hook 剥除，PS-26），同时兼容 u-<uuid> 原文形态（u1 若以 clientUuid
 * verbatim 出标记也命中——双形态收口消除跨单元契约错配面）。捕获组 2 统一归一为裸 uuid。
 *
 * 为什么不复用 DEFER_FLUSH_MARKER_RE：其字符集结构性排除 u- 前缀（显示层只需裸形态）；
 * 本正则是回执匹配专用，与显示剥标记职责分离，不改 SSOT。
 */
const DELIVERY_RECEIPT_MARKER_RE =
  /<!--taiji:msg:(u-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-->/i

// ── session.delivery 帧投影（D7 队列区单一数据源）──────────────────────────────

/** per-session 内核条目快照投影（state topic last-value 语义：每帧整体替换）。 */
// taste:allow-no-data-owner W24-EX-C（内核状态帧投影，interim 承载说明见文件头注）
const deliveryEntriesBySession = ref<Map<string, DeliveryFrameEntry[]>>(new Map())

/** steer/queued 条目 morph 时捕获的乐观气泡 segments（sid → clientUuid → segments）。
 *  非响应式核心记账：送达回执时一次性消费（按原段入流），消费即删。 */
// taste:allow-no-data-owner W24-EX-C（进程内流程状态——morph 暂存的段待回执消费，非 GUI 数据源；
// 与上方投影同批 interim 承载，登记表条目随 u3c/u5 收编评估一并补登）
const morphSegmentsBySession = new Map<string, Map<string, Segment[]>>()

/** 消费 session.delivery 帧：投影整体替换（空条目集删键，不积累空形态——对齐 queueStates 惯例）。 */
export function replaceDeliveryProjection(sid: string, entries: DeliveryFrameEntry[]): void {
  const next = new Map(deliveryEntriesBySession.value)
  if (entries.length === 0) next.delete(sid)
  else next.set(sid, [...entries])
  deliveryEntriesBySession.value = next
}

/** 读投影快照（帧数组只读语义：调用方不得原地改写；响应式消费走 getDeliveryProjectionRef）。 */
export function getDeliveryProjection(sid: string): readonly DeliveryFrameEntry[] {
  return deliveryEntriesBySession.value.get(sid) ?? []
}

/** 投影 ref（u3c QueueBubble 单源化 reactive 消费口；模块级单例，测试 reset 见下方钩子）。 */
export function getDeliveryProjectionRef(): typeof deliveryEntriesBySession {
  return deliveryEntriesBySession
}

/** 清指定 session 投影与 morph 段（disposeSession 编排 + delivery.drain 全量回收共用）。 */
export function clearDeliveryProjection(sid: string): void {
  if (deliveryEntriesBySession.value.has(sid)) {
    const next = new Map(deliveryEntriesBySession.value)
    next.delete(sid)
    deliveryEntriesBySession.value = next
  }
  morphSegmentsBySession.delete(sid)
}

/** 重置全部投影状态（仅供测试隔离；生产禁调——生产清理走 clearDeliveryProjection）。 */
export function resetDeliveryProjectionForTest(): void {
  deliveryEntriesBySession.value = new Map()
  morphSegmentsBySession.clear()
}

/**
 * [D7 morph] 捕获被 morph 条目的乐观气泡 segments：气泡已从对话流移除（truncateFrom），
 * 其原始段（image/skill/file chip 等）暂存于此，送达回执（message_end 标记命中）时按
 * 原段入流——「送达回执 → 按序入流」不降级为纯文本（live ≡ reload：reload 侧由 reducer
 * 重放产出同文消息）。重复捕获以最后一次为准（同 clientUuid 只会提交一次，防御性语义）。
 */
export function captureMorphSegments(sid: string, clientUuid: string, segments: Segment[]): void {
  const partition = morphSegmentsBySession.get(sid) ?? new Map<string, Segment[]>()
  partition.set(clientUuid, segments)
  morphSegmentsBySession.set(sid, partition)
}

/**
 * 送达回执消费（一次性）：条目投影转 delivered（队列区随即隐去）+ 返回捕获的 morph 段
 * （未 morph 过的条目返回 undefined——direct 气泡保持原位，无重复入流面）。
 * 幂等：已 delivered 条目返回 undefined（重复回执不二次入流）。
 */
function consumeDeliveryReceipt(sid: string, clientUuid: string): Segment[] | undefined {
  const entries = deliveryEntriesBySession.value.get(sid)
  const hit = entries?.find((e) => e.clientUuid === clientUuid && e.state !== 'delivered')
  if (hit) {
    const next = new Map(deliveryEntriesBySession.value)
    next.set(sid, entries!.map((e) => (e.clientUuid === clientUuid ? { ...e, state: 'delivered' as const } : e)))
    deliveryEntriesBySession.value = next
  }
  const segments = morphSegmentsBySession.get(sid)?.get(clientUuid)
  if (segments !== undefined) {
    const partition = morphSegmentsBySession.get(sid)!
    partition.delete(clientUuid)
    if (partition.size === 0) morphSegmentsBySession.delete(sid)
  }
  return segments
}

// ── message_end(user) 送达回执（①a 泛化，C-data-08 修订方向）──────────────────

/**
 * [steer-bubble u1 / D2 第 3 点] 提取 message_end(user) 帧的投递文本——回执标记的提取源。
 *
 * 实测 pi 投递的 user message content 是 content parts 数组 [{type:'text',text}]
 * （P2 探针，pi 不 trim）；wire 宽形态也可能到达 string（lift/异常帧），两种都归一为
 * 纯文本。非 text part（image 等）不拼接。text parts 按顺序拼接与 reducer 的 textContent
 * 累加同语义（apply-entry-convert）。
 */
export function extractUserContentText(entry: PiMessageEntry): string {
  const content = entry.message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let text = ''
    for (const part of content) {
      if (
        typeof part === 'object' && part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        text += (part as { text: string }).text
      }
    }
    return text
  }
  return content != null ? String(content) : ''
}

/**
 * [u3b / D2① 泛化] message_end(user) 送达回执——内核裸标记 id 命中投影条目即送达事实
 * （C-data-08 修订方向：标记 id 精确匹配取代计数 FIFO/文本匹配，id 是身份不是内容）。
 *
 * 命中处理（三分支，单一 owner = 内核投影）：
 * - ① morph 段存在（本地乐观气泡被 morph 移除过）→ 按原 segments 入流（非降级恢复）。
 * - ② 无 morph 段且非 direct 车道且 ref 中无同 id 气泡 → 纯文本降级入流：外来注入
 *   （session_manager send / plugin-service / 收养）与 runtime 重启 reattach 形态没有本地
 *   乐观气泡，其显示责任由本分支承接（前身 = 已退役的腿 2 includes 兜底，见下方
 *   [HISTORICAL] 注记）——文本按 reload 投影同规则剥标记 + trimEnd（同一正则同一变换，
 *   live ≡ reload 构造性成立）。direct 车道豁免：其气泡原位保留，入流会双插。
 * - ③ 其余（direct 气泡原位 / 已有同 id 气泡）→ 不动 ref（防双插）。
 * 共同收尾：投影转 delivered（幂等：已 delivered 命中即拒）+ inflight 占位回收（统一
 * submit 每条挂 1，回执即其确认帧）+ 返回 true（帧消费终止，调用方不再走 ② 计数兜底）。
 * 未命中返回 false（无标记 / 标记不命中投影——外来直发、帧缺失形态，落 ② 现状链）。
 *
 * [HISTORICAL ② 前身] 退役的腿 2 ③「includes 兜底」以 queue_update 快照文本匹配为据、
 * 插入含标记的原文纯文本；本分支以「内核条目身份 + 剥标记文本」同职责重建（数据源从
 * 已退役的 queue_update 快照换成 session.delivery 投影，D7 单一数据源）。
 *
 * 与 reducer 的关系：调用方（registry message_end handler）已无条件 ctx.applyEntryFrame
 * 喂 reducer（transcript 权威），本函数只是 overlay 显示侧的回执消费，异常路径不阻断
 * 权威喂入——与 ① 前身（defer 分区）同款职责划分。
 */
export function confirmKernelDeliveryOnMessageEnd(
  ctx: MessageEffectContext,
  sid: string,
  entry: PiMessageEntry,
): boolean {
  const text = extractUserContentText(entry)
  if (!text) return false
  const marker = text.match(DELIVERY_RECEIPT_MARKER_RE)
  if (!marker) return false
  const bareId = marker[2]!
  // 双形态匹配（契约桥见 DELIVERY_RECEIPT_MARKER_RE 注释）：裸 uuid（期望形态）/ u-<uuid> 原文
  const entries = deliveryEntriesBySession.value.get(sid) ?? []
  const hit = entries.find(
    (e) => (e.clientUuid === bareId || e.clientUuid === `u-${bareId}`) && e.state !== 'delivered',
  )
  if (!hit) return false
  const segments = consumeDeliveryReceipt(sid, hit.clientUuid)
  if (segments) {
    // ① morph 段入流（气泡已移除的条目按原 segments 恢复为正常 user 气泡——overlay-only，
    // 不喂 reducer：transcript 权威已由调用方 applyEntryFrame 承担，appendUser 不写 sidecar）
    ctx.appendUser(sid, segments)
  } else if (hit.lane !== 'direct' && !hasLocalBubble(ctx, sid, hit.clientUuid)) {
    // ② 无本地气泡的投递（外来注入 / reattach 恢复）：纯文本降级可见，不静默丢显示
    ctx.appendUser(sid, textToSegments(text.replace(DEFER_FLUSH_MARKER_RE, '').trimEnd()))
  }
  // inflight 占位回收：统一 submit 的每条乐观气泡挂 1，本帧即其确认帧（② 不再重复扣）
  ctx.decrementInflight(sid, 1)
  return true
}

/** ref 分区是否已有该 id 的气泡（appendUser 契约：气泡 id = clientUuid；truncateFrom 幂等）。 */
function hasLocalBubble(ctx: MessageEffectContext, sid: string, id: string): boolean {
  return (ctx.messages.value.get(sid)?.value ?? []).some((m) => m.id === id)
}
