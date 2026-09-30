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
 * 投影落位说明：session.delivery 投影由本模块级 ref 承载（u3c 落地形态：useQueueRows
 * 等 composable 不持 per-session 状态，投影分区由本 ref 持有——内核状态帧是 runtime
 * 投影数据，非本地 UI 输入）；per-session 键控 + disposeSession/resetChatModuleStateForTest
 * 双清理点 + 测试 reset 钩子按 ADR-0049 分区纪律对齐。登记条目 = 登记表主表 #6
 * （deliveryEntriesBySession 声明处 @data-owner #6）。
 */
import { ref } from 'vue'
import { textToSegments, MSG_ID_TAG_RE } from '@taiji/shared'
import type { PiMessageEntry, Segment } from '@taiji/shared'
import type { MessageEffectContext } from '../effect-types'
import type { DeliveryFrameEntry } from '../api-port'
import { DEFER_FLUSH_MARKER_RE } from '../apply-entry-convert'
import { isDevMode } from '../../../platform/dev-mode'

/**
 * [u3b 契约桥] 回执标记提取：SSOT = @taiji/shared 的 MSG_ID_TAG_RE（投递身份标记正则，
 * 双形态 `u-<uuid>` / 裸 `<uuid>`，捕获组 2 = 裸 uuid——本文件原手写体已收敛进该 SSOT，
 * 与 runtime skill-notice-publisher 同源）。只服务送达回执匹配；与显示剥标记
 * DEFER_FLUSH_MARKER_RE 职责分离（其字符集结构性排除 u- 前缀，显示层只需裸形态），不改 SSOT。
 */

/**
 * [R2-b04-2] 回执匹配用全局形态（由 shared SSOT 派生，不复制模式文本）：matchAll 取文本内
 * **最后一个**标记——内核标记恒追加在消息尾部，用户正文自带（粘贴）标记时首匹配会命中
 * 粘贴 id 而非本条投递身份（误配不命中投影 → 条目滞留 in-flight 至下一帧快照覆盖）。
 */
const MSG_ID_TAG_RE_GLOBAL = new RegExp(MSG_ID_TAG_RE.source, `${MSG_ID_TAG_RE.flags}g`)

// ── session.delivery 帧投影（D7 队列区单一数据源）──────────────────────────────

/** per-session 内核条目快照投影（state topic last-value 语义：每帧整体替换）。 */
// @data-owner #6 —— 主表 #6 renderer 消费副本：队列区渲染（useQueueRows / QueueBubble）
// 与撤回/气泡三态路由（findDeliveryEntry）直接消费的数据源，自 §4 ⑧ W24-EX-C 豁免转正向注解
const deliveryEntriesBySession = ref<Map<string, DeliveryFrameEntry[]>>(new Map())

/** steer/queued 条目 morph 时捕获的乐观气泡 segments（sid → clientUuid → 快照）。
 *  非响应式核心记账：送达回执时一次性消费（按原段入流），消费即删。
 *  [R2-b04-4] 值带 capturedAt——投递丢失/内核作废时回执永不到达，无 TTL 的模块级 Map
 *  会永久驻留（A 类慢泄漏）；TTL 语义见下方常量注释。 */
interface MorphSegmentsSnapshot {
  segments: Segment[]
  capturedAt: number
}
// taste:allow-no-data-owner W24-EX-C（进程内流程状态——morph 暂存的段待送达回执一次性
// 消费，无 GUI 直接消费方；登记于登记表 §4 ⑧ W24-EX-C 条目，队列条目本体归主表 #6 投影/内核）
const morphSegmentsBySession = new Map<string, Map<string, MorphSegmentsSnapshot>>()

/**
 * [R2-b04-4] morph 段 TTL（对齐 store RESPAWN_NOTICE_RETENTION_MS 5min 先例）：过期段在
 * 写入侧（captureMorphSegments 惰性清扫）与消费侧（consumeDeliveryReceipt 到期判否）
 * 清理，无定时器、不抛错——过期即视为无 morph 段，回执落 ② 纯文本降级链（可见性不丢）。
 */
const MORPH_SEGMENTS_TTL_MS = 300_000

/** 清扫全表过期 morph 段（惰性触发：captureMorphSegments 写入前调用）。 */
function purgeExpiredMorphSegments(now: number): void {
  for (const [sid, partition] of morphSegmentsBySession) {
    for (const [clientUuid, snapshot] of partition) {
      if (now - snapshot.capturedAt > MORPH_SEGMENTS_TTL_MS) partition.delete(clientUuid)
    }
    if (partition.size === 0) morphSegmentsBySession.delete(sid)
  }
}

/** 消费 session.delivery 帧：投影整体替换（空条目集删键，不积累空形态——对齐 retryStates 惯例）。 */
export function replaceDeliveryProjection(sid: string, entries: DeliveryFrameEntry[]): void {
  const next = new Map(deliveryEntriesBySession.value)
  if (entries.length === 0) next.delete(sid)
  else next.set(sid, [...entries])
  deliveryEntriesBySession.value = next
}

/**
 * 撤回「在途条目」判定谓词的单一数据点（[MF-1-4]）：按 clientUuid 查投影条目（无条目 =
 * undefined）。调用方（UserBubble 三态路由 / useChat.revokeMessage 双态路由）共用本谓词，
 * 禁再各自内联 `find(e => e.clientUuid === id)`——判定式漂移会让 UI 展示与执行分派分叉。
 * 返回条目对象非布尔：执行侧（revokeMessage）可细分 state（`state !== 'delivered'` = 在途）。
 */
export function findDeliveryEntry(sid: string, clientUuid: string): DeliveryFrameEntry | undefined {
  return deliveryEntriesBySession.value.get(sid)?.find((e) => e.clientUuid === clientUuid)
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
  // [R2-b04-4] 写入前惰性清扫过期段（无定时器，TTL 见常量注释）
  purgeExpiredMorphSegments(Date.now())
  const partition = morphSegmentsBySession.get(sid) ?? new Map<string, MorphSegmentsSnapshot>()
  partition.set(clientUuid, { segments, capturedAt: Date.now() })
  morphSegmentsBySession.set(sid, partition)
}

/**
 * 送达回执消费（一次性）：条目投影转 delivered（队列区随即隐去）+ 返回捕获的 morph 段
 * （未 morph 过的条目返回 undefined——direct 气泡保持原位，无重复入流面）。
 * 幂等：已 delivered 条目返回 undefined（重复回执不二次入流）。
 * [R2-b04-4] TTL：过期段不消费（视为无 morph 段，回执落 ② 纯文本降级链），就地清理不抛错。
 */
function consumeDeliveryReceipt(sid: string, clientUuid: string): Segment[] | undefined {
  const entries = deliveryEntriesBySession.value.get(sid)
  const hit = entries?.find((e) => e.clientUuid === clientUuid && e.state !== 'delivered')
  if (hit) {
    const next = new Map(deliveryEntriesBySession.value)
    next.set(sid, entries!.map((e) => (e.clientUuid === clientUuid ? { ...e, state: 'delivered' as const } : e)))
    deliveryEntriesBySession.value = next
  }
  const partition = morphSegmentsBySession.get(sid)
  const snapshot = partition?.get(clientUuid)
  if (partition && snapshot) {
    partition.delete(clientUuid)
    if (partition.size === 0) morphSegmentsBySession.delete(sid)
  }
  if (snapshot && Date.now() - snapshot.capturedAt <= MORPH_SEGMENTS_TTL_MS) {
    return snapshot.segments
  }
  return undefined
}

// ── message_end(user) 送达回执（①a 泛化，C-data-08 修订方向）──────────────────

/**
 * [steer-bubble u1 / D2 第 3 点] 提取 message_end(user) 帧的投递文本——回执标记的提取源。
 *
 * 实测 pi 投递的 user message content 是 content parts 数组 [{type:'text',text}]
 * （P2 探针，pi 不 trim）；wire 宽形态也可能到达 string（lift/异常帧），两种都归一为
 * 纯文本。非 text part（image 等）不拼接。text parts 按顺序拼接与 reducer 的 textContent
 * 累加同语义（apply-entry-convert）。
 * [R1-b04-候选2] 模块私有（生产仅同文件 confirmKernelDeliveryOnMessageEnd 消费，测试
 * 直接 import = 0）——收窄多余公开面。
 */
function extractUserContentText(entry: PiMessageEntry): string {
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
 * [消息撤回 U8] 两分支入流均传 hit.clientUuid 保号：重建气泡沿用提交时 clientUuid
 * （= morph 前乐观气泡 id = 内核条目 id，三者同源）。保号是 live 窗口撤回入口的结构
 * 前提——换新 `u-<uuid>` 会使该消息在撤回定位双通道（custom entry 映射 / 裸标记末尾
 * 锚）构造性 miss（no-mapping 空洞，且 live 窗口 reconcile 仅切入/重试触发、无自愈）。
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
  // [R2-b04-2] 取文本内最后一个标记（内核标记恒追加尾部，防用户正文自带标记首匹配误配）
  const marker = [...text.matchAll(MSG_ID_TAG_RE_GLOBAL)].pop()
  if (!marker) return false
  const bareId = marker[2]!
  // 双形态匹配（契约桥见 MSG_ID_TAG_RE 注释）：裸 uuid（期望形态）/ u-<uuid> 原文
  const entries = deliveryEntriesBySession.value.get(sid) ?? []
  const hit = entries.find(
    (e) => (e.clientUuid === bareId || e.clientUuid === `u-${bareId}`) && e.state !== 'delivered',
  )
  if (!hit) return false
  const segments = consumeDeliveryReceipt(sid, hit.clientUuid)
  // [R2-b04-3] 外来投递观测判定（须在 ② 入流前取——appendUser 会改变 hasLocalBubble 结果）：
  // 无 morph 段且 ref 无同 id 气泡 = 本地未挂账的投递（外来注入 / reattach 形态）。
  const isForeignReceipt = segments === undefined && !hasLocalBubble(ctx, sid, hit.clientUuid)
  if (segments) {
    // ① morph 段入流（气泡已移除的条目按原 segments 恢复为正常 user 气泡——overlay-only，
    // 不喂 reducer：transcript 权威已由调用方 applyEntryFrame 承担，appendUser 不写 sidecar）；
    // 保号传 hit.clientUuid（= 被移除乐观气泡的 id——morph key 同源），见函数头 [U8] 注释
    ctx.appendUser(sid, segments, hit.clientUuid)
  } else if (hit.lane !== 'direct' && !hasLocalBubble(ctx, sid, hit.clientUuid)) {
    // ② 无本地气泡的投递（外来注入 / reattach 恢复）：纯文本降级可见，不静默丢显示；
    // 保号传 hit.clientUuid（内核条目 id——外来形态可能为裸 uuid，保号语义优先于形态）
    ctx.appendUser(sid, textToSegments(text.replace(DEFER_FLUSH_MARKER_RE, '').trimEnd()), hit.clientUuid)
  }
  if (isForeignReceipt) logForeignReceiptDecrement(sid, hit)
  // inflight 占位回收：统一 submit 的每条乐观气泡挂 1，本帧即其确认帧（② 不再重复扣）
  ctx.decrementInflight(sid, 1)
  return true
}

/** [R2-b04-3] 外来投递回执扣 inflight 的 dev 计数/日志（生产零开销；钳制幂等机制不变）。 */
let foreignReceiptDecrementCount = 0
function logForeignReceiptDecrement(sid: string, hit: DeliveryFrameEntry): void {
  if (!isDevMode()) return
  foreignReceiptDecrementCount++
  console.warn(
    `[user-delivery] foreign receipt decremented inflight (total=${foreignReceiptDecrementCount}, sid=${sid},` +
      ` clientUuid=${hit.clientUuid}, lane=${hit.lane})` +
      ` — no local morph segments and no local bubble; the decrement may consume another direct submission's confirmation quota (clamped >= 0, idempotent)`,
  )
}

/** ref 分区是否已有该 id 的气泡（appendUser 契约：气泡 id = clientUuid；truncateFrom 幂等）。 */
function hasLocalBubble(ctx: MessageEffectContext, sid: string, id: string): boolean {
  return (ctx.messages.value.get(sid)?.value ?? []).some((m) => m.id === id)
}
