/**
 * drawer 协同层 —— 模块级公开 API（C2 契约）+ 瞬时参数。
 *
 * 迁移自 renderer composables/features/useSideDrawer.ts 的协同部分（W1）。
 * [P4 s5 drawer-widget-removal] pendingOpen 机制（pendingOpenMap/setPendingOpenForSid/
 * getPendingOpenForSid/consumePendingOpen/openTasksDrawerOnFirstData）已随 tasks 域删除移除——
 * PluginViewContainer 承接后无消费方（tasks tab 已从 SideDrawerTab 联合删除）。
 *
 * 瞬时参数（selectedCommandName/detailFilePath）：打开时的瞬时参数，
 * 消费后清空，不构成 session 级持久状态。
 *
 * 分层（C4）：单向依赖 control.ts（drawerControl 原语 + getBoundSessionId + getDrawerControlState）。
 * control 不 import 本文件（防循环）。
 */
import { ref } from 'vue'
import type { WorkflowRunRecord } from '@taiji/shared'
import { drawerControl, getDrawerControlState, _resetDrawerControlForTest } from './control'
import type { SideDrawerTab, OpenDrawerOptions, OpenSubagentOptions } from './types'

// ── 不分区的瞬时参数（模块级单例，消费后清空）──
// 供 renderer 兼容层 re-export（useSideDrawer() 返回形状含这两个 ref）。
/** Doc tab 当前展示的命令名（点击用户气泡 slash chip 时设置） */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：drawer doc tab 瞬时参数（消费后清空）
export const selectedCommandName = ref<string | null>(null)
/**
 * Detail tab 打开时立即展示的文件路径（点击即看 diff）。
 * 由变更集卡等非文件树入口设置；useDetailPane watch 它并强制 diff 模式。
 * 用完即清空（消费后置 null），避免残留导致下次打开 detail tab 被旧值劫持。
 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：drawer detail tab 瞬时参数（消费后清空）
export const detailFilePath = ref<string | null>(null)

// ── 模块级公开 API（C2）──

/**
 * 打开抽屉，可指定初始 tab + Doc tab 的选中命令 / Detail tab 的文件路径。
 * 瞬时参数写入对应 ref（消费后清空）。
 */
export function openDrawerTab(tab?: SideDrawerTab, opts?: OpenDrawerOptions): void {
  if (opts?.commandName !== undefined) selectedCommandName.value = opts.commandName
  if (opts?.filePath !== undefined) detailFilePath.value = opts.filePath
  drawerControl.open(tab)
}

/** 关闭抽屉（钉住态亦可手动关闭） */
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

/** 切换钉住态（仅当前分区） */
export function toggleDrawerDock(): void {
  drawerControl.toggleDock()
}

/**
 * 打开 subagent tab，展示指定 subagent 的只读对话流（D3：复用 MessageStream）。
 * virtualId 由调用方（chat subagent 块 / composer 任务托盘 / workflow WorkflowTab）用
 * subagentVirtualId(mainSid, subId) 或 agentCallVirtualId(acsId) 算好传入；core 不感知 id 结构。
 * enteredFrom 驱动 SubagentTab 返回按钮显隐（D4）：'workflow'=从 workflow tab 进入显返回；'chat'=无返回。
 */
export function openSubagent(opts: OpenSubagentOptions): void {
  drawerControl.setSubagentView(opts.virtualId, opts.enteredFrom)
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
 * 形参双语义与 WorkflowTab 兼收解析现状一致：传 runId（精确命中）或脚本名（取最新）；
 * 空串时仅切到 workflow tab（不记录选中名，显空态或全部）。消费方 = D10 回落链
 * （Guard → openDrawerTab('workflow') + 本函数注入选中态）、SubagentTab 返回按钮
 * （返回 drawer workflow tab）、block 反查未命中的兜底归宿。
 */
export function openWorkflowInDrawer(workflowName?: string): void {
  drawerControl.setWorkflowView(workflowName ?? '')
}

/**
 * workflow run 反查（chips 数据消费口）：转发 renderer 绑定的 lookup。
 * 未绑定（headless/测试）返回 undefined（调用方按无数据渲染，不报错）。
 */
export function lookupWorkflowRun(sessionId: string, scriptName: string, slug?: string): WorkflowRunRecord | undefined {
  return boundWorkflowRunLookup.value?.(sessionId, scriptName, slug)
}

/**
 * 重置 drawer 全部状态（测试隔离用）：control 分区 + 瞬时参数。
 * 生产代码禁止调用。renderer 兼容层 resetSideDrawer() 委托本函数。
 */
export function _resetDrawerForTest(): void {
  _resetDrawerControlForTest()
  selectedCommandName.value = null
  detailFilePath.value = null
}
