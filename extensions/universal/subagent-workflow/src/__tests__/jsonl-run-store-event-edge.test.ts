// src/__tests__/jsonl-run-store-event-edge.test.ts
//
// [P3/D6] 事件边沿 flush（快照投影增强）单测。
//
// 锁定的语义：
// - fold 投影：每次 flush 经 core projectRunEvents 从同目录 journal 增量喂入
//   （[W1 / D6] tail offset 续读）——state 投影携带 additive 字段（calls[].startedAt/
//   lastProgressAt、run 级 health、终局 outcome/errorCode）；
// - 无 journal（旧 run 形态）→ 未富集投影（缺省渲染前提，字节面无新键）；
// - 事件边沿防抖合并：窗口内 N 次边沿只触发 1 次 flush（固定窗口，writeFile 计数法
//   ——[W1] 条目通道停写后 flush 计数面收敛到 state 写盘）；
// - fs.watch 真实接线：journal 文件 append（模拟 pump 落账）→ 防抖后 state 文件更新。
//
// 时间：真实 timers + 注入小防抖窗口（eventEdgeDebounceMs: 5）——fake timers 不
// 控制 fs.watch 真实事件与真实 IO，edge 路径统一走 waitFor 轮询；防抖合并的确定性
// 由「同步多次 simulate → 恰好 1 次 flush」的计数断言承载，不依赖时钟速度。
// fs：mkdtemp 自建自删（rmSync 带 recursive/force/maxRetries/retryDelay 红线形态）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Budget } from "@zhushanwen/subagent-core/orchestration/models/budget.ts";
import { Trace } from "@zhushanwen/subagent-core/orchestration/models/trace.ts";
import type { RunSpec } from "@zhushanwen/subagent-core/orchestration/models/run-spec.ts";
import { WorkflowRun } from "@zhushanwen/subagent-core/orchestration/models/workflow-run.ts";
import { JsonlRunStore } from "../jsonl-run-store.ts";

const EDGE_DEBOUNCE_MS = 5;

function makeSpec(): RunSpec {
  return {
    scriptSource: "module.exports = async () => {};",
    args: {},
    scriptName: "test-script",
    scriptPath: "/tmp/test.js",
    description: "test",
  };
}

function makeRun(runId: string, status: "running" | "done" = "running"): WorkflowRun {
  return WorkflowRun.reconstruct(
    runId,
    makeSpec(),
    {
      status,
      // done 快照缺 reason 触发 WorkflowRun I2 不变式错误（codec 拒收）——终态必带
      ...(status === "done" ? { reason: "completed" as const } : {}),
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
}

/** 向 stateDir 的 journal 文件追加一帧（raw JSONL——模拟 core pump 单写者落账）。 */
function appendJournalEvent(tmpDir: string, runId: string, event: Record<string, unknown>): void {
  const journalPath = path.join(tmpDir, "workflow-state", `${runId}.events.jsonl`);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.appendFileSync(journalPath, `${JSON.stringify(event)}\n`, "utf8");
}

function readStateSnapshot(tmpDir: string, runId: string): Record<string, unknown> {
  const content = fs.readFileSync(path.join(tmpDir, "workflow-state", `${runId}.jsonl`), "utf8");
  const lastLine = content.split("\n").filter((l) => l.trim()).at(-1);
  return JSON.parse(lastLine!) as Record<string, unknown>;
}

describe("JsonlRunStore 事件边沿 flush（[P3/D6] + [W1] 停写锚定）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-run-store-edge-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeStore(): JsonlRunStore {
    return new JsonlRunStore({
      sessionDir: tmpDir,
      eventEdgeDebounceMs: EDGE_DEBOUNCE_MS,
    });
  }

  it("fold 投影：journal 事件在 flush 时进入 state 投影（additive 字段）", async () => {
    const store = makeStore();
    const runId = "wf-edge-fold";
    await store.save(makeRun(runId)); // 冷路径首写（此刻无 journal → 未富集）
    let snap = readStateSnapshot(tmpDir, runId);
    let state = snap.state as Record<string, unknown>;
    expect(state.health).toBeUndefined();

    // pump 落账两帧 → 边沿触发防抖 flush
    appendJournalEvent(tmpDir, runId, {
      type: "ask-dispatched", taskIndex: 0, agentName: "a0", attempt: 1, ts: 1000,
    });
    appendJournalEvent(tmpDir, runId, {
      type: "ask-settled", taskIndex: 0, attempt: 1, outcome: "completed", durationMs: 5, ts: 2000,
    });
    store.simulateJournalEdgeForTest(runId);
    await vi.waitFor(
      () => {
        snap = readStateSnapshot(tmpDir, runId);
        state = snap.state as Record<string, unknown>;
        expect(state.health).toBeDefined();
      },
      { timeout: 3000, interval: 5 },
    );
    expect(state.health).toEqual({ lastProgressAt: 2000 });
    const calls = state.calls as Array<Record<string, unknown>>;
    expect(calls).toEqual([]); // 本 run 无 call 条目——fold 不凭空造 calls
    await store.dispose();
  });

  it("终局 fold：run-settled 帧使终局投影携带 outcome/errorCode", async () => {
    const store = makeStore();
    const runId = "wf-edge-terminal";
    appendJournalEvent(tmpDir, runId, {
      type: "run-settled", outcome: "failed", errorCode: "engine_crashed", reason: "boom",
      artifactsDir: "/tmp/wf", ts: 9000,
    });
    await store.save(makeRun(runId, "done")); // 终态冷路径 flush（fold 已含终局帧）

    const snap = readStateSnapshot(tmpDir, runId);
    const state = snap.state as Record<string, unknown>;
    expect(state.outcome).toBe("failed");
    expect(state.errorCode).toBe("engine_crashed");
    expect(state.health).toEqual({ lastProgressAt: 9000 });
    await store.dispose();
  });

  it("边沿防抖合并：窗口内多次边沿只触发 1 次 flush（writeFile 计数法）", async () => {
    // watchJournalEdges: false = 关真实 watcher（防 seam 与真实事件双源各自调度一次——
    // 设计内语义），本用例隔离验证 seam 驱动的防抖合并逻辑。
    // [W1] flush 计数面 = state 写盘（writeFile spy 放行原实现）。
    const store = new JsonlRunStore({
      sessionDir: tmpDir,
      eventEdgeDebounceMs: EDGE_DEBOUNCE_MS,
      watchJournalEdges: false,
    });
    const wfSpy = vi.spyOn(fs.promises, "writeFile");
    const runId = "wf-edge-merge";
    await store.save(makeRun(runId)); // flush #1（冷路径）
    const baseline = wfSpy.mock.calls.length;
    appendJournalEvent(tmpDir, runId, {
      type: "ask-dispatched", taskIndex: 0, agentName: "a0", attempt: 1, ts: 1000,
    });
    store.simulateJournalEdgeForTest(runId);
    store.simulateJournalEdgeForTest(runId);
    store.simulateJournalEdgeForTest(runId); // 窗口内合并
    await vi.waitFor(() => expect(wfSpy.mock.calls.length).toBe(baseline + 1), {
      timeout: 3000, interval: 5,
    });
    // 合并窗口后无第二次边沿 flush（固定窗口不重置 timer，N 次边沿 = 1 次 flush）
    await new Promise((r) => setTimeout(r, EDGE_DEBOUNCE_MS * 4));
    expect(wfSpy.mock.calls.length).toBe(baseline + 1);
    await store.dispose();
  });

  it("fs.watch 真实接线：journal 文件 append（不经测试 seam）触发防抖 flush", async () => {
    const store = makeStore();
    const runId = "wf-edge-watch";
    await store.save(makeRun(runId)); // watcher 惰性开启点（doFlush 后目录必存在）
    // 模拟 core pump 同进程落账：直接 append journal 文件
    appendJournalEvent(tmpDir, runId, {
      type: "ask-dispatched", taskIndex: 0, agentName: "a0", attempt: 1, ts: 1234,
    });
    await vi.waitFor(
      () => {
        const state = readStateSnapshot(tmpDir, runId).state as Record<string, unknown>;
        expect(state.health).toEqual({ lastProgressAt: 1234 });
      },
      { timeout: 5000, interval: 5 },
    );
    await store.dispose();
  });

  it("终局后边沿不触发 flush：activeRuns 已回收（投影已终态，无 flush 意义）", async () => {
    const store = makeStore();
    const wfSpy = vi.spyOn(fs.promises, "writeFile");
    const runId = "wf-edge-done";
    await store.save(makeRun(runId, "done")); // 终态冷路径（activeRuns 不保留）
    const baseline = wfSpy.mock.calls.length;
    appendJournalEvent(tmpDir, runId, {
      type: "ask-dispatched", taskIndex: 0, agentName: "a0", attempt: 1, ts: 1000,
    });
    store.simulateJournalEdgeForTest(runId);
    await new Promise((r) => setTimeout(r, EDGE_DEBOUNCE_MS * 4));
    expect(wfSpy.mock.calls.length).toBe(baseline); // 无新 flush
    await store.dispose();
  });
});
