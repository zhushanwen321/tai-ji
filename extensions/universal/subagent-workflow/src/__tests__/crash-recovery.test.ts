// src/__tests__/crash-recovery.test.ts
//
// MF-5: session_start crash recovery 路径测试。
//
// 覆盖 store.loadAll 的 4 个分支（[u-5b / A-V3] 改写）：
//   1. loadAll 成功 + running run → 重建（transition done,failed + emit pending:unregister failed）
//      ——被测行为在装配链内（kill-9 恢复循环），seam 直测 setupSessionLifecycle +
//      deps.createRunStore 注入 fake（零整类 mock）
//   2. loadAll 成功 + 已终态 run → 直接 set 到 runs Map，不 transition
//   3. loadAll 失败 → storeHealthy=false，pi.__workflowRun 返回失败（fail-fast）
//   4. loadAll 失败后 subagent 域不受影响（subagent tool 注册仍被调用）
//      ——被测行为在组合根（pi.__workflowRun 守卫消费点 / factory 入口注册），
//      保留挂载 index.ts；mock 面收窄：仅 jsonl-run-store（store 可控点）+
//      双 Service 经访问器槽注入 fake（globalThis 槽，不整类 mock）。
//      it4 的「注册」观察从 module mock（registerSubagentTool spy）改为 pi.registerTool
//      捕获（tool name "subagent"），断言意图不变（观察面等价迁移，deviation 已登记）。
//
// 路径说明：index.ts 经 session-lifecycle.ts 从 ./jsonl-run-store.ts 导入 JsonlRunStore，
// 从本测试文件（src/__tests__/）相对路径为 ../jsonl-run-store.ts。

import { beforeEach, describe, expect, it, vi } from "vitest";

// JsonlRunStore mock：mount 用例的 store 可控点（loadAll 由各 test 配置；构造参数
// 忽略）。dispose/flushPendingSaves：session_shutdown handler 会调 state.store.dispose()
//（W2C5），防御性补齐防 mock 缺方法 TypeError。
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

// ── import 被测模块 ──
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// session_start 的 recoverCrashedRuns 经 oncePerProcess 守卫（u-audit-fix），守卫 Map
// 是模块级状态：beforeEach resetModules + 动态 import 每用例取新鲜模块实例，否则首用例
// 消费 key 后，后续用例的恢复链静默不执行（storeHealthy=false 等断言失真）。
// seam 直测用例同因改用例内动态 import setupSessionLifecycle——静态引用跨 resetModules
// 存活（守卫 Map 不随用例重置），后续 seam 用例会被已消费的 key 静默旁路。
let subagentsExtension: typeof import("../index.ts").default;
import { Budget } from "@zhushanwen/subagent-core";
import { Trace } from "@zhushanwen/subagent-core";
import { setModelConfigService, setSubagentService } from "@zhushanwen/subagent-core";
import { WorkflowRun } from "@zhushanwen/subagent-core";
import type { WorkflowRun as WorkflowRunType } from "@zhushanwen/subagent-core";
import type { SessionLifecycleDeps } from "../session-lifecycle.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

/** 构造一个可重水合的 WorkflowRun（用 WorkflowRun.reconstruct 跳过 I1 校验）。 */
function makeRun(
  runId: string,
  status: "running" | "done",
  reason?: "completed" | "failed" | "aborted" | "budget_limited" | "time_limited",
): WorkflowRunType {
  return WorkflowRun.reconstruct(
    runId,
    {
      scriptSource: "execute() {}",
      args: {},
      scriptName: "test",
      scriptPath: "/fake/test.js",
    },
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

/** 重置双 Service 单例槽（setter 不接受 null，测试清理用 Symbol 直写；
 *  key 与生产 getServiceSlot / getModelServiceSlot 的 Symbol.for 一致）。 */
function resetLifecycleSlots(): void {
  for (const key of ["@zhushanwen/pi-subagents.service", "@zhushanwen/pi-subagents.model-service"]) {
    const slot = Reflect.get(globalThis, Symbol.for(key)) as { current: unknown } | undefined;
    if (slot) slot.current = null;
  }
}

/** fake 双 Service（经访问器槽注入；含 mount 用例消费的 getStreamSink/dispose）。 */
function injectLifecycleFakes(): void {
  setSubagentService({
    initSession: vi.fn(),
    recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
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
}

/** 可观察 eventBus.emit 的 fake pi（seam 直测用）。 */
function createFakePi(): {
  pi: ExtensionAPI;
  emits: Array<{ channel: string; data: unknown }>;
} {
  const emits: Array<{ channel: string; data: unknown }> = [];
  const noop = (): void => {
    /* fake */
  };
  const pi = {
    appendEntry: noop,
    events: {
      emit(channel: string, data: unknown): void {
        emits.push({ channel, data });
      },
    },
    on: noop,
    sendMessage: noop,
  } as unknown as ExtensionAPI;
  return { pi, emits };
}

/** 最小 fake ExtensionContext。 */
function createFakeCtx(): ExtensionContext {
  return {
    cwd: "/home/user/project",
    // [Wave1 #21] mode 必填（与 SDK ExtensionContext 契约一致）；默认 tui。
    mode: "tui",
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    },
    model: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "session-crash",
      getSessionFile: () => "/home/user/.pi/agent/sessions/session-crash.jsonl",
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;
}

/** 挂载 index.ts 并跑一次 session_start（store loadAll 行为可配），返回观察面：
 *  pi（含 __workflowRun）/ eventBus emits / 已注册 tool 名清单。 */
async function mountWithLoadAll(loadAll: () => Promise<WorkflowRunType[]>): Promise<{
  pi: ExtensionAPI;
  emits: Array<{ channel: string; data: unknown }>;
  registeredToolNames: string[];
}> {
  resetLifecycleSlots();
  mockStoreLoadAll.mockImplementation(loadAll);
  injectLifecycleFakes();

  const emits: Array<{ channel: string; data: unknown }> = [];
  const registeredToolNames: string[] = [];
  let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const noop = (): void => {
    /* mock */
  };
  const pi = {
    registerTool: vi.fn((tool: { name?: string }) => {
      if (typeof tool?.name === "string") registeredToolNames.push(tool.name);
    }),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      if (event === "session_start") {
        sessionStartHandler = handler as (event: unknown, ctx: unknown) => Promise<void>;
      }
    },
    appendEntry: noop,
    events: {
      emit(channel: string, data: unknown): void {
        emits.push({ channel, data });
      },
    },
    sendMessage: noop,
  } as unknown as ExtensionAPI;

  subagentsExtension(pi);

  const handler = sessionStartHandler!;
  await handler({ type: "session_start" }, createFakeCtx());

  return { pi, emits, registeredToolNames };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockStoreLoadAll.mockResolvedValue([]);
  resetLifecycleSlots();
  subagentsExtension = (await import("../index.ts")).default;
});

// ── tests ──

describe("session_start crash recovery（store.loadAll 路径）", () => {
  it("loadAll 成功 + running run：transition done,failed + emit pending:unregister failed", async () => {
    // 用例内动态 import：setupSessionLifecycle 的守卫 Map 属模块级状态，随 beforeEach
    // resetModules 取新鲜实例（见文件头注释）
    const { setupSessionLifecycle } = await import("../session-lifecycle.ts");
    const runningRun = makeRun("wf-crash-1", "running");
    const { pi, emits } = createFakePi();
    const deps: SessionLifecycleDeps = {
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
          loadAll: vi.fn(async () => [runningRun]),
          save: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        }) as never,
    };

    await setupSessionLifecycle(pi, createFakeCtx(), deps);

    // run 被转为 done,failed（crash recovery）
    expect(runningRun.state.status).toBe("done");
    expect(runningRun.state.reason).toBe("failed");
    expect(runningRun.state.error).toContain("Process killed");

    // emit pending:unregister（reason=failed）
    const unregister = emits.find((e) => e.channel === "pending:unregister");
    expect(unregister).toBeDefined();
    expect(unregister!.data).toEqual({ id: "wf-crash-1", reason: "failed" });
  });

  it("loadAll 成功 + 已终态 run：直接 set 到 runs Map，不 transition", async () => {
    const doneRun = makeRun("wf-done-1", "done", "completed");
    const originalCompletedAt = doneRun.meta.completedAt;
    const { pi, emits } = await mountWithLoadAll(async () => [doneRun]);

    // 状态不变（仍 done/completed），不重新 transition（completedAt 不变）
    expect(doneRun.state.status).toBe("done");
    expect(doneRun.state.reason).toBe("completed");
    expect(doneRun.meta.completedAt).toBe(originalCompletedAt);

    // 终态 run 不触发 pending:unregister（恢复路径只处理 status==="running"）
    const unregister = emits.filter((e) => e.channel === "pending:unregister");
    expect(unregister).toHaveLength(0);

    // run 已被 set 到 runs Map —— pi.__workflowRun 在 storeHealthy=true 时
    // 不会因 store unavailable 提前返回
    const result = (await (pi as unknown as {
      __workflowRun: (n: string, a: Record<string, unknown>) => Promise<unknown>;
    }).__workflowRun("any", {})) as { error?: string };
    expect(result.error).not.toContain("store unavailable");
  });

  it("loadAll 失败 → storeHealthy=false：pi.__workflowRun 返回 store unavailable 失败", async () => {
    const { pi } = await mountWithLoadAll(async () => {
      throw new Error("disk corruption");
    });

    // pi.__workflowRun 在 store 不健康时 fail-fast
    const result = (await (pi as unknown as {
      __workflowRun: (n: string, a: Record<string, unknown>) => Promise<unknown>;
    }).__workflowRun("any", {})) as { status: string; reason: string; error: string };

    expect(result.status).toBe("done");
    expect(result.reason).toBe("failed");
    expect(result.error).toContain("store unavailable");
    expect(result.error).toContain("loadAll failed");
  });

  it("loadAll 失败后 subagent 域不受影响：registerSubagentTool 仍被调用", async () => {
    const { registeredToolNames } = await mountWithLoadAll(async () => {
      throw new Error("disk corruption");
    });

    // subagent tool 注册在 factory 入口（session_start 之外），与 store 健康无关
    //（观察面从 registerSubagentTool module spy 迁移为 pi.registerTool 捕获，
    // 断言意图不变：subagent 域 tool 已注册）
    expect(registeredToolNames).toContain("subagent");
  });
});
