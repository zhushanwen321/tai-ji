/**
 * useSessionScopedState —— per-session 状态隔离通用工厂（ADR-0049 W1）。
 *
 * core 定位：本文件是 @xyz-agent/core 平台无关内核（headless）的 W1 基建，
 * 从 renderer composables/ 原样迁移（含 triggerSessionCleanups 注册机制），
 * 供 core 内后续迁移的 composable/store 使用。renderer 侧 composables/useSessionScopedState.ts
 * 改为 re-export 本模块（迁移过渡期旧 Composer 未删，旧调用方零破坏）。
 *
 * 设计动机：codebase 存在两套并行的 session 隔离范式（Map 分区派 vs watch 清理派），
 * watch 清理派脆弱（切 session 忘清空字段就泄漏，useExtensionUI bug 即此模式失效）。
 * 本工厂把 Map 分区派抽象为通用 composable，新 per-session 状态用它天然隔离，
 * 从结构上防复发。详见 docs/adr/0049-session-isolation-map-partition.md。
 *
 * 契约：
 * - 内部维护 per-instance `Map<string, T>`（每次 useSessionScopedState 调用建自己的 Map）
 * - `current` computed：按 `sid.value` 查 Map 分区；新 sid 惰性 init（init() 仅调一次/sid）；
 *   null sid 返回 `init()` 默认实例但不写入 Map（防 null key 污染真实分区）
 * - `update(updater)`：操作当前 sid 分区（先确保分区存在）；null sid 时 no-op
 *   （null current 是每次新建的临时默认实例，对其修改不持久，避免污染任何真实分区）
 * - `updateFor(targetSid, updater)`：显式指定 sid 分区操作（不读 sid.value 实时值）。
 *   用于 WS handler 捕获订阅时 sid，防切 sid 后旧消息写入新分区（M1 竞态修复）
 * - `cleanup(sid)`：从 Map 移除指定 sid 分区（下次访问重新 init）
 * - 切 sid 不丢旧数据（Map 保留），切回恢复
 *
 * 例外登记（ADR-0049 §例外清单）：不采用本工厂的 per-session 状态（全局 sid
 * 协调器 / Pinia factory 单例 / shallowRef 容器等例外类）必须逐个在该 ADR 的
 * 例外清单登记「偏离点 + 判据 + 审批来源」，新增例外 = 同批登记，review 按此核对。
 *
 * **响应式契约（重要）**：init 工厂**必须返回 reactive 容器**（`reactive({...})` / `reactive([])`），
 * 不能是 plain object/array。原因：update/updateFor 内 mutate 分区对象，下游 computed
 * （如 `computed(() => state.current.value.find(...))`）需要在 reactive 容器上建立依赖才能
 * 在 mutate 时失效重算。plain object 的 mutate 不触发任何下游。W2 useExtensionUI 首次发现此契约。
 *
 * cleanup 注册机制（模块级，供 useSidebar.deleteSession 统一编排 session 销毁）：
 * - `registerSessionCleanup(fn)`：加入模块级 Set，返回反注册函数
 * - `triggerSessionCleanups(sid)`：遍历 Set 调所有 fn(sid)
 * - useSessionScopedState 实例 setup 时自动注册自己的 cleanup（删 Map 分区），
 *   onScopeDisposed 时反注册（防卸载后还被 trigger 调用）
 */
import { computed, onScopeDispose, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'

/**
 * 模块级 cleanup 注册表（Set 防同 fn 重复注册）。
 * 所有 useSessionScopedState 实例 + 外部 registerSessionCleanup 调用共享。
 * triggerSessionCleanups 遍历此 Set 调所有 fn(sid)。
 */
const sessionCleanupRegistry = new Set<(sid: string) => void>()

/**
 * 注册 session 级 cleanup 函数。triggerSessionCleanups(sid) 时遍历调用。
 * 返回反注册函数（调则从注册表移除该 fn）。
 *
 * 用途：session 销毁时统一清理各 composable 的 per-session 分区，防 Map 积累已销毁
 * session 条目导致内存泄漏（ADR-0049 Consequences 负面项「内存管理」的解法）。
 *
 * @param fn 接收 sid，执行该 session 的清理逻辑
 * @returns 反注册函数（scope dispose 时调，或由注册者显式调）
 */
export function registerSessionCleanup(fn: (sid: string) => void): () => void {
  sessionCleanupRegistry.add(fn)
  return () => {
    sessionCleanupRegistry.delete(fn)
  }
}

/**
 * 触发指定 session 的所有 cleanup（遍历注册表调 fn(sid)）。
 *
 * 调用点：useSidebar.deleteSession(id) 编排 session 销毁时调本函数，
 * 各 composable 注册的 cleanup 各自清理自己的 Map 分区。
 *
 * @param sid 被销毁的 session id
 */
export function triggerSessionCleanups(sid: string): void {
  // 复制一份遍历，防 fn 内部触发 register/unregister 改变 Set 大小导致迭代异常
  for (const fn of [...sessionCleanupRegistry]) {
    try {
      fn(sid)
    } catch (e) {
      // 单个 cleanup 失败不阻断其他 cleanup（session 销毁不应因一个 composable
      // 清理异常而部分泄漏）。记录日志便于诊断，不重抛。
      console.warn('[useSessionScopedState] session cleanup failed for sid=', sid, e)
    }
  }
}

/**
 * 测试专用：清空 sessionCleanupRegistry。生产代码禁止调用。
 * 用途：vitest 用例间隔离，防上例的 cleanup 注册残留污染下例（如未包 effectScope 的 useExtensionUI 测试）。
 */
export function __clearSessionCleanupRegistryForTest(): void {
  sessionCleanupRegistry.clear()
}

/**
 * per-session 状态隔离工厂。
 *
 * @param sid 响应式 session id（Ref<string|null>），null 表示无活跃 session
 * @param init 新 session 的状态工厂（惰性调用，每 sid 仅一次）
 * @returns { current, update, updateFor, cleanup }
 *   - current: 当前 sid 分区的 computed（null 返回默认实例不写 Map）
 *   - update(updater): 操作当前 sid 分区（读 sid.value 实时值，用于 UI 操作）
 *   - updateFor(targetSid, updater): 显式指定 sid 分区（用于 WS handler 捕获订阅时 sid，防 M1 竞态）
 *   - cleanup(sid): 移除指定 sid 分区
 */
export function useSessionScopedState<T>(
  sid: Ref<string | null>,
  init: () => T,
): {
  current: ComputedRef<T>
  update: (updater: (state: T) => void) => void
  updateFor: (targetSid: string, updater: (state: T) => void) => void
  cleanup: (sid: string) => void
  /** 测试钩子：清空所有分区（bump version 触发 current 重算）。生产代码禁止调用。 */
  _clearAllForTest: () => void
} {
  // per-instance Map：每个 useSessionScopedState 调用建自己的分区表
  const partitions = new Map<string, T>()

  // 分区结构版本号：Map 增删时 bump，让 current computed 感知非响应式 Map 的变化。
  // 必要性：triggerSessionCleanups → cleanup(sid) 删除 Map 分区后，current computed 需重算
  // 才能重新 init（W5 AC-8 契约）。Map 本身非响应式，computed 只依赖 sid.value 会命中缓存，
  // 故用 version ref 作为 computed 的额外依赖，cleanup 时 bump 触发失效。
  const version = ref(0)

  /** 按 sid 查分区，不存在则惰性 init 并写入 */
  function getOrCreatePartition(id: string): T {
    let p = partitions.get(id)
    if (!p) {
      p = init()
      partitions.set(id, p)
    }
    return p
  }

  /** cleanup 该实例 Map 中的指定 sid 分区（bump version 让 current computed 失效重算） */
  function cleanup(id: string): void {
    partitions.delete(id)
    version.value += 1
  }

  // current computed：按 sid.value 查分区
  // null sid 时返回 init() 默认实例但不写入 Map——防 null 作为 key 污染分区表，
  // 且对 null 实例的修改不持久（每次 computed 重算新建），不泄漏到真实 session。
  // computed 缓存特性保证同一次 null 期间多次访问拿到同一实例（init 仅在重算时调）。
  // current computed：按 sid.value 查分区。
  // 依赖 version：cleanup 移除分区后 bump version，computed 失效，下次访问重算 → 重新 init。
  // null sid 时返回 init() 默认实例但不写入 Map——防 null 作为 key 污染分区表，
  // 且对 null 实例的修改不持久（每次 computed 重算新建），不泄漏到真实 session。
  // computed 缓存特性保证同一次 null 期间多次访问拿到同一实例（init 仅在重算时调）。
  const current = computed<T>(() => {
    // 读 version 建立响应式依赖（cleanup 时 bump 触发本 computed 失效）
    void version.value
    const id = sid.value
    if (id === null) {
      return init()
    }
    return getOrCreatePartition(id)
  })

  /**
   * update(updater)：操作当前 sid 分区。
   * null sid 时 no-op——null current 是临时默认实例，对其修改不持久，
   * 且写入它会污染（下次 current 重算又新建），语义无意义故跳过。
   */
  function update(updater: (state: T) => void): void {
    const id = sid.value
    if (id === null) {
      return
    }
    const partition = getOrCreatePartition(id)
    updater(partition)
  }

  /**
   * updateFor(sid, updater)：显式指定 sid 分区操作（不读 sid.value 实时值）。
   *
   * 用途（M1 竞态修复）：WS 事件 handler 闭包捕获订阅时的 sid，调 updateFor(capturedSid, ...)
   * 写入「消息所属 sid」的分区。即使 session 切换后退订是异步的（watch flush:pre），
   * 旧 sid 的迟到消息也只会写入旧 sid 分区，不污染新 sid 分区——从结构上消除竞态。
   *
   * 与 update 的区别：update 读 sid.value（当前值），用于 UI 操作（用户主动操作当前 session）；
   * updateFor 读参数 sid（订阅时捕获值），用于 WS handler（消息属于固定 sid）。
   *
   * @param targetSid 目标分区 sid（由 handler 闭包捕获，不随当前 sid 变化）
   * @param updater 分区操作函数
   */
  function updateFor(targetSid: string, updater: (state: T) => void): void {
    const partition = getOrCreatePartition(targetSid)
    updater(partition)
  }

  // 注册实例 cleanup 到模块级注册表，scope dispose 时反注册。
  // 防 composable 卸载后 triggerSessionCleanups 仍调用其 cleanup（操作已废弃 Map 无意义，
  // 且若未来 Map 持有需要释放的资源会造成 use-after-unmount）。
  const unregister = registerSessionCleanup(cleanup)
  onScopeDispose(() => {
    unregister()
  })

  return {
    current,
    update,
    updateFor,
    cleanup,
    _clearAllForTest: () => {
      partitions.clear()
      version.value += 1
    },
  }
}
