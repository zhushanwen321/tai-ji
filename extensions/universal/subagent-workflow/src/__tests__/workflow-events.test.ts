// workflow-events.test.ts —— workflow-events 域测试合并文件（按生产模块归属分域）：
//   ① D3 makeDeps volatile 现读（pi 切换后旧 deps 解析到新 pi）+ GuiContext 现读 +
//      currentPi 登记点 + lazyDeps 语义 + workflowAgentDispatch 转发成员；
//   ② D1 session_shutdown reason 分支（reload 跳过破坏性动作 / quit 族全执行）+
//      D2 WorkflowDomainState 提权 globalThis 槽；
//   ③ handler 围栏（session_shutdown 的 dispose 抛错不阻断清理 / session_start
//      装配链异常不逃逸）；
//   ④ runSettledEffects 四步终局副作用管线直测；
//   ⑤ setupWorkflowDomain pi.on 注册顺序锁（逐位不变契约）；
//   ⑥ 组合根薄接线（registerWorkflowsCommand 第三参 lazyDeps.onRunDone → 真实
//      runSettledEffects 管线，session_start 装配域行为的完整重放由 session-lifecycle
//      域与 run-settled 直测共同权威，此处只锁接线不重放行为）。
//
// mock 集调和（合并文件统一 mock 面）：
//   - session-lifecycle 只 mock setupSessionLifecycle（sessionState 填充入口受控，
//     getOrCreateDialogQueue 保留真实实现——经 DIALOG_QUEUE_KEY 槽注入 spy queue）；
//   - terminateRunningRuns 走深路径 mock（barrel re-export 命中同一物理模块）；对
//     runSettledEffects 直测用例惰性（不在其调用链）；
//   - logger mock 隔离日志行为（notify ledger 槽显式清空保证 notifyDone 走降级直发
//     路径，pi.sendMessage 可断言，不受同 worker 先跑测试文件的槽串扰影响）；
//   - interface/commands mock 只为组合根薄接线捕获第三参，对直入 setupWorkflowDomain
//     的用例惰性。
//   ⑤注册顺序锁不 mock 兄弟模块（注册期不执行 handler 体）；④runSettledEffects
//   直测零功能 mock（notifyDone/trackNotifiedRunId/evictDoneRunsBeyondCap 均真实实现）。
//   测试直入 setupWorkflowDomain（事件族装配 seam 本体），除⑥外不挂 index.ts。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSetupSessionLifecycle,
  mockTerminateRunningRuns,
  loggerFns,
  mockRegisterWorkflowsCommand,
} = vi.hoisted(() => ({
  mockSetupSessionLifecycle: vi.fn(),
  mockTerminateRunningRuns: vi.fn(async () => {}),
  loggerFns: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  mockRegisterWorkflowsCommand: vi.fn(),
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

// 组合根薄接线（⑥）专用：registerWorkflowsCommand 打桩捕获第三参 lazyDeps。
vi.mock("../interface/commands.ts", () => ({
  registerWorkflowsCommand: mockRegisterWorkflowsCommand,
}));

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_RETAINED_DONE_RUNS } from "@zhushanwen/subagent-core";
import type { LauncherDeps, WorkflowRun } from "@zhushanwen/subagent-core";
import { setSubagentService } from "@zhushanwen/subagent-core";
import type { InFlightReporter } from "../host/inflight-reporter.ts";
import type { WorkflowDomainHandle } from "../workflow-events.ts";
import { runSettledEffects, type RunSettledEffectsEnv } from "../workflow-events.ts";

// 槽 key（Symbol.for 同 key 即同一 symbol——与被测实现登记的 key 一致）
const WORKFLOW_DOMAIN_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.workflow-domain-state");
const DIALOG_QUEUE_KEY = Symbol.for("@zhushanwen/pi-subagents.dialogQueue");
const SERVICE_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.service");
// notify ledger 槽（notify-ledger.ts NOTIFY_LEDGER_SLOT_KEY）：清空保证降级直发路径
const NOTIFY_LEDGER_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.notifyLedger");

// ── fake 组件（合并去重：makePi/makeCtx/makeReporter/resetSlots/mount 各一处定义） ──

const serviceDisposeSpy = vi.fn();
const storeDisposeSpy = vi.fn(async () => {});
const queueRejectAllSpy = vi.fn();
const reporterAttachSpy = vi.fn();
const reporterDetachSpy = vi.fn();

/** notifyDone 降级直发的 pi.sendMessage 首参形状（workflow-notify.ts WorkflowNotifyDetails）。 */
type SentMessage = {
  customType: string;
  content: string;
  display: boolean;
  details: {
    runId: string;
    notifyId: string;
  };
};

function sentMessages(pi: ExtensionAPI): SentMessage[] {
  const fn = pi.sendMessage as unknown as { mock: { calls: [SentMessage, unknown][] } };
  return fn.mock.calls.map(([message]) => message);
}

type FakeRunShape = {
  runId: string;
  status?: string;
  reason?: string;
  startedAt?: string;
  completedAt?: string;
  /** state.calls 预置条数（preserved 归因统计的 records 口径）。 */
  callCount?: number;
  scriptResult?: unknown;
};

/** 统一 WorkflowRun 构造：notifyDone 读 trace/spec/scriptResult/calls，evict 读
 *  status/completedAt（meta.completedAt 缺省 = evict 排序不感知），preserved 统计读
 *  runId + state.calls。 */
function makeRun(shape: FakeRunShape): WorkflowRun {
  const calls = new Map<number, unknown>();
  for (let i = 1; i <= (shape.callCount ?? 0); i += 1) calls.set(i, {});
  return {
    runId: shape.runId,
    spec: {},
    state: {
      status: shape.status ?? "running",
      reason: shape.reason,
      scriptResult: shape.scriptResult,
      calls,
      trace: { toArray: () => [] },
    },
    meta: {
      startedAt: shape.startedAt ?? new Date(0).toISOString(),
      completedAt: shape.completedAt,
    },
  } as unknown as WorkflowRun;
}

/** mode 是 GuiContext 面的唯一判定维度（isGuiCapable = mode==='rpc'）——
 *  tui 门控在飞上报等 rpc-only 行为（组合根接线测试用 tui 防重试 timer 悬挂）。 */
function makeCtx(sessionId: string, mode: "rpc" | "tui" = "rpc"): ExtensionContext {
  return {
    cwd: "/home/user/project",
    mode,
    hasUI: mode === "rpc",
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

/** 装配受控 sessionState 条目：store 带 settledRecordOf completed 形态（onRunDone
 *  管线的 notifyDone 步骤真实发通知）。 */
function makeLifecycleResult(
  sessionId: string,
  opts: { mode?: "rpc" | "tui"; runs?: WorkflowRun[] } = {},
) {
  const ctx = makeCtx(sessionId, opts.mode ?? "rpc");
  const runs = new Map<string, WorkflowRun>((opts.runs ?? []).map((r) => [r.runId, r] as const));
  const result = {
    sessionId,
    store: {
      dispose: storeDisposeSpy,
      settledRecordOf: () => ({ outcome: "completed", settledAt: 0 }),
    } as never,
    runs,
    sessionDir: "/tmp/subagent-workflow-test",
    runner: {} as never,
    ctx,
    storeHealthy: true,
  };
  return { result, ctx, runs };
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
    registerMessageRenderer: vi.fn(),
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

type HandlerMap = Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;

/** 挂载（只装配事件族，不触发 session_start）——围栏 / 提权槽 / 注册顺序用。 */
function mount(): { handle: WorkflowDomainHandle; handlers: HandlerMap } {
  const { pi, handlers } = makePi();
  const handle = setupWorkflowDomain(pi, { inflightReporter: makeReporter() });
  return { handle, handlers };
}

/** 挂载 + session_start 装配受控条目（getWorkflowDeps 守卫要求条目 + storeHealthy）。 */
async function mountWithSession(
  sessionId: string,
  opts: { mode?: "rpc" | "tui"; runs?: WorkflowRun[] } = {},
): Promise<{
  pi: ExtensionAPI;
  handle: WorkflowDomainHandle;
  handlers: HandlerMap;
  deps: LauncherDeps;
  ctx: ExtensionContext;
  runs: Map<string, WorkflowRun>;
}> {
  const { pi, handlers } = makePi();
  const { result, ctx, runs } = makeLifecycleResult(sessionId, opts);
  mockSetupSessionLifecycle.mockResolvedValue(result);
  const handle = setupWorkflowDomain(pi, { inflightReporter: makeReporter() });
  await handlers.get("session_start")!({ type: "session_start" }, ctx);
  const resolution = handle.getWorkflowDeps(sessionId);
  if (!resolution.ok) throw new Error(`getWorkflowDeps failed: ${resolution.reason}`);
  return { pi, handle, handlers, deps: resolution.deps, ctx, runs };
}

// ── 槽隔离（提权后槽是进程级共享态，防跨用例 / 跨测试文件串扰） ────────────────

function resetSlots(): void {
  for (const key of [WORKFLOW_DOMAIN_SLOT_KEY, DIALOG_QUEUE_KEY, NOTIFY_LEDGER_SLOT_KEY]) {
    Reflect.deleteProperty(globalThis, key);
  };
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

// ── ① D3：三面现读——pi 切换后旧 deps 解析到新 pi ─────────────────────────────

describe("D3 makeDeps volatile 现读：pi 切换（模拟 reload factory 重跑）后旧 deps 解析到新 pi", () => {
  it("eventBus：旧 deps 对象在 factory 重跑后经属性访问解析到新 pi.events（切换前基线 = 旧 pi）", async () => {
    const { pi: pi1, deps } = await mountWithSession("sess-evbus");
    expect(deps.eventBus).toBe(pi1.events); // 切换前正常解析（非 getter 破坏）

    const { pi: pi2 } = makePi();
    setupWorkflowDomain(pi2, { inflightReporter: makeReporter() }); // 模拟 reload 后 factory 重跑

    expect(deps.eventBus).toBe(pi2.events); // 旧 deps 现读到新 pi
    expect(deps.eventBus).not.toBe(pi1.events);
  });

  it("log：旧 deps.log 的 workflow:log entry 落新 pi.appendEntry，旧 pi 不再被调", async () => {
    const { pi: pi1, deps } = await mountWithSession("sess-log");
    deps.log?.("debug", "test:component", "before reload", { phase: 1 });
    expect(pi1.appendEntry).toHaveBeenCalledTimes(1); // 切换前正常写入旧 pi

    const { pi: pi2 } = makePi();
    setupWorkflowDomain(pi2, { inflightReporter: makeReporter() });

    deps.log?.("debug", "test:component", "after reload", { phase: 2 });
    expect(pi2.appendEntry).toHaveBeenCalledWith(
      "workflow:log",
      expect.objectContaining({
        level: "debug",
        component: "test:component",
        message: "after reload",
        data: { phase: 2 },
      }),
    );
    expect(pi1.appendEntry).toHaveBeenCalledTimes(1); // 旧 pi 计数不增长 = 不再被调
    expect(pi2.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("onRunDone：完成通知经新 pi.sendMessage 送出（workflow-result 通道），旧 pi 不再被调", async () => {
    const { pi: pi1, deps } = await mountWithSession("sess-done");
    const { pi: pi2 } = makePi();
    setupWorkflowDomain(pi2, { inflightReporter: makeReporter() });

    deps.onRunDone?.(makeRun({ runId: "run-after-reload", status: "done", scriptResult: { ok: true } }));

    const messages = sentMessages(pi2);
    expect(messages).toHaveLength(1);
    expect(messages[0].customType).toBe("workflow-result");
    expect(messages[0].display).toBe(true);
    expect(messages[0].details.runId).toBe("run-after-reload");
    expect(sentMessages(pi1)).toHaveLength(0); // 旧 pi 零调用
  });
});

// ── ① D3：currentPi 登记点 ─────────────────────────────────────────────────────

describe("D3 currentPi 登记点：factory 重跑覆盖槽上 volatile 绑定", () => {
  it("setupWorkflowDomain 重跑后同一 domain state 的 currentPi 换新（登记点即 reload 更新点）", async () => {
    const { pi: pi1, handle } = await mountWithSession("sess-reg");
    expect(handle.state.currentPi).toBe(pi1);

    const { pi: pi2 } = makePi();
    const handle2 = setupWorkflowDomain(pi2, { inflightReporter: makeReporter() });

    expect(handle2.state).toBe(handle.state); // B1 D2 前提：同槽同对象
    expect(handle.state.currentPi).toBe(pi2);
  });
});

// ── ① lazyDeps 语义不回归 ─────────────────────────────────────────────────────

describe("lazyDeps 语义不回归：属性访问经 getWorkflowDeps → makeDeps 现读链路", () => {
  it("pi 切换后经 lazyDeps 的 eventBus/log/onRunDone 属性访问同样解析新 pi", async () => {
    const { pi: pi1, handle } = await mountWithSession("sess-lazy");
    expect(handle.lazyDeps.eventBus).toBe(pi1.events); // 守卫 + 转发语义不变（切换前）

    const { pi: pi2 } = makePi();
    setupWorkflowDomain(pi2, { inflightReporter: makeReporter() });

    expect(handle.lazyDeps.eventBus).toBe(pi2.events); // lazy 链路同样现读新 pi
    handle.lazyDeps.log?.("debug", "lazy", "after reload");
    expect(pi2.appendEntry).toHaveBeenCalledTimes(1);
    expect(pi1.appendEntry).not.toHaveBeenCalled();
  });
});

// ── ① [A1 修复循环 R3] lazyDeps.workflowAgentDispatch 转发成员 ──────────────────
//
// 生产缺口实证（真机 wf-1790034646281-w7tp4f，R2 裁决）：lazyDeps 漏本成员时
// workflow tool 的 run action 以 lazyDeps 启动 run → pump dispatchAgentCall 读到
// undefined 静默回退 deps.runner（SAR.run 占位 runId）→ record.parentRunId =
// "sar-unattached" → armed 回执落账键错 → fold 出 created → IllegalTransitionError
// 让位，run journal 恒缺 armed 帧。守卫同源与转发契约锁定（真实回归豁免面）。

describe("lazyDeps.workflowAgentDispatch 转发成员（[A1 R3] 缺失 = pump 回退 SAR 占位 runId）", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, SERVICE_SLOT_KEY);
  });

  it("守卫同源：session 未初始化时属性访问 throw 'Session not initialized'（与 store 等成员同消息）", async () => {
    const { pi } = makePi();
    const handle = setupWorkflowDomain(pi, { inflightReporter: makeReporter() }); // 无 session_start
    expect(() => handle.lazyDeps.workflowAgentDispatch).toThrowError("Session not initialized");
  });

  it("转发契约：调用即透传 (opts, parentRunId, signal, stepIndex) 到 SubagentService.executeWorkflowAgent 并直通返回值", async () => {
    const { handle } = await mountWithSession("sess-dispatch-forward");
    const executeWorkflowAgent = vi.fn(async () => ({ content: "ok" }));
    // service 进程单例槽（service-bootstrap.ts Symbol.for 槽，{ current } 形态）注入
    // fake——生产 session_start 后真实单例在位，此处只验证闭包转发面。
    Reflect.set(globalThis, SERVICE_SLOT_KEY, {
      current: { executeWorkflowAgent, dispose: vi.fn() },
    });

    const dispatch = handle.lazyDeps.workflowAgentDispatch;
    if (!dispatch) throw new Error("lazyDeps.workflowAgentDispatch missing (regression to R2 gap)");
    const opts = { prompt: "调研 A", description: "research-a" };
    const signal = new AbortController().signal;
    // [W0 / D1] stepIndex 尾参（undefined, undefined = onEvent/stream 占位）随契约透传
    const result = await dispatch(opts, "wf-real-run", signal, 5);

    expect(executeWorkflowAgent).toHaveBeenCalledTimes(1);
    expect(executeWorkflowAgent).toHaveBeenCalledWith(opts, "wf-real-run", signal, undefined, undefined, 5);
    expect(result).toEqual({ content: "ok" });
  });
});

// ── ② D1：reload 分支 ─────────────────────────────────────────────────────────

describe("D1 session_shutdown reason=reload：破坏性动作全跳过，adoption 前提保全", () => {
  it("reload：a/c/d/e/f 五动作未被调用、b（detachSession）仍执行、preserved 归因日志发出且计数真实", async () => {
    const run = makeRun({ runId: "run-sess-reload", callCount: 2 });
    const { handle, handlers, ctx } = await mountWithSession("sess-reload", { runs: [run] });
    expect(handle.state.sessionState.size).toBe(1); // 前置：条目已装配

    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctx);

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

// ── ② D1：quit 族现状保持（S5 防过度保全） ────────────────────────────────────

describe("D1 session_shutdown quit 族：六动作现状全执行", () => {
  it("quit：dispose + terminate + store.dispose + sessionState 清空 + detachSession + rejectAll 全部执行", async () => {
    const { handle, handlers, ctx } = await mountWithSession("sess-quit", {
      runs: [makeRun({ runId: "run-sess-quit", callCount: 2 })],
    });
    expect(handle.state.sessionState.size).toBe(1);

    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);

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
      const { handle, handlers, ctx } = await mountWithSession(`sess-${reason}`, {
        runs: [makeRun({ runId: `run-sess-${reason}`, callCount: 1 })],
      });

      await handlers.get("session_shutdown")!({ type: "session_shutdown", reason }, ctx);

      expect(serviceDisposeSpy).toHaveBeenCalledTimes(1);
      expect(mockTerminateRunningRuns).toHaveBeenCalledTimes(1);
      expect(storeDisposeSpy).toHaveBeenCalledTimes(1);
      expect(handle.state.sessionState.size).toBe(0);
      expect(queueRejectAllSpy).toHaveBeenCalledTimes(1);
    },
  );
});

// ── ② D2：WorkflowDomainState 提权槽 ─────────────────────────────────────────

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
    const { handle } = await mountWithSession("sess-slot-survive", {
      runs: [makeRun({ runId: "run-sess-slot-survive", callCount: 1 })],
    });

    vi.resetModules();
    const { setupWorkflowDomain: freshSetup } = await import("../workflow-events.ts");
    const freshHandle = freshSetup(makePi().pi, { inflightReporter: makeReporter() });

    expect(
      freshHandle.state.sessionState.get("sess-slot-survive")?.runs.get("run-sess-slot-survive"),
    ).toBeDefined();
  });
});

// ── ③ session_shutdown：service.dispose 抛错不阻断后续清理 ────────────────────

describe("session_shutdown 围栏：SubagentService.dispose 抛错不阻断后续清理", () => {
  it("dispose 同步抛错 → terminate/store.dispose/条目清除/rejectAll 照常执行 + error 留痕（含 sessionId）", async () => {
    const { handle, handlers, ctx } = await mountWithSession("sess-dispose-boom", {
      runs: [makeRun({ runId: "run-sess-dispose-boom", callCount: 1 })],
    });
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

// ── ③ session_start：装配链异常不向 pi 事件分发逃逸 ───────────────────────────

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

// ── ④ runSettledEffects：三步固定顺序直测 ─────────────────────────────────────
//
// 管线原是 makeDeps 闭包内嵌策略（顺序固化无独立测试面），提级具名导出后在此
// 直测：不挂 fake pi 全装配、不挂 index.ts、不 mock 兄弟功能模块（notifyDone /
// trackNotifiedRunId / evictDoneRunsBeyondCap 均真实实现）——只注入 fake env
//（最小发送面 pi / 真 Set / 真 runs Map）。
//
// 三步顺序的可观测钉法：
// - step1（notifyDone 的 sendMessage）经步进哨兵数组记录；
// - step1 失败（中途失败分支）时 step2（track）与 step3（evict）不发生
//   ——证明 2/3 排在 1 之后；
// - 成功分支断言 step2（notifiedRunIds 纳入）与 step3（runs 淘汰）均已执行。
//
// notifyDone 走降级直发路径（ledger 槽未 bind → getBoundNotifyLedger() 为
// undefined）；stale 判定依据 ext-guards STALE_CTX_MARKER 文案子串，测试注入的
// 失败错误消息不含该串 → guardStaleCtx 判非 stale 原样上抛（真实语义）。

type EnvHarness = {
  env: RunSettledEffectsEnv;
  seq: string[];
  notifiedRunIds: Set<string>;
  runs: Map<string, WorkflowRun>;
  sendMessage: ReturnType<typeof vi.fn>;
  failSend: (err: Error) => void;
};

function makeEnv(): EnvHarness {
  const seq: string[] = [];
  const sendMessage = vi.fn(() => {
    seq.push("1:notifyDone(sendMessage)");
    return true;
  });
  const pi = { sendMessage } as unknown as ExtensionAPI;
  const notifiedRunIds = new Set<string>();
  const runs = new Map<string, WorkflowRun>();
  const env: RunSettledEffectsEnv = {
    resolvePi: () => pi,
    notifiedRunIds,
    state: { sessionDir: "/tmp/run-settled-test-session", runs },
    // [W2/V1 D1 第 7 行] 终局记录查询注入（生产 = JsonlRunStore.settledRecordOf；
    // 直测按 makeRun 的 completed 形态给帧同源记录）
    settledRecordOf: () => ({ outcome: "completed", settledAt: 0 }),
    lsRef: { lastSessionId: "sess-run-settled" },
  };
  return {
    env,
    seq,
    notifiedRunIds,
    runs,
    sendMessage,
    failSend: (err) => {
      sendMessage.mockImplementation(() => {
        seq.push("1:notifyDone(sendMessage)");
        throw err;
      });
    },
  };
}

/** 预置 keepDone+1 个 done run（含本轮 run 的 completedAt 最新）→ evict 步骤
 * 恰好淘汰最旧 1 个（keepDone 单源 = MAX_RETAINED_DONE_RUNS）。 */
function seedRunsWithCapOverflow(h: EnvHarness, currentRun: WorkflowRun): void {
  h.runs.set(currentRun.runId, currentRun);
  for (let i = 0; i < MAX_RETAINED_DONE_RUNS; i++) {
    h.runs.set(
      `seed-${i}`,
      makeRun({
        runId: `seed-${i}`,
        status: "done",
        // ISO 字典序=时间序：早于本轮（new Date(0) 基线上递增 1ms），seed-0 最旧
        startedAt: new Date(i + 1).toISOString(),
        completedAt: new Date(i + 1).toISOString(),
      }),
    );
  }
}

describe("runSettledEffects：三步固定顺序", () => {
  it("notifyDone 发送后 track 纳入去重窗口；evict 按单源 cap 裁剪最旧 done run", () => {
    const h = makeEnv();
    const run = makeRun({ runId: "wf-current", status: "done", completedAt: new Date(10_000).toISOString() });
    seedRunsWithCapOverflow(h, run);

    runSettledEffects(h.env, run);

    // step1（发送哨兵）已执行
    expect(h.seq).toEqual(["1:notifyDone(sendMessage)"]);
    // step2：去重窗口纳入本轮 runId（notifyDone 降级直发受理后 track + 管线幂等 track）
    expect(h.notifiedRunIds.has("wf-current")).toBe(true);
    // step3：done 总数 = cap+1 → 恰淘汰最旧 1 个（seed-0），本轮 run（completedAt 最新）保留
    expect(h.runs.size).toBe(MAX_RETAINED_DONE_RUNS);
    expect(h.runs.has("seed-0")).toBe(false);
    expect(h.runs.has("seed-1")).toBe(true);
    expect(h.runs.has("wf-current")).toBe(true);
    // step3 的日志入参：keep 单源 cap + session 归属现读 lsRef
    expect(loggerFns.debug).toHaveBeenCalledWith("[subagent-workflow] evicted done runs beyond cap", {
      evicted: 1,
      keep: MAX_RETAINED_DONE_RUNS,
      sessionId: "sess-run-settled",
    });
    // 通知发送面参数：customType workflow-result + notifyId 幂等键前缀（真实 notifyDone 语义）
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [message] = h.sendMessage.mock.calls[0] as [
      { customType: string; details: { runId: string; notifyId: string } },
    ];
    expect(message.customType).toBe("workflow-result");
    expect(message.details.runId).toBe("wf-current");
    expect(message.details.notifyId).toBe("wf-done:wf-current");
  });

  it("notifyDone 非 stale 抛错 → 异常原样上抛，后续 track/evict 不执行（无内部围栏）", () => {
    const h = makeEnv();
    const run = makeRun({ runId: "wf-boom", status: "done", completedAt: new Date(10_000).toISOString() });
    seedRunsWithCapOverflow(h, run);
    const runsSizeBefore = h.runs.size;
    h.failSend(new Error("relay send boom"));

    // 管线不吞错：上抛交由调用方 finalizeRun 的 onRunDone 独立 try 围栏（OR-4/B-4）
    expect(() => runSettledEffects(h.env, run)).toThrowError("relay send boom");

    // step1 到达且失败
    expect(h.seq).toEqual(["1:notifyDone(sendMessage)"]);
    // step2 未执行：去重窗口不含 runId（notifyDone 降级路径发送失败不标记——重试通道保持）
    expect(h.notifiedRunIds.has("wf-boom")).toBe(false);
    // step3 未执行：runs 原样
    expect(h.runs.size).toBe(runsSizeBefore);
    expect(h.runs.has("seed-0")).toBe(true);
  });

  it("notifyDone 幂等早退（去重窗口已含 runId）不是失败：sendMessage 零调用，收尾步照常执行", () => {
    const h = makeEnv();
    const run = makeRun({ runId: "wf-dup", status: "done", completedAt: new Date(10_000).toISOString() });
    seedRunsWithCapOverflow(h, run);
    h.notifiedRunIds.add("wf-dup"); // 预置：模拟重复收口

    runSettledEffects(h.env, run);

    // notifyDone 首行去重早退 → 发送面零调用
    expect(h.sendMessage).not.toHaveBeenCalled();
    // step2（幂等）/ step3 照常执行（seq 恒空——发送面零调用）
    expect(h.seq).toEqual([]);
    expect(h.notifiedRunIds.has("wf-dup")).toBe(true);
    expect(h.runs.size).toBe(MAX_RETAINED_DONE_RUNS);
    expect(h.runs.has("seed-0")).toBe(false);
  });

  it("终局记录缺席（settlement undefined）→ 通知跳过 + error 留痕 + track 不标 + evict 照常（[W2/V1 D1 第 7 行] 失败语义分支）", () => {
    const h = makeEnv();
    const run = makeRun({ runId: "wf-nosettlement", status: "done", completedAt: new Date(10_000).toISOString() });
    seedRunsWithCapOverflow(h, run);
    // journal dispatch 失败窗口：终局记录查询 miss
    h.env.settledRecordOf = () => undefined;

    // 缺席不是抛错路径：不回退两态机字段兜底（I2 失效窗口下兜底 = 恒 completed 假成功）
    expect(() => runSettledEffects(h.env, run)).not.toThrow();

    // 通知跳过：发送面零调用 + error 留痕（含恢复动作指向 journal 错误日志）
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(loggerFns.error).toHaveBeenCalledWith(
      "[workflow] done notify skipped: settlement record unavailable (runId=wf-nosettlement) — " +
        "run-settled journal dispatch likely failed; recovery: consult the journal error log above",
    );
    // track 不标：未发通知不占去重窗口（允许后续语义修正重试）
    expect(h.notifiedRunIds.has("wf-nosettlement")).toBe(false);
    // evict 照常：内存有界性独立于通知（seq 恒空——发送面零调用）
    expect(h.seq).toEqual([]);
    expect(h.runs.size).toBe(MAX_RETAINED_DONE_RUNS);
    expect(h.runs.has("seed-0")).toBe(false);
    expect(h.runs.has("wf-nosettlement")).toBe(true);
  });
});

// ── ⑤ setupWorkflowDomain 的 pi.on 注册顺序锁（逐位不变契约） ──────────────────
//
// index.ts 头注与 setupWorkflowDomain JSDoc 声明「7 个 pi.on handler 的注册相对
// 顺序原样保留」。跨域 handler 迁出（session_compact / model_select / 父级联
// before 事件归各自域模块的 setup* 注册）后，本用例是顺序逐位不变的机器证据：
// fake pi 捕获 on() 调用序列（Map 保持插入序），与锁定的 7 事件序列逐位比对。

/** 锁定的注册顺序（index.ts 头注声明的 7 事件序列，逐位不变契约）。 */
const EXPECTED_REGISTRATION_ORDER = [
  "session_start",
  "session_compact",
  "model_select",
  "session_tree",
  "session_before_fork",
  "session_before_switch",
  "session_shutdown",
] as const;

describe("setupWorkflowDomain pi.on 注册顺序", () => {
  it("7 个事件按锁定序列逐位注册（跨域 setup* 调用原位、不改变序列）", () => {
    const { pi, handlers } = makePi();
    setupWorkflowDomain(pi, { inflightReporter: makeReporter() });

    expect([...handlers.keys()]).toEqual([...EXPECTED_REGISTRATION_ORDER]);
  });
});

// ── ⑥ 组合根薄接线：registerWorkflowsCommand 第三参 lazyDeps.onRunDone ─────────
//
// 替代原 index-session-start 的 W3TC8 完整行为重放：行为面权威在 runSettledEffects
// 直测（④）与 core lifecycle evict 用例；此处只锁「组合根把 lazyDeps 转交给
// workflows command」这一根接线——捕获第三参，调 onRunDone，断言真实管线执行且
// evict 写的是 session_start 装配的 sessionState 条目 runs Map（同一对象引用）。
// ctx 用 tui（环境门控：非 rpc 不启动在飞上报，零重试 timer 悬挂）。

describe("组合根接线：registerWorkflowsCommand 第三参 lazyDeps.onRunDone", () => {
  it("捕获的 onRunDone 转发到真实 runSettledEffects 管线：workflow-result 通知发出 + evict 操作真实 sessionState runs Map", async () => {
    // 注入双 Service 单例槽（index.ts factory 挂载链读）
    const { setModelConfigService } = await import("@zhushanwen/subagent-core");
    setModelConfigService({
      initModel: vi.fn(),
      reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
    } as never);

    // 预置 cap+1 个 done run：本轮 completedAt 最新，evict 应淘汰最旧 seed-0
    const currentRun = makeRun({ runId: "wf-thin", status: "done", completedAt: new Date(10_000).toISOString() });
    const seeds: WorkflowRun[] = [];
    for (let i = 0; i < MAX_RETAINED_DONE_RUNS; i++) {
      seeds.push(
        makeRun({
          runId: `seed-${i}`,
          status: "done",
          startedAt: new Date(i + 1).toISOString(),
          completedAt: new Date(i + 1).toISOString(),
        }),
      );
    }

    const { pi, handlers } = makePi();
    const { result, ctx, runs } = makeLifecycleResult("sess-thin-wire", {
      mode: "tui",
      runs: [currentRun, ...seeds],
    });
    mockSetupSessionLifecycle.mockResolvedValue(result);
    const { default: subagentsExtension } = await import("../index.ts");
    subagentsExtension(pi);
    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    // 组合根把 workflow.lazyDeps 转交 workflows command（第三参）
    expect(mockRegisterWorkflowsCommand).toHaveBeenCalledTimes(1);
    const lazyDeps = mockRegisterWorkflowsCommand.mock.calls[0]![2] as LauncherDeps;
    expect(typeof lazyDeps.onRunDone).toBe("function");

    lazyDeps.onRunDone!(currentRun);

    // 真实 runSettledEffects 管线执行：完成通知经降级直发送出
    const messages = sentMessages(pi);
    expect(messages.at(-1)?.customType).toBe("workflow-result");
    expect(messages.at(-1)?.details.runId).toBe("wf-thin");
    // evict 写的是 session_start 装配条目的 runs Map（makeLifecycleResult 返回的同一对象）
    expect(runs.size).toBe(MAX_RETAINED_DONE_RUNS);
    expect(runs.has("seed-0")).toBe(false);
    expect(runs.has("wf-thin")).toBe(true);
  });
});
