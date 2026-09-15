// src/__tests__/jsonl-run-store-loadall-sources.test.ts
//
// loadAll entry 源扫描（collectEntrySources + loadRunFromStateFile）定向用例（R2-TC S4）。
//
// 防的 bug：loadAll 的多 run 重建 / 损坏 state 文件降级。W17 已覆盖单 run 的 entry 重建、
// link 兼容与读序优先级；本文件补齐三块未定向覆盖的分支：
// 1. 多 run 并存（多个 workflow-record entry run + link run 同批重建，无丢失）
// 2. 损坏 state 文件降级（末行非 JSON / 空文件 / link 指向不存在路径 / link data 缺 runId）
//    ——单文件失败返回 null 跳过，不崩 loadAll、不阻断同批其余 run 重建
// 3. 同 runId 多条 record entry 末条胜出在多 run 场景下不串扰
//
// 不 mock collectEntrySources：走 loadAll 真实通路（ctx.sessionManager.getEntries 返回
// seed entries，loadRunFromStateFile 读真实临时文件）。record entry 一律经真实 save 产出
//（deserializeRun 的快照 schema 以真实 serializeRun 为准，手工拼快照会绕开 schema 契约）。

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
import { JsonlRunStore } from "../jsonl-run-store.ts";
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

/** 手工构造旧 workflow-state-link 指针 entry（loadAll 的 link 兼容输入）。 */
function linkEntry(runId: string, statePath: string): CustomEntry {
  return {
    type: "custom",
    customType: "workflow-state-link",
    data: { runId, path: statePath },
    id: `seed-link-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

describe("loadAll entry 源扫描：多 run 重建与损坏 state 降级（R2-TC S4）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-loadall-src-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("多 run 并存：2 个 entry run + 1 个 link run 同批全部重建（无丢失）", async () => {
    // run-a/run-b 经真实 save 通路产出终态 entry（快照形态可信）
    const entries: CustomEntry[] = [];
    await saveDoneRun(tmpDir, entries, "run-a");
    await saveDoneRun(tmpDir, entries, "run-b");

    // run-c：旧 link 形态（state 文件完好，无 record entry）
    const storeC = new JsonlRunStore({ sessionDir: tmpDir });
    const runC = makeRunningRun("run-c");
    await storeC.save(runC);
    runC.transition("done", "completed");
    await storeC.save(runC);
    const linkPath = path.join(tmpDir, "workflow-state", "run-c.jsonl");
    expect(fs.existsSync(linkPath)).toBe(true);
    const seedEntries: CustomEntry[] = [...entries, linkEntry("run-c", linkPath)];

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(seedEntries) });
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId).sort()).toEqual(["run-a", "run-b", "run-c"]);
  });

  it("损坏 state 文件（末行非 JSON）→ 该 run 跳过不崩，同批其余 run（entry run）正常返回", async () => {
    const entries: CustomEntry[] = [];
    await saveDoneRun(tmpDir, entries, "run-good");

    const corruptPath = path.join(tmpDir, "workflow-state", "run-corrupt.jsonl");
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    fs.writeFileSync(corruptPath, "{truncated-not-json\n", "utf8");

    const seedEntries: CustomEntry[] = [...entries, linkEntry("run-corrupt", corruptPath)];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(seedEntries) });
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId)).toEqual(["run-good"]);
  });

  it("损坏形态族：空文件 / link 指向不存在路径 / link data 缺 runId → 均降级跳过，loadAll 不抛", async () => {
    const emptyPath = path.join(tmpDir, "workflow-state", "run-empty.jsonl");
    fs.mkdirSync(path.dirname(emptyPath), { recursive: true });
    fs.writeFileSync(emptyPath, "", "utf8");
    const missingPath = path.join(tmpDir, "workflow-state", "run-missing.jsonl");

    const malformedLink = linkEntry("run-bad", emptyPath);
    (malformedLink.data as Record<string, unknown>).runId = undefined; // 缺 runId 的坏指针

    // 对照组：一条合法 record entry run 应正常重建（真实 save 产出）
    const entries: CustomEntry[] = [];
    await saveDoneRun(tmpDir, entries, "run-seeded");

    const seedEntries: CustomEntry[] = [
      ...entries,
      linkEntry("run-empty", emptyPath),
      linkEntry("run-missing", missingPath),
      malformedLink,
    ];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(seedEntries) });
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId)).toEqual(["run-seeded"]);
  });

  it("同 runId 多条 record entry 末条胜出（running→done 收敛）+ 另一 run 不受影响（混合批不串扰）", async () => {
    const entries: CustomEntry[] = [];
    // run-x：两条 entry（running 中间态 + done 终态），末条胜出
    const storeX = new JsonlRunStore({ sessionDir: tmpDir, pi: mkPi(entries) });
    const runX = makeRunningRun("run-x");
    await storeX.save(runX);
    runX.transition("done", "completed");
    await storeX.save(runX);
    // run-y：done 终态
    await saveDoneRun(tmpDir, entries, "run-y");

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();
    const byId = new Map(loaded.map((r) => [r.runId, r]));
    expect(loaded).toHaveLength(2);
    expect(byId.get("run-x")?.state.status).toBe("done");
    expect(byId.get("run-y")?.state.status).toBe("done");
  });
});
