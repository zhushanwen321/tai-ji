// src/__tests__/session-lifecycle.test.ts
//
// u-4 行为变更点测试（设计 §3.1/D1/D2，impl-plan 验收 4「各自配测试」）：
//
//   1. bootstrap seam 直测——setupSessionLifecycle(pi, ctx, deps) 以 deps 注入
//      fake（worktreeManager/createServices/createRunStore）验证装配行为，
//      不挂载 index.ts、零整类 mock（设计 §3.1「使用者视角」样例的落地）。
//   2. 守卫合一——原 pi.__workflowRun 内联守卫与 getDeps 守卫两份重复合并为
//      单一 getWorkflowDeps 出口后，两个消费点（返回错误对象 / throw）对同一
//      失败态产生同源同消息的失败形态（错误消息逐字保留，组 2 / 组 6 用例锁定
//      "store unavailable" / "loadAll failed" 子串）。
//
// mock 面说明：第 2 组用例必须挂载 index.ts（守卫消费点是其闭包内符号），走
// module 级 vi.mock（jsonl-run-store + interface 层）；打桩面收敛是 u-5b 领地。
// crash-recovery.test.ts 已并入本文件：loadAll 四分支中与组 1 seam 条同契约的
// 不重复设条，独有断言面（B1 第二 session 恢复 / 已终态直 set / 域隔离）在组 6，
// kill-9 真实链路 fixture 在组 7。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── mock modules（在 import 前声明）──

// getAgentDir 可变锚：兜底维护轮行为断言（组 3）把 agentDir 指进临时目录，其余
// 用例消费缺省假路径（形态不变）。
const { mockAgentDir } = vi.hoisted(() => ({
  mockAgentDir: { current: "/home/user/.pi/agent" },
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => mockAgentDir.current,
}));
vi.mock("@zhushanwen/subagent-core/execution/worktree/worktree-manager.ts", () => ({
  WorktreeManager: class {
    scan = vi.fn(async () => {});
    cleanup = vi.fn();
    create = vi.fn();
    collectPatch = vi.fn();
    registerPid = vi.fn();
  },
}));
vi.mock("@zhushanwen/subagent-core/execution/persistence/session-file-gc.ts", () => ({
  maybeCleanupExpiredSessionFiles: vi.fn(),
}));

// seam 组（第 1 组 describe）直接 import session-lifecycle——它消费的默认实现走
// 下列 mock；seam 用例全部经 deps 注入 fake，mock 仅作默认实现的安全网。
vi.mock("@zhushanwen/subagent-core/execution/assembly/model-config-service.ts", () => ({
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
// importOriginal 只替换单例访问器（拦槽读写；真实装配逻辑保留——其内部
// new 的是模块图中已被 mock 的假壳类，行为等价 R6 前；原 createSubagentService
// 工厂已随 2026-09-13 barrel 收窄删除）。
vi.mock("@zhushanwen/subagent-core/execution/subagent-service.ts", () => ({
  SubagentService: class {
    initSession = vi.fn();
    recoverManifestTmpFiles = vi.fn(async () => ({ deleted: 0, recovered: 0 }));
    // [U4c/G1] boot 全量重建钩子（runProcessLevelMaintenance 消费面）
    rebuildIndexes = vi.fn(() => 0);
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
// subagents 批量 tool（u2）：与其余注册调用同一处理——本文件的 fake pi 无
// registerTool（挂载用例只需 factory 跑到 session 生命周期装配）。
vi.mock("../interface/tool-subagents.ts", () => ({
  registerSubagentsTool: vi.fn(),
}));
vi.mock("../interface/tool-workflow-script.ts", () => ({
  registerWorkflowScriptTool: vi.fn(),
}));
vi.mock("../interface/commands.ts", () => ({
  registerWorkflowsCommand: vi.fn(),
}));

// ── import 被测模块（模块图静态加载一次，beforeEach 显式重置模块级状态） ──
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// [W2/V4 D6] 直落断言消费的 protocol SSOT（customType 常量 + status 映射单点）
import { mapReasonToStatus, PENDING_UNREGISTER_ENTRY_TYPE } from "@zhushanwen/extension-protocol";
import { STALE_CTX_MARKER, _resetOncePerProcessForTest } from "@zhushanwen/pi-ext-guards";
import { IDENTITY_CUSTOM_TYPE } from "@zhushanwen/subagent-core";
import { ENV_ROOT_CWD, getSubagentRecordsDir, resolvePiSessionScopedDir, STATE_DIR_NAME } from "@zhushanwen/subagent-core";
import type { WorkflowRun as WorkflowRunType } from "@zhushanwen/subagent-core/orchestration/models/workflow-run.ts";
// 保留窗口 env 通道仅测试消费，深路径直取（对齐 retention 测试先例）
import { STATE_TTL_MS_ENV } from "@zhushanwen/subagent-core/orchestration/file-run-store.ts";
// 通知账本重置导出（beforeEach 显式清空，对齐 index-session-start 先例）
import { _resetNotifyLedgerForTest } from "@zhushanwen/subagent-core/execution/notify/notify-ledger.ts";
import { WorkflowRun } from "@zhushanwen/subagent-core";
import { Budget } from "@zhushanwen/subagent-core";
import { Trace } from "@zhushanwen/subagent-core";
import type { SessionLifecycleDeps } from "../session-lifecycle.ts";
import { bindLedgerHostAndRecover, setupSessionLifecycle } from "../session-lifecycle.ts";
import subagentsExtension from "../index.ts";
// 组 6 域隔离条的调用断言面；vi.mock 已在文件顶部拦截同路径（同一 mock 实例）。
import { registerSubagentTool } from "../interface/subagent-tool.ts";
// 组 1「new 分支」/ 组 3 观察面：单例访问器 + 双 Service 假类（mock 实例，与被测
// 装配消费同一模块图——模块图单实例后静态引用即被测引用）。
import {
  ModelConfigService,
  setModelConfigService,
  setSubagentService,
  SubagentService,
} from "@zhushanwen/subagent-core";

// factory 体内的 process 信号 hook（SIGTERM/SIGINT/beforeExit 收割防线）按 factory
// 调用叠加注册——本文件 5 次 factory 调用（组 2×3 + 组 6×2）计 15 个 listener，超
// Node 默认阈值 10 触发误报警告，抬高上限（生产单 factory 恒 3 个 listener）。
process.setMaxListeners(50);

// ── helpers ──

/** 重置双 Service 单例槽（本文件访问器已被 mock 拦截，槽位正常路径不写入；重置是
 *  防线外兜底——防真实 service-bootstrap 经其他导入面写槽后跨用例泄漏，与
 *  index-session-start 先例同款）。 */
function resetLifecycleSlots(): void {
  for (const key of ["@zhushanwen/pi-subagents.service", "@zhushanwen/pi-subagents.model-service"]) {
    const slot = Reflect.get(globalThis, Symbol.for(key)) as { current: unknown } | undefined;
    if (slot) slot.current = null;
  }
}

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

/** 最小 ExtensionContext fake。mode/ui 可选注入（streamSink 守卫观察面：rpc 下 ui.setWidget）。 */
function createFakeCtx(
  sessionId = "session-seam-1",
  mode: "tui" | "rpc" | "json" | "print" = "tui",
): ExtensionContext & { ui?: { setWidget: ReturnType<typeof vi.fn> } | undefined } {
  return {
    cwd: "/home/user/project",
    mode,
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    model: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => "/home/user/.pi/agent/sessions/seam.jsonl",
      getEntries: () => [],
    },
    ui: mode === "rpc" ? { setWidget: vi.fn() } : undefined,
  } as unknown as ExtensionContext & { ui?: { setWidget: ReturnType<typeof vi.fn> } | undefined };
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

/** 挂载 index.ts 并跑一次 session_start（loadAll 行为可配），返回守卫/恢复观察面：
 *  pi（含 __workflowRun）/ appendEntry entries / lazyDeps / 绑定 __workflowRun。
 *  守卫组（组 2）与 crash-recovery 吸收组（组 6）共用本挂载 harness（仅此一份）。 */
async function mountWithLoadAll(loadAll: () => Promise<WorkflowRunType[]>): Promise<{
  pi: ExtensionAPI;
  entries: EntryRecord[];
  lazyDeps: { store: unknown };
  workflowRun: (n: string, a: Record<string, unknown>) => Promise<{ status: string; reason: string; error?: string; runId: string }>;
}> {
  mockStoreLoadAll.mockImplementation(loadAll);
  let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const entries: EntryRecord[] = [];
  const noop = (): void => { /* fake */ };
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
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
  return { pi, entries, lazyDeps, workflowRun };
}

// [组 5a 瘦身] 模块图静态加载一次（文件顶部 import），beforeEach 显式重置全部被
// 用例消费的模块级状态，与旧「resetModules + 动态 import 全图重求值」等价：
//   ① oncePerProcess 守卫 Map（ext-guards 模块级）——session_start 的六项跨 session
//      副作用（worktree-scan / retention-maintenance-round 等）都经它单次放行；不清则
//      首个挂载/装配用例消费 key 后，后续用例的 scan 断言 / 组 4 维护轮 / kill-9 恢复
//      链静默旁路（storeHealthy 恒 true 等断言失真）。
//   ② 通知账本（core notify-ledger 模块级）——恢复链按 ctx entries 重水合，残留会让
//      账本跨用例带账。
//   ③ 双 Service 单例槽（globalThis Symbol）——resetLifecycleSlots 兜底清空。
//   ④ mock 调用记录——vi.clearAllMocks()（mock 工厂仅创建一次，调用记录逐用例清）。
// 生产代码的模块级可变状态核对结论：cachedMainSessionFile（session-lifecycle.ts）
// 每次 session_start 无条件刷新，无重置必要；workflow 域 sessionState/lsRef 等为
// per-factory 闭包状态，随每次 mount 新建，无跨用例泄漏面。
beforeEach(() => {
  vi.clearAllMocks();
  mockStoreLoadAll.mockResolvedValue([]);
  resetLifecycleSlots();
  _resetOncePerProcessForTest();
  _resetNotifyLedgerForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── 组 1：bootstrap seam（deps 注入直测） ────────────────────────────────────────

describe("setupSessionLifecycle — bootstrap seam（设计 §3.1）", () => {
  it("deps.worktreeManager 注入 fake：session_start 恰好 scan 一次（ADR-035 reaper 一行行为一个注入点）", async () => {
    const { pi } = createFakePi();
    const fakeWtm = { scan: vi.fn(async () => {}) };
    const deps: SessionLifecycleDeps = { worktreeManager: fakeWtm };

    await setupSessionLifecycle(pi, createFakeCtx(), deps);

    expect(fakeWtm.scan).toHaveBeenCalledTimes(1);
    expect(fakeWtm.scan).toHaveBeenCalledWith();
  });

  it("deps.createServices 注入 fake：装配走注入工厂，其 service 供 manifest 恢复与 SAR 委托", async () => {
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
    // createServices（访问器槽为 null）→ 走默认 createOrReuseServices 的 new 半边
    // （existing-??-new）。设计 §3.1「单例语义保持」+ §3.6 D8：仅 !existing 时
    // set；initModel/initSession 无条件执行——existingService === null ⟹
    // reused === false（createOrReuseServices 的 reused 仅由 existing 派生，无
    // 任何「跳过 init」分支），故构造 + 双 set 即 reused=false 的构造性证据。
    const { pi } = createFakePi();

    await setupSessionLifecycle(pi, createFakeCtx("session-new-1"), {});

    // 双 set 各恰一次，写入的是新构造实例（mock 类被实例化 = new 分支发生）。
    // 断言目标 = 静态导入的 mock 实例（与被测 setupSessionLifecycle 消费同一模块
    // 图——模块图单实例后静态引用即被测引用，vi.mock 子路径解析归一到 barrel
    // re-export 的同一物理模块）。
    const setSubagentCalls = vi.mocked(setSubagentService).mock.calls;
    const setModelCalls = vi.mocked(setModelConfigService).mock.calls;
    expect(setSubagentCalls).toHaveLength(1);
    expect(setModelCalls).toHaveLength(1);
    const svc = setSubagentCalls[0]?.[0];
    const modelSvc = setModelCalls[0]?.[0];
    expect(svc).toBeInstanceOf(SubagentService);
    expect(modelSvc).toBeInstanceOf(ModelConfigService);
    // init 无条件执行（D8）：new 实例的 initModel/initSession 仍被调（与
    // existing 分支共用同一行接线代码）
    expect(svc?.initSession).toHaveBeenCalledTimes(1);
    expect(modelSvc?.initModel).toHaveBeenCalledTimes(1);
  });

  it("deps.createRunStore 注入 fake：loadAll 成功 → storeHealthy=true，runs 重水合", async () => {
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
    const { pi } = createFakePi();
    const fakeStore = makeFakeStore(vi.fn(async () => {
      throw new Error("disk corruption");
    }));
    const deps: SessionLifecycleDeps = { createRunStore: () => fakeStore as never };

    const result = await setupSessionLifecycle(pi, createFakeCtx(), deps);

    expect(result.storeHealthy).toBe(false);
  });

  it("kill-9 恢复：running run 转 done,failed + pending:unregister appendEntry 直落（不经 emit）+ save 落盘", async () => {
    const { pi, entries, emits } = createFakePi();
    // 通知发送面 spy 化：守卫「中断 run 不产生 workflow-result 完成通知」（[W2 场景 4]
    // 断言——收编路径无通知回调，构造性成立；若未来壳侧装配误把 onRunDone 接进恢复
    // 链，此断言红灯）
    const sendMessage = vi.fn();
    pi.sendMessage = sendMessage;
    const runningRun = makeRun("wf-seam-k9", "running");
    const save = vi.fn(async () => {});
    const fakeStore = makeFakeStore(vi.fn(async () => [runningRun]));
    fakeStore.save = save;
    const deps: SessionLifecycleDeps = { createRunStore: () => fakeStore as never };

    const result = await setupSessionLifecycle(pi, createFakeCtx(), deps);

    expect(runningRun.state.status).toBe("done");
    expect(runningRun.state.reason).toBe("failed");
    expect(runningRun.state.error).toContain("Process killed");
    // [W2/V4 D6] 注销直落权威面：appendEntry 直接落盘（emit 链在 reload 转换窗
    // 失效——[reload-closeout D4] 定案在恢复链同样适用）。data 形状与 finalizeRun
    // 直落 / reconcile-sweep 补注销同构（status 经 protocol mapReasonToStatus 单点）。
    const unregister = entries.find((e) => e.customType === PENDING_UNREGISTER_ENTRY_TYPE);
    expect(unregister).toBeDefined();
    expect(unregister!.data).toEqual({
      id: "wf-seam-k9",
      reason: "failed",
      status: mapReasonToStatus("failed"),
    });
    // 零 emit：pending:unregister 不再经事件通道（验收条款：壳侧 emit 0）
    expect(emits.find((e) => e.channel === "pending:unregister")).toBeUndefined();
    // 零完成通知：恢复链无通知回调（场景 4 断言环——收编 run 不发 workflow-result）
    expect(sendMessage).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.storeHealthy).toBe(true);
  });

  it("子进程 env 注入：identity custom entry 落 appendEntry，11 字段与 env 全量映射（唯一子进程正例；不含 chatMode——modeless 波5 停写）", async () => {
    // 吸收自 index-session-start-identity.test.ts（11 字段全量映射为其唯一子进程正例）
    vi.stubEnv("PI_SUBAGENT_SELF_RECORD_ID", "rec-seam-1");
    vi.stubEnv("PI_SUBAGENT_AGENT", "worker");
    vi.stubEnv("PI_SUBAGENT_MODE", "background");
    vi.stubEnv("PI_SUBAGENT_TASK", "fix the bug");
    vi.stubEnv("PI_SUBAGENT_SLUG", "fix-bug");
    vi.stubEnv("PI_SUBAGENT_STARTED_AT", "1700000000000");
    vi.stubEnv("PI_SUBAGENT_ROOT_SESSION_ID", "root-session-9");
    vi.stubEnv("PI_SUBAGENT_PARENT_RECORD_ID", "rec-parent-0");
    vi.stubEnv("PI_SUBAGENT_DEPTH", "2");
    vi.stubEnv("PI_SUBAGENT_FORK_DEPTH", "1");
    vi.stubEnv("PI_SUBAGENT_WORKTREE", "true");
    const { pi, entries } = createFakePi();

    await setupSessionLifecycle(pi, createFakeCtx(), {});

    const identityEntry = entries.find((e) => e.customType === IDENTITY_CUSTOM_TYPE);
    expect(identityEntry).toBeDefined();
    expect(identityEntry!.data).toMatchObject({
      id: "rec-seam-1",
      agent: "worker",
      mode: "background",
      task: "fix the bug",
      slug: "fix-bug",
      startedAt: 1700000000000,
      rootSessionId: "root-session-9",
      parentRecordId: "rec-parent-0",
      depth: 2,
      forkDepth: 1,
      // [review round2] worktree 隔离标志经 env 贯穿写入 identity entry（跨重启重建
      // 拒绝续聊的数据源）
      worktree: true,
    });
    expect(Object.keys(identityEntry!.data as object)).not.toContain("chatMode");
  });

  it("可选字段缺失（slug/parentRecordId/forkDepth/worktree 未注入）：identity 仍写入，可选字段为默认", async () => {
    // 吸收自 index-session-start-identity.test.ts；stubEnv(key, undefined) = 删除
    // 语义（vitest 4 实装核实），显式保证可选键缺席，不依赖外层环境。
    vi.stubEnv("PI_SUBAGENT_SELF_RECORD_ID", "rec-seam-2");
    vi.stubEnv("PI_SUBAGENT_AGENT", "explorer");
    vi.stubEnv("PI_SUBAGENT_MODE", "background");
    vi.stubEnv("PI_SUBAGENT_TASK", "scan code");
    vi.stubEnv("PI_SUBAGENT_STARTED_AT", "1700000000002");
    vi.stubEnv("PI_SUBAGENT_ROOT_SESSION_ID", "root-9");
    vi.stubEnv("PI_SUBAGENT_DEPTH", "1");
    vi.stubEnv("PI_SUBAGENT_SLUG", undefined);
    vi.stubEnv("PI_SUBAGENT_PARENT_RECORD_ID", undefined);
    vi.stubEnv("PI_SUBAGENT_FORK_DEPTH", undefined);
    vi.stubEnv("PI_SUBAGENT_WORKTREE", undefined);
    const { pi, entries } = createFakePi();

    await setupSessionLifecycle(pi, createFakeCtx(), {});

    const identityEntry = entries.find((e) => e.customType === IDENTITY_CUSTOM_TYPE);
    expect(identityEntry).toBeDefined();
    const data = identityEntry!.data as Record<string, unknown>;
    // 必填字段正常
    expect(data.id).toBe("rec-seam-2");
    expect(data.agent).toBe("explorer");
    expect(data.mode).toBe("background");
    expect(data.startedAt).toBe(1700000000002);
    // 可选字段缺失 → undefined / false（chatMode 已随 modeless 波1 停写，键不存在）
    expect(Object.keys(data)).not.toContain("chatMode");
    expect(data.slug).toBeUndefined();
    expect(data.parentRecordId).toBeUndefined();
    expect(data.forkDepth).toBeUndefined();
    expect(data.worktree).toBe(false);
  });

  it("worktree scan 抛错不阻断 session_start（装配后续步骤仍执行）", async () => {
    // 吸收自 session-start-reaper.test.ts；阻断观察 = 装配后续步骤（ADR-035
    // manifest 恢复接线）仍执行——scan 抛错被「失败记日志不阻断」兜住。
    const { pi } = createFakePi();
    const fakeService = {
      initSession: vi.fn(),
      recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
      rebuildIndexes: vi.fn(() => 0),
    };
    const fakeModelService = {
      initModel: vi.fn(),
      reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
    };
    const deps: SessionLifecycleDeps = {
      worktreeManager: {
        scan: (): Promise<void> => {
          throw new Error("git not found");
        },
      },
      createServices: vi.fn(() => ({
        service: fakeService,
        modelService: fakeModelService,
        reused: false,
      })) as unknown as SessionLifecycleDeps["createServices"],
    };

    const result = await setupSessionLifecycle(pi, createFakeCtx(), deps);
    // 装配结果回传面：storeHealthy 默认真 + sessionId 回显（scan 抛错不吞装配结果）
    expect(result.storeHealthy).toBe(true);
    expect(result.sessionId).toBe("session-seam-1");

    expect(fakeService.recoverManifestTmpFiles).toHaveBeenCalledTimes(1);
  });

  it("mainSessionFile 解析值直传 initSession（按 sessionId 解析 miss → 回退 getSessionFile）", async () => {
    // 吸收自 session-start-reaper.test.ts（形态适配：旧观察面 = 整类 mock 构造
    // 参数，现行生产 = initSession.mainSessionFile 值直传，断言意图不变）。
    // initSession 接线住默认 createOrReuseServices（deps.createServices 注入会绕过
    // 它）——走默认装配 + barrel set 调用观察（组 1「new 分支」用例同款手法）。
    const { pi } = createFakePi();

    await setupSessionLifecycle(pi, createFakeCtx("session-mf-1"), {});

    // stub agentDir 下按 sessionId 解析未命中 → 回退 ctx.sessionManager.getSessionFile()
    const svc = vi.mocked(setSubagentService).mock.calls[0]?.[0] as
      | { initSession: ReturnType<typeof vi.fn> }
      | undefined;

    // stub agentDir 下按 sessionId 解析未命中 → 回退 ctx.sessionManager.getSessionFile()
    expect(svc!.initSession).toHaveBeenCalledTimes(1);
    const initArg = svc!.initSession.mock.calls[0]?.[0] as { mainSessionFile?: string | undefined };
    expect(initArg.mainSessionFile).toBe("/home/user/.pi/agent/sessions/seam.jsonl");
  });

  it("主进程（无 PI_SUBAGENT_SELF_RECORD_ID）不写 identity custom entry", async () => {
    // [S5] 用例隐含依赖「测试进程 env 无 PI_SUBAGENT_SELF_RECORD_ID」——在 pi subagent
    // 进程内跑测试（该 env 已注入）必红。显式 stub 隔离，不依赖外层环境。
    vi.stubEnv("PI_SUBAGENT_SELF_RECORD_ID", "");
    const { pi, entries } = createFakePi();

    await setupSessionLifecycle(pi, createFakeCtx(), {});

    expect(entries.find((e) => e.customType === IDENTITY_CUSTOM_TYPE)).toBeUndefined();
    vi.unstubAllEnvs();
  });
});

// ── 组 2：守卫合一（两消费点单一出口，u-4 行为变更点） ──────────────────────────

describe("getWorkflowDeps 守卫合一 — 两消费点同源同消息", () => {
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

// ── 组 3：streamSink ctx.mode 守卫（吸收自 stream-sink-guard.test.ts）──────────
//
// 断言契约来源：session-lifecycle.ts createOrReuseServices 内 streamSink 三元
// ——tui/json/print 下 undefined（无 widget 噪音）；rpc 下注入包装 ctx.ui.setWidget
// 的 sink 对象。接线住默认装配路径（createOrReuseServices），不走 deps.createServices。

describe("streamSink ctx.mode 守卫 — 运行时行为（FR-1/FR-2/AC-1/AC-2）", () => {
  /** 默认装配跑一次 session_start，返回 initSession spy 与 ctx（rpc 观察面）。 */
  async function runDefaultAssembly(mode: "tui" | "rpc" | "json" | "print"): Promise<{
    mockInitSession: ReturnType<typeof vi.fn>;
    ctx: ExtensionContext & { ui?: { setWidget: ReturnType<typeof vi.fn> } | undefined };
  }> {
    const { pi } = createFakePi();
    const ctx = createFakeCtx("session-stream-1", mode);
    await setupSessionLifecycle(pi, ctx, {
      worktreeManager: { scan: vi.fn(async () => {}) },
    });
    // initSession 参数观察面：module mock 的 SubagentService 假类实例（访问器槽被
    // mock 恒 null → new 分支），取静态导入的 barrel set 调用（与被测装配同一 mock
    // 实例）。
    const svc = vi.mocked(setSubagentService).mock.calls[0]?.[0] as
      | { initSession: ReturnType<typeof vi.fn> }
      | undefined;
    return { mockInitSession: svc!.initSession, ctx };
  }

  it.each(["tui", "json", "print"] as const)(
    "streamSink 守卫：%s mode → initSession 收到 streamSink === undefined（无 widget 噪音）",
    async (mode) => {
      const { mockInitSession } = await runDefaultAssembly(mode);

      expect(mockInitSession).toHaveBeenCalledTimes(1);
      const initArg = mockInitSession.mock.calls[0]?.[0] as { streamSink: unknown };
      // 守卫真的产出 undefined（不是源码里有就够）
      expect(initArg.streamSink).toBeUndefined();
    },
  );

  it("rpc mode（GUI/taiji）：initSession 收到 streamSink 是 { setWidget } 对象（守卫放行）", async () => {
    const { mockInitSession } = await runDefaultAssembly("rpc");

    const initArg = mockInitSession.mock.calls[0]?.[0] as { streamSink: unknown };
    expect(initArg.streamSink).toEqual({ setWidget: expect.any(Function) });
  });

  it("rpc mode：streamSink.setWidget 转发到 ctx.ui.setWidget（绑定真实方法）", async () => {
    const { mockInitSession, ctx } = await runDefaultAssembly("rpc");

    const initArg = mockInitSession.mock.calls[0]?.[0] as {
      streamSink: { setWidget: (key: string, lines: string[]) => void };
    };
    initArg.streamSink.setWidget("key1", ["line-a"]);
    expect(ctx.ui?.setWidget).toHaveBeenCalledWith("key1", ["line-a"]);
  });
});

// ── 组 4：session_start 兜底触发统一保留维护轮（[W1 / D5 触发点③]，组 2 移交项）──
//
// 原 retention grep 形态接线断言升级为行为断言：session_start 装配链内的兜底触发点
// 以双域目录锚调 core runRetentionMaintenanceRound——run 域 = resolveSessionDir 同源
// （resolvePiSessionScopedDir + STATE_DIR_NAME）+ record 域 = getSubagentRecordsDir
// (agentDir, ENV_ROOT_CWD ?? ctx.cwd)；oncePerProcess 守卫保证单进程只跑一轮。

/** 「N 天前」的 epoch ms（维护轮资格判据锚 = journal 帧 ts）。 */
function daysAgoMs(days: number): number {
  return Date.now() - days * 86_400_000;
}

/** 预置 run 域终态磁盘足迹（journal 帧 + state 文件 + 终局 manifest；帧格式与
 *  retention 测试 seedTerminalRun 同源）。 */
function seedTerminalRunFootprint(
  stateDir: string,
  runId: string,
  createdDaysAgo: number,
  settledDaysAgo: number,
): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, `${runId}.events.jsonl`), [
    JSON.stringify({ type: "run-created", ts: daysAgoMs(createdDaysAgo), runId, workflowName: "t", argsSummary: "{}" }),
    JSON.stringify({ type: "run-settled", ts: daysAgoMs(settledDaysAgo), outcome: "completed", artifactsDir: "/tmp/artifacts" }),
  ].join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(stateDir, `${runId}.jsonl`), `{"runId":"${runId}","stub":true}\n`, "utf8");
  // 终局 manifest（<runId>.json）：维护轮永不随裁（终局持久权威）
  fs.writeFileSync(path.join(stateDir, `${runId}.json`), JSON.stringify({ runId, outcome: "completed" }), "utf8");
}

/** 预置 record 域终态事件文件（头行 + created + settled 帧；帧格式与 record-events
 *  词表同源）+ manifest（<sa-id>.json 不触碰——独立 TTL 归 session-file-gc）。 */
function seedTerminalRecordFootprint(
  recordsDir: string,
  id: string,
  createdDaysAgo: number,
  settledDaysAgo: number,
): void {
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(path.join(recordsDir, `${id}.events`), [
    JSON.stringify({ type: "record-journal", id }),
    JSON.stringify({ type: "record-created", seq: 1, ts: daysAgoMs(createdDaysAgo), id, agent: "worker", task: "t", slug: "s", origin: "tool", rootSessionId: "root-1", depth: 0, mode: "background", startedAt: daysAgoMs(createdDaysAgo) }),
    JSON.stringify({ type: "record-settled", seq: 2, ts: daysAgoMs(settledDaysAgo), stopReason: "completed", outcome: "completed", endedAt: daysAgoMs(settledDaysAgo), turns: 1, totalTokens: 0 }),
  ].join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(recordsDir, `${id}.json`), JSON.stringify({ runId: id, outcome: "completed" }), "utf8");
}

describe("session_start 兜底触发统一保留维护轮（[W1 / D5 触发点③] 行为断言）", () => {
  let tmpDir: string;
  let agentDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-lifecycle-maint-"));
    agentDir = path.join(tmpDir, "agent");
    mockAgentDir.current = agentDir;
  });

  afterEach(() => {
    mockAgentDir.current = "/home/user/.pi/agent";
    delete process.env[STATE_TTL_MS_ENV];
    delete process.env[ENV_ROOT_CWD];
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 双域目录锚（与生产触发点同源同式推导）。 */
  function resolveDomainAnchors(): { stateDir: string; recordsDir: string } {
    return {
      // run 域：<agentDir>/sessions/<slug> 不存在 → 回退 agentDir 根（探测布局单源
      // resolvePiSessionScopedDir，与生产 resolveSessionDir 同参形态）
      stateDir: path.join(resolvePiSessionScopedDir({ agentDir }), STATE_DIR_NAME),
      // record 域：rootCwd = ENV_ROOT_CWD ?? ctx.cwd（ctx.cwd = createFakeCtx 固定值）
      recordsDir: getSubagentRecordsDir(agentDir, "/home/user/project"),
    };
  }

  it("session_start 装配触发维护轮：run/record 双域窗外终态裁剪，窗内与 manifest 保护", async () => {
    process.env[STATE_TTL_MS_ENV] = String(30 * 86_400_000);
    const { stateDir, recordsDir } = resolveDomainAnchors();

    seedTerminalRunFootprint(stateDir, "wf-maint-expired", 40, 35);
    seedTerminalRunFootprint(stateDir, "wf-maint-inwindow", 10, 5);
    seedTerminalRecordFootprint(recordsDir, "sa-maint-expired", 40, 35);
    seedTerminalRecordFootprint(recordsDir, "sa-maint-inwindow", 10, 5);

    const { pi } = createFakePi();
    await setupSessionLifecycle(pi, createFakeCtx("session-maint-1"), {});

    // run 域：窗外终态 state + journal 成对裁；窗内保留；manifest 永不随裁
    expect(fs.existsSync(path.join(stateDir, "wf-maint-expired.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "wf-maint-expired.events.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "wf-maint-expired.json"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "wf-maint-inwindow.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "wf-maint-inwindow.events.jsonl"))).toBe(true);
    // record 域：窗外终态事件文件裁；窗内保留；manifest 不触碰
    expect(fs.existsSync(path.join(recordsDir, "sa-maint-expired.events"))).toBe(false);
    expect(fs.existsSync(path.join(recordsDir, "sa-maint-expired.json"))).toBe(true);
    expect(fs.existsSync(path.join(recordsDir, "sa-maint-inwindow.events"))).toBe(true);
  });

  it("维护轮经 oncePerProcess 守卫防双跑：首轮后新落的窗外终态不被二次裁（单进程只跑一轮）", async () => {
    process.env[STATE_TTL_MS_ENV] = String(30 * 86_400_000);
    const { stateDir, recordsDir } = resolveDomainAnchors();

    seedTerminalRunFootprint(stateDir, "wf-maint-first", 40, 35);
    seedTerminalRecordFootprint(recordsDir, "sa-maint-first", 40, 35);

    const { pi } = createFakePi();

    // 第一派发：兜底触发点执行首轮（首轮足迹被裁 = 触发真实发生）
    await setupSessionLifecycle(pi, createFakeCtx("session-maint-2"), {});
    expect(fs.existsSync(path.join(stateDir, "wf-maint-first.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(recordsDir, "sa-maint-first.events"))).toBe(false);

    // 首轮之后新落的窗外终态：第二派发重放首轮 Promise，不重扫 → 存活
    seedTerminalRunFootprint(stateDir, "wf-maint-second", 40, 35);
    seedTerminalRecordFootprint(recordsDir, "sa-maint-second", 40, 35);
    await setupSessionLifecycle(pi, createFakeCtx("session-maint-3"), {});
    expect(fs.existsSync(path.join(stateDir, "wf-maint-second.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(recordsDir, "sa-maint-second.events"))).toBe(true);
  });
});

// ── 组 5：sendDelivery stale ctx 守卫（出自 notify-stale-guard.test.ts，归属本域）──
//
// 被测入口是本文件的 bindLedgerHostAndRecover 装配 seam（crash-resilience D1 /
// ext-guards 审计 §7 blockers#1 收口）：取装配后的 ledgerHost 直调 sendDelivery，
// 验证 stale 分诊三面——stale 错误（含 PS-30 分诊词）静默降级不外抛、非 stale
// 错误原样上抛（同一错误实例，attemptDeliver 既有 catch 的 settleRejected 留账
// 重试语义可接住）、正常路径单通道 {triggerTurn:true} 形态原样透传。notifyDone
// 半边（降级直发分支的同判）在 workflow-notify.test.ts。形态对齐 ext-guards
// guard-stale-ctx.test.ts（PI_STALE_ERROR 文案 fixture）；分诊无 isCtxStale 注入
// （与生产接入一致，文案兜底由 PS-30 门禁守卫）。

/** pi 实装 stale 文案的完整形态（E1 崩溃堆栈原文，探针 PS-30 守卫其稳定性）。 */
const PI_STALE_ERROR = `This extension ctx is stale ${STALE_CTX_MARKER} or reload. Do not use a captured pi or command ctx after ctx.newSession().`;

const DELIVERY_MESSAGE = {
  customType: "bg-notify",
  content: "subagent done: reviewer",
  display: true,
};

describe("sendDelivery stale ctx 守卫（bindLedgerHostAndRecover seam，出自 notify-stale-guard）", () => {
  /** bindLedgerHostAndRecover 最小 pi 面（sendMessage 可注入抛错形态）。 */
  function makeLedgerPi(sendMessageImpl?: (...args: unknown[]) => void): {
    pi: ExtensionAPI;
    sendMessage: ReturnType<typeof vi.fn>;
  } {
    const sendMessage = vi.fn(sendMessageImpl);
    const noop = (): void => {
      /* mock */
    };
    const pi = {
      appendEntry: noop,
      on: noop,
      sendMessage,
    } as unknown as ExtensionAPI;
    return { pi, sendMessage };
  }

  /** 每用例取静态导入的 bindLedgerHostAndRecover 装配（模块图单实例，静态引用即
   *  被测实例）。ctx 走 createFakeCtx：其 sessionManager.getEntries 恒空数组（恢复
   *  扫描零重放）、isIdle 恒 true。 */
  async function bindHost(sendMessageImpl?: (...args: unknown[]) => void) {
    const { pi, sendMessage } = makeLedgerPi(sendMessageImpl);
    const host = bindLedgerHostAndRecover(pi, createFakeCtx("session-stale-guard-1"));
    return { host, sendMessage };
  }

  it("stale 错误静默降级：不外抛，投递不放大为无人接 rejection", async () => {
    const { host, sendMessage } = await bindHost(() => {
      throw new Error(PI_STALE_ERROR);
    });
    expect(host).toBeDefined();

    expect(() => host!.sendDelivery(DELIVERY_MESSAGE)).not.toThrow();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("非 stale 错误原样上抛：attemptDeliver 既有 catch（settleRejected 留账重试）仍可接住", async () => {
    const boom = new Error("delivery rejected by runtime");
    const { host } = await bindHost(() => {
      throw boom;
    });

    expect(() => host!.sendDelivery(DELIVERY_MESSAGE)).toThrow(boom);
  });

  it("正常路径零变化：单通道形态 sendCustomMessage({triggerTurn:true}) 原样透传", async () => {
    const { host, sendMessage } = await bindHost();

    host!.sendDelivery(DELIVERY_MESSAGE);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(msg).toEqual(DELIVERY_MESSAGE);
    expect(opts).toEqual({ triggerTurn: true });
  });
});

// ── 组 6：session_start crash recovery — store.loadAll 路径（吸收自 crash-recovery.test.ts）──
//
// loadAll 四分支的归属现状：成功+running（transition + appendEntry 直落 + 不经 emit）
// 与失败 fail-fast（storeHealthy=false）两分支与组 1 seam 条同契约，以组 1 既有条为准
// 不重复设条；「store unavailable / loadAll failed」错误面由组 2 守卫条锁定。本组保留
// crash-recovery 独有断言面：B1 第二 session 恢复、已终态直 set、域隔离。观察面迁移
// 两处（断言意图不变）：已终态条的 entries 经挂载 harness 的 appendEntry 捕获（原文件
// 同形）；域隔离条的注册观察从 pi.registerTool 捕获 "subagent" 改为 interface mock 的
// registerSubagentTool 调用断言（本文件 interface 层 module mock 下真实注册不达 pi）。

describe("session_start crash recovery — store.loadAll 路径（吸收自 crash-recovery）", () => {
  it("B1: 同进程第二个 session 的恢复不被跳过（/new 后 /resume 崩溃 session 场景）", async () => {
    // [B1 回归] 恢复曾挂 oncePerProcess（进程级单次），同进程第二个 session_start
    // 重放首次 Promise、跳过 loadAll——被 /resume 的崩溃 session 残留 run 不被收编。
    // 修复后恢复是 session 级幂等操作：同一模块实例连续两次装配，第二次照常收编。
    const mkDeps = (runs: WorkflowRunType[]): SessionLifecycleDeps => ({
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
          loadAll: vi.fn(async () => runs),
          save: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        }) as never,
    });

    // 第一次 session_start（session-a）：无残留，恢复空转
    const first = await setupSessionLifecycle(createFakePi().pi, createFakeCtx(), mkDeps([]));
    expect(first.storeHealthy).toBe(true);

    // 第二次 session_start（session-b，同进程 /resume 上次崩溃的 session）：其
    // running 残留必须被收编（不被首次调用旁路）
    const runningRun = makeRun("wf-crash-2", "running");
    const { pi: pi2, entries: entries2 } = createFakePi();
    const second = await setupSessionLifecycle(pi2, createFakeCtx(), mkDeps([runningRun]));
    expect(second.storeHealthy).toBe(true);
    expect(runningRun.state.status).toBe("done");
    expect(runningRun.state.reason).toBe("failed");
    // [W2/V4 D6] 注销经 appendEntry 直落（不经 emit）
    const unregister = entries2.find((e) => e.customType === PENDING_UNREGISTER_ENTRY_TYPE);
    expect(unregister).toBeDefined();
    expect(unregister!.data).toEqual({
      id: "wf-crash-2",
      reason: "failed",
      status: mapReasonToStatus("failed"),
    });
  });

  it("loadAll 成功 + 已终态 run：直接 set 到 runs Map，不 transition", async () => {
    const doneRun = makeRun("wf-done-1", "done");
    const originalCompletedAt = doneRun.meta.completedAt;
    const { entries, workflowRun } = await mountWithLoadAll(async () => [doneRun]);

    // 状态不变（仍 done/completed），不重新 transition（completedAt 不变）
    expect(doneRun.state.status).toBe("done");
    expect(doneRun.state.reason).toBe("completed");
    expect(doneRun.meta.completedAt).toBe(originalCompletedAt);

    // 终态 run 不触发 pending:unregister（恢复路径只处理 status==="running"；
    // [W2/V4 D6] 注销面 = appendEntry 直落 entries，零断言走该通道）
    const unregister = entries.filter((e) => e.customType === PENDING_UNREGISTER_ENTRY_TYPE);
    expect(unregister).toHaveLength(0);

    // run 已被 set 到 runs Map —— pi.__workflowRun 在 storeHealthy=true 时
    // 不会因 store unavailable 提前返回
    const result = await workflowRun("any", {});
    expect(result.error).not.toContain("store unavailable");
  });

  it("loadAll 失败后 subagent 域不受影响：registerSubagentTool 仍被调用", async () => {
    await mountWithLoadAll(async () => {
      throw new Error("disk corruption");
    });

    // 域隔离：subagent tool 注册在 factory 入口（session_start 之外），与 store
    // 健康无关。观察面迁移：本文件 interface 层 module mock 下断言 mock 调用
    //（原文件无 interface mock、以 pi.registerTool 捕获 "subagent"），断言意图
    // 不变：store 不健康时 factory 入口的 subagent 域注册仍执行。
    expect(vi.mocked(registerSubagentTool)).toHaveBeenCalled();
  });
});

// ── 组 7：[W1 / D4] kill-9 收编 fixture（吸收自 crash-recovery.test.ts）────────
//
// 真实链路夹具（非 mock store）：真实 JsonlRunStore（经 importActual 绕开本文件
// 顶部的 JsonlRunStore module mock——mock 面服务挂载类用例的 store 可控点）+ 真实
// run journal（core 写者落账）+ setRunEventJournalDirForTest 注入 fixture 目录
// （真实 dispatchFinalRunSettle 链：状态机裁决 + journal run-settled 落账 + manifest
// 物化）。验收断言（设计场景 3 的 fixture 化）：
//   ① journal 尾部有收编 run-settled（failed）；
//   ② 主 session 条目恰两条（注册 + 终态，v2 形态）；
//   ③ manifest 物化（outcome=failed，prune 资格单源锚定）；
//   ④ 双重启不重复追加（幂等：第二次装配 journal 仍一条 run-settled、零条目写）。

describe("[W1 / D4] kill-9 收编 fixture：journal 终态 + 条目恰两条 + manifest 物化", () => {
  it("crashed run（有注册无终态）经恢复链收编；双重启零重复追加", async () => {
    // 真实 store（绕开文件顶部 module mock）+ core journal 写者 + pump journal 目录注入
    const { JsonlRunStore: RealJsonlRunStore } =
      await vi.importActual<typeof import("../jsonl-run-store.ts")>("../jsonl-run-store.ts");
    const { setRunEventJournalDirForTest } = await import(
      "@zhushanwen/subagent-core/orchestration/worker-message-pump.ts"
    );
    const { createRunEventJournal, WORKFLOW_RECORD_CUSTOM_TYPE, WORKFLOW_RECORD_ENTRY_VERSION } =
      await import("@zhushanwen/subagent-core");
    type CustomEntry = { type: string; customType?: string; data?: unknown; id: string; parentId: null; timestamp: string };

    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-kill9-"));
    setRunEventJournalDirForTest(fixtureDir);
    try {
      const runId = "wf-kill9-1";
      const journalPath = path.join(fixtureDir, `${runId}.events.jsonl`);
      // 崩溃形态 journal：run-created + ask 帧，无 run-settled（进程被 kill-9 的磁盘形态）
      const journal = createRunEventJournal(fixtureDir);
      await journal.append(runId, { type: "run-created", runId, workflowName: "kill9", argsSummary: "{}", ts: Date.now() - 60_000 });
      await journal.append(runId, { type: "ask-dispatched", taskIndex: 0, agentName: "a", attempt: 1, ts: Date.now() - 30_000 });

      // 主 session 面只落注册条目（v2 形态——终态条目缺失即收编补写对象）
      const entries: CustomEntry[] = [
        {
          type: "custom",
          customType: WORKFLOW_RECORD_CUSTOM_TYPE,
          data: {
            v: WORKFLOW_RECORD_ENTRY_VERSION,
            kind: "registered",
            runId,
            workflowName: "kill9",
            scriptName: "kill9",
            slug: "kill9",
            startedAt: Date.now() - 60_000,
            journalPath,
          },
          id: "seed-reg",
          parentId: null,
          timestamp: new Date().toISOString(),
        },
      ];

      // fake pi：appendEntry 模拟 session JSONL append（捕获 + 落 entries——pi.appendEntry
      // 的真实语义）。[W2/V4 D6] 恢复链注销走 appendEntry 直落，appended 是注销观察面。
      const appended: Array<{ t: string; d: unknown }> = [];
      const { pi: piBase, emits } = createFakePi();
      const appendEntry = vi.fn((t: string, d: unknown) => {
        appended.push({ t, d });
        entries.push({ type: "custom", customType: t, data: d, id: `entry-${entries.length}`, parentId: null, timestamp: new Date().toISOString() });
      });
      const pi = Object.assign(piBase, { appendEntry });
      const baseCtx = createFakeCtx();
      const ctx = {
        ...baseCtx,
        sessionManager: {
          ...baseCtx.sessionManager,
          getEntries: () => [...entries],
        },
      } as ExtensionContext;

      const mkDeps = (): SessionLifecycleDeps => ({
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
        createRunStore: () => new RealJsonlRunStore({ sessionDir: fixtureDir, pi, ctx }),
      });

      // 第一次启动（kill-9 后重启）：running 收编
      const first = await setupSessionLifecycle(pi, ctx, mkDeps());
      const run = first.runs.get(runId);
      expect(run?.state.status).toBe("done");
      expect(run?.state.reason).toBe("failed");
      // [W2/V4 D6] 注销经 appendEntry 直落（不经 emit）；零 emit 断言防事件通道回潮
      const unregister = appended.find(({ t }) => t === PENDING_UNREGISTER_ENTRY_TYPE);
      expect(unregister).toBeDefined();
      expect((unregister!.d as { reason?: string }).reason).toBe("failed");
      expect(emits.find((e) => e.channel === "pending:unregister")).toBeUndefined();

      // ① journal 尾部有收编 run-settled（[W2 D2/D3] 被动终局 = interrupted）
      const lines = fs.readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim());
      const lastFrame = JSON.parse(lines[lines.length - 1]!) as { type: string; outcome?: string };
      expect(lastFrame.type).toBe("run-settled");
      expect(lastFrame.outcome).toBe("interrupted");

      // ② 主 session 条目恰两条：注册（seed）+ 终态（收编补写）
      const wfEntries = entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE);
      expect(wfEntries).toHaveLength(2);
      expect((wfEntries[0]!.data as { kind?: string }).kind).toBe("registered");
      expect((wfEntries[1]!.data as { kind?: string }).kind).toBe("settled");

      // ③ manifest 物化（writeRunTerminalManifest 落 <fixtureDir>/<runId>.json）
      const manifest = JSON.parse(
        fs.readFileSync(path.join(fixtureDir, `${runId}.json`), "utf8"),
      ) as { id: string; outcome?: string };
      expect(manifest.id).toBe(runId);
      expect(manifest.outcome).toBe("interrupted");

      // ④ 双重启：journal 已终态 → loadAll 直读终局，零重复追加、零条目写
      appended.length = 0;
      await setupSessionLifecycle(pi, ctx, mkDeps());
      const settledFrames = fs
        .readFileSync(journalPath, "utf8")
        .split("\n")
        .filter((l) => l.trim() && (JSON.parse(l) as { type: string }).type === "run-settled");
      expect(settledFrames).toHaveLength(1);
      expect(appended.filter((a) => a.t === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(0);
      expect(entries.filter((e) => e.customType === WORKFLOW_RECORD_CUSTOM_TYPE)).toHaveLength(2);
    } finally {
      // 清 journal 目录注入（恢复 vitest 防线 no-op 形态——防其他测试误写真目录）
      const { setRunEventJournalDirForTest } = await import(
        "@zhushanwen/subagent-core/orchestration/worker-message-pump.ts"
      );
      setRunEventJournalDirForTest(undefined);
      fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
