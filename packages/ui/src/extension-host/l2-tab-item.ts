/**
 * l2-tab-item.ts —— L2TabBar 的 tab 条目类型 + L2 宿主注入契约（W4 · T2 + D4②/D4④）。
 *
 * 对齐 extension-host 层类型归位范式（view-host-source.ts / status-bar-source.ts
 * 等契约类型均落独立 .ts 文件，组件不导出类型——*.vue 模块命名导出
 * 在 tsc 下不可见）。
 *
 * D4②/D4④ 注入契约也落本文件（领地内唯一 extension-host 契约 .ts）：依赖方向是
 * renderer → ui，ui 包不能静态 import renderer 原生组件（BackgroundTaskListView），
 * 也读不到 renderer 侧的分桶状态——两者统一走「契约在 ui、真实实现由壳 provide」
 * 的既有注入范式（VIEWS_SOURCE_KEY / VIEW_HOST_SOURCE_KEY 同款）。
 */
import type { Component, InjectionKey } from 'vue'

/** 单个二级 tab 条目。 */
export interface L2TabItem {
  viewId: string
  title: string
  /** 已解析的 lucide 图标组件（父层字典映射后传入）；无则纯文字 tab */
  icon?: Component
  /** pinned 态（父层本地 ref 维护，不持久化）——pinned 时 pin 按钮 accent + 常显 */
  pinned?: boolean
  /** builtin view（tasks / base-tool-enhance plugin）不渲染 close 按钮 */
  builtin?: boolean
  /**
   * badge 小圆点（background-task-sidebar-view D4④）：点亮条件 = 该 view 关联的
   * 「运行中」桶计数 > 0（与 renderer 分桶 SSOT countBackgroundTasks 同源派生，
   * 数据由壳经 L2_TAB_BADGE_SOURCE_KEY 注入——ui 层只做 boolean → 圆点渲染，
   * 禁止在 ui 层二次实现分桶判定）。
   */
  badge?: boolean
}

/**
 * L2 原生视图注册表（background-task-sidebar-view D4②）。
 *
 * viewId → 原生 Vue 组件；PluginViewContainer 的 activeView 命中键即渲染原生组件
 * 替代 ViewHost（GuiComponent 树），不命中走原路径（对既有 view 零影响）。
 * 设计原文是「ui 包内模块级 NATIVE_VIEWS 静态 Record」，但 BackgroundTaskListView
 * 在 renderer 包——ui 静态引用会反向成环（renderer → ui），故收窄为注入契约：
 * 壳（renderer useExtensionHostBridge）provide 真实映射，生产未接线时 inject 缺省
 * 空表 → 全部 view 走 ViewHost 原路径（回归安全）。
 */
export const NATIVE_VIEWS_KEY: InjectionKey<Readonly<Record<string, Component>>> = Symbol(
  'l2-native-views',
)

/**
 * L2 tab badge 数据源（background-task-sidebar-view D4④）。
 *
 * 入参 sessionId（焦点 session），返回 viewId → 是否点亮。点亮条件在壳侧实现 =
 * 「运行中」桶计数 > 0，与 renderer 分桶 SSOT（countBackgroundTasks）同源派生
 * （D4④：badge 亮 = 默认桶非空，防「badge 点亮而默认视图是历史」语义断裂）。
 * 函数在 PluginViewContainer 的 tabs computed 内调用——壳实现内部读取的响应式
 * 状态会被追踪，状态变化自动反映到 tab 圆点。未注入时全部 tab 不亮（生产接线
 * 前回归安全）。
 */
export const L2_TAB_BADGE_SOURCE_KEY: InjectionKey<
  (sessionId: string) => Readonly<Record<string, boolean>>
> = Symbol('l2-tab-badge-source')
