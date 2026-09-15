// src/execution/engine/client/reaper.ts
//
// 进程组收割（EngineClient 内部模块，从 engine-client.ts 拆出——max-lines 纪律）。
//
// 收割单一机制（impl-plan §2.2，v6 已删按 pid 补杀）：POSIX 负 pid 组杀
// （SIGTERM → grace → SIGKILL 升级）；Windows taskkill /PID <pid> /T /F（按 pid 树）。
// 「零残留」断言范围 = 一代子进程 + 组内后代（引擎自身 detached 后代不覆盖，
// §7.2 R9-1 / 设计 §3.9 已接受代价）。

import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { getLogger } from "@zhushanwen/subagent-engine-sdk";

const logger = getLogger("subagents");

/** 进程组 SIGTERM 优雅窗口（对齐 SDK kill-chain DEFAULT_KILL_GRACE_MS）。 */
const KILL_GRACE_MS = 5_000;

/**
 * 组杀引擎 CLI：POSIX `process.kill(-pid)` 负 pid 组杀（引擎由 detached:true spawn =
 * 组长，组内含引擎 + 其任务子进程 = 一代子进程 + 组内后代）；Windows taskkill /T /F。
 */
export function killProcessTree(pid: number, reason: string, opts: { engineId: string }): void {
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 10_000 });
    if (r.error || r.status !== 0) {
      logger.warn(
        `[engine-client:${opts.engineId}] taskkill failed for pid ${pid} (${reason}): ${
          r.error?.message ?? `exit ${r.status}`
        }`,
      );
    }
    return;
  }
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (err) {
      logger.debug(
        `[engine-client:${opts.engineId}] process.kill(-${pid}, ${signal}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  };
  if (!signalGroup("SIGTERM")) {
    // 组不存在（组长已死）→ 单进程兜底。
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      logger.debug(
        `[engine-client:${opts.engineId}] single SIGTERM to ${pid} failed (already dead = expected): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return; // 已死
    }
  }
  const escalation = setTimeout(
    () => {
      if (!signalGroup("SIGKILL")) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (err) {
          // 已死 = 预期终态。
          logger.debug(
            `[engine-client:${opts.engineId}] SIGKILL to ${pid} failed (already dead = expected): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    },
    KILL_GRACE_MS,
  );
  escalation.unref();
}

/** 等 child 退出（有界；超时不再等待——SIGKILL 后进程必死，收尸由 OS 完成）。 */
export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
