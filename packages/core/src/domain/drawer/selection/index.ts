/**
 * drawer 域选中态/瞬时参数分区入口（display-containers §6.6 W0 状态还债）。
 *
 * 五字段迁出 DrawerControlState 后各回各的内容域分区（§6.6①）：
 *   subagent.ts（selectedSubagentId + enteredFrom）/ workflow.ts（selectedWorkflowName）/
 *   bash-task.ts（selectedBackgroundTaskId）/ btw.ts（selectedBtwVid）；
 * 瞬时参数按会话分区（§6.6②）：transient.ts（selectedCommandName / detailFilePath）；
 * 复合谓词单一源（迁出不变量 [MANDATORY]）：predicates.ts + viewed-vids.ts。
 *
 * 依赖方向：selection/<域> → control（drawerSessionKey 分区键）；predicates → control +
 * selection/<域>；control 不 import selection（保持纯控制态，C4 无环）。
 */
export * from './subagent'
export * from './workflow'
export * from './bash-task'
export * from './btw'
export * from './transient'
export * from './predicates'
export * from './viewed-vids'
import { _resetSubagentSelectionForTest } from './subagent'
import { _resetWorkflowSelectionForTest } from './workflow'
import { _resetBashTaskSelectionForTest } from './bash-task'
import { _resetBtwSelectionForTest } from './btw'
import { _resetTransientParamsForTest } from './transient'

/**
 * 清空全部选中态/瞬时参数分区（测试隔离用；coordination._resetDrawerForTest 组合调用）。
 * 生产代码禁止调用。
 */
export function _resetSelectionForTest(): void {
  _resetSubagentSelectionForTest()
  _resetWorkflowSelectionForTest()
  _resetBashTaskSelectionForTest()
  _resetBtwSelectionForTest()
  _resetTransientParamsForTest()
}
