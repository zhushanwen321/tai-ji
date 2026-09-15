// src/best-effort.ts
//
// bestEffort re-export shim——单源在 @zhushanwen/subagent-engine-sdk（round1-reuse
// R11 微副本收编；原引擎包自持副本删除，引擎 CLI → SDK 边界正向合法）。日志面
// 同走 SDK logger facade（经 host/log 反向通道上报 + stderr 兜底），行为不变。

export { bestEffort, type BestEffortLevel } from "@zhushanwen/subagent-engine-sdk";
