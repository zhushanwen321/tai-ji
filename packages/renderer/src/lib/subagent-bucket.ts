/**
 * subagent 判据宿主侧消费锚点（纯函数 re-export + renderer 特有展示 helper）。
 *
 * 职责：判据本体已下沉 @zhushanwen/extension-protocol（subagent-projection/
 * predicates.ts，[dmg-r1-4]），本模块 re-export 供宿主侧消费方（stores/subagent、
 * SubagentTab 等）同源 import，禁止消费方绕过本锚点重复实现：
 * - **isRunningProjection**——占用谓词，全仓「真在跑」唯一出处（G2）：hasRunning /
 *   isStreamingSubagent（stores/subagent）均为本 re-export 的 import wrapper（U2
 *   判据单一化），消费方（subagent 抽屉 tab 等）同源消费，不漂移。
 * - **failureCauseLabel / failureCauseToneClass**——轮收条失败分类展示 helper
 *   （subagent-observability §3.4 u8），SubagentTab 消费：label 判据在 protocol
 *   单点，tone（CSS 类名）是 renderer 特有展示、留在本模块。
 *
 * [容器扩展点统一 §6.6/U9] 托盘 subagent 件已迁插件推 widget 树：原「托盘 subagent 行
 * 状态点规则表」（SUBAGENT_DOT_RULES / subagentDotClass，[W2 D8] 自 TrayNativePanel
 * 迁入）随宿主托盘行退役一并删除——插件侧 widget 树（interface/gui/tray-widget.ts）
 * 与本模块 import 同一 protocol 判据单点（同实现，结构性不漂移）。
 *
 * [HISTORICAL] 2026-09-16 用户裁决托盘两态化：intent 意愿分桶自 UI 退役。原分桶面
 * （SubagentFilterValue / SubagentBucket / DEFAULT_SUBAGENT_FILTER / subagentBucket /
 * filterSubagents / countSubagents，设计 subagent-sidebar-filter §3.4，原设计文档已删除、
 * git 可追溯）随「已收起」视图一并删除——「已收起」不是用户可见状态，托盘不再以第三
 * 状态呈现；已收起记录归入「已结束」桶（已结束 = !isRunningProjection）。同日全链路
 * 清除终态：「已收起」机制已全链路删除——intent 字段自 shared 契约与 subagent-core
 * 执行层一并移除，renderer 不再按它分桶。
 */
import type { FailureCause } from '@taiji/shared'
import { failureCauseLabel, isRunningProjection } from '@zhushanwen/extension-protocol'

// [dmg-r1-4 判据下沉] isRunningProjection / failedRoundOf / failureCauseLabel 的
// 实现单点已下沉 @zhushanwen/extension-protocol（extensions/subagent-projection/
// predicates.ts）——插件侧托盘 widget（subagent-workflow interface/gui/tray-widget.ts）
// 与本模块 import 同一实现，镜像手抄退役。本模块保留宿主侧消费锚点（下方 re-export）
// 与 renderer 特有展示 helper（failureCauseToneClass 的 CSS 类名归 renderer，不进协议层）。

export { failureCauseLabel, isRunningProjection }

/**
 * 占用谓词 isRunningProjection 的宿主侧消费纪律（判据本体在 protocol
 * subagent-projection/predicates.ts——G2「正在跑」严格口径：`status === 'running' &&
 * stopReason === undefined`，[U6] 判据终态化）：
 * - 全仓「真在跑」唯一出处：hasRunning / isStreamingSubagent（stores/subagent）
 *   均为上方 re-export 的 import wrapper（U2 判据单一化），消费方同源消费不漂移。
 * - [B3] 全集覆盖检查（adversarial-review-fixes §3.3 B3）：shared 扩
 *   SubagentStatus 枚举时，新「进行中类」值对谓词的归属必须显式评估——判据直读
 *   status，新值默认落 false（安全方向）；词表纪律归 shared 侧编译锁与本包
 *   subagent-bucket.test 的覆盖矩阵，插件侧托盘 widget 消费同一实现，同批生效。
 */

// ── 轮收条失败分类展示 helper（subagent-observability §3.4 u8）────────────────
// SubagentTab 标题栏的展示判据（label 判据 protocol 单点、tone 归本模块，消费方经
// 本模块同源 import，防重复实现漂移）。
// 原与托盘行共用的消费面已随 §6.6/U9 托盘件迁移收窄到抽屉 tab 单消费方。

/**
 * 失败分类展示词（`"<class>.<kind>"` 点拼——与 run 终局 failedMembers[].cause 的
 * 序列化形态同形，原文 kebab-case 对齐停因词展示决策 U8a）：判据本体在 protocol
 * subagent-projection/predicates.ts，上方 re-export。
 */

/**
 * 失败分类展示 tone（红点判据同源中性/失败二分）：user.cancelled（用户主动中止，
 * 失败判据归中性档的同源语义）→ 中性 dim；其余失败分类 → danger。
 */
export function failureCauseToneClass(failure: FailureCause): string {
  // user.cancelled 判据内联（原私有 isUserCancelledCause 随托盘行退役删除——判据语义不变：
  // class=user 且 kind=cancelled，与 HEAD 版唯一判据点实现等价）
  return failure.class === 'user' && failure.kind === 'cancelled'
    ? 'text-neutral-dim opacity-70'
    : 'text-danger'
}
