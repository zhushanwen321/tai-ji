/**
 * useBackgroundTaskBucketFilter —— 后台命令列表的三桶筛选状态 per-session 分区
 *（docs/architecture/background-task-sidebar-view.md §3.3 D10②，u-renderer-store）。
 *
 * 分区语义（对齐 useSubagentBucketFilter 范式，subagent MF-A 同款死锁级坑的防回归锚）：
 * - **标量必须对象包装且必须 reactive 容器**（`reactive({ value })`）——useSessionScopedState
 *   的响应式契约：分区会被 update/updateFor 原地 mutate，下游 computed 需在 reactive 容器
 *   上建立依赖才能失效重算；plain object 的 mutate 不触发任何下游（筛选点击后列表不刷新）。
 * - 挂载期内跨 session 切换分区记忆（Map 保留，各 session 独立记住自己的筛选选择）；
 *   切 tab 卸载组件即实例销毁、分区随之丢弃——重开 tab 重置默认「运行中」。不跨启动记忆
 *  （运行态时间敏感，重启后旧选择大概率过期，D10②）。
 * - 组件纯读（current + setFilter），禁 watch(sessionId) 手动清空（ADR-0049）。
 */
import { computed, reactive } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import type { BackgroundTaskFilterValue } from '@/lib/background-task-bucket'

/** 默认筛选桶：「运行中」（高频关注点即默认视图，D10② 定案）。 */
export const BACKGROUND_TASK_DEFAULT_FILTER: BackgroundTaskFilterValue = 'active'

/** 分区容器：标量必须对象包装（工厂响应式契约，plain object 是已知回归坑）。 */
interface BackgroundTaskFilterPartition {
  value: BackgroundTaskFilterValue
}

export interface UseBackgroundTaskBucketFilterReturn {
  /** 当前筛选值（reactive 容器驱动，setFilter 后立即失效重算）。 */
  current: ComputedRef<BackgroundTaskFilterValue>
  /** 设置筛选值（UI 操作：FilterBar 点击；写当前 sid 分区，null sid no-op）。 */
  setFilter: (value: BackgroundTaskFilterValue) => void
}

/**
 * 三桶筛选状态根。必须在组件 setup 同步调用（内部依赖实例 scope）。
 *
 * @param sessionIdRef 焦点 session id（string | null | undefined；undefined 归一为 null）
 */
export function useBackgroundTaskBucketFilter(
  sessionIdRef: Ref<string | null | undefined>,
): UseBackgroundTaskBucketFilterReturn {
  // null 归一：useSessionScopedState 契约要求 Ref<string|null>
  const normalizedSid = computed(() => sessionIdRef.value ?? null)

  const scoped = useSessionScopedState<BackgroundTaskFilterPartition>(normalizedSid, () =>
    reactive<BackgroundTaskFilterPartition>({ value: BACKGROUND_TASK_DEFAULT_FILTER }),
  )

  return {
    current: computed(() => scoped.current.value.value),
    setFilter: (value) => {
      scoped.update((p) => {
        p.value = value
      })
    },
  }
}
