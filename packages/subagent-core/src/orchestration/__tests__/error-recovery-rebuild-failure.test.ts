/**
 * [OR-2] rebuildRuntime 抛错回灌重试矩阵 + [P-SD] 重建失败注入钩子 测试。
 *
 * 覆盖（crash-forensics-and-watchdog.md 附录 E（原 unbounded-wait-audit §4.1 OR-2 / §7.3 P-SD / §8.2 S-D 子场景②））：
 * - worker 崩溃 → rebuild 抛错（workerHost.start 失败）→ workerErrorCount 递增回灌矩阵
 *   → 后续 rebuild 成功 → run 恢复 running（不卡死）
 * - rebuild 连续失败耗尽 MAX_WORKER_RETRIES → 收敛 done,failed（不卡 running）、
 *   持久化、pending:unregister、onRunDone——且 handleWorkerError 的 await 链无
 *   rejection 泄漏（旧实现裸抛 → unhandledRejection）
 * - P-SD 钩子：TAIJI_SUBAGENT_TEST_INJECT_REBUILD_FAILURE=<N> 使 rebuildRuntime 第 N 次
 *   起抛错 → 重试矩阵确定性耗尽 → done,failed；激活 warn 留痕恰一次（安全约束）；
 *   未设置 = 完全不激活；非法值 = warn 指明 + 不激活（杜绝静默失效）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getLogger,
} from "../../core/logger.ts";
import {
  handleWorkerError,
  resetRebuildFailureInjectionForTest,
} from "../worker-message-pump.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { AgentResult } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { WorkerHandle } from "../worker-handle.ts";

// ── helpers（对齐 error-recovery-handlers.test.ts 的真实聚合根形态） ──

const REBUILD_INJECT_ENV = "TAIJI_SUBAGENT_TEST_INJECT_REBUILD_FAILURE";

function makeRealRun(runId: string, opts: { budgetTimeMs?: number } = {}): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptName: "test-wf",
      scriptSource: "agent('hi')",
      args: {},
      scriptPath: "/tmp/test-wf.js",
      budgetTimeMs: opts.budgetTimeMs,
    },
    {
      status: "running",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
  const initialWorker = {
    postMessage: vi.fn(),
    terminate: vi.fn(async () => {}),
  } as unknown as WorkerHandle;
  run.assignRuntime(new RunRuntime(initialWorker, new AbortController()));
  return run;
}

function makeDeps(opts: {
  /** workerHost.start 每次调用抛错（模拟线程/内存耗尽等重建失败）。 */
  startThrows?: boolean;
} = {}): LifecycleDeps & {
  store: { save: ReturnType<typeof vi.fn> };
  workerHost: { start: ReturnType<typeof vi.fn> };
  eventBus: { emit: ReturnType<typeof vi.fn> };
  appendEntry: ReturnType<typeof vi.fn>;
  onRunDone: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  const startImpl = opts.startThrows
    ? (): never => {
        throw new Error("Resource temporarily unavailable (injected start failure)");
      }
    : (): WorkerHandle =>
        ({ postMessage: vi.fn(), terminate: vi.fn(async () => {}) }) as unknown as WorkerHandle;
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn(startImpl) },
    runner: { run: vi.fn(async () => ({}) as AgentResult) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    appendEntry: vi.fn(),
    onRunDone: vi.fn(),
    log: vi.fn(),
  } as unknown as ReturnType<typeof makeDeps>;
}

function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

/** fake timers 下推进 N 毫秒并让 await delay(...) 链跑完。 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env[REBUILD_INJECT_ENV];
  resetRebuildFailureInjectionForTest();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env[REBUILD_INJECT_ENV];
  resetRebuildFailureInjectionForTest();
  vi.restoreAllMocks();
});

// ── [OR-2] rebuild 抛错回灌重试矩阵 ──────────────────────────

describe("[OR-2] rebuildRuntime 抛错回灌重试矩阵", () => {
  it("rebuild 抛错 → workerErrorCount 递增回灌 → 下一次 rebuild 成功 → run 恢复（不卡 running）", async () => {
    const run = makeRealRun("wf-rebuild-1");
    const deps = makeDeps();
    // 第 1 次 start（rebuild #1）抛错，之后成功——模拟瞬时线程耗尽
    let calls = 0;
    deps.workerHost.start.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        throw new Error("Resource temporarily unavailable");
      }
      return { postMessage: vi.fn(), terminate: vi.fn(async () => {}) } as unknown as WorkerHandle;
    });

    // worker 崩溃（count=1 ≤ 3 → scheduleRebuild → rebuild #1 抛错 → count=2 → 再排程）
    const p = handleWorkerError(run, new Error("worker boom"), deps, makeHandlers());
    await advance(1000); // 第 1 次退避 1s
    await advance(2000); // 回灌后第 2 次退避 2s（retryIndex=2）
    await p;

    // 回灌矩阵生效：两次计数（崩溃 + rebuild 失败）
    expect(run.meta.workerErrorCount).toBe(2);
    // rebuild #2 成功 → run 仍 running（旧 worker 已换新，不卡死不误判 failed）
    expect(run.state.status).toBe("running");
    expect(deps.workerHost.start).toHaveBeenCalledTimes(2);
    // 未收敛终态：不 save、不注销（直落）
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.appendEntry).not.toHaveBeenCalled();
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("rebuild 连续失败耗尽（count > MAX=3）→ 收敛 done,failed + 持久化 + 注销 + onRunDone", async () => {
    const run = makeRealRun("wf-rebuild-2");
    const deps = makeDeps({ startThrows: true });

    // await 链本身不 reject——旧实现此处裸抛 → void handlers.onError → unhandledRejection
    const p = handleWorkerError(run, new Error("worker boom"), deps, makeHandlers());
    // 退避序列：1s（crash→rebuild#1）→ 2s（#1 失败→#2）→ 4s（#2 失败→#3）→ 8s（#3 失败→耗尽）
    await advance(1000 + 2000 + 4000 + 8000);
    await expect(p).resolves.toBeUndefined();

    // 计数：崩溃 1 + rebuild 失败 3 = 4 > MAX
    expect(run.meta.workerErrorCount).toBe(4);
    // 收敛 done,failed（不卡 running）
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toContain("Runtime rebuild failed after 3 retries");
    expect(run.state.error).toContain("Resource temporarily unavailable");
    // workerHost.start 恰好试了 3 次（3 次 rebuild 全失败）
    expect(deps.workerHost.start).toHaveBeenCalledTimes(3);
    // 终态三件套：持久化 + pending:unregister 直落 + onRunDone
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.appendEntry).toHaveBeenCalledWith("pending:unregister", {
      id: "wf-rebuild-2",
      reason: "failed",
      status: "failed",
    });
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("耗尽收敛前 run 已被 abort（退避窗口内转终态）→ 不再 rebuild 也不再误转 failed", async () => {
    const run = makeRealRun("wf-rebuild-3");
    const deps = makeDeps({ startThrows: true });

    const p = handleWorkerError(run, new Error("worker boom"), deps, makeHandlers());
    // 退避窗口内外部 abort（done,aborted）
    run.transition("done", "aborted");
    await advance(1000);
    await expect(p).resolves.toBeUndefined();

    // scheduleRebuild 退避后重检 isTerminal → 跳过重建；isTerminal(run) 守卫跳过回灌
    expect(deps.workerHost.start).not.toHaveBeenCalled();
    expect(run.meta.workerErrorCount).toBe(1); // 仅崩溃那次，rebuild 失败未计数
    expect(run.state.reason).toBe("aborted");
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });
});

// ── [P-SD] TAIJI_SUBAGENT_TEST_INJECT_REBUILD_FAILURE 注入钩子 ──

describe("[P-SD] 重建失败注入钩子（TAIJI_SUBAGENT_TEST_INJECT_REBUILD_FAILURE）", () => {
  it("env=1：rebuild 第 1 次起全部抛错 → 重试矩阵确定性耗尽 → done,failed（S-D 子场景②）", async () => {
    process.env[REBUILD_INJECT_ENV] = "1";
    const run = makeRealRun("wf-inject-1");
    const deps = makeDeps(); // start 本身不抛——抛错全部来自钩子注入

    const p = handleWorkerError(run, new Error("worker boom"), deps, makeHandlers());
    await advance(1000 + 2000 + 4000 + 8000);
    await expect(p).resolves.toBeUndefined();

    // workerHost.start 从未被调到（rebuildRuntime 在 start 前注入抛错）
    expect(deps.workerHost.start).not.toHaveBeenCalled();
    // 注入错误进入重试矩阵并耗尽：崩溃 1 + 注入失败 3 = 4
    expect(run.meta.workerErrorCount).toBe(4);
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toContain("[S-D test hook]");
    expect(run.state.error).toContain("Runtime rebuild failed after 3 retries");
  });

  it("激活即 warn 留痕且恰一次（安全约束：杜绝静默生效/刷屏）", async () => {
    process.env[REBUILD_INJECT_ENV] = "1";
    const loggerSpy = vi.spyOn(getLogger("subagents"), "warn");
    const run = makeRealRun("wf-inject-warn");
    const deps = makeDeps();

    const p = handleWorkerError(run, new Error("worker boom"), deps, makeHandlers());
    await advance(1000 + 2000 + 4000 + 8000);
    await p;

    const warnCalls = loggerSpy.mock.calls.map((c) => String(c[0]));
    const hookWarns = warnCalls.filter((m) => m.includes(REBUILD_INJECT_ENV));
    expect(hookWarns).toHaveLength(1);
    expect(hookWarns[0]).toContain("ACTIVE");
    expect(hookWarns[0]).toContain("NEVER set in production");
  });

  it("env 未设置：钩子完全不激活，rebuild 照常（无 warn、start 正常被调）", async () => {
    delete process.env[REBUILD_INJECT_ENV];
    const loggerSpy = vi.spyOn(getLogger("subagents"), "warn");
    const run = makeRealRun("wf-inject-off");
    const deps = makeDeps();

    const p = handleWorkerError(run, new Error("worker boom"), deps, makeHandlers());
    await advance(1000);
    await p;

    expect(loggerSpy.mock.calls.filter((c) => String(c[0]).includes(REBUILD_INJECT_ENV))).toHaveLength(0);
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
    expect(run.state.status).toBe("running");
  });

  it("env 非法值（非正整数）：不激活 + warn 指明原值（杜绝静默失效，LC-7 同族）", async () => {
    process.env[REBUILD_INJECT_ENV] = "abc";
    const loggerSpy = vi.spyOn(getLogger("subagents"), "warn");
    const run = makeRealRun("wf-inject-invalid");
    const deps = makeDeps();

    const p = handleWorkerError(run, new Error("worker boom"), deps, makeHandlers());
    await advance(1000);
    await p;

    // 非法值 → 不注入：rebuild 正常执行
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
    expect(run.state.status).toBe("running");
    // 且 warn 留痕指明钩子未激活
    const hookWarns = loggerSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(REBUILD_INJECT_ENV));
    expect(hookWarns).toHaveLength(1);
    expect(hookWarns[0]).toContain('"abc"');
    expect(hookWarns[0]).toContain("INACTIVE");
  });

  it("env=0 / 负数 / 空串：同样不激活（空串 = 未设置语义）", async () => {
    for (const raw of ["0", "-3", ""]) {
      resetRebuildFailureInjectionForTest();
      const loggerSpy = vi.spyOn(getLogger("subagents"), "warn");
      if (raw === "") {
        delete process.env[REBUILD_INJECT_ENV];
      } else {
        process.env[REBUILD_INJECT_ENV] = raw;
      }
      const run = makeRealRun(`wf-inject-${raw || "empty"}`);
      const deps = makeDeps();
      const p = handleWorkerError(run, new Error("boom"), deps, makeHandlers());
      await advance(1000);
      await p;
      expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
      expect(run.state.status).toBe("running");
      loggerSpy.mockRestore();
    }
  });

  it("钩子序数跨 rebuild 生效：env=2 时第 1 次 rebuild 正常、第 2 次起注入", async () => {
    process.env[REBUILD_INJECT_ENV] = "2";
    const run = makeRealRun("wf-inject-ordinal");
    const deps = makeDeps();
    const handlers = makeHandlers();

    // 第 1 次崩溃 → rebuild #1（进程级序数 1 < 2）→ 注入不生效，真实重建成功
    const p1 = handleWorkerError(run, new Error("worker boom"), deps, handlers);
    await advance(1000);
    await p1;
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
    expect(run.state.status).toBe("running");

    // 第 2 次崩溃（新代际 worker）→ rebuild #2（序数 2 ≥ 2）起注入拦截 → 矩阵耗尽收敛
    const p2 = handleWorkerError(run, new Error("worker boom 2"), deps, handlers);
    await advance(2000 + 4000 + 8000);
    await p2;

    // rebuild #1 真实执行过；#2/#3 被注入拦截（start 不再增长）
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
    expect(run.meta.workerErrorCount).toBe(4);
    expect(run.state.reason).toBe("failed");
    expect(run.state.error).toContain("[S-D test hook]");
  });
});
