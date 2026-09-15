/**
 * session 域入口 —— @taiji/core 的 session 列表域（p3-strangler-domains W1）。
 *
 * 承接架构文档 §10.2（旧层 → core/domain/* 映射）：renderer stores/session.ts 迁移为
 * 纯 factory createSessionStore；IF2 SessionApiPort（TC2 后端通道）；IF3 panel 编排契约
 * （C-SS-3，PanelOrchestrationPort 端口）。[P4 s5 drawer-widget-removal] openPanelOnSessionEvent
 * + pendingOpen 路由已随 tasks 域删除移除（PluginViewContainer 承接）。renderer 消费方迁移为后续
 * WorkUnit，旧 store/composable 保留至消费方全部迁移后删除（strangler 逐域绞杀）。
 */
export * from './store'
export * from './api-port'
// panel-view：PanelView/derivePanelView（渲染视图派生契约，T3 renderer usePanelView 消费）
export * from './panel-view'
// w3 use-session：IF4 编排 factory + 端口/hook 类型
export { createUseSession, resetSessionListSubForTest } from './use-session'
export type {
  UseSessionDeps,
  SessionCleanupHooks,
  ChatHydratePort,
  NavigationPort,
  NavigationRoute,
  NewTaskFlowPort,
} from './use-session'
// w4 create-session-flow：IF5 session 创建编排原语（C-SS-2）
export { createSessionFlow, migrateImageSegments } from './create-session-flow'
export type {
  CreateSessionFlowCtx,
  CreateSessionFlowInput,
  CreateSessionFlowResult,
  MigrateImageFn,
  MigrateImageSegmentsResult,
} from './create-session-flow'
