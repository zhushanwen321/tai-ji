/**
 * [D1] 壳 store 判终局唯一判法（record fold）行为锚。
 *
 * 锁定的语义（设计 workflow-run-resume-revision 目标 2「判读单一」）：
 * 1. **终局判定单源**：settledRecordOf 只读 record 流 run-settled 帧（fold 尾向
 *    扫描）——无第二判据（state 快照已删，条目不参与终局判读）；
 * 2. **流不在场 = 未终局**（undefined，ENOENT 静默 miss——正常形态）；
 * 3. **流损坏 = 保守 miss + warn**（通知链不是恢复面；恢复面的拒绝语义在
 *    loadAll，见 record-mode 场景 18 用例）;
 * 4. **零快照写面**：save（终局前后）不产生任何 state 投影文件——磁盘上唯一
 *    持久件 = record 流。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { Budget, Trace, WorkflowRun } from "@zhushanwen/subagent-core";
import { RUN_EVENTS_SUFFIX } from "@zhushanwen/subagent-core";

import { JsonlRunStore } from "../jsonl-run-store.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-settled-routing-"));
  loggerMock.warn.mockClear();
  loggerMock.debug.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.restoreAllMocks();
});

function makeRun(runId: string): WorkflowRun {
  return WorkflowRun.reconstruct(
    runId,
    { scriptSource: "agent('x')", args: {}, scriptName: "sig-wf", scriptPath: "/tmp/x.js" },
    {
      status: "running",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
}

function recordPath(runId: string): string {
  return path.join(tmpDir, "workflow-state", `${runId}${RUN_EVENTS_SUFFIX}`);
}

function appendRecordLine(runId: string, event: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(recordPath(runId)), { recursive: true });
  fs.appendFileSync(recordPath(runId), `${JSON.stringify(event)}\n`, "utf8");
}

describe("壳 store 判终局唯一判法（[D1] record fold）", () => {
  it("record 流 run-settled 帧 → settledRecordOf 载荷直取（outcome/errorCode/reason/settledAt）", async () => {
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const ts = Date.now() - 1000;
    appendRecordLine("wf-route-settled", {
      type: "run-settled",
      seq: 4,
      ts,
      outcome: "failed",
      errorCode: "budget_limited",
      reason: "budget exhausted",
      artifactsDir: tmpDir,
    });

    expect(store.settledRecordOf("wf-route-settled")).toEqual({
      outcome: "failed",
      errorCode: "budget_limited",
      reason: "budget exhausted",
      settledAt: ts,
    });
    await store.dispose();
  });

  it("流不在场 / 流无 settled 帧 → undefined（未终局，零 warn——正常形态）", async () => {
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    expect(store.settledRecordOf("wf-route-missing")).toBeUndefined();
    // 在场但无终局帧：running run 的 record 流
    appendRecordLine("wf-route-running", { type: "run-created", seq: 1, ts: Date.now(), runId: "wf-route-running", workflowName: "t", argsSummary: "{}" });
    expect(store.settledRecordOf("wf-route-running")).toBeUndefined();
    expect(loggerMock.warn).not.toHaveBeenCalled();
    await store.dispose();
  });

  it("流损坏 → 保守 miss + warn 留证（通知链降级；恢复面拒绝语义在 loadAll）", async () => {
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    fs.mkdirSync(path.dirname(recordPath("wf-route-broken")), { recursive: true });
    fs.writeFileSync(recordPath("wf-route-broken"), "{not-json\n", "utf8");

    expect(store.settledRecordOf("wf-route-broken")).toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(String(loggerMock.warn.mock.calls[0]?.[0])).toContain("record stream read failed");
    await store.dispose();
  });

  it("零快照写面：终局前后 save 均不产生 state 投影文件（磁盘唯一持久件 = record 流）", async () => {
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const run = makeRun("wf-route-nosnap");

    await store.save(run); // running
    appendRecordLine(run.runId, { type: "run-settled", seq: 1, ts: Date.now(), outcome: "completed", artifactsDir: tmpDir });
    await store.save(run); // 终局后再 save

    const stateDirFiles = fs.readdirSync(path.join(tmpDir, "workflow-state"));
    expect(stateDirFiles).toEqual([`${run.runId}${RUN_EVENTS_SUFFIX}`]); // 无 <runId>.jsonl
    // stateFilePath 指向 record 流（唯一持久件指针）
    expect(store.stateFilePath(run.runId)).toBe(recordPath(run.runId));
    await store.dispose();
  });
});
