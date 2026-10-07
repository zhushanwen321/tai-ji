/**
 * rail 节点摘要 per-turn memo（自 TurnRail.vue 模块级 WeakMap 上移为共享导出）。
 *
 * 背景：rail 模板每 render 对全部节点跑 summarize*（summarizeAssistantForRail →
 * stripMarkdown 15+ 次全文正则），WeakMap 按 turn 引用缓存——引用同 ⇒ 内容同
 * （ADR-0039 不可变替换 + core toRenderItemsIncremental 对签名未变的 turn 逐引用
 * 复用）⇒ 摘要同；内容变化必然走不可变替换产生新引用（miss 后重算一次）。
 * turn 对象被 GC 后 WeakMap 条目自动回收，无泄漏。
 *
 * 模块级单例的两个消费方：
 * - TurnRail.vue 渲染：railMemoFor 命中零重算（既有行为，原文迁出）。
 * - useMessageStreamRail 的 railTurns 投影恒等判定（streaming perf）：streaming 末位
 *   turn 每帧新引用 → 命中判定需比对「rail 可见投影签名」（memo 四字段）而非 turn
 *   引用——与渲染消费同一 memo，每帧对末位 turn 至多算一次签名，且命中帧 TurnRail
 *   因 props 引用不变整体跳过重渲（零 vnode diff）。判定与渲染同源，签名漂移不可能。
 *
 * 无实例/props/session 维度（同 turn 引用 ⇒ 同派生值，跨 TurnRail/MessageStream 实例
 * 共享同一缓存条目安全——原 TurnRail.vue memo 注释同款论证）。
 */
import type { MessageTurn } from '@taiji/core/domain/chat'
import { hasFailedTool } from '@taiji/core/domain/chat'
import { summarizeTurnForRail, summarizeAssistantForRail } from '@taiji/core/domain/chat'

/** memo 条目的纯数据形状（非待实现契约——无 implements/extends 变体，用 type 别名） */
type RailTurnMemo = {
  /** user 行摘要（summarizeTurnForRail，无 user turn 为空串——模板 `|| ' '` 兜底不变） */
  userSummary: string
  /** agent 行摘要（summarizeAssistantForRail，空串时模板经占位门判定「进行中…」或空格 fallback——判据不在 memo 内） */
  agentSummary: string
  /** hasFailedTool 结果（agent 行文本 hover 升色依据） */
  failed: boolean
  /** agent 行 Bot 图标着色 class（agentIconClass 产出，与 failed 同帧同源） */
  iconClass: string
}

// @data-owner #58 —— chat 对话流渲染派生 memo ①（rail 节点摘要，纯派生可丢弃重建）
const railMemo = new WeakMap<MessageTurn, RailTurnMemo>()

/** agent 行 Bot 图标的着色 class（仅非 active 态消费；active 态走 loader-spin 不读本字段）：
 * failed（hasFailedTool）→ text-danger（§5.6B 常驻红），其余 → text-neutral-ico。 */
function agentIconClass(turn: MessageTurn): string {
  if (hasFailedTool(turn)) return 'text-danger'
  return 'text-neutral-ico'
}

/** 取 turn 的 rail 摘要 memo（首见计算并缓存，命中零重算）。模板每 render 调用。 */
export function railMemoFor(turn: MessageTurn): RailTurnMemo {
  let memo = railMemo.get(turn)
  if (memo === undefined) {
    memo = {
      userSummary: summarizeTurnForRail(turn),
      agentSummary: summarizeAssistantForRail(turn),
      failed: hasFailedTool(turn),
      iconClass: agentIconClass(turn),
    }
    railMemo.set(turn, memo)
  }
  return memo
}
