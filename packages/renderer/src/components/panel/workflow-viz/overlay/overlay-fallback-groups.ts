/**
 * overlay-fallback-groups.ts —— WorkflowVizOverlay 壳的两块分组展示数据派生（纯函数）：
 * DAG 不可得的降级列表（run 执行实例按 phase 分组只读形态）与未匹配实例分组
 *（D2⑥：零命中/歧义实例不静默丢弃）。与壳分离的变化原因：分组规则随执行实例形状
 * 演化；壳承载模板与 i18n 文案（随行标注 unmatchedNote 留组件侧——依赖 useI18n 实例）。
 */
import type { WorkflowAgentCall, WorkflowRunRecord } from '@taiji/shared'
import type { WorkflowUnmatchedInstance } from '../blueprint-match'

export interface FallbackGroup { // oe-exempt:20261025:framework:降级分组数据契约（类型契约先行，非抽象接口单实现）
  phase: string
  calls: WorkflowAgentCall[]
}

/** run 的执行实例按 phase 分组（插入序 = 事件流序；phase 缺失归空串组）。 */
export function buildFallbackGroups(run: WorkflowRunRecord | null): FallbackGroup[] {
  if (!run) return []
  const groups = new Map<string, WorkflowAgentCall[]>()
  for (const call of run.agentCalls) {
    const phase = call.phase ?? ''
    const list = groups.get(phase) ?? []
    list.push(call)
    groups.set(phase, list)
  }
  return [...groups.entries()].map(([phase, calls]) => ({ phase, calls }))
}

/** 存在显式 phase 才显示分组 header（线性脚本无 phase 不分组）。 */
export function hasExplicitPhase(groups: readonly FallbackGroup[]): boolean {
  return groups.some((g) => g.phase !== '')
}

export interface UnmatchedGroup { // oe-exempt:20261025:framework:未匹配分组数据契约（类型契约先行，非抽象接口单实现）
  phase: string
  items: WorkflowUnmatchedInstance[]
}

/** 未匹配实例按 phase 分组（插入序 = 事件流序，与降级列表同型；phase 缺失归空串组）。 */
export function buildUnmatchedGroups(items: readonly WorkflowUnmatchedInstance[] | undefined): UnmatchedGroup[] {
  const groups = new Map<string, WorkflowUnmatchedInstance[]>()
  for (const item of items ?? []) {
    const phase = item.call.phase ?? ''
    const list = groups.get(phase) ?? []
    list.push(item)
    groups.set(phase, list)
  }
  return [...groups.entries()].map(([phase, items]) => ({ phase, items }))
}
