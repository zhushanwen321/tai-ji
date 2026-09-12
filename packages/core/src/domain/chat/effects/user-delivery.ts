/**
 * message_end(user) 投递确认子域（session-occupancy-send-closure——已删除，git 可追溯——u4a / D5.3）。
 *
 * 承载三分支处理序的 ①（defer 分区 FIFO 文本匹配）与其注入点（defer 队列 provider），
 * 以及 ①③ 共用的帧文本提取 / 快照剔除 helper。归位动机：registry.ts 为 message.*
 * effect 注册表（多 type 聚合），defer 确认机制独立成模块后 u4b（flush 投递确认驱动
 * 重写）只需扩展本文件；同时 registry 行数回到 packages 域 max-lines 基线内。
 *
 * 三分支处理序（单一入口 registry.confirmUserDeliveryOnMessageEnd 内，逐级下落）：
 * - ① defer 分区 FIFO 文本匹配（本文件 confirmDeferQueueEntry，最高优先级）
 * - ② inflight > 0 → 纯计数 decrement → return（现状零改动）
 * - ③ 腿 2 快照 includes 兜底（现状零改动）
 */
import type { PiMessageEntry } from '@xyz-agent/shared'
import type { MessageEffectContext } from '../effect-types'
import type { CompactQueueLike } from '../useChat'
import type { QueueState } from '../store-types'

/**
 * [steer-bubble u1 / D2 第 3 点] 提取 message_end(user) 帧的投递文本——① 的 FIFO 比对源
 * 与 ③ 腿 2 includes 兜底判据的比对源。
 *
 * 实测 pi 投递的 user message content 是 content parts 数组 [{type:'text',text}]
 * （P2 探针，pi 不 trim）；wire 宽形态也可能到达 string（lift/异常帧），两种都归一为
 * 纯文本。非 text part（image 等）不拼接——入队帧数组只含文本，拼接会破坏同源比对。
 * text parts 按顺序拼接与 reducer 的 textContent 累加同语义（apply-entry-convert）。
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
 * [steer-bubble u1 / D2 第 3 点] ①/③ 消费后从快照剔命中文本一个实例（不可变写）。
 *
 * 为什么剔：F1 场景（pi splice 失败、drain 帧未发）快照停留于入队帧——含已被消费
 * 的文本，不剔则下一条提交的 countDrained(prev, new) 差集会错算出虚假 drain 数
 * → 腿 1 提前取出未投递条目；剔后快照深度与实际待投递对齐。
 *
 * 幂等性（设计 §5 待验证点，u4a 逐行确认）：includes→filter 模式天然幂等——
 * ① `!prev || !arr`（无快照/无维度数组）早退；② `idx === -1`（实例不存在）早退；
 * ③ 命中时 filter 不可变写。对「快照中不存在的实例」调用即 no-op 不抛错，重复调用
 * 结果一致（单测 ID1-ID3 锁定，effects-defer-confirmation.test.ts）。
 *
 * 剔后形态对齐 queue_update handler 的既有惯例：维度数组剔空 → 移除该维度字段；
 * 两维度全空 → 删除条目（queueStates 不积累空形态条目，QueueBubble 随深度归零消失，
 * 与空帧删条目同语义）。
 */
export function removeQueuedTextFromSnapshot(
  queueStates: MessageEffectContext['queueStates'],
  sid: string,
  dimension: 'steering' | 'followUp',
  text: string,
): void {
  const prev = queueStates.value.get(sid)
  const arr = prev?.[dimension]
  if (!prev || !arr) return
  const idx = arr.indexOf(text)
  if (idx === -1) return
  const rest = arr.filter((_, i) => i !== idx)
  const next: QueueState = { ...prev }
  if (rest.length === 0) delete next[dimension]
  else next[dimension] = rest
  const nextMap = new Map(queueStates.value)
  if (next.steering?.length || next.followUp?.length) nextMap.set(sid, next)
  else nextMap.delete(sid)
  queueStates.value = nextMap
}

/**
 * [session-occupancy-send-closure——已删除，git 可追溯——u4a / D5.3] defer 队列（compactQueue）provider——
 * message_end(user) 三分支处理序 ①（defer 分区 FIFO 文本匹配）的注入点。
 *
 * 为什么模块级 provider 而非 MessageEffectContext 成员：createChatStore 是无参 factory、
 * ctx 在 applyMessageEvent 内联构造（本单元领地不含 store.ts/effect-types.ts/renderer
 * stores/chat.ts），且 useCompactQueue 是 renderer 模块级单例（App.vue setup 绑定 app 级
 * effect scope 创建）——与 useChat 的 streamSubscriptions/coalescer 同款「全局 sid 协调器
 * 模块级单例」（ADR-0049 例外）对齐：renderer shell（useCompactQueue.ts 模块加载时）注册
 * provider，core 只依赖 CompactQueueLike 结构类型，无跨域 import。
 *
 * 未注册（core 单测未注入 / 旧消费方）→ ① 整体跳过 = defer 分区缺席，帧落入 ②③ 现状链
 * （与「队列无条目」同语义，既有行为逐字节不变）。
 */
let compactQueueProvider: (() => CompactQueueLike) | null = null

/**
 * 注册 defer 队列 provider（renderer useCompactQueue.ts 模块加载时调用一次；core 单测
 * 注入 mock 用）。重复注册以最后一次为准（单例语义，后写胜出）。
 */
export function setCompactQueueProviderForEffects(provider: () => CompactQueueLike): void {
  compactQueueProvider = provider
}

/** 重置 provider（仅供测试隔离：core 单测 afterEach 清 mock，防跨用例泄漏）。生产禁调。 */
export function resetCompactQueueProviderForEffectsForTest(): void {
  compactQueueProvider = null
}

/**
 * [簇 A2] flush 提交确认标记的提取正则——SSOT 在 apply-entry-convert.ts（剥标记消费点，
 * 显示投影与 ①a 提取同源），本文件 re-export 供 renderer QueueBubble 等显示侧 import。
 * 形态与互斥论证见定义处注释。
 */
export { DEFER_FLUSH_MARKER_RE } from '../apply-entry-convert'
import { DEFER_FLUSH_MARKER_RE } from '../apply-entry-convert'

/**
 * [u4a / D5.3 ①] defer 分区 FIFO 文本匹配——message_end(user) 三分支的最高优先级分支。
 *
 * [簇 A2] 出队信号去文本化（对齐 C-data-08「消费按计数 FIFO 禁文本匹配」）——两级匹配：
 * - ①a 标记 id 匹配（最高优先）：帧文本提取 flush 提交标记（submitQueuedEntry 附加
 *   `<!--xyz:msg:<entry.id>-->`，裸 uuid 标记经 pi input hook / steer 通路全程存活）
 *   → 按条目 id 精确确认。文本被 skill-injector 三入口（message-dispatcher sendPrompt /
 *   steerMessage / followUpMessage）或 BeforeSend hook 改写后仍可达——id 是身份不是内容。
 * - ①b 文本等值降级兜底（既有判据）：标记缺失/被 hook 剥除但文本未被改写的形态仍可
 *   确认（FIFO 最早同文本条目优先，语义与改造前一致）。
 *
 * 帧 content 文本与 compactQueue（defer 队列）已提交条目匹配 → 命中：确认回调出队
 * （confirmDelivery，转态动作在队列实现侧，u4b 消费条目 id）+ removeQueuedTextFromSnapshot
 * 剔一个同文本实例（若快照含，维持 queueStates 与 pi 队列对账）+ 仅 send 条目
 * decrementInflight 回收占位 + 返回 true（帧消费终止，调用方不再走 ②③）。
 * 未命中返回 false（逐级下落现有链）。
 *
 * 同文本碰撞守恒声明（D5.3 第 3 点）：① 的匹配可能把别人的帧配给 defer 条目（归属互换）
 * ——但帧数 = 落盘实体数，每帧恰被 ①/②/③ 之一消费一次，暂存侧按「① 命中即剔一个快照
 * 实例」保持数量守恒，同文本视觉不可区分，无用户可见差异。①a 标记 id 命中因标记的
 * 唯一性（条目 id 全局唯一）无归属互换面。
 *
 * 匹配资格 = 已提交条目（mode 已由 flush 提交时写入）：未提交条目的投递确认帧不可能
 * 存在，被同文本他帧误配出队会让永不被投递的消息被标记已投递（G2 必达破坏）——mode
 * undefined 天然排除（u4a 实现决策，单测 AC7 锁定）。
 *
 * @returns true = 帧已被 ① 消费（调用方终止处理）；false = 未命中/匹配作废，落 ②③ 现状链
 */
export function confirmDeferQueueEntry(
  ctx: MessageEffectContext,
  sid: string,
  entry: PiMessageEntry,
): boolean {
  // provider 未注册 = defer 分区缺席 → 直接落 ②③ 现状链（既有行为零变化的前提）。
  const queue = compactQueueProvider?.()
  if (!queue) return false
  // 独立提取帧文本（③ 内另有一次提取——纯函数无副作用，保守起见 ③ 代码行零改动）
  const deferText = extractUserContentText(entry)
  if (!deferText) return false
  const snapshots = queue.peek(sid)
  // ①a 标记 id 匹配（簇 A2）：身份级确认，不受文本改写影响
  const markerId = deferText.match(DEFER_FLUSH_MARKER_RE)?.[1]
  const hit = (markerId !== undefined
    ? snapshots.find((m) => m.id === markerId && m.mode !== undefined)
    : undefined)
    // ①b 文本等值降级兜底（既有判据，[defer segments 化 / D-A1-4] 比较源改 submitText）：
    // FIFO 最早同文本条目优先（且仅已提交条目）。submitText = 提交时写入的
    // segmentsToPrompt(segments)——富内容条目 draft（text）≠ 序列化落盘文本，按 text
    // 比对会失配；undefined（旧形态/未走 flush 提交写入）回退 text。覆盖面显式判定：
    // 含 skill 段条目 pi 落盘 = 注入展开后全文 ≠ submitText，①b 对其失配——分层语义
    // 即「①b 只管标记被剥但文本未被改写」，skill 展开属文本改写、由 ①a 独扛。
    ?? snapshots.find((m) => (m.submitText ?? m.text) === deferText && m.mode !== undefined)
  if (!hit) return false
  if (!queue.confirmDelivery(sid, hit.id)) {
    // confirmDelivery false（peek→确认间条目消失，同步单线程下防御性不可达）→ 匹配
    // 作废，落 ②③ 现状链（帧不丢、不剔快照、不动计数）。
    return false
  }
  // 剔快照一个同文本实例维持 queueStates 与 pi 队列对账（不剔则后续 countDrained
  // 差集错算虚假 drain → 腿 1 提前取出未投递条目，同腿 2 剔除理由）。固定 steering
  // 维度：defer 条目 pi 侧唯一落点走 chatApi.steer；send 条目文本从不在数组 →
  // includes 不命中天然 no-op。函数本身幂等（无快照/无维度/实例不存在均早退）。
  removeQueuedTextFromSnapshot(ctx.queueStates, sid, 'steering', deferText)
  // 仅 send 条目回收占位（D5.3 第 3 点）：defer send 条目挂 inflight 占位（防帧被
  // ② 误拦后漏配），确认到达即回收；steer 条目不挂占位，无条件 decrement 会对纯
  // 计数做多余扣减（错抵他条确认配额）。
  if (hit.mode === 'send') ctx.decrementInflight(sid, 1)
  // 帧消费终止：出队/转态已由确认回调承担。
  return true
}
