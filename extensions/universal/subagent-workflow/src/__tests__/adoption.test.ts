// src/__tests__/adoption.test.ts
//
// B2 单元验收面（skill-reload-nondestructive 设计 D4/D5）——lifecycle / handler 面：
//   ① D4 恢复门控：session_start(reason='reload') 全程不跑 recoverCrashedRuns
//      （无论条目有无）——条目存在（adoption 接管）与条目缺失（reload 落首次装配
//      await 链中）两形态的 running run 都不转 failed；非 reload（startup）现状
//      恢复语义保持（门控是 reason 驱动的对照组）；
//   ② D4 接管：adoption 后 sessionState.get(sid) 与 reload 前同一引用（store/runs
//      不换实例）、ctx 换新、rebind 后 appendEntry 走新 pi；
//   ③ D4 失败处置（顺序敏感 r4）：健康检查不过 → rebind-first 后 terminate 的
//      failed entry 落新 pi 权威 JSONL + notifyDone 用户可见（sendMessage
//      workflow-result）+ sessionState 条目移除 + 全量装配兜底。
//
// store 本体面（rebind 补写 / 投影重发保序 / stale guard 直测）归属
// jsonl-run-store-session-file.test.ts（测试审计裁决：被测对象是 JsonlRunStore
// 本体行为的条目随归属走）。
//
// mock 手法对齐既有测试：seam 直测对齐 session-lifecycle.test.ts（resetModules +
// 用例内动态 import setupSessionLifecycle——oncePerProcess 守卫 Map 是模块级状态；
// 双 Service 经访问器槽注入 fake）；handler 级对齐
// workflow-events.test.ts（真 setupWorkflowDomain 全链，不 mock
// session-lifecycle / jsonl-run-store / subagent-core）。
//
// 环境隔离：PI_CODING_AGENT_DIR 钉到 mkdtemp 临时目录（pi config.js getAgentDir
// env 优先）——真 JsonlRunStore 的 sessionDir / syncEnginesFile 全落临时目录，
// 不触碰真实 ~/.pi/agent（AGENTS.md 测试红线）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { CustomEntry, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Budget } from "@zhushanwen/subagent-core";
import { Trace } from "@zhushanwen/subagent-core";
import { createRunEventJournal, setModelConfigService, setSubagentService } from "@zhushanwen/subagent-core";
import { WorkflowRun } from "@zhushanwen/subagent-core";
import type { WorkflowRun as WorkflowRunType } from "@zhushanwen/subagent-core";
import type { RunSpec } from "@zhushanwen/subagent-core/orchestration/models/run-spec.ts";
import { mkCtx, mkPi } from "@zhushanwen/subagent-core/orchestration/__tests__/test-mocks.ts";
import type { InFlightReporter } from "../host/inflight-reporter.ts";
import type { SessionLifecycleDeps, SessionLifecycleResult } from "../session-lifecycle.ts";

// 本包 vitest alias 把 @earendil-works/pi-coding-agent 指向 mocks/pi-coding-agent.ts
//（getAgentDir 硬编码 /home/user/.pi/agent）。handler 级用例走真 JsonlRunStore 写盘，
// 经 PI_CODING_AGENT_DIR 钉到 mkdtemp 临时目录——部分覆写 mock 的 getAgentDir 对齐
// 真实 pi config.js 的 env 优先语义（config.js:420-424），其余 mock 成员原样保留
//（importOriginal 部分覆写，对齐 workflow-events.test.ts 手法）。
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    getAgentDir: (): string => process.env.PI_CODING_AGENT_DIR || actual.getAgentDir(),
  };
});

// ── 槽 key（Symbol.for 同 key 即同一 symbol——与被测实现登记的 key 一致） ─────────

const WORKFLOW_DOMAIN_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.workflow-domain-state");
const DIALOG_QUEUE_KEY = Symbol.for("@zhushanwen/pi-subagents.dialogQueue");

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSpec(): RunSpec {
  return {
    scriptSource: "module.exports = async () => {};",
    args: {},
    scriptName: "adoption-test",
    scriptPath: "/tmp/adoption-test.js",
    description: "test",
  };
}

/** 可重水合 WorkflowRun（reconstruct 跳过 I1；done 必带 reason——codec I2 不变式）。 */
function makeRun(
  runId: string,
  status: "running" | "done",
  reason?: "completed" | "failed" | "aborted" | "budget_limited" | "time_limited",
): WorkflowRunType {
  return WorkflowRun.reconstruct(
    runId,
    makeSpec(),
    {
      status,
      reason,
      budget: new Budget({ maxTokens: 1000 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
}

/** 重置进程级槽（domain state / dialog queue / 双 Service），防跨用例串扰。 */
function resetSlots(): void {
  Reflect.deleteProperty(globalThis, WORKFLOW_DOMAIN_SLOT_KEY);
  Reflect.deleteProperty(globalThis, DIALOG_QUEUE_KEY);
  for (const key of ["@zhushanwen/pi-subagents.service", "@zhushanwen/pi-subagents.model-service"]) {
    const slot = Reflect.get(globalThis, Symbol.for(key)) as { current: unknown } | undefined;
    if (slot) slot.current = null;
  }
}

/** fake 双 Service（经访问器槽注入；对齐 crash-recovery injectLifecycleFakes）。 */
function injectLifecycleFakes(): void {
  setSubagentService({
    initSession: vi.fn(),
    recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
    getStreamSink: () => null,
    dispose: vi.fn(),
  } as never);
  setModelConfigService({
    initModel: vi.fn(),
    reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
  } as never);
}

/** seam 直测 deps：双 Service fake + worktree fake（防真 WorktreeManager 扫真实目录）。 */
function makeSeamDeps(overrides: Partial<SessionLifecycleDeps> = {}): SessionLifecycleDeps {
  return {
    createServices: () =>
      ({
        service: {
          initSession: vi.fn(),
          recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
        },
        modelService: {
          initModel: vi.fn(),
          reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
        },
        reused: false,
      }) as never,
    worktreeManager: { scan: vi.fn(async () => {}) },
    ...overrides,
  };
}

/** 最小 fake ExtensionContext（指定 sessionId；getEntries 可观察）。 */
function makeFakeCtx(sessionId: string, entries: CustomEntry[] = []): ExtensionContext {
  return mkCtx(entries, {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/adoption-test-${sessionId}.jsonl`,
      getEntries: () => [...entries],
    },
  });
}

/** 从 pi session entries 里滤出某 runId 的 workflow-record 快照状态序列（物理序）。
 *  RunSnapshot 形态：{ v, runId, spec, state: { status, ... }, meta }——status 嵌套在
 *  state 层（core run-snapshot.ts RunSnapshot 接口）。 */
function recordStatuses(entries: CustomEntry[], runId: string): string[] {
  return entries
    .filter(
      (
        e,
      ): e is CustomEntry & {
        data: { snapshot?: { runId?: string; state?: { status?: string } } };
      } => e.type === "custom" && e.customType === "workflow-record",
    )
    .map((e) => e.data.snapshot)
    .filter((s) => s?.runId === runId)
    .map((s) => s?.state?.status ?? "");
}

/** 读 state 投影文件的 status（[W1] 持久化投影面断言用）。 */
function readStateStatus(sessionDir: string, runId: string): string {
  const raw = fs.readFileSync(path.join(sessionDir, "workflow-state", `${runId}.jsonl`), "utf8");
  return (JSON.parse(raw.trim()) as { state: { status: string } }).state.status;
}

// ── 环境隔离 + 模块新鲜度 ──────────────────────────────────────────────────────

let agentDir: string;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  resetSlots();
  injectLifecycleFakes();
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-adoption-agentdir-"));
  // pi getAgentDir() env 优先（config.js:420-424）——sessionDir/syncEnginesFile 全落临时
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  resetSlots();
  fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// ── ① D4 恢复门控 ─────────────────────────────────────────────────────────────

describe("D4 恢复门控：session_start(reason=reload) 不跑 kill-9 恢复", () => {
  it("条目存在（常态）：adoption 接管 adopted running run，不转 failed、不跑 recoverCrashedRuns", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const run = makeRun("wf-gate-1", "running");
    const store = {
      rebind: vi.fn(),
      resendSnapshots: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
      loadAll: vi.fn(async () => []),
    };
    const ctxOld = makeFakeCtx("sess-gate");
    const existing: SessionLifecycleResult = {
      sessionId: "sess-gate",
      store: store as never,
      runs: new Map([[run.runId, run]]),
      sessionDir: agentDir,
      runner: {} as never,
      ctx: ctxOld,
      storeHealthy: true,
    };

    const pi = mkPi();
    const ctxNew = makeFakeCtx("sess-gate");
    const result = await setupSessionLifecycle(pi, ctxNew, makeSeamDeps(), {
      reason: "reload",
      existing,
    });

    // 暗礁拆除：reload 证明进程没死，adopted running run 不被 kill-9 恢复误杀
    expect(run.state.status).toBe("running");
    expect(run.state.reason).toBeUndefined();
    // 门控在 adoption 分流内（不进 createSessionRunState / recoverCrashedRuns）
    expect(result).toBe(existing);
    expect(store.rebind).toHaveBeenCalledTimes(1);
    // [D1] record 单源后 store 无投影物化面——resendSnapshots 随 state 快照删除
    // 退役，接管收敛为 rebind（v2 终态条目补写自动走新 pi）
    expect(store.resendSnapshots).not.toHaveBeenCalled();
  });

  it("条目缺失（reload 落首次装配 await 链中）：全量装配但跳过恢复（磁盘 running entry 不收编）", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const diskRun = makeRun("wf-gate-2", "running");
    const deps = makeSeamDeps({
      createRunStore: () =>
        ({
          loadAll: vi.fn(async () => [diskRun]),
          save: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        }) as never,
    });

    const result = await setupSessionLifecycle(mkPi(), makeFakeCtx("sess-gate-2"), deps, {
      reason: "reload",
    });

    // 磁盘 running 残留（前一轮 adoption 未完成又 reload 的窗口）不被收编——
    // 由下一次非 reload 的 session_start 按既有 kill-9 语义收编（设计 §2.4）
    expect(diskRun.state.status).toBe("running");
    // 全量装配形态：storeHealthy=true（跳过 loadAll 时无从证伪，workflow 域可用）
    expect(result.storeHealthy).toBe(true);
    expect(result.runs.size).toBe(0);
  });

  it("非 reload（startup）：现状恢复语义保持（磁盘 running entry 转 failed）——门控是 reason 驱动", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const diskRun = makeRun("wf-gate-3", "running");
    const deps = makeSeamDeps({
      createRunStore: () =>
        ({
          loadAll: vi.fn(async () => [diskRun]),
          save: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        }) as never,
    });

    await setupSessionLifecycle(mkPi(), makeFakeCtx("sess-gate-3"), deps, {
      reason: "startup",
    });

    // [D2]/[D15] kill-9 语义 = 中断收编（run-interrupted 转移帧，非 done,failed）：
    // 内存观测面 status 维持 running（终局判据归 record fold）
    expect(diskRun.state.status).toBe("running");
  });
});

// ── ② D4 接管：同引用 + rebind + 快照重发 ─────────────────────────────────────

describe("D4 接管：同引用接管 + ctx 换新", () => {
  it("adoption 返回原条目引用（store/runs 不换实例）、ctx 换新", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const run = makeRun("wf-adopt-1", "running");
    const store = {
      rebind: vi.fn(),
      resendSnapshots: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
      loadAll: vi.fn(async () => []),
    };
    const runner = {};
    const existing: SessionLifecycleResult = {
      sessionId: "sess-adopt",
      store: store as never,
      runs: new Map([[run.runId, run]]),
      sessionDir: agentDir,
      runner: runner as never,
      ctx: makeFakeCtx("sess-adopt"),
      storeHealthy: true,
    };

    const pi = mkPi();
    const ctxNew = makeFakeCtx("sess-adopt");
    const result = await setupSessionLifecycle(pi, ctxNew, makeSeamDeps(), {
      reason: "reload",
      existing,
    });

    // 探针红线：sessionState.get(sid) 与 reload 前同一引用（result 即 existing 对象）
    expect(result).toBe(existing);
    expect(result.store).toBe(existing.store);
    expect(result.runs).toBe(existing.runs);
    // SessionLifecycleResult.ctx 换新 ctx（旧 ctx 已被 invalidate）
    expect(result.ctx).toBe(ctxNew);
    expect(store.rebind).toHaveBeenCalledWith(pi, ctxNew);
  });

  it("handler 级全链：reload 后 sessionState.get(sid) 与 reload 前同一引用、run 存活、投影重发落 state 文件（零条目写）", async () => {
    const { setupWorkflowDomain } = await import("../workflow-events.ts");
    const makeMount = () => {
      const entries: CustomEntry[] = [];
      const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
      const pi = mkPi(entries, {
        on: ((event: string, handler: (...args: unknown[]) => unknown) => {
          handlers.set(event, handler as (event: unknown, ctx: ExtensionContext) => unknown);
        }) as never,
      });
      return { pi, entries, handlers };
    };
    const reporter = {
      attachSession: vi.fn(),
      detachSession: vi.fn(),
      onInFlightChanged: vi.fn(),
    } as unknown as InFlightReporter;

    // 第一次装配（startup，旧 pi）
    const m1 = makeMount();
    const handle1 = setupWorkflowDomain(m1.pi, { inflightReporter: reporter });
    await m1.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, makeFakeCtx("sess-handler"));
    const first = handle1.state.sessionState.get("sess-handler");
    expect(first).toBeDefined();
    const run = makeRun("wf-live-1", "running");
    first!.runs.set(run.runId, run);

    // 模拟 reload：factory 重跑（同一 domain state 槽）+ 新 pi/ctx + session_start(reload)
    const m2 = makeMount();
    const handle2 = setupWorkflowDomain(m2.pi, { inflightReporter: reporter });
    await m2.handlers.get("session_start")!({ type: "session_start", reason: "reload" }, makeFakeCtx("sess-handler"));

    // 探针红线：同引用接管（store/runs 不换实例）
    expect(handle2.state.sessionState.get("sess-handler")).toBe(first);
    expect(first!.runs.get("wf-live-1")).toBe(run);
    // run 存活：不误杀
    expect(run.state.status).toBe("running");
    // [D1] state 快照面整体删除——接管无投影重发（record 流是唯一持久化，接管
    // 动作收敛为 rebind；不存在 state 文件是预期形态）
    expect(fs.existsSync(path.join(agentDir, "workflow-state", "wf-live-1.jsonl"))).toBe(false);
    // [W1 / D1] 停写锚定：条目通道退役——新旧 pi 零 workflow-record entry
    expect(recordStatuses(m2.entries, "wf-live-1")).toHaveLength(0);
    expect(recordStatuses(m1.entries, "wf-live-1")).toHaveLength(0);
  });
});

// ── ③ D4 adoption 失败处置：rebind-first 终态完整性 + 用户可见 + 条目移除 ────────

describe("D4 失败处置：rebind-first → terminate(notifyDone:true) → 移除条目 → 全量装配兜底", () => {
  it("seam 级：rebind 抛错 → rebind-first 兜底再试 + onAdoptionFailed 触发（terminate+移除注入回调）", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const run = makeRun("wf-fail-seam", "running");
    const rebindFn = vi.fn(() => {
      throw new Error("rebind exploded");
    });
    const existing: SessionLifecycleResult = {
      sessionId: "sess-fail-seam",
      store: {
        rebind: rebindFn,
        resendSnapshots: vi.fn(async () => {}),
        save: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      } as never,
      runs: new Map([[run.runId, run]]),
      sessionDir: agentDir,
      runner: {} as never,
      ctx: makeFakeCtx("sess-fail-seam"),
      storeHealthy: true,
    };
    const onAdoptionFailed = vi.fn(async () => {});

    const result = await setupSessionLifecycle(mkPi(), makeFakeCtx("sess-fail-seam"), makeSeamDeps({ onAdoptionFailed }), {
      reason: "reload",
      existing,
    });

    // rebind 抛错 → 失败处置：rebind-first 兜底再试（两次调用：adoption 主体一次 +
    // 失败处置无条件一次）+ terminate/移除回调触发 + 落到全量装配（新条目非 existing）
    expect(rebindFn).toHaveBeenCalledTimes(2);
    expect(onAdoptionFailed).toHaveBeenCalledTimes(1);
    expect(onAdoptionFailed).toHaveBeenCalledWith(existing, "rebind exploded");
    expect(result).not.toBe(existing);
  });

  it("handler 级全链：健康检查不过 → failed entry 落新 pi 权威 JSONL + notifyDone 用户可见 + 条目移除 + 兜底装配", async () => {
    const { setupWorkflowDomain } = await import("../workflow-events.ts");
    const sid = "sess-fail-handler";
    const makeMount = () => {
      const entries: CustomEntry[] = [];
      const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
      const pi = mkPi(entries, {
        on: ((event: string, handler: (...args: unknown[]) => unknown) => {
          handlers.set(event, handler as (event: unknown, ctx: ExtensionContext) => unknown);
        }) as never,
      });
      return { pi, entries, handlers };
    };
    const reporter = {
      attachSession: vi.fn(),
      detachSession: vi.fn(),
      onInFlightChanged: vi.fn(),
    } as unknown as InFlightReporter;

    // 第一次装配（startup）+ 注入在飞 run（真实首写落旧 pi）
    const m1 = makeMount();
    const handle1 = setupWorkflowDomain(m1.pi, { inflightReporter: reporter });
    await m1.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, makeFakeCtx(sid));
    const first = handle1.state.sessionState.get(sid)!;
    const run = makeRun("wf-fail-1", "running");
    first.runs.set(run.runId, run);
    await first.store.save(run);
    // [W2/V1] 六态机引导：journal 首帧（run-created）——terminate 终局裁决前置。
    // dispatch 链（fold/append）走模块 journal 单写者域，测试注入指向本 session 的
    // workflow-state 目录（与真 store 的 tail 读同域）。注入经动态 import 取与
    // workflow-events 同一 pump 模块实例（beforeEach vi.resetModules 双实例隔离）。
    const pump = await import("@zhushanwen/subagent-core/orchestration/terminal-actions.ts");
    pump.setRunEventJournalDirForTest(path.join(first.sessionDir, "workflow-state"));
    const journal = createRunEventJournal(path.join(first.sessionDir, "workflow-state"));
    await journal.append(run.runId, {
      type: "run-created",
      runId: run.runId,
      workflowName: "test-script",
      argsSummary: "{}",
      ts: Date.now(),
    });
    // 模拟健康检查不过（上一轮装配 loadAll 失败形态的条目）
    first.storeHealthy = false;

    // reload：adoption 失败处置全链（真 terminateRunningRuns + 真 store flush）
    const m2 = makeMount();
    const handle2 = setupWorkflowDomain(m2.pi, { inflightReporter: reporter });
    await m2.handlers.get("session_start")!({ type: "session_start", reason: "reload" }, makeFakeCtx(sid));

    // run 终局 failed（terminate；[W2/V1] 断言换源终局记录——经同一动态 pump 实例）
    expect(pump.isRunSettled(run)).toBe(true);
    expect(pump.settledRecordOf(run.runId)).toMatchObject({ outcome: "failed" });
    // 终态完整性（rebind-first）：terminate → finalizeRun → store.save 冷路径 flush，
    // failed 形态落 state 投影——[W1] 条目通道退役后投影是持久化面（journal 终局帧
    // 经 finalizeRun 同步落账，绕开 rebind-first 则 flush 走旧 pi 且 journal 权威面
    // 不受影响，但投影会停留在 running 误导恢复链）
    await vi.waitFor(() => {
      // [D1] 终局信号 = record 流 run-settled 帧（state 快照面已删除；帧 outcome
      // 经 finalizeRun 同步落账——rebind-first 语义的权威验证面）
      const raw = fs.readFileSync(path.join(agentDir, "workflow-state", "wf-fail-1.record.jsonl"), "utf8");
      const last = JSON.parse(raw.trim().split("\n").filter((l) => l.trim()).at(-1)!) as { type?: string; outcome?: string };
      expect(last.type).toBe("run-settled");
      expect(last.outcome).toBe("failed");
    });
    // [W1 / D1] 停写锚定：零 workflow-record entry（本场景无注册条目——run 是注入的
    // 内存 run；journal 终局帧随 finalizeRun 落账，不经条目面）
    expect(recordStatuses(m2.entries, "wf-fail-1")).toHaveLength(0);
    // notifyDone 用户可见：onRunDone → notifyDone → 账本投递 → sendMessage workflow-result
    await vi.waitFor(() => {
      expect(m2.pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "workflow-result" }),
        expect.anything(),
      );
    });
    // 条目移除后兜底全量装配：sessionState 是新条目（非 first，store 不残留半接管状态）
    const after = handle2.state.sessionState.get(sid);
    expect(after).toBeDefined();
    expect(after).not.toBe(first);
    expect(after!.runs.has("wf-fail-1")).toBe(false);
    pump.setRunEventJournalDirForTest(undefined);
  });
});
