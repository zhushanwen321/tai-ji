// src/orchestration/__tests__/resume-orchestration.test.ts
//
// [U2] resumeRun 编排原语测试（workflow-run-resume-revision §3.3 D7/D12/D13 +
// 机制文档场景 9/15/17 的脚本层形态）。
//
// 覆盖：
// - 复活主链：run-resumed 落 record（锁段内）+ 聚合重建（回放集 done + result
//   全文 / 重派集不建条目）+ worker 接管 + v2 注册条目 + pending:register
// - 场景 15（同进程双 resume）：串行第二次资格拒绝 + 并发形态恰一成功；record
//   只有一套 run-resumed
// - 场景 9（跨进程双 resume，脚本层）：锁互斥（mkdir 原子性构造性保证——待验证
//   检查点 2 已核实 proper-lockfile 实装；ELOCKED 拒绝文案 + 预置锁拒绝）；
//   record 无交错事件
// - 场景 17（resume 后 abort）：cancelled 终局正常写入 + 对 cancelled 再 resume
//   明确拒绝
// - 资格校验族：run 不存在 / 终局 run / 从未中断的 run / D13 嵌套拒绝
// - D12 完整性拒绝：半截行 / seq 断档 / settled 缺 result（场景 18 resume 侧）
// - 裁决点 7：v2 条目失败干净拒绝（run-resumed 未落）
// - D10 预算预检：活跃段已耗尽拒绝
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ResumeRejectionError,
  resumeRun,
} from "../resume-run.ts";
import { abortRun } from "../lifecycle.ts";
import {
  interruptRun,
  isRunSettled,
  resetPhaseSettlementTrackerForTest,
  setRunEventJournalDirForTest,
} from "../terminal-actions.ts";
import { createRunEventJournal } from "../run-events.ts";
import { getLogger } from "../../core/logger.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { WorkflowRunEvent } from "../run-events.ts";
import type { LifecycleDeps } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";

// ── helpers ──────────────────────────────────────────────────

const T0 = 1_770_000_000_000;
const MIN = 60_000;
const SCRIPT_SOURCE = "async function execute({ agent }) { await agent('step1'); }";

let journalDir: string;

beforeEach(() => {
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-orchestration-"));
  setRunEventJournalDirForTest(journalDir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function scanEvents(runId: string): Promise<readonly WorkflowRunEvent[]> {
  return createRunEventJournal(journalDir).scan(runId);
}

/** 预置「崩溃收编后」record 流：2 settled + 1 in-flight + run-interrupted。 */
async function seedInterruptedRecord(
  runId: string,
  opts: { scriptSource?: string; scriptPath?: string; withSessionFile?: boolean } = {},
): Promise<void> {
  const journal = createRunEventJournal(journalDir);
  await journal.append(runId, {
    type: "run-created",
    runId,
    workflowName: "test-wf",
    argsSummary: "{}",
    scriptSource: opts.scriptSource ?? SCRIPT_SOURCE,
    ...(opts.scriptPath !== undefined ? { scriptPath: opts.scriptPath } : {}),
    ts: T0,
  });
  await journal.append(runId, {
    type: "agent-started",
    taskIndex: 0,
    agentName: "collector",
    attempt: 1,
    ts: T0 + 1_000,
  });
  await journal.append(runId, {
    type: "agent-settled",
    taskIndex: 0,
    attempt: 1,
    outcome: "done",
    durationMs: 5_000,
    result: {
      content: "result-0",
      ...(opts.withSessionFile === true ? { sessionFile: "/fake/sessions/member-a.jsonl" } : {}),
    },
    ts: T0 + 6_000,
  });
  await journal.append(runId, {
    type: "agent-started",
    taskIndex: 1,
    agentName: "collector",
    attempt: 1,
    ts: T0 + 7_000,
  });
  await journal.append(runId, {
    type: "run-interrupted",
    errorCode: "crashed",
    reason: "test crash",
    ts: T0 + 8_000,
  });
}

/** mock LifecycleDeps（workerHost.start 返回 fake handle——不发消息，run 静置 running）。 */
function makeDeps(): {
  deps: LifecycleDeps;
  runs: Map<string, import("../models/workflow-run.ts").WorkflowRun>;
  appendEntry: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  workerStarts: number[];
  budgetSchedules: Array<{ runId: string; ms: number }>;
} {
  const runs = new Map();
  const appendEntry = vi.fn();
  const emit = vi.fn();
  const workerStarts: number[] = [];
  const budgetSchedules: Array<{ runId: string; ms: number }> = [];
  const deps: LifecycleDeps = {
    store: { save: vi.fn(async () => {}), loadAll: vi.fn(async () => []), stateFilePath: vi.fn(() => "") },
    workerHost: {
      start: vi.fn(() => {
        workerStarts.push(Date.now());
        return {
          postMessage: vi.fn(),
          terminate: vi.fn(async () => {}),
        } as unknown as WorkerHandle;
      }),
    },
    runner: { run: vi.fn(async () => ({ content: "" })) },
    runs,
    appendEntry,
    eventBus: { emit },
    onRunDone: vi.fn(),
    log: vi.fn(),
    // 预算重排捕获面（D10：首次挂表 + 重试重建重排共用同一 deps 注入点）
    scheduleTimeBudget: vi.fn((runId: string, ms: number) => {
      budgetSchedules.push({ runId, ms });
      return undefined;
    }),
  };
  return { deps, runs, appendEntry, emit, workerStarts, budgetSchedules };
}

function expectRejection(p: Promise<unknown>, fragment: string): Promise<void> {
  return expect(p).rejects.toMatchObject({
    name: "ResumeRejectionError",
    message: expect.stringContaining(fragment),
  });
}

// ── 复活主链 ─────────────────────────────────────────────────

describe("resumeRun — 复活主链（方案 A 同 runId 复活）", () => {
  it("run-resumed 落 record + 聚合重建（回放集 done+result / 重派集不建条目）+ worker 接管 + v2 条目 + pending:register", async () => {
    await seedInterruptedRecord("wf-main", { scriptPath: "/abs/workflows/fan-out.js" });
    const { deps, runs, appendEntry, emit } = makeDeps();

    const returned = await resumeRun("wf-main", deps, { now: () => T0 + 100_000 });

    expect(returned).toBe("wf-main");
    // record：run-resumed 转移事件（interrupted → running，锁段内自完成）
    const events = await scanEvents("wf-main");
    expect(events.map((e) => e.type)).toEqual([
      "run-created",
      "agent-started",
      "agent-settled",
      "agent-started",
      "run-interrupted",
      "run-resumed",
    ]);
    // 聚合重建：回放集（taskIndex 0）done + result 全文；重派集（taskIndex 1）无条目
    const run = runs.get("wf-main");
    expect(run).toBeDefined();
    expect(isRunSettled(run!)).toBe(false);
    expect(run!.runtime).toBeDefined();
    expect(run!.spec.scriptSource).toBe(SCRIPT_SOURCE);
    // 锚定恢复：scriptPath 从 run-created 帧逐字恢复（worker 沙箱 _shared 定位来源）
    expect(run!.spec.scriptPath).toBe("/abs/workflows/fan-out.js");
    const replayed = run!.state.calls.get(0);
    expect(replayed?.status).toBe("done");
    expect(replayed?.result?.content).toBe("result-0");
    expect(run!.state.calls.has(1)).toBe(false);
    // v2 注册条目（裁决点 7：锁段内、先于复活事件）
    expect(appendEntry).toHaveBeenCalledTimes(1);
    const [customType, entry] = appendEntry.mock.calls[0] as [
      string,
      { kind: string; runId: string; scriptPath: string },
    ];
    expect(customType).toBe("workflow-record");
    expect(entry.kind).toBe("registered");
    expect(entry.runId).toBe("wf-main");
    // scriptPath 真值回归：注册条目携带 run-created 帧的 scriptPath 原文（同源
    // scriptName）——last-writer-wins 投影下 resume 条目遮蔽原始条目时不丢全路径
    expect(entry.scriptPath).toBe("/abs/workflows/fan-out.js");
    // pending 信号（复活 = 对当前 session 重新可见）
    expect(emit).toHaveBeenCalledWith("pending:register", expect.objectContaining({ id: "wf-main" }));
  });

  it("旧格式帧（无 scriptPath 载荷）：重建回落空串（现状行为不劣化，inline 脚本不受影响）", async () => {
    await seedInterruptedRecord("wf-legacy"); // 不传 scriptPath = scriptPath 载荷落地前的旧格式帧
    const { deps, runs, appendEntry } = makeDeps();

    await resumeRun("wf-legacy", deps, { now: () => T0 + 100_000 });

    expect(runs.get("wf-legacy")!.spec.scriptPath).toBe("");
    // 注册条目同款回落：旧格式帧缺 scriptPath 载荷 → 条目空串（读侧按缺省处理）
    const [, entry] = appendEntry.mock.calls[0] as unknown as [
      string,
      { kind: string; scriptPath: string },
    ];
    expect(entry.kind).toBe("registered");
    expect(entry.scriptPath).toBe("");
  });

  it("D8 档 3（会话文件不可知/不存在）：重派集成员不补收、不建条目——worker 重放时真实派发", async () => {
    // in-flight call 的 agent 无既有 settled 帧（无 sessionFile 可知）→ 档 3
    await seedInterruptedRecord("wf-tier3");
    const { deps, runs } = makeDeps();

    await resumeRun("wf-tier3", deps, { now: () => T0 + 100_000 });

    const events = await scanEvents("wf-tier3");
    // 无补收帧（档 3 不落 settled）
    expect(events.filter((e) => e.type === "agent-settled")).toHaveLength(1);
    expect(runs.get("wf-tier3")!.state.calls.has(1)).toBe(false);
  });
});

// ── 预算单源（run-created 载荷继承/覆盖）──────────
//
// 修复 已归档设计档案 §1.1：resume 重建 spec 曾结构性不含 budgetTimeMs。
// 修复后 run-created 帧是预算单源：resume 显式 options 覆盖 / 未提供则继承该帧，
// 生效值写入 spec。[ADR-0122] 原用例中「错误重试 → rebuildRuntime 重排」附加断言
// 随重试矩阵删除（rebuildRuntime 已删）。

describe("resume 预算单源（run-created 载荷继承/覆盖）", () => {
  /** 活跃跨度可控的崩溃 record 流（active = 段内末执行事件 ts − run-created ts）。 */
  async function seedWithBudget(
    runId: string,
    opts: { budgetTimeMs?: number; activeElapsedMs: number },
  ): Promise<void> {
    const { activeElapsedMs } = opts;
    const journal = createRunEventJournal(journalDir);
    await journal.append(runId, {
      type: "run-created",
      runId,
      workflowName: "test-wf",
      argsSummary: "{}",
      scriptSource: SCRIPT_SOURCE,
      ...(opts.budgetTimeMs !== undefined ? { budgetTimeMs: opts.budgetTimeMs } : {}),
      ts: T0,
    });
    await journal.append(runId, {
      type: "agent-started",
      taskIndex: 0,
      agentName: "collector",
      attempt: 1,
      ts: T0 + 1_000,
    });
    await journal.append(runId, {
      type: "agent-settled",
      taskIndex: 0,
      attempt: 1,
      outcome: "done",
      durationMs: activeElapsedMs - 1_000,
      result: { content: "result-0" },
      ts: T0 + activeElapsedMs - 1_000,
    });
    // 段内末执行事件 = 本帧（决定活跃已耗 = activeElapsedMs）
    await journal.append(runId, {
      type: "agent-started",
      taskIndex: 1,
      agentName: "collector",
      attempt: 1,
      ts: T0 + activeElapsedMs,
    });
    await journal.append(runId, {
      type: "run-interrupted",
      errorCode: "crashed",
      reason: "test crash",
      ts: T0 + activeElapsedMs + 1_000,
    });
  }

  it("未传 time → 继承 run-created 预算（首次挂表按剩余活跃折算，非满额/非 undefined）", async () => {
    const budget = 60 * MIN;
    const active = 40 * MIN;
    await seedWithBudget("wf-budget-inherit", { budgetTimeMs: budget, activeElapsedMs: active });
    const { deps, runs, budgetSchedules } = makeDeps();

    await resumeRun("wf-budget-inherit", deps, { now: () => Date.now() });

    const run = runs.get("wf-budget-inherit")!;
    // spec 单源恢复（修复前恒 undefined → 重试重排分支不可达）
    expect(run.spec.budgetTimeMs).toBe(budget);
    expect(run.state.budget.maxTimeMs).toBe(budget);
    // 首次挂表（adoptResumedRun）与 summary 同一生效值折算：≈60−40=20min
    expect(budgetSchedules).toHaveLength(1);
    expect(budgetSchedules[0]!.ms).toBeGreaterThan(budget - active - 60_000);
    expect(budgetSchedules[0]!.ms).toBeLessThanOrEqual(budget - active);

  });

  it("显式传 time → 覆盖 run-created 预算（生效值全链一致）", async () => {
    const createdBudget = 60 * MIN;
    const override = 120 * MIN;
    const active = 40 * MIN;
    await seedWithBudget("wf-budget-override", { budgetTimeMs: createdBudget, activeElapsedMs: active });
    const { deps, runs, budgetSchedules } = makeDeps();

    await resumeRun("wf-budget-override", deps, {
      now: () => Date.now(),
      budgetTimeMs: override,
    });

    const run = runs.get("wf-budget-override")!;
    expect(run.spec.budgetTimeMs).toBe(override); // 覆盖而非继承
    expect(run.state.budget.maxTimeMs).toBe(override);
    expect(budgetSchedules[0]!.ms).toBeGreaterThan(override - active - 60_000);
    expect(budgetSchedules[0]!.ms).toBeLessThanOrEqual(override - active);

  });

  it("旧格式帧（无预算字段）+ 未传 time → 不限时（现状行为不劣化：spec 无预算、两处均不重排）", async () => {
    await seedInterruptedRecord("wf-budget-legacy"); // 不传 budgetTimeMs = 载荷落地前的旧格式帧
    const { deps, runs, budgetSchedules } = makeDeps();

    await resumeRun("wf-budget-legacy", deps, { now: () => Date.now() });

    const run = runs.get("wf-budget-legacy")!;
    expect(run.spec.budgetTimeMs).toBeUndefined();
    expect(run.state.budget.maxTimeMs).toBeUndefined();
    expect(budgetSchedules).toHaveLength(0); // 首次挂表亦不排
  });

  it("旧格式帧（无预算字段）+ 显式传 time → 显式生效（既有恢复通道保留）", async () => {
    await seedInterruptedRecord("wf-budget-legacy-explicit");
    const { deps, runs, budgetSchedules } = makeDeps();

    await resumeRun("wf-budget-legacy-explicit", deps, {
      now: () => Date.now(),
      budgetTimeMs: 30 * MIN,
    });

    const run = runs.get("wf-budget-legacy-explicit")!;
    expect(run.spec.budgetTimeMs).toBe(30 * MIN);
    expect(budgetSchedules).toHaveLength(1);
  });

  it("run-created 预算为 0/负值 → 不落 spec 字段（不限时，与写侧条件式一致）", async () => {
    for (const [runId, budget] of [["wf-budget-zero", 0], ["wf-budget-negative", -1]] as const) {
      await seedWithBudget(runId, { budgetTimeMs: budget, activeElapsedMs: 40 * MIN });
      const { deps, runs, budgetSchedules } = makeDeps();

      await resumeRun(runId, deps, { now: () => Date.now() });

      const run = runs.get(runId)!;
      expect(run.spec.budgetTimeMs).toBeUndefined();
      expect(budgetSchedules).toHaveLength(0);
    }
  });

  it("继承预算已耗尽（活跃已耗 ≥ 原预算）→ D10 预检拒绝（复活窗不绕过预算）", async () => {
    await seedWithBudget("wf-budget-exhausted", { budgetTimeMs: 30 * MIN, activeElapsedMs: 40 * MIN });
    const { deps, runs } = makeDeps();

    await expectRejection(
      resumeRun("wf-budget-exhausted", deps, { now: () => Date.now() }),
      "has exhausted its time budget",
    );
    expect(runs.has("wf-budget-exhausted")).toBe(false);
  });

  it("写侧：显式覆盖预算随 run-resumed 帧落盘；未设/0 → 不落字段（与 run-created 同款条件式）", async () => {
    // 显式覆盖 120min（run-created 60min）→ 帧带 120min
    await seedWithBudget("wf-budget-frame-override", { budgetTimeMs: 60 * MIN, activeElapsedMs: 40 * MIN });
    await resumeRun("wf-budget-frame-override", makeDeps().deps, {
      now: () => Date.now(),
      budgetTimeMs: 120 * MIN,
    });
    const resumed = (await scanEvents("wf-budget-frame-override")).find((e) => e.type === "run-resumed")!;
    expect(resumed).toMatchObject({ type: "run-resumed", budgetTimeMs: 120 * MIN });

    // 未传 + run-created 也无 → 不限时 → 帧不落字段
    await seedInterruptedRecord("wf-budget-frame-none");
    await resumeRun("wf-budget-frame-none", makeDeps().deps, { now: () => Date.now() });
    const noneResumed = (await scanEvents("wf-budget-frame-none")).find((e) => e.type === "run-resumed")!;
    expect("budgetTimeMs" in noneResumed).toBe(false);

    // 显式 0 → 不限时 → 帧不落字段
    await seedInterruptedRecord("wf-budget-frame-zero");
    await resumeRun("wf-budget-frame-zero", makeDeps().deps, { now: () => Date.now(), budgetTimeMs: 0 });
    const zeroResumed = (await scanEvents("wf-budget-frame-zero")).find((e) => e.type === "run-resumed")!;
    expect("budgetTimeMs" in zeroResumed).toBe(false);
  });

  it("跨崩溃存续：第一次显式 120min → 第二次无参 resume 生效 120min（非创建预算 60min）", async () => {
    const runId = "wf-budget-durable";
    const createdBudget = 60 * MIN;
    const override = 120 * MIN;
    const active = 40 * MIN;
    try {
      await seedWithBudget(runId, { budgetTimeMs: createdBudget, activeElapsedMs: active });
      const first = makeDeps();
      await resumeRun(runId, first.deps, { now: () => Date.now(), budgetTimeMs: override });
      const firstResumed = (await scanEvents(runId)).find((e) => e.type === "run-resumed")!;
      expect(firstResumed).toMatchObject({ budgetTimeMs: override });

      // 第二次崩溃（生产等价：崩溃收编写 run-interrupted）
      await interruptRun(runId, { errorCode: "crashed", reason: "second crash" });

      // 第二次 resume 无参 → 三档回落命中上一条 run-resumed 的 120min（不是 created 60min）
      const second = makeDeps();
      await resumeRun(runId, second.deps, { now: () => Date.now() });
      const run = second.runs.get(runId)!;
      expect(run.spec.budgetTimeMs).toBe(override);
      expect(run.state.budget.maxTimeMs).toBe(override);

    } finally {
      resetPhaseSettlementTrackerForTest();
    }
  });

  it("旧格式 run-resumed（无字段）→ 回落 run-created 创建预算（旧格式行为不劣化）", async () => {
    const runId = "wf-budget-legacy-resumed";
    const journal = createRunEventJournal(journalDir);
    await journal.append(runId, {
      type: "run-created",
      runId,
      workflowName: "test-wf",
      argsSummary: "{}",
      scriptSource: SCRIPT_SOURCE,
      budgetTimeMs: 60 * MIN,
      ts: T0,
    });
    await journal.append(runId, { type: "agent-started", taskIndex: 0, agentName: "collector", attempt: 1, ts: T0 + 1_000 });
    await journal.append(runId, {
      type: "agent-settled",
      taskIndex: 0,
      attempt: 1,
      outcome: "done",
      durationMs: 1_000,
      result: { content: "r" },
      ts: T0 + 40 * MIN - 1_000,
    });
    await journal.append(runId, { type: "run-interrupted", errorCode: "crashed", ts: T0 + 40 * MIN });
    // 旧格式 run-resumed（本载荷落地前的流：无 budgetTimeMs）
    await journal.append(runId, { type: "run-resumed", ts: T0 + 40 * MIN + 1_000 });
    await journal.append(runId, { type: "run-interrupted", errorCode: "crashed", ts: T0 + 40 * MIN + 2_000 });

    const { deps, runs } = makeDeps();
    await resumeRun(runId, deps, { now: () => Date.now() });

    expect(runs.get(runId)!.spec.budgetTimeMs).toBe(60 * MIN);
  });
});

// ── token 预算单源（budgetTokens 与时间轴同构）─────────────────
//
// 与上方时间预算同族缺口（已归档设计档案 §1.1 遗留项）：
// resume 重建 spec 曾结构性不含 budgetTokens——复活 run 的引擎侧 maxTokens 投影
// （lifecycle.createRunningRun / worker-host budget 注入读 spec.budgetTokens）静默
// 失效。修复后 token 轴与时间轴完全同构：run-created 载预算 + 三档回落 + 生效值
// 随 run-resumed 落盘 + spec 重建 + D10 token 预检（帧推导下界口径）。

describe("resume token 预算单源（budgetTokens 与时间轴同构）", () => {
  /** token 消耗可控的崩溃 record 流（usedTokens = settled 帧 usage 的加权口径 input*1）。 */
  async function seedWithTokenBudget(
    runId: string,
    opts: { budgetTokens?: number; usedTokens?: number },
  ): Promise<void> {
    const journal = createRunEventJournal(journalDir);
    await journal.append(runId, {
      type: "run-created",
      runId,
      workflowName: "test-wf",
      argsSummary: "{}",
      scriptSource: SCRIPT_SOURCE,
      ...(opts.budgetTokens !== undefined ? { budgetTokens: opts.budgetTokens } : {}),
      ts: T0,
    });
    await journal.append(runId, {
      type: "agent-started",
      taskIndex: 0,
      agentName: "collector",
      attempt: 1,
      ts: T0 + 1_000,
    });
    await journal.append(runId, {
      type: "agent-settled",
      taskIndex: 0,
      attempt: 1,
      outcome: "done",
      durationMs: 5_000,
      result: {
        content: "result-0",
        ...(opts.usedTokens !== undefined
          ? {
              usage: { input: opts.usedTokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
            }
          : {}),
      },
      ts: T0 + 6_000,
    });
    await journal.append(runId, {
      type: "agent-started",
      taskIndex: 1,
      agentName: "collector",
      attempt: 1,
      ts: T0 + 7_000,
    });
    await journal.append(runId, {
      type: "run-interrupted",
      errorCode: "crashed",
      reason: "test crash",
      ts: T0 + 8_000,
    });
  }

  it("未传 tokens → 继承 run-created 预算：spec 与 Budget 投影同源生效，已耗计数不归零", async () => {
    await seedWithTokenBudget("wf-token-inherit", { budgetTokens: 10_000, usedTokens: 1_000 });
    const { deps, runs } = makeDeps();

    await resumeRun("wf-token-inherit", deps, { now: () => Date.now() });

    const run = runs.get("wf-token-inherit")!;
    // spec 单源恢复（worker-host budget 注入与错误重试重建读同源——修复前恒 undefined）
    expect(run.spec.budgetTokens).toBe(10_000);
    // Budget 投影与 fresh run 同形（rebuildBudget maxTokens 条件式）
    expect(run.state.budget.maxTokens).toBe(10_000);
    // 已耗恢复（[§2.1b] 帧推导）：加权口径 input*1
    expect(run.state.budget.usedTokens).toBe(1_000);
  });

  it("显式传 tokens → 覆盖 run-created 预算，随 run-resumed 帧落盘", async () => {
    await seedWithTokenBudget("wf-token-override", { budgetTokens: 10_000, usedTokens: 1_000 });
    const { deps, runs } = makeDeps();

    await resumeRun("wf-token-override", deps, { now: () => Date.now(), budgetTokens: 50_000 });

    const run = runs.get("wf-token-override")!;
    expect(run.spec.budgetTokens).toBe(50_000); // 覆盖而非继承
    expect(run.state.budget.maxTokens).toBe(50_000);
    const resumed = (await scanEvents("wf-token-override")).find((e) => e.type === "run-resumed")!;
    expect(resumed).toMatchObject({ type: "run-resumed", budgetTokens: 50_000 });
  });

  it("跨崩溃存续：第一次显式覆盖 → 第二次无参 resume 继承末条 run-resumed 的生效值（非创建预算）", async () => {
    const runId = "wf-token-durable";
    try {
      await seedWithTokenBudget(runId, { budgetTokens: 10_000, usedTokens: 100 });
      const first = makeDeps();
      await resumeRun(runId, first.deps, { now: () => Date.now(), budgetTokens: 50_000 });

      // 第二次崩溃（生产等价：崩溃收编写 run-interrupted）
      await interruptRun(runId, { errorCode: "crashed", reason: "second crash" });

      // 第二次 resume 无参 → 三档回落命中上一条 run-resumed 的 50k（不是 created 10k）
      const second = makeDeps();
      await resumeRun(runId, second.deps, { now: () => Date.now() });
      const run = second.runs.get(runId)!;
      expect(run.spec.budgetTokens).toBe(50_000);
      expect(run.state.budget.maxTokens).toBe(50_000);
    } finally {
      resetPhaseSettlementTrackerForTest();
    }
  });

  it("旧格式帧（无预算字段）+ 未传 tokens → 不限制；旧格式 run-resumed 回落 created 创建预算", async () => {
    // created 无 budgetTokens
    await seedWithTokenBudget("wf-token-legacy", { usedTokens: 100 });
    const { deps, runs } = makeDeps();
    await resumeRun("wf-token-legacy", deps, { now: () => Date.now() });
    const run = runs.get("wf-token-legacy")!;
    expect(run.spec.budgetTokens).toBeUndefined();
    expect(run.state.budget.maxTokens).toBeUndefined();

    // created 有 budgetTokens + run-resumed 无字段（本载荷落地前的旧格式流）→ 回落 created
    const runId = "wf-token-legacy-resumed";
    const journal = createRunEventJournal(journalDir);
    await journal.append(runId, {
      type: "run-created",
      runId,
      workflowName: "test-wf",
      argsSummary: "{}",
      scriptSource: SCRIPT_SOURCE,
      budgetTokens: 10_000,
      ts: T0,
    });
    await journal.append(runId, { type: "agent-started", taskIndex: 0, agentName: "collector", attempt: 1, ts: T0 + 1_000 });
    await journal.append(runId, {
      type: "agent-settled",
      taskIndex: 0,
      attempt: 1,
      outcome: "done",
      durationMs: 1_000,
      result: { content: "r" },
      ts: T0 + 2_000,
    });
    await journal.append(runId, { type: "run-interrupted", errorCode: "crashed", ts: T0 + 3_000 });
    await journal.append(runId, { type: "run-resumed", ts: T0 + 4_000 }); // 旧格式：无 budgetTokens
    await journal.append(runId, { type: "run-interrupted", errorCode: "crashed", ts: T0 + 5_000 });

    const second = makeDeps();
    await resumeRun(runId, second.deps, { now: () => Date.now() });
    expect(second.runs.get(runId)!.spec.budgetTokens).toBe(10_000);
  });

  it("run-created 预算为 0/负值、显式 0 → 不落 spec 字段、run-resumed 帧不落字段（与写侧条件式一致）", async () => {
    for (const [runId, budget] of [["wf-token-zero", 0], ["wf-token-negative", -1]] as const) {
      await seedWithTokenBudget(runId, { budgetTokens: budget, usedTokens: 100 });
      const { deps, runs } = makeDeps();
      await resumeRun(runId, deps, { now: () => Date.now() });
      expect(runs.get(runId)!.spec.budgetTokens).toBeUndefined();
      const resumed = (await scanEvents(runId)).find((e) => e.type === "run-resumed")!;
      expect("budgetTokens" in resumed).toBe(false);
    }
  });

  it("继承预算已耗尽（帧推导已耗 ≥ 原预算）→ D10 token 预检拒绝（复活窗不绕过预算）", async () => {
    await seedWithTokenBudget("wf-token-exhausted", { budgetTokens: 10_000, usedTokens: 10_000 });
    const { deps, runs } = makeDeps();

    await expectRejection(
      resumeRun("wf-token-exhausted", deps, { now: () => Date.now() }),
      "has exhausted its token budget",
    );
    expect(runs.has("wf-token-exhausted")).toBe(false);
  });

  it("显式覆盖抬升预算 → 预检按覆盖值放行（覆盖是合法的扩预算通道）", async () => {
    await seedWithTokenBudget("wf-token-raise", { budgetTokens: 10_000, usedTokens: 10_000 });
    const { deps, runs } = makeDeps();

    await resumeRun("wf-token-raise", deps, { now: () => Date.now(), budgetTokens: 20_000 });

    const run = runs.get("wf-token-raise")!;
    expect(run.spec.budgetTokens).toBe(20_000);
    expect(run.state.budget.maxTokens).toBe(20_000);
  });
});

// ── 场景 15：同进程双 resume ──────────────────────────────────

describe("场景 15 — 同进程双 resume：恰一次生效，第二次明确拒绝", () => {
  it("串行第二次：fold=running 资格拒绝；record 只有一套 run-resumed", async () => {
    await seedInterruptedRecord("wf-dbl");
    const { deps } = makeDeps();

    await resumeRun("wf-dbl", deps, { now: () => T0 + 100_000 });
    await expectRejection(
      resumeRun("wf-dbl", deps, { now: () => T0 + 200_000 }),
      "not 'interrupted'",
    );

    const events = await scanEvents("wf-dbl");
    expect(events.filter((e) => e.type === "run-resumed")).toHaveLength(1);
  });

  it("并发形态（Promise.allSettled）：恰一成功一拒绝；record 一套 run-resumed 无交错事件", async () => {
    await seedInterruptedRecord("wf-race");
    const { deps } = makeDeps();

    const results = await Promise.allSettled([
      resumeRun("wf-race", deps, { now: () => T0 + 100_000 }),
      resumeRun("wf-race", deps, { now: () => T0 + 100_001 }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // 拒绝形态：锁互斥（ELOCKED）或资格（fold=running）——两者都是「明确拒绝」
    const reason = rejected[0].reason as Error;
    expect(reason).toBeInstanceOf(ResumeRejectionError);

    const events = await scanEvents("wf-race");
    expect(events.filter((e) => e.type === "run-resumed")).toHaveLength(1);
    // 无交错事件：尾三帧恰为 interrupted → run-resumed（无第二套派发痕迹）
    expect(events.slice(-2).map((e) => e.type)).toEqual(["run-interrupted", "run-resumed"]);
  });
});

// ── 场景 9：跨进程双 resume（脚本层——锁互斥行为面）────────────

describe("场景 9 — 跨进程双 resume：锁被占 → 明确拒绝（恰一成功）", () => {
  it("锁目录预置在场（另一进程持有）：ELOCKED 拒绝，文案指明另一进程 + 恢复指引", async () => {
    await seedInterruptedRecord("wf-lock");
    // 预置锁（proper-lockfile 的锁形态 = <target>.lock 目录；模拟另一进程持锁）
    fs.mkdirSync(path.join(journalDir, "wf-lock.resume.lock"), { recursive: true });
    const { deps } = makeDeps();

    await expectRejection(resumeRun("wf-lock", deps), "resumed by another process");

    // 拒绝路径零状态变更：record 无 run-resumed
    const events = await scanEvents("wf-lock");
    expect(events.some((e) => e.type === "run-resumed")).toBe(false);
  });

  it("锁正常释放：成功 resume 后锁工件自清（下次 resume 不被自身锁阻塞）", async () => {
    await seedInterruptedRecord("wf-rel");
    const { deps } = makeDeps();

    await resumeRun("wf-rel", deps, { now: () => T0 + 100_000 });
    expect(fs.existsSync(path.join(journalDir, "wf-rel.resume.lock"))).toBe(false);
  });
});

// ── 场景 17：resume 后 abort ─────────────────────────────────

describe("场景 17 — resume 后 abort：cancelled 终局正常写入，对 cancelled 再 resume 明确拒绝", () => {
  it("resume → abortRun → run-settled(cancelled) 落 record → 再 resume 拒绝（already settled）", async () => {
    await seedInterruptedRecord("wf-abort");
    const { deps } = makeDeps();

    await resumeRun("wf-abort", deps, { now: () => T0 + 100_000 });
    await abortRun("wf-abort", deps, "user aborted");

    const events = await scanEvents("wf-abort");
    const settled = events.at(-1);
    expect(settled?.type).toBe("run-settled");
    expect((settled as { outcome?: string }).outcome).toBe("cancelled");

    await expectRejection(resumeRun("wf-abort", deps), "already settled");
    // 二次拒绝零新增事件
    expect((await scanEvents("wf-abort")).filter((e) => e.type === "run-resumed")).toHaveLength(1);
  });
});

// ── 资格校验族 ───────────────────────────────────────────────

describe("resumeRun — 资格校验（错了明说）", () => {
  it("record 流不存在：拒绝（含 legacy run 不可续指引）", async () => {
    const { deps } = makeDeps();
    await expectRejection(resumeRun("wf-ghost", deps), "no record stream");
  });

  it("终局 run（run-settled 在场）：拒绝（only interrupted runs can be resumed）", async () => {
    const journal = createRunEventJournal(journalDir);
    await journal.append("wf-done", {
      type: "run-created",
      runId: "wf-done",
      workflowName: "test-wf",
      argsSummary: "{}",
      scriptSource: SCRIPT_SOURCE,
      ts: T0,
    });
    await journal.append("wf-done", {
      type: "run-settled",
      outcome: "done",
      artifactsDir: journalDir,
      ts: T0 + 1_000,
    });
    const { deps } = makeDeps();
    await expectRejection(resumeRun("wf-done", deps), "already settled");
  });

  it("从未中断的 run（fold=running，无 run-interrupted 帧）：拒绝", async () => {
    const journal = createRunEventJournal(journalDir);
    await journal.append("wf-live", {
      type: "run-created",
      runId: "wf-live",
      workflowName: "test-wf",
      argsSummary: "{}",
      scriptSource: SCRIPT_SOURCE,
      ts: T0,
    });
    const { deps } = makeDeps();
    await expectRejection(resumeRun("wf-live", deps), "not 'interrupted'");
  });

  // [撞名缺陷 / 第 4 道检查扩展到派发期] run-created 里的脚本文本不可编译时，
  // resume 必须在段 4/5/6 的任何写动作之前干净拒绝（否则 Worker 启动后必然异步语法错）。
  it("派发前语法闸：脚本文本不可编译 → 干净拒绝（worker 未启动、无 run-resumed 写入）", async () => {
    await seedInterruptedRecord("wf-bad-script", {
      scriptSource: "const args = { a: 1 };\nasync function execute() {}",
    });
    const { deps, runs, workerStarts } = makeDeps();

    await expectRejection(resumeRun("wf-bad-script", deps), "cannot compile");

    // 干净拒绝：无 worker、无活体注册、record 流保持 interrupted（run-resumed 未落）
    expect(workerStarts).toHaveLength(0);
    expect(runs.size).toBe(0);
    const events = await scanEvents("wf-bad-script");
    expect(events.filter((e) => e.type === "run-resumed")).toHaveLength(0);
  });

  // D13 嵌套词法拒绝已随嵌套 workflow() 功能移除而删除（检测对象不存在，场景 20 退役）
});

// ── D12 record 完整性校验（场景 18 resume 侧）─────────────────

describe("resumeRun — D12 完整性拒绝（损坏面）", () => {
  /** 手写 record 流文件（严格行由调用方拼——seq 显式控制以构造断档）。 */
  function writeRawRecord(runId: string, lines: unknown[]): void {
    fs.writeFileSync(
      path.join(journalDir, `${runId}.record.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );
  }

  const createdLine = { type: "run-created", runId: "wf-broken", workflowName: "w", argsSummary: "{}", scriptSource: "x", ts: T0, seq: 1 };

  it("半截行（末尾 JSON 截断）：拒绝 + 恢复指引", async () => {
    fs.writeFileSync(
      path.join(journalDir, "wf-broken.record.jsonl"),
      `${JSON.stringify(createdLine)}\n{"type":"run-interrupted","ts":${T0 + 1},"seq":2`, // 第二行截断
      "utf8",
    );
    const { deps } = makeDeps();
    await expectRejection(resumeRun("wf-broken", deps), "corrupted");
  });

  it("seq 断档（跳号 = 丢行/截断）：拒绝", async () => {
    writeRawRecord("wf-broken", [
      createdLine,
      { type: "run-interrupted", ts: T0 + 1, seq: 3 }, // 跳过 seq 2
    ]);
    const { deps } = makeDeps();
    await expectRejection(resumeRun("wf-broken", deps), "seq gap");
  });

  it("agent-settled 缺 result 全文：拒绝（D12 非法形态）", async () => {
    writeRawRecord("wf-broken", [
      createdLine,
      { type: "agent-started", taskIndex: 0, agentName: "a", attempt: 1, ts: T0 + 1, seq: 2 },
      { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 1, ts: T0 + 2, seq: 3 },
      { type: "run-interrupted", errorCode: "crashed", ts: T0 + 3, seq: 4 },
    ]);
    const { deps } = makeDeps();
    await expectRejection(resumeRun("wf-broken", deps), "no result payload");
  });
});

// ── 裁决点 7 + D10 预检 ──────────────────────────────────────

describe("resumeRun — v2 条目补写与预算预检", () => {
  it("appendEntry 失败：干净拒绝（run-resumed 未落，状态无损可重试）", async () => {
    await seedInterruptedRecord("wf-entryfail");
    const { deps } = makeDeps();
    (deps.appendEntry as ReturnType<typeof vi.fn>) = vi.fn(() => {
      throw new Error("session not writable");
    });

    await expectRejection(resumeRun("wf-entryfail", deps), "could not register");
    const events = await scanEvents("wf-entryfail");
    expect(events.some((e) => e.type === "run-resumed")).toBe(false);
    expect(events.at(-1)?.type).toBe("run-interrupted");
  });

  it("D10 预算预检：真实活跃段已耗尽 → 拒绝（搁置不计、已耗不退）", async () => {
    await seedInterruptedRecord("wf-budget");
    const { deps } = makeDeps();
    // 活跃段 = T0+1000..T0+7000 ≈ 6s（created → 末条执行事件）
    await expectRejection(
      resumeRun("wf-budget", deps, { budgetTimeMs: 5_000, now: () => T0 + 10 * 24 * 3600 * 1000 }),
      "exhausted its time budget",
    );
  });

  it("D10 预算预检：跨天搁置后仍有剩余 → 通过（场景 16 的不被秒拒，编排层）", async () => {
    await seedInterruptedRecord("wf-budget-ok");
    const { deps, runs } = makeDeps();
    // 预算 60s、活跃 6s、搁置 10 天 → 剩余 54s，resume 成功
    await expect(
      resumeRun("wf-budget-ok", deps, { budgetTimeMs: 60_000, now: () => T0 + 10 * 24 * 3600 * 1000 }),
    ).resolves.toBe("wf-budget-ok");
    expect(runs.get("wf-budget-ok")).toBeDefined();
  });
});

// ── 段 6 接管失败补偿（僵尸 run 防线）─────────────────────────

describe("resumeRun — 段 6 接管失败补偿（僵尸 run 防线）", () => {
  it("adoptResumedRun 失败：回滚落 run-interrupted(crashed)、无僵尸注册、再次 resume 不被「actively running」误拒", async () => {
    await seedInterruptedRecord("wf-adoptfail");
    const { deps, runs } = makeDeps();
    // worker 接管失败（段 6 可失败面：run-resumed 帧已落盘之后的重建/接管抛错）
    vi.mocked(deps.workerHost.start).mockImplementation(() => {
      throw new Error("engine spawn failed");
    });

    // 原异常上抛（调用方报错给用户），不被补偿路径转换语义
    await expect(resumeRun("wf-adoptfail", deps, { now: () => T0 + 100_000 }))
      .rejects.toThrow("engine spawn failed");

    // record：run-resumed 已落 + 补偿回滚——末帧 run-interrupted(errorCode=crashed，
    // reason 带失败原因)，而非滞留 running 的僵尸流
    const events = await scanEvents("wf-adoptfail");
    expect(events.some((e) => e.type === "run-resumed")).toBe(true);
    const last = events.at(-1);
    expect(last?.type).toBe("run-interrupted");
    expect((last as { errorCode?: string }).errorCode).toBe("crashed");
    expect((last as { reason?: string }).reason).toContain("resume adoption failed");
    expect((last as { reason?: string }).reason).toContain("engine spawn failed");
    // 进程内无僵尸注册（接管失败点在 runs.set 之前）
    expect(runs.has("wf-adoptfail")).toBe(false);

    // 再次 resume：record 已回 interrupted 态，资格校验不误拒——重试成功复活
    //（修复前：fold 滞留 running → 以「an actively running run needs no resume」
    // 拒绝，与「进程内无活体」的实情相反）
    const fresh = makeDeps();
    await expect(resumeRun("wf-adoptfail", fresh.deps, { now: () => T0 + 200_000 }))
      .resolves.toBe("wf-adoptfail");
    expect(isRunSettled(fresh.runs.get("wf-adoptfail")!)).toBe(false);
    const eventsAfterRetry = await scanEvents("wf-adoptfail");
    expect(eventsAfterRetry.filter((e) => e.type === "run-resumed")).toHaveLength(2);
  });

  it("回滚自身失败（journal 不可写）：不掩盖原异常上抛 + error 留痕指恢复路径", async () => {
    await seedInterruptedRecord("wf-rollbackfail");
    const { deps } = makeDeps();
    const errorSpy = vi.spyOn(getLogger("subagents"), "error");
    const recordPath = path.join(journalDir, "wf-rollbackfail.record.jsonl");
    vi.mocked(deps.workerHost.start).mockImplementation(() => {
      // 段 6 时刻（run-resumed 帧已落盘）：把 record 流换成目录形态，令补偿回滚的
      // journal append 以 EISDIR 失败——模拟「回滚自身也失败」的双重故障
      fs.rmSync(recordPath);
      fs.mkdirSync(recordPath);
      throw new Error("engine spawn failed");
    });

    try {
      // 原异常照常上抛（不被回滚失败掩盖成第二个错误）
      await expect(resumeRun("wf-rollbackfail", deps, { now: () => T0 + 100_000 }))
        .rejects.toThrow("engine spawn failed");
      // 回滚失败 error 留痕（含 runId 与恢复指引：下次 session_start 崩溃收编兜底）
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("resume rollback to interrupted failed (runId=wf-rollbackfail)"),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
