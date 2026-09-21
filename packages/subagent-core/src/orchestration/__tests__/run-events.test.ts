// run-events.test.ts —— run 事件词表与判别联合的类型层测试（设计 §3.3 D5）。
//
// 覆盖：
// - 词表断言：RUN_EVENT_TYPES 恰好 7 个（无 world-run 族——taiji 脚本 API 面无
//   子进程调用通道）；ALL_RUN_OUTCOMES 三态正交
// - 判别联合 exhaustive：switch 全 7 分支、无 default 吞噬（never 穷尽性断言——
//   编译期由 tsc --noEmit 把关，运行期用样本事件核对分支映射）
// - 载荷形状：7 类样本事件逐字段断言（ask-settled / run-settled 各含成功与失败
//   两形态）
// - journal 接口形态：最小内存 fake 验证 append/scan 可实现且调用形状成立
//   （实装归 journal 单元——本测试零文件 IO，无临时目录需求）
import { describe, expect, it } from "vitest";

import {
  ALL_RUN_OUTCOMES,
  RUN_EVENT_TYPES,
  type AskSettledEvent,
  type RunErrorCode,
  type RunEventJournal,
  type WorkflowRunEvent,
} from "../run-events.ts";

// ── 样本事件（覆盖全部 7 个 type；路径值均为 fixture 假路径）────

const TS = 1_758_000_000_000;

const runCreated: WorkflowRunEvent = {
  type: "run-created",
  ts: TS,
  runId: "wf-1758-a1",
  workflowName: "review-fix-loop",
  argsSummary: '{"pr":"#123"}',
};

const askDispatched: WorkflowRunEvent = {
  type: "ask-dispatched",
  ts: TS + 10,
  taskIndex: 0,
  agentName: "reviewer-security",
  attempt: 1,
};

const askExecuting: WorkflowRunEvent = {
  type: "ask-executing",
  ts: TS + 20,
  taskIndex: 0,
  agentName: "reviewer-security",
  attempt: 1,
};

const askRetrying: WorkflowRunEvent = {
  type: "ask-retrying",
  ts: TS + 30_000,
  taskIndex: 0,
  attempt: 1,
  backoffMs: 1000,
  reason: "provider 503",
};

const askSettledFailed: AskSettledEvent = {
  type: "ask-settled",
  ts: TS + 51_000,
  taskIndex: 0,
  attempt: 2,
  outcome: "failed",
  errorCode: "engine_crashed",
  durationMs: 21_000,
  stderrTeePath: "/journal-fixture/wf-1758-a1/ask-0-attempt-2.stderr.log",
};

const askSettledCompleted: AskSettledEvent = {
  type: "ask-settled",
  ts: TS + 120_000,
  taskIndex: 1,
  attempt: 1,
  outcome: "completed",
  durationMs: 65_000,
};

const armed: WorkflowRunEvent = {
  type: "armed",
  ts: TS + 5,
  frame: { engine: "pi", armed: true },
};

const runSettledFailed: WorkflowRunEvent = {
  type: "run-settled",
  ts: TS + 180_000,
  outcome: "failed",
  errorCode: "engine_crashed",
  reason: "all ask waves failed",
  artifactsDir: "/journal-fixture/wf-1758-a1",
};

const runSettledCompleted: WorkflowRunEvent = {
  type: "run-settled",
  ts: TS + 240_000,
  outcome: "completed",
  artifactsDir: "/journal-fixture/wf-1758-a1",
};

// ── 穷尽性处理样例 ────────────────────────────────────────────

/**
 * switch 覆盖全部 7 个 type 且无 default 分支——switch 之后 event 只剩 never，
 * 对其赋值即穷尽性断言：词表新增成员时该行编译失败（tsc 把关），强制同步扩展
 * 本处理样例。返回分支标记供运行期核对样本事件各命中唯一分支。
 */
function labelOf(event: WorkflowRunEvent): string {
  switch (event.type) {
    case "run-created":
      return `run-created:${event.workflowName}`;
    case "ask-dispatched":
      return `ask-dispatched:${event.taskIndex}:${event.attempt}`;
    case "ask-executing":
      return `ask-executing:${event.taskIndex}:${event.attempt}`;
    case "ask-retrying":
      return `ask-retrying:${event.taskIndex}:${event.backoffMs}`;
    case "ask-settled":
      return `ask-settled:${event.outcome}:${event.errorCode ?? "none"}`;
    case "armed":
      return "armed";
    case "run-settled":
      return `run-settled:${event.outcome}:${event.errorCode ?? "none"}`;
  }
  const _exhaustive: never = event;
  return _exhaustive;
}

// ── 词表 ─────────────────────────────────────────────────────

describe("事件词表（D5）", () => {
  it("RUN_EVENT_TYPES 恰好 7 个成员（无 world-run 族——脚本 API 面无子进程调用通道）", () => {
    expect(RUN_EVENT_TYPES).toEqual([
      "run-created",
      "ask-dispatched",
      "ask-executing",
      "ask-retrying",
      "ask-settled",
      "armed",
      "run-settled",
    ]);
  });

  it("ALL_RUN_OUTCOMES 三态正交（completed / failed / cancelled）", () => {
    expect(ALL_RUN_OUTCOMES).toEqual(["completed", "failed", "cancelled"]);
  });

  it("RunErrorCode 承载两族既有词表（编译期赋值由 tsc 把关）", () => {
    // 引擎固定码 + engine_ 前缀透传码 + 失败分类（classifyFailureKind 词表）
    const codes: RunErrorCode[] = [
      "engine_crashed",
      "engine_probe_failed",
      "engine_custom_future",
      "stale_context",
      "schema_deterministic",
      "unknown",
    ];
    expect(codes).toHaveLength(6);
  });
});

// ── 判别联合穷尽性 ───────────────────────────────────────────

describe("判别联合 exhaustive（无 default 吞噬）", () => {
  it("7 类样本事件各命中唯一分支，标记与预期一致", () => {
    const samples: WorkflowRunEvent[] = [
      runCreated,
      askDispatched,
      askExecuting,
      askRetrying,
      askSettledFailed,
      armed,
      runSettledFailed,
    ];
    expect(samples.map(labelOf)).toEqual([
      "run-created:review-fix-loop",
      "ask-dispatched:0:1",
      "ask-executing:0:1",
      "ask-retrying:0:1000",
      "ask-settled:failed:engine_crashed",
      "armed",
      "run-settled:failed:engine_crashed",
    ]);
  });

  it("样本事件 type 全部落在词表内（词表与联合成员一致）", () => {
    const samples: WorkflowRunEvent[] = [
      runCreated,
      askDispatched,
      askExecuting,
      askRetrying,
      askSettledFailed,
      askSettledCompleted,
      armed,
      runSettledFailed,
      runSettledCompleted,
    ];
    expect(new Set(samples.map((e) => e.type))).toEqual(new Set(RUN_EVENT_TYPES));
  });
});

// ── 载荷形状 ─────────────────────────────────────────────────

describe("载荷形状（D5 载荷表）", () => {
  it("run-created：runId / workflowName / argsSummary / model 引用", () => {
    expect(runCreated).toEqual({
      type: "run-created",
      ts: TS,
      runId: "wf-1758-a1",
      workflowName: "review-fix-loop",
      argsSummary: '{"pr":"#123"}',
    });
  });

  it("ask-dispatched / ask-executing：agentName / attempt / taskIndex", () => {
    expect(askDispatched).toEqual({
      type: "ask-dispatched",
      ts: TS + 10,
      taskIndex: 0,
      agentName: "reviewer-security",
      attempt: 1,
    });
    expect(askExecuting).toEqual({
      type: "ask-executing",
      ts: TS + 20,
      taskIndex: 0,
      agentName: "reviewer-security",
      attempt: 1,
    });
  });

  it("ask-retrying：attempt / backoffMs / reason", () => {
    expect(askRetrying).toEqual({
      type: "ask-retrying",
      ts: TS + 30_000,
      taskIndex: 0,
      attempt: 1,
      backoffMs: 1000,
      reason: "provider 503",
    });
  });

  it("ask-settled 失败形态：outcome / errorCode / durationMs + 诊断引用（stderrTeePath）", () => {
    expect(askSettledFailed).toEqual({
      type: "ask-settled",
      ts: TS + 51_000,
      taskIndex: 0,
      attempt: 2,
      outcome: "failed",
      errorCode: "engine_crashed",
      durationMs: 21_000,
      stderrTeePath: "/journal-fixture/wf-1758-a1/ask-0-attempt-2.stderr.log",
    });
  });

  it("ask-settled 成功形态：errorCode / stderrTeePath 缺省", () => {
    expect(askSettledCompleted).toEqual({
      type: "ask-settled",
      ts: TS + 120_000,
      taskIndex: 1,
      attempt: 1,
      outcome: "completed",
      durationMs: 65_000,
    });
  });

  it("armed：武装确认帧内容占位（frame）", () => {
    expect(armed).toEqual({
      type: "armed",
      ts: TS + 5,
      frame: { engine: "pi", armed: true },
    });
  });

  it("run-settled 失败形态：outcome / errorCode / reason / artifactsDir", () => {
    expect(runSettledFailed).toEqual({
      type: "run-settled",
      ts: TS + 180_000,
      outcome: "failed",
      errorCode: "engine_crashed",
      reason: "all ask waves failed",
      artifactsDir: "/journal-fixture/wf-1758-a1",
    });
  });

  it("run-settled 成功形态：errorCode / reason 缺省，artifactsDir 恒在", () => {
    expect(runSettledCompleted).toEqual({
      type: "run-settled",
      ts: TS + 240_000,
      outcome: "completed",
      artifactsDir: "/journal-fixture/wf-1758-a1",
    });
  });
});

// ── journal 接口形态 ─────────────────────────────────────────

describe("RunEventJournal 接口形态（仅类型签名——实装归 journal 单元）", () => {
  it("append / scan 可实现且调用形状成立（内存 fake，零文件 IO）", async () => {
    const store = new Map<string, WorkflowRunEvent[]>();
    const journal: RunEventJournal = {
      append: async (runId, event) => {
        const list = store.get(runId) ?? [];
        list.push(event);
        store.set(runId, list);
      },
      scan: async (runId) => store.get(runId) ?? [],
    };

    await journal.append("wf-1758-a1", runCreated);
    await journal.append("wf-1758-a1", askRetrying);
    await journal.append("wf-1758-a1", runSettledFailed);

    await expect(journal.scan("wf-1758-a1")).resolves.toEqual([
      runCreated,
      askRetrying,
      runSettledFailed,
    ]);
    await expect(journal.scan("wf-other")).resolves.toEqual([]);
  });
});
