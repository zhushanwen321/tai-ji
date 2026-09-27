// src/orchestration/__tests__/run-armed-receipt.test.ts
//
// [D3 协议版 P6] armed 回执落账断言（验收 d：armed 事件经 dispatchRunTrigger 真实
// 链路入 events journal）。锁四面：
// 1. journal 可见：dispatchRunTrigger(armed) 落 RunArmedEvent 帧（载荷 = 协议 armed
//    事件对象，frame 字段承载 D3 武装确认帧内容）；
// 2. 自环语义：dispatched 与 running 两态的 armed 自环行（D3 回执窗口横跨 engine
//    预备段与执行段）都放行且不迁态；多帧回执（多 schema ask 各一帧）合法；
// 3. 表外 fail-fast：terminal 后迟到的 armed 回执让位（IllegalTransitionError，
//    journal 帧数不变——终局后单写者停止 append 的纪律守卫）；
// 4. 协议 armed 事件 → RunArmedEvent.frame 的载荷直通（引擎上报对象逐字落账）。
//
// journal 目录经 setRunEventJournalDirForTest 注入 mkdtemp 临时目录（测试红线：
// 不触真实数据目录；teardown rmSync 带 maxRetries——F3 flake 纪律）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchRunTrigger, setRunEventJournalDirForTest } from "../worker-message-pump.ts";
import { createRunEventJournal, type WorkflowRunEvent } from "../run-events.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import type { WorkerHandle } from "../worker-handle.ts";

/** journal 读回（scan 走 run-events 唯一实装——写读同源）。 */
function scanRunEvents(dir: string, runId: string): Promise<readonly WorkflowRunEvent[]> {
  return createRunEventJournal(dir).scan(runId);
}

let journalDir: string;

beforeEach(() => {
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-armed-receipt-"));
  setRunEventJournalDirForTest(journalDir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 构造真实 WorkflowRun（与 run-event-dispatch.test 同款装配——真实链路面）。 */
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

/** 协议 armed 事件对象（SDK AgentEvent armed 变体的引擎上报形态）。 */
const ARMED_FRAME = {
  type: "armed",
  schemaEnvVar: "PI_WORKFLOW_SCHEMA",
  extensionPkg: "@zhushanwen/pi-structured-output",
} as const;

describe("armed 回执落账（[D3 协议版 P6] 经 dispatchRunTrigger 真实链路）", () => {
  it("dispatched 态自环：run-created 后（engine 预备段）的 armed 回执落 journal 且不迁态，载荷逐字入 frame", async () => {
    const run = makeRun("wf-armed-dispatched");
    const ts = Date.now();
    await dispatchRunTrigger(run, { type: "run-created", runId: run.runId, workflowName: "review-fix-loop", argsSummary: "{}", ts });

    await dispatchRunTrigger(run, { type: "armed", frame: ARMED_FRAME, ts });

    const events = await scanRunEvents(journalDir, run.runId);
    expect(events.map((e) => e.type)).toEqual(["run-created", "armed"]);
    const armedFrame = events[1] as Extract<WorkflowRunEvent, { type: "armed" }>;
    // 载荷直通：协议 armed 事件对象逐字落账（RunArmedEvent.frame = D3 武装确认帧内容）
    expect(armedFrame.frame).toEqual(ARMED_FRAME);
    expect(armedFrame.ts).toBe(ts);
  });

  it("running 态自环 + 多帧回执：多 schema ask 各一帧全部落账（自环语义允许多帧）", async () => {
    const run = makeRun("wf-armed-running");
    const ts = Date.now();
    await dispatchRunTrigger(run, { type: "run-created", runId: run.runId, workflowName: "review-fix-loop", argsSummary: "{}", ts });
    await dispatchRunTrigger(run, { type: "ask-dispatched", taskIndex: 1, agentName: "reviewer-1", attempt: 1, ts });

    await dispatchRunTrigger(run, { type: "armed", frame: ARMED_FRAME, ts });
    await dispatchRunTrigger(run, { type: "armed", frame: { ...ARMED_FRAME, schemaEnvVar: "OTHER_ENV" }, ts });

    const events = await scanRunEvents(journalDir, run.runId);
    expect(events.map((e) => e.type)).toEqual([
      "run-created",
      "ask-dispatched",
      "armed",
      "armed",
    ]);
    const second = events[3] as Extract<WorkflowRunEvent, { type: "armed" }>;
    expect(second.frame).toEqual({ ...ARMED_FRAME, schemaEnvVar: "OTHER_ENV" });
  });

  it("terminal 后迟到的回执让位（IllegalTransitionError，journal 帧数不变）", async () => {
    const run = makeRun("wf-armed-terminal");
    const ts = Date.now();
    await dispatchRunTrigger(run, { type: "run-created", runId: run.runId, workflowName: "review-fix-loop", argsSummary: "{}", ts });
    await dispatchRunTrigger(run, { type: "run-settled", outcome: "completed", artifactsDir: journalDir, ts });
    const before = await scanRunEvents(journalDir, run.runId);
    expect(before.map((e) => e.type)).toEqual(["run-created", "run-settled"]);

    await expect(
      dispatchRunTrigger(run, { type: "armed", frame: ARMED_FRAME, ts }),
    ).rejects.toThrowError(/非法 run 状态转移/);
    // journal 冻结：终局后单写者停止 append（表 terminal × 任意事件 fail-fast 的
    // 接线侧守卫——迟到回执不得穿透）
    const after = await scanRunEvents(journalDir, run.runId);
    expect(after.map((e) => e.type)).toEqual(["run-created", "run-settled"]);
  });
});
