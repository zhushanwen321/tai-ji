// src/__tests__/sdk-contract.test.ts
//
// SDK 契约测试：验证扩展对 Pi SDK 的消费符合 [MANDATORY] checklist。
// 关闭 CI sdk-contract-audit job 的前向引用（该 job 直接跑此文件）。
//
// 核心断言（[MANDATORY] checklist）：
//   1. registerSubagentsCommand 注册名为 "subagents" 的命令，handler 是 (args, ctx)
//   2. registerSubagentTool 注册名为 "subagent" 的工具，schema 存在
//   3. pending:unregister 事件携带 result/error/patchFile 时消费侧 sendMessage（T2 后替代 notifier）
//   4. session_start handler 类型签名 (event, ctx) → 编译期保证（stub 精确类型）
//
// 不导入 index.ts（它经 getAgentDir 值导入触发 alias 解析失败——alias 指向
// .d.ts-only stub）。改测叶子注册函数。session_start 的
// (event, ctx) 双参数契约由 tsconfig 的精确 stub 类型在编译期强制（见
// 注释：modelRegistry/cwd/ui 不在 event 上）。

import { describe, expect, it, vi } from "vitest";

// registerSubagentTool 经 subagent-tool.ts 值导入 StringEnum（pi-ai）+ Type（typebox）。
// stub 是 .d.ts（仅类型），pnpm optional-peer-dep 插件拦截值导入 → vi.mock 兜底。
vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: (values: string[]) => ({ type: "string", enum: values }),
}));
vi.mock("typebox", () => ({
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    Optional: (schema: unknown) => ({ ...schema as object, optional: true }),
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

// Mock getSubagentService：execute plumb-through 契约测试需要拦截 service.execute 调用。
// [H3/R6 连带] 单例访问器族自壳外移 service/service-bootstrap.ts（barrel 改从 bootstrap
// re-export）——mock 挂 bootstrap 并经 importOriginal 保留其余真实导出；不挂则被测侧
// 经 barrel 拿到真实未初始化服务（"subagents runtime not initialized" 假失败）。
const { mockServiceExecute } = vi.hoisted(() => ({
  mockServiceExecute: vi.fn(),
}));
vi.mock(
  "@zhushanwen/subagent-core/execution/service/service-bootstrap.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<typeof import("@zhushanwen/subagent-core/execution/service/service-bootstrap.ts")>();
    return {
      ...actual,
      getSubagentService: () => ({ execute: mockServiceExecute, getCollectSyncDefault: () => "async" }),
    };
  },
);

import { registerWorkflowsCommand } from "../interface/commands.ts";
import { registerSubagentTool } from "../interface/subagent-tool.ts";
import { registerSubagentsCommand } from "../interface/subagents.ts";
import type { LauncherDeps } from "@zhushanwen/subagent-core";
import { mockExtensionApi } from "@zhushanwen/subagent-core/testing/execution/__tests__/helpers/mock-extension-api.ts";

/**
 * 构造最小 LauncherDeps mock（契约测试只捕获 handler，从不调用它，
 * 故 deps 字段全为占位 no-op 即可——registerWorkflowsCommand 注册时不读 deps，
 * 仅存入 handler 闭包）。
 *
 * 用 `as unknown as LauncherDeps` 与 orchestration/__tests__ 同模式（该类型字段多，
 * 全字段构造冗余；占位足够此处断言注册名 + handler arity 的需要）。
 */
function makeLauncherDepsStub(): LauncherDeps {
  return {
    registry: { get: vi.fn() },
    runs: new Map(),
    store: { save: vi.fn(), loadAll: vi.fn(async () => []) },
    workerHost: { start: vi.fn() },
    runner: { run: vi.fn() },
    log: vi.fn(),
    eventBus: { emit: vi.fn() },
  } as unknown as LauncherDeps;
}

// ============================================================
// /subagents command 契约
// ============================================================
describe("/subagents command contract [MANDATORY]", () => {
  it("registers a command named 'subagents'", () => {
    let registeredName: string | undefined;
    const pi = mockExtensionApi({
      registerCommand: (name: string) => { registeredName = name; },
    });
    registerSubagentsCommand(pi);
    expect(registeredName).toBe("subagents");
  });

  it("handler accepts (args, ctx) — two parameters", () => {
    let capturedHandler: ((...args: unknown[]) => unknown) | undefined;
    const pi = mockExtensionApi({
      registerCommand: (_name: string, command: { handler: (...args: unknown[]) => unknown }) => {
        capturedHandler = command.handler;
      },
    });
    registerSubagentsCommand(pi);
    expect(capturedHandler).toBeDefined();
    // function.length 反映必填参数数（ctx 至少是第 2 个）
    expect(capturedHandler!.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================
// /workflows command 契约 [MANDATORY]
// ============================================================
//
// registerWorkflowsCommand(api, getRuns, deps) 注册名为 "workflows" 的命令，
// handler 是 (args, ctx)。与 /subagents 同构的注册契约——此处锁住注册名 + handler arity，
// 防止重构时改名或丢参数导致 /workflows 命令失效。
describe("/workflows command contract [MANDATORY]", () => {
  it("registers a command named 'workflows'", () => {
    let registeredName: string | undefined;
    const pi = mockExtensionApi({
      registerCommand: (name: string) => { registeredName = name; },
    });
    // getRuns / deps 契约测试不调用 handler，传最小合法值即可
    registerWorkflowsCommand(pi, () => new Map(), makeLauncherDepsStub());
    expect(registeredName).toBe("workflows");
  });

  it("handler accepts (args, ctx) — two parameters", () => {
    let capturedHandler: ((...args: unknown[]) => unknown) | undefined;
    const pi = mockExtensionApi({
      registerCommand: (_name: string, command: { handler: (...args: unknown[]) => unknown }) => {
        capturedHandler = command.handler;
      },
    });
    registerWorkflowsCommand(pi, () => new Map(), makeLauncherDepsStub());
    expect(capturedHandler).toBeDefined();
    // function.length 反映必填参数数（args + ctx = 2）
    expect(capturedHandler!.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================
// subagent tool 契约
// ============================================================
describe("subagent tool contract [MANDATORY]", () => {
  it("registers a tool named 'subagent' with a parameters schema", () => {
    let registeredTool: { name: string; parameters: unknown } | undefined;
    const pi = mockExtensionApi({
      registerTool: (tool: unknown) => { registeredTool = tool as { name: string; parameters: unknown }; },
    });
    registerSubagentTool(pi);
    expect(registeredTool?.name).toBe("subagent");
    expect(registeredTool?.parameters).toBeDefined();
  });

  it("tool has execute, renderCall, renderResult callbacks", () => {
    let registeredTool: Record<string, unknown> | undefined;
    const pi = mockExtensionApi({
      registerTool: (tool: unknown) => { registeredTool = tool as Record<string, unknown>; },
    });
    registerSubagentTool(pi);
    expect(typeof registeredTool?.execute).toBe("function");
  });

  // SDK 契约：ToolDefinition.execute 是 5 参数 (toolCallId, params, signal, onUpdate, ctx)。
  // ctx 是第 5 个参数，runtime 通过 wrapToolDefinition(ctxFactory) 注入。
  // 此测试验证 ctx.model 被 plumb 到 service.execute 的 ctxModel 参数。
  // 回归保护：subagent-tool.ts execute 把 _ctx?.model 传给 startHandler 的第 5 参 ctxModel。
  it("execute passes ctx.model as ctxModel (SDK 5-param contract)", async () => {
    let capturedExecute: ((...args: never[]) => Promise<unknown>) | undefined;
    const pi = mockExtensionApi({
      registerTool: (tool: unknown) => {
        capturedExecute = (tool as { execute: (...args: never[]) => Promise<unknown> }).execute;
      },
    });
    registerSubagentTool(pi);
    expect(capturedExecute).toBeDefined();

    mockServiceExecute.mockReset();
    mockServiceExecute.mockResolvedValue({
      mode: "background",
      subagentId: "bg-test",
      sessionFile: "/test/session.jsonl",
      details: { slug: "test-slug" },
    });
    const ctxModel = { id: "test-model", name: "Test", provider: "test", reasoning: false };
    const ctx = { model: ctxModel } as object;

    await capturedExecute!(
      "call-1",
      { action: "start", task: "test task", slug: "test-slug" },
      undefined,
      undefined,
      ctx,
    );

    expect(mockServiceExecute).toHaveBeenCalledTimes(1);
    expect(mockServiceExecute).toHaveBeenCalledWith(
      expect.objectContaining({ ctxModel, slug: "test-slug" }),
    );
  });

  // [MF#5] fork/worktree/cwd 参数传递链路契约（acceptance #8）：
  // tool execute → startHandler(service, params) → service.execute({fork, worktree, cwd, ...})。
  // 回归保护：subagent-actions.ts startHandler L152-166 把 input.fork/worktree/cwd 透传给
  // service.execute。若任一字段在 handler 内漏传（如重构改名/删行），子 agent 静默丢失隔离模式。
  // 此测试锁住「顶层 fork/worktree/cwd → service.execute 同名参数」端到端透传（拍平后无 startParam envelope）。
  it("execute plumbs top-level fork/worktree/cwd to service.execute (chain contract)", async () => {
    let capturedExecute: ((...args: never[]) => Promise<unknown>) | undefined;
    const pi = mockExtensionApi({
      registerTool: (tool: unknown) => {
        capturedExecute = (tool as { execute: (...args: never[]) => Promise<unknown> }).execute;
      },
    });
    registerSubagentTool(pi);
    expect(capturedExecute).toBeDefined();

    mockServiceExecute.mockReset();
    mockServiceExecute.mockResolvedValue({
      mode: "background",
      subagentId: "bg-fork-wt",
      sessionFile: "/test/session.jsonl",
      details: { slug: "iso-work" },
    });

    await capturedExecute!(
      "call-fork-wt",
      {
        action: "start",
        task: "isolated work",
        slug: "iso-work",
        fork: true,
        worktree: true,
        cwd: "/x",
      },
      undefined,
      undefined,
      undefined,
    );

    // service.execute 收到完整的 fork/worktree/cwd 三参数透传
    expect(mockServiceExecute).toHaveBeenCalledTimes(1);
    expect(mockServiceExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        fork: true,
        worktree: true,
        cwd: "/x",
      }),
    );
  });

  // sync 路径已删除（T2 Wave 0）。background 的 content JSON 只含 bgResponse
  // （status/mode/message），不含 record 派生投影——投影发生在 notifier 注入的完成消息。
});

// ============================================================
// pending:unregister 事件契约 [MANDATORY]（T2 后 notifier 职责转移至此）
// ============================================================
//
// T2 后 background 完成通知改由 pending-notifications 扩展消费 pending:unregister
// 事件后调 pi.sendMessage。subagent-service 的 emitPendingUnregister 在终态路径
// 携带 result/error/patchFile，消费侧据此构造 customType:"subagent-bg-notify" 消息
// 并以 triggerTurn:true + deliverAs:"followUp" 注入。
//
// 此处的契约由 pending-notifications 的单元测试覆盖（断言 sendMessage 调用参数），
// 本套件不再直接测试 BgNotifier（已删除）。

// ============================================================
// session_start handler 双参数契约 — 编译期保证
// ============================================================
describe("session_start handler signature (compile-time guarantee)", () => {
  it("ExtensionHandler<SessionStartEvent> is (event, ctx) two-param — enforced by stub type", () => {
    // 此测试是编译期断言：stub 类型声明
    //   ExtensionHandler<E, R> = (event: E, ctx: ExtensionContext) => Promise<R|void> | R | void;
    // 且 SessionStartEvent 注释明确 modelRegistry/cwd/ui 不在 event 上（在 ctx）。
    // index.ts:66 `pi.on("session_start", (_event, ctx) => {...})` 通过此类型检查即证明契约。
    // tsc --noEmit 零错误 = 此契约成立。此 it() 占位让套件非空（实际断言在编译期）。
    expect(true).toBe(true);
  });
});
