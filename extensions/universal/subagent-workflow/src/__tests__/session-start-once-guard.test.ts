// src/__tests__/session-start-once-guard.test.ts
//
// u-audit-fix 探针实测（subagent-workflow 侧）：排查清单
// （docs/design/pi-session-start-handler-idempotency-audit.md §2 subagent-workflow 行）
// 判定「必须接入」的六项跨 session 副作用操作经 oncePerProcess 包装后，双派发
// （factory 二调/handler 累积形态：同一 handler 引用直接调两次）下各执行 1 次；
// 清单「粒度边界」明令不包装的 ③identity appendEntry / ④bindNotifyLedger /
// ⑥service.initSession 保持每 session_start 执行（×2，防误伤反向断言）。
//
// 断言与清单探针验证点的对应（入口计数 ⟹ 内层副作用 ≤1 的构造性蕴含）：
//   ① syncEnginesFile 写 = 1（engines.json 写发生在函数内部，入口 =1 ⟹ 写 ≤1）
//   ⑦ startGcTimer = 1（setInterval 注册在 idle-gc 内部，入口 =1 ⟹ 注册 ≤1）
//   ⑧ maybeCleanupExpiredSessionFiles = 1（扫描 + unlink 在函数内部）
//   ⑨ recoverManifestTmpFiles = 1（promote/unlink 在函数内部）
//   ⑩ WorktreeManager.scan = 1（git/rm 进程操作在方法内部）
//   ⑪ recoverCrashedRuns = 1 + pending:unregister emit 恰 1 条（落盘 save 在函数内部）
//   ⑫ rebuildIndexes = 1（[U4c/G1] manifest 补缺/索引重建写发生在函数内部）
//
// 守卫 Map 是模块级状态：beforeEach resetModules + 动态 import 每用例取新鲜模块实例。

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules（在 import 前声明；对齐 index-session-start.test.ts 内联 vi.mock 模式） ──

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/home/user/.pi/agent",
}));
vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: (values: string[]) => ({ type: "string", enum: values }),
}));
vi.mock("typebox", () => ({
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    Optional: (schema: unknown) => ({ ...(schema as object), optional: true }),
    String: () => ({ type: "string" }),
    Boolean: () => ({ type: "boolean" }),
    Number: () => ({ type: "number" }),
    Array: (items: unknown) => ({ type: "array", items }),
    Record: (key: unknown, value: unknown) => ({ type: "object", additionalProperties: value, key }),
    Unknown: () => ({ type: "unknown" }),
    Union: (members: unknown[]) => ({ type: "union", members }),
    Literal: (value: unknown) => ({ type: "literal", value }),
  },
}));

// ── hoisted mock 实例：六项包装操作 + 防误伤观察点，全部 hoisted（resetModules 后
//    重新加载被测模块时 factory/断言读同一 spy 实例） ──

const {
  mockSyncEnginesFile,
  mockScan,
  mockMaybeCleanup,
  mockStartGcTimer,
  mockRecoverManifestTmpFiles,
  mockRebuildIndexes,
  mockRecoverCrashedRuns,
  mockBindNotifyLedgerHost,
  mockRecoverFromSession,
  mockInitSession,
  mockInitModel,
} = vi.hoisted(() => {
  const recoverFromSession = vi.fn();
  return {
    // ① engines.json 同步（factory 体内还有一次无守卫调用，用例内 clearAllMocks 分离计数）
    mockSyncEnginesFile: vi.fn(),
    // ⑩ worktree reaper 扫描
    mockScan: vi.fn(),
    // ⑧ 超 TTL session 文件清理
    mockMaybeCleanup: vi.fn(),
    // ⑦ idle GC 定时器
    mockStartGcTimer: vi.fn(),
    // ⑨ manifest tmp 恢复
    mockRecoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
    // ⑫ [U4c/G1] boot 全量索引重建
    mockRebuildIndexes: vi.fn(() => 0),
    // ⑪ 崩溃 run 恢复（onRunRecovered 由用例注入行为，emit 断言经真实 pi.events 链路）
    mockRecoverCrashedRuns: vi.fn(),
    // ④ 通知账本 bind（防误伤：每 session_start 执行）
    mockBindNotifyLedgerHost: vi.fn(() => ({ recoverFromSession })),
    mockRecoverFromSession: recoverFromSession,
    // ⑥ service.initSession（防误伤：每 session_start 执行）
    mockInitSession: vi.fn(),
    mockInitModel: vi.fn(),
  };
});

// ① [U7] engines.json 同步
vi.mock("@zhushanwen/subagent-core/execution/engine/engine-discovery.ts", () => ({
  syncEnginesFile: mockSyncEnginesFile,
}));

// ⑩ worktree reaper
vi.mock("@zhushanwen/subagent-core/execution/worktree-manager.ts", () => ({
  WorktreeManager: class {
    constructor(_agentDir: string) {
      /* mock */
    }
    scan = mockScan;
    cleanup = vi.fn();
    create = vi.fn();
    collectPatch = vi.fn();
    registerPid = vi.fn();
  },
}));

// ⑧ session 文件 GC
vi.mock("@zhushanwen/subagent-core/execution/session-file-gc.ts", () => ({
  maybeCleanupExpiredSessionFiles: mockMaybeCleanup,
}));

// ④ 通知账本 bind（index.ts 另消费 getBoundNotifyLedger —— session_compact handler）
vi.mock("@zhushanwen/subagent-core/execution/notify-ledger.ts", () => ({
  bindNotifyLedgerHost: mockBindNotifyLedgerHost,
  getBoundNotifyLedger: () => null,
}));

// ⑪ lifecycle：仅替换 recoverCrashedRuns，其余导出（scheduleTimeBudget/
// terminateRunningRuns 等）经 importOriginal 保留真实实现。
vi.mock("@zhushanwen/subagent-core/orchestration/lifecycle.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhushanwen/subagent-core/orchestration/lifecycle.ts")>();
  return { ...actual, recoverCrashedRuns: mockRecoverCrashedRuns };
});

// ⑦⑨⑥ SubagentService mock：方法全部挂 hoisted spy（跨实例聚合计数）。
// [H3/R6 连带] SubagentService 类仍从壳导出（壳 mock 保留）；单例访问器族外移
// service/service-bootstrap.ts，经 importOriginal 只替换 get/set（同 session-lifecycle）。
vi.mock("@zhushanwen/subagent-core/execution/subagent-service.ts", () => ({
  SubagentService: class {
    initSession = mockInitSession;
    setUiRequestHandler = vi.fn();
    startGcTimer = mockStartGcTimer;
    recoverManifestTmpFiles = mockRecoverManifestTmpFiles;
    rebuildIndexes = mockRebuildIndexes;
    getStreamSink = () => null;
    dispose = vi.fn();
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

vi.mock("@zhushanwen/subagent-core/execution/model-config-service.ts", () => ({
  ModelConfigService: class {
    initModel = mockInitModel;
    // session_start 的 lastEngine 基线读取经本方法（构造性同源）
    reloadGlobalConfig = vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } }));
  },
  getModelConfigService: () => null,
  setModelConfigService: vi.fn(),
}));

// JsonlRunStore mock：recoverCrashedRuns 已替换，loadAll 不会被触发；防御性补齐
// dispose/flushPendingSaves（session_shutdown handler 会调 state.store.dispose()）。
vi.mock("../jsonl-run-store.ts", () => ({
  JsonlRunStore: class {
    loadAll = vi.fn(async () => []);
    save = vi.fn(async () => {});
    dispose = vi.fn(async () => {});
    flushPendingSaves = vi.fn(async () => {});
  },
}));

// interface 层 mock：避免触发真实 pi.registerTool（pi 是 Proxy）。
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
  registerWorkflowTool: vi.fn(),
}));
vi.mock("../interface/tool-workflow-script.ts", () => ({
  registerWorkflowScriptTool: vi.fn(),
}));
vi.mock("../interface/commands.ts", () => ({
  registerWorkflowsCommand: vi.fn(),
}));

// ── import 被测工厂（每用例 resetModules 后动态取新鲜实例，守卫 Map 随之重建） ──

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { IDENTITY_CUSTOM_TYPE } from "@zhushanwen/subagent-core/execution/session-reconstructor.ts";

let subagentsExtension: (pi: ExtensionAPI) => void;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  subagentsExtension = (await import("../index.ts")).default;
});

// ── helpers（对齐 crash-recovery.test.ts 形态） ──

/** 创建可观察 eventBus.emit / appendEntry 的 mock ExtensionAPI，捕获 session_start handler。 */
function createMockPi(): {
  pi: ExtensionAPI;
  emits: Array<{ channel: string; data: unknown }>;
  appendEntryCalls: Array<{ customType: string; data: unknown }>;
  getSessionStartHandler: () => ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
} {
  let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const emits: Array<{ channel: string; data: unknown }> = [];
  const appendEntryCalls: Array<{ customType: string; data: unknown }> = [];
  const events = {
    emit(channel: string, data: unknown): void {
      emits.push({ channel, data });
    },
  };
  const noop = (): void => {
    /* mock */
  };
  const pi = new Proxy<ExtensionAPI>({} as ExtensionAPI, {
    get(_target, prop: string | symbol): unknown {
      if (prop === "on") {
        return (event: string, handler: (...args: unknown[]) => unknown) => {
          if (event === "session_start") {
            sessionStartHandler = handler as (event: unknown, ctx: unknown) => Promise<void>;
          }
        };
      }
      if (prop === "events") return events;
      if (prop === "appendEntry") {
        return (customType: string, data: unknown) => {
          appendEntryCalls.push({ customType, data });
        };
      }
      if (prop === "sendMessage") return noop;
      if (prop === "registerMessageRenderer") return noop;
      return noop;
    },
  });
  return {
    pi,
    emits,
    appendEntryCalls,
    getSessionStartHandler: () => sessionStartHandler,
  };
}

/** 最小 ExtensionContext mock。 */
function createMockCtx(): Record<string, unknown> {
  return {
    cwd: "/home/user/project",
    mode: "tui",
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    },
    model: undefined,
    sessionManager: {
      getSessionId: () => "session-once-1",
      getSessionFile: () => "/home/user/.pi/agent/sessions/session-once-1.jsonl",
      getSessionDir: () => "/home/user/.pi/agent/sessions",
      getCwd: () => "/home/user/project",
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => null,
      getLeafEntry: () => undefined,
      getEntry: () => undefined,
      getHeader: () => null,
      getTree: () => [],
      getSessionName: () => undefined,
    },
    isIdle: () => true,
  };
}

// ── tests ──

describe("session_start 双派发幂等守卫（oncePerProcess，u-audit-fix）", () => {
  it("双派发下六项跨 session 副作用操作各执行 1 次，pending:unregister 仅 emit 1 条", async () => {
    // ⑪ 模拟恢复一个 run：onRunRecovered 回调 → pi.events.emit（真实链路观察点）
    mockRecoverCrashedRuns.mockImplementation(async (
      _store: unknown,
      _runs: unknown,
      _reason: string,
      opts?: { onRunRecovered?: (payload: unknown) => void },
    ) => {
      opts?.onRunRecovered?.({ id: "wf-recover-1", reason: "failed" });
    });

    const { pi, emits, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);
    // factory 体内有一次无守卫的 syncEnginesFile（U7b，模块加载期兜底，u-audit 范围外）
    // ——清计数后只观察 handler 双派发窗口。
    vi.clearAllMocks();

    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();
    const ctx = createMockCtx();
    await handler!({ type: "session_start", reason: "startup" }, ctx);
    await handler!({ type: "session_start", reason: "resume" }, ctx);

    // 探针 a：handler 体执行 2 次（防误伤项证明双派发真实发生，见下一用例的 ×2 断言）
    // + 六项包装操作各执行 1 次
    expect(mockSyncEnginesFile).toHaveBeenCalledTimes(1);
    expect(mockStartGcTimer).toHaveBeenCalledTimes(1);
    expect(mockMaybeCleanup).toHaveBeenCalledTimes(1);
    expect(mockRecoverManifestTmpFiles).toHaveBeenCalledTimes(1);
    expect(mockRebuildIndexes).toHaveBeenCalledTimes(1);
    expect(mockScan).toHaveBeenCalledTimes(1);
    // 探针 e：recoverCrashedRuns 落盘链（loadAll → 转 failed → save）入口 =1
    expect(mockRecoverCrashedRuns).toHaveBeenCalledTimes(1);
    expect(mockRecoverCrashedRuns.mock.calls[0]?.[2]).toBe("Process killed (kill-9 or crash recovery)");
    // onRunRecovered 回调只在首次执行内触发 → emit 恰 1 条（第二派发重放 Promise 不重放回调）
    const unregister = emits.filter((e) => e.channel === "pending:unregister");
    expect(unregister).toHaveLength(1);
    expect(unregister[0]!.data).toEqual({ id: "wf-recover-1", reason: "failed" });
  });

  it("防误伤：③identity appendEntry / ④bindNotifyLedger / ⑥initSession 每 session_start 执行（双派发 ×2）", async () => {
    // ③ identity 只在子进程 env 注入时写（主进程跳过）——注入后双派发应 ×2
    process.env.PI_SUBAGENT_SELF_RECORD_ID = "rec-once-1";
    process.env.PI_SUBAGENT_AGENT = "reviewer";
    try {
      const { pi, appendEntryCalls, getSessionStartHandler } = createMockPi();
      subagentsExtension(pi);
      vi.clearAllMocks();

      const handler = getSessionStartHandler();
      expect(handler).toBeDefined();
      const ctx = createMockCtx();
      await handler!({ type: "session_start", reason: "startup" }, ctx);
      await handler!({ type: "session_start", reason: "resume" }, ctx);

      // ③ 本 session entry：每派发一次（进程级 flag 会杀掉后续 session 的 identity 写入）
      const identityEntries = appendEntryCalls.filter((c) => c.customType === IDENTITY_CUSTOM_TYPE);
      expect(identityEntries).toHaveLength(2);
      // ④ bind 每 session_start 一次（recoverFromSession 是「每 session 一次」语义，D3 粒度段）
      expect(mockBindNotifyLedgerHost).toHaveBeenCalledTimes(2);
      expect(mockRecoverFromSession).toHaveBeenCalledTimes(2);
      // ⑥ service 覆盖式注入：SR-3 语义要求每 session_start 重新注入
      expect(mockInitSession).toHaveBeenCalledTimes(2);
      expect(mockInitModel).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.PI_SUBAGENT_SELF_RECORD_ID;
      delete process.env.PI_SUBAGENT_AGENT;
    }
  });
});
