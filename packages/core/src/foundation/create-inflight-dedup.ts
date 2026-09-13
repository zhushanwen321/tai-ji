/**
 * createInflightDedup —— in-flight 去重共享原语（「Map + Promise 复用」模式工厂）。
 *
 * 【登记】D9「收编为共享原语」产物（docs/architecture/state-truth-sync-architecture.md §3.3 D9），
 * 约束 C-data-18 enforcement 载体：新增/修改「同 key 并发异步操作去重」时**禁止手写**
 * Map<key, Promise> + settle 清理的同构实现，一律组装本 factory（review-arch-boundary
 * 审查项）。收编前 7 处同构实现（迁移见 impl-plan U7b/U7c）：core subscription-state、
 * renderer useCommandSync / useCompactQueue / useBackgroundTasks / useGenStats /
 * useContextUsage / useProjectSkills。
 *
 * 全族不变量（factory 内建，调用方无需自实现）：
 * 1. 同 key 并发 run 共享同一 entry（fn 仅首次发起时执行，复用者拿到同一 promise）
 * 2. settle 即清：成功/失败都从表删条目（失败可重试，不残留死 promise）
 * 3. 引用比对防误删：条目被 delete/clear 后同 key 又有新 run 覆盖时，旧 promise settle
 *    只清「仍是自己」的槽位——先发起的慢请求 settle 不误删后发起的新 entry（收编前
 *    useCommandSync / useGenStats / useContextUsage / useBackgroundTasks 四处同款比对形态）
 * 4. settle 清理链不产生 unhandled rejection（then 双分支接管，见 run 内注释）
 *
 * 典型用法：
 * - per-key 去重（sid → RPC）：`const dedup = createInflightDedup<Reply>()`；
 *   `const { promise } = dedup.run(sid, () => api.fetch(sid))`
 * - entry 附带元数据（发起时刻簿记，如 useGenStats/useContextUsage 的 seqAtIssue——
 *   RPC 发起后分区被更新 live 帧覆盖则弃写）：
 *   `const dedup = createInflightDedup<Reply, { seqAtIssue: number }>()`；
 *   `const entry = dedup.run(sid, () => api.fetch(sid), { seqAtIssue: seq })`；
 *   `entry.promise.then(reply => apply(sid, reply, entry.meta.seqAtIssue))`。
 *   meta 仅首次发起时捕获：复用者共享**发起时刻**的值——按 attach 时刻捕获会让发起后
 *   落地过 live 帧的分区被陈旧 reply 回滚（useContextUsage 收编前注释的教训）。
 * - 单键退化形态（全局唯一 in-flight 变量，如 useProjectSkills 的 globalInFlight）：
 *   固定 key 常量 `dedup.run(SINGLE_KEY, fn)`——同 key 去重语义自然退化为单变量形态。
 *
 * dispose/clear 面：delete(key) / keys()（快照副本，供前缀匹配批量失效，如
 * subscription-state 的 invalidateSubscription）/ clear()（全清，供 dispose 钩子与
 * 测试隔离）。被清条目的 settle 回调经引用比对 no-op，无副作用。
 */

/** in-flight 去重表条目：promise 本体 + 发起时刻元数据。 */
export interface InflightEntry<T, M> {
  /** 在途异步操作本体。各调用方各自 attach then 消费结果（复用者不重复发起）。 */
  readonly promise: Promise<T>
  /** 发起时刻附着的元数据（仅首次发起捕获，并发复用者共享同一份）。 */
  readonly meta: M
}

/** in-flight 去重工厂实例 API。 */
export interface InflightDedup<T, M> {
  /**
   * 发起或复用 key 的在途操作：同 key 已有在途 entry 则直接返回（fn 不执行），
   * 否则执行 fn 登记新 entry。
   *
   * 时序契约：settle 清理回调在本函数内注册，先于任何调用方 attach 的 then——
   * 调用方 settle 回调执行时条目已清理（可安全再 run 发起新一轮）。
   * fn 同步抛：不登记条目，异常向上传播给发起者（无半登记残留）。
   *
   * @param key 去重键（含语义差异的操作必须编入 key，如 subscription-state 的
   *   `sid:fromSeq`——gap backfill 与 initial subscribe 不得互吞）
   * @param fn 异步操作工厂（仅首次发起时执行一次）
   * @param meta 发起时刻元数据（M 为具体类型时必传；M=void 时省略）
   */
  run(
    key: string,
    fn: () => Promise<T>,
    ...meta: M extends void ? [meta?: undefined] : [meta: M]
  ): InflightEntry<T, M>
  /** key 是否有在途条目（如 useBackgroundTasks 的抑制释放判定）。 */
  has(key: string): boolean
  /** 删除单条（在途 promise 不受影响，其 settle 清理经引用比对 no-op）。 */
  delete(key: string): void
  /** key 快照副本（迭代中删除安全；供前缀匹配批量失效，如 session 失效清 `sid:*`）。 */
  keys(): string[]
  /** 清空全部条目（dispose 钩子 / 测试隔离用）。 */
  clear(): void
}

/**
 * in-flight 去重工厂。
 *
 * @typeParam T 异步操作的 resolve 值类型
 * @typeParam M entry 附带元数据类型（默认 void = 无元数据；声明具体类型后 run 的
 *   meta 参数变为必传——seqAtIssue 类簿记漏传会编译期报错而非运行时 undefined）
 */
export function createInflightDedup<T, M = void>(): InflightDedup<T, M> {
  const entries = new Map<string, InflightEntry<T, M>>()

  function run(
    key: string,
    fn: () => Promise<T>,
    ...meta: M extends void ? [meta?: undefined] : [meta: M]
  ): InflightEntry<T, M> {
    const existing = entries.get(key)
    if (existing) return existing

    const promise = fn()
    // 条件元组 rest 在泛型未实例化时无法证明与 M 兼容，此处断言是本模块唯一的
    // 类型收窄点（运行时 meta[0] 的真实类型由签名保证）
    const entry: InflightEntry<T, M> = { promise, meta: meta[0] as M }
    entries.set(key, entry)

    // settle 即清 + 引用比对防误删：仅当 Map 中仍是自己的 entry 才删除。
    // then 双分支而非 .finally()：finally 返回的新 promise 会镜像 rejection，
    // void 丢弃即产生 unhandled rejection；双分支等价且 reject 分支已接管
    // （useGenStats/useContextUsage 收编前的同款教训）。
    const clearOnSettle = (): void => {
      if (entries.get(key) === entry) entries.delete(key)
    }
    void promise.then(clearOnSettle, clearOnSettle)

    return entry
  }

  return {
    run,
    has: (key: string): boolean => entries.has(key),
    delete: (key: string): void => {
      entries.delete(key)
    },
    keys: (): string[] => [...entries.keys()],
    clear: (): void => {
      entries.clear()
    },
  }
}
