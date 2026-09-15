/**
 * useListSync —— sidebar 列表（subagents / workflows）首拉 RPC 的响应式同步（features 层跨 store 编排）。
 *
 * 职责：封装「列表何时该首拉」的决策。两个触发源：
 * 1. focusedSessionId 变化（切会话）→ load 首拉 RPC
 * 2. 目标 tab 激活 + focusedSessionId 有值 → load 首拉 RPC
 *
 * 两个消费槽位（Sidebar.vue 各调一次）仅差 tab 名与 load 方法：
 * - { tab: 'subagents', load: subagentStore.loadSubagents }
 * - { tab: 'workflows', load: workflowStore.loadWorkflows }
 *
 * 状态更新（含非活跃 session 的终态增量推送）走 useConnection.routeInbound 兜底
 * （session.subagents → subagentStore.applyRecords / session.workflowUpdate →
 * workflowStore.triggerWorkflowReload），不在此订阅。本 composable 只负责首拉 RPC。
 *
 * 调用方：Sidebar.vue 在 onMounted 对每个槽位各调一次。watch 的生命周期跟随组件。
 */
import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import { usePanelStore } from '@/stores/panel'
import { useSidebarStore, type SidebarTab } from '@/stores/sidebar'

/** 两个消费槽位的参数化差异（其余行为完全一致）。 */
export interface ListSyncOptions {
  /** 激活该 tab 时首拉。 */
  tab: Extract<SidebarTab, 'subagents' | 'workflows'>
  /** 首拉 RPC（传对应 store 的 load 方法，setup store 的 action 不依赖 this，可安全传引用）。 */
  load: (sessionId: string) => Promise<unknown>
}

export function useListSync({ tab, load }: ListSyncOptions): void {
  const panel = usePanelStore()
  const sidebar = useSidebarStore()

  /**
   * 当前焦点 session（store.focusedSessionId，UI 高亮的真相源）。
   * v2 split 移除后直接读 store computed（此前 local computed 从 panels.find 派生，单 panel 下冗余）。
   */
  const { focusedSessionId } = storeToRefs(panel)

  /**
   * 切会话时首拉 RPC 兜底（推送可能晚到，RPC 立即拿到当前列表）。
   * immediate 承载挂载首拉（挂载时 tab 已激活的场景也被此覆盖——tab watch 无 immediate，
   * 两者恰一次触发，不重复首拉）。
   * 实时增量由 routeInbound 兜底统一处理，不再 per-focus 订阅。
   */
  watch(
    () => focusedSessionId.value,
    (sid) => {
      if (sid) {
        void load(sid)
      }
    },
    { immediate: true },
  )

  /**
   * 目标 tab 激活时首拉（用户主动切 tab 的场景；routeInbound 处理「运行时实时变化」，
   * 这里处理「用户主动切到目标 tab」）。
   */
  watch(
    () => [sidebar.activeTab, focusedSessionId.value] as const,
    ([active, sid]) => {
      if (active === tab && sid) {
        void load(sid)
      }
    },
  )
}
