// Hook 域消费薄壳（D28 方向反转，2026-09-05）：
// single source of truth = packages/plugin-sdk/src/types.ts（Hook 域段落）。
// 本文件原内联定义已上收 SDK，此处仅 re-export 保持既有
// `from './plugin-types/hook-types.js'` 导入面不变（消费方零改动）。
//
// 分层标注（IF2）沿承 SDK 侧定义：
// - @proposed — Hook 机制整体为 Phase 2 扩展面（API 表面仍在演进）
// - @internal — runtime 内部执行细节（HookResult 等主线程塑形）
export type {
  InterceptorHookType,
  ObserverHookType,
  HookType,
  InterceptorResult,
  HookContext,
  HookInterceptor,
  HookObserver,
  PiEventCallback,
  HookResult,
} from 'taiji-plugin-sdk'
