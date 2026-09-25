/**
 * 内核错误类（msg-pipeline-debloat D4-1，审计候选 16）。
 *
 * 判别形态依据（设计 §3.3 D4 尾注）：本包与消费方（runtime registry）是进程内同包
 * 调用边界——编译期类型可得，instanceof 是最简判别且免词表；与跨进程 WS 边界的
 * 分类码形态（CompactErrorCode）不构成双轨。
 */

/**
 * 「用户主动回收」对挂起 sendChecked waiter 的 reject 错误类。
 *
 * 产生点（delivery.ts）：cancel 终结条目（queued/failed 本地终结 + in-flight 收回确认）
 * 与 drain 全量回收时的 waiter reject。语义：文本已回草稿（V9/V11），条目已被内核
 * 终结——不是投递失败，消费方（registry dispose 错误分级）据 instanceof 判别后
 * 只记日志、不进用户可见错误面。
 *
 * 结构化字段（原文案契约的语义信息转字段，文案漂移不再击穿判别）：
 * - kind：回收方式。'cancelled' = cancel(id) 单条回收；'drained' = drain() 全量回收。
 * - entryId：被回收条目 id（drain 全量回收无单条目指向，undefined）。
 *
 * message 保持历史文案形态（`delivery cancelled: <id>` / `delivery drained`）：
 * 日志与诊断输出字节级不变，判别不再依赖它。
 */
export class DeliveryReclaimError extends Error {
  readonly kind: 'cancelled' | 'drained'
  readonly entryId: string | undefined

  constructor(kind: 'cancelled' | 'drained', entryId?: string) {
    super(kind === 'cancelled' ? `delivery cancelled: ${entryId ?? ''}` : 'delivery drained')
    this.name = 'DeliveryReclaimError'
    this.kind = kind
    this.entryId = entryId
  }
}
