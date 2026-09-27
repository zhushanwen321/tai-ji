// src/__tests__/jsonl-run-store-finality-reconciliation.test.ts
//
// loadAll 终局调和（reconcileRunningFinality——[W1 / D4/D7] v1 兼容层）定向用例。
//
// 防的 bug（两个已证实的误判面，兼容层语义保持）：
// 1. journal run-settled 终局先于终态 entry 落账（pump 落账顺序 + 终态 entry
//    best-effort 不重试）——实际 completed 的 run 崩溃恢复后被误标 failed；
// 2. idle-GC（core FileRunStore 通道）终局化只写 state 文件不改 entry——resume 后
//    恢复链从 entry 读到 running 再次转 failed，覆盖 GC 终局。
//
// [W1] 分流锚定：本调和只服务 v1 快照 entry 定界的实体；v2 实体的终局核对 =
// journal 投影本身（rebuildRunsFromJournals，见 session-file 件 v2 用例）。
//
// 场景构造纪律：v1 entry 一律经「真实 toRunSnapshot codec + 存量 v1 信封」夹具产出
// （W1 起壳侧停写该形态——夹具是兼容读面的唯一产出方式）；journal 帧按
// isWorkflowRunEventLine 的最小形状手写（type/ts/outcome 落词表）；state 文件的
// 旁路终局（GC 通道）经「无 pi 的第二个 store save 同一 run」模拟。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CustomEntry } from "@earendil-works/pi-coding-agent";

import { Budget } from "@zhushanwen/subagent-core";
import { Trace } from "@zhushanwen/subagent-core";
import type { ExecutionTraceNode } from "@zhushanwen/subagent-core";
import type { RunSpec } from "@zhushanwen/subagent-core";
import { WorkflowRun } from "@zhushanwen/subagent-core";
import { toRunSnapshot, WORKFLOW_RECORD_CUSTOM_TYPE } from "@zhushanwen/subagent-core";
import { JsonlRunStore } from "../jsonl-run-store.ts";
import { mkCtx } from "@zhushanwen/subagent-core/testing/orchestration/__tests__/test-mocks.ts";

function makeSpec(): RunSpec {
  return {
    scriptSource: "module.exports = async () => {};",
    args: {},
    scriptName: "test-script",
    scriptPath: "/tmp/test.js",
    description: "test",
  };
}

function makeTraceNode(stepIndex: number): ExecutionTraceNode {
  return { stepIndex, agent: "worker", task: "do thing", model: "default", status: "pending" };
}

function makeRunningRun(runId: string): WorkflowRun {
  const trace = new Trace();
  trace.append(makeTraceNode(0));
  return WorkflowRun.reconstruct(runId, makeSpec(), {
    status: "running",
    budget: new Budget(),
    calls: new Map(),
    trace,
    errorLogs: [],
  }, { startedAt: new Date().toISOString() });
}

/**
 * [W1 / D7] 手工构造 v1 快照 entry（兼容层夹具，running 形态）：W1 起壳侧停写该
 * 形态，兼容读面只能由夹具喂入。
 */
function v1RunningEntry(run: WorkflowRun): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: {
      v: 1,
      snapshot: toRunSnapshot(run),
      updatedAt: new Date().toISOString(),
    },
    id: `seed-v1-${run.runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** journal run-settled 帧（isWorkflowRunEventLine 最小形状：type/ts/outcome 落词表）。 */
function settledLine(outcome: "completed" | "failed" | "cancelled", extra?: Record<string, unknown>): string {
  return JSON.stringify({ type: "run-settled", ts: Date.now(), outcome, artifactsDir: "/tmp/wf", ...extra });
}

describe("loadAll 终局调和（v1 兼容层）：journal settled 帧 / state 文件旁路终局", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-finality-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("A1 completed：entry 仍 running 但 journal 已有 run-settled(completed) → 采纳 completed，不被恢复链误标 failed", async () => {
    // entry 通路：v1 夹具 running entry（W1 起壳 save 不产 entry——夹具喂入）
    const run = makeRunningRun("run-recon-a");
    const entries: CustomEntry[] = [v1RunningEntry(run)];

    // journal 通路：终局帧已落账、终态 entry 未写（pump 落账顺序窗口 / 终态 entry 写失败）
    const journalPath = path.join(tmpDir, "workflow-state", "run-recon-a.events.jsonl");
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, `${settledLine("completed")}\n`, "utf8");

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.state.status).toBe("done");
    expect(loaded[0]!.state.reason).toBe("completed");
    expect(loaded[0]!.state.error).toBeUndefined(); // 成功终局无 error
  });

  it("A1 failed：journal run-settled(failed, errorCode) → 采纳 failed 且 reason/error 保真（不落 generic kill-9 文案）", async () => {
    const run = makeRunningRun("run-recon-b");
    const entries: CustomEntry[] = [v1RunningEntry(run)];

    const journalPath = path.join(tmpDir, "workflow-state", "run-recon-b.events.jsonl");
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(
      journalPath,
      `${settledLine("failed", { errorCode: "engine_crashed", reason: "worker exited code 1" })}\n`,
      "utf8",
    );

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded[0]!.state.status).toBe("done");
    expect(loaded[0]!.state.reason).toBe("failed");
    expect(loaded[0]!.state.error).toBe("worker exited code 1");
  });

  it("A1 cancelled：journal run-settled(cancelled) → DoneReason 归位 aborted", async () => {
    const run = makeRunningRun("run-recon-c");
    const entries: CustomEntry[] = [v1RunningEntry(run)];

    const journalPath = path.join(tmpDir, "workflow-state", "run-recon-c.events.jsonl");
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, `${settledLine("cancelled")}\n`, "utf8");

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded[0]!.state.status).toBe("done");
    expect(loaded[0]!.state.reason).toBe("aborted");
  });

  it("A2 GC 旁路：journal 无 settled + state 文件被旁路终局化（done,time_limited）→ 采纳 state 终局", async () => {
    // entry 通路：v1 夹具 running entry；随后旁路 store（无 pi——FileRunStore 等价
    // 形态）把同一 run 终局化后写 state 文件：entry 保持 running、state 是 done,time_limited
    const run = makeRunningRun("run-recon-d");
    const entries: CustomEntry[] = [v1RunningEntry(run)];
    run.transition("done", "time_limited");
    run.state.error = "idle GC: run exceeded retention window";
    const sidecar = new JsonlRunStore({ sessionDir: tmpDir });
    await sidecar.save(run);

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded[0]!.state.status).toBe("done");
    expect(loaded[0]!.state.reason).toBe("time_limited");
    expect(loaded[0]!.state.error).toBe("idle GC: run exceeded retention window");
  });

  it("无终局证据（journal 缺 / state 同为 running）→ 保持 running 交恢复链收编（调和不越权）", async () => {
    const run = makeRunningRun("run-recon-e");
    const entries: CustomEntry[] = [v1RunningEntry(run)];
    // 写 running state 文件（save 通路）但不写 journal——entry 与 state 都是 running
    const sidecar = new JsonlRunStore({ sessionDir: tmpDir });
    await sidecar.save(run);

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded[0]!.state.status).toBe("running");
  });

  it("journal 有非终局帧（ask-settled）不触发调和——只认 run-settled", async () => {
    const run = makeRunningRun("run-recon-f");
    const entries: CustomEntry[] = [v1RunningEntry(run)];

    const journalPath = path.join(tmpDir, "workflow-state", "run-recon-f.events.jsonl");
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(
      journalPath,
      `${JSON.stringify({ type: "ask-settled", ts: Date.now(), outcome: "completed" })}\n`,
      "utf8",
    );

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded[0]!.state.status).toBe("running");
  });
});
