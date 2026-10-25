/**
 * subagent 判据 SSOT 模块（纯函数）。
 *
 * 职责：导出占用派生视图判据与轮收条失败分类展示 helper，判定/展示判据只写这一处，
 * 禁止消费方重复实现：
 * - **isRunningProjection**——占用谓词，全仓「真在跑」唯一出处（G2）：hasRunning /
 *   isStreamingSubagent（stores/subagent）均为本函数的 import wrapper（U2 判据单一化），
 *   消费方（subagent 抽屉 tab 等）同源消费，不漂移。
 * - **failureCauseLabel / failureCauseToneClass**——轮收条失败分类展示 helper
 *   （subagent-observability §3.4 u8），SubagentTab 消费。
 *
 * [容器扩展点统一 §6.6/U9] 托盘 subagent 件已迁插件推 widget 树：原「托盘 subagent 行
 * 状态点规则表」（SUBAGENT_DOT_RULES / subagentDotClass，[W2 D8] 自 TrayNativePanel
 * 迁入）随宿主托盘行退役一并删除——插件侧 widget 树的行 status 原语承载状态表达，
 * 判定镜像在扩展侧 interface/gui/tray-widget.ts（两侧判据同形不同源，各自单测锚定）。
 *
 * [HISTORICAL] 2026-09-16 用户裁决托盘两态化：intent 意愿分桶自 UI 退役。原分桶面
 * （SubagentFilterValue / SubagentBucket / DEFAULT_SUBAGENT_FILTER / subagentBucket /
 * filterSubagents / countSubagents，设计 subagent-sidebar-filter §3.4，原设计文档已删除、
 * git 可追溯）随「已收起」视图一并删除——「已收起」不是用户可见状态，托盘不再以第三
 * 状态呈现；已收起记录归入「已结束」桶（已结束 = !isRunningProjection）。同日全链路
 * 清除终态：「已收起」机制已全链路删除——intent 字段自 shared 契约与 subagent-core
 * 执行层一并移除，renderer 不再按它分桶。
 */
import type { FailureCause, SubagentRecord } from '@taiji/shared'

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
 * 均为本函数的 import wrapper（U2 判据单一化），消费方同源消费，不漂移。
 * [B3] 全集覆盖检查（adversarial-review-fixes §3.3 B3；[U6] 后全集 = 两态）：shared 扩
 * SubagentStatus 枚举时，新「进行中类」值对本谓词的归属必须显式评估——本函数直读
 * status，新值默认落 false（安全方向）；宿主托盘行的同款判定已随件迁插件侧
 * （interface/gui/tray-widget.ts 镜像），扩值评估两侧同批。
 */
export function isRunningProjection(record: SubagentRecord): boolean {
  return record.status === 'running' && record.stopReason === undefined
}

// ── 轮收条失败分类展示 helper（subagent-observability §3.4 u8）────────────────
// SubagentTab 标题栏的展示判据（判定/展示判据只写本模块，防消费方重复实现漂移）。
// 原与托盘行共用的消费面已随 §6.6/U9 托盘件迁移收窄到抽屉 tab 单消费方。

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
 * 失败判据归中性档的同源语义）→ 中性 dim；其余失败分类 → danger。
 */
export function failureCauseToneClass(failure: FailureCause): string {
  return failure.class === 'user' && failure.kind === 'cancelled'
    ? 'text-neutral-dim opacity-70'
    : 'text-danger'
}
