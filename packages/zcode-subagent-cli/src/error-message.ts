// src/error-message.ts
//
// toErrorMessage re-export shim——单源在 @zhushanwen/subagent-engine-sdk
// （round1-reuse R11 微副本收编；原引擎包自持副本删除，引擎 CLI → SDK 边界正向合法）。
//
// [A8 修复]：非 Error 的 object 入参经 SDK 单源输出 JSON 结构化文本（原
// String(e) = "[object Object]"）；Error 入参输出逐字节不变。

export { toErrorMessage } from "@zhushanwen/subagent-engine-sdk";
