// scenario.test.ts —— subagent-workflow C02 簇合并产物（round5-G）。
// 共同被测业务模块：`core:@zhushanwen/subagent-core/orchestration/resume-run.ts`。mock 相容：单侧 mock @zhushanwen/subagent-core/orchestration/resume-run.ts、proper-lockfile——合并后 mock 全文件生效，未 mock 方用例经产物自检全绿核对。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/scenario-03-terminal-resume-rejection.test.ts（2 用例，skip 0）
//   - src/__tests__/scenario-07-failed-terminal-rejection.test.ts（1 用例，skip 0）
//   - src/__tests__/scenario-09-cross-process-resume.test.ts（3 用例，skip 1）
//   - src/__tests__/scenario-17-resume-then-abort.test.ts（1 用例，skip 0）
//   - src/__tests__/scenario-18-corruption-rejection.test.ts（4 用例，skip 0）

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { appendEvents, askDispatched, askSettled, mkRecordEnv, runCreated, runSettled, writeRawLines } from './record-mode/helpers.ts'
import { ResumeRejectionError } from '@zhushanwen/subagent-core/orchestration/resume-run.ts'
import { makeFauxRunner, makeScenarioDeps, resumeScenarioRun, scanScenarioEvents, driverMarkerPath, mkScenarioEnv, seedCrashedRun, settledCountByTaskIndex, THREE_CALL_SERIAL_SCRIPT, waitForScenarioSettled } from './record-mode/scenario-kit.ts'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../../../test-guard/integration-gate.ts'
import { abortRun } from '@zhushanwen/subagent-core/orchestration/lifecycle.ts'

// ── proper-lockfile 进程内锁桩（逻辑面专用；集成组子进程不受影响）────────────
//
// 桩语义与真实 proper-lockfile.lock 的裁决面同构：持有中拒绝（ELOCKED）、
// release 归还；粒度差在跨进程 mkdir（真互斥归集成组验证）。calls 记录用例
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

// ======== 来源：scenario-03-terminal-resume-rejection.test.ts ========
describe("scenario-03-terminal-resume-rejection", () => {
  /** 终局 run 的最小 record 流（created + 1 settled + run-settled）。 */
  async function seedTerminalRun(
    env: ReturnType<typeof mkRecordEnv>,
    runId: string,
    outcome: string,
  ): Promise<void> {
    await appendEvents(env, runId, [
      runCreated({ ts: 1_759_000_000_000, runId, scriptSource: "await agent('x');" }),
      askDispatched({ ts: 1_759_000_000_100, taskIndex: 0, agentName: "x" }),
      askSettled({ ts: 1_759_000_000_200, taskIndex: 0, outcome: "done", result: { content: "ok" } }),
      runSettled({ ts: 1_759_000_000_300, outcome }),
    ]);
  }

  describe("场景 3：非 interrupted 终局拒绝", () => {
    it.each([
      { desc: "正常 completed 终局", runId: "wf-s3-completed", outcome: "done" },
      { desc: "用户 abort（cancelled）终局", runId: "wf-s3-cancelled", outcome: "cancelled" },
    ])("$desc → 拒绝 + 「仅 interrupted 可续跑」+ record 无 run-resumed", async ({ runId, outcome }) => {
      const env = mkRecordEnv("scenario-03");
      try {
        await seedTerminalRun(env, runId, outcome);
        const sd = makeScenarioDeps(env, makeFauxRunner());

        await expect(resumeScenarioRun(env, sd, runId)).rejects.toMatchObject({
          name: "ResumeRejectionError",
          message: expect.stringMatching(/already settled|only interrupted runs can be resumed/),
        } satisfies Partial<ResumeRejectionError>);

        // 终局与历史不变：无 run-resumed、无新派发
        const events = await scanScenarioEvents(env, runId);
        expect(events.some((e) => e.type === "run-resumed")).toBe(false);
        expect(sd.faux.dispatches).toHaveLength(0);
      } finally {
        env.cleanup();
      }
    });
  });
});

// ======== 来源：scenario-07-failed-terminal-rejection.test.ts ========
describe("scenario-07-failed-terminal-rejection", () => {
  const RUN_ID = "wf-s7-failed";

  describe("场景 7：failed 终局拒绝", () => {
    it("对 failed 终局 run 发 resume → 明确拒绝（仅中断可续跑），record 无 run-resumed、无新派发", async () => {
      const env = mkRecordEnv("scenario-07");
      try {
        await appendEvents(env, RUN_ID, [
          runCreated({ ts: 1_759_000_000_000, runId: RUN_ID, scriptSource: "await agent('x');" }),
          askDispatched({ ts: 1_759_000_000_100, taskIndex: 0, agentName: "x" }),
          askSettled({ ts: 1_759_000_000_200, taskIndex: 0, outcome: "failed", errorCode: "unknown", result: { content: "", error: "boom" } }),
          runSettled({ ts: 1_759_000_000_300, outcome: "failed", reason: "boom" }),
        ]);

        const sd = makeScenarioDeps(env, makeFauxRunner());
        await expect(resumeScenarioRun(env, sd, RUN_ID)).rejects.toMatchObject({
          name: "ResumeRejectionError",
          message: expect.stringContaining("only interrupted runs can be resumed"),
        } satisfies Partial<ResumeRejectionError>);

        const events = await scanScenarioEvents(env, RUN_ID);
        expect(events.some((e) => e.type === "run-resumed")).toBe(false);
        expect(sd.faux.dispatches).toHaveLength(0);
      } finally {
        env.cleanup();
      }
    });
  });
});

// ======== 来源：scenario-09-cross-process-resume.test.ts ========
describe("scenario-09-cross-process-resume", () => {
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

        // record 无交错事件（与集成组同款断言口径）：run-resumed 恰 1 条、settled
        // 帧每 taskIndex 恰 1 条（败者零写入；回放命中不重复落 settled）
        const events = await scanScenarioEvents(env, RUN_ID);
        expect(events.filter((e) => e.type === "run-resumed")).toHaveLength(1);
        const settledCount = settledCountByTaskIndex(events);
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

  // ── 集成组：真互斥（tsx 双子进程 + proper-lockfile 跨进程 mkdir）──────────────

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
    "场景 9 集成组：跨进程双 resume（proper-lockfile 真互斥）" +
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
          const holderPromise = waitExit(holder, 240_000);
          try {
            await waitForFile(driverMarkerPath(env.stateDir, "holder-a"), 60_000);
          } catch (err) {
            const holderDebug = await holderPromise.catch((e: unknown) => `holder spawn error: ${String(e)}`);
            throw new Error(`${String((err as Error).message)}\nholder outcome: ${JSON.stringify(holderDebug)}`);
          }

          // 竞争方到达（锁持有段内）：必 ELOCKED → 明确拒绝退出
          const contender = spawnDriver("contender", env.stateDir, "contender-b", env.runsDir);
          const contenderOutcome = await waitExit(contender, 120_000);

          const holderOutcome = await holderPromise;

          // 恰一个进入重放（holder exit 0），另一个锁拒绝（contender exit 1 + 文案）
          expect(holderOutcome.code).toBe(0);
          expect(contenderOutcome.code).toBe(1);
          expect(contenderOutcome.stderr).toContain("being resumed by another process");

          // record 无交错事件：run-resumed 恰 1 条、settled 帧每 taskIndex 恰 1 条
          // （竞争方零写入；严格 seq 连续由后续可 resume 构造性保证）
          const events = await scanScenarioEvents(env, RUN_ID);
          expect(events.filter((e) => e.type === "run-resumed")).toHaveLength(1);
          const settledCount = settledCountByTaskIndex(events);
          expect(settledCount.size).toBe(3);
          expect([...settledCount.values()].every((n) => n === 1)).toBe(true);
        } finally {
          env.cleanup();
        }
      }, 300_000);
    },
  );
});

// ======== 来源：scenario-17-resume-then-abort.test.ts ========
describe("scenario-17-resume-then-abort", () => {
  const RUN_ID = "wf-s17-abort";

  describe("场景 17：resume 后 abort（cancelled 终局 + 再 resume 拒绝）", () => {
    it("resume 进行中 abort → cancelled 终局正常写入；对 cancelled 再 resume 明确拒绝", async () => {
      const env = mkScenarioEnv("17");
      try {
        await seedCrashedRun(env, RUN_ID, {
          scriptSource: THREE_CALL_SERIAL_SCRIPT,
          settled: [{ agent: "A" }, { agent: "B" }],
          inflight: [{ agent: "C" }],
        });

        const sd = makeScenarioDeps(env, makeFauxRunner());
        sd.faux.steps.push({ kind: "hang" }); // resume 进行中（C 派发挂起）
        await resumeScenarioRun(env, sd, RUN_ID);
        const deadline = Date.now() + 10_000;
        while (sd.faux.dispatches.length < 1 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5));
        }

        // abort（用户主动终局）
        await abortRun(RUN_ID, sd.deps, "user abort", "aborted");
        const summary = await waitForScenarioSettled(sd.runs, RUN_ID);
        expect(summary.status).toBe("done");

        // cancelled 终局正常写入 record（run-settled outcome=cancelled）
        const events = await scanScenarioEvents(env, RUN_ID);
        const settledFrames = events.filter((e) => e.type === "run-settled");
        expect(settledFrames).toHaveLength(1);
        expect(settledFrames[0]).toMatchObject({ outcome: "cancelled" });

        // 对 cancelled 再 resume：明确拒绝（正常终局一次性）
        await expect(resumeScenarioRun(env, sd, RUN_ID)).rejects.toMatchObject({
          name: "ResumeRejectionError",
          message: expect.stringContaining("only interrupted runs can be resumed"),
        } satisfies Partial<ResumeRejectionError>);
        expect(events.filter((e) => e.type === "run-resumed")).toHaveLength(1); // 无第二条
      } finally {
        env.cleanup();
      }
    });
  });
});

// ======== 来源：scenario-18-corruption-rejection.test.ts ========
describe("scenario-18-corruption-rejection", () => {
  const RUN_ID = "wf-s18-corrupt";

  /** 用例间独立 runId（liveRunStates 进程内按 runId 键控——防前用例活体态串扰）。 */
  const RUN_ID_D = "wf-s18-corrupt-d";

  const T0 = 1_759_000_000_000;

  /** 合法帧的行文本（含 seq 信封——与生产写入器同构的最小行）。 */
  function frame(obj: Record<string, unknown>, seq: number): string {
    return JSON.stringify({ ...obj, seq });
  }

  describe("场景 18：record 损坏拒绝（resume 场景层）", () => {
    it("末尾半截行（崩溃写入中断形态）→ resume 拒绝，文案含损坏定位与恢复指引", async () => {
      const env = mkScenarioEnv("18a");
      try {
        writeRawLines(env, RUN_ID, [
          frame({ type: "run-created", ts: T0, runId: RUN_ID, workflowName: "w", argsSummary: "{}", scriptSource: "await agent('x');" }, 1),
          frame({ type: "agent-started", ts: T0 + 10, taskIndex: 0, agentName: "x", attempt: 1 }, 2),
          // 半截行：写入中断（无换行、JSON 截断）
          '{"type":"agent-settled",ts:',
        ]);
        const sd = makeScenarioDeps(env, makeFauxRunner());
        await expect(resumeScenarioRun(env, sd, RUN_ID)).rejects.toMatchObject({
          name: "ResumeRejectionError",
          message: expect.stringMatching(/corrupted at line 3.*Recovery:/s),
        } satisfies Partial<ResumeRejectionError>);
        expect(sd.faux.dispatches).toHaveLength(0);
      } finally {
        env.cleanup();
      }
    });

    it("seq 断档（检查①——丢行/截断形态）→ resume 拒绝并指明期望/实际 seq", async () => {
      const env = mkScenarioEnv("18b");
      try {
        writeRawLines(env, RUN_ID, [
          frame({ type: "run-created", ts: T0, runId: RUN_ID, workflowName: "w", argsSummary: "{}", scriptSource: "await agent('x');" }, 1),
          frame({ type: "agent-started", ts: T0 + 10, taskIndex: 0, agentName: "x", attempt: 1 }, 3), // 跳号
        ]);
        const sd = makeScenarioDeps(env, makeFauxRunner());
        await expect(resumeScenarioRun(env, sd, RUN_ID)).rejects.toMatchObject({
          name: "ResumeRejectionError",
          message: expect.stringMatching(/seq gap detected \(expected 2, got 3\)/),
        } satisfies Partial<ResumeRejectionError>);
      } finally {
        env.cleanup();
      }
    });

    it("无损坏对照：同构造合法流（补 settled 帧）可正常 resume（判别用例）", async () => {
      const env = mkScenarioEnv("18c");
      try {
        writeRawLines(env, RUN_ID, [
          frame({ type: "run-created", ts: T0, runId: RUN_ID, workflowName: "w", argsSummary: "{}", scriptSource: "await agent('x');" }, 1),
          frame({ type: "agent-started", ts: T0 + 10, taskIndex: 0, agentName: "x", attempt: 1 }, 2),
          frame({ type: "agent-settled", ts: T0 + 20, taskIndex: 0, attempt: 1, outcome: "done", durationMs: 10, result: { content: "ok" } }, 3),
          frame({ type: "run-interrupted", ts: T0 + 30, errorCode: "crashed", reason: "kill" }, 4),
        ]);
        const sd = makeScenarioDeps(env, makeFauxRunner());
        await expect(resumeScenarioRun(env, sd, RUN_ID)).resolves.toBe(RUN_ID);
      } finally {
        env.cleanup();
      }
    });

    it("run-created 缺 scriptSource 载荷（写侧缺口形态）→ rebuild 面不构成损坏，但空脚本体可被识别", async () => {
      // 写侧载荷前置缺口（scenario-kit 头注登记）的行为记录：生产链现不写
      // scriptSource——本用例钉住该流形态在 resume 面的表现（可诊断、不静默）。
      const env = mkScenarioEnv("18d");
      try {
        writeRawLines(env, RUN_ID_D, [
          frame({ type: "run-created", ts: T0, runId: RUN_ID_D, workflowName: "w", argsSummary: "{}" }, 1), // 无 scriptSource
          frame({ type: "agent-started", ts: T0 + 10, taskIndex: 0, agentName: "x", attempt: 1 }, 2),
          frame({ type: "agent-settled", ts: T0 + 20, taskIndex: 0, attempt: 1, outcome: "done", durationMs: 10, result: { content: "ok" } }, 3),
          frame({ type: "run-interrupted", ts: T0 + 30, errorCode: "crashed", reason: "kill" }, 4),
        ]);
        const sd = makeScenarioDeps(env, makeFauxRunner());
        // 行为记录：缺 scriptSource 不是行级损坏（resumeRun 接受、rebuild 得空脚本）
        await expect(resumeScenarioRun(env, sd, RUN_ID_D)).resolves.toBe(RUN_ID_D);
      } finally {
        env.cleanup();
      }
    });
  });
});
