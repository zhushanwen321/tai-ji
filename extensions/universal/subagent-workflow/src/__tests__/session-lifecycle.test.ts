// src/__tests__/session-lifecycle.test.ts
//
// u-4 行为变更点测试（设计 §3.1/D1/D2，impl-plan 验收 4「各自配测试」）：
//
//   1. bootstrap seam 直测——setupSessionLifecycle(pi, ctx, deps) 以 deps 注入
//      fake（worktreeManager/createServices/createRunStore）验证装配行为，
//      不挂载 index.ts、零整类 mock（设计 §3.1「使用者视角」样例的落地）。
//   2. 守卫合一——原 pi.__workflowRun 内联守卫与 getDeps 守卫两份重复合并为
//      单一 getWorkflowDeps 出口后，两个消费点（返回错误对象 / throw）对同一
//      失败态产生同源同消息的失败形态（错误消息逐字保留，crash-recovery 已锁
//      "store unavailable" / "loadAll failed" 子串）。
//
// mock 面说明：第 2 组用例必须挂载 index.ts（守卫消费点是其闭包内符号），沿
// crash-recovery.test.ts 的 module 级 vi.mock 先例；打桩面收敛是 u-5b 领地。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules（在 import 前声明）──

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/home/user/.pi/agent",
}));
vi.mock("@zhushanwen/subagent-core/execution/worktree-manager.ts", () => ({
  WorktreeManager: class {
    scan = vi.fn(async () => {});
    cleanup = vi.fn();
    create = vi.fn();
    collectPatch = vi.fn();
    registerPid = vi.fn();
  },
}));
vi.mock("@zhushanwen/subagent-core/execution/session-file-gc.ts", () => ({
  maybeCleanupExpiredSessionFiles: vi.fn(),
}));

// seam 组（第 1 组 describe）直接 import session-lifecycle——它消费的默认实现走
// 下列 mock；seam 用例全部经 deps 注入 fake，mock 仅作默认实现的安全网。
vi.mock("@zhushanwen/subagent-core/execution/model-config-service.ts", () => ({
  ModelConfigService: class {
    initModel = vi.fn();
    reloadGlobalConfig = vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } }));
  },
  getModelConfigService: () => null,
  setModelConfigService: vi.fn(),
}));
// [H3/R6 连带] R6 把单例访问器族外移 service/service-bootstrap.ts（barrel 改从 bootstrap
// re-export），SubagentService 类仍从壳直接导出——mock 必须按 barrel 实际取符号的两条
// 路径分开挂：壳 mock 留 SubagentService 假类（拦 new 分支构造），bootstrap mock 经
// importOriginal 只替换单例访问器（拦槽读写；真实 createSubagentService 保留——其内部
// new 的是模块图中已被 mock 的假壳类，行为等价 R6 前）。
vi.mock("@zhushanwen/subagent-core/execution/subagent-service.ts", () => ({
  SubagentService: class {
    initSession = vi.fn();
    recoverManifestTmpFiles = vi.fn(async () => ({ deleted: 0, recovered: 0 }));
    // [U4c/G1] boot 全量重建钩子（runProcessLevelMaintenance 消费面）
    rebuildIndexes = vi.fn(() => 0);
    startGcTimer = vi.fn();
  },
}));
vi.mock(
  "@zhushanwen/subagent-core/execution/service/service-bootstrap.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<typeof import("@zhushanwen/subagent-core/execution/service/service-bootstrap.ts")>();
    return { ...actual, getSubagentService: () => null, setSubagentService: vi.fn() };
  },
);

// 守卫组（挂载 index.ts）的 store 可控点：index.ts 走默认 createRunStore（真实
// JsonlRunStore 类经 mock 替换），loadAll 行为由 mountWithLoadAll 注入。
const { mockStoreLoadAll } = vi.hoisted(() => ({
  mockStoreLoadAll: vi.fn(async () => []),
}));
vi.mock("../jsonl-run-store.ts", () => ({
  JsonlRunStore: class {
    loadAll = mockStoreLoadAll;
    save = vi.fn(async () => {});
    dispose = vi.fn(async () => {});
    flushPendingSaves = vi.fn(async () => {});
  },
}));

// 守卫组（第 2 组 describe）挂载 index.ts 所需的 interface 层 mock（防真实
// registerTool 打在 Proxy pi 上）；registerWorkflowTool 捕获 lazyDeps 供断言。
const { mockRegisterWorkflowTool } = vi.hoisted(() => ({
  mockRegisterWorkflowTool: vi.fn(),
}));
vi.mock("../interface/subagent-tool.ts", () => ({
  registerSubagentTool: vi.fn(),
}));
vi.mock("../interface/subagents.ts", () => ({
  registerSubagentsCommand: vi.fn(),
}));
vi.mock("../interface/bg-notify-render.ts", () => ({
  renderBgNotifyMessage: vi.fn(),
}));
vi.mock("../interface/tool-workflow.ts", () => ({
  registerWorkflowTool: mockRegisterWorkflowTool,
}));
vi.mock("../interface/tool-workflow-script.ts", () => ({
  registerWorkflowScriptTool: vi.fn(),
}));
vi.mock("../interface/commands.ts", () => ({
  registerWorkflowsCommand: vi.fn(),
}));

// ── import 被测模块 ──
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { IDENTITY_CUSTOM_TYPE } from "@zhushanwen/subagent-core";
import type { WorkflowRun as WorkflowRunType } from "@zhushanwen/subagent-core/orchestration/models/workflow-run.ts";
import { WorkflowRun } from "@zhushanwen/subagent-core";
import { Budget } from "@zhushanwen/subagent-core";
import { Trace } from "@zhushanwen/subagent-core";
import type { SessionLifecycleDeps } from "../session-lifecycle.ts";

// resetModules 每用例重新加载 index.ts 副本，factory 体内的 process 信号 hook
//（SIGTERM/SIGINT/beforeExit 收割防线）随之叠加注册——本文件挂载用例超 Node 默认
// listener 阈值 10 触发误报警告，抬高上限（生产单副本恒 3 个 listener，无此形态）。
process.setMaxListeners(50);

// session_start 的六项跨 session 副作用操作经 oncePerProcess 守卫（u-audit-fix），
// 守卫 Map 是模块级状态：beforeEach resetModules + 动态 import 每用例取新鲜模块实例，
// 否则首用例消费 key 后，后续用例的 loadAll 失败 / kill-9 恢复链静默旁路
//（storeHealthy 恒 true 等断言失真）。组 1 用例内动态 import setupSessionLifecycle；
// 组 1「new 分支」用例的 setter/instanceof 断言同样须取当用例动态图的 barrel 实例——
// mock 的 vi.fn 随模块图重建，静态引用属首载图，断言会读到另一实例的空 calls。
let subagentsExtension: typeof import("../index.ts").default;

// ── helpers ──

interface EntryRecord {
  customType: string;
  data: unknown;
}

/** 最小 typed fake pi：appendEntry/events.emit/on/sendMessage 四成员（设计 §3.1 fake 形态）。 */
function createFakePi(): {
  pi: ExtensionAPI;
  entries: EntryRecord[];
  emits: Array<{ channel: string; data: unknown }>;
} {
  const entries: EntryRecord[] = [];
  const emits: Array<{ channel: string; data: unknown }> = [];
  const noop = (): void => { /* fake */ };
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
    events: {
      emit: (channel: string, data: unknown) => {
        emits.push({ channel, data });
      },
    },
    on: noop,
    sendMessage: noop,
  } as unknown as ExtensionAPI;
  return { pi, entries, emits };
}

/** 最小 ExtensionContext fake。 */
function createFakeCtx(sessionId = "session-seam-1"): ExtensionContext {
  return {
    cwd: "/home/user/project",
    mode: "tui",
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    model: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => "/home/user/.pi/agent/sessions/seam.jsonl",
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;
}

/** 构造可重水合的 WorkflowRun（reconstruct 跳过 I1 校验）。 */
function makeRun(runId: string, status: "running" | "done"): WorkflowRunType {
  return WorkflowRun.reconstruct(
    runId,
    { scriptSource: "execute() {}", args: {}, scriptName: "test", scriptPath: "/fake/test.js" },
    {
      status,
      reason: status === "done" ? "completed" : undefined,
      budget: new Budget({ maxTokens: 1000 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
}

/** 构造可控 fake store（注入 deps.createRunStore）。 */
function makeFakeStore(loadAll: () => Promise<WorkflowRunType[]>): {
  loadAll: () => Promise<WorkflowRunType[]>;
  save: (run: WorkflowRunType) => Promise<void>;
  dispose: () => Promise<void>;
} {
  return {
    loadAll,
    save: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockStoreLoadAll.mockResolvedValue([]);
  subagentsExtension = (await import("../index.ts")).default;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── 组 1：bootstrap seam（deps 注入直测） ────────────────────────────────────────

describe("setupSessionLifecycle — bootstrap seam（设计 §3.1）", () => {
  it("deps.worktreeManager 注入 fake：session_start 恰好 scan 一次（ADR-035 reaper 一行行为一个注入点）", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const { pi } = createFakePi();
    const fakeWtm = { scan: vi.fn(async () => {}) };
    const deps: SessionLifecycleDeps = { worktreeManager: fakeWtm };

    await setupSessionLifecycle(pi, createFakeCtx(), deps);

    expect(fakeWtm.scan).toHaveBeenCalledTimes(1);
    expect(fakeWtm.scan).toHaveBeenCalledWith();
  });

  it("deps.createServices 注入 fake：装配走注入工厂，其 service 供 manifest 恢复与 SAR 委托", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const { pi } = createFakePi();
    const fakeService = {
      recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
      rebuildIndexes: vi.fn(() => 0),
    };
    const fakeModelService = {
      reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
    };
    const createServices = vi.fn(() => ({
      service: fakeService,
      modelService: fakeModelService,
      reused: false,
    }));
    const deps: SessionLifecycleDeps = {
      createServices: createServices as unknown as SessionLifecycleDeps["createServices"],
    };

    const result = await setupSessionLifecycle(pi, createFakeCtx("session-svc-1"), deps);

    expect(createServices).toHaveBeenCalledTimes(1);
    expect(fakeService.recoverManifestTmpFiles).toHaveBeenCalledTimes(1);
    // 装配结果回传：sessionId/storeHealthy/lastEngine（absent → 归一 'pi'）
    expect(result.sessionId).toBe("session-svc-1");
    expect(result.storeHealthy).toBe(true);
    expect(result.lastEngine).toBe("pi");
  });

  it("默认 createServices（访问器槽为 null）→ new 分支：双 Service 构造 + 双 set 各恰一次 + init 无条件执行（D8）", async () => {
    // module mock 的访问器槽恒 null（getSubagentService/getModelConfigService），
    // deps 不注入 createServices → 走默认 createOrReuseServices 的 new 半边
    // （existing-??-new）。设计 §3.1「单例语义保持」+ §3.6 D8：仅 !existing 时
    // set；initModel/initSession 无条件执行——existingService === null ⟹
    // reused === false（createOrReuseServices 的 reused 仅由 existing 派生，无
    // 任何「跳过 init」分支），故构造 + 双 set 即 reused=false 的构造性证据。
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const { pi } = createFakePi();

    await setupSessionLifecycle(pi, createFakeCtx("session-new-1"), {});

    // 双 set 各恰一次，写入的是新构造实例（mock 类被实例化 = new 分支发生）。
    // 断言目标取当用例动态图的 barrel 实例（与被测 setupSessionLifecycle 消费同一
    // mock 实例——vi.mock 子路径解析归一到 barrel re-export 的同一物理模块，但
    // vi.fn 随模块图重建，静态引用属首载图会读到空 calls）。
    const {
      ModelConfigService: ModelConfigServiceOfRun,
      setModelConfigService: setModelConfigServiceOfRun,
      setSubagentService: setSubagentServiceOfRun,
      SubagentService: SubagentServiceOfRun,
    } = await import("@zhushanwen/subagent-core");
    const setSubagentCalls = vi.mocked(setSubagentServiceOfRun).mock.calls;
    const setModelCalls = vi.mocked(setModelConfigServiceOfRun).mock.calls;
    expect(setSubagentCalls).toHaveLength(1);
    expect(setModelCalls).toHaveLength(1);
    const svc = setSubagentCalls[0]?.[0];
    const modelSvc = setModelCalls[0]?.[0];
    expect(svc).toBeInstanceOf(SubagentServiceOfRun);
    expect(modelSvc).toBeInstanceOf(ModelConfigServiceOfRun);
    // init 无条件执行（D8）：new 实例的 initModel/initSession 仍被调（与
    // existing 分支共用同一行接线代码）
    expect(svc?.initSession).toHaveBeenCalledTimes(1);
    expect(modelSvc?.initModel).toHaveBeenCalledTimes(1);
  });

  it("deps.createRunStore 注入 fake：loadAll 成功 → storeHealthy=true，runs 重水合", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const { pi } = createFakePi();
    const doneRun = makeRun("wf-seam-done", "done");
    const fakeStore = makeFakeStore(vi.fn(async () => [doneRun]));
    const deps: SessionLifecycleDeps = {
      createRunStore: vi.fn(() => fakeStore as never),
    };

    const result = await setupSessionLifecycle(pi, createFakeCtx(), deps);

    expect(result.storeHealthy).toBe(true);
    expect(result.runs.has("wf-seam-done")).toBe(true);
    expect(result.store).toBe(fakeStore);
  });

  it("store.loadAll 失败 → result.storeHealthy=false（MF-1 fail-fast 语义经 result 回传）", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const { pi } = createFakePi();
    const fakeStore = makeFakeStore(vi.fn(async () => {
      throw new Error("disk corruption");
    }));
    const deps: SessionLifecycleDeps = { createRunStore: () => fakeStore as never };

    const result = await setupSessionLifecycle(pi, createFakeCtx(), deps);

    expect(result.storeHealthy).toBe(false);
  });

  it("kill-9 恢复：running run 转 done,failed + pending:unregister emit + save 落盘", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const { pi, emits } = createFakePi();
    const runningRun = makeRun("wf-seam-k9", "running");
    const save = vi.fn(async () => {});
    const fakeStore = makeFakeStore(vi.fn(async () => [runningRun]));
    fakeStore.save = save;
    const deps: SessionLifecycleDeps = { createRunStore: () => fakeStore as never };

    const result = await setupSessionLifecycle(pi, createFakeCtx(), deps);

    expect(runningRun.state.status).toBe("done");
    expect(runningRun.state.reason).toBe("failed");
    expect(runningRun.state.error).toContain("Process killed");
    const unregister = emits.find((e) => e.channel === "pending:unregister");
    expect(unregister).toBeDefined();
    expect(unregister!.data).toEqual({ id: "wf-seam-k9", reason: "failed" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.storeHealthy).toBe(true);
  });

  it("子进程 env 注入时 identity custom entry 落 appendEntry（类型 13 字段随迁块，写入 12——不含 @deprecated parentSessionId）", async () => {
    vi.stubEnv("PI_SUBAGENT_SELF_RECORD_ID", "rec-seam-1");
    vi.stubEnv("PI_SUBAGENT_AGENT", "fixer");
    vi.stubEnv("PI_SUBAGENT_MODE", "background");
    vi.stubEnv("PI_SUBAGENT_TASK", "do stuff");
    vi.stubEnv("PI_SUBAGENT_WORKTREE", "true");
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const { pi, entries } = createFakePi();

    await setupSessionLifecycle(pi, createFakeCtx(), {});

    const identityEntry = entries.find((e) => e.customType === IDENTITY_CUSTOM_TYPE);
    expect(identityEntry).toBeDefined();
    expect(identityEntry!.data).toMatchObject({
      id: "rec-seam-1",
      agent: "fixer",
      mode: "background",
      task: "do stuff",
      worktree: true,
      chatMode: false,
    });
  });

  it("主进程（无 PI_SUBAGENT_SELF_RECORD_ID）不写 identity custom entry", async () => {
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const { pi, entries } = createFakePi();

    await setupSessionLifecycle(pi, createFakeCtx(), {});

    expect(entries.find((e) => e.customType === IDENTITY_CUSTOM_TYPE)).toBeUndefined();
  });
});

// ── 组 2：守卫合一（两消费点单一出口，u-4 行为变更点） ──────────────────────────

describe("getWorkflowDeps 守卫合一 — 两消费点同源同消息", () => {
  /** 挂载 index.ts 并跑一次 session_start（loadAll 行为可配），返回守卫观察面。 */
  async function mountWithLoadAll(loadAll: () => Promise<WorkflowRunType[]>): Promise<{
    pi: ExtensionAPI;
    lazyDeps: { store: unknown };
    workflowRun: (n: string, a: Record<string, unknown>) => Promise<{ status: string; reason: string; error?: string; runId: string }>;
  }> {
    mockStoreLoadAll.mockImplementation(loadAll);
    let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const noop = (): void => { /* fake */ };
    const pi = {
      appendEntry: noop,
      events: { emit: noop },
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        if (event === "session_start") {
          sessionStartHandler = handler as (event: unknown, ctx: unknown) => Promise<void>;
        }
      },
      sendMessage: noop,
      registerMessageRenderer: noop,
    } as unknown as ExtensionAPI;

    subagentsExtension(pi);

    const handler = sessionStartHandler!;
    await handler({ type: "session_start" }, createFakeCtx("session-guard-1"));

    // registerWorkflowTool 第二参 = lazyDeps（LauncherDeps getter 形态，u-5b 领地改写）
    const lazyDeps = mockRegisterWorkflowTool.mock.calls[0]?.[1] as { store: unknown };
    const workflowRun = (pi as unknown as {
      __workflowRun: (n: string, a: Record<string, unknown>) => Promise<{ status: string; reason: string; error?: string; runId: string }>;
    }).__workflowRun.bind(pi);
    return { pi, lazyDeps, workflowRun };
  }

  it("session 未初始化：tool 侧消费点（lazyDeps getter）throw 'Session not initialized'", async () => {
    // 新 factory 实例，不触发 session_start——sessionState 为空。
    const noop = (): void => { /* fake */ };
    const rawPi = {
      appendEntry: noop,
      events: { emit: noop },
      on: noop,
      sendMessage: noop,
      registerMessageRenderer: noop,
    } as unknown as ExtensionAPI;
    subagentsExtension(rawPi);
    const rawLazyDeps = mockRegisterWorkflowTool.mock.calls[mockRegisterWorkflowTool.mock.calls.length - 1]?.[1] as { store: unknown };

    expect(() => rawLazyDeps.store).toThrowError("Session not initialized");
  });

  it("store 不健康：__workflowRun 消费点返回错误对象（fail-fast，不 throw）", async () => {
    const { workflowRun } = await mountWithLoadAll(async () => {
      throw new Error("disk corruption");
    });

    const result = await workflowRun("any", {});

    expect(result.status).toBe("done");
    expect(result.reason).toBe("failed");
    expect(result.error).toContain("store unavailable");
    expect(result.error).toContain("loadAll failed");
  });

  it("store 不健康：两消费点从单一守卫出口拿到逐字相同的消息", async () => {
    const { lazyDeps, workflowRun } = await mountWithLoadAll(async () => {
      throw new Error("disk corruption");
    });

    const apiResult = await workflowRun("any", {});
    let toolSideMessage = "";
    try {
      void lazyDeps.store;
    } catch (err) {
      toolSideMessage = err instanceof Error ? err.message : String(err);
    }

    expect(toolSideMessage).not.toBe("");
    expect(toolSideMessage).toBe(apiResult.error);
  });
});
