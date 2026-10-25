// src/execution/__tests__/workflow-state-root.test.ts
//
// [session-store-layout-inversion D2/D3] workflow 域 run 状态读侧装配同源布局测试。
//
// 背景（装配错位事故面）：对账 sweep 曾用缺省根读 workflow run state，而 pi 宿主真实
// 落盘 = JsonlRunStore 的 run 记录目录——两目录生产不相交 → 判据恒 missing →
// sweep 按终态补注销**活跃 run**。修复后装配点以 rootSessionId 为分区键解析目录
// （execution/workflow-state-root.ts 的 resolvePiWorkflowRunsDir，壳侧
// session-lifecycle 的 resolveWorkflowRunsDir 薄消费同一单源）。
//
// 本套件用 mkdtemp 真实目录布局（非 mock fs）证明四件事：
//   ① resolvePiWorkflowRunsDir 落 session 存储树 `<root>/<rootSid>/workflow/runs/`
//      （布局单源 = shared getSessionWorkflowRunsDir）；
//   ② 非法 sid（路径穿越形态）被同域校验拒绝（fail-fast，不落到树外）；
//   ③ findRunSettlementEvidence(stateDir, runId)（[W2/V1 D6] 判据源改接
//      journal/manifest 终态证据）在真实布局命中 running/终态/missing；
//   ④ sweep 装配链（runPendingReconcileSweepForService，binding 注入 rootSessionId）
//      端到端：running run 不补注销（修复前被误注销的事故方向）、终态 run 补注销。
//
// 写删目标全部 mkdtempSync 自建自删（禁触真实数据目录纪律）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findRunSettlementEvidence } from "../../execution/persistence/run-state-evidence.ts";
import { RUN_EVENTS_SUFFIX } from "../../shared/run-vocabulary.ts";
import { createRunEventJournal } from "../run-events.ts";
import {
  setRunEventJournalDirForTest,
} from "../terminal-actions.ts";
import { RecordStore } from "../../execution/persistence/record-store.ts";
import { runPendingReconcileSweepForService } from "../../execution/registry-reconcile/sweep-binding.ts";
import type { ReconcileSweepBinding } from "../../execution/registry-reconcile/sweep-binding.ts";
import {
  resolvePiWorkflowRunsDir,
  setPiWorkflowRootSessionId,
  clearPiWorkflowRootSessionId,
  listWorkflowRunsDirs,
} from "../../execution/assembly/workflow-state-root.ts";

let tmpDir: string;
/** 合法 sid fixture（树内分区键；形态须过 shared isPiSessionId）。 */
const SID = "sid-wf-state-root";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-state-root-"));
});

afterEach(() => {
  clearPiWorkflowRootSessionId();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("resolvePiWorkflowRunsDir（session 存储树 runs 目录单源）", () => {
  it("显式 sid → <root>/<rootSid>/workflow/runs/（dataDir 注入）", () => {
    expect(resolvePiWorkflowRunsDir(SID, tmpDir)).toBe(
      path.join(tmpDir, "ext-sessions", SID, "workflow", "runs"),
    );
  });

  it("进程级锚（无参形态）→ 同一目录（晚绑定：initSession 绑定后写侧/读侧同源）", () => {
    setPiWorkflowRootSessionId(SID);
    expect(resolvePiWorkflowRunsDir(undefined, tmpDir)).toBe(
      path.join(tmpDir, "ext-sessions", SID, "workflow", "runs"),
    );
  });

  it("进程级锚未绑定 → fail-fast（静默回落固定目录会让 run 记录落到非归属会话树上）", () => {
    expect(() => resolvePiWorkflowRunsDir()).toThrow(/no rootSessionId bound/);
  });

  it("非法 sid（路径穿越形态）→ 同域校验 throw", () => {
    expect(() => resolvePiWorkflowRunsDir("../escape", tmpDir)).toThrow(/invalid sessionId/);
    expect(() => resolvePiWorkflowRunsDir("btw:sid-1", tmpDir)).toThrow(/invalid sessionId/);
  });
});

describe("listWorkflowRunsDirs（孤儿对账 / 维护轮的触发面枚举）", () => {
  it("枚举存储树一级合法 sid 目录的 runs 目录，非 sid 形态目录跳过（D7 树内遍历规约）", async () => {
    const root = path.join(tmpDir, "ext-sessions");
    fs.mkdirSync(path.join(root, SID, "workflow", "runs"), { recursive: true });
    fs.mkdirSync(path.join(root, "sid-other", "workflow", "runs"), { recursive: true });
    fs.mkdirSync(path.join(root, "not-a-session-id!"), { recursive: true }); // 非 sid 形态
    fs.writeFileSync(path.join(root, "stray-file.txt"), "x", "utf8"); // 非目录
    const dirs = await listWorkflowRunsDirs(tmpDir);
    expect(dirs.sort()).toEqual(
      [
        path.join(root, SID, "workflow", "runs"),
        path.join(root, "sid-other", "workflow", "runs"),
      ].sort(),
    );
  });

  it("树根不存在（从未落盘）→ 空数组（ENOENT = 正常空态，不抛）", async () => {
    expect(await listWorkflowRunsDirs(tmpDir)).toEqual([]);
  });
});

describe("findRunSettlementEvidence(stateDir) × 真实 JsonlRunStore 布局（读侧判据——[W2/V1 D6] 改接）", () => {
  it("真实布局命中：journal 运行中帧 → running；run-settled 帧 → terminal+派生 reason；无文件 → missing", async () => {
    const stateDir = path.join(tmpDir, "ext-sessions", SID, "workflow", "runs");
    setRunEventJournalDirForTest(stateDir);
    try {
      const journal = createRunEventJournal(stateDir);
      await journal.append("wf-live", { type: "run-created", runId: "wf-live", workflowName: "test-script", argsSummary: "{}", ts: Date.now() });
      await journal.append("wf-live", { type: "agent-started", taskIndex: 1, agentName: "a", attempt: 1, ts: Date.now() });
      await journal.append("wf-done", { type: "run-created", runId: "wf-done", workflowName: "test-script", argsSummary: "{}", ts: Date.now() });
      await journal.append("wf-done", { type: "run-settled", outcome: "done", artifactsDir: stateDir, ts: Date.now() });

      expect(findRunSettlementEvidence(stateDir, "wf-live")).toEqual({ kind: "running" });
      expect(findRunSettlementEvidence(stateDir, "wf-done")).toEqual({ kind: "terminal", reason: "completed" });
      expect(findRunSettlementEvidence(stateDir, "wf-never")).toEqual({ kind: "missing" });
      // journal 落盘路径形状与 pi 壳 JsonlRunStore 同构：
      // <root>/<rootSid>/workflow/runs/<runId>.record.jsonl（后缀经 RUN_EVENTS_SUFFIX
      // 单源，防再改名漂移）。
      expect(fs.existsSync(path.join(stateDir, `wf-live${RUN_EVENTS_SUFFIX}`))).toBe(true);
    } finally {
      setRunEventJournalDirForTest(undefined);
    }
  });
});

describe("sweep 装配链端到端（runPendingReconcileSweepForService × 真实布局）", () => {
  /**
   * 装配 harness：binding 注入 rootSessionId（生产装配点 = SubagentService 的
   * baselines deps 回调，initSession 后 rootSessionId 即就位），run state 判据直接
   * 读解析出的目录——证明「生产装配点读的目录 = run state 真实落盘目录」（同源布局
   * 闭环）。
   */
  function setupSweep(): { runsDir: string } {
    // sweep 装配点经 resolvePiWorkflowRunsDir(rootSessionId)（无 dataDir 入参）解析
    // 目录——数据根经 env 注入，与生产链（ENV_WHITELIST_PREFIXES 注入 pi 进程）同形态。
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", tmpDir);
    const runsDir = resolvePiWorkflowRunsDir(SID);
    expect(runsDir).toBe(path.join(tmpDir, "ext-sessions", SID, "workflow", "runs"));
    // [W2/V1 D6] sweep 判据源 = journal/manifest 终态证据——收编/帧落账与判据同源注入。
    setRunEventJournalDirForTest(runsDir);
    return { runsDir };
  }

  async function seedJournalIn(dir: string, runId: string, settled?: { outcome: "done" | "failed" | "cancelled" | "time_limited" }): Promise<void> {
    const journal = createRunEventJournal(dir);
    await journal.append(runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: Date.now() });
    if (settled !== undefined) {
      await journal.append(runId, { type: "agent-started", taskIndex: 1, agentName: "a", attempt: 1, ts: Date.now() });
      await journal.append(runId, { type: "run-settled", outcome: settled.outcome, artifactsDir: dir, ts: Date.now() });
    } else {
      await journal.append(runId, { type: "agent-started", taskIndex: 1, agentName: "a", attempt: 1, ts: Date.now() });
    }
  }

  function makeBinding(sessionFile: string, appended: Array<{ customType: string; data: unknown }>): ReconcileSweepBinding {
    return {
      getStore: () => new RecordStore(() => path.join(tmpDir, "records")),
      getPi: () =>
        ({
          appendEntry: (type: string, data: unknown) => appended.push({ customType: type, data }),
          events: { emit: vi.fn() },
          sendMessage: vi.fn(),
        }) as unknown as NonNullable<ReturnType<ReconcileSweepBinding["getPi"]>>,
      getMainSessionFile: () => sessionFile,
      getRootSessionId: () => SID,
    };
  }

  function writeRegister(sessionFile: string, id: string): void {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ customType: "pending:register", data: { id, type: "workflow", name: id } }) + "\n",
      "utf-8",
    );
  }

  it("活跃 workflow run（journal 运行中帧在盘）→ sweep 不补注销（修复前被误注销）", async () => {
    const { runsDir } = setupSweep();
    await seedJournalIn(runsDir, "wf-live");

    const sessionFile = path.join(tmpDir, "agent", "main-session.jsonl");
    writeRegister(sessionFile, "wf-live");
    const appended: Array<{ customType: string; data: unknown }> = [];
    try {
      runPendingReconcileSweepForService(makeBinding(sessionFile, appended), false);
    } finally {
      setRunEventJournalDirForTest(undefined);
    }
    expect(appended).toHaveLength(0); // 活跃 run 不注销——事故方向的回归钉
  });

  it("终态 workflow run（journal run-settled 帧在盘）→ sweep 补注销（reason 经联合派生）", async () => {
    const { runsDir } = setupSweep();
    await seedJournalIn(runsDir, "wf-done", { outcome: "done" });

    const sessionFile = path.join(tmpDir, "agent", "main-session.jsonl");
    writeRegister(sessionFile, "wf-done");
    const appended: Array<{ customType: string; data: unknown }> = [];
    try {
      runPendingReconcileSweepForService(makeBinding(sessionFile, appended), false);
    } finally {
      setRunEventJournalDirForTest(undefined);
    }
    expect(appended).toEqual([
      { customType: "pending:unregister", data: { id: "wf-done", reason: "completed", status: "completed" } },
    ]);
  });
});
