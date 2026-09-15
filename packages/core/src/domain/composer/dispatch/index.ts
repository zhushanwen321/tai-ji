/**
 * composer dispatch 模块入口 —— core/domain/composer/dispatch/ 的公开 API 聚合（W3）。
 *
 * 定位：p3-strangler-domains::composer W3 产物。staging/submit/bash/send/fork-mode/handoff-mode
 * 六个 composable 迁入 core，经 deps 注入跨域能力（chatStore/useChat/useSidebar 等），零 renderer import。
 * fork-mode/handoff-mode 的共享行为骨架在 ./staging-mode（D8 泛化）——dispatch 内部模块，
 * 不经 barrel 导出（公共面不宣告内部骨架）。
 *
 * barrel 用 export * 自动 re-export 各模块已 export 的符号：六个 composable + 已 export 的
 * deps 接口（ComposerSendDeps/ForkDeps/HandoffDeps）。ComposerSubmitDeps 未 export，
 * 保留 submit 模块内部，壳层构造该 deps 时靠 TS 结构匹配推断。
 */
export * from './staging'
export * from './submit'
export * from './bash'
export * from './send'
// [session-occupancy u5b / D6] 发送路由表纯函数（sessionPhase → sendRoute，统一发送分发器判定核心）
export * from './send-route'
export * from './fork-mode'
export * from './handoff-mode'
