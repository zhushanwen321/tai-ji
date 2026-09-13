/**
 * useSubagentBucketFilter —— Agents tab 二级筛选（全部活跃 / 只看正在跑 / 已收起，
 * U8b 可见性翻转后语义）的 per-session 状态分区 composable（设计 subagent-sidebar-filter
 * D5 + 永久会话模型 §3.2.8，ADR-0049 合规）。
 *
 * 分区语义（D1/D5）：经 useSessionScopedState 工厂按 sessionId 分区——
 * - 新 session 首次进入 = 默认视图「全部活跃」（DEFAULT_SUBAGENT_FILTER）
 * - 同一次宿主挂载期内切回旧 session 恢复该 session 上次选择
 * - 切 tab（宿主卸载）后分区全量丢弃，重置默认视图
 *
 * [响应式契约] init 必须返回 reactive 容器（`reactive({ value: ... })`）——工厂文件头
 * 「响应式契约」明文（W2 useExtensionUI 同款踩坑先例）：update 内 mutate 分区对象，
 * 下游 computed 只能在 reactive 容器上建立依赖；plain object 的 mutate 不触发任何
 * 下游重算，切桶 UI 永不更新（功能死锁级）。
 *
 * [生命周期] per-instance Map：分区随宿主组件实例存活（每次调用建独立 Map，切 tab
 * 卸载即重置）；session 销毁的 cleanup 由工厂自动注册，随 useSidebar.deleteSession 统一编排。
 *
 * 消费方（SubagentList）纯读：`const { filter, setFilter } = useSubagentBucketFilter(
 * computed(() => props.sessionId))`——组件内禁止 watch(sessionId) 清空、禁止实例级
 * filter ref（ADR-0049 点名反模式，分区语义由本工厂承担）。
 */
import { computed, reactive } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useSessionScopedState } from '@xyz-agent/core/foundation/use-session-scoped-state'
import { DEFAULT_SUBAGENT_FILTER } from '@/lib/subagent-bucket'
import type { SubagentFilterValue } from '@/lib/subagent-bucket'

export function useSubagentBucketFilter(sessionId: Ref<string | null>): {
  /** 当前 session 的筛选视图（新 session 初值 = 'active' 默认视图） */
  filter: ComputedRef<SubagentFilterValue>
  /** 切换当前 session 的筛选桶（null sid 时工厂内部 no-op，Overview 态不可改） */
  setFilter: (value: SubagentFilterValue) => void
} {
  // 标量需对象包装且必须 reactive 容器（见文件头响应式契约）
  const { current, update } = useSessionScopedState<{ value: SubagentFilterValue }>(
    sessionId,
    () => reactive({ value: DEFAULT_SUBAGENT_FILTER }),
  )

  const filter = computed<SubagentFilterValue>(() => current.value.value)

  function setFilter(value: SubagentFilterValue): void {
    update((state) => {
      state.value = value
    })
  }

  return { filter, setFilter }
}
