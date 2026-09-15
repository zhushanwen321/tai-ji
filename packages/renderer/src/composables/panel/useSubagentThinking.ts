/**
 * useSubagentThinking —— subagent drawer 思考中指示（u3-thinking，设计
 * docs/design/subagent-drawer-blank.md §6.3/§7.3）。
 *
 * 虚拟 session 收不到 occupancy 帧（sessionPhase.turn 恒 idle），ActivityStrip thinking 行
 * 永远不亮——由 forceWorking 补充驱动：真在跑且末位 turn 还没有 assistant 产出（分区为空或
 * 只有 task user 气泡）时视为「思考中」，调用方经 prop 传给 ActivityStrip（文案复用
 * dispatching key）。不写 occupancy、不动 TurnMeta（§6.3 裁决：occupancy 是 runtime 帧驱动
 * 的单一权威，renderer 伪造写点破坏 SSOT）。
 *
 * 自 MessageStream.vue 抽出（≤300 行规范）：lastRenderTurn 是调用方的局部 computed，
 * 作形参注入复用（本 composable 不重复派生渲染项）。
 */
import { computed, type ComputedRef } from 'vue'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import { SUBAGENT_OUTCOME_PLACEHOLDER } from '@taiji/shared'
import { isSubagentVirtualId, extractSubagentId, extractMainSessionId, useSubagentStore } from '@/stores/subagent'

/**
 * @param sessionId 当前 panel 绑定的 session id（响应式）
 * @param lastRenderTurn 渲染项里最后一个 turn（调用方局部 computed，无 turn 时 null）
 */
export function useSubagentThinking(
  sessionId: ComputedRef<string>,
  lastRenderTurn: ComputedRef<MessageTurn | null>,
): { forceWorking: ComputedRef<boolean>; subagentThinking: ComputedRef<boolean> } {
  const subagentStore = useSubagentStore()

  /** subagent 虚拟 session 真在跑时强制 streaming（JSONL 读出 status 恒 complete，但 subagent 可能还在跑）。
   *  [review round2 R1-遗留-1] 窄口径判定（isStreamingSubagent，与主 session hasRunning 同判据）：
   *  running + 轮终 result 在场（running-resumable）不算 streaming——轮终后虚拟 session 末位
   *  turn 不再卡「streaming」，与主 session working 判定一致。resumable 续轮的真实流活动由
   *  消息级 streaming status 承担（subscribeStream → applySubagentStreamDelta）；订阅判定
   *  继续用宽松 isRunning（SubagentTab），此处不受影响。 */
  const forceWorking = computed(() => {
    if (!isSubagentVirtualId(sessionId.value)) return false
    return subagentStore.isStreamingSubagent(extractMainSessionId(sessionId.value), extractSubagentId(sessionId.value))
  })

  /**
   * subagent drawer 思考中判定（§6.3/§7.3 + 非 pi 可见性 D6）：forceWorking 且末位
   * turn 无 assistant 实质产出——assistants 为空，或全部为占位 assistant（content ===
   * SUBAGENT_OUTCOME_PLACEHOLDER，仅 result/error 双缺时由③级投影产出）。非占位
   * content（真实 result/error 文本）= 有产出 → 思考行熄灭。
   */
  const subagentThinking = computed(() => {
    if (!forceWorking.value) return false
    const turn = lastRenderTurn.value
    return (
      turn === null ||
      turn.assistants.length === 0 ||
      turn.assistants.every((a) => a.content === SUBAGENT_OUTCOME_PLACEHOLDER)
    )
  })

  return { forceWorking, subagentThinking }
}
