/**
 * executeNestedWorkflow — workflow() 嵌套调用实现测试。
 *
 * 覆盖 6 个场景：循环检测、registry 未找到、lint 失败、成功执行、budget 同步、
 * 子 workflow 失败。
 *
 * 通过 vi.mock("../lifecycle.ts") 控制 runWorkflow：返回固定 runId + 把预构造的
 * child run 注入 deps.runs，使 pollRunToResult 首轮即命中 done 返回（无需真实 worker）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Budget } from "../models/budget.ts";
import type { RunSpec } from "../models/run-spec.ts";
import type { LauncherDeps } from "../launcher.ts";
import type { LintResult } from "../script-lint.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";
import type { WorkflowScript } from "../models/workflow-script.ts";

// ── module mock：lifecycle.runWorkflow 由各 test 配置 ──────────────────

vi.mock("../lifecycle.ts", () => ({
  runWorkflow: vi.fn(),
  abortRun: vi.fn(async () => {}),
  scheduleTimeBudget: vi.fn(() => undefined),
}));

// import 在 vi.mock 之后（hoisting 保证拿到 mock 版本）。runWorkflow 从被 mock 的
// lifecycle 模块导入，与 launcher.ts 内部引用的是同一 mock 实例。
import { runWorkflow, abortRun } from "../lifecycle.ts";
import { ArgsValidationError } from "../args-validator.ts";
import { RUN_WATCHDOG_ENV, executeNestedWorkflow, runAndWait } from "../launcher.ts";

const MOCK_RUN_ID = "wf-test-child";

// ── helpers ──────────────────────────────────────────────────

/** 构造 mock WorkflowScript（validate / toExecutable 可控）。 */
function makeScript(opts: { valid?: boolean; lintErrorMsg?: string } = {}): WorkflowScript {
  const valid = opts.valid ?? true;
  return {
    name: "child-wf",
    path: "/fake/child-wf.js",
    meta: { name: "child-wf", description: "child workflow", phases: [] },
    toExecutable: () => "const meta = {}; execute() {}",
    validate: (): LintResult => ({
      valid,
      findings: valid
        ? []
        : [
            {
              severity: "error",
              line: 3,
              message: opts.lintErrorMsg ?? "lint boom",
              suggestion: "fix it",
            },
          ],
    }),
  } as unknown as WorkflowScript;
}

/**
 * 构造 mock parent WorkflowRun。
 *
 * parentBudget 用真实 Budget 实例（remaining() + 可写 usedTokens/usedCost）。
 * controller 提供 AbortSignal（默认未 abort）。
 */
function makeParentRun(opts: {
  scriptName?: string;
  parentWorkflowChain?: readonly string[];
  budget?: Budget;
  aborted?: boolean;
  /** 预算语义对齐：父 run 级时间预算（deadline 传导测试用） */
  budgetTimeMs?: number;
} = {}): WorkflowRun {
  const controller = new AbortController();
  if (opts.aborted) controller.abort();
  const spec = {
    scriptName: opts.scriptName ?? "parent-wf",
    parentWorkflowChain: opts.parentWorkflowChain,
    budgetTimeMs: opts.budgetTimeMs,
  };
  return {
    spec,
    state: { budget: opts.budget ?? new Budget({ maxTokens: 10000 }) },
    runtime: { controller },
  } as unknown as WorkflowRun;
}

/**
 * 构造 mock child WorkflowRun（done 终态，pollRunToResult 首轮命中）。
 *
 * childBudget 用普通对象（仅需 usedTokens/usedCost 供 budget 同步读取）。
 */
function makeDoneChildRun(opts: {
  reason?: "completed" | "failed" | "aborted";
  scriptResult?: unknown;
  error?: string;
  usedTokens?: number;
  usedCost?: number;
}): WorkflowRun {
  const reason = opts.reason ?? "completed";
  return {
    runId: MOCK_RUN_ID,
    spec: { scriptName: "child-wf" },
    state: {
      status: "done",
      reason,
      scriptResult: opts.scriptResult,
      error: opts.error,
      budget: { usedTokens: opts.usedTokens ?? 0, usedCost: opts.usedCost ?? 0 },
    },
  } as unknown as WorkflowRun;
}

/**
 * 构造 mock child WorkflowRun（running 态，pollRunToResult 持续轮询）。
 * state 可变——deadline 测试中手动翻转为 done 模拟子 run 完成。
 */
function makeRunningChildRun(): WorkflowRun {
  return {
    runId: MOCK_RUN_ID,
    spec: { scriptName: "child-wf" },
    state: {
      status: "running",
      reason: undefined,
      scriptResult: undefined,
      error: undefined,
      budget: { usedTokens: 0, usedCost: 0 },
    },
  } as unknown as WorkflowRun;
}

/** 构造 LauncherDeps mock：registry + runs（Map）+ 占位 port。 */
function makeDeps(opts: {
  script?: WorkflowScript;
  childRun?: WorkflowRun;
  registry?: { getPath: ReturnType<typeof vi.fn> };
} = {}): LauncherDeps {
  const runs = new Map<string, WorkflowRun>();
  if (opts.childRun) runs.set(MOCK_RUN_ID, opts.childRun);
  const registry = opts.registry ?? {
    getPath: vi.fn(async () => opts.script),
  };
  return {
    registry,
    runs,
    store: { save: vi.fn(async () => {}), loadAll: vi.fn(async () => []) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({})) },
    log: vi.fn(),
    eventBus: { emit: vi.fn() },
  } as unknown as LauncherDeps;
}

/** 配置 runWorkflow mock：把 childRun 注入 deps.runs 并返回 MOCK_RUN_ID。 */
function setupRunWorkflow(childRun: WorkflowRun): void {
  vi.mocked(runWorkflow).mockImplementation(async (_spec, deps) => {
    deps.runs.set(MOCK_RUN_ID, childRun);
    return MOCK_RUN_ID;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // [F-4 假红源修复] env 隔离对称化：本文件的「不限时」用例（deadline 传导 /
  // runAndWait timeoutMs 语义）依赖「TAIJI_SUBAGENT_RUN_WATCHDOG_MS 未设」基线，
  // 宿主 shell export 即假红（U7 describe 内部 stubEnv 不覆盖同文件其他用例）。
  // 空串 = 未设（getEnvRunWatchdogMs 的 raw falsy 判定）；SPAWN_WATCHDOG 同款
  // 防御（launcher 不读，防未来接线后回归）。
  vi.stubEnv(RUN_WATCHDOG_ENV, "");
  vi.stubEnv("TAIJI_SUBAGENT_SPAWN_WATCHDOG_MS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── tests ────────────────────────────────────────────────────

describe("executeNestedWorkflow", () => {
  it("returns error result when workflow not found", async () => {
    const parent = makeParentRun();
    const signal = parent.runtime!.controller.signal;
    const addSpy = vi.spyOn(signal, "addEventListener");
    const removeSpy = vi.spyOn(signal, "removeEventListener");
    const deps = makeDeps({ script: undefined });

    const result = await executeNestedWorkflow("missing", {}, parent, deps);

    expect(result.error).toBe("Workflow 'missing' not found");
    expect(result.content).toBe("");
    expect(runWorkflow).not.toHaveBeenCalled();
    // E8：早返回也走 finally——Step 2 注册的 listener 被移除（原实现泄漏）
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("returns error result on lint failure", async () => {
    const parent = makeParentRun();
    const deps = makeDeps({ script: makeScript({ valid: false, lintErrorMsg: "no entry point" }) });

    const result = await executeNestedWorkflow("child-wf", {}, parent, deps);

    expect(result.error).toContain("has lint errors");
    expect(result.error).toContain("no entry point");
    expect(result.content).toBe("");
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it("TC11: chokepoint 校验失败 → {error} + parentSignal listener 不泄漏（E8）", async () => {
    // 模块级 mock lifecycle：runWorkflow reject ArgsValidationError（真实实例——
    // launcher.ts 未被 mock，instanceof 检查命中同一 class）。
    vi.mocked(runWorkflow).mockRejectedValueOnce(
      new ArgsValidationError(
        "child-wf",
        "Invalid args for workflow 'child-wf': 1 error(s)\n- /target: is required\nRead the workflow script file (location from <available_workflows>) for the parameter schema and usage.",
      ),
    );
    const parent = makeParentRun();
    const signal = parent.runtime!.controller.signal;
    const addSpy = vi.spyOn(signal, "addEventListener");
    const removeSpy = vi.spyOn(signal, "removeEventListener");
    const deps = makeDeps({ script: makeScript() });

    const result = await executeNestedWorkflow("child-wf", {}, parent, deps);

    expect(result.content).toBe("");
    expect(result.error).toContain("Invalid args for workflow 'child-wf'");
    // Step 2 注册 1 次 + finally 移除 1 次 → 平衡即无泄漏（E8 修复点）
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("detects circular call chain", async () => {
    // parent chain ["a"], parent scriptName "b", target name "a" → a→b→a 循环
    const parent = makeParentRun({
      scriptName: "b",
      parentWorkflowChain: ["a"],
    });
    const deps = makeDeps({ script: makeScript() });

    const result = await executeNestedWorkflow("a", {}, parent, deps);

    expect(result.error).toContain("Circular workflow call detected");
    expect(result.error).toContain("a → b → a");
    expect(result.content).toBe("");
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it("executes child workflow and returns result on success", async () => {
    const parent = makeParentRun();
    const childRun = makeDoneChildRun({
      reason: "completed",
      scriptResult: { summary: "done" },
    });
    const deps = makeDeps({ script: makeScript(), childRun });
    setupRunWorkflow(childRun);

    const result = await executeNestedWorkflow("child-wf", { k: 1 }, parent, deps);

    // content = JSON.stringify(scriptResult)；parsedOutput 原样回传对象
    expect(result.error).toBeUndefined();
    expect(result.content).toBe(JSON.stringify({ summary: "done" }));
    expect(result.parsedOutput).toEqual({ summary: "done" });
    expect(runWorkflow).toHaveBeenCalledTimes(1);
  });

  it("shares parent budget reference with child run (no sync-back)", async () => {
    const parentBudget = new Budget({ maxTokens: 10000 });
    parentBudget.usedTokens = 100;
    const parent = makeParentRun({ budget: parentBudget });
    const childRun = makeDoneChildRun({
      reason: "completed",
      scriptResult: "ok",
    });
    const deps = makeDeps({ script: makeScript(), childRun });

    // 捕获传给 runWorkflow 的 spec——验证 budgetRef 共享父 Budget 引用
    let capturedSpec: RunSpec | undefined;
    vi.mocked(runWorkflow).mockImplementation(async (spec, d) => {
      capturedSpec = spec;
      d.runs.set(MOCK_RUN_ID, childRun);
      return MOCK_RUN_ID;
    });

    await executeNestedWorkflow("child-wf", {}, parent, deps);

    // 子 run 直接复用父 Budget 引用（budgetRef），而非独立 Budget + sync-back
    expect(capturedSpec?.budgetRef).toBe(parentBudget);
    expect(capturedSpec?.budgetTokens).toBeUndefined();
    // 无 sync-back：parent budget 不被 launcher 直接修改（mock 未真实 consume）
    expect(parent.state.budget.usedTokens).toBe(100);
  });

  it("returns error result when child workflow fails", async () => {
    const parent = makeParentRun();
    const childRun = makeDoneChildRun({
      reason: "failed",
      error: "agent exploded",
    });
    const deps = makeDeps({ script: makeScript(), childRun });
    setupRunWorkflow(childRun);

    const result = await executeNestedWorkflow("child-wf", {}, parent, deps);

    expect(result.content).toBe("");
    expect(result.error).toBe("agent exploded");
  });

  // ── deadline 传导（预算语义对齐 2026-08）──
  // 语义：父 spec.budgetTimeMs 显式设定 → 原样作为子 run 轮询 deadline（不 min(DEFAULT)
  // 封顶）；父未设 → 无 deadline。旧实现 min(父, 10min) 把父 time:2h 截断到 10min。
  describe("deadline 传导（预算语义对齐）", () => {
    it("父 budgetTimeMs=2h → 子 deadline 传导 2h（不 min(10min) 封顶）", async () => {
      vi.useFakeTimers();
      try {
        // 确定性起点：deadline = 0 + 7_200_000（pollRunToResult 入口算术计算）。
        vi.setSystemTime(0);
        const parent = makeParentRun({ budgetTimeMs: 7_200_000 });
        const childRun = makeRunningChildRun();
        const deps = makeDeps({ script: makeScript(), childRun });
        setupRunWorkflow(childRun);

        const promise = executeNestedWorkflow("child-wf", {}, parent, deps);
        // 冲刷微任务至 pollRunToResult 已算出 deadline 并挂起首个 500ms 轮询 tick
        // （deadline 在轮询入口计算——先跳时钟会让 deadline 跟随后移，必须后跳）。
        await vi.advanceTimersByTimeAsync(0);

        // 越过旧 10min 默认：不应 abort（若回归 min 封顶，这里会触发 time_limited abort）。
        // deadline 是 while(Date.now() < deadline) 算术比较（非调度定时器）——
        // setSystemTime 直跳 + 单个 500ms tick 唤醒挂起的轮询即可判定，无需逐 tick 推进。
        vi.setSystemTime(600_000 + 500);
        await vi.advanceTimersByTimeAsync(500);
        expect(vi.mocked(abortRun)).not.toHaveBeenCalled();

        // 2h deadline 到期：abortRun 收到完整 7200000ms 超时 + time_limited
        vi.setSystemTime(7_200_000 + 1_000);
        await vi.advanceTimersByTimeAsync(500);
        const result = await promise;
        expect(vi.mocked(abortRun)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(abortRun)).toHaveBeenCalledWith(
          MOCK_RUN_ID,
          deps,
          "Workflow timed out after 7200000ms",
          "time_limited",
        );
        void result;
      } finally {
        vi.useRealTimers();
      }
    });

    it("父未传 budgetTimeMs → 无 deadline（远超旧 10min 默认不 abort，子完成正常返回）", async () => {
      vi.useFakeTimers();
      try {
        const parent = makeParentRun();
        const childRun = makeRunningChildRun();
        const deps = makeDeps({ script: makeScript(), childRun });
        setupRunWorkflow(childRun);

        const promise = executeNestedWorkflow("child-wf", {}, parent, deps);

        // 旧实现 DEFAULT_RUNANDWAIT_TIMEOUT_MS=10min 会在此 abort；不限时则不 abort
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 500);
        expect(vi.mocked(abortRun)).not.toHaveBeenCalled();

        // 子 run 完成 → 正常返回 completed（deadline 仍是 undefined）
        childRun.state.status = "done";
        childRun.state.reason = "completed";
        childRun.state.scriptResult = "ok";
        await vi.advanceTimersByTimeAsync(500);
        const result = await promise;
        // 成功分支返回 { content, parsedOutput? }（无 reason 字段）——string scriptResult 走 content
        expect(result.content).toBe("ok");
        expect(result.error).toBeUndefined();
        expect(vi.mocked(abortRun)).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    // [U2] 预算语义统一：budgetTimeMs <=0（含 0/负）与 undefined 同义 = 不限——
    // 旧实现 0 传导给子 run 后 deadline=now 立即超时（"timed out after 0ms"），与
    // lifecycle 的 0=不限（>0 才挂 scheduleTimeBudget）语义分裂。
    it("父 budgetTimeMs=0 → 不限（旧实现立即超时；子 run 晚完成正常返回，U2）", async () => {
      vi.useFakeTimers();
      try {
        const parent = makeParentRun({ budgetTimeMs: 0 });
        const childRun = makeRunningChildRun();
        const deps = makeDeps({ script: makeScript(), childRun });
        setupRunWorkflow(childRun);

        const promise = executeNestedWorkflow("child-wf", {}, parent, deps);

        // 旧实现 0 落成 deadline=now：首轮轮询即 abort time_limited。不限时则不 abort
        await vi.advanceTimersByTimeAsync(5_000);
        expect(vi.mocked(abortRun)).not.toHaveBeenCalled();

        childRun.state.status = "done";
        childRun.state.reason = "completed";
        childRun.state.scriptResult = "ok";
        await vi.advanceTimersByTimeAsync(500);
        const result = await promise;
        expect(result.content).toBe("ok");
        expect(result.error).toBeUndefined();
        expect(vi.mocked(abortRun)).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("父 budgetTimeMs=-5000 → 不限且错误串无 \"-5000ms\"（U2 负数同义不限）", async () => {
      vi.useFakeTimers();
      try {
        const parent = makeParentRun({ budgetTimeMs: -5_000 });
        const childRun = makeRunningChildRun();
        const deps = makeDeps({ script: makeScript(), childRun });
        setupRunWorkflow(childRun);

        const promise = executeNestedWorkflow("child-wf", {}, parent, deps);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(vi.mocked(abortRun)).not.toHaveBeenCalled();

        childRun.state.status = "done";
        childRun.state.reason = "completed";
        childRun.state.scriptResult = "ok";
        await vi.advanceTimersByTimeAsync(500);
        const result = await promise;
        expect(result.content).toBe("ok");
        expect(result.error).toBeUndefined();
        // 防御：任何路径都不产生 "timed out after -5000ms" 类错误串
        const abortCalls = vi.mocked(abortRun).mock.calls.map((c) => String(c[2]));
        expect(abortCalls.join(";")).not.toContain("-5000ms");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── runAndWait timeoutMs 语义（预算语义对齐 2026-08）──
  describe("runAndWait timeoutMs 语义（预算语义对齐）", () => {
    it("未传 timeoutMs → 不限（远超旧 10min 默认不 abort，完成后正常返回）", async () => {
      vi.useFakeTimers();
      try {
        const childRun = makeRunningChildRun();
        const deps = makeDeps({ script: makeScript(), childRun });
        setupRunWorkflow(childRun);

        // 只传 3 参：不传 signal / timeoutMs
        const promise = runAndWait("child-wf", {}, deps);

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 500);
        expect(vi.mocked(abortRun)).not.toHaveBeenCalled();

        childRun.state.status = "done";
        childRun.state.reason = "completed";
        childRun.state.scriptResult = "ok";
        await vi.advanceTimersByTimeAsync(500);
        const result = await promise;
        expect(result.status).toBe("done");
        expect(result.reason).toBe("completed");
        expect(vi.mocked(abortRun)).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("显式 timeoutMs=1000 → 到期 abort time_limited（限时能力保留）", async () => {
      vi.useFakeTimers();
      try {
        const childRun = makeRunningChildRun();
        const deps = makeDeps({ script: makeScript(), childRun });
        setupRunWorkflow(childRun);

        const promise = runAndWait("child-wf", {}, deps, undefined, 1_000);

        await vi.advanceTimersByTimeAsync(1_000 + 500);
        const result = await promise;
        expect(vi.mocked(abortRun)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(abortRun)).toHaveBeenCalledWith(
          MOCK_RUN_ID,
          deps,
          "Workflow timed out after 1000ms",
          "time_limited",
        );
        void result;
      } finally {
        vi.useRealTimers();
      }
    });

    // [U2] 0/负 timeoutMs 与 undefined 同义 = 不限（旧实现 0 → 立即超时、
    // 负数 → "timed out after -5000ms" 类错误串）。
    it("timeoutMs=0 → 不限（旧实现立即超时；不产生 \"timed out after 0ms\"，U2）", async () => {
      vi.useFakeTimers();
      try {
        const childRun = makeRunningChildRun();
        const deps = makeDeps({ script: makeScript(), childRun });
        setupRunWorkflow(childRun);

        const promise = runAndWait("child-wf", {}, deps, undefined, 0);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(vi.mocked(abortRun)).not.toHaveBeenCalled();

        childRun.state.status = "done";
        childRun.state.reason = "completed";
        childRun.state.scriptResult = "ok";
        await vi.advanceTimersByTimeAsync(500);
        const result = await promise;
        expect(result.reason).toBe("completed");
        expect(vi.mocked(abortRun)).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    // [U7] TAIJI_SUBAGENT_RUN_WATCHDOG_MS：显式不限时 run 的绝对时限兑底（与
    // spawn watchdog env 同款：未设 = 无兑底，设置 = opt-in 挂载）。
    describe("TAIJI_SUBAGENT_RUN_WATCHDOG_MS 兑底（U7）", () => {
      it("env 设置 + 未传 timeoutMs → env 时限到期 abort time_limited，错误串含 env 值", async () => {
        vi.useFakeTimers();
        try {
          vi.stubEnv(RUN_WATCHDOG_ENV, "1000");
          const childRun = makeRunningChildRun();
          const deps = makeDeps({ script: makeScript(), childRun });
          setupRunWorkflow(childRun);

          const promise = runAndWait("child-wf", {}, deps);

          await vi.advanceTimersByTimeAsync(1_000 + 500);
          const result = await promise;
          expect(vi.mocked(abortRun)).toHaveBeenCalledWith(
            MOCK_RUN_ID,
            deps,
            "Workflow timed out after 1000ms",
            "time_limited",
          );
          // mock abortRun 不翻转 run 状态（对齐同组 timeoutMs=1000 用例）：result.reason
          // 是 toResult 对 running run 的防御 fallback，不在此断言
          void result;
        } finally {
          vi.useRealTimers();
          vi.unstubAllEnvs();
        }
      });

      it("env 设置 + 显式 timeoutMs → 显式值优先（env 不截断显式限时）", async () => {
        vi.useFakeTimers();
        try {
          vi.stubEnv(RUN_WATCHDOG_ENV, "1000");
          const childRun = makeRunningChildRun();
          const deps = makeDeps({ script: makeScript(), childRun });
          setupRunWorkflow(childRun);

          const promise = runAndWait("child-wf", {}, deps, undefined, 60_000);

          // env 1000ms 到期：不 abort（显式 60s 优先）
          await vi.advanceTimersByTimeAsync(1_000 + 500);
          expect(vi.mocked(abortRun)).not.toHaveBeenCalled();

          // 显式 60s 到期：才 abort，错误串为显式值
          await vi.advanceTimersByTimeAsync(60_000);
          const result = await promise;
          expect(vi.mocked(abortRun)).toHaveBeenCalledWith(
            MOCK_RUN_ID,
            deps,
            "Workflow timed out after 60000ms",
            "time_limited",
          );
          void result;
        } finally {
          vi.useRealTimers();
          vi.unstubAllEnvs();
        }
      });

      it("env 非法值（abc / -1）→ 视为未设（无兑底，不限）", async () => {
        vi.useFakeTimers();
        try {
          const childRun = makeRunningChildRun();
          const deps = makeDeps({ script: makeScript(), childRun });
          setupRunWorkflow(childRun);

          vi.stubEnv(RUN_WATCHDOG_ENV, "abc");
          const promiseAbc = runAndWait("child-wf", {}, deps);
          await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 500);
          expect(vi.mocked(abortRun)).not.toHaveBeenCalled();
          // 收尾完成，防用例间 promise 悬挂
          childRun.state.status = "done";
          childRun.state.reason = "completed";
          childRun.state.scriptResult = "ok";
          await vi.advanceTimersByTimeAsync(500);
          await promiseAbc;

          vi.mocked(abortRun).mockClear();
          vi.stubEnv(RUN_WATCHDOG_ENV, "-1");
          // childRun 已是 done 态：pollRunToResult 首轮即命中终态返回，无 deadline 可言
          await runAndWait("child-wf", {}, deps);
          expect(vi.mocked(abortRun)).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
          vi.unstubAllEnvs();
        }
      });
    });
  });
});

// ── runAndWait model 透传（host-surface：zsw CLI --model 的同步面入口）──
// 契约：显式 model → spec.model（Option B：workerData → $MODEL → agent() fallback）；
// 未传 → undefined（不覆盖脚本内 agent() 显式参数 / agent .md / 引擎默认的解析序）。
describe("runAndWait model 透传", () => {
  it("显式 model → spec.model 透传", async () => {
    const childRun = makeDoneChildRun({ reason: "completed", scriptResult: "ok" });
    const deps = makeDeps({ script: makeScript(), childRun });
    setupRunWorkflow(childRun);

    const result = await runAndWait(
      "child-wf",
      {},
      deps,
      undefined,
      undefined,
      "zai-coding-cn/glm-5.3-flash",
    );
    expect(result.reason).toBe("completed");
    expect(vi.mocked(runWorkflow)).toHaveBeenCalledTimes(1);
    const spec = vi.mocked(runWorkflow).mock.calls[0]![0] as RunSpec;
    expect(spec.model).toBe("zai-coding-cn/glm-5.3-flash");
  });

  it("未传 model → spec.model 保持 undefined（不覆盖既有解析序）", async () => {
    const childRun = makeDoneChildRun({ reason: "completed", scriptResult: "ok" });
    const deps = makeDeps({ script: makeScript(), childRun });
    setupRunWorkflow(childRun);

    await runAndWait("child-wf", {}, deps);
    const spec = vi.mocked(runWorkflow).mock.calls[0]![0] as RunSpec;
    expect(spec.model).toBeUndefined();
  });
});
