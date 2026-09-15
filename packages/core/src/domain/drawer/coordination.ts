/**
 * drawer 协同层 —— 模块级公开 API（C2 契约）+ 瞬时参数。
 *
 * 迁移自 renderer composables/features/useSideDrawer.ts 的协同部分（W1）。
 * [P4 s5 drawer-widget-removal] pendingOpen 机制（pendingOpenMap/setPendingOpenForSid/
 * getPendingOpenForSid/consumePendingOpen/openTasksDrawerOnFirstData）已随 tasks 域删除移除——
 * PluginViewContainer 承接后无消费方（tasks tab 已从 SideDrawerTab 联合删除）。
 *
 * 瞬时参数（selectedCommandName/detailFilePath/browserUrl）：打开时的瞬时参数，
 * 消费后清空，不构成 session 级持久状态。
 *
 * 分层（C4）：单向依赖 control.ts（drawerControl 原语 + getBoundSessionId + getDrawerControlState）。
 * control 不 import 本文件（防循环）。
 */
import { ref } from 'vue'
import { drawerControl, getDrawerControlState, _resetDrawerControlForTest } from './control'
import type { SideDrawerTab, OpenDrawerOptions, OpenSubagentOptions } from './types'

// ── 不分区的瞬时参数（模块级单例，消费后清空）──
// 供 renderer 兼容层 re-export（useSideDrawer() 返回形状含这三个 ref + consumeBrowserUrl）。
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
/**
 * Browser tab 打开时立即加载的 URL（点击 agent 输出的链接设置）。
 * 由 `openDrawerTab(opts.url)` 写入；SideDrawer/BrowserPane 据此触发导航。
 * 原 renderer 设置方 `useMarkdownInteractions` 外链分支已于 2026-09-11 随死代码删除，
 * 当前无调用方（保留待后续接入）。
 * 用完即清空（消费后置 null），避免残留导致下次打开 browser tab 被旧值劫持。
 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：drawer browser tab 瞬时参数（消费后清空）
export const browserUrl = ref<string | null>(null)

/** 消费 browserUrl：读取并清空（BrowserPane 挂载时调，取到非空值触发导航） */
export function consumeBrowserUrl(): string | null {
  const url = browserUrl.value
  browserUrl.value = null
  return url
}

// ── 模块级公开 API（C2）──

/**
 * 打开抽屉，可指定初始 tab + Doc tab 的选中命令 / Detail tab 的文件路径 / Browser tab 的 URL。
 * 瞬时参数写入对应 ref（消费后清空）。
 */
export function openDrawerTab(tab?: SideDrawerTab, opts?: OpenDrawerOptions): void {
  if (opts?.commandName !== undefined) selectedCommandName.value = opts.commandName
  if (opts?.filePath !== undefined) detailFilePath.value = opts.filePath
  if (opts?.url !== undefined) browserUrl.value = opts.url
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
 * virtualId 由调用方（chat subagent 块 / sidebar SubagentList / workflow WorkflowTab）用
 * subagentVirtualId(mainSid, subId) 或 agentCallVirtualId(acsId) 算好传入；core 不感知 id 结构。
 * enteredFrom 驱动 SubagentTab 返回按钮显隐（D4）：'workflow'=从 workflow tab 进入显返回；'chat'=无返回。
 */
export function openSubagent(opts: OpenSubagentOptions): void {
  drawerControl.setSubagentView(opts.virtualId, opts.enteredFrom)
}

/**
 * 打开 workflow tab，展示指定 workflow 的 agent call 列表。
 * workflowName 为空串时仅切到 workflow tab（不记录选中名，显空态或全部）。
 */
export function openWorkflow(workflowName?: string): void {
  drawerControl.setWorkflowView(workflowName ?? '')
}

/**
 * 重置 drawer 全部状态（测试隔离用）：control 分区 + 瞬时参数。
 * 生产代码禁止调用。renderer 兼容层 resetSideDrawer() 委托本函数。
 */
export function _resetDrawerForTest(): void {
  _resetDrawerControlForTest()
  selectedCommandName.value = null
  detailFilePath.value = null
  browserUrl.value = null
}
