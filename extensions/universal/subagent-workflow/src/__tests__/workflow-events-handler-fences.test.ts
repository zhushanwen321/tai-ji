// workflow-events-handler-fences.test.ts —— handler 围栏验收面（extension 通知域
// 加固审查修复）：
//   ① session_shutdown（quit 族）的 SubagentService.dispose 抛错不阻断后续清理
//      （terminateRunningRuns / store.dispose / sessionState 清除 / dialogQueue
//      .rejectAll 照常执行）+ error 留痕；
//   ② session_start 装配链异常不向 pi 事件分发逃逸（handler 保持不抛）+ error 留痕。
//
// mock 手法对齐 workflow-events-reload-branch.test.ts（session-lifecycle 只 mock
// setupSessionLifecycle；terminateRunningRuns 走深路径 mock；service 槽注入 fake）。
// 测试直入 setupWorkflowDomain（事件族装配 seam 本体），不挂 index.ts。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSetupSessionLifecycle, mockTerminateRunningRuns, loggerFns } = vi.hoisted(() => ({
  mockSetupSessionLifecycle: vi.fn(),
  mockTerminateRunningRuns: vi.fn(async () => {}),
  loggerFns: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../session-lifecycle.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-lifecycle.ts")>();
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

function makeFakeRun(runId: string): WorkflowRun {
  return { runId, spec: {}, state: { status: "running", calls: new Map() } } as never;
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

function makeFakeLifecycleResult(sessionId: string) {
  const ctx = makeCtx(sessionId);
  const run = makeFakeRun(`run-${sessionId}`);
  return {
    result: {
      sessionId,
      store: { dispose: storeDisposeSpy } as never,
      runs: new Map<string, WorkflowRun>([[run.runId, run]]),
      sessionDir: "/tmp/subagent-workflow-handler-fences-test",
      runner: {} as never,
      ctx,
      storeHealthy: true,
    },
    ctx,
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

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  resetSlots();
  setSubagentService({
    initSession: vi.fn(),
    recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
    startGcTimer: vi.fn(),
    getStreamSink: () => null,
    dispose: serviceDisposeSpy,
  } as never);
  Reflect.set(globalThis, DIALOG_QUEUE_KEY, { rejectAll: queueRejectAllSpy });
  setupWorkflowDomain = (await import("../workflow-events.ts")).setupWorkflowDomain;
});

afterEach(() => {
  resetSlots();
});

// ── ① session_shutdown：service.dispose 抛错不阻断后续清理 ─────────────────────

describe("session_shutdown 围栏：SubagentService.dispose 抛错不阻断后续清理", () => {
  it("dispose 同步抛错 → terminate/store.dispose/条目清除/rejectAll 照常执行 + error 留痕（含 sessionId）", async () => {
    const { handle, handlers } = mount();
    const { result, ctx } = makeFakeLifecycleResult("sess-dispose-boom");
    mockSetupSessionLifecycle.mockResolvedValue(result);
    await handlers.get("session_start")!({ type: "session_start" }, ctx);
    expect(handle.state.sessionState.size).toBe(1); // 前置：条目已装配

    // dispose 同步抛错（多步同步链中段失败的形态）
    serviceDisposeSpy.mockImplementation(() => {
      throw new Error("dispose boom: engine handle already closed");
    });

    // handler 本身不向 pi 事件分发逃逸（不 reject）
    await expect(
      handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx),
    ).resolves.toBeUndefined();

    // 后续清理全部执行
    expect(mockTerminateRunningRuns).toHaveBeenCalledTimes(1);
    expect(storeDisposeSpy).toHaveBeenCalledTimes(1);
    expect(handle.state.sessionState.size).toBe(0);
    expect(queueRejectAllSpy).toHaveBeenCalledTimes(1);
    expect(reporterDetachSpy).toHaveBeenCalledTimes(1);
    // error 级留痕（含 sessionId，可检索）
    expect(loggerFns.error).toHaveBeenCalledWith(
      "[subagent-workflow] session_shutdown SubagentService.dispose failed (sessionId=sess-dispose-boom)",
      { reason: "dispose boom: engine handle already closed" },
    );
  });
});

// ── ② session_start：装配链异常不向 pi 事件分发逃逸 ────────────────────────────

describe("session_start 围栏：装配链异常不逃逸", () => {
  it("setupSessionLifecycle reject → handler 保持不抛 + error 留痕（含 sessionId），sessionState 不残留半装配条目", async () => {
    const { handle, handlers } = mount();
    const ctx = makeCtx("sess-start-boom");
    mockSetupSessionLifecycle.mockRejectedValue(new Error("store init failed"));

    await expect(
      handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx),
    ).resolves.toBeUndefined();

    expect(loggerFns.error).toHaveBeenCalledWith(
      "[subagent-workflow] session_start handler failed (sessionId=sess-start-boom)",
      { reason: "store init failed" },
    );
    expect(handle.state.sessionState.size).toBe(0);
  });
});
