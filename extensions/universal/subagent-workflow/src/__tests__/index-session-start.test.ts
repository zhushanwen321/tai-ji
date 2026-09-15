// src/__tests__/index-session-start.test.ts
//
// C2 critical: session 装配的 UI handler 注入链路测试。
//
// 测试目标：验证 session_start 装配（createOrReuseServices）是否正确注入
// uiRequestHandler，特别是 **SR-3**：
//   无论 new 还是 existing SubagentService，session_start 都必须注入 handler
//   （[D4-④] 注入通道 = initSession.uiRequestHandler 参数，原 setUiRequestHandler
//   方法已随 D4 Service 收窄删除）——/resume /fork 复用 existingService 时旧
//   handler 可能失效。
//
// [u-5b / A-V3] 改写（2026-09-03）：
//   - 装配链内行为（SR-3 接线 / recoverManifestTmpFiles 接线 / loadAll 裁剪 /
//     通知账本恢复）→ bootstrap seam 直测 setupSessionLifecycle：双 Service 经
//     单例访问器槽（setSubagentService/setModelConfigService，globalThis 槽）注入
//     fake——默认装配走 existing 分支复用 fake，initSession 参数可观察。零整类
//     mock SubagentService/pi-ai/typebox（pi-coding-agent 运行时值由包根 mocks/
//     alias 提供）。
//   - 组合根消费点行为（W2TC16 shutdown 编排 / W3TC8 onRunDone 接线）→ 保留挂载
//     index.ts，mock 面收窄至 3：jsonl-run-store（store 可控）+ lifecycle
//     （terminate spy）+ interface/commands（runs getter / lazyDeps 捕获）。
//   - 旧 [D15] 裁决注释（「不抽共享 mocks 文件」）随本轮撤销清理：运行时桩已收敛
//     共享桩 module（src/__tests__/mocks/runtime-stubs.ts，u-5a），形态分工由
//     A-V3（seam 注入 / 访问器 mock）取代「内联 vi.mock 承担运行时隔离」。
//
// 旧用例「new 路径（existingService=null）」的形态适配（deviation 已登记）：initSession
// 参数接线仅在 existing 分支可观察（fake service 经访问器槽注入；new 分支构造真实
// SubagentService 副作用不可桩化），而 new/existing 两分支共用同一行接线代码（D8
// init 无条件语义），new 分支的构造语义由 session-lifecycle.test.ts 组 1 用例『默认
// createServices（访问器槽为 null）→ new 分支：双 Service 构造 + 双 set 各恰一次
// + init 无条件执行（D8）』断言锁定。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules（在 import 前声明；路径相对 src/__tests__/） ──

// JsonlRunStore mock：mount 用例的 store 可控点。dispose/flushPendingSaves：
// session_shutdown handler 会调 state.store.dispose()（W2C5）；dispose 用 hoisted
// spy 以便 W2TC16 断言（instance.dispose 即 spy）。
const { mockStoreLoadAll, mockStoreDispose, mockStoreFlushPendingSaves } = vi.hoisted(() => ({
  mockStoreLoadAll: vi.fn(async () => []),
  mockStoreDispose: vi.fn(async () => {}),
  mockStoreFlushPendingSaves: vi.fn(async () => {}),
}));
vi.mock("../jsonl-run-store.ts", () => ({
  JsonlRunStore: class {
    loadAll = mockStoreLoadAll;
    save = vi.fn(async () => {});
    dispose = mockStoreDispose;
    flushPendingSaves = mockStoreFlushPendingSaves;
  },
}));

// lifecycle mock：仅替换 terminateRunningRuns 为 hoisted spy（W2TC16 断言
// terminate→dispose 顺序用），其余导出（scheduleTimeBudget/runWorkflow/abortRun/
// evictDoneRunsBeyondCap）经 importOriginal 保留真实实现——本文件不执行真实
// workflow，替换只影响 shutdown handler 的 terminate 调用点。
const { mockTerminateRunningRuns } = vi.hoisted(() => ({
  mockTerminateRunningRuns: vi.fn(async () => {}),
}));
vi.mock("@zhushanwen/subagent-core/orchestration/lifecycle.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhushanwen/subagent-core/orchestration/lifecycle.ts")>();
  return { ...actual, terminateRunningRuns: mockTerminateRunningRuns };
});

// interface/commands mock：W3TC8 捕获 registerWorkflowsCommand 的 runs getter
//（第二参数）与 lazyDeps（第三参数，onRunDone 接线观察面）。
const { mockRegisterWorkflowsCommand } = vi.hoisted(() => ({
  mockRegisterWorkflowsCommand: vi.fn(),
}));
vi.mock("../interface/commands.ts", () => ({
  registerWorkflowsCommand: mockRegisterWorkflowsCommand,
}));

// ── import 被测模块 ──
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// resetModules 每用例重新加载 index.ts 副本，factory 体内的 process 信号 hook
//（SIGTERM/SIGINT/beforeExit 收割防线）随之叠加注册——本文件 mount 用例超 Node 默认
// listener 阈值 10 触发误报警告，抬高上限（生产单副本恒 3 个 listener，无此形态）。
process.setMaxListeners(50);

// session_start 的六项跨 session 副作用操作经 oncePerProcess 守卫（u-audit-fix），
// 守卫 Map 是模块级状态：beforeEach resetModules + 动态 import 每用例取新鲜模块实例，
// 否则首用例消费 key 后，后续用例的 recoverManifestTmpFiles / recoverCrashedRuns
//（loadAll 淘汰、storeHealthy）等断言静默失真。seam 直测路径同因：调用点
//（runSessionAssembly / W3TC7 / U2 用例）各自动态 import 取当用例的新鲜
// setupSessionLifecycle——静态引用跨 resetModules 存活，守卫 Map 不随用例重置。
let subagentsExtension: typeof import("../index.ts").default;
import { NOTIFY_ACK_CUSTOM_TYPE, NOTIFY_CUSTOM_TYPE, NOTIFY_LEDGER_CUSTOM_TYPE } from "@zhushanwen/subagent-core/execution/notify/notify-ledger.ts";
import { Budget } from "@zhushanwen/subagent-core";
import { Trace } from "@zhushanwen/subagent-core";
import { setModelConfigService, setSubagentService } from "@zhushanwen/subagent-core";
import { WorkflowRun } from "@zhushanwen/subagent-core";

// ── helpers ──────────────────────────────────────────────────────────────────

/** 重置双 Service 单例槽（setter 不接受 null，测试清理用 Symbol 直写；
 *  key 与生产 getServiceSlot / getModelServiceSlot 的 Symbol.for 一致）。 */
function resetLifecycleSlots(): void {
  for (const key of ["@zhushanwen/pi-subagents.service", "@zhushanwen/pi-subagents.model-service"]) {
    const slot = Reflect.get(globalThis, Symbol.for(key)) as { current: unknown } | undefined;
    if (slot) slot.current = null;
  }
}

/** 最小 fake pi。spies（可选）：U2 通知账本用例注入 appendEntry / sendMessage 观察桩。 */
function createFakePi(spies?: {
  appendEntry?: (customType: string, data: unknown) => void;
  sendMessage?: (message: unknown, options?: unknown) => void;
}): ExtensionAPI {
  const noop = (): void => {
    /* fake */
  };
  return {
    appendEntry: spies?.appendEntry ?? noop,
    events: { emit: vi.fn() },
    on: noop,
    sendMessage: spies?.sendMessage ?? noop,
  } as unknown as ExtensionAPI;
}

/** 最小 fake ExtensionContext。mode 由参数控制（决定 handler 注入行为）。
 *  entries（可选）：U2 通知账本用例注入 sessionManager.getEntries 返回值
 *  （模拟重启前落盘的 ledger/ack entry）。 */
function createFakeCtx(
  mode: "tui" | "rpc" | "json" | "print",
  entries?: unknown[],
): ExtensionContext & { ui: { setWidget: ReturnType<typeof vi.fn> } | undefined } {
  const ui = mode === "rpc" ? { setWidget: vi.fn() } : undefined;
  return {
    cwd: "/home/user/project",
    mode,
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    },
    model: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "session-inject-1",
      getSessionFile: () => "/home/user/.pi/agent/sessions/session-inject-1.jsonl",
      getEntries: () => entries ?? [],
    },
    ui,
  } as unknown as ExtensionContext & { ui: { setWidget: ReturnType<typeof vi.fn> } | undefined };
}

/**
 * seam 直测：注入 fake 双 Service（访问器槽，默认装配 existing 分支复用 fake）+
 * fake wtm/store，跑一次完整 session 装配。返回接线观察面（initSession/initModel/
 * recoverManifestTmpFiles spies）。
 */
async function runSessionAssembly(mode: "tui" | "rpc" | "json" | "print", entries?: unknown[]): Promise<{
  mockInitSession: ReturnType<typeof vi.fn>;
  mockInitModel: ReturnType<typeof vi.fn>;
  mockRecoverManifestTmpFiles: ReturnType<typeof vi.fn>;
}> {
  const mockInitSession = vi.fn();
  const mockInitModel = vi.fn();
  const mockRecoverManifestTmpFiles = vi.fn(async () => ({ deleted: 0, recovered: 0 }));
  // 当用例的新鲜 seam 实例（守卫 Map 随 beforeEach resetModules 重置，见文件头注释）
  const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
  setSubagentService({
    initSession: mockInitSession,
    recoverManifestTmpFiles: mockRecoverManifestTmpFiles,
    startGcTimer: vi.fn(),
    getStreamSink: () => null,
    dispose: vi.fn(),
  } as never);
  setModelConfigService({
    initModel: mockInitModel,
    // session_start 的 lastEngine 基线读取经本方法（构造性同源）：absent → lastEngine
    // 归一 'pi'，与旧实现 readGlobalConfig 读不到文件时的行为一致
    reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
  } as never);
  await setupSessionLifecycle(createFakePi(), createFakeCtx(mode, entries), {
    worktreeManager: { scan: vi.fn(async () => {}) },
    createRunStore: () =>
      ({
        loadAll: vi.fn(async () => []),
        save: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      }) as never,
  });
  return { mockInitSession, mockInitModel, mockRecoverManifestTmpFiles };
}

/** 挂载 index.ts 并跑一次 session_start（store loadAll 行为可配），返回守卫观察面：
 *  pi（含 __workflowRun）/ session_shutdown handler / registerWorkflowsCommand 捕获。 */
async function mountWithLoadAll(loadAll: () => Promise<unknown[]>): Promise<{
  pi: ExtensionAPI;
  shutdownHandler: (event: unknown, ctx: unknown) => Promise<void>;
}> {
  resetLifecycleSlots();
  mockStoreLoadAll.mockImplementation(loadAll as () => Promise<never[]>);
  setSubagentService({
    initSession: vi.fn(),
    recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
    startGcTimer: vi.fn(),
    getStreamSink: () => null,
    dispose: vi.fn(),
  } as never);
  setModelConfigService({
    initModel: vi.fn(),
    reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
  } as never);

  let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let sessionShutdownHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const noop = (): void => {
    /* mock */
  };
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      if (event === "session_start") {
        sessionStartHandler = handler as (event: unknown, ctx: unknown) => Promise<void>;
      }
      if (event === "session_shutdown") {
        sessionShutdownHandler = handler as (event: unknown, ctx: unknown) => Promise<void>;
      }
    },
    appendEntry: noop,
    events: { emit: vi.fn() },
    sendMessage: noop,
  } as unknown as ExtensionAPI;

  subagentsExtension(pi);

  const handler = sessionStartHandler!;
  await handler({ type: "session_start" }, createFakeCtx("tui"));

  return {
    pi,
    shutdownHandler: sessionShutdownHandler!,
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockStoreLoadAll.mockResolvedValue([]);
  resetLifecycleSlots();
  subagentsExtension = (await import("../index.ts")).default;
});

afterEach(() => {
  resetLifecycleSlots();
});

// ── tests ──

describe("session_start UI handler 注入链路（SR-3）", () => {
  it("装配链（tui mode）：initSession 收到 uiRequestHandler=函数 + session 锚点（槽注入 existing 形态）", async () => {
    // 旧用例为「new 路径（existingService=null）」——initSession 参数接线仅在
    // existing 分支可观察（见文件头 deviation 说明）；new/existing 共用同一行
    // 接线代码（D8 init 无条件），此处经槽注入走 existing 分支锁定同一契约。
    const { mockInitSession } = await runSessionAssembly("tui");

    // SR-3 核心：initSession 必须收到 handler（[D4-④] 唯一注入入口）
    expect(mockInitSession).toHaveBeenCalledTimes(1);
    // 非 headless mode → 注入的是函数（UiRequestHandler），非 null/undefined
    const initArg = mockInitSession.mock.calls[0]?.[0] as { uiRequestHandler?: unknown; sessionId?: unknown };
    expect(typeof initArg?.uiRequestHandler).toBe("function");
    // session 锚点同步注入（SR-3：/resume /fork 复用时更新 sessionId）
    expect(initArg?.sessionId).toBe("session-inject-1");
  });

  it("existing 路径（槽注入复用）：initSession 仍收到 handler + initModel 无条件执行（SR-3 关键）", async () => {
    // 模拟 /resume /fork：单例访问器槽返回已存在的 service（fake），
    // session_start 复用之——initModel/initSession 均无条件执行（D8）。
    const { mockInitSession, mockInitModel, mockRecoverManifestTmpFiles } = await runSessionAssembly("tui");

    // SR-3 关键断言：existing 路径下 initSession 仍收到 handler
    //（旧 handler 可能已失效，session_start 必须重新注入覆盖）
    expect(mockInitSession).toHaveBeenCalledTimes(1);
    const initArg = mockInitSession.mock.calls[0]?.[0] as { uiRequestHandler?: unknown };
    expect(typeof initArg?.uiRequestHandler).toBe("function");

    // D8 init 无条件语义：existing 复用时 initModel 仍执行（不因 reused 跳过）
    expect(mockInitModel).toHaveBeenCalledTimes(1);

    // ADR-035 existing 路径守护：/resume /fork 复用 service 时 session_start
    // 也必须调 recoverManifestTmpFiles。守护 case 走 new 路径抓不到 existing 误删，
    // 此处对称断言（与 handler 注入在本 case 的独立断言同模式）。
    expect(mockRecoverManifestTmpFiles).toHaveBeenCalledTimes(1);
  });

  it("headless mode（json）：createUiRequestHandlerForMode 返回 undefined → initSession 收到 null（显式清空）", async () => {
    const { mockInitSession } = await runSessionAssembly("json");

    // SR-3 语义保留：headless 不注入 handler，且显式传 null（清空旧 session 残留，
    // 非 undefined——undefined 是「不动」语义，会保留上一个 session 的 handler）
    expect(mockInitSession).toHaveBeenCalledTimes(1);
    const initArg = mockInitSession.mock.calls[0]?.[0] as { uiRequestHandler?: unknown };
    expect(initArg?.uiRequestHandler).toBeNull();
  });

  it("rpc mode：initSession 收到 uiRequestHandler=函数", async () => {
    const { mockInitSession } = await runSessionAssembly("rpc");

    expect(mockInitSession).toHaveBeenCalledTimes(1);
    const initArg = mockInitSession.mock.calls[0]?.[0] as { uiRequestHandler?: unknown };
    expect(typeof initArg?.uiRequestHandler).toBe("function");
  });

  it("initSession 是 uiRequestHandler 单一注入入口（[#24][D4-④]，防双路径注入回退）", async () => {
    const { mockInitSession } = await runSessionAssembly("tui");

    // [#24][D4-④] 单一注入入口：session_start 经 initSession.uiRequestHandler 注入 handler
    //（原 setUiRequestHandler 方法已删，双路径注入在 Service 面上不可达）。
    // mode 仍需 session 级注入（uiObservability.setMode 依赖它）。
    expect(mockInitSession).toHaveBeenCalledTimes(1);
    const initArg = mockInitSession.mock.calls[0]?.[0] as {
      uiRequestHandler?: unknown;
      mode?: unknown;
      dialogQueue?: unknown;
    } | undefined;
    expect(initArg).toBeDefined();
    expect(typeof initArg?.uiRequestHandler).toBe("function");
    // mode 仍需 session 级注入（uiObservability.setMode 依赖它）
    expect(initArg?.mode).toBe("tui");
    // dialogQueue 仍注入（SR-4 清理路径接通）
    expect(initArg).toHaveProperty("dialogQueue");
  });

  it("session_start 调用 recoverManifestTmpFiles（接线守护，防 ADR-035 启动恢复再次断线）", async () => {
    const { mockRecoverManifestTmpFiles } = await runSessionAssembly("tui");

    // ADR-035 接线断言：session_start 必须调 service.recoverManifestTmpFiles（防死代码回退）
    expect(mockRecoverManifestTmpFiles).toHaveBeenCalledTimes(1);
  });
});

describe("session_shutdown: store.dispose 接线（W2TC16）", () => {
  it("W2TC16: session_shutdown 触发后 store 实例 dispose 被调用（terminate 完成之后、sessionState 清理之前）", async () => {
    // 预热：session_start 建立一个 sessionState 条目（含 mock store 实例）。
    // loadAll 注入 running run 使其进入 sessionState.runs——duck-typed 对象 +
    // no-op transition：session_start 的 kill-9 恢复会把 running run 转 done,failed
    // （真实 WorkflowRun.reconstruct 无法保持 running），no-op transition 吞掉该转换
    // 让 run 以 running 进入 sessionState.runs。运行时形状由消费路径保证：handler
    // 只读 state.status（string）与 transition（可调用），duck typing 满足。
    mockStoreDispose.mockClear();
    const runningRun = {
      runId: "wf-w2tc16-1",
      state: { status: "running", error: undefined as string | undefined },
      transition: vi.fn(),
    } as unknown as WorkflowRun;
    const { shutdownHandler } = await mountWithLoadAll(async () => [runningRun]);

    // terminate gate：deferred 模拟 terminateRunningRuns 内部 `await store.save(run)`
    // 落盘边界——resolve 前 dispose 不得发生（terminate 未完成 = failed 状态未落盘，
    // 此刻 dispose 刷 pending 批会把未定稿的 running 尾巴刷出去，重启后 kill-9
    // 恢复误判）。
    let resolveTerminate = (): void => {};
    mockTerminateRunningRuns.mockImplementationOnce(async () => {
      await new Promise<void>((r) => {
        resolveTerminate = r;
      });
    });

    // 触发 session_shutdown（event 触发模式对齐本文件 session_start 既有写法）
    const shutdownDone = shutdownHandler({ type: "session_shutdown" }, createFakeCtx("tui"));

    // terminate 未完成（save 未落盘）→ dispose 未被调（await 边界真实生效）
    await Promise.resolve();
    expect(mockStoreDispose).not.toHaveBeenCalled();

    resolveTerminate();
    await shutdownDone;

    // 每 sessionState 条目一次：session_start 建了 1 个 session → terminate 调用 1 次
    expect(mockTerminateRunningRuns).toHaveBeenCalledTimes(1);
    // 原因串字面值（session_shutdown 路径，接口契约锁定）
    expect(mockTerminateRunningRuns.mock.calls[0]?.[1]).toBe("Session shutdown: run terminated");
    // dispose 在 terminate 完成后被调（每 session 1 次）
    expect(mockStoreDispose).toHaveBeenCalledTimes(1);

    // 顺序断言「sessionState 清理之前」（标题后半）：sessionState.delete 是 Map
    // 同步操作、无外部可观察 spy——用第二次 shutdown 的幂等性间接证明：第一次
    // handler 内条目已删（delete 在 dispose await 之后执行），重复 shutdown 遍历
    // 空 Map 不再二次 terminate/dispose。若清理被跳过，此处会涨到 2 次。
    await shutdownHandler({ type: "session_shutdown" }, createFakeCtx("tui"));
    expect(mockTerminateRunningRuns).toHaveBeenCalledTimes(1);
    expect(mockStoreDispose).toHaveBeenCalledTimes(1);
  });
});

// ── W-N: done run 淘汰接线（loadAll 裁剪 + onRunDone 裁剪） ──

/** fixture 基准时刻（过去时刻，保证 now 恒晚于全部 fixture completedAt）。 */
const W3_T0 = Date.parse("2020-01-01T00:00:00.000Z");
function w3IsoAt(min: number): string {
  return new Date(W3_T0 + min * 60_000).toISOString();
}

/** loadAll 重水合输入 fixture：done run（status done reason completed + completedAt）。 */
function makeLoadedDoneRun(runId: string, completedAt: string): WorkflowRun {
  return WorkflowRun.reconstruct(
    runId,
    {
      scriptSource: "execute() {}",
      args: {},
      scriptName: "test",
      scriptPath: "/fake/test.js",
    },
    {
      status: "done",
      reason: "completed",
      budget: new Budget({ maxTokens: 1000 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: completedAt, completedAt },
  );
}

/** loadAll 重水合输入 fixture：running run（kill-9 恢复输入，reconstruct 跳 I1 合法）。 */
function makeLoadedRunningRun(runId: string): WorkflowRun {
  return WorkflowRun.reconstruct(
    runId,
    {
      scriptSource: "execute() {}",
      args: {},
      scriptName: "test",
      scriptPath: "/fake/test.js",
    },
    {
      status: "running",
      budget: new Budget({ maxTokens: 1000 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: w3IsoAt(0) },
  );
}

describe("W-3: done run 淘汰接线（loadAll 裁剪 + onRunDone 裁剪）", () => {
  it("W3TC7: session_start loadAll 灌入后裁剪到 K（21 done + 1 running kill-9 恢复）", async () => {
    // seam 直测：loadAll 循环 + kill-9 恢复 + evict 住在 session-lifecycle.ts 装配链内，
    // 装配结果 result.runs 即裁剪后 runs Map（旧形态经 registerWorkflowsCommand
    // 捕获 runs getter，观察面等价迁移）。
    const doneRuns = Array.from({ length: 21 }, (_, i) =>
      makeLoadedDoneRun(`wf-loaded-${i}`, w3IsoAt(i)));
    const runningRun = makeLoadedRunningRun("wf-recovered-1");
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");

    const result = await setupSessionLifecycle(createFakePi(), createFakeCtx("tui"), {
      createServices: (() => ({
        service: {
          initSession: vi.fn(),
          recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
          startGcTimer: vi.fn(),
        },
        modelService: {
          initModel: vi.fn(),
          reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
        },
        reused: false,
      })) as never,
      worktreeManager: { scan: vi.fn(async () => {}) },
      createRunStore: () =>
        ({
          loadAll: vi.fn(async () => [...doneRuns, runningRun]),
          save: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        }) as never,
    });
    const runs = result.runs;

    // kill-9 恢复链把 running 转 done,failed（既有语义）后共 22 done → 裁到 20
    expect(runs.size).toBe(20);
    // 恢复 run 的 completedAt 为 transition 时刻（now，晚于全部 fixture 过去时间戳）
    // → 必在保留端
    expect(runs.has("wf-recovered-1")).toBe(true);
    expect(runs.get("wf-recovered-1")?.state.status).toBe("done");
    expect(runs.get("wf-recovered-1")?.state.reason).toBe("failed");
    // 被淘汰 2 个 = fixture 最旧两个
    expect(runs.has("wf-loaded-0")).toBe(false);
    expect(runs.has("wf-loaded-1")).toBe(false);
    for (let i = 2; i < 21; i++) {
      expect(runs.has(`wf-loaded-${i}`)).toBe(true);
    }
  });

  it("W3TC8: onRunDone 回调接线——notify → track → evict，本轮 run 不被自身触发的裁剪淘汰", async () => {
    // onRunDone 接线住组合根 makeDeps（index.ts），保留挂载形态。
    // session_start 预热：恰好 20 个 done（completedAt t0..t19）
    const doneRuns = Array.from({ length: 20 }, (_, i) =>
      makeLoadedDoneRun(`wf-pre-${i}`, w3IsoAt(i)));
    await mountWithLoadAll(async () => doneRuns);

    // lazyDeps = registerWorkflowsCommand 第三参数（getter 转发 makeDeps 的 onRunDone）
    const lazyDeps = mockRegisterWorkflowsCommand.mock.calls[0]?.[2] as
      | { onRunDone: (run: WorkflowRun) => void }
      | undefined;
    expect(lazyDeps).toBeDefined();

    // 本轮 newDoneRun：completedAt = now（晚于全部 fixture 过去时间戳）
    const newDoneRun = WorkflowRun.reconstruct(
      "wf-current-1",
      {
        scriptSource: "execute() {}",
        args: {},
        scriptName: "test",
        scriptPath: "/fake/test.js",
      },
      {
        status: "done",
        reason: "completed",
        budget: new Budget({ maxTokens: 1000 }),
        calls: new Map(),
        trace: new Trace(),
        errorLogs: [],
      },
      { startedAt: w3IsoAt(999), completedAt: new Date().toISOString() },
    );

    // 模拟真实流程的注册步骤：lifecycle.ts runWorkflow 在创建时 deps.runs.set(runId, run)
    //（onRunDone 回调只裁剪不注册——本轮 run 必须先在 Map 中，「保留端」断言才有对象）
    const getRuns = mockRegisterWorkflowsCommand.mock.calls[0]?.[1] as
      | (() => Map<string, WorkflowRun>)
      | undefined;
    expect(typeof getRuns).toBe("function");
    const runs = getRuns!();
    runs.set("wf-current-1", newDoneRun);

    // 回调不抛错（notifyDone 对 fake pi 安全：sendMessage no-op；
    // toGuiCtx(tui ctx) isGuiCapable false 走无 __gui__ 分支）
    expect(() => lazyDeps!.onRunDone(newDoneRun)).not.toThrow();

    // 21 done 裁 1：size 回到 20
    expect(runs.size).toBe(20);
    // 被淘汰的是 t0 最旧 run 而非本轮 run（completedAt 最新恒在保留端）
    expect(runs.has("wf-current-1")).toBe(true);
    expect(runs.has("wf-pre-0")).toBe(false);
    for (let i = 1; i < 20; i++) {
      expect(runs.has(`wf-pre-${i}`)).toBe(true);
    }
  });
});

// ============================================================
// [U2] session_start 通知账本装配 + 重启恢复钩子（设计 D4）
// ============================================================
//
// fake session 文件（ctx.sessionManager.getEntries）含 ledger/ack entry →
// session 装配绑定账本并重放差集：未销账号经 pi.sendMessage({triggerTurn:true})
// 单通道重投；已销账零重发。bind 顺序在 service.initSession 之前（notifier.notify
// 经模块级绑定消费账本）。

describe("session_start 通知账本恢复钩子（U2 B-ledger）", () => {
  afterEach(async () => {
    // 动态 import 命中用例已加载的同一 notify-ledger 实例（下一次 beforeEach 才
    // resetModules），重置的正是被测绑定槽——静态引用属首载模块图，重置对其无效。
    const { _resetNotifyLedgerForTest } = await import("@zhushanwen/subagent-core/execution/notify/notify-ledger.ts");
    _resetNotifyLedgerForTest();
  });

  it("mock session 含 ledger/ack entry → 未销账号重放（单通道 triggerTurn），已销账零重发", async () => {
    const appendEntryCalls: Array<{ customType: string; data: unknown }> = [];
    const sendMessageCalls: Array<{ message: unknown; options: unknown }> = [];
    const pi = createFakePi({
      appendEntry: (customType, data) => {
        appendEntryCalls.push({ customType, data });
      },
      sendMessage: (message, options) => {
        sendMessageCalls.push({ message, options });
      },
    });

    // 模拟重启前落盘：2 条 ledger entry（s-a 已销账 + s-b 未销账）+ 1 条 ack
    const entries: unknown[] = [
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-a", content: "ca", record: { notifyId: "s-a" } } },
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-b", content: "cb", record: { notifyId: "s-b" } } },
      { type: "custom", customType: NOTIFY_ACK_CUSTOM_TYPE, data: { v: 1, notifyId: "s-a" } },
    ];
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");

    await setupSessionLifecycle(pi, createFakeCtx("rpc", entries), {
      createServices: (() => ({
        service: {
          initSession: vi.fn(),
          recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
          startGcTimer: vi.fn(),
        },
        modelService: {
          initModel: vi.fn(),
          reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
        },
        reused: false,
      })) as never,
      worktreeManager: { scan: vi.fn(async () => {}) },
      createRunStore: () =>
        ({
          loadAll: vi.fn(async () => []),
          save: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        }) as never,
    });

    // 未销账 s-b 单条重放：sendMessage 恰 1 次，options 恰 {triggerTurn:true}
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]!.options).toEqual({ triggerTurn: true });
    const sent = sendMessageCalls[0]!.message as { customType: string; content: string; details?: { notifyId?: string } };
    expect(sent.customType).toBe(NOTIFY_CUSTOM_TYPE);
    expect(sent.content).toBe("cb");
    expect(sent.details?.notifyId).toBe("s-b");
    // 已销账 s-a 零重发（不追加新 ledger entry，不重投）
    expect(appendEntryCalls.filter((c) => c.customType === NOTIFY_LEDGER_CUSTOM_TYPE)).toHaveLength(0);
  });

  it("全部已销账（差集为空）→ 零重放零发送", async () => {
    const sendMessageCalls: unknown[] = [];
    const pi = createFakePi({
      sendMessage: () => {
        sendMessageCalls.push({});
      },
    });

    const entries: unknown[] = [
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-x", content: "cx", record: { notifyId: "s-x" } } },
      { type: "custom", customType: NOTIFY_ACK_CUSTOM_TYPE, data: { v: 1, notifyId: "s-x" } },
    ];
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");

    await setupSessionLifecycle(pi, createFakeCtx("rpc", entries), {
      createServices: (() => ({
        service: {
          initSession: vi.fn(),
          recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
          startGcTimer: vi.fn(),
        },
        modelService: {
          initModel: vi.fn(),
          reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
        },
        reused: false,
      })) as never,
      worktreeManager: { scan: vi.fn(async () => {}) },
      createRunStore: () =>
        ({
          loadAll: vi.fn(async () => []),
          save: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        }) as never,
    });

    expect(sendMessageCalls).toHaveLength(0);
  });
});
