/**
 * view-host-source.ts —— ViewHost 组件的数据源注入接口（W3 · T1，C2 契约 + U2 scope 消费面）。
 *
 * 对齐 core ViewHostStore（U2 起 per-scope 分区）：会话域三法（getSessionId 形态，托盘
 * widget 区既有消费方沿用）+ scope 联合两法（ViewHost scope prop 消费，Provider 页等
 * 全局域挂载位走此路径）。两族方法落同一 store 分区（会话域 scope 串 = session:<id>），
 * 只是参数形态不同——ui 侧契约先行，壳（P5）provide 真实实现，单测注入 mock 实现。
 *
 * ViewCacheEntry 形状对齐 core view-host-store：viewId/pluginId/guiTree/updatedAt
 * （+ meta / generation 可选）。guiTree 用 @zhushanwen/extension-protocol 的权威
 * GuiComponent 类型（P2 GuiComponentRenderer 同源）。
 */
import type { InjectionKey } from 'vue'
import type { GuiComponent, WidgetMeta } from '@zhushanwen/extension-protocol'
import type { PluginViewScope } from '@taiji/shared'

/** plugin view 的 GuiComponent 树缓存条目（对齐 core ViewHostStore ViewCacheEntry）。 */
export interface ViewCacheEntry {
  viewId: string
  pluginId: string
  guiTree: GuiComponent[]
  /** widget 宿主元数据（v1.1 wire 携带，托盘 widget 面板 head 渲染） */
  meta?: WidgetMeta
  /** 全量替换代际（U2，plugin:viewUpdate 源携带；extension:widget 纯文本源无） */
  generation?: number
  updatedAt: number
}

/** ViewHost 数据源（会话域三法 + U2 scope 联合两法，落同一 store 分区）。 */
export interface ViewHostSource {
  /** 会话域读（托盘 widget 区既有消费方；等价 getView({ kind:'session', sessionId })） */
  getView(sessionId: string, viewId: string): ViewCacheEntry | undefined

  /**
   * 枚举该 session 当前缓存的全部 viewId（widgetKey 原值），供 widget 消费端
   * （composer 任务托盘的协议 widget 区）枚举拼装条目。core ViewHostStore 已有同名实现
   * （view-host-store.ts getViewIds），壳侧 provide 纯透传。
   */
  getViewIds(sessionId: string): string[]

  /**
   * 会话域分区缺失自举补拉（ADR-0097「拉为主、推补充」事件边沿拉，可选）：ViewHost
   * 挂载发现该 (sessionId, viewId) 分区无内容时调用——壳实现按同键过滤拉取插件 UI 快照
   * 并写回 store（幂等读）。推送型数据丢失（transient 帧不入 ring）后的组件级收敛通道。
   */
  refreshView?(sessionId: string, viewId: string): void

  /**
   * scope 联合读（U2）：ViewHost scope prop 消费；全局域挂载位（Provider 页）经此读
   * `global:<mountId>:<pluginId>` 分区，会话域与上方 getView 同分区。
   */
  getViewInScope?(scope: PluginViewScope, viewId: string): ViewCacheEntry | undefined

  /**
   * scope 联合自举补拉（U2，可选）：语义同 refreshView，键为 scope 联合——全局域按
   * { mountId, pluginId, viewId } 过滤拉取。
   */
  refreshViewInScope?(scope: PluginViewScope, viewId: string): void
}

/** provide/inject key——壳 provide，组件 inject，单测 global.provide mock。 */
export const VIEW_HOST_SOURCE_KEY: InjectionKey<ViewHostSource> = Symbol('view-host-source')
