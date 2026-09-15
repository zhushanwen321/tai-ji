/**
 * views-source.ts —— PluginViewContainer 组件的数据源注入接口（W4 · T1）。
 *
 * 对齐同目录 view-host-source.ts 范式（注入 key + 接口契约）：
 * 壳（renderer useExtensionHostBridge）provide 真实实现（经 ContributionRegistry
 * 查询 sidebar.tab 视图贡献，见 renderer 侧 T6 接线），单测 global.provide mock。
 *
 * 与 ViewHostSource（getView(sessionId, viewId) 按需取单 view 的 GuiComponent 树）不同，
 * 本接口是 L2 二级 tab 的清单源：一次取全部 plugin view 摘要（标题/可见性/所属 plugin），
 * 供 PluginViewContainer 渲染 tab 栏 + 路由到 ViewHost。
 */
import type { InjectionKey } from 'vue'

/** plugin view 摘要（L2 二级 tab 数据源条目）。 */
export interface PluginViewSummary {
  viewId: string
  title: string
  /** 图标名（当前贡献侧无图标源，壳透传 undefined；组件按 viewId 内置字典兜底） */
  icon?: string
  initialVisibility: 'visible' | 'hidden'
  /** 所属 plugin（builtin 判定依据：'tasks' 为 builtin，不可关闭） */
  pluginId: string
}

/** PluginViewContainer 数据源。 */
export interface PluginViewsSource {
  /** 取该 session 可见的 view 清单（静态声明；per-session 形参保留接口兼容，当前实现忽略）。 */
  getViews(sessionId: string): PluginViewSummary[]
}

/** provide/inject key——壳 provide，组件 inject，单测 global.provide mock。 */
export const VIEWS_SOURCE_KEY: InjectionKey<PluginViewsSource> = Symbol('views-source')
