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
//
// [round5-g 合并产物] 吸收同被测模块（worker-message-pump）姊妹件：
// worker-message-pump-workflow-dispatch.test.ts（workflow 派发 + 服务级接线）。
// 其 logger 桩提升为文件级；TAIJI_AGENT_DATA_DIR 存取 hook 保留其段内语义。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearEngines } from "../../execution/engine/registry.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "../../execution/__tests__/helpers/fake-engine-port.ts";
import { CTX_MODEL as ctxModel, emptyRegistry } from "../../execution/__tests__/helpers/model-registry-mock.ts";
import { makePi, type PiMock } from "../../execution/__tests__/helpers/pi-mock.ts";
import { ModelConfigService } from "../../execution/assembly/model-config-service.ts";
import type { RecordStore } from "../../execution/persistence/record-store.ts";
import { SubagentService } from "../../execution/subagent-service.ts";
import type { AgentCallOpts } from "../../shared/agent-call-types.js";
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

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

/** deps mock：副作用打点进单一顺序数组（断言四步顺序）。appendEntry 是直写权威存储的部分
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

/** deps.appendEntry 收到的 pending:unregister 落盘形态（直落 entry 断言范围）。
 *  mock.calls 是参数元组，此处映射为 {customType, data} 命名形态。 */
function appendedUnregister(deps: ReturnType<typeof makeTracingDeps>): { customType: string; data: unknown } | undefined {
  const call = deps.appendEntry.mock.calls.find((c) => c[0] === "pending:unregister");
  if (!call) return undefined;
  return { customType: call[0] as string, data: call[1] };
}

// ── finalizeRun 直测 ─────────────────────────────────────────


/** [W2/V1] 六态机引导：journal 首帧（run-created）写入 journal 记录——finalizeRun/abortRun 等
 *  活体终局入口的六态机裁决要求 created→dispatched 已在链上（生产链路由
 *  runWorkflow 正点发射承接；直测终局入口的用例经本 helper 补齐同一引导）。 */
async function seedRunCreated(run: WorkflowRun): Promise<void> {
  await dispatchRunCreated(run);
}

describe("finalizeRun（D5-② 单写点直测）", () => {
  it("[W2/V1] 五步恰好一次且有序：run-settled 六态机写入 journal 记录 → workflow-record 终态条目 → save → pending:unregister 直落 → onRunDone", async () => {
    const run = makeRealRun("wf-fin-1");
    const deps = makeTracingDeps();
    await seedRunCreated(run);

    const ok = await finalizeRun(run, deps, "completed", { context: "test" });

    expect(ok).toBe(true);
    // [W2/V1] 终局断言换源：终局经六态机 dispatch 链（isRunSettled / 终局记录
    // 注册表）判定——[D6(a) 第 3 步] 起聚合快照不再持状态字段。
    expect(isRunSettled(run)).toBe(true);
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
    // 让位路径不写入 journal 记录：注册表无条目、不 save、不直落、不通知
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
    // onRunDone 不被直落故障吞掉（终局链依赖其收尾）
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

    // 消费方（goal 检查 / pending_notifications 工具 / sweep 差集输入）现算：
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

    // [W2/V1] 终局断言换源（六态机写入 journal 记录——两态机字段停更）
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

// ══════ 来源: worker-message-pump-workflow-dispatch.test.ts ══════

// src/orchestration/__tests__/worker-message-pump-workflow-dispatch.test.ts
//
// [H2 W3] pump 切换 executeWorkflowAgent 端到端单测（设计
// subagent-workflow-record-unification.md §3.5 终态数据流 / §5 W3）。
//
// 真实链路形态：handleWorkerMessage(agent-call) → dispatchAgentCall →
// deps.workflowAgentDispatch（SubagentService.executeWorkflowAgent 注入形态）→
// fake pi EnginePort（协议 seam 替身，与 W2 workflow-agent-dispatch.test 同源）。
//
// 锁四组面：
//   1. record 进 store：dispatch 在途时 record 带 origin:"workflow" +
//      parentRunId=run.runId（真实 record 经 store 治理侧可见——进度源切换的
//      数据前提）；record 级 pending:register 照旧发射。
//   2. worker 协议回包不变：引擎应答 → executeAgentCall finalize →
//      postMessage({type:"agent-result", callId, result})（cached:false）；
//      trace node 终态摘要保真（node.result 来自 executeWorkflowAgent 的
//      AgentResult 出口，D2「node 保留 result」）。
//   3. 成功即终态化（D7 联动回归）：settle 后 record closed/gc + record 级
//      pending:unregister（archive 出内存，run 视图经磁盘内容回查终态）。
//   4. 注入路径回退：未注入 workflowAgentDispatch（旧测试 deps）→ deps.runner.run
//      被调（SAR 旧编排路径，W4 归位；两路互不串扰）。
//
// 替身形态与测试红线对齐 W2 workflow-agent-dispatch.test.ts：TAIJI_AGENT_DATA_DIR
// 指 tmpdir（不触真实数据目录）；logger mock 防噪声。




// ── harness ──────────────────────────────────────────────────

/** 按 stepIndex 查 trace 节点（Trace 公共查询范围 = toArray 线性扫）。 */
function findByStep(trace: Trace, stepIndex: number) {
  return trace.toArray().find((n) => n.stepIndex === stepIndex);
}

interface PumpHarness {
  service: SubagentService;
  store: RecordStore;
  pi: PiMock;
  fake: FakePiEnginePort;
  run: WorkflowRun;
  postMessage: ReturnType<typeof vi.fn>;
  deps: LifecycleDeps;
  tmpRoot: string;
}

function makePumpHarness(runId: string): PumpHarness {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-pump-it-"));
  process.env.TAIJI_AGENT_DATA_DIR = path.join(tmpRoot, "engine-data");
  const agentDir = path.join(tmpRoot, "agent");
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({ modelRegistry: emptyRegistry(), sessionId: "wf-pump-it", ctxModel });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "wf-pump-it" });
  clearEngines();
  const fake = registerFakePiEngine();

  const run = new WorkflowRun(
    runId,
    { scriptName: "test-wf", scriptSource: "agent('调研 A')", args: {}, scriptPath: "/tmp/test.js" },
    { budget: new Budget({ maxTokens: 100_000 }), calls: new Map(), trace: new Trace(), errorLogs: [] },
    { startedAt: new Date().toISOString() },
  );
  const postMessage = vi.fn();
  const initialWorker = { postMessage, terminate: vi.fn(async () => {}) } as unknown as WorkerHandle;
  run.assignRuntime(new RunRuntime(initialWorker, new AbortController()));

  // 组合根注入形态（extension index.ts makeDeps 的等价内联）：dispatch 闭包捕获
  // service 单例，parentRunId 由 pump 侧补 run.runId。
  const deps = {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn() },
    runner: { run: vi.fn(async () => ({ content: "legacy-runner", durationMs: 1, error: undefined, toolCalls: [] })) },
    runs: new Map([[runId, run]]),
    eventBus: { emit: vi.fn() },
    appendEntry: vi.fn(),
    log: vi.fn(),
    workflowAgentDispatch: (opts: AgentCallOpts, parentRunId: string, signal?: AbortSignal) =>
      service.executeWorkflowAgent(opts, parentRunId, signal),
  } as unknown as LifecycleDeps;
  const harness = { service, store: Reflect.get(service, "store") as RecordStore, pi, fake, run, postMessage, deps, tmpRoot };
  openHarnesses.push({ service, tmpRoot });
  return harness;
}

function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

/** 微任务冲刷（dispatch → 路由 → record 注册 → acquire → engine.run 链）。 */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function findAgentResultPost(postMessage: ReturnType<typeof vi.fn>, callId: number) {
  return postMessage.mock.calls
    .map((c) => c[0] as { type?: string; callId?: number; result?: { content?: string; error?: string }; cached?: boolean })
    .find((m) => m.type === "agent-result" && m.callId === callId);
}

let prevDataDirEnv: string | undefined;

/** 在途 harness 登记处：makePumpHarness 创建即登记，顶层 afterEach 统一释放（tmp 不泄漏）。 */
const openHarnesses: Array<{ service: SubagentService; tmpRoot: string }> = [];

beforeEach(() => {
  prevDataDirEnv = process.env["TAIJI_AGENT_DATA_DIR"];
});

afterEach(() => {
  for (const h of openHarnesses) {
    h.service.dispose();
    fs.rmSync(h.tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
  openHarnesses.length = 0;
  clearEngines();
  vi.restoreAllMocks();
  if (prevDataDirEnv === undefined) delete process.env["TAIJI_AGENT_DATA_DIR"];
  else process.env["TAIJI_AGENT_DATA_DIR"] = prevDataDirEnv;
});

// ── 1+2+3：注入 dispatch 的端到端主路径 ───────────────────────

describe("pump → executeWorkflowAgent 端到端", () => {
  it("record 进 store（origin=workflow + parentRunId）→ settle → 回包/终态摘要/D7 终态化全链", async () => {
    const h = makePumpHarness("wf-pump-e2e-1");
    await dispatchRunCreated(h.run); // [W2/V1] 六态机引导（journal 首帧——run 级终局裁决前置）
    await handleWorkerMessage(
      h.run,
      { type: "agent-call", callId: 1, opts: { prompt: "调研 A", description: "research-a" } },
      h.deps,
      makeHandlers(),
    );
    await flush();

    // 1. dispatch 在途：真实 record 在 store（origin/parentRunId——views store 订阅的数据
    //    前提）。经 views 同款查询路径（queries.collectRecordsByParentRunId）断言命中，
    //    再经 getMutable 拿真 record 验 originFields（listRunning 是 RecordSnapshot
    //    轻量派生视图，无 origin 字段——勿用）。
    const found = h.service.queries.collectRecordsByParentRunId("wf-pump-e2e-1", 100);
    expect(found).toHaveLength(1);
    expect(found[0]!.origin).toBe("workflow");
    expect(found[0]!.parentRunId).toBe("wf-pump-e2e-1");
    expect(found[0]!.status).toBe("running");
    const record = h.store.getMutable(found[0]!.id)!;
    expect(record.origin).toBe("workflow");
    expect(record.parentRunId).toBe("wf-pump-e2e-1");
    // 引擎收到 run（taskId = record.id——守护/journal 键，W2 已锁定）
    expect(h.fake.runs).toHaveLength(1);
    // record 级 pending:register 照旧（D5：record 域发射侧不动）
    const registered = h.pi.events.emit.mock.calls.find((c) => c[0] === "pending:register");
    expect(registered?.[1]).toMatchObject({ id: record.id, type: "subagent" });

    // 2. 引擎应答 → worker 协议回包 + trace node 终态摘要
    //    （settle 后链路含 journal.close 的真 fs await，用 waitFor 收敛）
    // sessionFile 落 os.tmpdir() 白名单（fs-guard 防线要求），禁写 /tmp 根：
    // settle 链路含 writeAliveMarker 真实写 `<sessionFile>.alive`，/tmp 根不在白名单会被拦截。
    const sessionFile = path.join(h.tmpRoot, "sess-1.jsonl");
    h.fake.runs[0]!.settle({ content: "ok", sessionId: "sess-1", sessionFile, durationMs: 5 });
    await vi.waitFor(() => {
      expect(findAgentResultPost(h.postMessage, 1)).toBeDefined();
    });

    const posted = findAgentResultPost(h.postMessage, 1);
    expect(posted).toBeDefined();
    expect(posted!.cached).toBe(false);
    expect(posted!.result!.content).toBe("ok");
    expect(posted!.result!.error).toBeUndefined();
    // node 终态摘要（D2：live 删除后 node 保留 result——数据源 = executeWorkflowAgent
    // 的 AgentResult 出口，经 executeAgentCall finalizeCall 写入）
    const node = findByStep(h.run.state.trace, 1);
    expect(node?.status).toBe("completed");
    expect(node?.result?.content).toBe("ok");
    expect(node?.result?.sessionFile).toBe(sessionFile);
    expect(node?.completedAt).toBeDefined();
    expect(h.run.state.calls.get(1)?.status).toBe("done");

    // 3. D7 联动：成功即终态化（closed/gc + archive 出内存）+ record 级 unregister。
    //    （archive 后从磁盘重建侧回查终态的「run 视图不丢行」行为由 W1 record-store
    //    的 mergedRecords 测试锁定——本 harness 的 pi mock 不落盘，不在此重复。）
    expect(h.store.listRunning()).toHaveLength(0);
    const unregistered = h.pi.events.emit.mock.calls.find((c) => c[0] === "pending:unregister");
    expect(unregistered?.[1]).toMatchObject({ id: record.id });

    // 4. run 级 pending 配对不回归（D5：lifecycle↔pump 的 run 级注册/注销对零改动
    //    ——register 仍经 eventBus emit；此处锁 pump 侧 run 终态注销行为）：
    //    脚本 return → finalizeRun 直落 appendEntry pending:unregister with id=runId
    //    （[reload-closeout D4] emit 发射点已删，注销唯一持久化路径 = 直落）。
    await handleWorkerMessage(h.run, { type: "return", result: "done" }, h.deps, makeHandlers());
    const runUnregister = h.deps.appendEntry as ReturnType<typeof vi.fn>;
    const runUnregCall = runUnregister.mock.calls.find((c) => c[0] === "pending:unregister");
    expect(runUnregCall?.[1]).toMatchObject({ id: "wf-pump-e2e-1", status: "completed" });
    // [W2/V1] 终局断言换源（两态机字段停更）
    expect(isRunSettled(h.run)).toBe(true);
  });

  it("失败结果：引擎 error outcome → 回包 error + trace failed 终态摘要", async () => {
    const h = makePumpHarness("wf-pump-e2e-2");
    await handleWorkerMessage(
      h.run,
      { type: "agent-call", callId: 2, opts: { prompt: "调研 B", description: "research-b" } },
      h.deps,
      makeHandlers(),
    );
    await flush();
    expect(h.fake.runs).toHaveLength(1);

    // 失败结果带巨额 usage 打爆 run 预算（Budget maxTokens=100k）——executeAgentCall
    // 的「预算超限不重试」分支直接 finalize（否则 error 结果走 1s/2s 退避重试，
    // 测试需 fake timers 推进；重试语义已由 execute-agent-call.test.ts 锁定，此处
    // 聚焦 pump 切换后的回包/终态摘要）。
    h.fake.runs[0]!.settle({ content: "", error: "engine blew up", durationMs: 3, usage: { input: 1_000_000, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } });
    await vi.waitFor(() => {
      expect(findAgentResultPost(h.postMessage, 2)).toBeDefined();
    });

    const posted = findAgentResultPost(h.postMessage, 2);
    expect(posted).toBeDefined();
    expect(posted!.result!.error).toBe("engine blew up");
    const node = findByStep(h.run.state.trace, 2);
    expect(node?.status).toBe("failed");
    expect(node?.result?.error).toBe("engine blew up");
    expect(h.run.state.calls.get(2)?.status).toBe("done");
  });
});

// ── 4：注入点回退（旧 deps 不注入 dispatch） ──────────────────

describe("workflowAgentDispatch 未注入回退", () => {
  it("旧 deps（仅 runner）→ deps.runner.run 被调（[H2 W4] SAR.run 已掏空为纯转调 executeWorkflowAgent，两分支执行体归一；生产恒注入 dispatch 本分支不可达，仅为旧测试 deps 形态兼容）", async () => {
    const run = new WorkflowRun(
      "wf-pump-fallback-1",
      { scriptName: "test-wf", scriptSource: "agent('hi')", args: {}, scriptPath: "/tmp/test.js" },
      { budget: new Budget(), calls: new Map(), trace: new Trace(), errorLogs: [] },
      { startedAt: new Date().toISOString() },
    );
    const runnerRun = vi.fn(async () => ({ content: "legacy", durationMs: 1, error: undefined, toolCalls: [] }));
    const postMessage = vi.fn();
    const deps = {
      store: { save: vi.fn(async () => {}) },
      workerHost: { start: vi.fn() },
      runner: { run: runnerRun },
      runs: new Map(),
      eventBus: { emit: vi.fn() },
      log: vi.fn(),
    } as unknown as LifecycleDeps;
    run.assignRuntime(new RunRuntime({ postMessage, terminate: vi.fn(async () => {}) } as unknown as WorkerHandle, new AbortController()));

    await handleWorkerMessage(run, { type: "agent-call", callId: 7, opts: { prompt: "p" } }, deps, makeHandlers());
    await flush();

    expect(runnerRun).toHaveBeenCalledTimes(1);
    const posted = findAgentResultPost(postMessage, 7);
    expect(posted?.result?.content).toBe("legacy");

    // [GUI 步骤实时可见 2026-09-14] 启动即持久化：dispatch 同步段内（trace.append 后）
    // 必须触发一次 store.save——否则 running 节点要等完成路径才落盘，GUI 详情期间见不到步骤
    expect(deps.store.save).toHaveBeenCalled();
  });
});
