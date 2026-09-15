/**
 * composer context 模块入口 —— core/domain/composer/context/ 的公开 API 聚合（W3）。
 *
 * 定位：p3-strangler-domains::composer W3 产物。三个模块迁入 core：
 * - injection-store：drawer 注入的「一次性消息通道」store（createComposerInjectionStore factory 范式）
 * - context-chips：Composer 顶部「已附上下文」chip 行状态派生
 * - injection：Composer 侧消费注入请求（target 路由 + file/text chip 注入）
 *
 * barrel 用 export * 自动 re-export 各模块已 export 的符号。InjectionDeps 从 injection.ts export，
 * PendingInjection/InjectionRequest/InjectionTarget/ComposerInjectionStore/PendingInjectionRef 从 injection-store export。
 */
export * from './context-chips'
export * from './injection-store'
export * from './injection'
// 注意：ComposerInputInstance 由 composer 域 barrel（index.ts 的 export * from './types'）导出，
// 此处不再 re-export（TS2308 冲突）。
