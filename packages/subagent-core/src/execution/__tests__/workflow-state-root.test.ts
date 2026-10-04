// src/execution/__tests__/workflow-state-root.test.ts
//
// [F-1 修复] pi 宿主 WorkflowRun state 读侧装配同源布局测试。
//
// 背景（装配错位事故面）：对账 sweep 曾用缺省根
// `<dataRoot>/workflow-state`（zcode 宿主布局）读 workflow run state，而 pi 宿主真实
// 落盘 = JsonlRunStore 的 `<sessionDir>/workflow-state/<runId>.jsonl`——两目录生产不
// 相交 → 判据恒 missing → sweep 按终态补注销**活跃 run**。修复后装配点
// 传 resolvePiWorkflowStateDir()（execution/workflow-state-root.ts
// ——pi 宿主 sessionDir 布局单源 resolvePiSessionScopedDir 的 workflow-state 后缀
// 派生，壳 session-lifecycle.resolveSessionDir 薄消费同一单源）。
//
// 本套件用 mkdtemp 真实目录布局（非 mock fs）证明三件事：
//   ① resolvePiWorkflowStateDir 探测语义两分支（sessionScopedDir 存在/不存在）；
//   ② findRunSettlementEvidence(stateDir, runId)（[W2/V1 D6] 判据源改接
//      journal/manifest 终态证据）在真实布局命中 running/终态/missing；
//   ③ sweep 装配链（runPendingReconcileSweepForService，env 指向 tmp agentDir）端到端：
//      running run 不补注销（修复前被误注销的事故方向）、终态 run 补注销。
//
// 写删目标全部 mkdtempSync 自建自删（禁触真实数据目录纪律）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findRunSettlementEvidence } from "../persistence/run-state-evidence.ts";
import { RUN_EVENTS_SUFFIX } from "../../shared/run-vocabulary.ts";
import { createRunEventJournal } from "../../orchestration/run-events.ts";
import {
  setRunEventJournalDirForTest,
} from "../../orchestration/terminal-actions.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { runPendingReconcileSweepForService } from "../registry-reconcile/sweep-binding.ts";
import type { ReconcileSweepBinding } from "../registry-reconcile/sweep-binding.ts";
import { resolvePiSessionScopedDir, resolvePiWorkflowStateDir } from "../assembly/workflow-state-root.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-state-root-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 与生产单源 resolvePiSessionScopedDir 同规则的 cwd-slug（独立 mirror 构造期望
 * 布局用——不 import 生产推导，保断言独立性）。 */
function slugOf(cwd: string): string {
  return `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
}

describe("resolvePiSessionScopedDir（sessionDir 布局单源低阶导出，不带 workflow-state 后缀）", () => {
  it("sessionScopedDir 存在 → 返回 <agentDir>/sessions/<slug>（实例隔离布局）", () => {
    const cwd = path.join(tmpDir, "proj"); // 形式 cwd（不要求真实存在）
    const agentDir = path.join(tmpDir, "agent");
    const sessionScopedDir = path.join(agentDir, "sessions", slugOf(cwd));
    fs.mkdirSync(sessionScopedDir, { recursive: true });
    expect(resolvePiSessionScopedDir({ agentDir, cwd })).toBe(sessionScopedDir);
  });

  it("sessionScopedDir 不存在 → 回退 agentDir 根（JsonlRunStore 首写 mkdir 的根布局）", () => {
    const agentDir = path.join(tmpDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    expect(resolvePiSessionScopedDir({ agentDir, cwd: path.join(tmpDir, "fresh-proj") })).toBe(agentDir);
  });

  it("agentDir 缺省（无 opts）→ PI_CODING_AGENT_DIR env 通道，cwd 缺省 process.cwd()", () => {
    const agentDir = path.join(tmpDir, "agent-env");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    // 断言对探测两分支均成立：命中 → sessions/<slug> 在该树下，未命中 → 树根本身。
    // 真实 process.cwd() 的探测结果不受控（本机可能存在同名目录），不做分支级断言。
    expect(resolvePiSessionScopedDir().startsWith(agentDir)).toBe(true);
  });

  it("agentDir 缺省且 env 为空串 → homedir 自推锚定（~/.pi/agent 树下）", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
    const defaultAgentRoot = path.join(os.homedir(), ".pi", "agent");
    // 只读断言（不写真实 homedir）：探测两分支都在缺省锚定树下即证明 env 空 →
    // homedir 回落；分支级探测语义已由上方注入用例覆盖。
    expect(resolvePiSessionScopedDir().startsWith(defaultAgentRoot)).toBe(true);
  });

  it("resolvePiWorkflowStateDir 是其 workflow-state 纯后缀派生（同参一致）", () => {
    const cwd = path.join(tmpDir, "proj2");
    const agentDir = path.join(tmpDir, "agent2");
    fs.mkdirSync(path.join(agentDir, "sessions", slugOf(cwd)), { recursive: true });
    expect(resolvePiWorkflowStateDir({ agentDir, cwd })).toBe(
      path.join(resolvePiSessionScopedDir({ agentDir, cwd }), "workflow-state"),
    );
  });
});

describe("resolvePiWorkflowStateDir 探测语义（resolvePiSessionScopedDir 后缀派生）", () => {
  it("sessionScopedDir 存在 → 用 <agentDir>/sessions/<slug>/workflow-state（实例隔离布局）", () => {
    const cwd = path.join(tmpDir, "proj"); // 形式 cwd（不要求真实存在）
    const agentDir = path.join(tmpDir, "agent");
    const sessionScopedDir = path.join(agentDir, "sessions", slugOf(cwd));
    fs.mkdirSync(sessionScopedDir, { recursive: true });
    expect(resolvePiWorkflowStateDir({ agentDir, cwd })).toBe(path.join(sessionScopedDir, "workflow-state"));
  });

  it("sessionScopedDir 不存在 → 回退 <agentDir>/workflow-state（JsonlRunStore 首写 mkdir 的根布局）", () => {
    const agentDir = path.join(tmpDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    expect(resolvePiWorkflowStateDir({ agentDir, cwd: path.join(tmpDir, "fresh-proj") })).toBe(
      path.join(agentDir, "workflow-state"),
    );
  });
});

describe("findRunSettlementEvidence(stateDir) × 真实 JsonlRunStore 布局（读侧判据——[W2/V1 D6] 改接）", () => {
  it("真实布局命中：journal 运行中帧 → running；run-settled 帧 → terminal+派生 reason；无文件 → missing", async () => {
    const stateDir = path.join(tmpDir, "sessions", slugOf("/x/y"), "workflow-state");
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
      // journal 落盘路径形状与 pi 壳 JsonlRunStore 同构：<sessionDir>/workflow-state/<runId>.record.jsonl
      //（后缀经 RUN_EVENTS_SUFFIX 单源，防再改名漂移）。
      expect(fs.existsSync(path.join(stateDir, `wf-live${RUN_EVENTS_SUFFIX}`))).toBe(true);
    } finally {
      setRunEventJournalDirForTest(undefined);
    }
  });
});

describe("sweep 装配链端到端（runPendingReconcileSweepForService × 真实布局）", () => {
  /**
   * 装配 harness：env 指向 tmp agentDir（生产装配 resolvePiWorkflowStateDir() 无参走
   * env + process.cwd()），run state 判据直接读解析出的目录——
   * 证明「生产装配点读的目录 = run state 真实落盘目录」（同源布局闭环）。
   */
  function setupSweep(): { agentDir: string; stateDir: string } {
    const agentDir = path.join(tmpDir, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const stateDir = resolvePiWorkflowStateDir(); // 与生产装配同参
    // [W2/V1 D6] sweep 判据源 = journal/manifest 终态证据——收编/帧落账与判据同源注入。
    setRunEventJournalDirForTest(stateDir);
    return { agentDir, stateDir };
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
      getStore: () => new RecordStore(path.join(tmpDir, "records")),
      getPi: () =>
        ({
          appendEntry: (type: string, data: unknown) => appended.push({ customType: type, data }),
          events: { emit: vi.fn() },
          sendMessage: vi.fn(),
        }) as unknown as NonNullable<ReturnType<ReconcileSweepBinding["getPi"]>>,
      getMainSessionFile: () => sessionFile,
    };
  }

  function writeRegister(sessionFile: string, id: string): void {
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ customType: "pending:register", data: { id, type: "workflow", name: id } }) + "\n",
      "utf-8",
    );
  }

  it("活跃 workflow run（journal 运行中帧在盘）→ sweep 不补注销（修复前被误注销）", async () => {
    const { agentDir, stateDir } = setupSweep();
    await seedJournalIn(stateDir, "wf-live");

    const sessionFile = path.join(agentDir, "main-session.jsonl");
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
    const { agentDir, stateDir } = setupSweep();
    await seedJournalIn(stateDir, "wf-done", { outcome: "done" });

    const sessionFile = path.join(agentDir, "main-session.jsonl");
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
