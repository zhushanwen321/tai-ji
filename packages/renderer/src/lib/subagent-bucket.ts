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
 * 占用谓词（G2「正在跑」，严格口径 SSOT——two-state-convergence D1/D2）：
 * `running && result === undefined && resumable !== true` 三子句。result 在场 =
 * 轮终信号（chat 轮终 / one-shot 轮终 / legacy chatMode=∅ 形态一律不计入——
 * 旧组合判据 `!isDoneProjection` 对 chatMode=true 的轮终误判占用，即 sidebar
 * badge 幽灵 running 根因，session 01a09f83 实测 8 幽灵）；resumable=true =
 * 无活进程驱动的 residual running（孤儿兜底/轮终），同样不算真在跑。
 * 全仓「真在跑」判据唯一出处：hasRunning / isStreamingSubagent（stores/subagent）
 * 与 isStreaming（SubagentList）均为本函数的 import wrapper（U2 判据单一化），
 * badge 计数（useSidebarCounts）与「正在跑」过滤视图同源消费，不漂移。
 */
export function isRunningProjection(record: SubagentRecord): boolean {
  return (
    projectSubagentExecutionStatus(record.status) === 'running' &&
    record.result === undefined &&
    record.resumable !== true
  )
}

/**
 * done 投影判据（D4 SSOT；[two-state-convergence U4] 判据 idle 化——写面翻边后轮终
 * 权威词 = idle（markRoundIdle 写 idle，对齐 §3.2.2 事件表 settle 行），one-shot 完成
 * 展示判据随之从「running + result + chatMode=false 的桥接组合」翻为
 * `idle && chatMode === false`。桥接期旧 entry（running + result 形态）不再命中本
 * 判据——展示过渡态（U6 归一映射恢复等价显示），占用判定不受影响（isRunningProjection
 * 独立严格口径）。
 * [two-state-convergence D1] 本函数是**展示判据**（done 绿点 vs chat 等续聊 accent
 * 点），不参与占用判定——占用谓词 isRunningProjection 是严格口径（result/resumable
 * 子句），不经理由本函数反向挪用。SubagentList 展示判据 isDone 必须引用本函数，
 * 禁止重复实现。
 */
export function isDoneProjection(record: SubagentRecord): boolean {
  return record.status === 'idle' && record.chatMode === false
}

/**
 * waiting 投影判据（[two-state-convergence U4] SSOT 化 + idle 化——自 SubagentList
 * 本地实现迁入，判据从 `running && 非占用 && 非 done` 的组合翻为 `idle && chatMode
 * !== false`）：chat 等续聊 / 孤儿兜底的静态半透明 accent 点。
 * chatMode 缺省（legacy 存量 entry 无该字段）保守归 chat（!== false 恒真）——无法
 * 确认不是 chat 就不宣告完成（与 isDoneProjection 的保守方向同构，互补无交叠：
 * done = idle && chatMode === false）。
 */
export function isWaiting(record: SubagentRecord): boolean {
  return record.status === 'idle' && record.chatMode !== false
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
