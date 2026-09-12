// src/execution/__tests__/subprocess-agent-runner-no-progress-killall.test.ts
//
// [M3 决策 9 / V5c] killAll 组杀邻接（真引擎进程，集成层）。
//
// 被测语义：M3 fire 的 abort 并入 mergedSignal 后走 RemoteEngine 既有 wireAbortSignal
// 阶梯——引擎对 cancel 帧 >收敛窗无响应 → killAll 组杀引擎 CLI → 同引擎其余在途 run
// 全部以 engine_crashed error 终态化（G1 字面保持：有终态 + executeAgentCall 可重试），
// 无悬挂。
//
// 与 V5① 的分工（如实声明）：
//   - V5①（fake timers，单测）锁「30min 窗口到点 → watchdog abort」的计时链路；
//   - 本文件锁「watchdog abort（= fire 的同步动作）→ mergedSignal → 阶梯 → killAll →
//     邻接 run 终态」的进程链路。mid-round 窗是原语内纯常量、无 env/测试 seam 可缩短
//     （K6 结论），真引擎进程无法与 fake timers 混跑，故此处直接驱动 watchdog 的
//     AbortController（即 fire 回调内的唯一同步动作，逐字等价）。
//
// 对端 sessionDir = mkdtempSync 自建自删（禁碰真实数据目录）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngineClient } from "../engine/client/engine-client.ts";
import { RemoteEngine, type RemoteEngineManifestSnapshot } from "../engine/client/remote-engine.ts";
import { mergeRunSignals } from "../subprocess-agent-runner.ts";

const FAKE_ENGINE = fileURLToPath(
  new URL("../engine/client/__tests__/__fixtures__/fake-engine.mjs", import.meta.url),
);

/** 与 fake 引擎 initialize 应答逐位一致（gate 位多声明判定「一致放行」基线）。 */
const FAKE_MATCHED_CAPS = {
  schemaEnforcement: "emulated",
  steer: "unsupported",
  conversation: "unsupported",
  personaInjection: "prompt",
  eventGranularity: "stream",
  sandbox: "emulated",
  sessionRead: "full",
  resume: "cold",
  interrupt: "kill-only",
  permissionMode: "fixed",
  maxTurns: false,
} as const;

/** run 动作脚本：长 delay 保持两路 run 在途（cancel 不做收敛，考验 3s 收敛窗后的杀链）。 */
const HANG_RUN_ACTIONS = JSON.stringify([{ op: "delay", ms: 30_000 }]);

async function waitForTrue(predicate: () => boolean, timeoutMs = 8_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("waitForTrue: condition not met within timeout");
}

/** fake 引擎收到 run 帧后回显的 run-params 事件（run 已派发的确定性同步点）。 */
function sawRunParams(events: unknown[]): boolean {
  return events.some(
    (e) =>
      (e as { type?: string; message?: string }).type === "error" &&
      typeof (e as { message?: string }).message === "string" &&
      (e as { message: string }).message.startsWith("run-params:"),
  );
}

describe("M3 V5c killAll 组杀邻接", () => {
  let dataDir = "";

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "m3-v5c-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("watchdog fire（引擎对 cancel 无响应）→ killAll → 邻接 run 以 engine_crashed 收敛，无悬挂", async () => {
    const client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [FAKE_ENGINE, "--run-actions", HANG_RUN_ACTIONS],
      hostKind: "test",
      dataDir,
      envPrefixes: [],
    });
    const manifest: RemoteEngineManifestSnapshot = {
      capabilities: { ...FAKE_MATCHED_CAPS },
    };
    const engine = new RemoteEngine({ engineId: "fake", client, dataDir, hostKind: "test", manifest });

    try {
      const eventsA: unknown[] = [];
      const eventsB: unknown[] = [];
      // M3 形态的合并 signal：外部 run 级 signal（永不 abort）+ watchdog abort 源。
      const watchdog = new AbortController();
      const mergedA = mergeRunSignals(new AbortController().signal, undefined, watchdog.signal);

      const runA = engine.run(
        { prompt: "wedged" },
        { taskId: "run-a", poolKey: "shared", signal: mergedA.signal, onEvent: (e) => eventsA.push(e) },
      );
      const runB = engine.run(
        { prompt: "healthy" },
        {
          taskId: "run-b",
          poolKey: "shared",
          signal: new AbortController().signal,
          onEvent: (e) => eventsB.push(e),
        },
      );

      // 两路 run 帧均已到达引擎（确定性同步点）后触发 fire
      await waitForTrue(() => sawRunParams(eventsA) && sawRunParams(eventsB));
      watchdog.abort();

      const [a, b] = await Promise.all([runA, runB]);

      // 被 fire 的 run：cancel 未收敛 → 杀链 → 合成 abort 终态（不 reject）
      expect(a.outcome.error).toContain("aborted before terminal answer");
      expect(a.outcome.exitCode).toBeNull();
      expect(a.handle.data.engineId).toBe("fake");

      // 邻接 healthy run：killAll 组杀连带 → engine_crashed error 终态（G1：有终态 + 可重试）
      expect(b.outcome.error).toContain("engine_crashed");
      expect(b.outcome.exitCode).toBeNull();
      expect(b.handle.data.engineId).toBe("fake");

      mergedA.dispose();
    } finally {
      await client.dispose().catch(() => {});
    }
  }, 20_000);
});
