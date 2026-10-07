/**
 * workflow 内容域选中态（display-containers §6.6① 五字段迁出，W0 还债）。
 *
 * 迁出来源 = DrawerControlState.selectedWorkflowName（workflow tab 当前展示的 workflow 名）。
 * per-session 分区（useSessionScopedState，ADR-0049），键 = drawerSessionKey。
 * 写入面 = setWorkflowView（coordination.openWorkflowInDrawer 编排调用）；
 * 读取面 = useWorkflowSelection（WorkflowTab 消费）。
 */
import { computed, reactive } from 'vue'
import type { ComputedRef } from 'vue'
import { useSessionScopedState } from '../../../foundation/use-session-scoped-state'
import { drawerSessionKey } from '../control'

/** workflow 选中态（per-session 分区） */
export interface WorkflowSelectionState { // oe-exempt:20261003:framework:类型契约先行——selection 分区契约，renderer 消费面即本批 D1 单元
  /** workflow tab 当前展示的 workflow 名；null=未选中（workflow tab 显空态） */
  selectedWorkflowName: string | null
}

function createDefaultWorkflowSelection(): WorkflowSelectionState {
  // reactive 容器契约（ADR-0049 W2 教训）：plain object 的 mutate 不触发下游重算
  return reactive({ selectedWorkflowName: null })
}

const selection = useSessionScopedState<WorkflowSelectionState>(
  drawerSessionKey,
  createDefaultWorkflowSelection,
)

/** workflow 选中态视图（当前分区，切 session 自动跟随） */
export function useWorkflowSelection(): {
  selectedWorkflowName: ComputedRef<string | null>
  } {
  return {
    selectedWorkflowName: computed(() => selection.current.value.selectedWorkflowName),
  }
}

/** 设置 workflow tab 视图：记录 workflow 名（切 tab + 开 drawer 的编排在 coordination） */
export function setWorkflowView(workflowName: string): void {
  selection.current.value.selectedWorkflowName = workflowName
}

/** 清空 workflow 选中态分区（测试隔离用）。生产代码禁止调用。 */
export function _resetWorkflowSelectionForTest(): void {
  selection._clearAllForTest()
}
