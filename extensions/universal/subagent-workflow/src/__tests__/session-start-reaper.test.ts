// src/__tests__/session-start-reaper.test.ts
//
// 验证 session 装配的三个行为（[u-5b / A-V3] 改写为 bootstrap seam 直测，设计 §3.1
// 「使用者视角」样例的落地——被测行为在 session_start 装配链内，直调
// setupSessionLifecycle + fake pi/ctx + deps 注入 fake，不再挂载 index.ts、
// 不再整类 mock SubagentService/pi-ai/typebox）：
//   1. WTM.scan reaper 被调用（best-effort）——deps.worktreeManager 注入 fake
//   2. scan 抛错不阻断启动——后续装配步骤（manifest 恢复接线）仍执行
//   3. mainSessionFile 被缓存并传给 SubagentService——fake service 的 initSession
//      参数观察（访问器槽注入，默认装配 existing 分支复用 fake）
//
// 形态适配（deviation 登记）：旧形态经整类 mock 的 SubagentService 构造参数
// （getMainSessionFile getter）观察缓存；现行生产形态为 initSession.mainSessionFile
// 值直传（session-lifecycle.ts createOrReuseServices），观察面随之迁移，断言意图不变。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { setModelConfigService, setSubagentService } from "@zhushanwen/subagent-core";
import type { SessionLifecycleDeps } from "../session-lifecycle.ts";

// WorktreeManager.scan / manifest 恢复经 oncePerProcess 守卫（u-audit-fix），守卫 Map 是
// 模块级状态：beforeEach resetModules + 用例内动态 import setupSessionLifecycle 每用例
// 取新鲜模块实例，否则首用例消费 key 后「scan 抛错」用例收到重放的成功结果、
// recoverManifestTmpFiles 断言失真（抛错路径静默不测）。

// ── helpers ──────────────────────────────────────────────────────────────────

/** 最小 typed fake pi（appendEntry/events.emit/on/sendMessage 四成员）。 */
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

/** 最小 fake ExtensionContext。 */
function createFakeCtx(): ExtensionContext {
  return {
    cwd: "/home/user/project",
    // [Wave1 #21] mode 必填（与 SDK ExtensionContext 契约一致）；默认 tui。
    mode: "tui",
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    model: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "session-123",
      getSessionFile: () => "/home/user/.pi/agent/sessions/session-123.jsonl",
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;
}

/** 重置双 Service 单例槽（setter 不接受 null，测试清理用 Symbol 直写；
 *  key 与生产 getServiceSlot / getModelServiceSlot 的 Symbol.for 一致）。 */
function resetLifecycleSlots(): void {
  for (const key of ["@zhushanwen/pi-subagents.service", "@zhushanwen/pi-subagents.model-service"]) {
    const slot = Reflect.get(globalThis, Symbol.for(key)) as { current: unknown } | undefined;
    if (slot) slot.current = null;
  }
}

/** fake 双 Service（经访问器槽注入，默认装配 existing 分支复用之，不构造真实 Service）。 */
function injectLifecycleFakes(): {
  mockInitSession: ReturnType<typeof vi.fn>;
  mockRecoverManifestTmpFiles: ReturnType<typeof vi.fn>;
} {
  const mockInitSession = vi.fn();
  const mockRecoverManifestTmpFiles = vi.fn(async () => ({ deleted: 0, recovered: 0 }));
  setSubagentService({
    initSession: mockInitSession,
    recoverManifestTmpFiles: mockRecoverManifestTmpFiles,
    startGcTimer: vi.fn(),
    getStreamSink: () => null,
    dispose: vi.fn(),
  } as never);
  setModelConfigService({
    initModel: vi.fn(),
    // session_start 的 lastEngine 基线读取经本方法（构造性同源）：absent → lastEngine
    // 归一 'pi'，与旧实现 readGlobalConfig 读不到文件时的行为一致
    reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
  } as never);
  return { mockInitSession, mockRecoverManifestTmpFiles };
}

/** 可控 fake store（注入 deps.createRunStore）。 */
function makeFakeStore(): { loadAll: () => Promise<unknown[]>; save: () => Promise<void>; dispose: () => Promise<void> } {
  return {
    loadAll: vi.fn(async () => []),
    save: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

/** 组装 seam deps：fake wtm（scan 行为可配）+ fake store。 */
function makeSeamDeps(scan: () => Promise<void>): SessionLifecycleDeps {
  return {
    worktreeManager: { scan },
    createRunStore: () => makeFakeStore() as never,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  resetLifecycleSlots();
});

afterEach(() => {
  resetLifecycleSlots();
});

// ── tests ──

describe("session_start worktree reaper", () => {
  it("session_start 触发 WTM.scan 调用", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const mockScan = vi.fn(async () => {});
    injectLifecycleFakes();
    const deps = makeSeamDeps(mockScan);

    await setupSessionLifecycle(createFakePi(), createFakeCtx(), deps);

    expect(mockScan).toHaveBeenCalledTimes(1);
    // scan 无参（全局注册表，不依赖 cwd）
    expect(mockScan).toHaveBeenCalledWith();
  });

  it("scan 抛错不阻断 session_start", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    // scan 同步抛错（走 catch 分支）
    const mockScan = vi.fn(() => {
      throw new Error("git not found");
    });
    const { mockRecoverManifestTmpFiles } = injectLifecycleFakes();
    const deps = makeSeamDeps(mockScan as unknown as () => Promise<void>);

    // 不应抛错
    await expect(
      setupSessionLifecycle(createFakePi(), createFakeCtx(), deps),
    ).resolves.toBeDefined();

    // 启动未被阻断：装配后续步骤（ADR-035 manifest 恢复接线）仍执行
    //（旧形态断言 setSubagentService 被调——existing 分支复用 fake 不再 set，
    // 改以「后续装配步骤继续」作为等价阻断观察，deviation 已登记）
    expect(mockRecoverManifestTmpFiles).toHaveBeenCalledTimes(1);
  });

  it("mainSessionFile 被缓存并传给 SubagentService", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const { mockInitSession } = injectLifecycleFakes();
    const deps = makeSeamDeps(vi.fn(async () => {}));

    await setupSessionLifecycle(createFakePi(), createFakeCtx(), deps);

    // initSession 收到 session_start 时缓存解析的 sessionFile
    //（resolveMainSessionFileById 对 stub agentDir 未命中 → 回退 getSessionFile()）
    expect(mockInitSession).toHaveBeenCalledTimes(1);
    const initArg = mockInitSession.mock.calls[0]?.[0] as { mainSessionFile?: string | undefined };
    expect(initArg.mainSessionFile).toBe("/home/user/.pi/agent/sessions/session-123.jsonl");
  });
});
