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
//   - 装配链内行为（SR-3 接线 / 通知账本恢复）→ bootstrap seam 直测
//     setupSessionLifecycle：双 Service 经单例访问器槽（setSubagentService/
//     setModelConfigService，globalThis 槽）注入 fake——默认装配走 existing 分支
//     复用 fake，initSession 参数可观察。零整类 mock SubagentService/pi-ai/typebox
//     （pi-coding-agent 运行时值由包根 mocks/ alias 提供）。
//   - 组合根消费点行为（W2TC16 shutdown 编排）→ 保留挂载 index.ts，mock 面收窄
//     至 3：jsonl-run-store（store 可控）+ lifecycle（terminate spy）+
//     interface/commands（runs getter / lazyDeps 捕获）。
//   - 旧 [D15] 裁决注释（「不抽共享 mocks 文件」）随本轮撤销清理：运行时桩已收敛
//     共享桩 module（src/__tests__/mocks/runtime-stubs.ts，u-5a），形态分工由
//     A-V3（seam 注入 / 访问器 mock）取代「内联 vi.mock 承担运行时隔离」。
//
// [组 5a 瘦身 2026-09-27] beforeEach 不再 resetModules + 动态 import index.ts
//（每用例全图重求值，9 条 seam 用例免付）——模块图静态加载一次，oncePerProcess
// 守卫 Map 经 ext-guards 测试重置导出在 beforeEach 清空（与 resetModules 重建等价）；
// W3TC7/W3TC8 淘汰接线两条删除（core lifecycle-recover-crashed 已锁淘汰语义；
// W3TC8 由组 5b 在 workflow-events 合并文件补薄接线断言）。
//
// 旧用例「new 路径（existingService=null）」的形态适配（deviation 已登记）：initSession
// 参数接线仅在 existing 分支可观察（fake service 经访问器槽注入；new 分支构造真实
// SubagentService 副作用不可桩化），而 new/existing 两分支共用同一行接线代码（D8
// init 无条件语义），new 分支的构造语义由 session-lifecycle.test.ts 组 1 用例『默认
// createServices（访问器槽为 null）→ new 分支：双 Service 构造 + 双 set 各恰一次
// + init 无条件执行（D8）』断言锁定。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetOncePerProcessForTest } from "@zhushanwen/pi-ext-guards";

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

// interface/commands mock：组合根 factory 体内的 registerWorkflowsCommand 调用
// 打桩（挂载用例的 fake pi 无真实命令注册面）。
const { mockRegisterWorkflowsCommand } = vi.hoisted(() => ({
  mockRegisterWorkflowsCommand: vi.fn(),
}));
vi.mock("../interface/command/commands.ts", () => ({
  registerWorkflowsCommand: mockRegisterWorkflowsCommand,
}));

// ── import 被测模块 ──
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// session_start 的六项跨 session 副作用操作经 oncePerProcess 守卫（u-audit-fix），
// 守卫 Map 是模块级状态：beforeEach 经 _resetOncePerProcessForTest 清空（本文件
// 静态加载模块图，无 resetModules 重建）。
import { NOTIFY_ACK_CUSTOM_TYPE, NOTIFY_CUSTOM_TYPE, NOTIFY_LEDGER_CUSTOM_TYPE, _resetNotifyLedgerForTest } from "@zhushanwen/subagent-core/execution/notify/notify-ledger.ts";
import { setupSessionLifecycle } from "../session-lifecycle.ts";
import subagentsExtension from "../index.ts";
import { WorkflowRun } from "@zhushanwen/subagent-core";
import { GLOBAL_SLOT_KEYS, setModelConfigService, setSubagentService } from "@zhushanwen/subagent-core";

// ── helpers ──────────────────────────────────────────────────────────────────

/** 重置双 Service 单例槽（setter 不接受 null，测试清理用 Symbol 直写；
 *  key 与生产 getServiceSlot / getModelServiceSlot 的 Symbol.for 一致）。 */
function resetLifecycleSlots(): void {
  for (const key of [GLOBAL_SLOT_KEYS.service, GLOBAL_SLOT_KEYS.modelService]) {
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
  setSubagentService({
    initSession: mockInitSession,
    recoverManifestTmpFiles: mockRecoverManifestTmpFiles,
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
 *  pi / session_shutdown handler / registerWorkflowsCommand 捕获。 */
async function mountWithLoadAll(loadAll: () => Promise<unknown[]>): Promise<{
  pi: ExtensionAPI;
  shutdownHandler: (event: unknown, ctx: unknown) => Promise<void>;
}> {
  resetLifecycleSlots();
  mockStoreLoadAll.mockImplementation(loadAll as () => Promise<never[]>);
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

beforeEach(() => {
  vi.clearAllMocks();
  mockStoreLoadAll.mockResolvedValue([]);
  resetLifecycleSlots();
  _resetOncePerProcessForTest();
});

afterEach(() => {
  resetLifecycleSlots();
});

// ── tests ──

describe("session_start UI handler 注入链路（SR-3）", () => {
  it("装配链（tui mode）：initSession 收到 uiRequestHandler=函数 + session 锚点 + mode/dialogQueue 注入（槽注入 existing 形态）", async () => {
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
    // [#24][D4-④] 单一注入入口（原独立用例并入）：mode 仍需 session 级注入
    //（uiObservability.setMode 依赖它）；dialogQueue 仍注入（SR-4 清理路径接通）
    expect(initArg?.mode).toBe("tui");
    expect(initArg).toHaveProperty("dialogQueue");
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
});

describe("session_shutdown: store.dispose 接线（W2TC16）", () => {
  it("W2TC16: session_shutdown 触发后 store 实例 dispose 被调用（terminate 完成之后、sessionState 清理之前）", async () => {
    // 预热：session_start 建立一个 sessionState 条目（含 mock store 实例）。
    // loadAll 注入 running run 使其进入 sessionState.runs——duck-typed 对象 +
    // no-op transition：session_start 的 kill-9 恢复会把 running run 转 done,failed
    // 残留 running 形态经恢复链走中断收编（isRunSettled=false 判活——聚合快照
    // 不持生命周期轴，duck typing 满足消费路径）。
    mockStoreDispose.mockClear();
    const runningRun = {
      runId: "wf-w2tc16-1",
      state: { error: undefined as string | undefined },
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

// ============================================================
// [U2] session_start 通知账本装配 + 重启恢复钩子（设计 D4）
// ============================================================
//
// fake session 文件（ctx.sessionManager.getEntries）含 ledger/ack entry →
// session 装配绑定账本并重放差集：未销账号经 pi.sendMessage({triggerTurn:true})
// 单通道重投；已销账零重发。bind 顺序在 service.initSession 之前（notifier.notify
// 经模块级绑定消费账本）。

describe("session_start 通知账本恢复钩子（U2 B-ledger）", () => {
  afterEach(() => {
    // 静态 import 命中被测绑定槽同一实例（本文件已无 resetModules，首载图即当前图）
    _resetNotifyLedgerForTest();
  });

  it("mock session 含 ledger/ack entry → 仅未销账号重放（单通道 triggerTurn），已销账零重发零重放", async () => {
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

    // 模拟重启前落盘：3 条 ledger entry（s-a/s-c 已销账 + s-b 未销账）+ 2 条 ack
    //（原「全部已销账 → 零重放」独立用例并入：已销账条目不重投由 s-a/s-c 共同证明）
    const entries: unknown[] = [
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-a", content: "ca", record: { notifyId: "s-a" } } },
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-b", content: "cb", record: { notifyId: "s-b" } } },
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-c", content: "cc", record: { notifyId: "s-c" } } },
      { type: "custom", customType: NOTIFY_ACK_CUSTOM_TYPE, data: { v: 1, notifyId: "s-a" } },
      { type: "custom", customType: NOTIFY_ACK_CUSTOM_TYPE, data: { v: 1, notifyId: "s-c" } },
    ];

    await setupSessionLifecycle(pi, createFakeCtx("rpc", entries), {
      createServices: (() => ({
        service: {
          initSession: vi.fn(),
          recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
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
    // 已销账 s-a/s-c 零重发（不追加新 ledger entry，不重投）
    expect(appendEntryCalls.filter((c) => c.customType === NOTIFY_LEDGER_CUSTOM_TYPE)).toHaveLength(0);
  });
});
