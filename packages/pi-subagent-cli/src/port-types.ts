// src/port-types.ts
//
// EnginePort / RunContext / EngineRunResult 的引擎包契约面——re-export shim
// （S4 簇 1 收编：W7 迁移承接的本地镜像七符号 + server.ts 的 parseCtxModel 单源
// 收编 SDK port-contract；本包 import 点零改写）。
//
// 原头注「本地镜像而非 SDK 契约」的理由已随收编消解：这是 W5/W7 双轨沉淀后的
// 收编——RunContext 含 AbortSignal/回调/EngineStream 非序列化成员，SDK 侧收主
// barrel 而非 protocol/ 子入口（protocol/ 是 semver 收窄的跨进程可序列化面，
// 跨进程面经 server.ts 帧映射）。字段与 core src/execution/engine/port.ts 的
// 漂移面由 W10 conformance 套件继续覆盖（core 侧宿主契约不收编）。
//
// 命名：全量任务声明 SDK 侧名 EngineAgentCallOpts（SDK 主 barrel 已有 protocol
// 的 AgentCallOpts 引擎面子集，同名不可共存），shim 转名保本包消费面不变。

export type {
  EngineAgentCallOpts as AgentCallOpts,
  EngineCtxModel,
  EngineStream,
  RunContext,
  EngineHandle,
  EngineRunResult,
  EnginePort,
} from "@zhushanwen/subagent-engine-sdk";

export { parseCtxModel } from "@zhushanwen/subagent-engine-sdk";
