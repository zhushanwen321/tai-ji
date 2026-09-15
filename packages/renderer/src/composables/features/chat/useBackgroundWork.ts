/**
 * useBackgroundWork —— background 异步任务（subagent/workflow）谓词。
 *
 * 聚合 subagent + workflow 的 running/paused 判定，供 deriveStatus（working 态）与
 * handleCompletion（完成提示守卫）共用。单一真相源：未来新增 background 任务类型
 * （非 subagent/workflow）只需在 hasBackgroundWork 实现里注册判定。
 *
 * 为什么独立 composable 而非内联：
 *   hasBackgroundWork 原本内联在 useSessionDerivations.derivedStatus（L83），但
 *   handleCompletion（useCompletionNotify.ts）需复用同一判定。独立 composable 消除
 *   重复，避免两处判定漂移。
 */
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'

export function useBackgroundWork() {
  const subagentStore = useSubagentStore()
  const workflowStore = useWorkflowStore()

  /**
   * 指定 session 是否有 background 任务仍在跑（subagent running 或 workflow running/paused）。
   * subagent 无 paused 概念（只有 running/done/failed/cancelled/crashed）；workflow 有 paused（用户暂停）。
   * paused 算 background work：paused 不发 triggerTurn 续跑，主 agent 不会推进，仍是未完成状态。
   *
   * H2 W1（record-unification D1③）：workflow 脚本派发的 subagent（origin==='workflow'）
   * 不算本 session 的后台工作——其生命周期由 workflow run 承载（终态化收口见 D7），
   * 混入会让主 session 在 workflow 运行期间被误判 working。origin 缺省（undefined =
   * tool 语义，存量 record）恒参与判定。判据单源 = store.hasRunning（S1：origin 排除
   * 经 opts 传入，不再内联复刻判据）。
   */
  function hasBackgroundWork(sessionId: string): boolean {
    const subagentWorking = subagentStore.hasRunning(sessionId, { excludeOrigin: 'workflow' })
    return subagentWorking || workflowStore.hasRunningOrPaused(sessionId)
  }

  return { hasBackgroundWork }
}
