// src/orchestration/__tests__/resume-tier-budget.test.ts
//
// [U2] D10 时间预算活跃段算式（纯函数）测试 +
// [ADR-0092]「恢复不补收未提交结果」的回归锁（原 D8 三档判据已随该条删除）。
// [ADR-0122] 原「D10 pump 账本消费」describe 随重试矩阵删除（账本 + rebuildRuntime 已删）。
//
// 文件名保留历史名（原为「tier 判据 + 预算」双主题）；档位真实性冒烟归场景 22。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeActiveElapsedMs, resumeRun } from "../resume-run.ts";
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

describe("[ADR-0092] 恢复不补收未提交结果 — resumeRun 集成", () => {
  let journalDir: string;

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-tier-"));
    setRunEventJournalDirForTest(journalDir);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 同名 agent 第一轮已落定（携带会话文件路径）、第二轮在途即崩溃。 */
  async function seedSecondRoundInFlight(runId: string, sessionFile: string): Promise<void> {
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
      result: { content: "round-1", sessionFile },
      ts: T0 + 2_000,
    });
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

  it("会话文件里有完整正文也不补收：只落 run-resumed，调用留重派集", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-member-"));
    try {
      // 旧实装会读这份文件、按「末轮 assistant 有正文」判档 1 并合成补收帧；
      // [ADR-0092] 后恢复链不再读取它，结果只来自已提交。
      const sessionFile = path.join(sessionDir, "member-a.jsonl");
      fs.writeFileSync(
        sessionFile,
        `${sessionHeaderLine()}\n${messageLine("user", "round 2 prompt", 1)}\n${messageLine("assistant", "recovered round-2 answer", 2)}\n`,
        "utf8",
      );
      await seedSecondRoundInFlight("wf-nocollect", sessionFile);
      const { deps, runs } = makeDeps();

      await resumeRun("wf-nocollect", deps, { now: () => T0 + 100_000 });

      const events = await createRunEventJournal(journalDir).scan("wf-nocollect");
      expect(events.map((e) => e.type).slice(-1)).toEqual(["run-resumed"]);
      expect(events.filter((e) => e.type === "agent-settled")).toHaveLength(1); // 仅崩溃前那一条
      expect(String((events.at(-1) as { reason?: string }).reason ?? "")).toBe("resume plan: replay=1 redispatch=1");
      // 未完成调用不建条目（留重派集：worker 重放到断点后重新派发）
      expect(runs.get("wf-nocollect")!.state.calls.has(1)).toBe(false);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("会话文件不存在同样不影响：恢复链不再读取它", async () => {
    await seedSecondRoundInFlight("wf-missing-file", path.join(os.tmpdir(), "does-not-exist-member.jsonl"));
    const { deps, runs } = makeDeps();

    await resumeRun("wf-missing-file", deps, { now: () => T0 + 100_000 });

    const events = await createRunEventJournal(journalDir).scan("wf-missing-file");
    expect(events.filter((e) => e.type === "agent-settled")).toHaveLength(1);
    expect(runs.get("wf-missing-file")!.state.calls.has(1)).toBe(false);
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
