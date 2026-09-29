// src/__tests__/scenario-09-cross-process-resume.test.ts
//
// 场景 9（修订设计 §4，D7）：跨进程双 resume。双宿主几乎同时 resume。
//
// 通过标准（原文）：恰一个进入重放，另一个锁拒绝；record 无交错事件。
//
// 双进程夹具（任务书 §2）：两个真实 OS 子进程（tsx 载体 driver-resume.ts）各自
// 调 resumeRun。确定性竞争窗口 = 持锁方在锁段内（appendEntry 回调）写 marker
// 握手 + Atomics.wait 拉长持有段；主测试进程等 marker 出现（锁已被真实持有）后
// 再放竞争方。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  driverMarkerPath,
  mkScenarioEnv,
  scanScenarioEvents,
  seedCrashedRun,
  THREE_CALL_SERIAL_SCRIPT,
} from "./record-mode/scenario-kit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(HERE, "record-mode", "driver-resume.ts");

/** 逐级向上定位 node_modules/.bin/tsx（物理推导，不依赖 cwd / 仓库层数假设）。 */
function locateTsx(): string {
  let dir = HERE;
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", "tsx");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("tsx not found in any ancestor node_modules");
    dir = parent;
  }
}
const TSX = locateTsx();

const RUN_ID = "wf-s9-crossproc";

interface DriverOutcome { // oe-exempt:20260929:test:driver outcome shape (test fixture infra)
  code: number | null;
  stderr: string;
}

function spawnDriver(
  role: "holder" | "contender",
  stateDir: string,
  marker: string,
  agentDirRoot: string,
): ReturnType<typeof spawn> {
  // 剥离 vitest 防线 env：driver 是真实生产形态宿主进程（core journal 的 VITEST
  // 检测会落 no-op journal——子进程不继承测试防线）。
  // PI_CODING_AGENT_DIR 锚进本轮 tmp（生产推导 resolvePiWorkflowStateDir 的根——
  // 不注入会落真实 ~/.pi 数据目录，测试红线；锚定后 worker 后续帧/manifest 全落
  // 本轮 stateDir，与 journalDir 注入面同目录）。
  const childEnv = { ...process.env };
  delete childEnv.VITEST;
  childEnv.PI_CODING_AGENT_DIR = agentDirRoot;
  return spawn(TSX, [DRIVER], {
    env: {
      ...childEnv,
      WF_DRIVER_STATE_DIR: stateDir,
      WF_DRIVER_RUN_ID: RUN_ID,
      WF_DRIVER_ROLE: role,
      WF_DRIVER_MARKER: marker,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<DriverOutcome> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`driver did not exit within ${timeoutMs}ms; stderr so far: ${stderr.slice(0, 2000)}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForFile(file: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (existsSync(file)) return resolve();
      if (Date.now() > deadline) {
        return reject(new Error(`marker ${file} not written within ${timeoutMs}ms`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("场景 9：跨进程双 resume（proper-lockfile 真互斥）", () => {
  it("双宿主几乎同时 resume：恰一个进入重放，另一个锁拒绝；record 无交错事件", async () => {
    const env = mkScenarioEnv("09");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });

      // 持锁方先起：marker 出现 = 锁已被真实持有（跨进程 mkdir 产物在盘）
      const holder = spawnDriver("holder", env.stateDir, "holder-a", env.sessionDir);
      const holderPromise = waitExit(holder, 60_000);
      try {
        await waitForFile(driverMarkerPath(env.stateDir, "holder-a"), 20_000);
      } catch (err) {
        const holderDebug = await holderPromise.catch((e: unknown) => `holder spawn error: ${String(e)}`);
        throw new Error(`${String((err as Error).message)}\nholder outcome: ${JSON.stringify(holderDebug)}`);
      }

      // 竞争方到达（锁持有段内）：必 ELOCKED → 明确拒绝退出
      const contender = spawnDriver("contender", env.stateDir, "contender-b", env.sessionDir);
      const contenderOutcome = await waitExit(contender, 30_000);

      const holderOutcome = await holderPromise;

      // 恰一个进入重放（holder exit 0），另一个锁拒绝（contender exit 1 + 文案）
      expect(holderOutcome.code).toBe(0);
      expect(contenderOutcome.code).toBe(1);
      expect(contenderOutcome.stderr).toContain("being resumed by another process");

      // record 无交错事件：run-resumed 恰 1 条、settled 帧每 taskIndex 恰 1 条
      // （竞争方零写入；严格 seq 连续由后续可 resume 构造性保证）
      const events = await scanScenarioEvents(env, RUN_ID);
      expect(events.filter((e) => e.type === "run-resumed")).toHaveLength(1);
      const settledCount = new Map<number, number>();
      for (const e of events) {
        if (e.type === "agent-settled") settledCount.set(e.taskIndex, (settledCount.get(e.taskIndex) ?? 0) + 1);
      }
      expect(settledCount.size).toBe(3);
      expect([...settledCount.values()].every((n) => n === 1)).toBe(true);
    } finally {
      env.cleanup();
    }
  }, 90_000);
});
