/**
 * subagent 分桶判据 SSOT 模块（纯函数，设计 subagent-sidebar-filter §3.4 / D3 D4）。
 *
 * 唯一职责：把 SubagentRecord 按运行状态派生到「进行中 / 已结束」二桶，供
 * SubagentList（列表过滤 + isDone 展示判据）与 SubagentFilterBar 计数共同消费——
 * 判据只写这一处，禁止消费方重复实现 status 判定（D3）。
 */
import type { SubagentRecord } from '@xyz-agent/shared'

/** 筛选值（FilterBar 三桶） */
export type SubagentFilterValue = 'active' | 'ended' | 'all'
/** 分桶结果（数据语义二值；'all' 是筛选值不是桶） */
export type SubagentBucket = 'active' | 'ended'

export const DEFAULT_SUBAGENT_FILTER: SubagentFilterValue = 'active'

/**
 * done 投影判据（D4 SSOT）：one-shot 轮终等 GC——runtime 侧 doFinalizeRoundToIdle
 * 故意保持 running（可冷路径 resume），此形态以绿点展示且可长期滞留，「轮终不算
 * 真在跑」是 store 既有窄口径语义（hasRunning / isStreamingSubagent 同源注释）。
 * SubagentList 展示判据 isDone 必须引用本函数，禁止重复实现。
 */
export function isDoneProjection(record: SubagentRecord): boolean {
  return record.status === 'running' && record.result !== undefined && record.chatMode === false
}

/**
 * 分桶判据（D4）：active = streaming（真在跑，spinner）+ waiting（chat 轮终等续聊 /
 * 孤儿兜底，半透明 accent 点——可复活非终态）；ended = 五种显式终态 + done 投影。
 *
 * [B3] 下方 `status !== 'running'` 是反向白名单：shared 扩 SubagentStatus 枚举时，
 * 新「进行中类」值会静默落本分支的「已结束」桶——扩枚举必须先评估新值桶归属，
 * 同步 SUBAGENT_STATUS_ALL 与 subagent-bucket.test.ts 的全集覆盖矩阵（断言表
 * 缺键即测试红；见 adversarial-review-fixes §3.3 B3）。
 */
export function subagentBucket(record: SubagentRecord): SubagentBucket {
  if (record.status !== 'running') return 'ended'
  return isDoneProjection(record) ? 'ended' : 'active'
}

export function filterSubagents(records: SubagentRecord[], filter: SubagentFilterValue): SubagentRecord[] {
  if (filter === 'all') return records
  return records.filter((r) => subagentBucket(r) === filter)
}

/** 三桶计数（all = 全量长度，非 active+ended 之外的第三桶） */
export function countSubagents(records: SubagentRecord[]): { active: number; ended: number; all: number } {
  const active = records.filter((r) => subagentBucket(r) === 'active').length
  return { active, ended: records.length - active, all: records.length }
}
