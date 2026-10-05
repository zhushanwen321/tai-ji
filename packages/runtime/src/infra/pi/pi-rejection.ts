/**
 * pi prompt() busy 类确定性拒绝的文案常量与分型（pi1-disposition-chat-flow D5③）。
 *
 * 驻留点契约：本文件是 pi 拒绝文案在仓内的**唯一驻留点**（infra/pi 单点，文案项机器检查
 * `check_pi_type_leak.py` 按此口径——该两条原文在 infra/pi 之外出现即红）。文案是 pi
 * dist 实装的逐字拒绝原文，锚定与漂移检测由 PS-22/PS-23 探针承担
 * （`infra/pi/__tests__/pi-semantics-prompt-rejection.test.ts`：静态直读 dist 断言原文与
 * 分支位置，文案/分支漂移即红——pi 版本 bump 时探针红须同步本文件常量后更新 verifiedWith）。
 *
 * [HISTORICAL] 驻留迁移史：识别函数原在 message-dispatcher（catch 面消费点），错误分类
 * 迁移（session-occupancy-send-closure D6）后落 session-delivery-registry（promptWithBusyRetry
 * 的 catch 面）；抽象层并入（pi1-disposition-chat-flow U3①）再下沉 infra/pi——pi 词汇
 * 合法持有点清单（ADR D5①）中 services 层不留文案驻留。
 */

/** pi prompt() busy 类确定性拒绝原文（语义登记 PS-22，verifiedWith 以 pi-semantics.json 为准；探针锁守卫——manual 压缩窗口拒绝）。 */
export const PI_REJECTION_COMPACTING = 'Cannot submit a prompt while compaction is in progress'

/** pi prompt() busy 类确定性拒绝原文（语义登记 PS-23，verifiedWith 以 pi-semantics.json 为准；探针锁守卫——isStreaming 无 streamingBehavior 拒绝）。 */
export const PI_REJECTION_PROCESSING = 'Agent is already processing'

/** pi busy 类拒绝分型（D6；非 busy 类返回 null → 走普通错误面）。 */
export type PromptRejectionReason = 'compacting' | 'processing'

/**
 * 识别 pi prompt() 的 busy 类确定性拒绝（按错误消息原文 includes）。
 * 逐字保持识别口径——消费方 = session-delivery-registry.promptWithBusyRetry 的 catch 面。
 */
export function classifyPromptRejection(errorMessage: string): PromptRejectionReason | null {
  if (errorMessage.includes(PI_REJECTION_COMPACTING)) return 'compacting'
  if (errorMessage.includes(PI_REJECTION_PROCESSING)) return 'processing'
  return null
}
