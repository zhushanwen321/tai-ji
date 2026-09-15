/**
 * toErrorMessage re-export shim——单源在 @zhushanwen/subagent-engine-sdk
 * （round1-reuse R11 微副本收编；core → SDK 边界正向合法）。本文件路径不变，
 * core 内部 8 个消费方 import 不动。
 *
 * [A8 修复]：非 Error 的 object 入参经 SDK 单源输出 JSON 结构化文本（原
 * String(e) = "[object Object]"）；Error 入参输出逐字节不变。core barrel 不导出
 * 该符号（导出面零变化）。
 */
export { toErrorMessage } from "@zhushanwen/subagent-engine-sdk";
