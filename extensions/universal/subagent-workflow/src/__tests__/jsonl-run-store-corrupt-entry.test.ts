// src/__tests__/jsonl-run-store-corrupt-entry.test.ts
//
// [SO-DATA-2] collectRecordRun 的 per-entry 隔离：1 条残缺 workflow-record entry
// 不得让整个 loadAll 返回空。
//
// 防的 bug：deserializeRun 在 v guard 之后直接读 snapshot.state.budget 等嵌套字段，
// 残缺 entry（截断/手改/跨版本半写）抛 TypeError 会沿 collectEntrySources 穿透
// loadAll 的 catch → 返回空——单条损坏让全部 run 不可见（读序优先 entry，state
// 文件兜底也不再走）。修复：collectRecordRun 单条 try/catch，损坏 entry 跳过 +
// logger.warn 留证（含 entry 索引与原因），其余 entry 正常重建。
//
// 好坏对照：2 条好 entry 经真实 save 通路产出（快照形态可信，与
// jsonl-run-store-loadall-sources.test.ts 同一搭建方式），1 条坏 entry 手工构造
//（模拟损坏正是本用例的目的——绕开 schema 契约即 corruption 的本质）。

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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { CustomEntry } from "@earendil-works/pi-coding-agent";

import { Budget } from "@zhushanwen/subagent-core";
import { Trace } from "@zhushanwen/subagent-core";
import type { RunSpec } from "@zhushanwen/subagent-core";
import type { ExecutionTraceNode } from "@zhushanwen/subagent-core";
import { WorkflowRun } from "@zhushanwen/subagent-core";
// SNAPSHOT_VERSION 随 c721646f1 codec 迁 core 后壳模块不再 re-export，改从 barrel 消费
import { SNAPSHOT_VERSION } from "@zhushanwen/subagent-core";
import { JsonlRunStore, WORKFLOW_RECORD_CUSTOM_TYPE } from "../jsonl-run-store.ts";
import { mkCtx, mkPi } from "@zhushanwen/subagent-core/testing/orchestration/__tests__/test-mocks.ts";

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

/** running → done 的完整生命周期 save（终态快照可被 deserializeRun 重建）。 */
async function saveDoneRun(
  sessionDir: string,
  entries: CustomEntry[],
  runId: string,
): Promise<void> {
  const store = new JsonlRunStore({ sessionDir, pi: mkPi(entries) });
  const run = makeRunningRun(runId);
  await store.save(run);
  run.transition("done", "completed");
  await store.save(run);
}

/** 手工构造残缺 record entry：v1 guard 通过，但 snapshot.state 缺全部必读嵌套字段
 *  → deserializeRun 读 snapshot.state.budget.maxTokens 抛 TypeError。 */
function corruptRecordEntry(runId: string): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: {
      v: 1,
      snapshot: { v: SNAPSHOT_VERSION, runId, state: {} },
      updatedAt: new Date().toISOString(),
    },
    id: `seed-corrupt-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

describe("SO-DATA-2: 残缺 record entry 的 per-entry 隔离", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-corrupt-entry-"));
    loggerMock.warn.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("3 条 entry（2 好 1 坏）→ 返回 2 条 + warn 留证（含 entry 索引与原因）", async () => {
    const entries: CustomEntry[] = [];
    await saveDoneRun(tmpDir, entries, "run-a");
    await saveDoneRun(tmpDir, entries, "run-b");
    const corrupt = corruptRecordEntry("run-corrupt");
    const seedEntries: CustomEntry[] = [...entries, corrupt];

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(seedEntries) });
    const loaded = await store.loadAll();

    // 损坏 entry 只跳过自身，其余 run 全部可见
    expect(loaded.map((r) => r.runId).sort()).toEqual(["run-a", "run-b"]);
    // warn 留证：entry 索引 + 损坏原因
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const warnMsg = String(loggerMock.warn.mock.calls[0]?.[0] ?? "");
    expect(warnMsg).toContain(`entry #${seedEntries.indexOf(corrupt)}`);
    expect(warnMsg).toContain("corrupted");
  });

  it("全部 entry 均损坏 → 返回空（不再抛 TypeError 穿透）+ 每条各留一条 warn", async () => {
    const seedEntries: CustomEntry[] = [
      corruptRecordEntry("run-corrupt-1"),
      corruptRecordEntry("run-corrupt-2"),
    ];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(seedEntries) });
    const loaded = await store.loadAll();
    expect(loaded).toEqual([]);
    expect(loggerMock.warn).toHaveBeenCalledTimes(2);
  });

  it("损坏 entry 位于同 runId 好 entry 之前 → 后写覆盖语义不受影响（好快照胜出）", async () => {
    const corrupt = corruptRecordEntry("run-x");
    const entries: CustomEntry[] = [corrupt];
    await saveDoneRun(tmpDir, entries, "run-x");

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId)).toEqual(["run-x"]);
    expect(loaded[0]?.state.status).toBe("done");
  });
});
