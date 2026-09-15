// src/logs/stderr-rotation.ts
//
// 引擎侧 stderr tee 的实例维度文件名 + 轮转 + 过期清理（单源实现，前缀参数化——
// 两引擎包（pi-subagent-cli / zcode-subagent-cli）各自的 logs/stderr-rotation.ts
// 是本模块的薄包装，只绑定各自前缀常量）。
//
// 清理三判据（三者同时成立才删，缺一不删）：
//   1. 同前缀（调用方绑定）；2. pid 已死（process.kill(pid,0) 跨实例探测，存活实例
//   的文件一律不删）；3. mtime 过期（TAIJI_LOG_KEEP_DAYS，缺省 7 天）。
// 轮转参数读宿主同款 env：TAIJI_LOG_MAX_BYTES（缺省 50MB）/ TAIJI_LOG_KEEP_DAYS。

import * as fs from "node:fs";
import { dirname, join } from "node:path";

/** 缺省轮转阈值（与宿主 logger 同源缺省：50MB）。 */
const BYTES_PER_KB = 1024;
const DEFAULT_MAX_FILE_MB = 50;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

export const DEFAULT_STDERR_MAX_BYTES = DEFAULT_MAX_FILE_MB * BYTES_PER_KB * BYTES_PER_KB;

const DAY_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** 缺省保留天数（与宿主 logger 同源缺省：7 天）。 */
export const DEFAULT_STDERR_KEEP_DAYS = 7;

/** 轮转参数（env 覆盖面 = 宿主 logger 同款 TAIJI_LOG_* 两键）。 */
export interface StderrRotationParams {
  maxBytes: number;
  keepDays: number;
}

function positiveIntEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 读 env 解析轮转参数（非法值回缺省——取证面配置不拖垮主通道）。 */
export function stderrRotationParams(env: NodeJS.ProcessEnv): StderrRotationParams {
  return {
    maxBytes:
      positiveIntEnv(env, "TAIJI_LOG_MAX_BYTES") ?? DEFAULT_STDERR_MAX_BYTES,
    keepDays:
      positiveIntEnv(env, "TAIJI_LOG_KEEP_DAYS") ?? DEFAULT_STDERR_KEEP_DAYS,
  };
}

/** 实例维度 stderr tee 路径：<engineDataDir>/logs/<prefix><pid>.log。 */
export function stderrLogPathFor(engineDataDir: string, pid: number, prefix: string): string {
  return join(engineDataDir, "logs", `${prefix}${pid}.log`);
}

/** 从文件名解析实例 pid（非本前缀形态返回 undefined——调用方跳过）。 */
export function stderrLogPidOf(fileName: string, prefix: string): number | undefined {
  if (!fileName.startsWith(prefix)) return undefined;
  const rest = fileName.slice(prefix.length);
  // 兼容轮转副本形态 <pid>.log.<timestamp>
  const pidToken = rest.split(".", 1)[0] ?? "";
  if (!/^\d+$/.test(pidToken)) return undefined;
  return Number(pidToken);
}

/** pid 存活探测（跨实例：ESRCH = 死；EPERM = 存活但非属主，按存活保守处理）。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 尺寸轮转：当前文件超过 maxBytes 时 rename 为 `<path>.<时间戳>` 副本并返回
 * true（调用方懒重开新文件继续 append）。rename 失败返回 false（继续 append 原
 * 文件——轮转是取证面优化，不是主通道）。
 */
export function rotateStderrLogIfNeeded(
  path: string,
  params: StderrRotationParams,
): boolean {
  let size: number;
  try {
    size = fs.statSync(path).size;
  } catch {
    return false;
  }
  if (size <= params.maxBytes) return false;
  const rotated = `${path}.${Date.now()}`;
  try {
    fs.renameSync(path, rotated);
    return true;
  } catch {
    return false;
  }
}

export interface CleanupResult {
  /** 已删除文件数。 */
  deleted: number;
  /** 命中前缀但跳过（pid 存活 / mtime 未过期 / 探测不确定）的文件数。 */
  skipped: number;
}

/**
 * 过期清理：扫描 logsDir 下同前缀文件，三判据同时成立才删。目录缺失/读失败返回
 * 零删除（取证面 best-effort）。
 */
export function cleanupStaleStderrLogs(
  logsDir: string,
  env: NodeJS.ProcessEnv,
  prefix: string,
  now: number = Date.now(),
): CleanupResult {
  const params = stderrRotationParams(env);
  const expiryMs = params.keepDays * DAY_MS;
  let deleted = 0;
  let skipped = 0;
  let names: string[];
  try {
    names = fs.readdirSync(logsDir);
  } catch {
    return { deleted, skipped };
  }
  for (const name of names) {
    const pid = stderrLogPidOf(name, prefix);
    if (pid === undefined) continue;
    // 判据 2：pid 存活 → 该实例的文件（含轮转副本）一律不删
    if (isPidAlive(pid)) {
      skipped += 1;
      continue;
    }
    // 判据 3：mtime 未过期 → 保留
    const full = join(logsDir, name);
    try {
      if (fs.statSync(full).mtimeMs > now - expiryMs) {
        skipped += 1;
        continue;
      }
    } catch {
      continue;
    }
    try {
      fs.rmSync(full, { force: true });
      deleted += 1;
    } catch {
      skipped += 1;
    }
  }
  return { deleted, skipped };
}

/** 便捷入口：对 tee 路径所在 logs 目录做过期清理（流打开时机调用，每代一次）。 */
export function cleanupSiblingStderrLogs(
  logPath: string,
  env: NodeJS.ProcessEnv,
  prefix: string,
  now?: number,
): CleanupResult {
  return cleanupStaleStderrLogs(dirname(logPath), env, prefix, now);
}
