/**
 * subagent 判据 SSOT 模块（纯函数）。
 *
 * 职责：导出占用投影判据与托盘 subagent 行状态点规则，判定/展示判据只写这一处，
 * 禁止消费方重复实现：
 * - **isRunningProjection**——占用谓词，全仓「真在跑」唯一出处（G2）：hasRunning /
 *   isStreamingSubagent（stores/subagent）均为本函数的 import wrapper（U2 判据单一化），
 *   托盘计数（useTrayCounts）与「进行中」分桶视图同源消费，不漂移。
 * - **SUBAGENT_DOT_RULES / subagentDotClass**——托盘 subagent 行状态点规则表
 *   （[W2 D8] 自 TrayNativePanel 迁入本判据模块 + 加全集锁）：按 status 分组的
 *   `satisfies Record<SubagentStatus, …>` 键型 = 词表全集，扩值漏配编译红。
 *
 * [HISTORICAL] 2026-09-16 用户裁决托盘两态化：intent 意愿分桶自 UI 退役。原分桶面
 * （SubagentFilterValue / SubagentBucket / DEFAULT_SUBAGENT_FILTER / subagentBucket /
 * filterSubagents / countSubagents，设计 subagent-sidebar-filter §3.4，原设计文档已删除、
 * git 可追溯）随「已收起」视图一并删除——「已收起」不是用户可见状态，托盘不再以第三
 * 状态呈现；已收起记录归入「已结束」桶（已结束 = !isRunningProjection）。同日全链路
 * 清除终态：「已收起」机制已全链路删除——intent 字段自 shared 契约与 subagent-core
 * 执行层一并移除，renderer 不再按它分桶。
 */
import type { SubagentRecord, SubagentStatus } from '@taiji/shared'

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

// ── 托盘 subagent 行状态点规则（[W2 D8] 全集锁；自 TrayNativePanel 迁入）────────
// stopReason 值域在 shared 侧为 string 透传（extension 新增展示值不因类型收窄丢字段），
// 词表锁只能落在 status 两态维度；stopReason 组合的穷尽由下方键域全集断言
// （state-tone-lock.test.ts）+ 组内「兜底行收尾」形态保证。

/** 中断族停因（被动收口：用户取消 / 进程收编 / 宿主重启 / 父级终止）——中性暗档 */
const INTERRUPTED_STOP_REASONS = new Set(['cancelled', 'interrupted', 'interrupted-by-restart', 'interrupted-by-parent'])

interface SubagentDotRule {
  match: (record: SubagentRecord) => boolean
  cls: string
}

/**
 * 状态点规则表（[W2 D8]）：按 status 分组 + `satisfies Record<SubagentStatus, …>`——
 * SubagentStatus 词表扩值而本表漏配新键 = 本行编译红（vue-tsc 承载）。组内顺序即语义
 * （失败红 / 中断灰先于完成绿兜底），find 首中即停：
 * - running 组：W4 死亡纳管态（running + stopReason='failed'）红点；其余 running
 *   组合（在飞）由调用方 spinner 分流，落本函数时走 accent 兜底。
 * - idle 组：failed 红 / 中断族与 reopened 中性暗 / 其余（正常完成收口）绿兜底。
 *   [W2 D8] reopened（已重开待续）原落绿点兜底——语义修正为中性暗（非成功，与
 *   中断族邻近规则同档）。
 */
export const SUBAGENT_DOT_RULES = {
  running: [
    { match: (r) => r.stopReason === 'failed', cls: 'bg-danger' },
  ],
  idle: [
    { match: (r) => r.stopReason === 'failed', cls: 'bg-danger' },
    { match: (r) => r.stopReason !== undefined && INTERRUPTED_STOP_REASONS.has(r.stopReason), cls: 'bg-neutral-dim opacity-50' },
    { match: (r) => r.stopReason === 'reopened', cls: 'bg-neutral-dim opacity-50' },
    { match: () => true, cls: 'bg-success' },
  ],
} satisfies Record<SubagentStatus, readonly SubagentDotRule[]>

/**
 * 状态点类名：首中规则取档，规则表无命中（running 非死亡纳管组合）→ accent 兜底。
 * `SUBAGENT_DOT_RULES[record.status]` 的键表达式类型 = SubagentStatus——词表扩值时
 * 上方 satisfies 漏配新键先行编译红，本索引处不产生第二道检查（单点锁）。
 */
export function subagentDotClass(record: SubagentRecord): string {
  // 词表外 / 缺失 status 兜底中性档（D3r3 验收顺带发现：directive 派发 record 投影字段
  // 缺失时本行 `.find` 抛 TypeError，托盘已结束 tab 整列表不渲染）——不假设 status 恒在词表。
  const rules = SUBAGENT_DOT_RULES[record.status]
  const hit = rules?.find((entry) => entry.match(record))
  return hit ? hit.cls : 'bg-accent'
}
