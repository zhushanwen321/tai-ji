/**
 * lifecycle — runWorkflow/abortRun/terminateRunningRuns/scheduleTimeBudget/evict 测试。
 *
 * 用真实 WorkflowRun（含真实状态机 + I1/I2 不变式守卫）+ mock RunRuntime（释放副作用
 * 可控）+ mock LifecycleDeps（store/workerHost/eventBus 可观察）。这样能真正测到
 * transition/assignRuntime/releaseRuntime 的状态机逻辑，而非全 mock 聚合根。
 *
 * 覆盖：
 * - runWorkflow：spec → 创建 run + workerHost.start + store.save + emit pending:register
 * - abortRun：done no-op / running→done + emit pending:unregister
 * - terminateRunningRuns：session 切换/关闭时仅 running 被终止（done,failed 落盘）
 * - scheduleTimeBudget：定时器到期 → abortRun(done,time_limited)（用 fake timers）
 * - evictDoneRunsBeyondCap：done run 内存淘汰白名单/排序/tie
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  abortRun,
  evictDoneRunsBeyondCap,
  MAX_RETAINED_DONE_RUNS,
  runWorkflow,
  scheduleTimeBudget,
  terminateRunningRuns,
} from "../lifecycle.ts";
import { ArgsValidationError } from "../args-validator.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { RunSpec } from "../models/run-spec.ts";
import type { LifecycleDeps } from "../models/ports.ts";
import { WorkflowRun } from "../models/workflow-run.ts";

// ── helpers ──────────────────────────────────────────────────

/** 构造一个最小 RunSpec（满足 WorkflowRun 构造的字段需求）。 */
function makeSpec(opts: {
  budgetTimeMs?: number;
  budgetTokens?: number;
  parameters?: Record<string, unknown>;
  args?: Record<string, unknown>;
} = {}): RunSpec {
  return {
    scriptSource: "execute() {}",
    args: opts.args ?? {},
    parameters: opts.parameters,
    scriptName: "test-wf",
    scriptPath: "/fake/test.js",
    budgetTimeMs: opts.budgetTimeMs,
    budgetTokens: opts.budgetTokens,
  };
}

/**
 * 构造一个 status="running" 的真实 WorkflowRun，注入 mock RunRuntime。
 *
 * 流程：new WorkflowRun（status=running，I1 构造期跳过）→ assignRuntime
 * （注入 runtime，恢复 I1）。mock runtime 的 worker.terminate / controller.abort /
 * release 均可观察。
 */
/** flush microtask 队列多次，让 void .then().catch() + async 链跑完。
 *
 * 注意：fake timers 下 setTimeout(resolve,0) 也会被拦截，故用 Promise.resolve()
 * 走原生 microtask 队列（不被 fake timers 拦截）。 */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function makeRunningRealRun(
  runId: string,
  opts: { budgetTimeMs?: number } = {},
): { run: WorkflowRun; terminate: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> } {
  const spec = makeSpec(opts);
  const run = new WorkflowRun(
    runId,
    spec,
    {
      status: "running",
      budget: new Budget({ maxTokens: 1000 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
  const terminate = vi.fn(async () => {});
  const controller = new AbortController();
  const abort = vi.spyOn(controller, "abort");
  const worker = { terminate, postMessage: vi.fn() } as unknown as ConstructorParameters<typeof RunRuntime>[0];
  const runtime = new RunRuntime(
    worker as never,
    controller,
    undefined,
  );
  run.assignRuntime(runtime);
  return { run, terminate, abort };
}

/** LifecycleDeps mock：store/workerHost/eventBus/onRunDone/log 可观察。 */
function makeDeps(): LifecycleDeps & {
  store: { save: ReturnType<typeof vi.fn>; loadAll: ReturnType<typeof vi.fn> };
  workerHost: { start: ReturnType<typeof vi.fn> };
  eventBus: { emit: ReturnType<typeof vi.fn> };
  onRunDone: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  return {
    store: { save: vi.fn(async () => {}), loadAll: vi.fn(async () => []) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn(), terminate: vi.fn(async () => {}) })) },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
  } as unknown as ReturnType<typeof makeDeps>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── scheduleTimeBudget ───────────────────────────────────────

describe("scheduleTimeBudget", () => {
  it("定时器到期 → abortRun(done,time_limited)", async () => {
    const { run } = makeRunningRealRun("wf-budget-1");
    const deps = makeDeps();
    deps.runs.set("wf-budget-1", run);

    const timer = scheduleTimeBudget("wf-budget-1", deps, 1000);
    expect(timer).toBeDefined();

    // 推进定时器到到期 + flush 让 abortRun async 链跑完
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("time_limited");
    expect(run.state.error).toContain("Time budget exceeded");
    // 完成通知
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:unregister", {
      id: "wf-budget-1",
      reason: "time_limited",
    });
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("run 已 done 时 abortRun no-op（到期不重复 transition）", async () => {
    const { run } = makeRunningRealRun("wf-budget-2");
    // 先把 run 转 done（手动）
    run.transition("done", "completed");
    const deps = makeDeps();
    deps.runs.set("wf-budget-2", run);

    scheduleTimeBudget("wf-budget-2", deps, 500);
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    // 状态保持原 done/completed，未被 time_limited 覆盖
    expect(run.state.reason).toBe("completed");
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("定时器 unref（不阻止 Node 退出）", () => {
    const deps = makeDeps();
    const timer = scheduleTimeBudget("wf-x", deps, 10000);
    // unref 是 Node timer 的方法，fake timer 也支持——验证不抛错
    expect(() => timer.unref()).not.toThrow();
    timer.unref();
  });

  // [U1] setTimeout 2^31-1 溢出 fail-fast：溢出 budgetTimeMs 被 Node 置 1ms 立即触发
  //（「不限时预算」变「立即超时」），arm 入口拦截且错误含上限值与恢复指引。
  it("budgetTimeMs 溢出（>2^31-1）→ fail-fast throw（不挂 timer、不静默 clamp）", () => {
    const deps = makeDeps();
    expect(() => scheduleTimeBudget("wf-overflow", deps, 3_000_000_000)).toThrowError(/2147483647/);
    expect(() => scheduleTimeBudget("wf-overflow", deps, Number.MAX_SAFE_INTEGER)).toThrowError(
      /Recovery/,
    );
  });
});

// ── runWorkflow ──────────────────────────────────────────────

describe("runWorkflow", () => {
  it("spec → 创建 run + 启动 worker + store.save + emit pending:register", async () => {
    const deps = makeDeps();
    const spec = makeSpec();

    const runId = await runWorkflow(spec, deps);

    expect(runId).toMatch(/^wf-/);
    // run 注册到 deps.runs
    expect(deps.runs.has(runId)).toBe(true);
    const run = deps.runs.get(runId)!;
    // status 为 running（assignRuntime 已绑定 runtime）
    expect(run.state.status).toBe("running");
    expect(run.runtime).toBeDefined();
    // workerHost.start 被调
    expect(deps.workerHost.start).toHaveBeenCalledTimes(1);
    // store.save 持久化
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    // pending:register 通知
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:register", {
      id: runId,
      type: "workflow",
      name: "test-wf",
    });
  });

  it("创建即 running：构造即 running，runs.set 在 assignRuntime 后（I1 窗口对外不可见）", async () => {
    const deps = makeDeps();
    // worker.start 被调时探测 runs 注册状态——证明 runs.set 在 assignRuntime 之后
    let runsSizeAtWorkerStart = -1;
    vi.spyOn(deps.workerHost, "start").mockImplementation(() => {
      runsSizeAtWorkerStart = deps.runs.size;
      return { postMessage: vi.fn(), terminate: vi.fn(async () => {}) };
    });

    const runId = await runWorkflow(makeSpec(), deps);

    // worker.start 执行时 run 尚未注册（I1 跳过窗口不外泄）
    expect(runsSizeAtWorkerStart).toBe(0);
    // 完成后已注册，且构造即 running + runtime 已注入（I1 成立）
    expect(deps.runs.has(runId)).toBe(true);
    const run = deps.runs.get(runId)!;
    expect(run.state.status).toBe("running");
    expect(run.runtime).toBeDefined();
    // save 落盘的是恢复 I1 后的聚合（status running + runtime 已绑定）
    const savedRun = deps.store.save.mock.calls[0]![0] as WorkflowRun;
    expect(savedRun).toBe(run);
    expect(savedRun.state.status).toBe("running");
  });

  it("worker.start 抛错 → runWorkflow 拒绝且 runs 无孤儿注册", async () => {
    const deps = makeDeps();
    deps.workerHost.start = vi.fn(() => {
      throw new Error("worker boot failed");
    });

    await expect(runWorkflow(makeSpec(), deps)).rejects.toThrow("worker boot failed");

    // 无孤儿：启动失败时 run 未注册进 deps.runs（runs.set 在 start 之后）
    expect(deps.runs.size).toBe(0);
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
  });

  // OR-1 顺序修复（unbounded-wait-audit §4.1）：budgetTimeMs 溢出的 fail-fast
  // 必须发生在首个副作用（workerHost.start）之前——旧顺序 worker 先启动、
  // scheduleTimeBudget 后 throw，产生「worker 已跑、run 永不可达」的孤儿。
  it("OR-1: budgetTimeMs 溢出（>2^31-1）→ worker 启动前 fail-fast（zero side effects）", async () => {
    const deps = makeDeps();
    const spec = makeSpec({ budgetTimeMs: 3_000_000_000 });

    await expect(runWorkflow(spec, deps)).rejects.toThrow(/2147483647/);

    // fail-fast 先于全部副作用：worker 未启动、run 未注册、未落盘、未通知
    expect(deps.workerHost.start).not.toHaveBeenCalled();
    expect(deps.runs.size).toBe(0);
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
  });

  // OR-1 前移的代价：start 抛错时已挂的 timeBudget timer 会残留（到期对从未注册的
  // runId 触发 abortRun → not found）——start 抛错路径必须就地 clearTimeout。
  it("OR-1: budgetTimeMs 有效但 worker.start 抛错 → timeBudget timer 被清理（无残留）", async () => {
    const deps = makeDeps();
    deps.workerHost.start = vi.fn(() => {
      throw new Error("worker boot failed");
    });

    // fake timers：用例开始时无 pending 计时器（beforeEach 全新安装）
    expect(vi.getTimerCount()).toBe(0);

    await expect(
      runWorkflow(makeSpec({ budgetTimeMs: 60_000 }), deps),
    ).rejects.toThrow("worker boot failed");

    // timer 挂载（scheduleTimeBudget）发生在 start 之前 → 抛错路径必须回收：
    // 无 pending 计时器残留（若漏清理此处为 1，到期会误 abort 幽灵 runId）
    expect(vi.getTimerCount()).toBe(0);
    // 既有行为不回归：runs Map 无该 runId 条目（abortRun not found 语义保持）
    expect(deps.runs.size).toBe(0);
  });

  it("带 budgetTimeMs 时调度时间预算计时器（真实消费：挂载 + 到期 time_limited）", async () => {
    const deps = makeDeps();
    const spec = makeSpec({ budgetTimeMs: 3000 });

    const runId = await runWorkflow(spec, deps);
    const run = deps.runs.get(runId)!;

    // 生产行为面①：budgetTimeMs>0 → RunRuntime.timeBudgetTimer 被真实挂载
    //（scheduleTimeBudget 产出的 Node timer，非死代码 spy）
    expect(run.runtime?.timeBudgetTimer).toBeDefined();

    // 生产行为面②：到期后 abortRun(time_limited) 真实触发——run 转 done，
    // reason/error/通知全部落位（文件级 beforeEach 已 fake timers）
    await vi.advanceTimersByTimeAsync(3000);
    await flushMicrotasks();

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("time_limited");
    expect(run.state.error).toContain("Time budget exceeded");
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:unregister", {
      id: runId,
      reason: "time_limited",
    });
  });

  it("未传 budgetTimeMs → 不挂时间预算计时器（对照：runtime.timeBudgetTimer undefined）", async () => {
    const deps = makeDeps();
    const runId = await runWorkflow(makeSpec(), deps);
    const run = deps.runs.get(runId)!;

    expect(run.runtime?.timeBudgetTimer).toBeUndefined();

    // 无预算 → 不存在到期 abort：推进 10min 后 run 仍 running
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await flushMicrotasks();
    expect(run.state.status).toBe("running");
  });

  it("signal 已 abort → fail fast（抛错，不创建 run）", async () => {
    const deps = makeDeps();
    const spec = makeSpec();
    const controller = new AbortController();
    controller.abort();

    await expect(runWorkflow(spec, deps, controller.signal)).rejects.toThrow(
      "aborted before start",
    );
    expect(deps.runs.size).toBe(0);
    expect(deps.workerHost.start).not.toHaveBeenCalled();
  });

  it("TC8: 参数校验失败 → throw ArgsValidationError + zero side effects（E9）", async () => {
    const deps = makeDeps();
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const spec = makeSpec({
      parameters: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
      },
      args: {},
    });

    await expect(runWorkflow(spec, deps, controller.signal)).rejects.toThrow(ArgsValidationError);
    expect(deps.runs.size).toBe(0);
    expect(deps.workerHost.start).not.toHaveBeenCalled();
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(deps.eventBus.emit).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled(); // 校验在 deps.log 前 throw（无日志痕迹）
  });
});

// ── abortRun ─────────────────────────────────────────────────

describe("abortRun", () => {
  it("running run → done,aborted：releaseRuntime + emit pending:unregister", async () => {
    const { run, terminate } = makeRunningRealRun("wf-abort-1");
    const deps = makeDeps();
    deps.runs.set("wf-abort-1", run);

    await abortRun("wf-abort-1", deps, "user cancelled");

    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("aborted");
    expect(run.state.error).toBe("user cancelled");
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(run.runtime).toBeUndefined();
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:unregister", {
      id: "wf-abort-1",
      reason: "aborted",
    });
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("done 状态 no-op（不重复 abort）", async () => {
    const { run } = makeRunningRealRun("wf-abort-2");
    run.transition("done", "completed");
    const deps = makeDeps();
    deps.runs.set("wf-abort-2", run);

    await abortRun("wf-abort-2", deps, "late abort");

    expect(run.state.reason).toBe("completed"); // 未被覆盖
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("[B-4] eventBus listener 抛错 → abortRun 不向调用方抛错、onRunDone 仍执行", async () => {
    const { run, terminate } = makeRunningRealRun("wf-abort-fence");
    const deps = makeDeps();
    deps.eventBus.emit = vi.fn(() => {
      throw new Error("listener exploded");
    });
    deps.runs.set("wf-abort-fence", run);

    // 旧实现裸调 emit：listener 抛错 → 异常上抛给 tool 调用方 + 跳过 onRunDone
    await expect(abortRun("wf-abort-fence", deps, "abort with broken bus")).resolves.toBeUndefined();

    // abort 成功语义保持：终态转换/terminate 照常完成
    expect(run.state.status).toBe("done");
    expect(run.state.reason).toBe("aborted");
    expect(terminate).toHaveBeenCalledTimes(1);
    // 独立围栏：onRunDone 不被 emit 故障跳过
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("自定义 doneReason（time_limited）", async () => {
    const { run } = makeRunningRealRun("wf-abort-3");
    const deps = makeDeps();
    deps.runs.set("wf-abort-3", run);

    await abortRun("wf-abort-3", deps, "timeout", "time_limited");

    expect(run.state.reason).toBe("time_limited");
    expect(run.state.error).toBe("timeout");
  });

  it("runId 不存在 → 抛错", async () => {
    const deps = makeDeps();
    await expect(abortRun("wf-missing", deps)).rejects.toThrow("not found");
  });
});

// ── terminateRunningRuns ─────────────────────────────────────

describe("terminateRunningRuns", () => {
  it("多 run 中仅 running 被终止（done run 不动）", async () => {
    const { run: running1 } = makeRunningRealRun("wf-term-1");
    const { run: running2 } = makeRunningRealRun("wf-term-2");
    const { run: doneRun } = makeRunningRealRun("wf-term-done");
    doneRun.transition("done", "completed");
    const deps = makeDeps();
    deps.runs.set("wf-term-1", running1);
    deps.runs.set("wf-term-2", running2);
    deps.runs.set("wf-term-done", doneRun);

    await terminateRunningRuns(deps, "Session switched: run terminated");

    // running 全部转 done,failed
    expect(running1.state.status).toBe("done");
    expect(running1.state.reason).toBe("failed");
    expect(running2.state.status).toBe("done");
    expect(running2.state.reason).toBe("failed");
    // done run 不被重写（保留 completed）
    expect(doneRun.state.reason).toBe("completed");
  });

  it("每个被终止的 run 发 pending:unregister（reason=failed）且不调 onRunDone", async () => {
    const { run: r1 } = makeRunningRealRun("wf-term-3");
    const { run: r2 } = makeRunningRealRun("wf-term-4");
    const deps = makeDeps();
    deps.runs.set("wf-term-3", r1);
    deps.runs.set("wf-term-4", r2);

    await terminateRunningRuns(deps, "Session shutdown: run terminated");

    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:unregister", {
      id: "wf-term-3",
      reason: "failed",
    });
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:unregister", {
      id: "wf-term-4",
      reason: "failed",
    });
    // 对齐 session_start 恢复先例：主 agent 已离开本 session，不发完成通知
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("state.error = reason、reason 字段 = failed、run 落盘（releaseRuntime 解绑 runtime）", async () => {
    const { run, terminate } = makeRunningRealRun("wf-term-5");
    const deps = makeDeps();
    deps.runs.set("wf-term-5", run);

    await terminateRunningRuns(deps, "Session switched: run terminated");

    expect(run.state.error).toBe("Session switched: run terminated");
    expect(run.state.reason).toBe("failed");
    expect(run.runtime).toBeUndefined();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(deps.store.save).toHaveBeenCalledWith(run);
  });

  it("[B-4] eventBus listener 抛错 → 不向调用方抛错、本 run 收尾完成、其余 run 继续终止", async () => {
    const { run: a, terminate: terminateA } = makeRunningRealRun("wf-term-fence-a");
    const { run: b, terminate: terminateB } = makeRunningRealRun("wf-term-fence-b");
    const deps = makeDeps();
    deps.runs.set("wf-term-fence-a", a);
    deps.runs.set("wf-term-fence-b", b);
    // 仅 runA 的 emit 抛错（按 payload id 判别模拟坏 listener）
    deps.eventBus.emit = vi.fn((_event: string, payload: { id: string }) => {
      if (payload.id === "wf-term-fence-a") throw new Error("listener exploded");
    });

    await expect(terminateRunningRuns(deps, "Session switched: run terminated")).resolves.toBeUndefined();

    // 两个 run 都走到终态（runA 的 emit 故障不中断批量收尾）
    expect(a.state.reason).toBe("failed");
    expect(b.state.reason).toBe("failed");
    expect(terminateA).toHaveBeenCalledTimes(1);
    expect(terminateB).toHaveBeenCalledTimes(1);
  });

  it("单 run save 抛错不中断其余（save best-effort：unregister 仍发 + 其余 run 照常落盘）", async () => {
    const { run: bad } = makeRunningRealRun("wf-term-err");
    const { run: good } = makeRunningRealRun("wf-term-ok");
    const deps = makeDeps();
    deps.runs.set("wf-term-err", bad);
    deps.runs.set("wf-term-ok", good);
    deps.store.save = vi.fn(async (r: WorkflowRun) => {
      if (r.runId === "wf-term-err") throw new Error("disk full");
    });

    await terminateRunningRuns(deps, "Session shutdown: run terminated");

    // [D5-② finalizeRun 收敛] save 失败 best-effort（SW-DATA-3 统一）：transition 先于
    // save，状态已转 done；与收敛前不同，unregister 不再被 save 失败短路——否则
    // pending 通知幽灵注销（列表残留永不清理的 running 条目）
    expect(bad.state.status).toBe("done");
    expect(bad.state.reason).toBe("failed");
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:unregister", {
      id: "wf-term-err",
      reason: "failed",
    });
    // 其余 run 正常走完落盘 + unregister（单 run 失败不中断批量终止）
    expect(good.state.status).toBe("done");
    expect(deps.store.save).toHaveBeenCalledWith(good);
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:unregister", {
      id: "wf-term-ok",
      reason: "failed",
    });
  });
});

// ── evictDoneRunsBeyondCap ────────────────────────────────────

/**
 * 构造可重水合的 WorkflowRun 快照（对齐 crash-recovery.test.ts makeRun 模式——
 * WorkflowRun.reconstruct 与构造同语义：I1 构造期跳过，running 快照合法）。
 *
 * @param runId run 标识
 * @param opts.completedAt 完成时刻 ISO 串（缺省=缺失场景，模拟旧格式/异常快照）
 * @param opts.status 状态（默认 done；running 用于白名单验证）
 */
function makeEvictableRun(
  runId: string,
  opts: { completedAt?: string; status?: "running" | "done" } = {},
): WorkflowRun {
  const status = opts.status ?? "done";
  return WorkflowRun.reconstruct(
    runId,
    {
      scriptSource: "execute() {}",
      args: {},
      scriptName: "test",
      scriptPath: "/fake/test.js",
    },
    {
      status,
      reason: status === "done" ? "completed" : undefined,
      budget: new Budget({ maxTokens: 1000 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    {
      startedAt: opts.completedAt ?? "2026-08-15T00:00:00.000Z",
      ...(opts.completedAt !== undefined ? { completedAt: opts.completedAt } : {}),
    },
  );
}

/** ISO 基准时刻（过去时刻），isoAt(n) = 基准 + n 分钟。 */
const EVICT_T0 = Date.parse("2020-01-01T00:00:00.000Z");
function isoAt(min: number): string {
  return new Date(EVICT_T0 + min * 60_000).toISOString();
}

describe("evictDoneRunsBeyondCap（done run 内存淘汰，K=MAX_RETAINED_DONE_RUNS）", () => {
  it("W3TC1: 状态白名单——仅 done 可淘汰，running 永不删", () => {
    const runs = new Map<string, WorkflowRun>();
    runs.set("wf-done-1", makeEvictableRun("wf-done-1", { completedAt: isoAt(1) }));
    runs.set("wf-done-2", makeEvictableRun("wf-done-2", { completedAt: isoAt(2) }));
    runs.set("wf-done-3", makeEvictableRun("wf-done-3", { completedAt: isoAt(3) }));
    runs.set("wf-run-1", makeEvictableRun("wf-run-1", { status: "running" }));
    runs.set("wf-run-2", makeEvictableRun("wf-run-2", { status: "running" }));

    const evicted = evictDoneRunsBeyondCap(runs, 2);

    // 3 done 超保留数 2 → 淘汰最旧 1 个
    expect(evicted).toBe(1);
    // running 全部仍在 Map（白名单外，即使 completedAt 缺失也不参与排序淘汰）
    for (const id of ["wf-run-1", "wf-run-2"]) {
      expect(runs.has(id)).toBe(true);
    }
    // done 仅剩 t2/t3 两个（t1 最旧被淘汰）
    expect(runs.has("wf-done-1")).toBe(false);
    expect(runs.has("wf-done-2")).toBe(true);
    expect(runs.has("wf-done-3")).toBe(true);
    expect(runs.size).toBe(4);
  });

  it("W3TC2: 按 meta.completedAt 升序淘汰最旧超限项 + 返回淘汰计数（非插入序）", () => {
    const runs = new Map<string, WorkflowRun>();
    // 插入序刻意与 completedAt 序无关：先倒序插入 t24→t0，再 delete+set 重排几个
    // 中段条目（移到 Map 尾部）模拟一般性「完成序≠插入序」——若实现退化为按 Map
    // 迭代首 excess 个淘汰，删的将不是 t0-t4，本用例失败
    for (let i = 24; i >= 0; i--) {
      runs.set(`wf-t${i}`, makeEvictableRun(`wf-t${i}`, { completedAt: isoAt(i) }));
    }
    for (const i of [5, 15, 20]) {
      const run = runs.get(`wf-t${i}`)!;
      runs.delete(`wf-t${i}`);
      runs.set(`wf-t${i}`, run);
    }

    const evicted = evictDoneRunsBeyondCap(runs, MAX_RETAINED_DONE_RUNS);

    expect(evicted).toBe(5);
    expect(runs.size).toBe(MAX_RETAINED_DONE_RUNS);
    // 被删的恰是 completedAt 最小的 5 个（t0-t4）
    for (let i = 0; i < 5; i++) {
      expect(runs.has(`wf-t${i}`)).toBe(false);
    }
    for (let i = 5; i < 25; i++) {
      expect(runs.has(`wf-t${i}`)).toBe(true);
    }
  });

  it("W3TC3: 反序 fixture——创建最早、完成最晚的 run 不被淘汰（GAP-1 回归锚点）", () => {
    // 嵌套 workflow 竞态背景：父 run 创建最早（Map 首元素）、完成最晚（completedAt
    // 全局最新）。同 session 累计 21 个 done 时父 run 完成瞬间触发同步裁剪——若按
    // Map 插入序淘汰，父 run 被淘汰，runAndWait 轮询窗口内 get 不到 → 误返
    // "Run not found"。completedAt 排序结构性消除。
    const runs = new Map<string, WorkflowRun>();
    // 插入序 = 创建序：wf-parent 最先插入，completedAt=t100 全局最新（先创建后完成）
    runs.set("wf-parent", makeEvictableRun("wf-parent", { completedAt: isoAt(100) }));
    for (let i = 0; i < 20; i++) {
      // child(i+1) 后插入，completedAt=t0..t19（父 run 之前完成）
      runs.set(`wf-child${i + 1}`, makeEvictableRun(`wf-child${i + 1}`, { completedAt: isoAt(i) }));
    }

    const evicted = evictDoneRunsBeyondCap(runs, MAX_RETAINED_DONE_RUNS);

    expect(evicted).toBe(1);
    // 被淘汰的是 child1（completedAt 最旧 t0），非 Map 首元素 wf-parent
    expect(runs.has("wf-child1")).toBe(false);
    expect(runs.has("wf-parent")).toBe(true);
    for (let i = 2; i <= 20; i++) {
      expect(runs.has(`wf-child${i}`)).toBe(true);
    }
  });

  it("W3TC4: completedAt 缺失 fallback 视为最旧（排序键空串字典序最小）", () => {
    const runs = new Map<string, WorkflowRun>();
    // 插入序 [runC, runA, runB]——缺失者 runA 居中，防「碰巧首元素」假通过
    runs.set("wf-runC", makeEvictableRun("wf-runC", { completedAt: isoAt(2) }));
    runs.set("wf-runA", makeEvictableRun("wf-runA"));
    runs.set("wf-runB", makeEvictableRun("wf-runB", { completedAt: isoAt(1) }));

    const evicted = evictDoneRunsBeyondCap(runs, 2);

    // runA 缺失 completedAt = 空串排序键 → 字典序最小=最旧 → 先被淘汰
    expect(evicted).toBe(1);
    expect(runs.has("wf-runA")).toBe(false);
    expect(runs.has("wf-runB")).toBe(true);
    expect(runs.has("wf-runC")).toBe(true);
  });

  it("W3TC5: tie 稳定排序——同 completedAt 按 Map 插入序确定性淘汰", () => {
    function buildTieFixture(): Map<string, WorkflowRun> {
      const runs = new Map<string, WorkflowRun>();
      const tie = isoAt(50);
      for (const id of ["wf-w1", "wf-w2", "wf-w3", "wf-w4"]) {
        runs.set(id, makeEvictableRun(id, { completedAt: tie }));
      }
      return runs;
    }

    const runs = buildTieFixture();
    const evicted = evictDoneRunsBeyondCap(runs, 2);

    // tie 组内先插入者视为更旧先被淘汰
    expect(evicted).toBe(2);
    expect(runs.has("wf-w1")).toBe(false);
    expect(runs.has("wf-w2")).toBe(false);
    expect(runs.has("wf-w3")).toBe(true);
    expect(runs.has("wf-w4")).toBe(true);

    // 确定性：同 fixture 二次运行断言同一淘汰集合
    const runs2 = buildTieFixture();
    const evicted2 = evictDoneRunsBeyondCap(runs2, 2);
    expect(evicted2).toBe(2);
    expect(runs2.has("wf-w1")).toBe(false);
    expect(runs2.has("wf-w2")).toBe(false);
    expect(runs2.has("wf-w3")).toBe(true);
    expect(runs2.has("wf-w4")).toBe(true);
  });

  it("W3TC6: done 数 <= keepDone 时 no-op 返回 0（恰好 K / 不足 K 两场景）", () => {
    // 场景①：恰好 20 个 done（=K）
    const exact = new Map<string, WorkflowRun>();
    for (let i = 0; i < MAX_RETAINED_DONE_RUNS; i++) {
      exact.set(`wf-ex-${i}`, makeEvictableRun(`wf-ex-${i}`, { completedAt: isoAt(i) }));
    }
    const evictedExact = evictDoneRunsBeyondCap(exact, MAX_RETAINED_DONE_RUNS);
    expect(evictedExact).toBe(0);
    expect(exact.size).toBe(MAX_RETAINED_DONE_RUNS);
    for (let i = 0; i < MAX_RETAINED_DONE_RUNS; i++) {
      expect(exact.has(`wf-ex-${i}`)).toBe(true);
    }

    // 场景②：5 个 done（<K）+ 混入 running
    const under = new Map<string, WorkflowRun>();
    for (let i = 0; i < 5; i++) {
      under.set(`wf-un-${i}`, makeEvictableRun(`wf-un-${i}`, { completedAt: isoAt(i) }));
    }
    under.set("wf-un-run", makeEvictableRun("wf-un-run", { status: "running" }));
    const evictedUnder = evictDoneRunsBeyondCap(under, MAX_RETAINED_DONE_RUNS);
    expect(evictedUnder).toBe(0);
    expect(under.size).toBe(6);
    for (const id of ["wf-un-run"]) {
      expect(under.has(id)).toBe(true);
    }
  });
});
