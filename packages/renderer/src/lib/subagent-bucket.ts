/**
 * subagent 判据 SSOT 模块（纯函数）。
 *
 * 唯一职责：导出两个投影判据，全仓「真在跑 / 完成展示」的判定只写这一处，禁止消费方
 * 重复实现：
 * - **isRunningProjection**——占用谓词，全仓「真在跑」唯一出处（G2）：hasRunning /
 *   isStreamingSubagent（stores/subagent）均为本函数的 import wrapper（U2 判据单一化），
 *   托盘计数（useTrayCounts）与「进行中」分桶视图同源消费，不漂移。
 * - **isDoneProjection**——done 展示公式（idle + 有 result = 完成展示）。
 *
 * [HISTORICAL] 2026-09-16 用户裁决托盘两态化：intent 意愿分桶自 UI 退役。原分桶面
 * （SubagentFilterValue / SubagentBucket / DEFAULT_SUBAGENT_FILTER / subagentBucket /
 * filterSubagents / countSubagents，设计 subagent-sidebar-filter §3.4，原设计文档已删除、
 * git 可追溯）随「已收起」视图一并删除——「已收起」不是用户可见状态，托盘不再以第三
 * 状态呈现；已收起记录归入「已结束」桶（已结束 = !isRunningProjection）。同日全链路
 * 清除终态：「已收起」机制已全链路删除——intent 字段自 shared 契约与 subagent-core
 * 执行层一并移除，renderer 不再按它分桶。
 */
import type { SubagentRecord } from '@taiji/shared'

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
 * 均为本函数的 import wrapper（U2 判据单一化），托盘计数（useTrayCounts）与「进行中」
 * 分桶视图同源消费，不漂移。
 * [B3] 全集覆盖守卫（adversarial-review-fixes §3.3 B3；[U6] 后全集 = 两态）：shared 扩
 * SubagentStatus 枚举时，新「进行中类」值对本谓词的归属必须显式评估——本函数直读
 * status，新值默认落 false（安全方向）；但展示层（托盘 subagent 行状态点）与全集覆盖
 * 矩阵须同步评估新值的三态归属，subagent-bucket.test.ts 断言表缺键即测试红。
 */
export function isRunningProjection(record: SubagentRecord): boolean {
  return record.status === 'running' && record.stopReason === undefined
}

/**
 * done 展示判据（[modeless 波4] 判据 idle+result 化——chatMode 比对位随字段消亡删除）：
 * idle + 有 result = 完成展示（轮终产出在场）。万物可续后 idle 不再细分「完成 vs 等续聊」
 * （chatMode===false 特判删除）——本函数保留作展示公式与测试面，状态点色表已不消费
 * （idle 统一绿兜底，托盘 subagent 行状态点表同语义）。
 * [two-state-convergence D1] 本函数不参与占用判定——占用谓词 isRunningProjection 是
 * 严格口径，不经本函数反向挪用。
 */
export function isDoneProjection(record: SubagentRecord): boolean {
  return record.status === 'idle' && record.result !== undefined
}
