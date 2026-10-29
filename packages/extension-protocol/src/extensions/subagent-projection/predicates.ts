/**
 * subagent 投影判据（占用谓词 / 失败轮 / 失败分类展示词）——插件侧托盘 widget 与
 * 宿主 renderer 的共享判据单点（dmg-r1-4 判据下沉：此前两侧手抄镜像、靠「两侧单测
 * 各自锚定」的人工纪律同步，无对拍）。
 *
 * 契约两端（同判据同实现，结构性不漂移）：
 *   - 插件侧：@zhushanwen/pi-subagent-workflow interface/gui/tray-widget.ts（托盘
 *     widget 树的行状态映射 / 分桶 / meta 状态点）；
 *   - 宿主侧：packages/renderer lib/subagent-bucket.ts（badge 计数 / streaming 判定
 *     / SubagentTab 失败展示），经 re-export 同源消费。
 *
 * 入参类型 = 两侧 SubagentRecord 的共持形状子集（@taiji/shared 与
 * @zhushanwen/subagent-core 各持一份 record 类型，本包零运行时依赖、不 import 任何
 * 一侧词表）；status/stopReason 词表纪律（扩值评估、编译锁）仍归两侧 record 类型
 * 所在包，本模块只锚判据逻辑本体。
 */

/**
 * 失败分类的最小消费形状（两侧 FailureCause 的共持子集）：判据只读 class/kind 二
 * 字段。宽入参是刻意的——sdk 判别联合（class×kind 矩阵）对两侧各自持有，本包不
 * 复制词表防漂移。
 */
export interface SubagentFailureLike { // oe-exempt:20261029:framework:SDK 判据入参契约——两侧 FailureCause 共持子集（宽入参防词表漂移），消费方结构类型匹配、永不 implements
  class: string
  kind: string
}

/** 三判据消费的最小字段面（两侧 SubagentRecord 形状子集；字段语义见判据注释）。 */
export interface SubagentProjectionRecord { // oe-exempt:20261029:framework:SDK 判据入参契约——两侧 SubagentRecord 形状子集（零运行时依赖、不 import 两侧词表），消费方结构类型匹配、永不 implements
  status: string
  stopReason?: string
  lastRound?: { failure?: SubagentFailureLike }
}

/**
 * 占用谓词（「正在跑」严格口径）：running 且无轮收条停因（「轮收条已写 = 本轮不在途」
 * 的等价信号——轮始清点族在翻 running 时清 stopReason，markRoundIdle 轮终写入停因，
 * 信号由 stopReason 字段承载）。带停因的 running（轮收条残留）不算占用。
 */
export function isRunningProjection(record: SubagentProjectionRecord): boolean {
  return record.status === 'running' && record.stopReason === undefined
}

/**
 * 失败轮判据：lastRound.failure 存在且非 user.cancelled（FailureCause 存在即失败轮；
 * user.cancelled 是用户主动中止非失败）。返回该 lastRound 供展示消费（泛型保留两侧
 * 各自的 lastRound 载荷类型）；非失败轮返回 undefined。
 */
export function failedRoundOf<T extends SubagentProjectionRecord>(record: T): T['lastRound'] | undefined {
  const failure = record.lastRound?.failure
  if (failure === undefined) return undefined
  if (failure.class === 'user' && failure.kind === 'cancelled') return undefined
  return record.lastRound
}

/**
 * 失败分类展示词：`"<class>.<kind>"` 点拼（与 run 终局 failedMembers[].cause 的
 * 序列化形态同形）。
 */
export function failureCauseLabel(failure: SubagentFailureLike): string {
  return `${failure.class}.${failure.kind}`
}
