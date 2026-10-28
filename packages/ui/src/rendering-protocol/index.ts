/**
 * ui 包 rendering-protocol 层导出清单（IF2）。
 *
 * 导出 GuiComponentRenderer（7 原语渲染路由器）+ 透传 core 的 resolve 纯函数与注册表机制
 * （resolveComponent / ResolvedRender / GUI_CUSTOM_REGISTRY_KEY / EMPTY_CUSTOM_REGISTRY /
 * isCustomRegistered，权威定义在 @taiji/core/rendering-protocol）。
 *
 * 降级 SSOT 在 core（§7.2）：ui 组件（GuiComponentRenderer / PrimitiveRouter）直接 import
 * 并调用 resolveComponent，type 路由 + AnsiText 降级 + props 适配全部由 core 提供，
 * ui 层不再持有独立的降级逻辑。
 */
// AnsiText 例外暴露：它是通用 ANSI 文本渲染器（GuiComponentRenderer 的 ansi-text type
// 与 ansi-fallback 均用它），外部原始 ANSI 文本消费（Block bash output / SideDrawer
// status text）是其合法第二用途（IF3：优先复用 rendering-protocol 消费方，行为一致优先）。
// 其余 6 原语（Card/Columns/ListTree/ProgressBar/StatsLine/TabBar）不暴露，仅经 barrel
// 供 GuiComponentRenderer 内部消费（TC2 总则：原语是 RenderingProtocol 内部实现细节）。
export { default as AnsiText } from './primitives/AnsiText.vue'
export { default as GuiComponentRenderer } from './GuiComponentRenderer.vue'
// action-bar 执行器注入契约（AP-3）：壳层 provide 真实实现（useExtensionHostBridge），
// Actionbar.vue 内部 inject 同一 key——key symbol 必须跨包同一实例，故经 barrel 导出给消费方
export { ACTION_EXECUTOR_KEY } from './action-executor-key'
export type { ActionExecutor, ActionArgs } from './action-executor-key'
// 容器导航执行器注入契约（容器扩展点统一 §6.4）：壳层 provide core 执行器实例（结构同构
// 零适配），Actionbar/ListTree 内部 inject 同一 key；VIEW_SCOPE_SESSION_KEY 由 ViewHost
// 按视图 scope provide（会话注入第一档）。symbol 跨包同一实例，经 barrel 导出
export {
  CONTAINER_NAVIGATION_KEY,
  VIEW_SCOPE_SESSION_KEY,
  dispatchTreeInteraction,
} from './container-navigation-key'
export type {
  ContainerNavigationExecutor,
  NavigateOptions,
} from './container-navigation-key'
// text-input 值回传注入契约（provider-plugin-access D8）：mount 点容器 provide（它同时掌握
// pluginId + viewId），TextInput.vue inject 同一 key——key symbol 必须跨包同一实例
export { UI_EVENT_SENDER_KEY } from './primitives/ui-event-sender-key'
export type { UiEventSender } from './primitives/ui-event-sender-key'
export {
  resolveComponent,
  type ResolvedRender,
} from '@taiji/core/rendering-protocol'
export {
  GUI_CUSTOM_REGISTRY_KEY,
  EMPTY_CUSTOM_REGISTRY,
  isCustomRegistered,
} from '@taiji/core/rendering-protocol/custom-registry'
