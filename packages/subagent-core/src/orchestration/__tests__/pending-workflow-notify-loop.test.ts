// src/execution/__tests__/pending-workflow-notify-loop.test.ts
//
// [P4 / D7] run 级 pending register/unregister 闭环单测（impl-plan P4 验收条款 b）。
//
// 闭环两端（同一 runId 流过）：
//   - register：runWorkflow（run 创建处，orchestration/lifecycle.ts）经 deps.eventBus
//     emit "pending:register"（id=runId、type=workflow、name 回退链 slug→scriptName→runId）
//     —— pending-notifications 扩展 listener 消费后 appendEntry 落盘（扩展侧自测，
//     本文件断言发射载荷契约）；
//   - unregister：finalizeRun（终态序列唯一定义点，orchestration/worker-message-pump.ts）
//     直落 appendEntry "pending:unregister"（id=runId、reason=DoneReason、status 经
//     protocol mapReasonToStatus 映射——completed/failed/aborted 逐一锁定，
//     budget_limited→failed 的非 identity 映射单独锁定。注意 run 域取消的 DoneReason
//     是 aborted，protocol 权威映射为 status 'aborted'（pending 词表独立态，非
//     cancelled）——journal 面的 outcome cancelled（D5 run-settled）与 pending status
//     面的 'aborted' 是两域词表，映射权威在 extension-protocol 单点）。
//
// 测试防线路径：finalizeRun 内部 run-settled journal 投递在 vitest 环境无
// setRunEventJournalDirForTest 注入时自动落 no-op journal（不触真实数据目录，
// worker-message-pump.ts resolveRunEventJournal 的 VITEST 防线）。
//
// [round5-g 合并产物] 吸收同域（P4/D7 pending 通知闭环）姊妹件：
// - agent-retry-silent-notify.test.ts（终局化静默反向单测）。其 journal hook
//   已下沉进自身 describe（本文件依赖无注入 no-op journal 语义，不可共享文件级
//   hook）；makeRealRun 与本文件同构去重。
import { describe, expect, it, vi } from "vitest";

import { runWorkflow } from "../lifecycle.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import { Budget } from "../models/budget.ts";
import type { RunSpec } from "../models/run-spec.ts";
import type { LifecycleDeps } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";
import {
  dispatchRunCreated,
  finalizeRun,
} from "../terminal-actions.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { dispatchAgentSettled, setRunEventJournalDirForTest } from "../terminal-actions.ts";
import { executeAgentCall } from "../execute-agent-call.ts";
import { AgentCall } from "../models/agent-call.ts";
import type { AgentResult } from "../models/types.ts";
import { createRunEventJournal } from "../run-events.ts";
import { flushMicrotasks } from "./helpers/flush-microtasks.ts";

// ── harness ──────────────────────────────────────────────────

function makeSpec(): RunSpec {
  return {
    scriptSource: "async function execute() {}",
    args: {},
    scriptName: "test-wf",
    scriptPath: "/fake/test.js",
  } as RunSpec;
}

/** runWorkflow 用 deps mock（eventBus.emit 可观察 = register 发射侧）。 */
function makeLauncherDeps(): LifecycleDeps & {
  runs: Map<string, WorkflowRun>;
  eventBus: { emit: ReturnType<typeof vi.fn> };
} {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn(), terminate: vi.fn(async () => {}) })) },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    log: vi.fn(),
  } as unknown as ReturnType<typeof makeLauncherDeps>;
}

/** 构造真实 WorkflowRun（真实状态机）+ runtime（finalizeRun 直测输入）。 */
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

/** finalizeRun 用 deps mock（appendEntry 可观察 = unregister 直落面）。 */
function makeFinalizeDeps(): LifecycleDeps & {
  appendEntry: ReturnType<typeof vi.fn>;
  onRunDone: ReturnType<typeof vi.fn>;
} {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    appendEntry: vi.fn(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
  } as unknown as ReturnType<typeof makeFinalizeDeps>;
}

/** deps.appendEntry 收到的 pending:unregister 落盘形态。 */
function appendedUnregister(deps: ReturnType<typeof makeFinalizeDeps>): {
  id: string;
  reason: string;
  status: string;
} | undefined {
  const call = deps.appendEntry.mock.calls.find((c) => c[0] === "pending:unregister");
  if (!call) return undefined;
  const data = call[1] as { id: string; reason: string; status: string };
  return { id: data.id, reason: data.reason, status: data.status };
}

// ── 闭环 ─────────────────────────────────────────────────────

describe("run 级 pending register/unregister 闭环（D7）", () => {
  it("register 发射载荷（runWorkflow，run 创建处）：id=runId、type=workflow、name 回退链", async () => {
    const deps = makeLauncherDeps();
    const spec = makeSpec();

    const runId = await runWorkflow(spec, deps);

    expect(deps.eventBus.emit).toHaveBeenCalledTimes(1);
    expect(deps.eventBus.emit).toHaveBeenCalledWith("pending:register", {
      id: runId,
      type: "workflow",
      name: "test-wf",
    });
  });

  it("闭环配对：同一 runId 走 register（创建）与 unregister 直落（终局），两端 id 同源", async () => {
    const launcherDeps = makeLauncherDeps();
    const runId = await runWorkflow(makeSpec(), launcherDeps);
    const registerCall = launcherDeps.eventBus.emit.mock.calls[0]?.[1] as { id: string };

    const run = launcherDeps.runs.get(runId)!;
    const finalizeDeps = makeFinalizeDeps();
    const transitioned = await finalizeRun(run, finalizeDeps, "completed", { context: "loop-test" });

    expect(transitioned).toBe(true);
    const unregister = appendedUnregister(finalizeDeps);
    // 配对键：register.id === unregister.id === runId（主 agent 查询范围同一注册条目的
    // 生命周期两端）
    expect(registerCall.id).toBe(runId);
    expect(unregister).toEqual({ id: runId, reason: "completed", status: "completed" });
  });

  it("status 映射：failed→failed、aborted→aborted（各恰好一条 unregister）", async () => {
    for (const [doneReason, expectedStatus] of [
      ["failed", "failed"],
      ["aborted", "aborted"],
    ] as const) {
      const run = makeRealRun(`wf-loop-${doneReason}`);
      const deps = makeFinalizeDeps();
      await dispatchRunCreated(run); // [W2/V1] 六态机引导（终局裁决前置）
      await finalizeRun(run, deps, doneReason, { context: `loop-test-${doneReason}` });
      const unregister = appendedUnregister(deps);
      expect(unregister).toEqual({
        id: `wf-loop-${doneReason}`,
        reason: doneReason,
        status: expectedStatus,
      });
      // 终局通知恰好随注销成对触发（一个 run 恰好一个终局，无双语义事件）
      expect(deps.onRunDone).toHaveBeenCalledTimes(1);
    }
  });

  it("status 非 identity 映射锁定：budget_limited → failed（词表外落值防线）", async () => {
    const run = makeRealRun("wf-loop-budget");
    const deps = makeFinalizeDeps();
    await dispatchRunCreated(run); // [W2/V1] 六态机引导（终局裁决前置）
    await finalizeRun(run, deps, "budget_limited", { context: "loop-test-budget" });
    expect(appendedUnregister(deps)).toEqual({
      id: "wf-loop-budget",
      reason: "budget_limited",
      status: "failed",
    });
  });
});

// ══════ 来源: agent-retry-silent-notify.test.ts ══════

// src/execution/__tests__/agent-retry-silent-notify.test.ts
//
// [P4 / D7] 终局化静默反向单测。
//
// [HISTORICAL] 原主题「重试等待期零通知」（impl-plan P4 验收条款 c）随重试矩阵删除
// （ADR-0122）——无重试等待期，失败单次终态化即唯一终局信号。现行锁定两点：
//
//   1. call 级（executeAgentCall 真函数 + fake runner）：失败单次终态化——finalizeCall
//      恰好一次（终局化单次，trace 单节点单次 update）。
//   2. journal 级（dispatchAgentSettled 的 result gate）：call 未 markDone 时
//      dispatchAgentSettled 静默返回——agent-settled / run-settled 帧只在终局后写入 journal 记录
//      （该检查为防御性质，现网调用点在 markDone 之后）。



// ── harness ──────────────────────────────────────────────────

// ── 反向面 1：重试等待期零终局信号 ─────────────────────────────

describe("agent 失败重试期零通知（D7 反向面）", () => {

  let journalDir: string;

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-retry-silent-"));
    setRunEventJournalDirForTest(journalDir);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    fs.rmSync(journalDir, { recursive: true, maxRetries: 5, retryDelay: 20 });
  });
  it("call 级：失败 → 单次终态化（runner.run 恰 1 次、trace 单节点单次 update）", async () => {
    vi.useFakeTimers();
    try {
      const call = new AgentCall(
        1,
        { prompt: "调研 A", description: "research-a" },
        {
          stepIndex: 1,
          agent: "research-a",
          task: "调研 A",
          model: "default",
          status: "running",
          startedAt: new Date().toISOString(),
        },
      );
      const runner = {
        run: vi
          .fn()
          .mockResolvedValue({ content: "", error: "engine transient boom", failureKind: "unknown" } satisfies AgentResult),
      };
      const budget = new Budget();
      const trace = new Trace();
      // trace 节点 append 是 dispatchAgentCall（pump 层）的前置动作（finalizeCall 只
      // update——update 对不存在节点 no-op），harness 复刻该前置以还原真实链形态。
      trace.append({
        stepIndex: 1,
        agent: "research-a",
        task: "调研 A",
        model: "default",
        status: "running",
        startedAt: new Date().toISOString(),
      });

      const promise = executeAgentCall(
        call,
        runner as unknown as Parameters<typeof executeAgentCall>[1],
        budget,
        new AbortController().signal,
        trace,
      );

      await promise;

      expect(runner.run).toHaveBeenCalledTimes(1); // 无重试
      expect(call.attempts).toBe(1);
      expect(call.status).toBe("done");
      expect(call.result?.error).toBe("engine transient boom");
      expect(trace.toArray()).toHaveLength(1); // 终局化恰好一次
      expect(trace.toArray()[0]?.status).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("journal 级：call 未终局（重试中）→ dispatchAgentSettled 静默零帧", async () => {
    const run = makeRealRun("wf-retry-silent-1");
    const call = new AgentCall(
      1,
      { prompt: "调研 A", description: "research-a" },
      {
        stepIndex: 1,
        agent: "research-a",
        task: "调研 A",
        model: "default",
        status: "running",
        startedAt: new Date().toISOString(),
      },
    );
    call.markRunning(); // running、无 result —— 重试中的真实形态

    dispatchAgentSettled(run, call, false);
    await flushMicrotasks(20);

    const journal = createRunEventJournal(journalDir);
    // 零 agent-settled / run-settled 帧——终局 journal 帧（终局通知的单点判定源）
    // 只在 markDone 后写入 journal 记录，重试期结构性静默。
    await expect(journal.scan(run.runId)).resolves.toHaveLength(0);
  });

  it("journal 级：被接管轮（promptDisposition=handled）→ 跳写 agent-settled 帧（resume 落重派集，§3.3.8 P6）", async () => {
    const run = makeRealRun("wf-adopted-skip-1");
    await dispatchRunCreated(run); // 转移合法化——零帧归因于设计跳帧，非转移门拦截
    const call = new AgentCall(
      0,
      { prompt: "调研 A", description: "research-a" },
      {
        stepIndex: 0,
        agent: "research-a",
        task: "调研 A",
        model: "default",
        status: "running",
        startedAt: new Date().toISOString(),
      },
    );
    call.markRunning();
    // 被接管轮回执形态（output-collector ②-A 支）：回执层成功、引擎未执行
    call.markDone({ content: "", sessionId: "s", promptDisposition: "handled" });

    dispatchAgentSettled(run, call, false);
    await flushMicrotasks(20);

    const journal = createRunEventJournal(journalDir);
    // 仅 run-created 一帧：被接管任务不得进 resume 回放集（帧缺席 = 重派集成员，任务续聊重派）
    const events = await journal.scan(run.runId);
    expect(events.map((e) => e.type)).toEqual(["run-created"]);
  });

  it("journal 级：对照——正常终局 call 仍写 agent-settled 帧（跳帧仅限被接管形态）", async () => {
    const run = makeRealRun("wf-adopted-skip-2");
    await dispatchRunCreated(run);
    const call = new AgentCall(
      0,
      { prompt: "调研 A", description: "research-a" },
      {
        stepIndex: 0,
        agent: "research-a",
        task: "调研 A",
        model: "default",
        status: "running",
        startedAt: new Date().toISOString(),
      },
    );
    call.markRunning();
    call.markDone({ content: "done", sessionId: "s" });

    dispatchAgentSettled(run, call, false);
    await flushMicrotasks(20);

    const journal = createRunEventJournal(journalDir);
    const events = await journal.scan(run.runId);
    expect(events.at(-1)?.type).toBe("agent-settled");
  });
});
