// src/execution/__tests__/workflow-state-root.test.ts
//
// [F-1 修复] pi 宿主 WorkflowRun state 读侧装配同源布局测试。
//
// 背景（装配错位事故面）：对账 sweep 与 idle-gc 曾用 FileRunStore 缺省根
// `<dataRoot>/workflow-state`（zcode 宿主布局）读 workflow run state，而 pi 宿主真实
// 落盘 = JsonlRunStore 的 `<sessionDir>/workflow-state/<runId>.jsonl`——两目录生产不
// 相交 → findStateByIdSync 恒 missing → sweep 按终态补注销**活跃 run**；WorkflowRun
// GC 恒空转。修复后装配点传 resolvePiWorkflowStateDir()（execution/workflow-state-root.ts
// ——pi 宿主 sessionDir 布局单源 resolvePiSessionScopedDir 的 workflow-state 后缀
// 派生，壳 session-lifecycle.resolveSessionDir 薄消费同一单源）。
//
// 本套件用 mkdtemp 真实目录布局（非 mock fs）证明四件事：
//   ① resolvePiWorkflowStateDir 探测语义两分支（sessionScopedDir 存在/不存在）；
//   ② FileRunStore({stateDir}) findSettlementEvidenceSync（[W2/V1 D6] 判据源改接
//      journal/manifest 终态证据）在真实布局命中 running/终态/missing；
//   ③ sweep 装配链（runPendingReconcileSweepForService，env 指向 tmp agentDir）端到端：
//      running run 不补注销（修复前被误注销的事故方向）、终态 run 补注销；
//   ④ idle-gc 同布局：超龄 running run 经收编原语终局化（journal run-settled 帧 +
//      manifest 落盘——[W2/V1 D3] transition+save 写点退役）。
//
// 写删目标全部 mkdtempSync 自建自删（禁触真实数据目录纪律）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleepReal } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileRunStore } from "../../orchestration/file-run-store.ts";
import { createRunEventJournal } from "../../orchestration/run-events.ts";
import { setRunEventJournalDirForTest } from "../../orchestration/worker-message-pump.ts";
import { Budget } from "../../orchestration/models/budget.ts";
import { Trace } from "../../orchestration/models/trace.ts";
import { WorkflowRun } from "../../orchestration/models/workflow-run.ts";
import { startIdleGc } from "../persistence/idle-gc.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { runPendingReconcileSweepForService } from "../registry-reconcile/sweep-binding.ts";
import type { ReconcileSweepBinding } from "../registry-reconcile/sweep-binding.ts";
import { resolvePiSessionScopedDir, resolvePiWorkflowStateDir } from "../assembly/workflow-state-root.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 60 * 1000;

let tmpDir: string;
let stopGc: (() => void) | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-state-root-"));
});

afterEach(() => {
  stopGc?.();
  stopGc = undefined;
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 与生产单源 resolvePiSessionScopedDir 同规则的 cwd-slug（独立 mirror 构造期望
 * 布局用——不 import 生产推导，保断言独立性）。 */
function slugOf(cwd: string): string {
  return `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
}

/** 构造可持久化的 WorkflowRun（对齐 file-run-store.test.ts makeRun 模式）。 */
function makeRun(
  runId: string,
  opts: { status?: "running" | "done"; startedAt?: string } = {},
): WorkflowRun {
  const status = opts.status ?? "running";
  return WorkflowRun.reconstruct(
    runId,
    {
      scriptSource: "export function execute() { return 'ok'; }",
      args: { topic: "demo" },
      scriptName: "test-script",
      scriptPath: "/fake/test.js",
      parameters: { type: "object" },
      budgetTokens: 1000,
    },
    {
      status,
      ...(status === "done" ? { reason: "completed" as const } : {}),
      budget: new Budget({ maxTokens: 1000, usedTokens: 1, usedCost: 0, totalCallCount: 1 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
      scriptResult: undefined,
    },
    { startedAt: opts.startedAt ?? "2026-08-30T00:00:00.000Z" },
  );
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

describe("FileRunStore({stateDir}) × 真实 JsonlRunStore 布局（findSettlementEvidenceSync 读侧判据——[W2/V1 D6] 改接）", () => {
  it("真实布局命中：journal 运行中帧 → running；run-settled 帧 → terminal+派生 reason；无文件 → missing", async () => {
    const stateDir = path.join(tmpDir, "sessions", slugOf("/x/y"), "workflow-state");
    const store = new FileRunStore({ stateDir });
    setRunEventJournalDirForTest(stateDir);
    try {
      const journal = createRunEventJournal(stateDir);
      await journal.append("wf-live", { type: "run-created", runId: "wf-live", workflowName: "test-script", argsSummary: "{}", ts: Date.now() });
      await journal.append("wf-live", { type: "ask-dispatched", taskIndex: 1, agentName: "a", attempt: 1, ts: Date.now() });
      await journal.append("wf-done", { type: "run-created", runId: "wf-done", workflowName: "test-script", argsSummary: "{}", ts: Date.now() });
      await journal.append("wf-done", { type: "run-settled", outcome: "completed", artifactsDir: stateDir, ts: Date.now() });

      expect(store.findSettlementEvidenceSync("wf-live")).toEqual({ kind: "running" });
      expect(store.findSettlementEvidenceSync("wf-done")).toEqual({ kind: "terminal", reason: "completed" });
      expect(store.findSettlementEvidenceSync("wf-never")).toEqual({ kind: "missing" });
      // journal 落盘路径形状与 pi 壳 JsonlRunStore 同构：<sessionDir>/workflow-state/<runId>.events.jsonl
      expect(fs.existsSync(path.join(stateDir, "wf-live.events.jsonl"))).toBe(true);
    } finally {
      setRunEventJournalDirForTest(undefined);
    }
  });
});

describe("sweep 装配链端到端（runPendingReconcileSweepForService × 真实布局）", () => {
  /**
   * 装配 harness：env 指向 tmp agentDir（生产装配 resolvePiWorkflowStateDir() 无参走
   * env + process.cwd()），run state 由 FileRunStore({stateDir}) 写入解析出的目录——
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

  async function seedJournalIn(dir: string, runId: string, settled?: { outcome: "completed" | "failed" | "cancelled" | "interrupted" }): Promise<void> {
    const journal = createRunEventJournal(dir);
    await journal.append(runId, { type: "run-created", runId, workflowName: "test-script", argsSummary: "{}", ts: Date.now() });
    if (settled !== undefined) {
      await journal.append(runId, { type: "ask-dispatched", taskIndex: 1, agentName: "a", attempt: 1, ts: Date.now() });
      await journal.append(runId, { type: "run-settled", outcome: settled.outcome, artifactsDir: dir, ts: Date.now() });
    } else {
      await journal.append(runId, { type: "ask-dispatched", taskIndex: 1, agentName: "a", attempt: 1, ts: Date.now() });
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
    await seedJournalIn(stateDir, "wf-done", { outcome: "completed" });

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

describe("idle-gc 同布局（WorkflowRun GC 读对根）", () => {
  /**
   * GC interval 用 fake timers 推进；但 gcWorkflowRuns 的 loadAll/save 是**真实 fs IO**
   * （libuv 线程池回调不属被 fake 的 timer API）——推进后经 setImmediate（toFake 排除，
   * 保持真实调度）反复让出事件循环排空在途 IO。
   */
  async function flushRealIo(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((resolve) => setImmediate(() => resolve()));
    }
  }

  /**
   * 轮询等待真实 fs IO 落盘翻转（pred 置位提前 return；预算耗尽静默返回，由调用处原断言失败）。
   *
   * 为什么固定排空窗口不够：满并行 vitest（全量并发）下多 worker 抢满 CPU，libuv 线程池 fs 回调
   * 的墙钟延迟无稳定上界——50×setImmediate 排空窗口等不到 save 落盘是 flake 根因（GC 触发本身
   * 正常）。同仓先例 git-head-watcher.test.ts injectUntilPending：轮询把「迟到」消化在预算内
   * （10s 预算远小于用例 timeout 30s）。计时用 hrtime 不受 fake timers 影响；睡眠走
   * node:timers/promises 模块导出，不在 vi.useFakeTimers 的 toFake 替换面内（先例已探针核实）。
   */
  async function pollUntilPersisted(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadlineMs = Number(process.hrtime.bigint() / 1_000_000n) + timeoutMs;
    while (!pred()) {
      if (Number(process.hrtime.bigint() / 1_000_000n) > deadlineMs) return;
      await sleepReal(50);
    }
  }

  it(
    "真实布局超龄 running run → GC 经收编原语终局化（journal run-settled 帧 + manifest；[W2/V1 D3]）",
    { timeout: 30_000 }, // pollUntilPersisted 预算 10s 的用例级余量（先例 git-head-watcher 同款）
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const agentDir = path.join(tmpDir, "agent");
      const cwd = path.join(tmpDir, "proj");
      const sessionScopedDir = path.join(agentDir, "sessions", slugOf(cwd));
      fs.mkdirSync(sessionScopedDir, { recursive: true });
      const stateDir = resolvePiWorkflowStateDir({ agentDir, cwd });
      const runStore = new FileRunStore({ stateDir });
      // 超龄锚 = 快照 meta.startedAt（loadAll 面）；终局证据面 = journal（可收编形态）
      await runStore.save(
        makeRun("wf-stale", { startedAt: new Date(Date.now() - 31 * DAY_MS).toISOString() }),
      );
      setRunEventJournalDirForTest(stateDir);
      try {
        const journal = createRunEventJournal(stateDir);
        await journal.append("wf-stale", { type: "run-created", runId: "wf-stale", workflowName: "test-script", argsSummary: "{}", ts: Date.now() });
        await journal.append("wf-stale", { type: "ask-dispatched", taskIndex: 1, agentName: "a", attempt: 1, ts: Date.now() });

        stopGc = startIdleGc(new RecordStore(path.join(tmpDir, "records")), runStore);
        await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
        await flushRealIo();
        // 满并行下固定排空窗口可能早于 manifest（writeAtomicFile 真实 IO）落盘——
        // 轮询等待落盘翻转；预算耗尽静默返回，落到下方原断言失败（断言语义不放松）。
        await pollUntilPersisted(() => fs.existsSync(path.join(stateDir, "wf-stale.json")));

        // 终局已落盘（journal run-settled 帧 + manifest 两件直落，[W2 三路径 outcome 断言]）
        const events = await createRunEventJournal(stateDir).scan("wf-stale");
        const settled = events.find((e) => e.type === "run-settled");
        expect(settled).toMatchObject({ outcome: "interrupted", errorCode: "idle-evicted" });
        const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, "wf-stale.json"), "utf8")) as { outcome?: string };
        expect(manifest.outcome).toBe("interrupted");
      } finally {
        setRunEventJournalDirForTest(undefined);
      }
    },
  );

  it("窗内 running run 不动（GC 判据在正确根上按 startedAt 生效）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const agentDir = path.join(tmpDir, "agent");
    const stateDir = resolvePiWorkflowStateDir({ agentDir, cwd: tmpDir });
    const runStore = new FileRunStore({ stateDir });
    await runStore.save(
      makeRun("wf-fresh", { startedAt: new Date(Date.now() - 1 * DAY_MS).toISOString() }),
    );
    setRunEventJournalDirForTest(stateDir);
    try {
      const journal = createRunEventJournal(stateDir);
      await journal.append("wf-fresh", { type: "run-created", runId: "wf-fresh", workflowName: "test-script", argsSummary: "{}", ts: Date.now() });
      await journal.append("wf-fresh", { type: "ask-dispatched", taskIndex: 1, agentName: "a", attempt: 1, ts: Date.now() });

      stopGc = startIdleGc(new RecordStore(path.join(tmpDir, "records")), runStore);
      await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
      await flushRealIo();

      const events = await createRunEventJournal(stateDir).scan("wf-fresh");
      expect(events.filter((e) => e.type === "run-settled")).toHaveLength(0);
      expect(fs.existsSync(path.join(stateDir, "wf-fresh.json"))).toBe(false);
    } finally {
      setRunEventJournalDirForTest(undefined);
    }
  });
});
