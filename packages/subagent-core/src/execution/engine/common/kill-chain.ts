// src/execution/engine/common/kill-chain.ts
//
// 超时杀链与 abort 两级中断的 re-export shim：实现体单源
// @zhushanwen/subagent-engine-sdk（自本文件逐字等价移入 SDK，s4-reuse 簇 1；
// core → SDK 边界正向合法，设计权威源 D1/§3.3.3 注释随实现留在 SDK 侧）。
// core 内消费方（subprocess-agent-runner 与本目录测试）import 路径保持不变。
// 唯一签名差异：SDK 版 synthesizeTimeoutOutcome 第 3 参 engineId 必填
//（core 原缺省 DEFAULT_ENGINE_ID="pi" 的隐式行为随收编删除——core 非测试
// 代码零调用方，无生产行为影响）。

export {
  abortWithFallback,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_NATIVE_INTERRUPT_GRACE_MS,
  HOST_TIMEOUT_ABORT_REASON,
  killChain,
  type KillableChild,
  type KillChainOptions,
  synthesizeTimeoutOutcome,
} from "@zhushanwen/subagent-engine-sdk";
