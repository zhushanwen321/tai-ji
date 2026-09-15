// src/logs/stderr-rotation.ts
//
// pi 任务子进程 stderr tee 的实例维度文件名 + 轮转 + 过期清理——SDK 单源实现的
// 薄包装（只绑定 pi 前缀常量；实现与契约见
// @zhushanwen/subagent-engine-sdk logs/stderr-rotation.ts）。
//
// 落点背景：pi 任务子进程（pi --mode rpc）的 stderr 经 SDK spawnEngineChild pipe
// 出来后此前无消费面（静默丢弃，且 pipe 写满会背压卡死子进程）——本模块提供
// 落盘 tee（文件名带任务子进程 pid，同 dataDir 双实例互不干扰）。

import {
  cleanupStaleStderrLogs as sdkCleanupStaleStderrLogs,
  cleanupSiblingStderrLogs as sdkCleanupSiblingStderrLogs,
  stderrLogPathFor as sdkStderrLogPathFor,
  stderrLogPidOf as sdkStderrLogPidOf,
} from "@zhushanwen/subagent-engine-sdk";

/** stderr tee 文件名前缀（实例维度 = 任务子进程 pid）。 */
export const PI_STDERR_LOG_PREFIX = "pi-task-stderr-";

export {
  DEFAULT_STDERR_KEEP_DAYS,
  DEFAULT_STDERR_MAX_BYTES,
  isPidAlive,
  rotateStderrLogIfNeeded,
  stderrRotationParams,
} from "@zhushanwen/subagent-engine-sdk";
export type { CleanupResult, StderrRotationParams } from "@zhushanwen/subagent-engine-sdk";

/** 实例维度 stderr tee 路径：<engineDataDir>/logs/pi-task-stderr-<pid>.log。 */
export function stderrLogPathFor(engineDataDir: string, pid: number): string {
  return sdkStderrLogPathFor(engineDataDir, pid, PI_STDERR_LOG_PREFIX);
}

/** 从文件名解析实例 pid（非本前缀形态返回 undefined——调用方跳过）。 */
export function stderrLogPidOf(fileName: string): number | undefined {
  return sdkStderrLogPidOf(fileName, PI_STDERR_LOG_PREFIX);
}

/** 过期清理（三判据：同前缀 + pid 已死 + mtime 过期；目录缺失零删除 best-effort）。 */
export function cleanupStaleStderrLogs(
  logsDir: string,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): { deleted: number; skipped: number } {
  return sdkCleanupStaleStderrLogs(logsDir, env, PI_STDERR_LOG_PREFIX, now);
}

/** 便捷入口：对 tee 路径所在 logs 目录做过期清理（流打开时机调用，每代一次）。 */
export function cleanupSiblingStderrLogs(
  logPath: string,
  env: NodeJS.ProcessEnv,
  now?: number,
): { deleted: number; skipped: number } {
  return sdkCleanupSiblingStderrLogs(logPath, env, PI_STDERR_LOG_PREFIX, now);
}
