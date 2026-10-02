/**
 * drawer 协同层 —— 模块级公开 API（C2 契约）+ 瞬时参数/选中态写入编排。
 *
 * 迁移自 renderer composables/features/useSideDrawer.ts 的协同部分（W1）。
 * [P4 s5 drawer-widget-removal] pendingOpen 机制（pendingOpenMap/setPendingOpenForSid/
 * getPendingOpenForSid/consumePendingOpen/openTasksDrawerOnFirstData）已随 tasks 域删除移除——
 * PluginViewContainer 承接后无消费方（tasks tab 已从 SideDrawerTab 联合删除）。
 *
 * 瞬时参数（selectedCommandName/detailFilePath）：打开时的瞬时参数，按会话分区
 * （selection/transient.ts，display-containers §6.6②——消跨会话劫持），读取面在该文件。
 *
 * 选中态写入编排（display-containers §6.6① 五字段迁出后）：选中态落 selection/<域>
 * 分区、切 tab + 开合落 control——跨两分区的编排收口在本层（control 保持纯控制态，C4）。
 * 各选中态写入面（setSubagentView / setWorkflowView / setBtwView / setBackgroundTaskView）
 * 状态本体在 selection/<域>，经 drawer barrel 单一出口（本文件不重复导出，防 export * 同名冲突）。
 *
 * 分层（C4）：单向依赖 control.ts（drawerControl 原语 + getBoundSessionId + getDrawerControlState）
 * 与 selection/（各内容域分区 + 瞬时参数）。control/selection 不 import 本文件（防循环）。
 */
import { ref } from 'vue'
import type { WorkflowRunRecord } from '@taiji/shared'
import { drawerControl, getDrawerControlState, _resetDrawerControlForTest } from './control'
import { setSubagentView } from './selection/subagent'
import { setWorkflowView } from './selection/workflow'
import { setBackgroundTaskView } from './selection/bash-task'
import { selectedCommandName, detailFilePath } from './selection/transient'
import { _resetSelectionForTest } from './selection'
import type { SideDrawerTab, OpenDrawerOptions, OpenSubagentOptions } from './types'

// ── 模块级公开 API（C2）──

/**
 * 打开抽屉，可指定初始 tab + Doc tab 的选中命令 / Detail tab 的文件路径。
 * 瞬时参数写入当前会话分区（selection/transient.ts；undefined 字段不写——缺省不覆盖已有值）。
 */
export function openDrawerTab(tab?: SideDrawerTab, opts?: OpenDrawerOptions): void {
  if (opts?.commandName !== undefined) selectedCommandName.value = opts.commandName
  if (opts?.filePath !== undefined) detailFilePath.value = opts.filePath
  drawerControl.open(tab)
}

/** 关闭抽屉 */
export function closeDrawer(): void {
  drawerControl.close()
}

/** 切换开关；从关到开可指定 tab */
export function toggleDrawer(tab?: SideDrawerTab): void {
  if (getDrawerControlState().isOpen) closeDrawer()
  else openDrawerTab(tab)
}

/** 切换 tab（抽屉关闭时仅改 activeTab，不自动打开） */
export function setDrawerTab(tab: SideDrawerTab): void {
  drawerControl.setTab(tab)
}

/**
 * 打开 subagent tab，展示指定 subagent 的只读对话流（D3：复用 MessageStream）。
 * virtualId 由调用方（chat subagent 块 / composer 任务托盘 / workflow WorkflowTab）用
 * subagentVirtualId(mainSid, subId) 或 agentCallVirtualId(acsId) 算好传入；core 不感知 id 结构。
 * enteredFrom 驱动 SubagentTab 返回按钮显隐（D4）：'workflow'=从 workflow tab 进入显返回；'chat'=无返回。
 * 选中态（selectedSubagentId + enteredFrom）落 subagent 内容域分区（§6.6①），切 tab + 开 drawer 落控制态。
 */
export function openSubagent(opts: OpenSubagentOptions): void {
  setSubagentView(opts.virtualId, opts.enteredFrom)
  drawerControl.open('subagent')
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

/** overlay 打开回调（renderer 注入）：收 nameOrRunId（双语义，同 openWorkflow 形参约定）+ 可选 slug/sessionId */
export type WorkflowOverlayOpener = (nameOrRunId: string, slug?: string, sessionId?: string) => void

/** workflow run 反查回调（renderer 注入）：从 workflowStore 分区读，(scriptName, slug) → record */
export type WorkflowRunLookup = (sessionId: string, scriptName: string, slug?: string) => WorkflowRunRecord | undefined

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：overlay 桥接绑定单例 ref
const boundOverlayOpener = ref<WorkflowOverlayOpener | null>(null)
// taste:allow-no-data-owner W24-EX-B（同上，同组桥接绑定的第二声明）
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
 * 形参双语义（与 D1 调用面全量一致）：托盘行传 runId（TrayNativePanel 行点击矩阵，
 * 零改动）；对话流 block 传脚本名 + opts.slug（block 以 (scriptName, slug) 经
 * workflowStore 反查 runId 的动作在 renderer opener 内单处执行——core 不感知
 * store 数据）。opts.sessionId = 发起 pane 的 session（block 场景精确传，缺省由
 * renderer opener 回落 focusedSessionId）。
 *
 * 同一函数不承担「开 overlay」与「注入 drawer 选中态」两种语义（D1）——drawer
 * 语义见 openWorkflowInDrawer。
 */
export function openWorkflow(workflowName?: string, opts?: { slug?: string; sessionId?: string }): void {
  boundOverlayOpener.value?.(workflowName ?? '', opts?.slug, opts?.sessionId)
}

/**
 * 打开 drawer workflow tab，展示指定 workflow 的 agent call 列表（显式 drawer 语义，
 * D1：现 openWorkflow 实现的移位保留）。
 *
 * 形参双语义与 WorkflowTab 兼容解析现状一致：传 runId（精确命中）或脚本名（取最新）；
 * 空串时仅切到 workflow tab（不记录选中名，显空态或全部）。消费方 = D10 回落链
 * （Guard → openDrawerTab('workflow') + 本函数注入选中态）、SubagentTab 返回按钮
 * （返回 drawer workflow tab）、block 反查未命中的兜底归宿。
 * 选中态落 workflow 内容域分区（§6.6①），切 tab + 开 drawer 落控制态。
 */
export function openWorkflowInDrawer(workflowName?: string): void {
  setWorkflowView(workflowName ?? '')
  drawerControl.open('workflow')
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
