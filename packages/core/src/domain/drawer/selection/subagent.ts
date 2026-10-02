/**
 * subagent 内容域选中态（display-containers §6.6① 五字段迁出，W0 还债）。
 *
 * 迁出来源 = DrawerControlState.selectedSubagentId + enteredFrom（同迁 subagent 内容域——
 * enteredFrom 是 subagent 面板进入来源态，与 selectedSubagentId 同生命周期同分区）。
 * 状态本体按 per-session 分区（useSessionScopedState，ADR-0049），与控制态分区同键
 * （drawerSessionKey，control.ts 绑定），但物理独立——控制态只留开合 + activeTab。
 *
 * 写入面 = setSubagentView（coordination.openSubagent 编排调用）；
 * 读取面 = useSubagentSelection（SubagentTab 消费）+ readSubagentSelectionFor
 * （复合谓词 selection/predicates.ts 按 sid 跨域读，getViewedVids 豁免链用）。
 */
import { computed, reactive } from 'vue'
import type { ComputedRef } from 'vue'
import { useSessionScopedState } from '../../../foundation/use-session-scoped-state'
import { drawerSessionKey } from '../control'

/** subagent 选中态（per-session 分区） */
export interface SubagentSelectionState { // oe-exempt:20261003:framework:类型契约先行——selection 分区契约，renderer 消费面即本批 D1 单元
  /** subagent tab 当前展示的 subagent 虚拟 id（`subagent:<mainSid>:<subId>` 或 `agentcall:<acsId>`，由调用方算好传入）；null=未选中（subagent tab 显空态） */
  selectedSubagentId: string | null
  /** subagent tab 的进入来源：'chat'=从 chat subagent 块进入（无返回按钮）；'workflow'=从 workflow tab 点 agent call 进入（显←返回按钮）；null=未在 subagent tab */
  enteredFrom: 'chat' | 'workflow' | null
}

function createDefaultSubagentSelection(): SubagentSelectionState {
  // [HISTORICAL] 必须返回 reactive 容器（useSessionScopedState 响应式契约）：
  // plain object 的 mutate 不触发下游 computed 重算（ADR-0049 W2 教训）。
  return reactive({
    selectedSubagentId: null,
    enteredFrom: null,
  })
}

const selection = useSessionScopedState<SubagentSelectionState>(
  drawerSessionKey,
  createDefaultSubagentSelection,
)

/** subagent 选中态视图（当前分区，切 session 自动跟随） */
export function useSubagentSelection(): {
  selectedSubagentId: ComputedRef<string | null>
  enteredFrom: ComputedRef<'chat' | 'workflow' | null>
  } {
  return {
    selectedSubagentId: computed(() => selection.current.value.selectedSubagentId),
    enteredFrom: computed(() => selection.current.value.enteredFrom),
  }
}

/**
 * 设置 subagent tab 视图（D4）：记录选中的 subagent 虚拟 id + 进入来源。
 * virtualId 由调用方算好（subagentVirtualId/agentCallVirtualId），core 不感知 id 结构。
 * 切 tab + 开 drawer 的编排在 coordination.openSubagent（本函数只写选中态）。
 */
export function setSubagentView(virtualId: string, enteredFrom: 'chat' | 'workflow'): void {
  const cur = selection.current.value
  cur.selectedSubagentId = virtualId
  cur.enteredFrom = enteredFrom
}

/** 按 sid 读 subagent 选中态（复合谓词跨域读取用；updateFor 语义：已删 sid 不复活分区） */
export function readSubagentSelectionFor<R>(sid: string, read: (s: SubagentSelectionState) => R): R | undefined {
  let out: R | undefined
  selection.updateFor(sid, (s) => {
    out = read(s)
  })
  return out
}

/** 清空 subagent 选中态分区（测试隔离用）。生产代码禁止调用。 */
export function _resetSubagentSelectionForTest(): void {
  selection._clearAllForTest()
}
