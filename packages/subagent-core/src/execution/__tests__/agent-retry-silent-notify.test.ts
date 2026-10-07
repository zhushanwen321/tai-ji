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
//      dispatchAgentSettled 静默返回——agent-settled / run-settled 帧只在终局后落账
//      （守卫为防御面，现网调用点在 markDone 之后）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  setRunEventJournalDirForTest,
} from "../../orchestration/terminal-actions.ts";
import {
  dispatchAgentSettled,
} from "../../orchestration/terminal-actions.ts";
import { executeAgentCall } from "../../orchestration/execute-agent-call.ts";
import { AgentCall } from "../../orchestration/models/agent-call.ts";
import { Budget } from "../../orchestration/models/budget.ts";
import { RunRuntime } from "../../orchestration/models/run-runtime.ts";
import { Trace } from "../../orchestration/models/trace.ts";
import type { AgentResult } from "../../orchestration/models/types.ts";
import { WorkflowRun } from "../../orchestration/models/workflow-run.ts";
import type { WorkerHandle } from "../../orchestration/worker-handle.ts";
import { createRunEventJournal } from "../../orchestration/run-events.ts";

// ── harness ──────────────────────────────────────────────────

let journalDir: string;

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), "wf-retry-silent-"));
  setRunEventJournalDirForTest(journalDir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  rmSync(journalDir, { recursive: true, maxRetries: 5, retryDelay: 20 });
});

/** 构造 running 态真实 WorkflowRun（dispatchAgentSettled 的 journal 归属键）。 */
function makeRealRun(runId: string): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptName: "retry-silent-wf",
      scriptSource: "agent('hi')",
      args: {},
      scriptPath: "/tmp/retry-silent.js",
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

/** flush 微任务队列（void dispatchRunTrigger 的 async 链推进到稳定态）。 */
async function flushMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    // eslint-disable-next-line no-await-in-loop -- 排空微任务队列的固定 tick 循环，非逐项等待
    await Promise.resolve();
  }
}

// ── 反向面 1：重试等待期零终局信号 ─────────────────────────────

describe("agent 失败重试期零通知（D7 反向面）", () => {
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
    await flushMicrotasks();

    const journal = createRunEventJournal(journalDir);
    // 零 agent-settled / run-settled 帧——终局 journal 帧（终局通知的单点判定源）
    // 只在 markDone 后落账，重试期结构性静默。
    await expect(journal.scan(run.runId)).resolves.toHaveLength(0);
  });
});
