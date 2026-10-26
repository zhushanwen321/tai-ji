/**
 * subagent 判据 SSOT 模块（纯函数）。
 *
 * 职责：导出占用派生视图判据与托盘 subagent 行状态点规则，判定/展示判据只写这一处，
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
 *
 * [subagent-observability §3.3.3②⑥ u8] 失败红点判据替换：红 = `lastRound.failure`
 * 非空且非 user.cancelled（FailureCause 存在即失败轮——同时覆盖 error 停因与 aborted +
 * harness/engine 失败分型两形态），旧判据 `stopReason === 'failed'` 降为迁移期回落分支
 * （旧推断存储值 + runtime deriveClosedDisplay 注入族 legacy closed 失败形态红点保持，
 * 退役条件绑定见 isFailedRound 注释）；中性暗 = user.cancelled / 宿主中断族停因 /
 * reopened / 被接管（promptDisposition=handled）；绿兜底 = 其余（引擎 stop 无失败分类
 * → 派生「正常收尾」）。伴生展示 helper（failureCauseLabel / failureCauseToneClass）
 * 同住本模块——判定与展示判据只写这一处，SubagentTab 与任务托盘共用，禁止消费方
 * 重复实现。
 */
import type { FailureCause, SubagentRecord, SubagentStatus } from '@taiji/shared'

/**
 * 占用谓词（G2「正在跑」严格口径 SSOT——two-state-convergence D1/D2；[U6] 判据
 * 终态化：`status === 'running' && stopReason === undefined`（D5 R3 终态判据，§3.1
 * isOccupied 本体）。U1 桥接判据的 result 子句已删——U4 翻边后轮终权威词
 * = idle（status 子句直接排除）。
 * [subagent-observability §3.3.3] 轮收条事实化后 stopReason 子句的信号语义收编：
 * 占用信号 = 「轮收条已写 = 本轮不在途」的等价信号——轮始清点族（markRoundStarted /
 * revive 格）在翻 running 时清 stopReason，markRoundIdle 轮终写入停因，信号仍由
 * stopReason 字段承载、判据表达式不变（mobile 壳镜像读不到新字段的前提下保持等价，
 * §3.3.3⑦ 前提显式登记：禁止把本信号换轨到移动壳读不到的新字段表达）；原「W4 死亡
 * 纳管态排除」（running + stopReason='failed'，[U5/D4] adoptEngineDeath 写点）随该
 * 写点退役删除（判定链事实化后引擎死亡走正常轮终），不再单列。在途期上轮停因不可见
 * = 显式裁决的代价（§3.1 注释）。
 * 全仓「真在跑」判据唯一出处：hasRunning / isStreamingSubagent（stores/subagent）
 * 均为本函数的 import wrapper（U2 判据单一化），托盘计数（useTrayCounts）与「进行中」
 * 分桶视图同源消费，不漂移。
 * [B3] 全集覆盖检查（adversarial-review-fixes §3.3 B3；[U6] 后全集 = 两态）：shared 扩
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

/** 中断族停因（被动收尾：用户取消 / 进程收编 / 宿主重启 / 父级终止）——中性暗档。
 *  [subagent-observability §3.3.3②] 值域同批核对结论：维持 4 值——宿主中断族三值
 *  （interrupted / interrupted-by-restart / interrupted-by-parent，core NEW_STOP_REASONS
 *  子集）+ 旧展示值 cancelled（runtime deriveClosedDisplay 注入族 legacy closed 中止
 *  形态）；新词表不新增 cancelled 停因值（「cancelled 族」是 FailureCause user.cancelled
 *  分型不是停因值，防第二套中止词表——core record-types.ts 三层词表映射裁决）。 */
const INTERRUPTED_STOP_REASONS = new Set(['cancelled', 'interrupted', 'interrupted-by-restart', 'interrupted-by-parent'])

interface SubagentDotRule {
  match: (record: SubagentRecord) => boolean
  cls: string
}

/** user.cancelled 判据（用户主动中止——失败红 / 中性暗 / tone 三处共用的唯一判据点）。 */
function isUserCancelledCause(failure: FailureCause): boolean {
  return failure.class === 'user' && failure.kind === 'cancelled'
}

/**
 * 判失败轮（红点，subagent-observability §3.3.3②）：lastRound.failure 非空且非
 * user.cancelled——FailureCause 存在即失败轮（同时覆盖 error 停因与 aborted + harness/
 * engine 失败分型两形态）；user.cancelled 是用户主动中止非失败，归中性档。
 * 迁移期回落（§3.4 双写同款「先读事实字段、缺省回落旧值」）：failure 缺省回落旧
 * `stopReason === 'failed'`——旧推断存储值（迁移完删旧值）+ runtime deriveClosedDisplay
 * 注入族（legacy closed record 的失败展示值同判红，红点迁移前后保持，§3.3.3⑥）。
 * 退役条件（绑定登记）：迁移完删旧值 + deriveClosedDisplay 退役管道删除时，本回落
 * 分支同批删除。
 */
function isFailedRound(record: SubagentRecord): boolean {
  const failure = record.lastRound?.failure
  if (failure !== undefined) {
    return !isUserCancelledCause(failure)
  }
  return record.stopReason === 'failed'
}

/** 判中性暗轮（subagent-observability §3.3.3②）：被接管（promptDisposition=handled——
 *  引擎未执行，无停因无成败）/ user.cancelled（用户主动中止）/ reopened（已重开待续）/
 *  宿主中断族停因（INTERRUPTED_STOP_REASONS）。 */
function isNeutralRound(record: SubagentRecord): boolean {
  if (record.lastRound?.promptDisposition === 'handled') return true
  const failure = record.lastRound?.failure
  if (failure !== undefined && isUserCancelledCause(failure)) return true
  if (record.stopReason === 'reopened') return true
  return record.stopReason !== undefined && INTERRUPTED_STOP_REASONS.has(record.stopReason)
}

/**
 * 状态点规则表（[W2 D8]）：按 status 分组 + `satisfies Record<SubagentStatus, …>`——
 * SubagentStatus 词表扩值而本表漏配新键 = 本行编译红（vue-tsc 承载）。组内顺序即语义
 * （失败红 / 中性暗先于完成绿兜底），find 首中即停：
 * - running 组：失败轮红点（isFailedRound，四形态见其注释）；其余 running
 *   组合（在途）由调用方 spinner 分流，落本函数时走 accent 兜底。
 * - idle 组：失败红 / 中性暗（被接管 / user.cancelled / 中断族 / reopened）/ 绿兜底。
 *   [subagent-observability §3.3.3②] 绿兜底 = 其余（引擎 stop 无失败分类 → 派生
 *   「正常收尾」）。[W2 D8] reopened（已重开待续）原落绿点兜底——语义修正为中性暗
 *   （非成功，与中断族邻近规则同档）。
 */
export const SUBAGENT_DOT_RULES = {
  running: [
    { match: isFailedRound, cls: 'bg-danger' },
  ],
  idle: [
    { match: isFailedRound, cls: 'bg-danger' },
    { match: isNeutralRound, cls: 'bg-neutral-dim opacity-50' },
    { match: () => true, cls: 'bg-success' },
  ],
} satisfies Record<SubagentStatus, readonly SubagentDotRule[]>

/**
 * 状态点类名：首中规则取档，规则表无命中（running 非失败轮组合——在途由调用方
 * spinner 分流）→ accent 兜底。
 * `SUBAGENT_DOT_RULES[record.status]` 的键表达式类型 = SubagentStatus——词表扩值时
 * 上方 satisfies 漏配新键先行编译红，本索引处不产生第二道检查（单点锁）。
 */
export function subagentDotClass(record: SubagentRecord): string {
  // 词表外 / 缺失 status 兜底中性档（D3r3 验收顺带发现：directive 派发 record 派生视图字段
  // 缺失时本行 `.find` 抛 TypeError，托盘已结束 tab 整列表不渲染）——不假设 status 恒在词表。
  const rules = SUBAGENT_DOT_RULES[record.status]
  const hit = rules?.find((entry) => entry.match(record))
  return hit ? hit.cls : 'bg-accent'
}

// ── 轮收条失败分类展示 helper（subagent-observability §3.4 u8）────────────────
// SubagentTab 标题栏与任务托盘行共用的展示判据（判定/展示判据只写本模块，防消费方
// 重复实现漂移——头注释同款约束）。

/**
 * 失败分类展示词：`"<class>.<kind>"` 点拼（如 provider.rate_limited）——与 run 终局
 * failedMembers[].cause 的序列化形态同形（§3.3.8 走查补），原文 kebab-case 对齐停因词
 * 展示决策（U8a）。
 */
export function failureCauseLabel(failure: FailureCause): string {
  return `${failure.class}.${failure.kind}`
}

/**
 * 失败分类展示 tone（红点判据同源中性/失败二分）：user.cancelled（用户主动中止，
 * isFailedRound 归中性档的同源语义）→ 中性 dim；其余失败分类 → danger。
 */
export function failureCauseToneClass(failure: FailureCause): string {
  return isUserCancelledCause(failure)
    ? 'text-neutral-dim opacity-70'
    : 'text-danger'
}
