// src/execution/engine/common/nesting-guard.ts
//
// 嵌套防护（跨进程 env 标记 + 进程内 ALS 深度计数）的 re-export shim：实现体单源
// @zhushanwen/subagent-engine-sdk（自本文件逐字等价移入 SDK，s4-reuse 簇 2；
// 设计权威源 D8 / D3-⑤ 注释随实现留在 SDK 侧）。core 内消费方（subagent-service
// 与本目录测试）import 路径保持不变。唯一行为差异：assertNotNestedSpawn 抛
// NestedSpawnRejectedError（SDK 形态，code/recovery 文案逐字一致）而非 core
// EngineError——该函数在 core 非测试代码零调用方，错误类形态差异无生产影响。
// 错误类随 shim 一并导出（本目录测试断言消费；core barrel 不转发本模块，无对外
// 导出面影响）。

export {
  assertNotNestedSpawn,
  buildNestedSpawnEnv,
  ExecutionNestingContext,
  type ExecutionNestingState,
  NestedSpawnRejectedError,
  NESTED_SPAWN_ENV,
  type SpawnEnv,
} from "@zhushanwen/subagent-engine-sdk";
