/**
 * finalizeRun — D5-② 终态 coda 单写点测试。
 *
 * 「transition → save → pending:unregister 直落 appendEntry → onRunDone」四步终态
 * 序列的唯一定义点（worker-message-pump.ts）。收敛前 8 处逐字复制（本文件 6 处 +
 * lifecycle 2 处）——本文件锁定：
 * 1. 四步恰好一次且有序（transition 先于 save 先于直落先于 onRunDone）
 * 2. notifyDone:false 真差异承载（finalizeRun 的 notifyDone 参数语义：false 时不调 onRunDone、直落 unregister 仍发）
 * 3. 终局触发让位（六态机表外 fail-fast）→ 后三步全不执行
 * 4. save best-effort（SW-DATA-3）→ 直落/onRunDone 不被落盘失败短路
 * 5. [reload-closeout D4] 直落 entry 三字段（id/reason/status∈mapReasonToStatus
 *    值域，budget_limited→failed 用例锁死）+ emit 发射点已删（eventBus 零
 *    pending:unregister 调用）+ 直落失败 OR-4 围栏（留痕 runId/reason、不崩宿主
 *    不跳过 onRunDone）+ 多写方竞态幂等（直落 entry 落后 listener/sweep 差集为空）
 *
 * 其余终态路径的「恰好一次四步」行为断言（save×1 + 直落 + onRunDone×1）
 * 已由既有测试覆盖：handleWorkerError/handleScriptError/handleWorkerExit 超限
 * （worker-message-pump-handlers / worker-exit-without-result）、time_limited
 * （worker-message-pump-handlers race-F3 describe）、abortRun（lifecycle.test）、
 * handleReturn（worker-exit-without-result SW-DATA-3 describe）。本文件补齐
 * budget_limited 路径（dispatchAgentCall coda）与 notifyDone:false 路径。
 */
import { describe, expect, it, vi } from "vitest";

import { collectActivePendingIds } from "@zhushanwen/extension-protocol";

import {
  handleWorkerMessage,
} from "../worker-message-pump.ts";
import {
  dispatchRunCreated,
  finalizeRun,
  isRunSettled,
  settledRecordOf,
} from "../terminal-actions.ts";
import { getLogger } from "../../core/logger.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { AgentResult } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";

// ── helpers ──────────────────────────────────────────────────

/** 构造真实 WorkflowRun（真实状态机 transition）+ 初始 runtime。 */
function makeRealRun(runId: string): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptName: "test-wf",
      scriptSource: "agent('hi')",
      args: {},
      scriptPath: "/tmp/test-wf.js",
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
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(async () => {}),
  } as unknown as WorkerHandle;
  run.assignRuntime(new RunRuntime(worker, new AbortController()));
  return run;
}

/** deps mock：副作用打点进单一顺序数组（断言四步顺序）。appendEntry 是直落权威面
 *  （[reload-closeout D4]）；eventBus 保留观察 register emit——断言 unregister 不再
 *  经 emit（发射点已删）。 */
function makeTracingDeps(): LifecycleDeps & {
  order: string[];
  store: { save: ReturnType<typeof vi.fn> };
  appendEntry: ReturnType<typeof vi.fn>;
  eventBus: { emit: ReturnType<typeof vi.fn> };
} {
  const order: string[] = [];
  return {
    order,
    store: {
      save: vi.fn(async () => {
        order.push("save");
      }),
    },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({}) as AgentResult) },
    runs: new Map(),
    appendEntry: vi.fn((customType: string) => {
      order.push(`append:${customType}`);
    }),
    eventBus: {
      emit: vi.fn((event: string) => {
        order.push(`emit:${event}`);
      }),
    },
    onRunDone: vi.fn(() => {
      order.push("onRunDone");
    }),
    log: vi.fn(),
  } as unknown as ReturnType<typeof makeTracingDeps>;
}

/** flush 微任务队列（void finalizeRun 的 async 链推进到稳定态）。 */
async function flushMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    // eslint-disable-next-line no-await-in-loop -- 排空微任务队列的固定 tick 循环，非逐项等待
    await Promise.resolve();
  }
}

/** deps.appendEntry 收到的 pending:unregister 落盘形态（直落 entry 断言面）。
 *  mock.calls 是参数元组，此处映射为 {customType, data} 命名形态。 */
function appendedUnregister(deps: ReturnType<typeof makeTracingDeps>): { customType: string; data: unknown } | undefined {
  const call = deps.appendEntry.mock.calls.find((c) => c[0] === "pending:unregister");
  if (!call) return undefined;
  return { customType: call[0] as string, data: call[1] };
}

// ── finalizeRun 直测 ─────────────────────────────────────────


/** [W2/V1] 六态机引导：journal 首帧（run-created）落账——finalizeRun/abortRun 等
 *  活体终局入口的六态机裁决要求 created→dispatched 已在链上（生产链路由
 *  runWorkflow 正点发射承接；直测终局入口的用例经本 helper 补齐同一引导）。 */
async function seedRunCreated(run: WorkflowRun): Promise<void> {
  await dispatchRunCreated(run);
}

describe("finalizeRun（D5-② 单写点直测）", () => {
  it("[W2/V1] 五步恰好一次且有序：run-settled 六态机落账 → workflow-record 终态条目 → save → pending:unregister 直落 → onRunDone", async () => {
    const run = makeRealRun("wf-fin-1");
    const deps = makeTracingDeps();
    await seedRunCreated(run);

    const ok = await finalizeRun(run, deps, "completed", { context: "test" });

    expect(ok).toBe(true);
    // [W2/V1] 终局断言换源：两态机字段停更（state.status 恒 running），终局经
    // 六态机 dispatch 链（isRunSettled / 终局记录注册表）判定。
    expect(isRunSettled(run)).toBe(true);
    expect(run.state.status).toBe("running");
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "done" });
    // 各步恰好一次（终局帧经 no-op journal 防线零写——投递链空转一次）
    expect(deps.store.save).toHaveBeenCalledTimes(1);
    expect(appendedUnregister(deps)).toBeDefined();
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
    // 顺序：终态条目（journal run-settled 帧之后的物化半边，W1 / D1——
    // dispatchFinalRunSettle 经 no-op journal 防线零写、无 order 打点）→ save →
    // 直落 → onRunDone（transition 已同步先行）
    expect(deps.order).toEqual([
      "append:workflow-record",
      "save",
      "append:pending:unregister",
      "onRunDone",
    ]);
  });

  it("[W1 / D1] v2 终态条目两写点之一：workflow-record settled data 与 run-settled 帧同源", async () => {
    const run = makeRealRun("wf-fin-v2entry");
    const deps = makeTracingDeps();
    await seedRunCreated(run);

    await finalizeRun(run, deps, "completed", { context: "test" });

    const settled = deps.appendEntry.mock.calls.find((c) => c[0] === "workflow-record");
    expect(settled).toBeDefined();
    expect(settled![1]).toMatchObject({
      v: 2,
      kind: "settled",
      runId: "wf-fin-v2entry",
      status: "done",
      reason: "completed",
      outcome: "done",
      callCount: 0,
      usedTokens: 0,
    });
    expect(typeof (settled![1] as { settledAt: number }).settledAt).toBe("number");
  });

  it("[D4] 直落 entry 三字段：{id, reason, status∈mapReasonToStatus 值域}", async () => {
    const run = makeRealRun("wf-fin-entry");
    const deps = makeTracingDeps();
    await seedRunCreated(run);

    await finalizeRun(run, deps, "completed", { context: "test" });

    expect(appendedUnregister(deps)?.data).toEqual({
      id: "wf-fin-entry",
      reason: "completed",
      status: "completed",
    });
  });

  it("[D4] budget_limited → status 映射为 failed（非 identity 词表锁定）", async () => {
    const run = makeRealRun("wf-fin-budget");
    const deps = makeTracingDeps();
    await seedRunCreated(run);

    await finalizeRun(run, deps, "budget_limited", { context: "test" });

    // [W2/V1] reason 细分经终局记录联合派生（failed + budget_limited → budget_limited）
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "failed", errorCode: "budget_limited" });
    expect(appendedUnregister(deps)?.data).toEqual({
      id: "wf-fin-budget",
      reason: "budget_limited",
      status: "failed",
    });
  });

  it("[D4] emit 发射点已删：eventBus 零 pending:unregister 调用（注销唯一持久化路径 = 直落）", async () => {
    const run = makeRealRun("wf-fin-noemit");
    const deps = makeTracingDeps();
    await seedRunCreated(run);

    await finalizeRun(run, deps, "failed", { context: "test" });

    const unregisterEmits = deps.eventBus.emit.mock.calls.filter((c) => c[0] === "pending:unregister");
    expect(unregisterEmits).toHaveLength(0);
    expect(appendedUnregister(deps)?.data).toMatchObject({ id: "wf-fin-noemit" });
  });

  it("notifyDone:false → onRunDone 不调、直落仍发（finalizeRun 参数语义锁）", async () => {
    const run = makeRealRun("wf-fin-2");
    const deps = makeTracingDeps();
    await seedRunCreated(run);

    const ok = await finalizeRun(run, deps, "failed", {
      context: "terminateRunningRuns",
      notifyDone: false,
    });

    expect(ok).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "failed" });
    expect(appendedUnregister(deps)?.data).toEqual({
      id: "wf-fin-2",
      reason: "failed",
      status: "failed",
    });
    expect(deps.onRunDone).not.toHaveBeenCalled();
    expect(deps.order).toEqual(["append:workflow-record", "save", "append:pending:unregister"]);
  });

  it("终局触发让位（六态机表外 fail-fast）→ 返回 false，后三步全不执行", async () => {
    const run = makeRealRun("wf-fin-3");
    // 无 run-created 引导即终局化：fold 停在 created，created × run-settled 表外
    // 转移 fail-fast（IllegalTransitionError）——并发终局让位的结构性承载（[W2/V1]）。
    const deps = makeTracingDeps();

    const ok = await finalizeRun(run, deps, "failed", { context: "test" });

    expect(ok).toBe(false);
    // 让位路径不落账：注册表无条目、不 save、不直落、不通知
    expect(settledRecordOf(run.runId)).toBeUndefined();
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(appendedUnregister(deps)).toBeUndefined();
    expect(deps.onRunDone).not.toHaveBeenCalled();
  });

  it("save 抛错（ENOSPC）→ best-effort：直落 + onRunDone 照常（SW-DATA-3 统一）", async () => {
    const run = makeRealRun("wf-fin-4");
    const deps = makeTracingDeps();
    await seedRunCreated(run);
    deps.store.save = vi.fn(async () => {
      throw new Error("ENOSPC: no space left on device");
    });

    const ok = await finalizeRun(run, deps, "failed", { context: "test" });

    expect(ok).toBe(true);
    expect(isRunSettled(run)).toBe(true);
    expect(appendedUnregister(deps)).toBeDefined();
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("onRunDone 抛错 → 被捕获记日志（M12：真实副作用错误不静默吞、不上抛）", async () => {
    const run = makeRealRun("wf-fin-5");
    const deps = makeTracingDeps();
    await seedRunCreated(run);
    deps.onRunDone = vi.fn(() => {
      throw new Error("interface notify blew up");
    });

    await expect(
      finalizeRun(run, deps, "completed", { context: "test" }),
    ).resolves.toBe(true);
    expect(appendedUnregister(deps)).toBeDefined();
    expect(isRunSettled(run)).toBe(true);
  });

  it("[OR-4] appendEntry 抛错（reload 转换窗 assertActive）→ 留痕 runId/reason、不崩宿主不跳过 onRunDone", async () => {
    const errorSpy = vi.spyOn(getLogger("subagents"), "error");
    const run = makeRealRun("wf-fin-fence");
    const deps = makeTracingDeps();
    await seedRunCreated(run);
    deps.appendEntry = vi.fn(() => {
      throw new Error("assertActive: session invalidated");
    });

    const ok = await finalizeRun(run, deps, "failed", { context: "reload window" });

    expect(ok).toBe(true);
    expect(isRunSettled(run)).toBe(true);
    // onRunDone 不被直落故障吞掉（终局链依赖其收口）
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
    const errLogs = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(
      errLogs.some(
        (m) =>
          m.includes("pending:unregister appendEntry failed") &&
          m.includes("runId=wf-fin-fence") &&
          m.includes("reason=failed"),
      ),
    ).toBe(true);
  });

  it("[向后兼容] deps.appendEntry 未注入（旧测试 deps）→ 跳过直落不抛错，onRunDone 照常", async () => {
    const run = makeRealRun("wf-fin-noappend");
    const deps = makeTracingDeps();
    await seedRunCreated(run);
    delete (deps as Partial<LifecycleDeps>).appendEntry;

    await expect(
      finalizeRun(run, deps, "completed", { context: "test" }),
    ).resolves.toBe(true);
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });

  it("[D4] 多写方竞态幂等：直落 entry 落盘后 listener/sweep 差集判据视该 id 已注销", async () => {
    // 直落、sweep、listener 三写方共用同一幂等语义：注销 entry 在 entries 任意位置
    // 均抵消 register（protocol pending-entries 规则单点——listener 落盘前置
    // isPendingActive / sweep 差集 collectActiveRegisterEntries 同构消费）。
    // 本用例从直落产物出发锁「直落后的权威视图不再含该 id」。
    const run = makeRealRun("wf-fin-race");
    const deps = makeTracingDeps();
    await seedRunCreated(run);
    const entries: unknown[] = [
      { customType: "pending:register", data: { id: "wf-fin-race", type: "workflow" } },
    ];

    await finalizeRun(run, deps, "completed", { context: "race" });
    const appended = appendedUnregister(deps);
    expect(appended).toBeDefined();
    // 直落 entry 追加进权威 entries（pi.appendEntry 同步入账的生产语义）
    entries.push({ customType: appended!.customType, data: appended!.data });

    // 消费面（goal 守卫 / pending_notifications 工具 / sweep 差集输入）现算：
    // register 已被直落注销 entry 抵消 → 无活跃条目（重复 unregister 天然无重复语义）
    expect(collectActivePendingIds(entries).has("wf-fin-race")).toBe(false);
  });
});

// ── budget_limited 路径（dispatchAgentCall coda）四步恰好一次 ────────────

describe("budget_limited 终态路径（dispatchAgentCall → finalizeRun）", () => {
  it("agent call 后预算超限 → 四步恰好一次（直落 reason/status=budget_limited/failed + onRunDone）", async () => {
    const run = makeRealRun("wf-budget-1");
    const deps = makeTracingDeps();
    await seedRunCreated(run);
    // budget.isExceeded 恒 true——runner.run 成功返回后命中 C-2 coda
    (run.state.budget as unknown as { isExceeded: () => boolean }).isExceeded =
      () => true;
    deps.runner.run = vi.fn(async () =>
      ({ content: "ok", durationMs: 1, error: undefined, toolCalls: [] }) as AgentResult,
    );
    const handlers: WorkerHandlers = {
      onMessage: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
      onExit: vi.fn(async () => {}),
    };

    await handleWorkerMessage(
      run,
      { type: "agent-call", callId: 1, opts: { prompt: "p", description: "d" } },
      deps,
      handlers,
    );
    // [Q2] flush 40 轮（原 20）：P1b-1 created 引导删除后 run-settled 投递链的
    // await 边沿数变化，把 finalizeRun coda 尾链（save → 直落 → onRunDone）推出
    // 20 轮窗口（探针实证：20 轮停在末次 save、40 轮全链走完）——P1b-2 同族先例
    //（async await 边沿会推出存量 flushMicrotasks 窗口）。
    await flushMicrotasks(40);

    // [W2/V1] 终局断言换源（六态机落账——两态机字段停更）
    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf(run.runId)).toMatchObject({ outcome: "failed", errorCode: "budget_limited" });
    // save 3 次 = dispatch 启动快照（8d52c0035 dispatch-time save，running 步骤
    // 实时可见）+ call 完成快照（dispatchAgentCall .then 的常规持久化）+ budget
    // 终态快照（finalizeRun 内）——三次语义不同，收敛前后一致
    expect(deps.store.save).toHaveBeenCalledTimes(3);
    expect(appendedUnregister(deps)?.data).toEqual({
      id: "wf-budget-1",
      reason: "budget_limited",
      status: "failed",
    });
    expect(deps.onRunDone).toHaveBeenCalledTimes(1);
  });
});
