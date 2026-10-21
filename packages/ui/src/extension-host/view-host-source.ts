/**
 * view-host-source.ts —— ViewHost 组件的数据源注入接口（W3 · T1，C2 契约）。
 *
 * 对齐 S2 plan IF10（ViewHostStore）消费方：getView(sessionId, viewId)。
 * S2 的 ViewHostStore 类尚未交付（S2 W4 headless-consumers），本接口即 ui 侧消费契约：
 * 壳（P5）在 S2 落地后把真 store 适配注入（S4 TC4），单测注入 mock 实现。
 *
 * ViewCacheEntry 形状对齐 S2 IF10：viewId/pluginId/guiTree/updatedAt。
 * guiTree 用 @zhushanwen/extension-protocol 的权威 GuiComponent 类型（P2 GuiComponentRenderer
 * 同源——core types.ts 的 WidgetPayload.guiTree 尚为 unknown[]，S2 W4 落地时替换为
 * GuiComponent[]，本接口按 S2 IF10 契约先行）。
 */
import type { InjectionKey } from 'vue'
import type { GuiComponent, WidgetMeta } from '@zhushanwen/extension-protocol'

/** plugin view 的 GuiComponent 树缓存条目（对齐 S2 IF10 ViewCacheEntry）。 */
export interface ViewCacheEntry {
  viewId: string
  pluginId: string
  guiTree: GuiComponent[]
  /** widget 宿主元数据（v1.1 wire 携带，托盘 widget 面板 head 渲染） */
  meta?: WidgetMeta
  updatedAt: number
}

/** ViewHost 数据源（对齐 S2 IF10 ViewHostStore 消费方）。 */
export interface ViewHostSource {
  getView(sessionId: string, viewId: string): ViewCacheEntry | undefined

  /**
   * 枚举该 session 当前缓存的全部 viewId（widgetKey 原值），供 widget 消费端
   * （composer 任务托盘的协议 widget 区）枚举拼装条目。core ViewHostStore 已有同名实现
   * （view-host-store.ts getViewIds），壳侧 provide 纯透传。
   */
  getViewIds(sessionId: string): string[]

  /**
   * 分区缺失自举补拉（ADR-0097「拉为主、推补充」事件边沿拉，可选）：ViewHost 挂载发现
   * 该 (sessionId, viewId) 分区无内容时调用——壳实现按同键过滤拉取插件 UI 快照并写回
   * store（幂等读）。推送型数据丢失（transient 帧不入 ring）后的组件级收敛通道。
   */
  refreshView?(sessionId: string, viewId: string): void
}

/** provide/inject key——壳 provide，组件 inject，单测 global.provide mock。 */
export const VIEW_HOST_SOURCE_KEY: InjectionKey<ViewHostSource> = Symbol('view-host-source')
