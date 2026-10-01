// src/orchestration/__tests__/worker-log-persistence.test.ts
//
// [§2.1 errorLogs 持久化 / ADR-0094] 写入侧契约：worker 诊断日志在追加
// run.state.errorLogs 的同时落一条 `worker-log` 事件到 record 流（重启可重建），
// 且活体写入与落账共用同一单点（追加 + 尾部上限裁剪语义一致）。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleWorkerMessage } from "../worker-message-pump.ts";
import { createRunEventJournal } from "../run-events.ts";
import { setRunEventJournalDirForTest } from "../terminal-actions.ts";
import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { WorkerHandle } from "../worker-handle.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-worker-log-"));
  setRunEventJournalDirForTest(tmpDir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeRun(runId: string): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    { scriptName: "test-wf", scriptSource: "agent('hi')", args: {}, scriptPath: "/tmp/test-wf.js" },
    { budget: new Budget(), calls: new Map(), trace: new Trace(), errorLogs: [] },
    { startedAt: new Date().toISOString() },
  );
  run.assignRuntime(new RunRuntime(
    { postMessage: vi.fn(), terminate: vi.fn(async () => {}) } as unknown as WorkerHandle,
    new AbortController(),
  ));
  return run;
}

function makeDeps(): LifecycleDeps {
  return {
    store: { save: vi.fn(async () => {}) },
    workerHost: { start: vi.fn() },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    log: vi.fn(),
  } as unknown as LifecycleDeps;
}

function makeHandlers(): WorkerHandlers {
  return { onMessage: vi.fn(async () => {}), onError: vi.fn(async () => {}), onExit: vi.fn(async () => {}) } as unknown as WorkerHandlers;
}

async function scanLogs(runId: string) {
  const events = await createRunEventJournal(tmpDir).scan(runId);
  return events.filter((e) => e.type === "worker-log");
}

describe("worker 诊断日志落账（ADR-0094）", () => {
  it("主线程 log 消息：入 errorLogs 且落一条 worker-log 事件", async () => {
    const run = makeRun("wf-log-1");
    await handleWorkerMessage(run, { type: "log", message: "step 1 done", phase: "p" }, makeDeps(), makeHandlers());
    expect(run.state.errorLogs).toEqual([{ level: "log", message: "step 1 done" }]);
    const logged = await scanLogs("wf-log-1");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.entry).toEqual({ level: "log", message: "step 1 done" });
  });

  it("workerLogs 随 return 消息回带：每条各落一帧（顺序保持）", async () => {
    const run = makeRun("wf-log-2");
    await handleWorkerMessage(
      run,
      { type: "return", result: { ok: true }, workerLogs: [{ level: "warn", message: "w1" }, { level: "error", message: "e1" }] },
      makeDeps(),
      makeHandlers(),
    );
    expect(run.state.errorLogs.map((l) => l.message)).toEqual(["w1", "e1"]);
    const logged = await scanLogs("wf-log-2");
    expect(logged.map((e) => e.entry.message)).toEqual(["w1", "e1"]);
  });

  it("非诊断消息不产生 worker-log 帧（agent-call 只走 run 事件）", async () => {
    const run = makeRun("wf-log-3");
    await handleWorkerMessage(run, { type: "log", message: "only" }, makeDeps(), makeHandlers());
    await handleWorkerMessage(run, { type: "return", result: { ok: true } }, makeDeps(), makeHandlers());
    expect(await scanLogs("wf-log-3")).toHaveLength(1);
  });


});
