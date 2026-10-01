// src/orchestration/__tests__/run-event-dispatch.test.ts
//
// [P1b-1] run 事件状态机接线单测（D5-④ 唯一入口的编排侧消费面）。
//
// 锁四面（设计 workflow-architecture-redesign D5 事件枚举表 + 转移表）：
// 1. 事件序列落账：ask 重试轨迹完整（run-created → agent-started → agent-retrying →
//    agent-settled(failed, errorCode) → agent-settled(completed, attempt 递增) →
//    run-settled(completed)）——对照设计 D5 事件枚举表的字段验收（attempt/errorCode）。
// 2. 终态三形态（journal 侧写读闭环）：成功=completed、失败=failed+errorCode、
//    取消=cancelled（经 cancel-requested 控制事件合成 run-settled 路径——控制事件
//    本身不落 journal，journal 词表恰无 cancel-requested 帧）。
// 3. terminal 后单写者停止 append：终局后再投递任何事件 = IllegalTransitionError
//    让位，journal 帧数不变（表 terminal × 任意事件 fail-fast 的接线侧守卫）。
// 4. fold 重放：清空活体态缓存后，新投递从 journal fold 恢复状态——终帧停 running
//    时后续 run-settled 可续推（run-events.ts fold 契约的接线侧验证）。
//
// journal 目录经 setRunEventJournalDirForTest 注入 mkdtemp 临时目录（测试红线：
// 不触真实数据目录；teardown rmSync 带 maxRetries——F3 flake 纪律）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dispatchAgentStarted,
  dispatchAgentRetrying,
  dispatchAgentSettledFailed,
  dispatchRunCreated,
  dispatchRunTrigger,
  setRunEventJournalDirForTest,
} from "../terminal-actions.ts";
import { createRunEventJournal } from "../run-events.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import type { WorkflowRunEvent } from "../run-events.ts";
import type { WorkerHandle } from "../worker-handle.ts";

// ── helpers ──────────────────────────────────────────────────

/** journal 读回（scan 走 run-events 唯一实装——写读同源）。 */
function scanRunEvents(dir: string, runId: string): Promise<readonly WorkflowRunEvent[]> {
  return createRunEventJournal(dir).scan(runId);
}

// ── helpers ──────────────────────────────────────────────────

let journalDir: string;

beforeEach(() => {
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-event-dispatch-"));
  setRunEventJournalDirForTest(journalDir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 构造真实 WorkflowRun（spec/args 可控——created 引导补投的载荷源）。 */
function makeRun(runId: string, opts: { budgetTimeMs?: number } = {}): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptName: "review-fix-loop",
      scriptSource: "agent('hi')",
      args: { pr: 42 },
      scriptPath: "/tmp/review-fix-loop.js",
      ...(opts.budgetTimeMs !== undefined ? { budgetTimeMs: opts.budgetTimeMs } : {}),
      model: "test-model",
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
    postMessage: () => {},
    terminate: async () => {},
  } as unknown as WorkerHandle;
  run.assignRuntime(new RunRuntime(worker, new AbortController()));
  return run;
}

// ── 1. 事件序列落账（ask 重试轨迹完整） ──────────────────────

describe("事件序列落账（D5 事件枚举表对照）", () => {
  it("ask 重试轨迹完整：dispatched → retrying → settled(failed, errorCode, attempt) → settled(completed, attempt+1) → run-settled(completed)", async () => {
    const run = makeRun("wf-seq-1");
    const ts = Date.now();

    await dispatchRunTrigger(run, {
      type: "run-created",
      runId: run.runId,
      workflowName: run.spec.scriptName,
      argsSummary: '{"pr":42}',
      model: run.spec.model,
      ts,
    });
    await dispatchRunTrigger(run, {
      type: "agent-started",
      taskIndex: 1,
      agentName: "reviewer",
      attempt: 1,
      ts,
    });
    await dispatchRunTrigger(run, {
      type: "agent-retrying",
      taskIndex: 1,
      attempt: 1,
      backoffMs: 1000,
      reason: "engine_crashed: child exited",
      ts,
    });
    await dispatchRunTrigger(run, {
      type: "agent-settled",
      taskIndex: 1,
      attempt: 1,
      outcome: "failed",
      errorCode: "engine_crashed",
      durationMs: 21000,
      stderrTeePath: "/tmp/stderr-tee.jsonl",
      ts,
    });
    await dispatchRunTrigger(run, {
      type: "agent-settled",
      taskIndex: 1,
      attempt: 2,
      outcome: "done",
      durationMs: 5000,
      ts,
    });
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "done",
      artifactsDir: journalDir,
      ts,
    });

    const events = await scanRunEvents(journalDir, run.runId);
    expect(events.map((e) => e.type)).toEqual([
      "run-created",
      "agent-started",
      "agent-retrying",
      "agent-settled",
      "agent-settled",
      "run-settled",
    ]);
    // 重试轨迹字段验收（D5 载荷表：attempt/errorCode/退避/原因）
    const retrying = events[2] as Extract<WorkflowRunEvent, { type: "agent-retrying" }>;
    expect(retrying).toMatchObject({ taskIndex: 1, attempt: 1, backoffMs: 1000 });
    const firstSettled = events[3] as Extract<WorkflowRunEvent, { type: "agent-settled" }>;
    expect(firstSettled).toMatchObject({
      taskIndex: 1,
      attempt: 1,
      outcome: "failed",
      errorCode: "engine_crashed",
      stderrTeePath: "/tmp/stderr-tee.jsonl",
    });
    const secondSettled = events[4] as Extract<WorkflowRunEvent, { type: "agent-settled" }>;
    expect(secondSettled).toMatchObject({ taskIndex: 1, attempt: 2, outcome: "done" });
    expect(secondSettled.errorCode).toBeUndefined();
    const final = events[5] as Extract<WorkflowRunEvent, { type: "run-settled" }>;
    expect(final).toMatchObject({ outcome: "done", artifactsDir: journalDir });
  });

  it("[Q2] created 引导已退役：无 run-created 前史时首个编排触发表外转移 fail-fast（不静默补齐）", async () => {
    const run = makeRun("wf-seq-bootstrap");

    await expect(
      dispatchRunTrigger(run, {
        type: "agent-started",
        taskIndex: 7,
        agentName: "fixer",
        attempt: 1,
        ts: Date.now(),
      }),
    ).rejects.toThrow(/非法 run 状态转移/);

    // fail-fast 不落任何帧（run-created 唯一落点 = dispatchRunCreated 正点）
    expect(await scanRunEvents(journalDir, run.runId)).toHaveLength(0);
  });
});

// ── 1.5 agent-started phase 承载（W1 D6 phase 分组供源） ────

describe("agent-started phase 承载（W1 D6 分组供源）", () => {
  it("dispatchAgentStarted 透传 phase：journal 帧携带剧本归属", async () => {
    const run = makeRun("wf-phase-1");
    await dispatchRunCreated(run);
    dispatchAgentStarted(run, 0, "reviewer", "Dev-w0(W1)");
    await dispatchRunTrigger(run, { type: "cancel-requested", reason: "test-drain" });

    const events = await scanRunEvents(journalDir, run.runId);
    const dispatched = events.find(
      (e): e is Extract<WorkflowRunEvent, { type: "agent-started" }> => e.type === "agent-started",
    )!;
    expect(dispatched.phase).toBe("Dev-w0(W1)");
  });

  it("无归属（缺参 / 空串）不写 phase 键——载荷紧凑，旧读侧零兼容成本", async () => {
    const run = makeRun("wf-phase-2");
    await dispatchRunCreated(run);
    dispatchAgentStarted(run, 0, "reviewer");
    dispatchAgentStarted(run, 1, "fixer", "");
    await dispatchRunTrigger(run, { type: "cancel-requested", reason: "test-drain" });

    const events = await scanRunEvents(journalDir, run.runId);
    const dispatched = events.filter(
      (e): e is Extract<WorkflowRunEvent, { type: "agent-started" }> => e.type === "agent-started",
    );
    expect(dispatched).toHaveLength(2);
    for (const frame of dispatched) {
      expect("phase" in frame).toBe(false);
    }
  });
});

// ── 1.6 run-created 时间预算载荷（预算单源，已归档设计档案（决策记录见 docs/adr/decisions.md） §1.1） ──

describe("run-created 时间预算载荷（resume 预算单源）", () => {
  it("spec.budgetTimeMs > 0 → 帧携带该字段（resume 继承恢复的数据面）", async () => {
    const run = makeRun("wf-created-budget", { budgetTimeMs: 600_000 });
    await dispatchRunCreated(run);

    const events = await scanRunEvents(journalDir, run.runId);
    const created = events.find(
      (e): e is Extract<WorkflowRunEvent, { type: "run-created" }> => e.type === "run-created",
    )!;
    expect(created.budgetTimeMs).toBe(600_000);
  });

  it("未设/0/负值 → 不落字段（旧格式形态保持，读侧回落不限时）", async () => {
    const cases: Array<[string, number | undefined]> = [
      ["wf-created-nobudget", undefined],
      ["wf-created-zero", 0],
      ["wf-created-negative", -1],
    ];
    for (const [runId, budget] of cases) {
      const run = makeRun(runId, budget !== undefined ? { budgetTimeMs: budget } : {});
      await dispatchRunCreated(run);
      const events = await scanRunEvents(journalDir, runId);
      const created = events.find((e) => e.type === "run-created")!;
      expect("budgetTimeMs" in created).toBe(false);
    }
  });
});

// ── 2. 终态三形态（journal 侧写读闭环） ──────────────────────

describe("终态写读三形态（验收 b：journal 侧）", () => {
  it("成功 = completed", async () => {
    const run = makeRun("wf-term-ok");
    await dispatchRunCreated(run); // [Q2] 正点发射（引导已删）
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "done",
      artifactsDir: journalDir,
      ts: Date.now(),
    });

    const events = await scanRunEvents(journalDir, run.runId);
    expect(events.at(-1)).toMatchObject({ type: "run-settled", outcome: "done" });
  });

  it("失败 = failed + errorCode", async () => {
    const run = makeRun("wf-term-fail");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "failed",
      errorCode: "engine_crashed",
      reason: "worker died 3 times",
      artifactsDir: journalDir,
      ts: Date.now(),
    });

    const events = await scanRunEvents(journalDir, run.runId);
    expect(events.at(-1)).toMatchObject({
      type: "run-settled",
      outcome: "failed",
      errorCode: "engine_crashed",
    });
  });

  it("取消 = cancelled（经 cancel-requested 控制事件合成 run-settled；控制事件本身不落 journal）", async () => {
    const run = makeRun("wf-term-cancel");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "agent-started",
      taskIndex: 1,
      agentName: "a",
      attempt: 1,
      ts: Date.now(),
    });
    await dispatchRunTrigger(run, { type: "cancel-requested", reason: "user abort" });

    const events = await scanRunEvents(journalDir, run.runId);
    // journal 词表恰无 cancel-requested——合成形态 = run-settled(cancelled)
    expect(events.map((e) => e.type)).toEqual(["run-created", "agent-started", "run-settled"]);
    expect(events.at(-1)).toMatchObject({ type: "run-settled", outcome: "cancelled", reason: "user abort" });
  });

  it("派发前置失败形态（resolveAgentOpts 失败）= failed + errorCode unknown + result 全文随帧", async () => {
    // [U6 回归] agent-settled 帧缺 result 是 record 恢复读面（loadAll 严格解析 /
    // D12 完整性校验）的拒绝形态——本帧是合法写入方（agent 名/skill 解析失败路径），
    // result 必须随帧落账，否则一次普通用户错误（agent 名拼错）在重启后使整个
    // workflow 域停初始化。errorResult 与 worker-message-pump resolveAgentOpts
    // 失败分支构造的 run 内形态同源（{content:"", error}）。
    const run = makeRun("wf-pre-dispatch-fail");
    await dispatchRunCreated(run);
    dispatchAgentSettledFailed(run, 0, { content: "", error: "skill not found: reviewer-x" });
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "failed",
      errorCode: "unknown",
      reason: "agent opts resolve failed",
      artifactsDir: journalDir,
      ts: Date.now(),
    });

    const events = await scanRunEvents(journalDir, run.runId);
    const settled = events.find((e) => e.type === "agent-settled");
    expect(settled).toMatchObject({
      type: "agent-settled",
      taskIndex: 0,
      outcome: "failed",
      errorCode: "unknown",
      result: { content: "", error: "skill not found: reviewer-x" },
    });
  });
});

// ── 3. terminal 后单写者停止 append ──────────────────────────

describe("terminal 后追加让位（终局纪律守卫）", () => {
  it("终局后投递任何事件 → IllegalTransitionError，journal 帧数不变", async () => {
    const run = makeRun("wf-term-guard");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "done",
      artifactsDir: journalDir,
      ts: Date.now(),
    });
    const before = await scanRunEvents(journalDir, run.runId);
    expect(before).toHaveLength(2); // run-created(正点) + run-settled

    await expect(
      dispatchRunTrigger(run, {
        type: "agent-settled",
        taskIndex: 1,
        attempt: 1,
        outcome: "done",
        durationMs: 1,
        ts: Date.now(),
      }),
    ).rejects.toThrow(/terminal/);

    const after = await scanRunEvents(journalDir, run.runId);
    expect(after).toHaveLength(before.length);
  });
});

// ── 4. fold 重放 ─────────────────────────────────────────────

describe("fold 重放（活体态 miss → journal fold 恢复）", () => {
  it("终帧停 running 的 journal：重置活体缓存后投 run-settled 续推至 terminal", async () => {
    const runId = "wf-fold-1";
    const run = makeRun(runId);
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "agent-started",
      taskIndex: 1,
      agentName: "a",
      attempt: 1,
      ts: Date.now(),
    });
    await dispatchRunTrigger(run, {
      type: "agent-settled",
      taskIndex: 1,
      attempt: 1,
      outcome: "done",
      durationMs: 1,
      ts: Date.now(),
    });

    // 清空活体态缓存（模拟进程重启后的投影恢复路径）——journal 仍在
    setRunEventJournalDirForTest(journalDir);
    const run2 = makeRun(runId);
    await dispatchRunTrigger(run2, {
      type: "run-settled",
      outcome: "done",
      artifactsDir: journalDir,
      ts: Date.now(),
    });

    const events = await scanRunEvents(journalDir, runId);
    expect(events.map((e) => e.type)).toEqual([
      "run-created",
      "agent-started",
      "agent-settled",
      "run-settled",
    ]);
  });

  it("已 terminal 的 journal：重置后投递 fail-fast（fold 终帧落 terminal 的守卫）", async () => {
    const runId = "wf-fold-2";
    const run = makeRun(runId);
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "done",
      artifactsDir: journalDir,
      ts: Date.now(),
    });

    setRunEventJournalDirForTest(journalDir);
    const run2 = makeRun(runId);
    await expect(
      dispatchRunTrigger(run2, {
        type: "agent-started",
        taskIndex: 1,
        agentName: "a",
        attempt: 1,
        ts: Date.now(),
      }),
    ).rejects.toThrow(/terminal/);
    const events = await scanRunEvents(journalDir, runId);
    expect(events).toHaveLength(2);
  });
});

// ── 5. run 启动竞态回归（L4 A4 附带发现：8 跑 1 丢 6 帧的回归锁） ──────────

describe("run 启动竞态回归（created 落账前到达的 ask 帧零丢失）", () => {
  it("run-created 入队（不 await）后同步并发投递首 ask 链 ×20 轮 → 帧序 created 先行、零丢帧", async () => {
    // 生产时序（lifecycle.runWorkflow 修复后形态）：created 入队先于 worker 启动，
    // worker 首个 agent() 的 ask 事件在 created 落账完成前同步入队——per-run 队列
    // 执行序 = 入队序，ask 帧必须全部落账。修复前形态（ask 先入队）在 created 态
    // 表外转移被 yielded 吞，journal 永久缺帧。cancel-requested 作队列尾哨兵
    // （await 它 = 该 run 队列排空 + terminal 自清理）。
    for (let i = 0; i < 20; i++) {
      const run = makeRun(`wf-race-${i}`);
      const createdPromise = dispatchRunCreated(run);
      dispatchAgentStarted(run, 0, "reviewer");
      dispatchAgentRetrying(run, 0, 1, 1000, "engine_run_failed: race probe");
      dispatchAgentSettledFailed(run, 0, { content: "", error: "skill not found: nope" });
      await dispatchRunTrigger(run, {
        type: "cancel-requested",
        reason: "race-probe",
      });
      await createdPromise;

      const events = await scanRunEvents(journalDir, run.runId);
      expect(events.map((e) => e.type), `round ${i}`).toEqual([
        "run-created",
        "agent-started",
        "agent-retrying",
        "agent-settled",
        "run-settled",
      ]);
    }
  });

  it("接线错误语义保持：ask 帧先于 created 入队（修复前的竞态形态直构）→ created 态表外让位不补齐", async () => {
    // 反向锁：竞态修复靠入队序，不改让位语义——若未来有人回退 lifecycle 入队点，
    // 本用例的让位行为（journal 缺 ask 帧）+ lifecycle 时序锁用例会双双红灯。
    const run = makeRun("wf-race-inverted");
    void dispatchRunTrigger(run, {
      type: "agent-started",
      taskIndex: 0,
      agentName: "reviewer",
      attempt: 1,
      ts: Date.now(),
    }).catch(() => {});
    await dispatchRunCreated(run);

    const events = await scanRunEvents(journalDir, run.runId);
    expect(events.map((e) => e.type)).toEqual(["run-created"]);
  });
});
