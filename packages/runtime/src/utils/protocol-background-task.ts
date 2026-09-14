/**
 * `@xyz-agent/extension-protocol/background-task` 子出口的 runtime 侧统一入口
 * （纯 named re-export）。
 *
 * 历史（ext-simplify-13）：protocol 包曾缺 `"type": "module"` 声明，其 `export *`
 * 聚合在 node tsx 源码链被按 CJS interop 加载、named exports 无法静态分析，本文件
 * 一度承担「CJS interop 真身优先 / ESM namespace 兜底」的运行时探测；protocol 补
 * 声明后（对照先例 pi-file-lock）按预留退路简化为纯 re-export。文件保留使 runtime
 * 消费方（background-task-reaper / registry-write / output-tail / background-task-
 * service）的 import 路径单点——protocol 出口形态再调整时只动此处。
 */

export {
  // 进程原语（background-task-process.ts）
  isPidAlive,
  killProcessTree,
  getProcessStartTimeSec,
  pidStartMatchesRegistered,
  type ProcessFallbackLogger,
  // registry 文件原语（background-task-registry-file.ts）
  readRegistry,
  atomicWriteRegistry,
  serializeRegistryFile,
  trimTerminalEntries,
  type RegistryFileLogFn,
  type TrimTerminalEntryLike,
  // 输出 tail 原语（output-tail.ts）
  readOutputTail,
  type OutputTailLogFn,
  type OutputTailOptions,
  type OutputTailResult,
} from '@xyz-agent/extension-protocol/background-task'
