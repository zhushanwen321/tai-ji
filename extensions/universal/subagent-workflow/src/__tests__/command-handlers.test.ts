/**
 * command-handlers — RPC 分支 dispatch 测试（PR review 补测）。
 *
 * 纯函数 parseSubagentRpcCommand/parseWorkflowRpcCommand 已在 command-actions.test.ts 覆盖。
 * 本文件补测 handler 本身的接线逻辑：switch dispatch + try/catch + notify 文案。
 *
 * 测试手法：调 register*Command(pi_mock) 后，从 pi_mock.registerCommand 的调用中
 * 取出 handler 函数，直接调用 handler(argsStr, ctx_mock)。
 *
 * mock 策略（[u-5b / A-V3] 访问器窄 mock 形态）：
 * - SubagentService 经单例访问器槽注入 fake（setSubagentService，globalThis 槽——
 *   生产 getSubagentService 读同一槽，不再整类 mock subagent-service 模块），
 *   由测试控制返回的 service 形状（cancel/chatActions/execute 等少数方法）
 * - abortRun（lifecycle.ts）用 vi.mock 桩化，控制抛错/成功
 * - ExtensionCommandContext 用最小 duck-typed mock（mode/hasUI/ui.notify + isIdle 留痕分流判据）
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── module mocks（必须在 import 被测模块之前声明）──────────────

/** 桩化 lifecycle——abortRun 为 vi.fn，由测试控制 resolve/reject。 */
vi.mock("@zhushanwen/subagent-core/orchestration/lifecycle.ts", () => ({
  abortRun: vi.fn(),
}));

// ── 延迟 import 被测模块（取 mock 后的实现）──────────────────

// 被 mock 的模块——vi.mock 路径与被测源文件解析到同一物理模块，确保 vitest 拦截同一模块实例。
// 使用 import 副作用顺序：vi.mock 在文件顶部提升，此处 import 拿到的是 mock 版本。
import { setSubagentService } from "@zhushanwen/subagent-core";
import { registerWorkflowsCommand } from "../interface/commands.ts";
import { registerSubagentsCommand } from "../interface/subagents.ts";
import { abortRun } from "@zhushanwen/subagent-core";

// ── 访问器槽注入 helpers ─────────────────────────────────────

/** 重置进程级 SubagentService 单例槽（setSubagentService 不接受 null，测试清理用
 *  Symbol 直写；key 与生产 getServiceSlot 的 SERVICE_SLOT_KEY 一致）。 */
function resetServiceSlot(): void {
  const slot = Reflect.get(globalThis, Symbol.for("@zhushanwen/pi-subagents.service")) as
    | { current: unknown }
    | undefined;
  if (slot) slot.current = null;
}

/** 经真实单例访问器注入 fake service（消费方 interface/* 经 barrel 读同一 globalThis 槽）。 */
function injectFakeService(service: unknown): void {
  setSubagentService(service as never);
}

// ── 类型辅助 ────────────────────────────────────────────────

/** 最小 ctx mock：mode/hasUI/ui.notify（handler RPC 分支依赖）+ isIdle（留痕分流判据）。 */
type CtxMock = Pick<ExtensionCommandContext, "mode" | "hasUI" | "ui" | "isIdle">;

/** ExtensionAPI 的最小子集：registerCommand 捕获 handler + sendMessage 捕获留痕调用。 */
type PiMock = Pick<ExtensionAPI, "registerCommand" | "sendMessage">;

/** registerCommand 第二参数形状（{ description, handler }）。 */
interface CommandDef {
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

// ============================================================
// /subagents handler（registerSubagentsCommand）
// ============================================================

describe("registerSubagentsCommand — RPC 分支 dispatch", () => {
  let captured: Record<string, CommandDef>;
  let pi: PiMock;
  let ctx: CtxMock;
  let cancelMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    captured = {};
    pi = {
      registerCommand: vi.fn((name: string, def: CommandDef) => {
        captured[name] = def;
      }),
    } as unknown as PiMock;
    ctx = {
      mode: "rpc",
      hasUI: true,
      ui: { notify: vi.fn() } as unknown as CtxMock["ui"],
      isIdle: vi.fn(() => true),
    };
    cancelMock = vi.fn();
    // 默认注入一个带 cancel 的 service（由用例覆写 cancelMock 行为）
    injectFakeService({ cancel: cancelMock });
  });

  /** 取出注册的 /subagents handler 并调用。 */
  async function runHandler(argsStr: string): Promise<void> {
    registerSubagentsCommand(pi);
    const def = captured["subagents"];
    expect(def).toBeDefined();
    await def.handler(argsStr, ctx as ExtensionCommandContext);
  }

  it("RPC + cancel + 有效 id → service.cancel 调用 + info 文案", async () => {
    cancelMock.mockReturnValue(true);

    await runHandler("cancel bg-jwt-research");

    expect(cancelMock).toHaveBeenCalledWith("bg-jwt-research");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cancelled subagent bg-jwt-research", "info");
  });

  it("RPC + cancel + id 不存在（cancel 返回 false）→ warning 文案", async () => {
    cancelMock.mockReturnValue(false);

    await runHandler("cancel bg-x");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Subagent bg-x not found or already finished",
      "warning",
    );
  });

  it("RPC + cancel 无 id → Usage 提示 warning", async () => {
    await runHandler("cancel");

    expect(cancelMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /subagents cancel <id>", "warning");
  });

  it("RPC + cancel + service.cancel 抛异常 → try/catch 兜底 warning 文案", async () => {
    cancelMock.mockImplementation(() => {
      throw new Error("service disposed");
    });

    await runHandler("cancel bg-y");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Failed to cancel subagent bg-y: service disposed",
      "warning",
    );
  });

  it("RPC + noop（空参）→ info 文案（兜底）", async () => {
    await runHandler("");

    expect(cancelMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "View subagents in the sidebar Agents tab",
      "info",
    );
  });

  it("service=null（session 未启动）→ error 文案，不进入 RPC 分支", async () => {
    resetServiceSlot();

    await runHandler("cancel bg-z");

    expect(cancelMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "subagents execution runtime not ready (session not started)",
      "error",
    );
  });
});

// ============================================================
// /subagents handler — message/start 分支（GUI 定向消息通道，设计 §3.3.3）
// ============================================================

describe("registerSubagentsCommand — RPC message/start dispatch + 留痕", () => {
  let captured: Record<string, CommandDef>;
  let pi: PiMock;
  let ctx: CtxMock;
  let sendMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    captured = {};
    sendMessageMock = vi.fn();
    pi = {
      registerCommand: vi.fn((name: string, def: CommandDef) => {
        captured[name] = def;
      }),
      sendMessage: sendMessageMock,
    } as unknown as PiMock;
    // isIdle 默认 true（非 streaming）——现有用例覆盖非 streaming 分支；
    // streaming 分支用例内覆写为 false
    ctx = {
      mode: "rpc",
      hasUI: true,
      ui: { notify: vi.fn() } as unknown as CtxMock["ui"],
      isIdle: vi.fn(() => true),
    };
    // 槽清理 + 非 null 兜底（message 缺 text 类用例在触 service 前走 Usage 分支，
    // 但 handler 先检查 service 就绪——空槽会提前进 "not ready" 分支）
    resetServiceSlot();
    injectFakeService({});
  });

  async function runHandler(argsStr: string): Promise<void> {
    registerSubagentsCommand(pi as ExtensionAPI);
    const def = captured["subagents"];
    expect(def).toBeDefined();
    await def.handler(argsStr, ctx as ExtensionCommandContext);
  }

  /** chatMode record mock（messageHandler 经 getRecordForAction 取到）。 */
  function makeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "sa-1",
      slug: "build-api",
      chatMode: true,
      status: "running",
      ...overrides,
    };
  }

  it("message 正常（非 streaming）→ messageHandler 接线 + 留痕 entry 立即落盘", async () => {
    const record = makeRecord();
    const deliverChatMessage = vi.fn();
    // [D4 聚合跟随] message/close 生产消费面 = service.chatActions
    injectFakeService({
      chatActions: {
        getRecordForAction: vi.fn(() => record),
        deliverChatMessage,
      },
    });

    // 转义协议：字面 \n 传输，解析侧还原（P3）
    await runHandler("message sa-1 第一条消息\\n带换行");

    // 真实 messageHandler 跑通：deliverChatMessage(record, 还原后文本)（[H1 U6] interrupt 退役）
    expect(deliverChatMessage).toHaveBeenCalledWith(record, "第一条消息\n带换行");
    // 留痕：subagent-directive custom_message（§3.3.3——customType/content/details 契约）
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [msg, options] = sendMessageMock.mock.calls[0] as [
      { customType: string; content: string; display: boolean; details: unknown },
      unknown,
    ];
    expect(msg.customType).toBe("subagent-directive");
    expect(msg.content).toBe("第一条消息\n带换行");
    expect(msg.display).toBe(false);
    expect(msg.details).toEqual({ subagentId: "sa-1", slug: "build-api", direction: "user" });
    // 非 streaming（ctx.isIdle()=true）→ options 整体缺席：立即 append entry 留痕，
    // 不 steer、不产生新 turn（§3.3.8）
    expect(options).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Message delivered to subagent build-api (sa-1)",
      "info",
    );
  });

  it("message 正常（streaming）→ 留痕走 deliverAs:nextTurn，不 steer 主 agent 当前 turn", async () => {
    const record = makeRecord();
    const deliverChatMessage = vi.fn();
    // [D4 聚合跟随] message/close 生产消费面 = service.chatActions
    injectFakeService({
      chatActions: {
        getRecordForAction: vi.fn(() => record),
        deliverChatMessage,
      },
    });
    // 主 agent turn 进行中（ctx.isIdle()=false）
    ctx.isIdle = vi.fn(() => false);

    await runHandler("message sa-1 turn 进行中的定向消息");

    // pi 0.84.4 sendCustomMessage：isStreaming 且无 deliverAs 时默认 steer 当前
    // turn——分流契约要求显式 nextTurn（入 _pendingNextTurnMessages 队列，下个
    // turn 注入，不打断当前 turn）
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [msg, options] = sendMessageMock.mock.calls[0] as [
      { customType: string; content: string; display: boolean; details: unknown },
      { deliverAs?: string } | undefined,
    ];
    expect(msg.customType).toBe("subagent-directive");
    expect(options).toEqual({ deliverAs: "nextTurn" });
    // 派发与通知不受 streaming 状态影响
    expect(deliverChatMessage).toHaveBeenCalledWith(record, "turn 进行中的定向消息");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Message delivered to subagent build-api (sa-1)",
      "info",
    );
  });

  it("message 目标不存在（getRecordForAction throw）→ warning 文案，不留痕", async () => {
    // [D4 聚合跟随] message/close 生产消费面 = service.chatActions
    injectFakeService({
      chatActions: {
        getRecordForAction: vi.fn(() => {
          throw new Error('No subagent record with id "sa-x"');
        }),
        deliverChatMessage: vi.fn(),
      },
    });

    await runHandler("message sa-x hi");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'Failed to message subagent sa-x: No subagent record with id "sa-x"',
      "warning",
    );
    // 失败不留痕（GUI 按 toast 错误处理，不产生假成功 entry）
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("message 缺 recordId → Usage warning 指明缺什么，不触 service", async () => {
    const deliverChatMessage = vi.fn();
    injectFakeService({ deliverChatMessage });

    await runHandler("message");

    expect(deliverChatMessage).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /subagents message <recordId> <text> — recordId is missing",
      "warning",
    );
  });

  it("message 缺 text → Usage warning 指明缺 text", async () => {
    await runHandler("message sa-1");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /subagents message <recordId> <text> — text is missing",
      "warning",
    );
  });

  it("start 正常（非 streaming）→ startHandler 接线（conversation:true 固定）+ 留痕 entry 带 subagentId/slug", async () => {
    const execute = vi.fn().mockResolvedValue({
      subagentId: "sa-new",
      sessionFile: "/tmp/s.jsonl",
      details: { slug: "fix-login" },
    });
    injectFakeService({ execute, getCollectSyncDefault: () => "async" });

    await runHandler("start fix-login 修复登录页\\n并写测试");

    // conversation:true 是 GUI 定向对话场景的固定参数（§3.3.3，可续聊）
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "修复登录页\n并写测试",
        slug: "fix-login",
        conversation: true,
      }),
    );
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [msg, options] = sendMessageMock.mock.calls[0] as [
      { customType: string; content: string; details: unknown },
      unknown,
    ];
    expect(msg.customType).toBe("subagent-directive");
    expect(msg.content).toBe("修复登录页\n并写测试");
    // start 的 subagentId 来自 startHandler 返回（StartHandlerResult.subagentId）
    expect(msg.details).toEqual({ subagentId: "sa-new", slug: "fix-login", direction: "user" });
    // 非 streaming（ctx.isIdle()=true）→ options 整体缺席（立即留痕，不 steer）
    expect(options).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Started subagent fix-login (sa-new)", "info");
  });

  it("start 正常（streaming）→ 留痕走 deliverAs:nextTurn，不 steer 主 agent 当前 turn", async () => {
    const execute = vi.fn().mockResolvedValue({
      subagentId: "sa-run",
      sessionFile: "/tmp/s2.jsonl",
      details: { slug: "audit-log" },
    });
    injectFakeService({ execute, getCollectSyncDefault: () => "async" });
    // 主 agent turn 进行中（ctx.isIdle()=false）
    ctx.isIdle = vi.fn(() => false);

    await runHandler("start audit-log 审计日志模块");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [msg, options] = sendMessageMock.mock.calls[0] as [
      { customType: string; content: string; details: unknown },
      { deliverAs?: string } | undefined,
    ];
    expect(msg.customType).toBe("subagent-directive");
    expect(msg.details).toEqual({ subagentId: "sa-run", slug: "audit-log", direction: "user" });
    // streaming 分流契约：显式 nextTurn（默认无 options 会 steer 当前 turn）
    expect(options).toEqual({ deliverAs: "nextTurn" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Started subagent audit-log (sa-run)", "info");
  });

  it("start 缺 task → Usage warning 指明缺 task，不触 service", async () => {
    const execute = vi.fn();
    injectFakeService({ execute, getCollectSyncDefault: () => "async" });

    await runHandler("start fix-login");

    expect(execute).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /subagents start <slug> <task> — task is missing",
      "warning",
    );
  });

  it("start service.execute 抛错（slug 超长等）→ warning 文案，不留痕", async () => {
    injectFakeService({
      execute: vi.fn().mockRejectedValue(new Error("slug must be ≤35 chars")),
      // [U1/U2] startHandler 解析链（E4 守卫前置）在 execute 之前调；缺省 async 不触发额外分支
      getCollectSyncDefault: () => "async",
    });

    await runHandler("start x task text");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Failed to start subagent x: slug must be ≤35 chars",
      "warning",
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// /workflows handler（registerWorkflowsCommand）
// ============================================================

describe("registerWorkflowsCommand — RPC 分支 dispatch", () => {
  let captured: Record<string, CommandDef>;
  let pi: PiMock;
  let ctx: CtxMock;
  const mockedAbortRun = vi.mocked(abortRun);

  beforeEach(() => {
    vi.clearAllMocks();
    captured = {};
    pi = {
      registerCommand: vi.fn((name: string, def: CommandDef) => {
        captured[name] = def;
      }),
    } as unknown as PiMock;
    // /workflows handler 不走留痕，isIdle 仅满足 CtxMock 类型形状
    ctx = {
      mode: "rpc",
      hasUI: true,
      ui: { notify: vi.fn() } as unknown as CtxMock["ui"],
      isIdle: vi.fn(() => true),
    };
  });

  /** 取出注册的 /workflows handler 并调用。 */
  async function runHandler(argsStr: string): Promise<void> {
    registerWorkflowsCommand(
      pi as ExtensionAPI,
      () => new Map(),
      // LauncherDeps 只在非 RPC 分支用到（abortRun 已被 mock 替换）
      {} as never,
    );
    const def = captured["workflows"];
    expect(def).toBeDefined();
    await def.handler(argsStr, ctx as ExtensionCommandContext);
  }

  it("RPC + abort + runId → abortRun 调用 + info 文案", async () => {
    mockedAbortRun.mockResolvedValue(undefined);

    await runHandler("abort run-xyz");

    expect(mockedAbortRun).toHaveBeenCalledTimes(1);
    expect(mockedAbortRun.mock.calls[0][0]).toBe("run-xyz");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Workflow run-xyz: aborted", "info");
  });

  it("RPC + abort + abortRun 抛异常 → try/catch 兜底 warning 文案", async () => {
    mockedAbortRun.mockRejectedValue(new Error("not found"));

    await runHandler("abort run-err");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Failed to abort workflow run-err: not found",
      "warning",
    );
  });

  it("RPC + pause（已移除 verb，带 runId）→ removed 提示 warning，不调 abortRun", async () => {
    await runHandler("pause run-abc");

    expect(mockedAbortRun).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Workflow pause has been removed — runs are one-shot. To stop a run early: /workflows abort <runId>",
      "warning",
    );
  });

  it("RPC + pause（已移除 verb，无 runId）→ removed 提示优先于 Usage（提示语义优先）", async () => {
    await runHandler("pause");

    expect(mockedAbortRun).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Workflow pause has been removed — runs are one-shot. To stop a run early: /workflows abort <runId>",
      "warning",
    );
  });

  it("RPC + resume（已移除 verb）→ removed 提示 warning", async () => {
    await runHandler("resume run-def");

    expect(mockedAbortRun).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Workflow resume has been removed — runs are one-shot. To stop a run early: /workflows abort <runId>",
      "warning",
    );
  });

  it("RPC + abort 无 runId → Usage 提示 warning", async () => {
    await runHandler("abort");

    expect(mockedAbortRun).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /workflows abort <runId>", "warning");
  });

  it("RPC + noop（空参）→ info 文案（兜底）", async () => {
    await runHandler("");

    expect(mockedAbortRun).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "View workflows in the sidebar Flows tab",
      "info",
    );
  });
});
