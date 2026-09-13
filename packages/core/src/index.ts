// @xyz-agent/core — 平台无关内核（headless）。P0 骨架阶段。
// 详见 docs/architecture/renderer-package-topology.md §3（包拓扑）/§4（core 内部分层）。
// Vue reactivity 可用（双端 Vue），零 DOM / 零 electron / 零浏览器 API 直连（经 PlatformPort 注入）。
export * from './bootstrap'
export * from './extension-host'
export * from './platform/port'
export * from './platform/dev-mode'
export * from './coordination'
export * from './transport/ws-client'
export * from './transport/use-connection'
export * from './domain/chat'
export * from './domain/session'
export * from './domain/new-task-search'
export * from './domain/settings'
export * from './utils/error-message'
