/**
 * utils/session-scoped-map.ts —— createSessionScopedMap（DM2）。
 *
 * ADR-0049「Map 分区派」范式在 core 包的落地：per-session 状态统一用 Map<sessionId, T> 分区，
 * 切 sid 切分区，天然隔离，不依赖人记得清空。与 renderer 的 composables/useSessionScopedState
 * （foundation/use-session-scoped-state.ts，Vue 响应式版）语义同源但实现独立：
 * 本工具是 headless 纯 Map 实现（无 Vue 依赖），core 无全局 current sid 概念，
 * 所有操作显式传 sessionId（无需 update/updateFor 区分）。
 *
 * 契约（DM2）：
 * - getOrDefault 惰性 init：每个 sid 的 init() 仅调一次（不存在则建并存）
 * - update 不存在 sid 自动建分区
 * - cleanup 移除分区（session 销毁调，防内存泄漏 ERR4）
 * - 不同 sid 分区互不污染
 */
export interface SessionScopedMap<T> {
  /** 查分区；不存在返回 undefined（不建） */
  get(sessionId: string): T | undefined
  /** 查分区；不存在则 init() 建并存（每 sid 仅 init 一次） */
  getOrDefault(sessionId: string): T
  /** 更新分区（不存在自动建分区） */
  update(sessionId: string, fn: (t: T) => void): void
  /** 移除分区（session 销毁调） */
  cleanup(sessionId: string): void
  has(sessionId: string): boolean
  /** 遍历全部分区键（status-bar 快照同步清空未提及分区用） */
  keys(): Iterable<string>
}

/**
 * 创建 per-session 分区 Map。init 工厂返回的 T 应是可变容器
 * （headless 场景：plain object + 显式 update 触发消费者）。
 */
export function createSessionScopedMap<T>(init: () => T): SessionScopedMap<T> {
  const partitions = new Map<string, T>()

  return {
    get(sessionId: string): T | undefined {
      return partitions.get(sessionId)
    },
    getOrDefault(sessionId: string): T {
      let partition = partitions.get(sessionId)
      if (!partition) {
        partition = init()
        partitions.set(sessionId, partition)
      }
      return partition
    },
    update(sessionId: string, fn: (t: T) => void): void {
      const partition = this.getOrDefault(sessionId)
      fn(partition)
    },
    cleanup(sessionId: string): void {
      partitions.delete(sessionId)
    },
    has(sessionId: string): boolean {
      return partitions.has(sessionId)
    },
    keys(): Iterable<string> {
      return partitions.keys()
    },
  }
}
