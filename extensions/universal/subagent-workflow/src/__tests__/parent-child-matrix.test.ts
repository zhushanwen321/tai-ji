// src/__tests__/parent-child-matrix.test.ts
//
// SP-4: 父子联动测试（真实 SubagentService + index.ts 事件接线）。
//
// [M2/M7 重写] 旧套件在测试内手写 tryTransition/completeRecord/recentlyCascaded 模拟
// （平行复刻生产逻辑），生产代码任何回归恒绿。现改为两层真实驱动：
//   Block 1: 真实 SubagentService.onParentFork / onParentNew / disposeAllRecords
//            → 断言 record 转 closed + closedReason + archive + pending:unregister
//   Block 2: 真实 index.ts factory 注册的 session_before_fork / session_before_switch
//            handler 驱动同一真实 Service → 断言事件接线与 reason 门控
//
// 事件语义依据 SDK 0.82.1（core/agent-session-runtime.js + core/agent-session.js）：
//   /fork          → session_before_fork(entryId, position) → teardown("fork")
//   /new           → session_before_switch(reason:"new") → teardown("new")
//                    （/new 从不触发 session_before_tree——旧实现误挂即 M2 bug）
//   /resume /import → session_before_switch(reason:"resume")
//   /tree          → session_before_tree（同 session 内分支导航，无 session 替换）
//                    + session_tree（导航后）——均无级联关闭语义

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// mock logger（import 链需要 getLogger 存在；对齐 subagent-service-parent-guard.test.ts。
// setPiHandle 是 index.ts factory 顶层调用（注入 pi handle 给全局 logger），需一并 stub）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => loggerMock,
  setPiHandle: vi.fn(),
}));
vi.mock("@zhushanwen/subagent-core/core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

// mock session-runner（import 链需要 runSpawn/killAllSpawnedChildren/getChildByRecord；
// 避免真实 kill，且 dispose 收割路径可断言）
const { killAllSpawnedChildrenMock } = vi.hoisted(() => ({
  killAllSpawnedChildrenMock: vi.fn(),
}));
vi.mock("@zhushanwen/subagent-core/execution/engine/engines/pi/session-runner.ts", () => ({
  runSpawn: vi.fn(),
  killAllSpawnedChildren: killAllSpawnedChildrenMock,
  killRecordChildWithEscalation: vi.fn(),
  getChildByRecord: vi.fn(() => undefined),
}));

import { createRecord } from "@zhushanwen/subagent-core/execution/execution-record.ts";
import { ModelConfigService } from "@zhushanwen/subagent-core";
import { RecordStore } from "@zhushanwen/subagent-core";
import { SubagentService, setSubagentService } from "@zhushanwen/subagent-core";
import type { PiLike } from "@zhushanwen/subagent-core/execution/subagent-service.ts";
import type { ExecutionRecord } from "@zhushanwen/subagent-core";
import subagentsExtension from "../index.ts";

// ── helpers ──

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "parent-child-matrix-"));
}

/** 最小 mock PiLike（appendEntry/events.emit/sendMessage 全部可断言）。 */
function makePi(): { pi: PiLike; eventsEmit: ReturnType<typeof vi.fn> } {
  const eventsEmit = vi.fn();
  const pi = {
    appendEntry: vi.fn(),
    events: { emit: eventsEmit },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
  return { pi, eventsEmit };
}

/** 暴露私有字段供测试注入 record（对齐 subagent-service-parent-guard.test.ts 模式）。 */
interface ServiceInternals {
  store: RecordStore;
}

/** 构造一个 running 状态的 ExecutionRecord（内存态，register 进真实 store）。 */
function makeRunningRecord(id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: `task for ${id}`,
    slug: `slug-${id}`,
    startedAt: Date.now(),
    rootSessionId: "root-session",
    controller: new AbortController(),
    ...overrides,
  });
}

/** 重置进程级 SubagentService 单例槽（setSubagentService 不接受 null，测试清理用）。
 *  key 与生产 getServiceSlot 的 SERVICE_SLOT_KEY（subagent-service.ts）一致。 */
function resetServiceSlot(): void {
  const slot = Reflect.get(globalThis, Symbol.for("@zhushanwen/pi-subagents.service")) as
    | { current: SubagentService | null }
    | undefined;
  if (slot) slot.current = null;
}

/** 创建真实 SubagentService（tmp agentDir + mock pi），返回 service 与内部 store。 */
function setupRealService(): { service: SubagentService; store: RecordStore } {
  const agentDir = makeTmpAgentDir();
  const modelService = new ModelConfigService({ agentDir });
  const service = new SubagentService({ cwd: agentDir, modelService });
  service.initSession({ pi: makePi().pi, sessionId: "root-session" });
  const store = (service as unknown as ServiceInternals).store;
  return { service, store, agentDir };
}

// ============================================================
// Block 1: 真实 SubagentService 级联关闭
// ============================================================

describe("SP-4 级联关闭（真实 SubagentService）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let eventsEmit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir });
    const { pi, eventsEmit: emit } = makePi();
    eventsEmit = emit;
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi, sessionId: "root-session" });
    store = (service as unknown as ServiceInternals).store;
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("[U5] onParentFork：running record 自动收起（settle idle + interrupted-by-parent + intent=archived + 放弃轮标记，不终态化留内存可寻回）", () => {
    const record = makeRunningRecord("sa-fork-1");
    store.register(record);

    const count = service.onParentFork();

    expect(count).toBe(1);
    // [U5 / §3.2.5 编排性关闭行] settle 回 idle（不终态化）+ intent 翻转 archived
    expect(record.status).toBe("idle");
    expect(record.stopReason).toBe("interrupted-by-parent");
    expect(record.closedReason).toBeUndefined();
    expect(record.intent).toBe("archived");
    expect(record.lastAbandonedRound).toEqual({ epoch: 0, round: 0 });
    // 在飞 controller 立即打断
    expect(record.controller?.signal.aborted).toBe(true);
    // record 留内存（archived ≠ 内存回收——旧 session 树内 message 可寻回续聊；
    // listAllActive 只收 running——settle 后离开 running 集，getMutable 仍可达）
    expect(store.getMutable("sa-fork-1")).toBeDefined();
    expect(store.listAllActive()).toHaveLength(0);
  });

  it("[U5] onParentNew：running record 自动收起（interrupted-by-parent）", () => {
    const record = makeRunningRecord("sa-new-1");
    store.register(record);

    const count = service.onParentNew();

    expect(count).toBe(1);
    expect(record.status).toBe("idle");
    expect(record.stopReason).toBe("interrupted-by-parent");
    expect(record.intent).toBe("archived");
    expect(store.getMutable("sa-new-1")).toBeDefined();
  });

  it("多个 running record 全部级联收起，返回 count 与 record 数一致", () => {
    const records = [
      makeRunningRecord("sa-multi-1"),
      makeRunningRecord("sa-multi-2"),
      makeRunningRecord("sa-multi-3"),
    ];
    for (const r of records) store.register(r);

    const count = service.onParentNew();

    expect(count).toBe(3);
    for (const r of records) {
      expect(r.status).toBe("idle");
      expect(r.stopReason).toBe("interrupted-by-parent");
      expect(r.intent).toBe("archived");
    }
    // settle 后离开 running 集（listAllActive 只收 running），getMutable 全员可达
    expect(store.listAllActive()).toHaveLength(0);
  });

  it("级联收起对每个被关 record 发 pending:unregister（[U5] reason=archived——归档点补发注销）", () => {
    const record = makeRunningRecord("sa-pending-1");
    store.register(record);

    service.onParentFork();

    expect(eventsEmit).toHaveBeenCalledWith("pending:unregister", {
      id: "sa-pending-1",
      reason: "archived",
    });
  });

  it("幂等：无活跃 record 返回 0；级联后再次调用返回 0（record 已归档）", () => {
    expect(service.onParentNew()).toBe(0);

    const record = makeRunningRecord("sa-idem-1");
    store.register(record);
    expect(service.onParentFork()).toBe(1);
    expect(service.onParentFork()).toBe(0); // 已 closed + archived，不重复关
  });
});

// ============================================================
// Block 2: index.ts 事件接线（真实 factory + 真实 Service）
// ============================================================

describe("SP-4 index.ts 事件接线", () => {
  type PiHandler = (...args: unknown[]) => void | Promise<void>;
  const registered = new Map<string, PiHandler>();
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;

  /** 最小 mock ExtensionAPI：捕获 pi.on 注册的 handler（对齐 process-shutdown-hook.test.ts 模式）。 */
  function createMockPi(): ExtensionAPI {
    const noop = (): void => {
      /* mock */
    };
    return {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: (event: string, handler: PiHandler) => {
        registered.set(event, handler);
      },
      appendEntry: vi.fn(),
      events: { emit: vi.fn(), on: vi.fn() },
    } as unknown as ExtensionAPI;
  }

  beforeEach(() => {
    // 捕获 process.on 注册（不真实注册，防 listener 跨用例泄漏）——factory 顶层注册
    // SIGTERM/SIGINT/beforeExit 三个 process hook（见 process-shutdown-hook.test.ts）。
    processOnSpy = vi.spyOn(process, "on").mockImplementation((() => process) as never);

    registered.clear();
    killAllSpawnedChildrenMock.mockReset();

    const ctx = setupRealService();
    agentDir = ctx.agentDir;
    service = ctx.service;
    store = ctx.store;
    setSubagentService(service);

    subagentsExtension(createMockPi());
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    resetServiceSlot();
  });

  it("factory 注册 session_before_fork 与 session_before_switch handler", () => {
    expect(registered.get("session_before_fork")).toBeTypeOf("function");
    expect(registered.get("session_before_switch")).toBeTypeOf("function");
  });

  it("[M2] 不注册 session_before_tree——/tree 同 session 分支导航不得级联杀 subagent", () => {
    // SDK 中 session_before_tree 只由 navigateTree（/tree）触发，与 /new 无关。
    // 旧实现误挂此事件当 /new 级联入口 → 普通 /tree 导航误杀全部活跃 subagent。
    // 本断言是 M2 回归守卫：该事件不得再注册级联 handler。
    expect(registered.has("session_before_tree")).toBe(false);
  });

  it("[M2] session_before_switch(reason:'new') 触发 /new 级联：record 自动收起（[U5] interrupted-by-parent + archived）", () => {
    const record = makeRunningRecord("sa-wire-new-1");
    store.register(record);
    const onParentNewSpy = vi.spyOn(service, "onParentNew");

    registered.get("session_before_switch")!(
      { type: "session_before_switch", reason: "new" },
      undefined,
    );

    expect(onParentNewSpy).toHaveBeenCalledTimes(1);
    expect(record.status).toBe("idle");
    expect(record.stopReason).toBe("interrupted-by-parent");
    expect(record.intent).toBe("archived");
    expect(store.getMutable("sa-wire-new-1")).toBeDefined();
  });

  it("[M2] session_before_switch(reason:'resume') 不级联：/resume 回到已有 session，record 保持 running", () => {
    const record = makeRunningRecord("sa-wire-resume-1");
    store.register(record);
    const onParentNewSpy = vi.spyOn(service, "onParentNew");

    registered.get("session_before_switch")!(
      {
        type: "session_before_switch",
        reason: "resume",
        targetSessionFile: "/tmp/other-session.jsonl",
      },
      undefined,
    );

    expect(onParentNewSpy).not.toHaveBeenCalled();
    expect(record.status).toBe("running");
    expect(store.getMutable("sa-wire-resume-1")).toBe(record);
  });

  it("session_before_fork 触发 /fork 级联：record 自动收起（[U5] interrupted-by-parent + archived）", () => {
    const record = makeRunningRecord("sa-wire-fork-1");
    store.register(record);
    const onParentForkSpy = vi.spyOn(service, "onParentFork");

    registered.get("session_before_fork")!(
      { type: "session_before_fork", entryId: "entry-1", position: "before" },
      undefined,
    );

    expect(onParentForkSpy).toHaveBeenCalledTimes(1);
    expect(record.status).toBe("idle");
    expect(record.stopReason).toBe("interrupted-by-parent");
    expect(record.intent).toBe("archived");
    expect(store.getMutable("sa-wire-fork-1")).toBeDefined();
  });

  it("service 单例未初始化（getSubagentService()=null）时 handler 安全 no-op", () => {
    resetServiceSlot();
    expect(() => {
      registered.get("session_before_switch")!(
        { type: "session_before_switch", reason: "new" },
        undefined,
      );
      registered.get("session_before_fork")!(
        { type: "session_before_fork", entryId: "e", position: "before" },
        undefined,
      );
    }).not.toThrow();
  });
});
