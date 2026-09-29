// src/orchestration/__tests__/resume-tier-budget.test.ts
//
// [U2] D8 三档恢复（档位判据纯逻辑 + 档 1 补收落帧）与 D10 时间预算活跃段算式
// （纯函数 + pump 账本消费）测试。
//
// D8 档位真实性（场景 22 真机冒烟）归 u4a；本文件锁编排侧判据与补收行为。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyResumeTier,
  classifyResumeTierFromContent,
  computeActiveElapsedMs,
  extractAssistantTextContent,
  resumeRun,
} from "../resume-run.ts";
import {
  forgetRunResumedBudget,
  noteRunResumedBudget,
  rebuildRuntime,
} from "../worker-message-pump.ts";
import {
  resetPhaseSettlementTrackerForTest,
  setRunEventJournalDirForTest,
} from "../terminal-actions.ts";
import { createRunEventJournal } from "../run-events.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import { Budget } from "../models/budget.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";

// ── helpers ──────────────────────────────────────────────────

const T0 = 1_770_000_000_000;
const MIN = 60_000;

/** pi 会话文件行构造器（type=message 形态对齐 pi session JSONL）。 */
function messageLine(role: string, content: unknown, idSeed: number): string {
  return JSON.stringify({ type: "message", id: `e${idSeed}`, parentId: `e${idSeed - 1}`, message: { role, content } });
}

function sessionHeaderLine(): string {
  return JSON.stringify({ type: "session", id: "e0", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" });
}

// ── D8 档位判据（纯逻辑）────────────────────────────────────

describe("D8 档位判据 — classifyResumeTierFromContent", () => {
  it("末轮 assistant 完整（string content）→ 档 1 collect，提取正文", () => {
    const content = [sessionHeaderLine(), messageLine("user", "do it", 1), messageLine("assistant", "final answer", 2)].join("\n");
    expect(classifyResumeTierFromContent(content)).toEqual({
      tier: "collect",
      collectedContent: "final answer",
    });
  });

  it("末轮 assistant 完整（blocks content）→ 档 1 collect：text 块拼接，thinking 排除", () => {
    const blocks = [
      { type: "thinking", thinking: "internal reasoning" },
      { type: "text", text: "part-a" },
      { type: "text", text: "part-b" },
    ];
    const content = [sessionHeaderLine(), messageLine("user", "q", 1), messageLine("assistant", blocks, 2)].join("\n");
    expect(classifyResumeTierFromContent(content)).toEqual({
      tier: "collect",
      collectedContent: "part-apart-b",
    });
  });

  it("末尾悬空 user prompt（请求未完成）→ 档 2 continue", () => {
    const content = [sessionHeaderLine(), messageLine("user", "pending prompt", 1)].join("\n");
    expect(classifyResumeTierFromContent(content)).toEqual({ tier: "continue" });
  });

  it("末尾半截行（写入中断）→ 档 2 continue", () => {
    const content = [sessionHeaderLine(), messageLine("user", "q", 1), '{"type":"message","id":"e2","parentId":"e1","mess'].join("\n");
    expect(classifyResumeTierFromContent(content)).toEqual({ tier: "continue" });
  });

  it("末轮 assistant 纯工具调用（无 text 块）→ 档 2 continue（工具循环中崩溃）", () => {
    const toolOnly = [{ type: "toolCall", id: "tc1", name: "bash", arguments: "{}" }];
    const content = [sessionHeaderLine(), messageLine("user", "q", 1), messageLine("assistant", toolOnly, 2)].join("\n");
    expect(classifyResumeTierFromContent(content)).toEqual({ tier: "continue" });
  });

  it("末尾 toolResult（工具结果后引擎死亡）→ 档 2 continue", () => {
    const content = [
      sessionHeaderLine(),
      messageLine("user", "q", 1),
      messageLine("assistant", [{ type: "toolCall", id: "tc1", name: "bash", arguments: "{}" }], 2),
      messageLine("toolResult", "tool output", 3),
    ].join("\n");
    expect(classifyResumeTierFromContent(content)).toEqual({ tier: "continue" });
  });

  it("尾部 custom 元数据行跳过（subagent-identity 等 parentId=null 非对话流）→ 判定取其前 message", () => {
    const content = [
      sessionHeaderLine(),
      messageLine("user", "q", 1),
      messageLine("assistant", "done text", 2),
      JSON.stringify({ type: "custom", id: "c1", parentId: null, customType: "subagent-identity", data: {} }),
    ].join("\n");
    expect(classifyResumeTierFromContent(content)).toEqual({
      tier: "collect",
      collectedContent: "done text",
    });
  });

  it("仅 header（会话在但从未有回复）→ 档 2 continue", () => {
    expect(classifyResumeTierFromContent(sessionHeaderLine())).toEqual({ tier: "continue" });
  });
});

describe("D8 档位判据 — classifyResumeTier（IO 包装）", () => {
  it("sessionFile 缺省（agent 从未有落定调用）→ 档 3 restart", () => {
    expect(classifyResumeTier(undefined)).toEqual({ tier: "restart" });
  });

  it("读取失败（文件不存在/清理）→ 档 3 restart", () => {
    expect(
      classifyResumeTier("/gone/session.jsonl", () => {
        throw new Error("ENOENT");
      }),
    ).toEqual({ tier: "restart" });
  });
});

describe("D8 提取边界 — extractAssistantTextContent（检查点 8）", () => {
  it("string 直取；空串 → undefined", () => {
    expect(extractAssistantTextContent("hello")).toBe("hello");
    expect(extractAssistantTextContent("")).toBeUndefined();
  });

  it("blocks：text 块拼接；thinking/toolCall 排除；空 → undefined", () => {
    expect(
      extractAssistantTextContent([
        { type: "thinking", thinking: "x" },
        { type: "text", text: "a" },
        { type: "toolCall", name: "bash" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
    expect(extractAssistantTextContent([{ type: "thinking", thinking: "only" }])).toBeUndefined();
    expect(extractAssistantTextContent(42)).toBeUndefined();
  });
});

// ── D8 档 1 补收落帧（编排接线）──────────────────────────────

describe("D8 档 1 补收 — resumeRun 集成", () => {
  let journalDir: string;

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-tier-"));
    setRunEventJournalDirForTest(journalDir);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** in-flight call 的 agent 有既有 settled 帧（sessionFile 可知）→ 可判档。 */
  async function seedWithSessionFile(runId: string): Promise<void> {
    const journal = createRunEventJournal(journalDir);
    await journal.append(runId, {
      type: "run-created",
      runId,
      workflowName: "test-wf",
      argsSummary: "{}",
      scriptSource: "async function execute() {}",
      ts: T0,
    });
    await journal.append(runId, {
      type: "agent-started",
      taskIndex: 0,
      agentName: "worker-a",
      attempt: 1,
      ts: T0 + 1_000,
    });
    await journal.append(runId, {
      type: "agent-settled",
      taskIndex: 0,
      attempt: 1,
      outcome: "done",
      durationMs: 1_000,
      result: { content: "round-1", sessionFile: "/fake/sessions/member-a.jsonl" },
      ts: T0 + 2_000,
    });
    // 同名 agent 第二轮在途（崩溃形态）
    await journal.append(runId, {
      type: "agent-started",
      taskIndex: 1,
      agentName: "worker-a",
      attempt: 1,
      ts: T0 + 3_000,
    });
    await journal.append(runId, {
      type: "run-interrupted",
      errorCode: "crashed",
      ts: T0 + 4_000,
    });
  }

  function makeDeps(): { deps: LifecycleDeps; runs: Map<string, WorkflowRun> } {
    const runs = new Map<string, WorkflowRun>();
    const deps: LifecycleDeps = {
      store: { save: vi.fn(async () => {}), loadAll: vi.fn(async () => []), stateFilePath: vi.fn(() => "") },
      workerHost: {
        start: vi.fn(() => ({ postMessage: vi.fn(), terminate: vi.fn(async () => {}) } as unknown as WorkerHandle)),
      },
      runner: { run: vi.fn(async () => ({ content: "" })) },
      runs,
      appendEntry: vi.fn(),
      eventBus: { emit: vi.fn() },
      onRunDone: vi.fn(),
      log: vi.fn(),
    };
    return { deps, runs };
  }

  it("档 1：补收帧落 record（agent-settled 含提取正文 + sessionFile）+ 回放集含补收 call", async () => {
    await seedWithSessionFile("wf-collect");
    const { deps, runs } = makeDeps();
    const memberSession = [
      sessionHeaderLine(),
      messageLine("user", "round 2 prompt", 1),
      messageLine("assistant", "recovered round-2 answer", 2),
    ].join("\n");

    await resumeRun("wf-collect", deps, {
      now: () => T0 + 100_000,
      readMemberSession: () => memberSession,
    });

    // record：run-resumed 后落补收帧（事实入流，D1）
    const events = await createRunEventJournal(journalDir).scan("wf-collect");
    const types = events.map((e) => e.type);
    expect(types.slice(-2)).toEqual(["run-resumed", "agent-settled"]);
    const collected = events.at(-1) as { taskIndex: number; outcome: string; result: { content: string; sessionFile?: string } };
    expect(collected.taskIndex).toBe(1);
    expect(collected.outcome).toBe("done");
    expect(collected.result.content).toBe("recovered round-2 answer");
    expect(collected.result.sessionFile).toBe("/fake/sessions/member-a.jsonl");
    // 聚合：补收 call 进回放集（worker 重放到断点时零 token 回话）
    const run = runs.get("wf-collect")!;
    expect(run.state.calls.get(1)?.status).toBe("done");
    expect(run.state.calls.get(1)?.result?.content).toBe("recovered round-2 answer");
  });

  it("档 2：末尾悬空 prompt → 不补收（in-flight 留重派，续写经成员复用通道）", async () => {
    await seedWithSessionFile("wf-continue");
    const { deps, runs } = makeDeps();
    const memberSession = [sessionHeaderLine(), messageLine("user", "round 2 prompt", 1)].join("\n");

    await resumeRun("wf-continue", deps, {
      now: () => T0 + 100_000,
      readMemberSession: () => memberSession,
    });

    const events = await createRunEventJournal(journalDir).scan("wf-continue");
    expect(events.filter((e) => e.type === "agent-settled")).toHaveLength(1); // 仅崩溃前的 round-1
    expect(runs.get("wf-continue")!.state.calls.has(1)).toBe(false);
  });
});

// ── D10 活跃段算式（纯函数）──────────────────────────────────

describe("D10 活跃段算式 — computeActiveElapsedMs", () => {
  it("单段：created → 执行事件 → interrupted：活跃 = 末执行事件 − 段首（收编帧不算执行）", () => {
    const events = [
      { type: "run-created", ts: T0, seq: 1 },
      { type: "agent-started", taskIndex: 0, agentName: "a", attempt: 1, ts: T0 + 1 * MIN, seq: 2 },
      { type: "agent-settled", taskIndex: 0, attempt: 1, outcome: "done", durationMs: 1, result: { content: "x" }, ts: T0 + 40 * MIN, seq: 3 },
      { type: "run-interrupted", errorCode: "crashed", ts: T0 + 41 * MIN, seq: 4 },
    ];
    expect(computeActiveElapsedMs(events as never)).toBe(40 * MIN);
  });

  it("跨天 resume（场景 16）：搁置不计——段边界后活跃归零，重开段从 resumed 起", () => {
    const twoDays = 2 * 24 * 60 * MIN;
    const events = [
      { type: "run-created", ts: T0, seq: 1 },
      { type: "agent-started", taskIndex: 0, agentName: "a", attempt: 1, ts: T0 + 5 * MIN, seq: 2 },
      { type: "run-interrupted", errorCode: "crashed", ts: T0 + 5 * MIN + 1000, seq: 3 },
      { type: "run-resumed", ts: T0 + twoDays, seq: 4 }, // 搁置 2 天不计
      { type: "agent-started", taskIndex: 1, agentName: "a", attempt: 1, ts: T0 + twoDays + 2 * MIN, seq: 5 },
      { type: "run-interrupted", errorCode: "crashed", ts: T0 + twoDays + 3 * MIN, seq: 6 },
    ];
    // 段1 = 5min（created→末执行）；段2 = 2min（resumed→末执行）；搁置 2 天零计
    expect(computeActiveElapsedMs(events as never)).toBe(7 * MIN);
  });

  it("复活后立即再崩（段内无执行事件）→ 该段计 0", () => {
    const events = [
      { type: "run-created", ts: T0, seq: 1 },
      { type: "agent-started", taskIndex: 0, agentName: "a", attempt: 1, ts: T0 + 1 * MIN, seq: 2 },
      { type: "run-interrupted", errorCode: "crashed", ts: T0 + 2 * MIN, seq: 3 },
      { type: "run-resumed", ts: T0 + 3 * MIN, seq: 4 },
      { type: "run-interrupted", errorCode: "crashed", ts: T0 + 4 * MIN, seq: 5 },
    ];
    expect(computeActiveElapsedMs(events as never)).toBe(1 * MIN);
  });
});

// ── D10 pump 账本消费（重试路径按活跃段折算，场景 21）────────

describe("D10 pump 账本消费 — rebuildRuntime 计时器重排按剩余活跃预算", () => {
  it("noteRunResumedBudget 后 rebuildRuntime：scheduleTimeBudget 收到 budget −（活跃 + 本段已跑）", () => {
    const runId = "wf-retry-budget";
    const spec = {
      scriptSource: "async function execute() {}",
      args: {},
      scriptName: "w",
      scriptPath: "",
      budgetTimeMs: 60 * MIN,
    };
    const run = new WorkflowRun(
      runId,
      spec,
      {
        status: "running",
        budget: new Budget({ maxTimeMs: 60 * MIN }),
        calls: new Map(),
        trace: new Trace(),
        errorLogs: [],
      },
      { startedAt: new Date(T0).toISOString() },
    );
    const worker = { postMessage: vi.fn(), terminate: vi.fn(async () => {}) } as unknown as WorkerHandle;
    run.assignRuntime(new RunRuntime(worker, new AbortController()));

    const scheduleTimeBudget = vi.fn();
    const deps = {
      store: { save: vi.fn(async () => {}) },
      workerHost: { start: vi.fn(() => worker) },
      runner: { run: vi.fn(async () => ({ content: "" })) },
      runs: new Map(),
      scheduleTimeBudget,
    } as unknown as LifecycleDeps;
    const handlers: WorkerHandlers = {
      onMessage: vi.fn(async () => {}),
      onError: vi.fn(async () => {}),
      onExit: vi.fn(async () => {}),
    };

    try {
      // resume 于「活跃已耗 40min + 本段已跑 5min」→ 剩余 ≈ 15min
      noteRunResumedBudget(runId, 40 * MIN, Date.now() - 5 * MIN);
      rebuildRuntime(run, deps, handlers);
      expect(scheduleTimeBudget).toHaveBeenCalledTimes(1);
      const rescheduled = scheduleTimeBudget.mock.calls[0]![1] as number;
      expect(rescheduled).toBeGreaterThanOrEqual(14 * MIN);
      expect(rescheduled).toBeLessThanOrEqual(15 * MIN);
    } finally {
      forgetRunResumedBudget(runId);
      resetPhaseSettlementTrackerForTest();
    }
  });

  it("forgetRunResumedBudget 后回落 startedAt 墙钟现状算法（非 resume 来源 run 语义保持）", () => {
    const runId = "wf-fallback";
    const spec = {
      scriptSource: "async function execute() {}",
      args: {},
      scriptName: "w",
      scriptPath: "",
      budgetTimeMs: 60 * MIN,
    };
    const run = new WorkflowRun(
      runId,
      spec,
      {
        status: "running",
        budget: new Budget({ maxTimeMs: 60 * MIN }),
        calls: new Map(),
        trace: new Trace(),
        errorLogs: [],
      },
      { startedAt: new Date(Date.now() - 10 * MIN).toISOString() },
    );
    const worker = { postMessage: vi.fn(), terminate: vi.fn(async () => {}) } as unknown as WorkerHandle;
    run.assignRuntime(new RunRuntime(worker, new AbortController()));
    const scheduleTimeBudget = vi.fn();
    const deps = {
      store: { save: vi.fn(async () => {}) },
      workerHost: { start: vi.fn(() => worker) },
      runner: { run: vi.fn(async () => ({ content: "" })) },
      runs: new Map(),
      scheduleTimeBudget,
    } as unknown as LifecycleDeps;

    try {
      noteRunResumedBudget(runId, 1, Date.now());
      forgetRunResumedBudget(runId);
      rebuildRuntime(run, deps, {
        onMessage: vi.fn(async () => {}),
        onError: vi.fn(async () => {}),
        onExit: vi.fn(async () => {}),
      });
      const rescheduled = scheduleTimeBudget.mock.calls[0]![1] as number;
      expect(rescheduled).toBeGreaterThanOrEqual(49 * MIN); // 60 − 10（墙钟）
      expect(rescheduled).toBeLessThanOrEqual(50 * MIN);
    } finally {
      resetPhaseSettlementTrackerForTest();
    }
  });
});
