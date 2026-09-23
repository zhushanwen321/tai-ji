// workflow-events-reload-branch.test.ts —— B1 单元验收面（skill-reload-nondestructive
// 设计 D1/D2/D8）：
//   ① D1：session_shutdown 按 reason 分支——reload 跳过破坏性动作 a/c/d/e/f
//      （service dispose / terminateRunningRuns / store.dispose / sessionState 清除 /
//      dialogQueue.rejectAll），保留 b（inflightReporter.detachSession）；
//   ② D1：quit 族（quit/new/resume/fork）六动作现状全执行——真会话离开不因
//      reason 分支误跳过（S5 防过度保全）；
//   ③ D2：WorkflowDomainState 提权 globalThis Symbol 槽——factory 重跑（含模拟
//      pi reload 模块重求值）拿到同一 domain state 引用（adoption 接管前提）；
//   ④ D8：reload 分支 preserved 归因日志（数字来自 sessionState 域状态真实统计）。
//
// mock 手法对齐 inflight-wiring.test.ts：session-lifecycle 只 mock
// setupSessionLifecycle（sessionState 填充入口受控），getOrCreateDialogQueue 保留
// 真实实现（经 DIALOG_QUEUE_KEY 槽注入 spy queue——同时覆盖「queue 槽被 get-or-create
// 返回」的真实路径）；terminateRunningRuns 走深路径 mock；service 槽注入 fake。
// 测试直入 setupWorkflowDomain（事件族装配 seam 本体），不挂 index.ts。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSetupSessionLifecycle, mockTerminateRunningRuns, loggerFns } = vi.hoisted(() => ({
  mockSetupSessionLifecycle: vi.fn(),
  mockTerminateRunningRuns: vi.fn(async () => {}),
  loggerFns: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../session-lifecycle.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-lifecycle.ts")>();
  // getOrCreateDialogQueue 保留真实实现：走 DIALOG_QUEUE_KEY globalThis 槽，
  // 测试经槽注入 spy queue（覆盖真实 get-or-create 路径，非 mock 短路）。
  return { ...actual, setupSessionLifecycle: mockSetupSessionLifecycle };
});

vi.mock("@zhushanwen/subagent-core/orchestration/lifecycle.ts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@zhushanwen/subagent-core/orchestration/lifecycle.ts")
  >();
  return { ...actual, terminateRunningRuns: mockTerminateRunningRuns };
});

vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => loggerFns,
  setPiHandle: vi.fn(),
}));

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import { setSubagentService } from "@zhushanwen/subagent-core";
import type { InFlightReporter } from "../host/inflight-reporter.ts";
import type { WorkflowDomainHandle } from "../workflow-events.ts";

// 槽 key（Symbol.for 同 key 即同一 symbol——与被测实现登记的 key 一致）
const WORKFLOW_DOMAIN_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.workflow-domain-state");
const DIALOG_QUEUE_KEY = Symbol.for("@zhushanwen/pi-subagents.dialogQueue");
const SERVICE_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.service");

// ── fake 组件 ──────────────────────────────────────────────────────────────────

const serviceDisposeSpy = vi.fn();
const storeDisposeSpy = vi.fn(async () => {});
const queueRejectAllSpy = vi.fn();
const reporterAttachSpy = vi.fn();
const reporterDetachSpy = vi.fn();

/** 最小 fake run：preserved 统计只访问 runId + state.calls（口径见实现注释）。 */
function makeFakeRun(runId: string, callCount: number): WorkflowRun {
  const calls = new Map<number, unknown>();
  for (let i = 1; i <= callCount; i += 1) calls.set(i, {});
  return { runId, spec: {}, state: { status: "running", calls } } as never;
}

function makeCtx(sessionId: string): ExtensionContext {
  return {
    cwd: "/home/user/project",
    mode: "rpc",
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    model: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/home/user/.pi/agent/sessions/${sessionId}.jsonl`,
      getEntries: () => [],
    },
    ui: { select: vi.fn() },
  } as unknown as ExtensionContext;
}

/** 装配受控 sessionState 条目：1 session × 1 run × callCount 个 agent call。 */
function makeFakeLifecycleResult(sessionId: string, callCount: number) {
  const ctx = makeCtx(sessionId);
  const run = makeFakeRun(`run-${sessionId}`, callCount);
  const runs = new Map<string, WorkflowRun>([[run.runId, run]]);
  return {
    result: {
      sessionId,
      store: { dispose: storeDisposeSpy } as never,
      runs,
      sessionDir: "/tmp/subagent-workflow-reload-branch-test",
      runner: {} as never,
      ctx,
      storeHealthy: true,
    },
    run,
  };
}

function makeReporter(): InFlightReporter {
  return {
    attachSession: reporterAttachSpy,
    detachSession: reporterDetachSpy,
    onInFlightChanged: vi.fn(),
  } as unknown as InFlightReporter;
}

function makePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
} {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler as (event: unknown, ctx: ExtensionContext) => unknown);
    },
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

let setupWorkflowDomain: typeof import("../workflow-events.ts").setupWorkflowDomain;

function mount(): { handle: WorkflowDomainHandle; handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown> } {
  const { pi, handlers } = makePi();
  const handle = setupWorkflowDomain(pi, { inflightReporter: makeReporter() });
  return { handle, handlers };
}

// ── 槽隔离（防跨测试 / 跨测试文件串扰——提权后槽是进程级共享态） ────────────────

function resetSlots(): void {
  Reflect.deleteProperty(globalThis, WORKFLOW_DOMAIN_SLOT_KEY);
  Reflect.deleteProperty(globalThis, DIALOG_QUEUE_KEY);
  const serviceSlot = Reflect.get(globalThis, SERVICE_SLOT_KEY) as { current: unknown } | undefined;
  if (serviceSlot) serviceSlot.current = null;
}

function injectFakeService(): void {
  setSubagentService({
    initSession: vi.fn(),
    recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
    startGcTimer: vi.fn(),
    getStreamSink: () => null,
    dispose: serviceDisposeSpy,
  } as never);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetSlots();
  injectFakeService();
  Reflect.set(globalThis, DIALOG_QUEUE_KEY, { rejectAll: queueRejectAllSpy });
  setupWorkflowDomain = (await import("../workflow-events.ts")).setupWorkflowDomain;
});

afterEach(() => {
  resetSlots();
});

// ── ① D1：reload 分支 ─────────────────────────────────────────────────────────

describe("D1 session_shutdown reason=reload：破坏性动作全跳过，adoption 前提保全", () => {
  it("reload：a/c/d/e/f 五动作未被调用、b（detachSession）仍执行、preserved 归因日志发出且计数真实", async () => {
    const { handle, handlers } = mount();
    const { run } = makeFakeLifecycleResult("sess-reload", 2);
    mockSetupSessionLifecycle.mockResolvedValue({
      sessionId: "sess-reload",
      store: { dispose: storeDisposeSpy } as never,
      runs: new Map([[run.runId, run]]),
      sessionDir: "/tmp/subagent-workflow-reload-branch-test",
      runner: {} as never,
      ctx: makeCtx("sess-reload"),
      storeHealthy: true,
    });
    await handlers.get("session_start")!({ type: "session_start" }, makeCtx("sess-reload"));
    expect(handle.state.sessionState.size).toBe(1); // 前置：条目已装配

    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, makeCtx("sess-reload"));

    // a：SubagentService 不 dispose（dispose 会经 abort 链杀引擎/relay/子进程）
    expect(serviceDisposeSpy).not.toHaveBeenCalled();
    // c：workflow 域内存不终态化
    expect(mockTerminateRunningRuns).not.toHaveBeenCalled();
    // d：store 不关闸（去抖批 + 权威 entry 链保持存活）
    expect(storeDisposeSpy).not.toHaveBeenCalled();
    // e：sessionState 条目保留（adoption 接管前提——同 run 对象仍在 Map 内）
    expect(handle.state.sessionState.size).toBe(1);
    expect(handle.state.sessionState.get("sess-reload")?.runs.get("run-sess-reload")).toBe(run);
    // f：pending dialog 不被全量拒绝（在飞 ask-user 属于在飞工作）
    expect(queueRejectAllSpy).not.toHaveBeenCalled();
    // b：reporter detach 仍执行（detach 不是破坏，防旧 reporter 持 stale ctx 重试）
    expect(reporterDetachSpy).toHaveBeenCalledTimes(1);
    // D8：preserved 归因日志——数字来自 sessionState 真实统计（1 run / 2 call / 1 store）
    expect(loggerFns.debug).toHaveBeenCalledWith(
      "[workflow-events] session_shutdown reason=reload preserved={runs:1, records:2, stores:1}",
    );
  });

  it("reload：空 sessionState（无在飞工作）时 preserved 计数为 0，日志仍发出", async () => {
    const { handlers } = mount();
    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, makeCtx("sess-empty"));
    expect(loggerFns.debug).toHaveBeenCalledWith(
      "[workflow-events] session_shutdown reason=reload preserved={runs:0, records:0, stores:0}",
    );
    expect(reporterDetachSpy).toHaveBeenCalledTimes(1);
  });
});

// ── ② D1：quit 族现状保持（S5 防过度保全） ─────────────────────────────────────

describe("D1 session_shutdown quit 族：六动作现状全执行", () => {
  it("quit：dispose + terminate + store.dispose + sessionState 清空 + detachSession + rejectAll 全部执行", async () => {
    const { handle, handlers } = mount();
    const { result } = makeFakeLifecycleResult("sess-quit", 2);
    mockSetupSessionLifecycle.mockResolvedValue(result);
    await handlers.get("session_start")!({ type: "session_start" }, result.ctx);
    expect(handle.state.sessionState.size).toBe(1);

    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, result.ctx);

    expect(serviceDisposeSpy).toHaveBeenCalledTimes(1);
    expect(mockTerminateRunningRuns).toHaveBeenCalledTimes(1);
    expect(storeDisposeSpy).toHaveBeenCalledTimes(1);
    expect(handle.state.sessionState.size).toBe(0);
    expect(reporterDetachSpy).toHaveBeenCalledTimes(1);
    expect(queueRejectAllSpy).toHaveBeenCalledTimes(1);
  });

  it.each(["new", "resume", "fork"] as const)(
    "reason=%s：与 quit 同路径（terminate + dispose + 清空 + rejectAll 执行）",
    async (reason) => {
      const { handle, handlers } = mount();
      const { result } = makeFakeLifecycleResult(`sess-${reason}`, 1);
      mockSetupSessionLifecycle.mockResolvedValue(result);
      await handlers.get("session_start")!({ type: "session_start" }, result.ctx);

      await handlers.get("session_shutdown")!({ type: "session_shutdown", reason }, result.ctx);

      expect(serviceDisposeSpy).toHaveBeenCalledTimes(1);
      expect(mockTerminateRunningRuns).toHaveBeenCalledTimes(1);
      expect(storeDisposeSpy).toHaveBeenCalledTimes(1);
      expect(handle.state.sessionState.size).toBe(0);
      expect(queueRejectAllSpy).toHaveBeenCalledTimes(1);
    },
  );
});

// ── ③ D2：WorkflowDomainState 提权槽 ───────────────────────────────────────────

describe("D2 WorkflowDomainState 提权：factory 重跑拿到同一 domain state 引用", () => {
  it("同模块两次 setupWorkflowDomain：state 对象与五个成员（lsRef/notifiedRunIds/sessionState/workerHost/registry）均同引用", () => {
    const first = setupWorkflowDomain(makePi().pi, { inflightReporter: makeReporter() });
    const second = setupWorkflowDomain(makePi().pi, { inflightReporter: makeReporter() });

    expect(second.state).toBe(first.state);
    expect(second.state.lsRef).toBe(first.state.lsRef);
    expect(second.state.notifiedRunIds).toBe(first.state.notifiedRunIds);
    expect(second.state.sessionState).toBe(first.state.sessionState);
    expect(second.state.workerHost).toBe(first.state.workerHost);
    expect(second.state.registry).toBe(first.state.registry);
  });

  it("模拟 pi reload 模块重求值（vi.resetModules + 重新 import）后 setupWorkflowDomain 仍拿到同一引用", async () => {
    const first = setupWorkflowDomain(makePi().pi, { inflightReporter: makeReporter() });

    vi.resetModules();
    const { setupWorkflowDomain: freshSetup } = await import("../workflow-events.ts");
    const second = freshSetup(makePi().pi, { inflightReporter: makeReporter() });

    expect(second.state).toBe(first.state);
    // 模块重求值后新代码拿到的 state 已在 globalThis 槽上（非新建）
    expect(Reflect.get(globalThis, WORKFLOW_DOMAIN_SLOT_KEY)).toBe(first.state);
  });

  it("槽上的 sessionState 在 reload 模块重求值后仍可读到原条目（adoption 数据前提）", async () => {
    const { handle, handlers } = mount();
    const { result, run } = makeFakeLifecycleResult("sess-slot-survive", 1);
    mockSetupSessionLifecycle.mockResolvedValue(result);
    await handlers.get("session_start")!({ type: "session_start" }, result.ctx);

    vi.resetModules();
    const { setupWorkflowDomain: freshSetup } = await import("../workflow-events.ts");
    const freshHandle = freshSetup(makePi().pi, { inflightReporter: makeReporter() });

    expect(freshHandle.state.sessionState.get("sess-slot-survive")?.runs.get("run-sess-slot-survive")).toBe(run);
  });
});
