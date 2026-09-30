// inflight-wiring.test.ts —— 组合根接线：session_start 即发初始上报（u7a，设计 §3.3 D5
// 「触发时点钉死 = extension 加载完成」验收面）。
//
// 验证点：
//   ① 初始上报在 session_start handler 内、setupSessionLifecycle await 链之外发起
//     （handler 未 await 完成时帧已在途——fire-and-forget，不阻塞装配链）；
//   ② 帧形状过契约守卫（isSubagentInFlightReport）：count=当下真实快照（真实
//     core barrel，空态=0——无任何 subagent 调用的 session 也必上报）；
//   ③ ack 后通道静默：session_shutdown 摘除后无残余调用；
//   ④ 环境门控（2026-09-13 oe-audit + 裸 TUI 闪框事故）：非 rpc 模式不启动上报。
//
// mock 面对齐 index-session-start.test.ts（jsonl-run-store + lifecycle.terminate）；
// 其余走真实装配（service 单例槽注入 fake，与该文件同一模式）。
//
// 装载成本分层 [组 5a 瘦身 2026-09-27]：模块图静态加载一次，beforeEach 显式重置
// oncePerProcess 守卫 Map + 通知账本 + Service 单例槽（与 resetModules 重建等价）；
// subagentsExtension（index.ts 全图）不再每用例动态 import 重求值。reporter 重试
// 用例被测对象是 createInFlightReporter 单模块（静态图内缓存命中）。重试语义用
// fake timers 确定性驱动（重试 timer 走 setTimeout；select 为 stub 立即返回，无真实
// 超时计时），消除对真实时序的依赖。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetOncePerProcessForTest } from "@zhushanwen/pi-ext-guards";

const { mockStoreLoadAll, mockStoreDispose } = vi.hoisted(() => ({
  mockStoreLoadAll: vi.fn(async () => []),
  mockStoreDispose: vi.fn(async () => {}),
}));
vi.mock("../jsonl-run-store.ts", () => ({
  JsonlRunStore: class {
    loadAll = mockStoreLoadAll;
    save = vi.fn(async () => {});
    dispose = mockStoreDispose;
    flushPendingSaves = vi.fn(async () => {});
  },
}));

const { mockTerminateRunningRuns } = vi.hoisted(() => ({
  mockTerminateRunningRuns: vi.fn(async () => {}),
}));
vi.mock("@zhushanwen/subagent-core/orchestration/lifecycle.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhushanwen/subagent-core/orchestration/lifecycle.ts")>();
  return { ...actual, terminateRunningRuns: mockTerminateRunningRuns };
});

// [modeless 波5 测试修复] logger mock：失败路径首次 logger.warn 触发 fresh logger 模块
// 的同步初始化（~100ms 量级，实测 probe 阻塞事件循环）。本文件主题是 reporter 重试
// 语义，非日志行为，隔离之；重试窗口另由 fake timers 确定性驱动，双重消除时序敏感。
const { inflightLoggerFns } = vi.hoisted(() => ({
  inflightLoggerFns: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => inflightLoggerFns,
  // index.ts factory 顶层调用 setPiHandle（把 pi handle 注入全局 logger，供深层 getLogger
  // 走 appendEntry）——本文件隔离日志行为，stub 之（对齐 parent-child-matrix.test.ts）。
  setPiHandle: vi.fn(),
}));

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  INFLIGHT_REPORT_ACK,
  SUBAGENT_INFLIGHT_MARKER,
  isSubagentInFlightReport,
} from "@zhushanwen/extension-protocol";
import { setModelConfigService, setSubagentService } from "@zhushanwen/subagent-core";
// 通知账本重置导出（beforeEach 显式清空；session_start 装配链按 ctx entries 重水合）
import { _resetNotifyLedgerForTest } from "@zhushanwen/subagent-core/execution/notify/notify-ledger.ts";
import subagentsExtension from "../index.ts";

process.setMaxListeners(50);

function resetLifecycleSlots(): void {
  for (const key of ["@zhushanwen/subagent-core.service", "@zhushanwen/subagent-core.modelService"]) {
    const slot = Reflect.get(globalThis, Symbol.for(key)) as { current: unknown } | undefined;
    if (slot) slot.current = null;
  }
}

/** select 通道：立即回 ack（runtime event-adapter 到达即 resolve 的 fire-and-forget 形态）。 */
function makeCtx(
  sessionId = "sess-inflight-wiring",
  mode: ExtensionContext["mode"] = "rpc",
): { ctx: ExtensionContext; selectCalls: unknown[][] } {
  const selectCalls: unknown[][] = [];
  const ctx = {
    cwd: "/home/user/project",
    mode,
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    model: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/home/user/.pi/agent/sessions/${sessionId}.jsonl`,
      getEntries: () => [],
    },
    ui: {
      select: vi.fn(async (title: string, options: string[]) => {
        selectCalls.push([title, options]);
        return INFLIGHT_REPORT_ACK;
      }),
    },
  } as unknown as ExtensionContext;
  return { ctx, selectCalls };
}

function injectFakeServices(): void {
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

beforeEach(() => {
  vi.clearAllMocks();
  mockStoreLoadAll.mockResolvedValue([]);
  resetLifecycleSlots();
  _resetOncePerProcessForTest();
  _resetNotifyLedgerForTest();
  injectFakeServices();
});

afterEach(() => {
  resetLifecycleSlots();
});

describe("组合根接线：初始上报时点（u7a 验收）", () => {
  function mount(): { pi: ExtensionAPI; handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown> } {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const noop = (): void => undefined;
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler as (event: unknown, ctx: ExtensionContext) => unknown);
      },
      appendEntry: noop,
      events: { emit: vi.fn() },
      sendMessage: noop,
    } as unknown as ExtensionAPI;
    subagentsExtension(pi);
    return { pi, handlers };
  }

  it("session_start 即发初始上报，不等 setupSessionLifecycle await 链（fire-and-forget）", async () => {
    const { pi, handlers } = mount();
    const { ctx, selectCalls } = makeCtx();

    const startHandler = handlers.get("session_start");
    expect(startHandler).toBeDefined();

    // 不 await：handler 同步前缀（attachSession）应已发起初始帧
    const running = startHandler!({ type: "session_start" }, ctx) as Promise<void>;
    expect(selectCalls).toHaveLength(1);
    const [title, options] = selectCalls[0] as [string, string[]];
    expect(title).toBe(SUBAGENT_INFLIGHT_MARKER);
    const frame: unknown = JSON.parse(options[0] ?? "{}");
    // 帧过契约守卫（u7b event-adapter 的同一信任边界）；kind 字段已删
    //（2026-09-13 oe-audit：消费端不读，死字段）
    expect(isSubagentInFlightReport(frame)).toBe(true);
    expect(frame).not.toHaveProperty("kind");
    // 真实 core 快照（空态）：无任何 subagent 调用的 session 也必上报 count=0
    expect((frame as { inFlight: number }).inFlight).toBe(0);
    expect((frame as { sessionId?: string }).sessionId).toBe("sess-inflight-wiring");

    await running;
  });

  it("ack 送达后通道静默；session_shutdown 摘除后无残余调用", async () => {
    const { handlers } = mount();
    const { ctx, selectCalls } = makeCtx();

    await handlers.get("session_start")!({ type: "session_start" }, ctx);
    expect(selectCalls).toHaveLength(1); // 初始帧已 ack（fake select 立即回 ack）

    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "new" }, ctx);
    // 关键：detach 后（含真实重试定时器语义）无任何残余推送
    await new Promise((r) => setTimeout(r, 20));
    expect(selectCalls).toHaveLength(1);
    expect(mockTerminateRunningRuns).toHaveBeenCalled(); // shutdown 装配链正常走完（未被上报阻塞）
  });

  it("环境门控：非 rpc 模式（裸 pi TUI）不启动上报——marker select 无拦截方不弹框", async () => {
    const { handlers } = mount();
    const { ctx, selectCalls } = makeCtx("sess-tui-mode", "tui");

    await handlers.get("session_start")!({ type: "session_start" }, ctx);
    // 等待任何潜在的延迟推送（重试/异步链）——门控后应零调用
    await new Promise((r) => setTimeout(r, 20));
    expect(selectCalls).toHaveLength(0);

    // 迁移点回调同样 no-op（ctx 从未注入）
    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "new" }, ctx);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("createInFlightReporter：有界重试（2026-09-13 oe-audit，原无限重试收敛）", () => {
  // 重试 timer 走 setTimeout（retryDelayMs），select 为 stub 立即 resolve——fake timers
  // 确定性驱动整条重试链，不依赖真实时序。
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 最小 ctx：select 恒超时折叠（resolve undefined = 无 ack），模拟无拦截方通道。 */
  function neverAckCtx(selectCalls: unknown[][]): ExtensionContext {
    return {
      mode: "rpc",
      sessionManager: { getSessionId: () => "sess-bounded" },
      ui: {
        select: vi.fn(async (title: string, options: string[]) => {
          selectCalls.push([title, options]);
          return undefined;
        }),
      },
    } as unknown as ExtensionContext;
  }

  it("连续失败达 maxAttempts 放弃（不再重试）；ack 成功清零计数恢复重试资格", async () => {
    const { createInFlightReporter } = await import("../host/inflight-reporter.ts");
    const reporter = createInFlightReporter({
      selectTimeoutMs: 1,
      retryDelayMs: 1,
      maxAttempts: 3,
    });
    const selectCalls: unknown[][] = [];
    const ctx = neverAckCtx(selectCalls);

    reporter.attachSession(ctx);
    await vi.advanceTimersByTimeAsync(30);
    // 放弃后停止：初始 1 次 + 重试 2 次 = maxAttempts 次，之后静默
    expect(selectCalls).toHaveLength(3);
    const settled = selectCalls.length;
    reporter.onInFlightChanged();
    await vi.advanceTimersByTimeAsync(20);
    expect(selectCalls).toHaveLength(settled); // 已放弃，迁移点不再触发推送

    // ack 恢复路径：换一个恒 ack 的 ctx（模拟 runtime 就绪后的新 session）
    const ackCtx = {
      ...ctx,
      ui: {
        select: vi.fn(async (title: string, options: string[]) => {
          selectCalls.push([title, options]);
          return INFLIGHT_REPORT_ACK;
        }),
      },
    } as unknown as ExtensionContext;
    reporter.detachSession();
    reporter.attachSession(ackCtx);
    await vi.advanceTimersByTimeAsync(5);
    expect(selectCalls).toHaveLength(settled + 1); // 新 epoch 首帧即 ack
  });

  it("失败重试在 maxAttempts 内：ack 到达即停（不再多发）", async () => {
    const { createInFlightReporter } = await import("../host/inflight-reporter.ts");
    const reporter = createInFlightReporter({
      selectTimeoutMs: 1,
      retryDelayMs: 1,
      maxAttempts: 10,
    });
    const selectCalls: unknown[][] = [];
    // 第 1 次失败（无 ack），第 2 次 ack
    let call = 0;
    const ctx = {
      mode: "rpc",
      sessionManager: { getSessionId: () => "sess-retry" },
      ui: {
        select: vi.fn(async (title: string, options: string[]) => {
          selectCalls.push([title, options]);
          call += 1;
          return call >= 2 ? INFLIGHT_REPORT_ACK : undefined;
        }),
      },
    } as unknown as ExtensionContext;

    reporter.attachSession(ctx);
    await vi.advanceTimersByTimeAsync(30);
    expect(selectCalls).toHaveLength(2); // 失败 1 次 → 重试 1 次 → ack 停
  });
});
