// src/__tests__/scenario-09-cross-process-resume.test.ts
//
// 场景 9（修订设计 §4，D7）：跨进程双 resume。双宿主几乎同时 resume。
//
// 通过标准（原文）：恰一个进入重放，另一个锁拒绝；record 无交错事件。
//
// 两轨结构（单测层极端测试整治）：
// - 逻辑面（默认跑）：vi.mock("proper-lockfile") 注入进程内锁桩——先到者得锁、
//   持有中再 lock() 同一 target 即 ELOCKED（JS 单线程内两次调用的到达序即裁决序，
//   模拟真锁「锁文件新鲜即拒绝」的仲裁语义）。mock 的只是锁原语（进程互斥边界），
//   resumeRun 编排全真跑（资格校验 → v2 条目补写 → run-resumed 落盘 → 活体注册
//   → worker 重放）。
// - 集成轨（TAIJI_TEST_INTEGRATION 门控，本地默认跳过）：两个真实 OS 子进程
//   （tsx 载体 driver-resume.ts）各自调 resumeRun 的真互斥形态——跨进程 mkdir
//   互斥属判据第 3 档（无完成信号可等，负载下窗口无上界），只能设窗口观测。
//   tsx 子进程纯 node 解析、不继承父进程 vi.mock——门控段真锁语义不受桩污染。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ResumeRejectionError } from "@zhushanwen/subagent-core/orchestration/resume-run.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from "../../../../../test-guard/integration-gate.ts";

import {
  driverMarkerPath,
  makeFauxRunner,
  makeScenarioDeps,
  mkScenarioEnv,
  resumeScenarioRun,
  scanScenarioEvents,
  seedCrashedRun,
  THREE_CALL_SERIAL_SCRIPT,
  waitForScenarioSettled,
} from "./record-mode/scenario-kit.ts";

// ── proper-lockfile 进程内锁桩（逻辑面专用；集成轨子进程不受影响）────────────
//
// 桩语义与真实 proper-lockfile.lock 的裁决面同构：持有中拒绝（ELOCKED）、
// release 归还；粒度差在跨进程 mkdir（真互斥归集成轨验证）。calls 记录用例
// 断言锁获取参数语义 + mock 生效检查（未命中先红，防真锁静默顶替）。
const injectedLock = vi.hoisted(() => {
  const state = {
    calls: [] as Array<{ target: string; options: Record<string, unknown> }>,
    held: new Set<string>(),
  };
  return state;
});

vi.mock("proper-lockfile", () => ({
  lock: (target: string, options?: Record<string, unknown>): Promise<() => Promise<void>> => {
    injectedLock.calls.push({ target, options: options ?? {} });
    if (injectedLock.held.has(target)) {
      return Promise.reject(
        Object.assign(new Error(`ELOCKED (injected lock): ${target} is already held`), { code: "ELOCKED" }),
      );
    }
    injectedLock.held.add(target);
    return Promise.resolve(async () => {
      injectedLock.held.delete(target);
    });
  },
}));

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

describe("场景 9 逻辑面：双宿主并发 resume（锁桩裁决恰一个进入）", () => {
  beforeEach(() => {
    injectedLock.calls.length = 0;
    injectedLock.held.clear();
  });

  it("并发双 resume：恰一个进入重放（终态 done），另一个 ResumeRejectionError（being resumed by another process）；record 无交错事件", async () => {
    const env = mkScenarioEnv("09logic");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });

      // 双宿主 = 两套独立 ScenarioDeps（各自 runs 注册表 / faux runner），同一
      // record 流。不 await 第一个——并发到达是场景本体（锁桩按到达序裁决）
      const sdA = makeScenarioDeps(env, makeFauxRunner());
      const sdB = makeScenarioDeps(env, makeFauxRunner());
      const outcomes = await Promise.allSettled([
        resumeScenarioRun(env, sdA, RUN_ID),
        resumeScenarioRun(env, sdB, RUN_ID),
      ]);

      // mock 生效检查先行：锁桩未命中（vi.mock 解析漂移）时先红，防真锁静默顶替
      expect(injectedLock.calls.length).toBe(2);

      // 恰一个进入重放，另一个锁拒绝
      const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const rejection = (rejected[0] as PromiseRejectedResult).reason as ResumeRejectionError;
      expect(rejection).toBeInstanceOf(ResumeRejectionError);
      expect(rejection.message).toContain("being resumed by another process");

      // 胜者终局 done（回放 A/B + 重派 C 全链推进）——按结果定位胜者 deps
      const winner = outcomes[0]!.status === "fulfilled" ? sdA : sdB;
      const outcome = await waitForScenarioSettled(winner.runs, RUN_ID);
      expect(outcome.status).toBe("done");

      // record 无交错事件（与集成轨同款断言口径）：run-resumed 恰 1 条、settled
      // 帧每 taskIndex 恰 1 条（败者零写入；回放命中不重复落 settled）
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
  });

  it("锁获取参数语义：retries 0（锁被占立即显式拒绝不退避，[ADR-0122]）+ realpath false + 锁名锚定 recordPath", async () => {
    const env = mkScenarioEnv("09lockargs");
    try {
      await seedCrashedRun(env, RUN_ID, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        settled: [{ agent: "A" }],
        inflight: [{ agent: "B" }],
      });
      const sd = makeScenarioDeps(env, makeFauxRunner());
      await resumeScenarioRun(env, sd, RUN_ID);
      const outcome = await waitForScenarioSettled(sd.runs, RUN_ID);
      expect(outcome.status).toBe("done");

      expect(injectedLock.calls.length).toBe(1);
      // retries 0 = 锁被占立即 ELOCKED 拒绝（不自动退避重试——另一 resume 在途时
      // 退避等待违背首败即停）；realpath false = 锁名按路径字面不解析符号链接
      expect(injectedLock.calls[0]!.options).toMatchObject({ realpath: false, retries: 0 });
      // 锁名 = recordPath 剥 .record.jsonl 后缀 + .resume（跨进程互斥的仲裁键）
      expect(injectedLock.calls[0]!.target.endsWith(".resume")).toBe(true);
      expect(injectedLock.calls[0]!.target.includes(RUN_ID)).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});

// ── 集成轨：真互斥（tsx 双子进程 + proper-lockfile 跨进程 mkdir）──────────────

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
  // TAIJI_AGENT_DATA_DIR 锚进本轮 tmp：[session-store-layout-inversion D2/D3] 新布局
  // 的生产推导根 = shared getDataDir()（不注入则任何意外触达生产推导的点会落真实
  // ~/.taiji 数据目录，测试红线；journal 写读面另经 driver 内
  // setRunEventJournalDirForTest(STATE_DIR) 显式锚定，见 driver-resume.ts）。
  const childEnv = { ...process.env };
  delete childEnv.VITEST;
  childEnv.TAIJI_AGENT_DATA_DIR = agentDirRoot;
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

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  "场景 9 集成轨：跨进程双 resume（proper-lockfile 真互斥）" +
    (INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""),
  () => {
    it("双宿主几乎同时 resume：恰一个进入重放，另一个锁拒绝；record 无交错事件", async () => {
      const env = mkScenarioEnv("09");
      try {
        await seedCrashedRun(env, RUN_ID, {
          scriptSource: THREE_CALL_SERIAL_SCRIPT,
          settled: [{ agent: "A" }, { agent: "B" }],
          inflight: [{ agent: "C" }],
        });

        // 持锁方先起：marker 出现 = 锁已被真实持有（跨进程 mkdir 产物在盘）
        const holder = spawnDriver("holder", env.stateDir, "holder-a", env.runsDir);
        const holderPromise = waitExit(holder, 60_000);
        try {
          await waitForFile(driverMarkerPath(env.stateDir, "holder-a"), 20_000);
        } catch (err) {
          const holderDebug = await holderPromise.catch((e: unknown) => `holder spawn error: ${String(e)}`);
          throw new Error(`${String((err as Error).message)}\nholder outcome: ${JSON.stringify(holderDebug)}`);
        }

        // 竞争方到达（锁持有段内）：必 ELOCKED → 明确拒绝退出
        const contender = spawnDriver("contender", env.stateDir, "contender-b", env.runsDir);
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
  },
);
