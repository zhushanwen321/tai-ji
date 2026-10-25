/**
 * drawer 协同层 —— 模块级公开 API（C2 契约）+ 瞬时参数/选中态写入编排。
 *
 * 迁移自 renderer composables/features/useSideDrawer.ts 的协同部分（W1）。
 * [P4 s5 drawer-widget-removal] pendingOpen 机制（pendingOpenMap/setPendingOpenForSid/
 * getPendingOpenForSid/consumePendingOpen/openTasksDrawerOnFirstData）已随 tasks 域删除移除——
 * PluginViewContainer 承接后无消费方（tasks tab 已从抽屉 tab 联合删除）。
 *
 * 瞬时参数（selectedCommandName/detailFilePath）：打开时的瞬时参数，按会话分区
 * （selection/transient.ts，display-containers §6.6②——消跨会话劫持），读侧在该文件。
 *
 * 选中态写入编排（display-containers §6.6① 五字段迁出后）：选中态落 selection/<域>
 * 分区、切 tab + 开合落 control——跨两分区的编排收敛在本层（control 保持纯控制态，C4）。
 * 各选中态写侧（setSubagentView / clearSubagentView / setBtwView / setBackgroundTaskView）
 * 状态本体在 selection/<域>，经 drawer barrel 单一出口（本文件不重复导出，防 export * 同名冲突）。
 *
 * 分层（C4）：单向依赖 control.ts（drawerControl 原语 + getBoundSessionId + getDrawerControlState）
 * 与 selection/（各内容域分区 + 瞬时参数）。control/selection 不 import 本文件（防循环）。
 */
import { ref } from 'vue'
import type { WorkflowRunRecord } from '@taiji/shared'
import { drawerControl, getDrawerControlState, _resetDrawerControlForTest } from './control'
import { setSubagentView, clearSubagentView, clearSubagentViewFor } from './selection/subagent'
import { setBackgroundTaskView } from './selection/bash-task'
import { selectedCommandName, detailFilePath } from './selection/transient'
import { _resetSelectionForTest } from './selection'
import type { RightDrawerTab, OpenDrawerOptions, OpenSubagentOptions } from './types'

// ── 模块级公开 API（C2）──

/**
 * 打开抽屉，可指定初始 tab + Doc tab 的选中命令 / Detail tab 的文件路径。
 * 瞬时参数写入当前会话分区（selection/transient.ts；undefined 字段不写——缺省不覆盖已有值）。
 */
export function openDrawerTab(tab?: RightDrawerTab, opts?: OpenDrawerOptions): void {
  if (opts?.commandName !== undefined) selectedCommandName.value = opts.commandName
  if (opts?.filePath !== undefined) detailFilePath.value = opts.filePath
  drawerControl.open(tab)
}

/** 关闭抽屉 */
export function closeDrawer(): void {
  drawerControl.close()
}

/**
 * 二级 tab 关空收敛（drawer 域交互规则单一落点）：某一级 tab 下最后一个二级 tab 关闭时，
 * 整个抽屉直接关闭（不回空态停留）。全部二级 tab 关闭编排（现有 detail 文件 tab /
 * subagent 实例 tab，未来新增可关闭二级 tab 的内容域同样适用）的关空分支必须经本入口，
 * 禁止各自直调 closeDrawer。empty 由调用方以内容域 store 关闭后的同步结果判定
 * （core 不感知内容域数据），必须在关闭动作之后调用（判定基于关闭后的剩余计数）。
 */
export function closeDrawerIfTabsEmpty(empty: boolean): void {
  if (empty) closeDrawer()
}

/** 切换开关；从关到开可指定 tab */
export function toggleDrawer(tab?: RightDrawerTab): void {
  if (getDrawerControlState().isOpen) closeDrawer()
  else openDrawerTab(tab)
}

/** 切换 tab（抽屉关闭时仅改 activeTab，不自动打开） */
export function setDrawerTab(tab: RightDrawerTab): void {
  drawerControl.setTab(tab)
}

/**
 * 打开 subagent tab，展示指定 subagent 的只读对话流（D3：复用 MessageStream）。
 * virtualId 由调用方（chat subagent 块 / composer 任务托盘）用
 * subagentVirtualId(mainSid, subId) 或 agentCallVirtualId(acsId) 算好传入；core 不感知 id 结构。
 * 选中态（selectedSubagentId）落 subagent 内容域分区（§6.6①），切 tab + 开 drawer 落控制态。
 */
export function openSubagent(opts: OpenSubagentOptions): void {
  setSubagentView(opts.virtualId)
  drawerControl.open('subagent')
}

/**
 * 清空 subagent 选中态（drawer 二级 tab 全部关闭回空态时调用，不开合 drawer）。
 * 与 openSubagent 同为 subagent 选中态的编排级写入入口——空态不同步清空会在分区留
 * 残留 vid，重挂载复活已关闭 tab / 同值重选不触发 watch。
 * sid 省缺 = 清当前分区（绑定键 current）；显式传 sid = 定向清除该分区（与 tab
 * store 分区同键——调用方 useSubagentDrawerTabs 空态收敛传 focusedSid，消除
 * 「清除走 current、读写走 focusedSid」对 current == focused 隐式不变量的依赖）。
 */
export function clearSubagentSelection(sid?: string): void {
  if (sid !== undefined) clearSubagentViewFor(sid)
  else clearSubagentView()
}

/**
 * 设置 bashTask tab 当前任务（undefined=清选中）+ 切 tab + 开 drawer（D5④ 行点击归宿）。
 * 选中态落 bashTask 内容域分区（§6.6①，selection/bash-task.ts）。
 */
export function selectBackgroundTask(taskId: string | undefined): void {
  setBackgroundTaskView(taskId)
  drawerControl.open('bashTask')
}

// ── workflow overlay 桥接（workflow-visualization U6/D1 入口语义分立）──────────
//
// core 保持 headless（零 pinia/renderer 依赖）：overlay 的打开与 run 反查实装在
// renderer（workflow-viz controller），经本层绑定口注入（bindDrawerSessionId 同款
// 模式，绑定动作发生在 renderer 装配模块加载时，函数体首次执行在用户交互时刻——
// pinia 已 active）。未绑定时 openWorkflow no-op / lookupWorkflowRun 返回 undefined
// （headless/测试环境安全默认）。
// [2026-10-19] openWorkflowInDrawer（drawer workflow tab 显式语义）已随该 tab 删除
// 移除——workflow 唯一入口 = openWorkflow（开浮层）。

/** overlay 打开回调（renderer 注入）：收 nameOrRunId（双语义，同 openWorkflow 形参约定）+ 可选 slug/sessionId */
export type WorkflowOverlayOpener = (nameOrRunId: string, slug?: string, sessionId?: string) => void

/** workflow run 反查回调（renderer 注入）：从 workflowStore 分区读，(scriptName, slug) → record */
export type WorkflowRunLookup = (sessionId: string, scriptName: string, slug?: string) => WorkflowRunRecord | undefined

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，已登记 §4 ⑧ 2026-10-02）：overlay 桥接绑定单例 ref
const boundOverlayOpener = ref<WorkflowOverlayOpener | null>(null)
// taste:allow-no-data-owner W24-EX-B（同上，已登记 §4 ⑧ 2026-10-02）：同组桥接绑定的第二声明
const boundWorkflowRunLookup = ref<WorkflowRunLookup | null>(null)

/**
 * 绑定 overlay 打开回调（renderer 装配调用；幂等，传 null 解绑——测试隔离用）。
 */
export function bindWorkflowOverlayOpener(opener: WorkflowOverlayOpener | null): void {
  boundOverlayOpener.value = opener
}

/** 绑定 workflow run 反查回调（renderer 装配调用；幂等，传 null 解绑）。 */
export function bindWorkflowRunLookup(lookup: WorkflowRunLookup | null): void {
  boundWorkflowRunLookup.value = lookup
}

/**
 * 打开 workflow——workflow-visualization U6/D1 改向后 = 开 overlay（全屏实况视图）。
 *
 * 形参双语义（与 D1 调用范围全量一致）：托盘行传 runId（TrayNativePanel 行点击矩阵，
 * 零改动）；对话流 block 传脚本名 + opts.slug（block 以 (scriptName, slug) 经
 * workflowStore 反查 runId 的动作在 renderer opener 内单处执行——core 不感知
 * store 数据）。opts.sessionId = 发起 pane 的 session（block 场景精确传，缺省由
 * renderer opener 回落 focusedSessionId）。
 */
export function openWorkflow(workflowName?: string, opts?: { slug?: string; sessionId?: string }): void {
  boundOverlayOpener.value?.(workflowName ?? '', opts?.slug, opts?.sessionId)
}

/**
 * workflow run 反查（chips 数据消费口）：转发 renderer 绑定的 lookup。
 * 未绑定（headless/测试）返回 undefined（调用方按无数据渲染，不报错）。
 */
export function lookupWorkflowRun(sessionId: string, scriptName: string, slug?: string): WorkflowRunRecord | undefined {
  return boundWorkflowRunLookup.value?.(sessionId, scriptName, slug)
}

/**
 * 重置 drawer 全部状态（测试隔离用）：control 分区 + 选中态/瞬时参数分区。
 * 生产代码禁止调用。renderer 兼容层 resetSideDrawer() 委托本函数。
 */
export function _resetDrawerForTest(): void {
  _resetDrawerControlForTest()
  _resetSelectionForTest()
}
