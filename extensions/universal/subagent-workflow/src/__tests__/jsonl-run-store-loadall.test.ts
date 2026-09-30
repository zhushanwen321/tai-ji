// src/__tests__/jsonl-run-store-loadall.test.ts
//
// loadAll 发现域裁决锚（v2-only）：主 session 的发现通道收敛为「v2 注册条目定界 →
// record 流权威重建」单通道。历史形态 entry（v1 全量快照 / 旧 workflow-state-link
// 指针）不参与发现——旧 session JSONL 里的历史 entry 仍在盘上，loadAll 必须静默
// 忽略（不抛、不重建、零 warn），未知 entry 容忍面不受影响。
// v2 重建/收编读面的完整用例在 jsonl-run-store-session-file.test.ts（W17/W1 describe）与
// __tests__/record-mode/（[D1] record 单源语义族）。

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

import {
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_ENTRY_VERSION,
  evictDoneRunsBeyondCap,
  isRunSettled,
  runSummary,
} from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
// [D6(a) 第 1 步] 注册表清零面（setRunEventJournalDirForTest 同实现内清 liveRunStates
// 与终局记录注册表）——换源后注册表是 isRunSettled / runSummary 的唯一判源。
import { setRunEventJournalDirForTest } from "@zhushanwen/subagent-core/orchestration/terminal-actions.ts";
import { JsonlRunStore } from "../jsonl-run-store.ts";
import { mkCtx } from "@zhushanwen/subagent-core/testing/orchestration/__tests__/test-mocks.ts";

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/** 手工构造历史形态 v1 快照 entry（快照载荷直接给对象字面量——历史数据在盘形态
 *  的夹具产出，用于锚定「不再被发现」的裁决行为）。 */
function legacyV1RecordEntryRaw(runId: string, snapshot: Record<string, unknown>): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: { v: 1, snapshot, updatedAt: new Date().toISOString() },
    id: `seed-v1-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** 手工构造历史形态 workflow-state-link 指针 entry。 */
function legacyLinkEntry(runId: string, statePath: string): CustomEntry {
  return {
    type: "custom",
    customType: "workflow-state-link",
    data: { runId, path: statePath },
    id: `seed-link-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** v2 注册条目夹具（字段集 = core lifecycle 写点同构）。 */
function v2RegisteredEntry(runId: string, journalPath: string): CustomEntry {
  return {
    type: "custom",
    customType: WORKFLOW_RECORD_CUSTOM_TYPE,
    data: {
      v: WORKFLOW_RECORD_ENTRY_VERSION,
      kind: "registered",
      runId,
      workflowName: "test-script",
      scriptName: "test-script",
      slug: "test-script",
      startedAt: Date.now(),
      journalPath,
    },
    id: `seed-v2-reg-${runId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
  };
}

/** record 流 run-settled 终局帧（载荷完整形态——[D1] 后 settled 帧必带 result 全文）。 */
function settledLine(): string {
  return JSON.stringify({
    type: "run-settled",
    seq: 2,
    ts: Date.now(),
    outcome: "done",
    artifactsDir: "/tmp/wf",
  });
}

function journalPathOf(tmpDir: string, runId: string): string {
  return path.join(tmpDir, "workflow-state", `${runId}.record.jsonl`);
}

// ── 用例 ─────────────────────────────────────────────────────────────────────

describe("loadAll 发现域（v2-only）：历史形态 entry 不再被发现", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-loadall-v2only-"));
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("存量旧会话（v1 快照 entry + workflow-state-link 指针在盘）→ loadAll 返回空 + 零 warn（静默忽略不抛）", async () => {
    // v1 形态快照：v 字段 + snapshot 信封 + v2 版本头（历史形态的合法内容）
    const statePath = path.join(tmpDir, "workflow-state", "run-legacy.jsonl");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({ v: "wf-run-v2", runId: "run-legacy", state: { status: "running" }, meta: {} })}\n`,
      "utf8",
    );

    const entries: CustomEntry[] = [
      legacyV1RecordEntryRaw("run-legacy", { v: "wf-run-v2", runId: "run-legacy", state: { status: "running" }, meta: {} }),
      legacyLinkEntry("run-legacy", statePath),
    ];
    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });

    // 历史形态不参与发现：空结果、不抛、零 warn（静默语义）
    await expect(store.loadAll()).resolves.toEqual([]);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("混合批：v2 注册条目照常 journal 重建，历史形态 entry 同批不干扰", async () => {
    // v2 实体：注册条目 + journal 终局帧 → journal 权威重建
    const journalPath = journalPathOf(tmpDir, "run-v2-current");
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, `${settledLine()}\n`, "utf8");

    // 历史形态同批在盘：v1 快照 entry + link 指针（指向 state 文件）
    const legacyStatePath = path.join(tmpDir, "workflow-state", "run-old.jsonl");
    fs.writeFileSync(
      legacyStatePath,
      `${JSON.stringify({ v: "wf-run-v2", runId: "run-old", state: { status: "running" }, meta: {} })}\n`,
      "utf8",
    );
    const entries: CustomEntry[] = [
      v2RegisteredEntry("run-v2-current", journalPath),
      legacyV1RecordEntryRaw("run-old", { v: "wf-run-v2", runId: "run-old", state: { status: "running" }, meta: {} }),
      legacyLinkEntry("run-old", legacyStatePath),
    ];

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx(entries) });
    const loaded = await store.loadAll();

    // 只有 v2 实体重建（终局 ⟸ journal run-settled）；历史形态零发现
    expect(loaded.map((r) => r.runId)).toEqual(["run-v2-current"]);
    // [D6(a) 第 3 步] 终局判定源 = 终局记录注册表（聚合不持 status）
    expect(isRunSettled(loaded[0]!)).toBe(true);
    expect(loaded[0]!.state.reason).toBe("completed");
  });

  it("[U6 回归] resolveAgentOpts 失败形态的 agent-settled 帧带 result → loadAll 正常重建（不判损坏）", async () => {
    // 派发前置失败（agent 名/skill 解析失败）是设计内合法产出：run 终局 failed、
    // call 的 agent-settled 帧由 dispatchAgentSettledFailed 落账。写面补齐 result
    // 后，重启 loadAll 的严格读原语（settled 帧缺 result = RecordStreamCorruptionError
    // → storeHealthy=false 停初始化）不再把该流判损坏。
    const journalPath = journalPathOf(tmpDir, "run-pre-dispatch-fail");
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(
      journalPath,
      [
        JSON.stringify({
          type: "run-created",
          seq: 1,
          ts: Date.now(),
          runId: "run-pre-dispatch-fail",
          workflowName: "test-script",
          argsSummary: "{}",
          scriptSource: "agent('nope')",
        }),
        JSON.stringify({
          type: "agent-started",
          seq: 2,
          ts: Date.now(),
          taskIndex: 0,
          agentName: "nope",
          attempt: 1,
        }),
        JSON.stringify({
          type: "agent-settled",
          seq: 3,
          ts: Date.now(),
          taskIndex: 0,
          attempt: 1,
          outcome: "failed",
          errorCode: "unknown",
          result: { content: "", error: "skill not found: nope" },
          durationMs: 0,
        }),
        JSON.stringify({
          type: "run-settled",
          seq: 4,
          ts: Date.now(),
          outcome: "failed",
          errorCode: "unknown",
          reason: "agent opts resolve failed",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const store = new JsonlRunStore({ sessionDir: tmpDir, ctx: mkCtx([v2RegisteredEntry("run-pre-dispatch-fail", journalPath)]) });
    const loaded = await store.loadAll();

    expect(loaded.map((r) => r.runId)).toEqual(["run-pre-dispatch-fail"]);
    // [D6(a) 第 3 步] 终局判定源 = 终局记录注册表（聚合不持 status）
    expect(isRunSettled(loaded[0]!)).toBe(true);
    expect(loaded[0]!.state.reason).toBe("failed");
    const call = loaded[0]!.state.calls.get(0);
    expect(call?.result).toMatchObject({ content: "", error: "skill not found: nope" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// [D6(a) 第 1 步] 重启后重水合 run 的终局判定换源：判据 = 重建 fold 结果
//
// loadAll 从 record 流 fold 出「有 run-settled 帧」这一事实后，经
// noteRebuiltSettlement 注入 core 终局记录注册表——展示投影（runSummary）、
// isRunSettled、evictDoneRunsBeyondCap 白名单三处据此判定，不再读聚合 status
// 字段。本节 = 设计 §1.7 第 1 步判据点名的三处行为断言（重启后 done run 不回退
// running / 判终局为真 / 可被淘汰，内存有界）。
// ════════════════════════════════════════════════════════════════════════════

describe("[D6(a) 第 1 步] 重水合 run 的终局判定源 = 重建 fold 结果", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-rehydrate-finality-"));
    // 注册表清零（换源后它是 isRunSettled / runSummary 的唯一判源）——防跨用例污染
    setRunEventJournalDirForTest(undefined);
  });

  afterEach(() => {
    setRunEventJournalDirForTest(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 写 record 流 + v2 注册条目 → loadAll 重建该 run。 */
  async function rebuild(runId: string, lines: string[]): Promise<WorkflowRun> {
    const journalPath = journalPathOf(tmpDir, runId);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, `${lines.join("\n")}\n`, "utf8");
    const store = new JsonlRunStore({
      sessionDir: tmpDir,
      ctx: mkCtx([v2RegisteredEntry(runId, journalPath)]),
    });
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.runId)).toEqual([runId]);
    return loaded[0]!;
  }

  it("① 重启后 done run 的 runSummary 仍投影 done（展示不回退 running）", async () => {
    const run = await rebuild("wf-rehydrated-done", [settledLine()]);

    const summary = runSummary(run);
    expect(summary.status).toBe("done");
    expect(summary.reason).toBe("completed");
    expect(summary.completedAt).toBeDefined();
  });

  it("② isRunSettled 对重水合 done run 为真；无 run-settled 帧的重水合 run 为假", async () => {
    const done = await rebuild("wf-rehydrated-settled", [settledLine()]);
    expect(isRunSettled(done)).toBe(true);

    const running = await rebuild("wf-rehydrated-running", [
      JSON.stringify({
        type: "run-created",
        seq: 1,
        ts: Date.now(),
        runId: "wf-rehydrated-running",
        workflowName: "test-script",
        argsSummary: "{}",
        scriptSource: "agent('a')",
      }),
    ]);
    expect(isRunSettled(running)).toBe(false);
    expect(runSummary(running).status).toBe("running");
  });

  it("③ 重水合 done run 进入 evictDoneRunsBeyondCap 白名单（runs Map 内存有界性）", async () => {
    const run = await rebuild("wf-rehydrated-evict", [settledLine()]);
    const runs = new Map<string, WorkflowRun>([[run.runId, run]]);

    expect(evictDoneRunsBeyondCap(runs, 0)).toBe(1);
    expect(runs.has(run.runId)).toBe(false);
  });
});
