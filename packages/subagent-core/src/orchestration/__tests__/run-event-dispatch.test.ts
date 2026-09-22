// src/orchestration/__tests__/run-event-dispatch.test.ts
//
// [P1b-1] run 事件状态机接线单测（D5-④ 唯一入口的编排侧消费面）。
//
// 锁四面（设计 workflow-architecture-redesign D5 事件枚举表 + 转移表）：
// 1. 事件序列落账：ask 重试轨迹完整（run-created → ask-dispatched → ask-retrying →
//    ask-settled(failed, errorCode) → ask-settled(completed, attempt 递增) →
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
  dispatchAskDispatched,
  dispatchAskRetrying,
  dispatchAskSettledFailed,
  dispatchRunCreated,
  dispatchRunTrigger,
  setRunEventJournalDirForTest,
} from "../worker-message-pump.ts";
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
function makeRun(runId: string): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptName: "review-fix-loop",
      scriptSource: "agent('hi')",
      args: { pr: 42 },
      scriptPath: "/tmp/review-fix-loop.js",
      model: "test-model",
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
      type: "ask-dispatched",
      taskIndex: 1,
      agentName: "reviewer",
      attempt: 1,
      ts,
    });
    await dispatchRunTrigger(run, {
      type: "ask-retrying",
      taskIndex: 1,
      attempt: 1,
      backoffMs: 1000,
      reason: "engine_crashed: child exited",
      ts,
    });
    await dispatchRunTrigger(run, {
      type: "ask-settled",
      taskIndex: 1,
      attempt: 1,
      outcome: "failed",
      errorCode: "engine_crashed",
      durationMs: 21000,
      stderrTeePath: "/tmp/stderr-tee.jsonl",
      ts,
    });
    await dispatchRunTrigger(run, {
      type: "ask-settled",
      taskIndex: 1,
      attempt: 2,
      outcome: "completed",
      durationMs: 5000,
      ts,
    });
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "completed",
      artifactsDir: journalDir,
      ts,
    });

    const events = await scanRunEvents(journalDir, run.runId);
    expect(events.map((e) => e.type)).toEqual([
      "run-created",
      "ask-dispatched",
      "ask-retrying",
      "ask-settled",
      "ask-settled",
      "run-settled",
    ]);
    // 重试轨迹字段验收（D5 载荷表：attempt/errorCode/退避/原因）
    const retrying = events[2] as Extract<WorkflowRunEvent, { type: "ask-retrying" }>;
    expect(retrying).toMatchObject({ taskIndex: 1, attempt: 1, backoffMs: 1000 });
    const firstSettled = events[3] as Extract<WorkflowRunEvent, { type: "ask-settled" }>;
    expect(firstSettled).toMatchObject({
      taskIndex: 1,
      attempt: 1,
      outcome: "failed",
      errorCode: "engine_crashed",
      stderrTeePath: "/tmp/stderr-tee.jsonl",
    });
    const secondSettled = events[4] as Extract<WorkflowRunEvent, { type: "ask-settled" }>;
    expect(secondSettled).toMatchObject({ taskIndex: 1, attempt: 2, outcome: "completed" });
    expect(secondSettled.errorCode).toBeUndefined();
    const final = events[5] as Extract<WorkflowRunEvent, { type: "run-settled" }>;
    expect(final).toMatchObject({ outcome: "completed", artifactsDir: journalDir });
  });

  it("[Q2] created 引导已退役：无 run-created 前史时首个编排触发表外转移 fail-fast（不静默补齐）", async () => {
    const run = makeRun("wf-seq-bootstrap");

    await expect(
      dispatchRunTrigger(run, {
        type: "ask-dispatched",
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

// ── 2. 终态三形态（journal 侧写读闭环） ──────────────────────

describe("终态写读三形态（验收 b：journal 侧）", () => {
  it("成功 = completed", async () => {
    const run = makeRun("wf-term-ok");
    await dispatchRunCreated(run); // [Q2] 正点发射（引导已删）
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "completed",
      artifactsDir: journalDir,
      ts: Date.now(),
    });

    const events = await scanRunEvents(journalDir, run.runId);
    expect(events.at(-1)).toMatchObject({ type: "run-settled", outcome: "completed" });
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
      type: "ask-dispatched",
      taskIndex: 1,
      agentName: "a",
      attempt: 1,
      ts: Date.now(),
    });
    await dispatchRunTrigger(run, { type: "cancel-requested", reason: "user abort" });

    const events = await scanRunEvents(journalDir, run.runId);
    // journal 词表恰无 cancel-requested——合成形态 = run-settled(cancelled)
    expect(events.map((e) => e.type)).toEqual(["run-created", "ask-dispatched", "run-settled"]);
    expect(events.at(-1)).toMatchObject({ type: "run-settled", outcome: "cancelled", reason: "user abort" });
  });
});

// ── 3. terminal 后单写者停止 append ──────────────────────────

describe("terminal 后追加让位（终局纪律守卫）", () => {
  it("终局后投递任何事件 → IllegalTransitionError，journal 帧数不变", async () => {
    const run = makeRun("wf-term-guard");
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "completed",
      artifactsDir: journalDir,
      ts: Date.now(),
    });
    const before = await scanRunEvents(journalDir, run.runId);
    expect(before).toHaveLength(2); // run-created(正点) + run-settled

    await expect(
      dispatchRunTrigger(run, {
        type: "ask-settled",
        taskIndex: 1,
        attempt: 1,
        outcome: "completed",
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
      type: "ask-dispatched",
      taskIndex: 1,
      agentName: "a",
      attempt: 1,
      ts: Date.now(),
    });
    await dispatchRunTrigger(run, {
      type: "ask-settled",
      taskIndex: 1,
      attempt: 1,
      outcome: "completed",
      durationMs: 1,
      ts: Date.now(),
    });

    // 清空活体态缓存（模拟进程重启后的投影恢复路径）——journal 仍在
    setRunEventJournalDirForTest(journalDir);
    const run2 = makeRun(runId);
    await dispatchRunTrigger(run2, {
      type: "run-settled",
      outcome: "completed",
      artifactsDir: journalDir,
      ts: Date.now(),
    });

    const events = await scanRunEvents(journalDir, runId);
    expect(events.map((e) => e.type)).toEqual([
      "run-created",
      "ask-dispatched",
      "ask-settled",
      "run-settled",
    ]);
  });

  it("已 terminal 的 journal：重置后投递 fail-fast（fold 终帧落 terminal 的守卫）", async () => {
    const runId = "wf-fold-2";
    const run = makeRun(runId);
    await dispatchRunCreated(run);
    await dispatchRunTrigger(run, {
      type: "run-settled",
      outcome: "completed",
      artifactsDir: journalDir,
      ts: Date.now(),
    });

    setRunEventJournalDirForTest(journalDir);
    const run2 = makeRun(runId);
    await expect(
      dispatchRunTrigger(run2, {
        type: "ask-dispatched",
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
      dispatchAskDispatched(run, 0, "reviewer");
      dispatchAskRetrying(run, 0, 1, 1000, "engine_run_failed: race probe");
      dispatchAskSettledFailed(run, 0);
      await dispatchRunTrigger(run, {
        type: "cancel-requested",
        reason: "race-probe",
      });
      await createdPromise;

      const events = await scanRunEvents(journalDir, run.runId);
      expect(events.map((e) => e.type), `round ${i}`).toEqual([
        "run-created",
        "ask-dispatched",
        "ask-retrying",
        "ask-settled",
        "run-settled",
      ]);
    }
  });

  it("接线错误语义保持：ask 帧先于 created 入队（修复前的竞态形态直构）→ created 态表外让位不补齐", async () => {
    // 反向锁：竞态修复靠入队序，不改让位语义——若未来有人回退 lifecycle 入队点，
    // 本用例的让位行为（journal 缺 ask 帧）+ lifecycle 时序锁用例会双双红灯。
    const run = makeRun("wf-race-inverted");
    void dispatchRunTrigger(run, {
      type: "ask-dispatched",
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
