// src/logs/stderr-rotation.ts
//
// zcode app-server stderr tee 的实例维度文件名 + 轮转 + 过期清理（W11，impl-plan
// §2.11 / 设计 §3.9 写入面表「宿主侧引擎 stderr」行）——SDK 单源实现的薄包装
// （只绑定 zcode 前缀常量；实现与契约见
// @zhushanwen/subagent-engine-sdk logs/stderr-rotation.ts）。
//
// 为什么文件名带 pid：同一路径双实例（pi 宿主 + runtime 各持一个引擎 CLI，各 spawn
// 一个 app-server）并发 append + 轮转 rename 会互相竞争——文件名带写入方 app-server
// pid 后双实例天然互不干扰。

import {
  cleanupStaleStderrLogs as sdkCleanupStaleStderrLogs,
  cleanupSiblingStderrLogs as sdkCleanupSiblingStderrLogs,
  stderrLogPathFor as sdkStderrLogPathFor,
  stderrLogPidOf as sdkStderrLogPidOf,
} from "@zhushanwen/subagent-engine-sdk";

/** stderr tee 文件名前缀（实例维度 = app-server pid）。 */
export const ZCODE_STDERR_LOG_PREFIX = "zcode-appserver-stderr-";

export {
  DEFAULT_STDERR_KEEP_DAYS,
  DEFAULT_STDERR_MAX_BYTES,
  isPidAlive,
  rotateStderrLogIfNeeded,
  stderrRotationParams,
} from "@zhushanwen/subagent-engine-sdk";
export type { CleanupResult, StderrRotationParams } from "@zhushanwen/subagent-engine-sdk";

/** 实例维度 stderr tee 路径：<engineDataDir>/logs/zcode-appserver-stderr-<pid>.log。 */
export function stderrLogPathFor(engineDataDir: string, pid: number): string {
  return sdkStderrLogPathFor(engineDataDir, pid, ZCODE_STDERR_LOG_PREFIX);
}

/** 从文件名解析实例 pid（非本前缀形态返回 undefined——调用方跳过）。 */
export function stderrLogPidOf(fileName: string): number | undefined {
  return sdkStderrLogPidOf(fileName, ZCODE_STDERR_LOG_PREFIX);
}

/** 过期清理（三判据：同前缀 + pid 已死 + mtime 过期；目录缺失零删除 best-effort）。 */
export function cleanupStaleStderrLogs(
  logsDir: string,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): { deleted: number; skipped: number } {
  return sdkCleanupStaleStderrLogs(logsDir, env, ZCODE_STDERR_LOG_PREFIX, now);
}

/** 便捷入口：对 tee 路径所在 logs 目录做过期清理（流打开时机调用，每代一次）。 */
export function cleanupSiblingStderrLogs(
  logPath: string,
  env: NodeJS.ProcessEnv,
  now?: number,
): { deleted: number; skipped: number } {
  return sdkCleanupSiblingStderrLogs(logPath, env, ZCODE_STDERR_LOG_PREFIX, now);
}
