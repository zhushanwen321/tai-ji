// src/best-effort.ts
//
// best-effort IO 清理的错误吞咽 helper 单源（round1-reuse R11 微副本收编，实现体
// 自 core src/execution/best-effort.ts 迁移；pi 引擎包 best-effort.ts 副本自本模块
// re-export 收编。core 版保留自持：其 logger 经 configureCore HostServices 通道解析，
// 与 SDK LoggerSink 通道是真差异，非可消副本）。
//
// 用途：sidecar 写入 / worktree remove / alive marker 删除等次要 IO，失败不影响
// 主流程（session 已完成或正在收尾）。这类 catch 故意吞错——但 taste/no-silent-catch
// 规则禁止空 catch 或仅 console 的 catch。本 helper 提供一条「实质调用语句」让
// catch 合规，同时把错误记录到 debug/error 便于排查（经共享 logger 路由，不裸 console）。

import { getLogger } from "./logger.ts";

const logger = getLogger("subagents");

/** 错误日志级别。debug = 次要清理（默认）；error = 关键步骤但需继续后续清理。 */
export type BestEffortLevel = "debug" | "error";

/**
 * 吞咽 best-effort IO 的错误，按 level 经共享 logger 记录。
 *
 *   - debug（默认）：次要清理（sidecar/worktree/alive marker），失败属预期路径
 *   - error：关键步骤抛错但需继续后续清理（如 finalizeRecord 的 B9 链：completeRecord
 *     抛错后仍要执行 finalized/cleanup，错误需可见但不阻断）
 *
 * 错误对象优先取 message（避免打印巨大堆栈/对象），其他类型原样传入。
 */
export function bestEffort(err: unknown, context: string, level: BestEffortLevel = "debug"): void {
  const detail = err instanceof Error ? err.message : err;
  const msg = `[subagents] best-effort ${context} failed`;
  if (level === "error") {
    logger.error(msg, { detail });
  } else {
    logger.debug(msg, { detail });
  }
}
