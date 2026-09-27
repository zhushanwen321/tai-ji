// src/execution/__tests__/workflow-no-progress-kill-radius.test.ts
//
// [D9-2] watchdog no-progress kill 半径（真引擎进程，集成层；前身
// subprocess-agent-runner-no-progress-killall.test.ts 锁的「killAll 组杀连带邻接 run
// engine_crashed」语义已随半径收窄退役，本文件按收窄后语义重写）。
//
// 被测语义：M3 fire 的 abort 并入 mergedSignal 后走 RemoteEngine 既有 wireAbortSignal
// 阶梯——引擎对 cancel 帧 >收敛窗无响应 → 宿主本地合成 abort 终态（record 必须收尾）
// + run 拓扑杀（只杀该 run 的引擎孙进程，SDK killPidChain 单 pid 杀链）。引擎宿主与
// 同引擎其余并发 run **存活**：邻接 run 正常完成（真实结果，非 engine_crashed 连带），
// 其孙进程不被触碰（D9-2 豁免面 dispose/stdout-wedge 保留组杀，不在此阶梯）。
//
// 与 V5① 的分工（如实声明）：
//   - V5①（fake timers，单测）锁「30min 窗口到点 → watchdog abort」的计时链路；
//   - 本文件锁「watchdog abort（= fire 的同步动作）→ mergedSignal → 阶梯 → run 拓扑
//     杀 → 半径存活面」的进程链路。mid-round 窗是原语内纯常量、无 env/测试 seam 可
//     缩短（K6 结论），真引擎进程无法与 fake timers 混跑，故此处直接驱动 watchdog 的
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
import { isProcessAlive } from "../engine/client/pid-file.ts";
import { mergeRunSignals } from "../assembly/subprocess-agent-runner.ts";

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

/**
 * run 动作脚本：每 run 先 spawn 一个孙进程（recordId "@runId" = per-run 归账锚），
 * 再长 delay 不应答——被 fire 的 run 在收敛窗超时后被宿主强制收尾 + 拓扑杀；邻接
 * run（不 abort）在 delay 走完后正常应答（activeRun 单槽语义：后派发者持槽应答）。
 */
const RUN_ACTIONS = JSON.stringify([
  { op: "spawnGrandchild", recordId: "@runId" },
  { op: "delay", ms: 1500 },
]);

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

describe("D9-2 watchdog no-progress kill 半径（真引擎进程）", () => {
  let dataDir = "";

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "d9-2-radius-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("watchdog fire（引擎对 cancel 无响应）→ 仅该 run 的孙进程被杀；邻接 run 正常完成、其孙进程与引擎宿主存活", async () => {
    const client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [FAKE_ENGINE, "--run-actions", RUN_ACTIONS],
      hostKind: "test",
      dataDir,
      envPrefixes: [],
    });
    const manifest: RemoteEngineManifestSnapshot = {
      capabilities: { ...FAKE_MATCHED_CAPS },
    };
    // [S1 P1 校准适配] 兜底窗缺省 30s——本用例锁「cancel 无响应 → 拓扑杀 → 半径存活面」
    // 的进程链路而非窗口量级（量级由 remote-engine.test.ts 常量断言锚定），注入短窗。
    const engine = new RemoteEngine({
      engineId: "fake",
      client,
      dataDir,
      hostKind: "test",
      manifest,
      cancelSettleGraceMs: 400,
    });

    try {
      const eventsA: unknown[] = [];
      const eventsB: unknown[] = [];
      // M3 形态的合并 signal：外部 run 级 signal（永不 abort）+ watchdog abort 源。
      const watchdog = new AbortController();
      const mergedA = mergeRunSignals(new AbortController().signal, undefined, watchdog.signal);

      const runA = engine.run(
        { prompt: "wedged" },
        { taskId: "run-a", signal: mergedA.signal, onEvent: (e) => eventsA.push(e) },
      );
      const runB = engine.run(
        { prompt: "healthy" },
        { taskId: "run-b", signal: new AbortController().signal, onEvent: (e) => eventsB.push(e) },
      );

      // 两路 run 帧均已到达引擎（确定性同步点）后触发 fire
      await waitForTrue(() => sawRunParams(eventsA) && sawRunParams(eventsB));
      // 两路孙进程均已上报镜像（childSpawned 反向通道落账 = 杀目标的确定性同步点）
      await waitForTrue(() => client.mirror.snapshot().filter((e) => e.state === "running").length >= 2);
      const grandchildA = client.mirror.snapshot().find((e) => e.recordId === "run-a");
      const grandchildB = client.mirror.snapshot().find((e) => e.recordId === "run-b");
      expect(grandchildA).toBeDefined();
      expect(grandchildB).toBeDefined();
      const enginePid = client.enginePid!;

      watchdog.abort();

      // 被 fire 的 run：cancel 未收敛 → 本地合成 abort 终态（不 reject，record 必须收尾）
      const a = await runA;
      expect(a.outcome.error).toContain("aborted before terminal answer");
      expect(a.outcome.exitCode).toBeNull();
      expect(a.handle.data.engineId).toBe("fake");

      // 半径断言①：目标 run 的孙进程被杀（真实 SIGTERM → 进程消亡）
      await waitForTrue(() => isProcessAlive(grandchildA!.pid) === false);

      // 半径断言②：邻接 healthy run 正常完成（真实结果，非 engine_crashed 连带）
      const b = await runB;
      expect(b.outcome.error).toBeUndefined();
      expect(b.outcome.content).toBe("fake-content-run-b");

      // 半径断言③：邻接 run 的孙进程存活（不连带）
      expect(isProcessAlive(grandchildB!.pid)).toBe(true);

      // 半径断言④：引擎宿主存活（D9-2 组杀退役；dispose 是豁免面，不在本阶梯）
      expect(client.currentState).toBe("ready");
      expect(isProcessAlive(enginePid)).toBe(true);

      mergedA.dispose();
    } finally {
      await client.dispose().catch(() => {});
    }
  }, 20_000);
});
