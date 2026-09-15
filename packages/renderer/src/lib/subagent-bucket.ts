/**
 * subagent 分桶判据 SSOT 模块（纯函数，设计 subagent-sidebar-filter §3.4 / D3 D4——原设计文档
 * docs/design/subagent-sidebar-filter.md 已删除，git 可追溯，现行判据以 subagent-bucket.test.ts
 * 断言表为准；永久会话模型 §3.2.8 默认可见性翻转，U8b 重写）。
 *
 * 唯一职责：把 SubagentRecord 按意愿维度（intent）分「活跃 / 已收起」二桶 + 派生
 * 「正在跑」占用谓词，供 SubagentList（列表过滤 + 状态点展示判据）、SubagentFilterBar
 * 计数、useSidebarCounts badge 共同消费——判据只写这一处，禁止消费方重复实现（D3）。
 * [two-state-convergence D2]「与 hasRunning 同源」自 U2 起为结构性事实：hasRunning /
 * isStreamingSubagent（stores/subagent）与 isStreaming（SubagentList）均已改为 import
 * 本模块的 isRunningProjection wrapper，全仓「真在跑」判据单一出处（G2）。
 *
 * [U8b 可见性翻转] 默认列表 = running + idle(active) 全显（[U6] 契约收窄后类型已
 * 两态，legacy 终态由 runtime 归一层映射 idle 同样可见——「旧 session 显示」只读兼容）；
 * intent=archived 默认隐藏，「已收起」过滤视图可寻回（场景 3：寻回靠 message 隐含
 * 翻回 active，GUI 只负责展示与入口）。
 */
import type { SubagentRecord } from '@xyz-agent/shared'

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
 * 占用谓词（G2「正在跑」严格口径 SSOT——two-state-convergence D1/D2；[U6] 判据
 * 终态化：`status === 'running' && stopReason === undefined`（D5 R3 终态判据，§3.1
 * isOccupied 本体）。U1 桥接判据的 result 子句已删——U4 翻边后轮终权威词
 * = idle（status 子句直接排除），result 子句的旧 entry 兜底职责由 runtime 归一层
 * 第五归一（`running && resumable===true → idle`，D5）承接；stopReason 子句排除
 * W4 死亡纳管态（running + stopReason='failed'，[U5/D4] adoptEngineDeath 写点），
 * 依赖轮始清点族扩字段（markRoundStarted / revive 格翻 running 时清 stopReason）——
 * 在飞期上轮停因不可见 = 显式裁决的代价（§3.1 注释）。
 * 全仓「真在跑」判据唯一出处：hasRunning / isStreamingSubagent（stores/subagent）
 * 与 isStreaming（SubagentList）均为本函数的 import wrapper（U2 判据单一化），
 * badge 计数（useSidebarCounts）与「正在跑」过滤视图同源消费，不漂移。
 */
export function isRunningProjection(record: SubagentRecord): boolean {
  return record.status === 'running' && record.stopReason === undefined
}

/**
 * done 展示判据（[modeless 波4] 判据 idle+result 化——chatMode 比对位随字段消亡删除）：
 * idle + 有 result = 完成展示（轮终产出在场）。万物可续后 idle 不再细分「完成 vs 等续聊」
 * （chatMode===false 特判删除）——本函数保留作展示公式与测试面，状态点色表已不消费
 * （idle 统一绿兜底，见 SubagentList STATUS_DOT_RULES）。
 * [two-state-convergence D1] 本函数不参与占用判定——占用谓词 isRunningProjection 是
 * 严格口径，不经本函数反向挪用。
 */
export function isDoneProjection(record: SubagentRecord): boolean {
  return record.status === 'idle' && record.result !== undefined
}

/**
 * [B3] 全集覆盖守卫（adversarial-review-fixes §3.3 B3，U8b 重述；[U6] 后全集 = 两态）：
 * shared 扩 SubagentStatus 枚举时，新「进行中类」值对本占用谓词的归属必须显式评估
 * ——isRunningProjection 直读 status，新值默认落 false（安全方向）；但展示层
 * （SubagentList 状态点）与全集覆盖矩阵须同步评估新值的三态归属，
 * subagent-bucket.test.ts 断言表缺键即测试红。
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
