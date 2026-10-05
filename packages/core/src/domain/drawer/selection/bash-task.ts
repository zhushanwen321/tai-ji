/**
 * bashTask（后台命令）内容域选中态（display-containers §6.6① 五字段迁出，W0 还债）。
 *
 * 迁出来源 = DrawerControlState.selectedBackgroundTaskId（bashTask tab 当前展示的后台任务 id）。
 * per-session 分区（useSessionScopedState，ADR-0049），键 = drawerSessionKey。
 * 写入面 = setBackgroundTaskView（TrayNativePanel 行点击 / 测试）；
 * 读取面 = useBashTaskSelection（BackgroundTaskDetailPanel + PanelContainer 注入判定）。
 */
import { computed, reactive } from 'vue'
import type { ComputedRef } from 'vue'
import { useSessionScopedState } from '../../../foundation/use-session-scoped-state'
import { drawerSessionKey } from '../control'

/** bashTask 选中态（per-session 分区） */
export interface BashTaskSelectionState { // oe-exempt:20261003:framework:类型契约先行——selection 分区契约，renderer 消费面即本批 D1 单元
  /** bashTask tab 当前展示的后台任务 id（registry taskId，background-task-sidebar-view D5①）；undefined=未选中（bashTask tab 显空态） */
  selectedBackgroundTaskId?: string
}

function createDefaultBashTaskSelection(): BashTaskSelectionState {
  // reactive 容器契约（ADR-0049 W2 教训）：plain object 的 mutate 不触发下游重算
  return reactive({})
}

const selection = useSessionScopedState<BashTaskSelectionState>(
  drawerSessionKey,
  createDefaultBashTaskSelection,
)

/** bashTask 选中态视图（当前分区，切 session 自动跟随） */
export function useBashTaskSelection(): {
  selectedBackgroundTaskId: ComputedRef<string | undefined>
  } {
  return {
    selectedBackgroundTaskId: computed(() => selection.current.value.selectedBackgroundTaskId),
  }
}

/** 设置 bashTask tab 当前任务（undefined=清选中 → 面板显空态）。写入方 = 列表 item 点击（D5④）。 */
export function setBackgroundTaskView(taskId: string | undefined): void {
  selection.current.value.selectedBackgroundTaskId = taskId
}

/** 清空 bashTask 选中态分区（测试隔离用）。生产代码禁止调用。 */
export function _resetBashTaskSelectionForTest(): void {
  selection._clearAllForTest()
}
