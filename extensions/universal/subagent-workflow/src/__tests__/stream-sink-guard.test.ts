// src/__tests__/stream-sink-guard.test.ts
//
// streamSink ctx.mode guard — 运行时测试（FR-1/FR-2/AC-1/AC-2）。
//
// [B7] 从纯源码正则断言升级为运行时行为断言：真正调装配逻辑，mock ctx.mode 为
// tui/json/print，断言 initSession 收到的 streamSink === undefined；rpc mode 断言是
// 包装 ctx.ui.setWidget 的 sink 对象。
//
// [u-5b / A-V3] 改写为 bootstrap seam 直测（设计 §3.1）：streamSink 接线住在
// session-lifecycle.ts 的默认 createOrReuseServices 内（initSession 参数组装处），
// 本文件经单例访问器槽（setSubagentService/setModelConfigService，globalThis 槽）
// 注入 fake service/model——默认装配走 existing 分支复用 fake，initSession 参数
// 在 fake 上可观察。不再挂载 index.ts、不再整类 mock SubagentService/pi-ai/typebox
// （pi-coding-agent 运行时值由包根 mocks/ alias 提供）。
//
// 断言契约来源：session-lifecycle.ts createOrReuseServices 内
//   streamSink: ctx.mode === "rpc" ? { setWidget: (key, lines) => ctx.ui.setWidget(...) } : undefined
// TUI/json/print 下 streamSink=undefined（无 widget 噪音）；rpc 下注入 ctx.ui.setWidget 包装。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { setModelConfigService, setSubagentService } from "@zhushanwen/subagent-core";
import { setupSessionLifecycle } from "../session-lifecycle.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

/** 最小 typed fake pi（appendEntry/events.emit/on/sendMessage 四成员，设计 §3.1 形态）。 */
function createFakePi(): ExtensionAPI {
  const noop = (): void => {
    /* fake */
  };
  return {
    appendEntry: noop,
    events: { emit: vi.fn() },
    on: noop,
    sendMessage: noop,
  } as unknown as ExtensionAPI;
}

/** mode 控制 streamSink 守卫分支的 fake ctx。rpc 下 ui 必须有 setWidget。 */
function createFakeCtx(mode: "tui" | "rpc" | "json" | "print"): ExtensionContext & {
  ui: { setWidget: ReturnType<typeof vi.fn> } | undefined;
} {
  const ui = mode === "rpc" ? { setWidget: vi.fn() } : undefined;
  return {
    cwd: "/home/user/project",
    mode,
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    model: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "session-stream-1",
      getSessionFile: () => "/home/user/.pi/agent/sessions/session-stream-1.jsonl",
      getEntries: () => [],
    },
    ui,
  } as unknown as ExtensionContext & { ui: { setWidget: ReturnType<typeof vi.fn> } | undefined };
}

/** 可控 fake store（注入 deps.createRunStore）。 */
function makeFakeStore(): { loadAll: () => Promise<unknown[]>; save: () => Promise<void>; dispose: () => Promise<void> } {
  return {
    loadAll: vi.fn(async () => []),
    save: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

/** 重置双 Service 单例槽（setter 不接受 null，测试清理用 Symbol 直写；
 *  key 与生产 getServiceSlot / getModelServiceSlot 的 Symbol.for 一致）。 */
function resetLifecycleSlots(): void {
  for (const key of ["@zhushanwen/pi-subagents.service", "@zhushanwen/pi-subagents.model-service"]) {
    const slot = Reflect.get(globalThis, Symbol.for(key)) as { current: unknown } | undefined;
    if (slot) slot.current = null;
  }
}

/**
 * 注入 fake 双 Service（访问器槽）+ fake wtm/store，跑一次完整 session 装配，
 * 返回 fake service 的 initSession spy（接线参数观察面）。
 */
async function runSessionAssembly(ctx: ExtensionContext): Promise<ReturnType<typeof vi.fn>> {
  const mockInitSession = vi.fn();
  setSubagentService({
    initSession: mockInitSession,
    recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
    startGcTimer: vi.fn(),
    getStreamSink: () => null,
    dispose: vi.fn(),
  } as never);
  setModelConfigService({
    initModel: vi.fn(),
    // lastEngine 基线读取：absent → 归一 'pi'（与旧实现 readGlobalConfig 缺文件时一致）
    reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
  } as never);
  await setupSessionLifecycle(createFakePi(), ctx, {
    worktreeManager: { scan: vi.fn(async () => {}) },
    createRunStore: () => makeFakeStore() as never,
  });
  return mockInitSession;
}

/** initSession 参数的 streamSink 字段形状（断言 mock 调用参数）。
 *  必填 streamSink 字段（非全可选）以避免 taste/no-unsafe-cast 全可选断言 warn；
 *  streamSink 运行时可能为 undefined（tui/json/print 下守卫产 undefined）。 */
type InitSessionArg = { streamSink: unknown };

beforeEach(() => {
  vi.clearAllMocks();
  resetLifecycleSlots();
});

afterEach(() => {
  resetLifecycleSlots();
});

// ── 运行时断言 ──

describe("streamSink ctx.mode guard — 运行时行为（FR-1/FR-2/AC-1/AC-2）", () => {
  it("tui mode：initSession 收到 streamSink === undefined（无 widget 噪音）", async () => {
    const mockInitSession = await runSessionAssembly(createFakeCtx("tui"));

    expect(mockInitSession).toHaveBeenCalledTimes(1);
    const initArg = mockInitSession.mock.calls[0]?.[0] as InitSessionArg;
    // [B7] 运行时断言：守卫在 tui 下真的产出 undefined（不是源码里有就够）
    expect(initArg.streamSink).toBeUndefined();
  });

  it("json mode（headless）：initSession 收到 streamSink === undefined", async () => {
    const mockInitSession = await runSessionAssembly(createFakeCtx("json"));

    const initArg = mockInitSession.mock.calls[0]?.[0] as InitSessionArg;
    expect(initArg.streamSink).toBeUndefined();
  });

  it("print mode：initSession 收到 streamSink === undefined", async () => {
    const mockInitSession = await runSessionAssembly(createFakeCtx("print"));

    const initArg = mockInitSession.mock.calls[0]?.[0] as InitSessionArg;
    expect(initArg.streamSink).toBeUndefined();
  });

  it("rpc mode（GUI/taiji）：initSession 收到 streamSink 是 { setWidget } 对象（守卫放行）", async () => {
    const mockInitSession = await runSessionAssembly(createFakeCtx("rpc"));

    const initArg = mockInitSession.mock.calls[0]?.[0] as InitSessionArg;
    // rpc 守卫放行：streamSink 注入了包装 ctx.ui.setWidget 的 sink 对象
    expect(initArg.streamSink).toBeDefined();
    expect(typeof initArg.streamSink).toBe("object");
    expect(typeof (initArg.streamSink as { setWidget: unknown }).setWidget).toBe("function");
  });

  it("rpc mode：streamSink.setWidget 转发到 ctx.ui.setWidget（绑定真实方法）", async () => {
    const ctx = createFakeCtx("rpc");
    const mockInitSession = await runSessionAssembly(ctx);

    const initArg = mockInitSession.mock.calls[0]?.[0] as InitSessionArg;
    (initArg.streamSink as { setWidget: (key: string, lines: string[]) => void }).setWidget("key1", ["line-a"]);
    // 转发到注入时的 ctx.ui.setWidget
    const uiSetWidget = (ctx.ui as { setWidget: ReturnType<typeof vi.fn> }).setWidget;
    expect(uiSetWidget).toHaveBeenCalledWith("key1", ["line-a"]);
  });
});
