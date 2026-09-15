/**
 * entry 化四步骨架共享 helper（u6.2 D13 联动，renderer-deepening 设计「effects 骨架
 * helper」的 entry 侧形态）。
 *
 * 从 4 处 effect 内联收敛（customStart / compactionSummary / branchSummary / bashResult）：
 * 此前每个 handler 各自重复「applyEntryFrame 喂 reducer → 空 state 派生 overlay 投影 →
 * commit 追加 messages ref」四步（对称性靠注释维持），收敛为单点骨架，effect 只保留
 * 差异部分（entry 构造）。
 *
 * 语义（与收敛前各处逐字等价）：
 * 1. 权威喂入：ctx.applyEntryFrame(sid, entry) 喂 store 内 per-session reducer state
 *    （与文件重放 get_entries → replayEntries 同一个 applyEntry——「live ≡ reload」
 *    构造性成立的喂入点）。
 * 2. overlay 投影：applyEntry 在空 state 上派生本条消息。
 * 3. commit：派生消息追加进 messages ref（渲染 ref 消费同一份派生，W21 裁决：ref 不由
 *    reducer state 直接投影，收敛归 W22）。
 *
 * 适用前提：「投影不依赖前置 state」——custom_message / compaction / branch_summary /
 * bashExecution message entry 的 reducer case 均无条件 append（空 state 派生即本条消息）；
 * 依赖前置 state 的 entry（toolResult 窗口回填 / user badge 查表）不适用本 helper。
 */
import type { PiEntry } from '@taiji/shared'
import { applyEntry, createInitialChatViewState } from '../apply-entry'
import { commitMessages } from '../mutations'
import type { MessageEffectContext } from '../effect-types'

/**
 * entry 化四步：权威喂入 + overlay 投影 + commit。
 * 消费方只构造差异部分（entry）；投影/喂入/commit 骨架单点维护。
 */
export function applyEntryFrameWithOverlay(
  ctx: Pick<MessageEffectContext, 'messages' | 'applyEntryFrame'>,
  sid: string,
  entry: PiEntry,
): void {
  // 权威喂入：per-session reducer state（与重开 replayEntries 同一个 applyEntry）
  ctx.applyEntryFrame(sid, entry)
  // overlay 投影：空 state 派生即本条消息（见文件头适用前提）
  const derived = applyEntry(createInitialChatViewState(), entry)
  const prev = ctx.messages.value.get(sid)?.value ?? []
  commitMessages(ctx.messages, sid, [...prev, ...derived.messages])
}
