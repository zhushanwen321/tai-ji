/**
 * subagent 分桶判据 SSOT 模块（纯函数，设计 subagent-sidebar-filter §3.4 / D3 D4——原设计文档
 * docs/design/subagent-sidebar-filter.md 已删除，git 可追溯，现行判据以 subagent-bucket.test.ts
 * 断言表为准；永久会话模型 §3.2.8 默认可见性翻转，U8b 重写）。
 *
 * 唯一职责：把 SubagentRecord 按意愿维度（intent）分「活跃 / 已收起」二桶 + 派生
 * 「正在跑」占用谓词，供 SubagentList（列表过滤 + 状态点展示判据）、SubagentFilterBar
 * 计数、useSidebarCounts badge 共同消费——判据只写这一处，禁止消费方重复实现（D3）。
 *
 * [U8b 可见性翻转] 默认列表 = running + idle(active) 全显（legacy 终态经
 * projectSubagentExecutionStatus 投影 idle 同样可见——「旧 session 显示」只读兼容）；
 * intent=archived 默认隐藏，「已收起」过滤视图可寻回（场景 3：寻回靠 message 隐含
 * 翻回 active，GUI 只负责展示与入口）。
 */
import type { SubagentRecord } from '@xyz-agent/shared'
import { projectSubagentExecutionStatus } from '@xyz-agent/shared'

/** 筛选值（FilterBar 三视图：全部活跃 / 只看正在跑 / 已收起） */
export type SubagentFilterValue = 'active' | 'running' | 'archived'
/** 分桶结果（数据语义二值：意愿维度；'running' 是筛选值不是桶） */
export type SubagentBucket = 'active' | 'archived'

export const DEFAULT_SUBAGENT_FILTER: SubagentFilterValue = 'active'

/**
 * 意愿分桶判据（§3.2.1 intent 维度）：archived = 用户收起；缺省（存量 record 与
 * 旧扩展投影）= active（默认列表可见）。status 不参与本判据——占用与意愿正交。
 */
export function subagentBucket(record: SubagentRecord): SubagentBucket {
  return record.intent === 'archived' ? 'archived' : 'active'
}

/**
 * 占用谓词（G2「正在跑」）：projectSubagentExecutionStatus 投影 running 且非
 * done 投影——done 投影（running + result + chatMode 显式 false，v4~U7 轮终形态）
 * 是「已收口不算在跑」的旧数据窄口径；idle 与 legacy 终态（投影 idle）不算。
 * badge 计数（useSidebarCounts）与「正在跑」过滤视图同源消费，不漂移。
 */
export function isRunningProjection(record: SubagentRecord): boolean {
  return projectSubagentExecutionStatus(record.status) === 'running' && !isDoneProjection(record)
}

/**
 * done 投影判据（D4 SSOT）：one-shot 轮终等 GC——v4~U7 写面故意保持 running
 * （可冷路径 resume）但携带轮终 result，此形态以绿点展示且可长期滞留，「轮终不算
 * 真在跑」是 store 既有窄口径语义（hasRunning / isStreamingSubagent 同源注释）。
 * U8 起成功/失败轮终落 running-resumable 形态（仍经本判据判定 done），并非直接
 * 落 idle——本判据服务全部现存 one-shot 轮终（running + result 形态）+ 旧 session
 * 数据展示，不可退役。
 * SubagentList 展示判据 isDone 必须引用本函数，禁止重复实现。
 */
export function isDoneProjection(record: SubagentRecord): boolean {
  return record.status === 'running' && record.result !== undefined && record.chatMode === false
}

/**
 * [B3] 全集覆盖守卫（adversarial-review-fixes §3.3 B3，U8b 重述）：shared 扩
 * SubagentStatus 枚举时，新值经 projectSubagentExecutionStatus 落「非 running」半边
 * ——对 isRunningProjection 恒 false（安全方向）；但展示层（SubagentList 状态点）与
 * 全集覆盖矩阵须同步评估新值的三态归属，subagent-bucket.test.ts 断言表缺键即测试红。
 */
export function filterSubagents(records: SubagentRecord[], filter: SubagentFilterValue): SubagentRecord[] {
  if (filter === 'archived') return records.filter((r) => subagentBucket(r) === 'archived')
  if (filter === 'running') return records.filter((r) => isRunningProjection(r))
  return records.filter((r) => subagentBucket(r) === 'active')
}

/** 三视图计数（active 与 running 计数集常态包含，编排性关闭打断窗口可短暂交叠） */
export function countSubagents(records: SubagentRecord[]): { active: number; running: number; archived: number } {
  return {
    active: records.filter((r) => subagentBucket(r) === 'active').length,
    running: records.filter((r) => isRunningProjection(r)).length,
    archived: records.filter((r) => subagentBucket(r) === 'archived').length,
  }
}
