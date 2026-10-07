/**
 * rpc-command-handling — RPC slash command 测试（command-handlers + command-actions 合一）。
 *
 * 同域两层的组织性收敛（非去重）：
 * - 解析纯函数层：parseSubagentRpcCommand / parseWorkflowRpcCommand——正常路径、
 *   missing-id 边界、removed 边界（run 一次性生命周期后 pause 不可用；resume 是
 *   断点续跑一等 action）、noop 边界（空串 / 未知 action / 无参列表查看）。纯函数无外部依赖，直接断言返回值。
 * - handler 接线层：switch dispatch + try/catch + notify 文案。
 *
 * handler 测试手法：调 register*Command(pi_mock) 后，从 pi_mock.registerCommand 的调用中
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

/** 桩化 lifecycle/resume-run——abortRun / resumeRun 为 vi.fn，由测试控制 resolve/reject。 */
vi.mock("@zhushanwen/subagent-core/orchestration/lifecycle.ts", () => ({
  abortRun: vi.fn(),
}));
vi.mock("@zhushanwen/subagent-core/orchestration/resume-run.ts", () => ({
  resumeRun: vi.fn(),
}));

/** 桩化扩展日志：断言 /workflows runId 补全数据源不可用时的 warn 留痕。 */
const { loggerFns } = vi.hoisted(() => ({
  loggerFns: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => loggerFns,
  setPiHandle: vi.fn(),
}));

// ── 延迟 import 被测模块（取 mock 后的实现）──────────────────

// 被 mock 的模块——vi.mock 路径与被测源文件解析到同一物理模块，确保 vitest 拦截同一模块实例。
// 使用 import 副作用顺序：vi.mock 在文件顶部提升，此处 import 拿到的是 mock 版本。
import { setSubagentService, setModelConfigService } from "@zhushanwen/subagent-core";
import { registerWorkflowsCommand } from "../interface/command/commands.ts";
import { registerSubagentsCommand } from "../interface/command/subagents.ts";
import {
  parseSubagentRpcCommand,
  parseWorkflowRpcCommand,
} from "../interface/command/command-actions.ts";
import { abortRun, resumeRun } from "@zhushanwen/subagent-core";
import { GLOBAL_SLOT_KEYS } from "@zhushanwen/subagent-core";

// ── 访问器槽注入 helpers ─────────────────────────────────────

/** 重置进程级 SubagentService 单例槽（setSubagentService 不接受 null，测试清理用
 *  Symbol 直写；key 与生产 getServiceSlot 的 SERVICE_SLOT_KEY 一致）。 */
function resetServiceSlot(): void {
  const slot = Reflect.get(globalThis, Symbol.for(GLOBAL_SLOT_KEYS.service)) as
    | { current: unknown }
    | undefined;
  if (slot) slot.current = null;
}

/** 重置进程级 ModelConfigService 单例槽（model catalog 预检用例的清理，同款 Symbol 直写）。 */
function resetModelServiceSlot(): void {
  const slot = Reflect.get(globalThis, Symbol.for(GLOBAL_SLOT_KEYS.modelService)) as
    | { current: unknown }
    | undefined;
  if (slot) slot.current = null;
}

/** 目录放行的最小 ModelConfigService fake（getAvailable 只含 p1/m1）。 */
function injectModelServiceWith(entries: Array<{ provider: string; id: string }>): void {
  setModelConfigService({
    getModelRegistry: () => ({ getAvailable: () => entries }),
  } as never);
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

/** registerCommand 第二参数形状（{ description, handler, getArgumentCompletions }）。 */
interface CommandDef {
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  getArgumentCompletions?: (
    prefix: string,
  ) => Array<{ label: string; value: string; description: string }> | null;
}

// ============================================================
// 解析纯函数层：parseSubagentRpcCommand
// ============================================================

describe("parseSubagentRpcCommand", () => {
  it("cancel + recordId → { action: 'cancel', recordId }", () => {
    expect(parseSubagentRpcCommand("cancel bg-jwt-research")).toEqual({
      action: "cancel",
      recordId: "bg-jwt-research",
    });
  });

  it("cancel 无 recordId → cancel-missing-id", () => {
    expect(parseSubagentRpcCommand("cancel")).toEqual({ action: "cancel-missing-id" });
  });

  it("cancel 后跟多个空格再 id → 正确解析 id（trim 后）", () => {
    expect(parseSubagentRpcCommand("cancel   bg-x")).toEqual({
      action: "cancel",
      recordId: "bg-x",
    });
  });

  it("空串 → noop", () => {
    expect(parseSubagentRpcCommand("")).toEqual({ action: "noop" });
  });

  it("纯空白 → noop", () => {
    expect(parseSubagentRpcCommand("   ")).toEqual({ action: "noop" });
  });

  it("未知 action → noop", () => {
    expect(parseSubagentRpcCommand("foobar bg-x")).toEqual({ action: "noop" });
  });

  it("无参（列表查看，GUI 不走此路径但需兜底）→ noop", () => {
    expect(parseSubagentRpcCommand("bg-jwt-research")).toEqual({ action: "noop" });
  });
});

// ============================================================
// parseSubagentRpcCommand — message/start（GUI 定向消息通道，设计 §3.3.3）
// ============================================================

describe("parseSubagentRpcCommand message/start（定向消息通道）", () => {
  it("message + recordId + text（含空格）→ 剩余全量保留空格", () => {
    expect(parseSubagentRpcCommand("message sa-1 展开讲讲 这个方案")).toEqual({
      action: "message",
      recordId: "sa-1",
      text: "展开讲讲 这个方案",
    });
  });

  it("message text 含引号 → 原样保留（不解析引号语义）", () => {
    expect(parseSubagentRpcCommand('message sa-1 引用 "so called" 原文')).toEqual({
      action: "message",
      recordId: "sa-1",
      text: '引用 "so called" 原文',
    });
  });

  it("message 换行转义：字面 \\n（两字符）还原为真实换行（P3 转义协议）", () => {
    // 源码里 "\\n" = 字面反斜杠+n；解析产物含真实换行 "\n"
    expect(parseSubagentRpcCommand("message sa-1 第一行\\n第二行")).toEqual({
      action: "message",
      recordId: "sa-1",
      text: "第一行\n第二行",
    });
  });

  it("message 多个换行转义 + 空格混合 → 还原为多行文本", () => {
    expect(parseSubagentRpcCommand("message sa-1 标题\\n\\n正文 内容")).toEqual({
      action: "message",
      recordId: "sa-1",
      text: "标题\n\n正文 内容",
    });
  });

  it("message 缺 recordId → message-missing-args (missing: recordId)", () => {
    expect(parseSubagentRpcCommand("message")).toEqual({
      action: "message-missing-args",
      missing: "recordId",
    });
  });

  it("message 缺 text（recordId 后无内容）→ message-missing-args (missing: text)", () => {
    expect(parseSubagentRpcCommand("message sa-1")).toEqual({
      action: "message-missing-args",
      missing: "text",
    });
  });

  it("message text 纯字面换行（还原后为空白）→ missing text（先还原再判空）", () => {
    expect(parseSubagentRpcCommand("message sa-1 \\n")).toEqual({
      action: "message-missing-args",
      missing: "text",
    });
  });

  it("message verb 后多空格再 recordId → trim 后正确解析", () => {
    expect(parseSubagentRpcCommand("message   sa-x   hello world")).toEqual({
      action: "message",
      recordId: "sa-x",
      text: "hello world",
    });
  });

  it("start + slug + task（含空格）→ 剩余全量", () => {
    expect(parseSubagentRpcCommand("start fix-login 修复登录页 并写测试")).toEqual({
      action: "start",
      slug: "fix-login",
      task: "修复登录页 并写测试",
    });
  });

  it("start task 换行转义 → 还原为真实换行", () => {
    expect(parseSubagentRpcCommand("start my-slug 任务一\\n任务二")).toEqual({
      action: "start",
      slug: "my-slug",
      task: "任务一\n任务二",
    });
  });

  it("start 缺 slug → start-missing-args (missing: slug)", () => {
    expect(parseSubagentRpcCommand("start")).toEqual({
      action: "start-missing-args",
      missing: "slug",
    });
  });

  it("start 缺 task → start-missing-args (missing: task)", () => {
    expect(parseSubagentRpcCommand("start fix-login")).toEqual({
      action: "start-missing-args",
      missing: "task",
    });
  });

  it("message/start 与 cancel 共存：未知 verb 仍落 noop（回归保护）", () => {
    expect(parseSubagentRpcCommand("pause sa-1")).toEqual({ action: "noop" });
    expect(parseSubagentRpcCommand("restart sa-1")).toEqual({ action: "noop" });
  });
});

// ============================================================
// 转义协议互逆（runtime encodeDirectiveText ↔ decodeNewlineEscapes）
// ============================================================

describe("转义协议互逆（message/start 文本往返不变）", () => {
  // runtime 侧 encodeDirectiveText（session-service.ts）的本地镜像：extension 不依赖
  // runtime 包（依赖边界 F7），互逆性靠两侧测试对同一 wire 协议双向钉死。
  // 编码规则：原生反斜杠 → \\（先）、真实换行 → 字面 \n（后），命令保持单行。
  const encodeMirror = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

  it("原文含字面 \\n（反斜杠+n，如路径 C:\\new）→ 往返不变（不被误解码为换行）", () => {
    const original = "路径 C:\\new folder 的说明";
    const parsed = parseSubagentRpcCommand(`message sa-1 ${encodeMirror(original)}`);
    expect(parsed).toEqual({ action: "message", recordId: "sa-1", text: original });
  });

  it("原文含反斜杠（非 n 前缀，如正则 \\d+ 与 UNC 路径）→ 往返不变", () => {
    const original = "正则 \\d+ 与 \\\\server\\share";
    const parsed = parseSubagentRpcCommand(`message sa-1 ${encodeMirror(original)}`);
    expect(parsed).toEqual({ action: "message", recordId: "sa-1", text: original });
  });

  it("原文含真实换行 → 往返不变（编码为字面 \\n 后还原）", () => {
    const original = "第一行\n第二行";
    const parsed = parseSubagentRpcCommand(`message sa-1 ${encodeMirror(original)}`);
    expect(parsed).toEqual({ action: "message", recordId: "sa-1", text: original });
  });

  it("混合：反斜杠 + 真实换行 + 字面 \\n 同文 → 往返不变", () => {
    const original = "C:\\new\n正则 \\d+\n收尾";
    const parsed = parseSubagentRpcCommand(`message sa-1 ${encodeMirror(original)}`);
    expect(parsed).toEqual({ action: "message", recordId: "sa-1", text: original });
  });

  it("start task 同样满足互逆（task 与 text 共用同一转义协议）", () => {
    const original = "任务 C:\\new\n第二行";
    const parsed = parseSubagentRpcCommand(`start my-slug ${encodeMirror(original)}`);
    expect(parsed).toEqual({ action: "start", slug: "my-slug", task: original });
  });
  // 注：原「wire 上编码后的文本不含真实换行」条已删——断言打在本文件自定义的
  // encodeMirror 上（镜像函数替换换行后 includes("\n") 结构性恒 false，生产编码
  // 零参与）；命令单行不变式由 runtime 侧 encodeDirectiveText 的对拍断言承接。
});

// ============================================================
// parseWorkflowRpcCommand
// ============================================================

describe("parseWorkflowRpcCommand", () => {
  it("pause + runId → { action: 'lifecycle-removed', verb: 'pause' }（run 一次性生命周期，不可挂起）", () => {
    expect(parseWorkflowRpcCommand("pause run-abc")).toEqual({
      action: "lifecycle-removed",
      verb: "pause",
    });
  });

  it("resume + runId → { action: 'resume', runId }（断点续跑一等 action——与 TUI verb、tool action 同语义）", () => {
    expect(parseWorkflowRpcCommand("resume run-def")).toEqual({
      action: "resume",
      runId: "run-def",
    });
  });

  it("resume + runId + model → { action: 'resume', runId, model }（F1-26 后续项：显式模型第三通道入参）", () => {
    expect(parseWorkflowRpcCommand("resume run-def p2/m2:high")).toEqual({
      action: "resume",
      runId: "run-def",
      model: "p2/m2:high",
    });
  });

  it("abort + runId → { action: 'abort', runId }", () => {
    expect(parseWorkflowRpcCommand("abort run-ghi")).toEqual({
      action: "abort",
      runId: "run-ghi",
    });
  });

  it("pause 无 runId → lifecycle-removed（removed verb 优先于 missing-id 判定——提示语义优先）", () => {
    expect(parseWorkflowRpcCommand("pause")).toEqual({
      action: "lifecycle-removed",
      verb: "pause",
    });
  });

  it("resume 无 runId → lifecycle-missing-id with verb（Usage 引导补 runId）", () => {
    expect(parseWorkflowRpcCommand("resume")).toEqual({
      action: "lifecycle-missing-id",
      verb: "resume",
    });
  });

  it("abort 无 runId → lifecycle-missing-id with verb", () => {
    expect(parseWorkflowRpcCommand("abort")).toEqual({
      action: "lifecycle-missing-id",
      verb: "abort",
    });
  });

  it("空串 → noop", () => {
    expect(parseWorkflowRpcCommand("")).toEqual({ action: "noop" });
  });

  it("纯空白 → noop", () => {
    expect(parseWorkflowRpcCommand("  ")).toEqual({ action: "noop" });
  });

  it("未知 action → noop", () => {
    expect(parseWorkflowRpcCommand("status run-abc")).toEqual({ action: "noop" });
  });

  it("无参（列表查看）→ noop", () => {
    expect(parseWorkflowRpcCommand("run-abc")).toEqual({ action: "noop" });
  });
});

// ============================================================
// handler 接线层：/subagents handler（registerSubagentsCommand）
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
      "View subagents in the composer task tray",
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

  /** message 目标 record mock（messageHandler 经 getRecordForAction 取到）。
   *  [modeless 波5] 无 chatMode——message 资格 = 引擎能力轴（fake 的
   *  engineSupportsConversation），与 record 形态无关。 */
  function makeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "sa-1",
      slug: "build-api",
      status: "running",
      ...overrides,
    };
  }

  it("message 正常（非 streaming）→ messageHandler 接线 + 留痕 entry 立即落盘", async () => {
    const record = makeRecord();
    const deliverChatMessage = vi.fn();
    const getRecordForAction = vi.fn(() => record);
    const engineSupportsConversation = vi.fn(() => true);
    // [D4 聚合跟随] message/close 生产消费面 = service.chatActions
    injectFakeService({
      chatActions: {
        getRecordForAction,
        deliverChatMessage,
      },
      engineSupportsConversation,
    });

    // 转义协议：字面 \n 传输，解析侧还原（P3）
    await runHandler("message sa-1 第一条消息\\n带换行");

    // 归属校验（reconnect 放行）→ 引擎能力轴 gate（[modeless 波1] message 资格唯一门槛）
    // → 真实 messageHandler 跑通：deliverChatMessage(record, 还原后文本)
    expect(getRecordForAction).toHaveBeenCalledWith("sa-1", { allowReconnect: true });
    expect(engineSupportsConversation).toHaveBeenCalledWith(record);
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
      // [modeless 波1] message 资格引擎轴 gate（messageHandler 现流程第二道）；streaming
      // 分流发生在 gate 之后的留痕段——不喂门则 message 被引擎轴拒、留痕不落
      engineSupportsConversation: vi.fn(() => true),
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

  it("start 正常（非 streaming）→ startHandler 接线（modeless 无续聊参数）+ 留痕 entry 带 subagentId/slug", async () => {
    const execute = vi.fn().mockResolvedValue({
      subagentId: "sa-new",
      sessionFile: "/tmp/s.jsonl",
      details: { slug: "fix-login" },
    });
    injectFakeService({ execute, getCollectSyncDefault: () => "async" });

    await runHandler("start fix-login 修复登录页\\n并写测试");

    // [modeless 波5 收尾] start 无续聊参数（万物可续，资格由引擎能力轴在 message 面把关）
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "修复登录页\n并写测试",
        slug: "fix-login",
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
// handler 接线层：/workflows handler（registerWorkflowsCommand）
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

    await runHandler("abort run-foo");

    expect(mockedAbortRun).toHaveBeenCalledTimes(1);
    expect(mockedAbortRun.mock.calls[0][0]).toBe("run-foo");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Workflow run-foo: aborted", "info");
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

  it("RPC + resume + runId → resumeRun 调用 + info 文案（GUI 通道断点续跑接通）", async () => {
    const mockedResumeRun = vi.mocked(resumeRun);
    mockedResumeRun.mockResolvedValue("run-def");

    await runHandler("resume run-def");

    expect(mockedResumeRun).toHaveBeenCalledTimes(1);
    expect(mockedResumeRun).toHaveBeenCalledWith("run-def", expect.anything());
    // 无 model 不落键：调用恰为 (runId, deps) 两参（spread 条件反写不会静默通过）
    expect(mockedResumeRun.mock.calls[0]).toHaveLength(2);
    expect(mockedAbortRun).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Workflow run-def: resuming — completed calls replay at zero token cost, unfinished calls re-dispatched",
      "info",
    );
  });

  it("RPC + resume + model → resumeRun 第三参 { model } 透传（handler 接线层不丢参）", async () => {
    injectModelServiceWith([{ provider: "p2", id: "m2" }]);
    try {
      const mockedResumeRun = vi.mocked(resumeRun);
      mockedResumeRun.mockResolvedValue("run-def");

      await runHandler("resume run-def p2/m2:high");

      expect(mockedResumeRun).toHaveBeenCalledTimes(1);
      expect(mockedResumeRun).toHaveBeenCalledWith("run-def", expect.anything(), {
        model: "p2/m2:high",
      });
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Workflow run-def: resuming with model p2/m2:high — completed calls replay at zero token cost, unfinished calls re-dispatched",
        "info",
      );
    } finally {
      resetModelServiceSlot();
    }
  });

  it("RPC + resume + model 目录查无 → 同步拒单 warning（tool 通道同款 D8 语义，不落覆盖记账）", async () => {
    injectModelServiceWith([{ provider: "p1", id: "m1" }]);
    try {
      const mockedResumeRun = vi.mocked(resumeRun);
      mockedResumeRun.mockResolvedValue("run-def");

      await runHandler("resume run-def pX/nope");

      // 目录查无在 resumeRun 之前拒绝——不产生假成功 notify
      expect(mockedResumeRun).not.toHaveBeenCalled();
      const call = vi.mocked(ctx.ui.notify).mock.calls[0];
      expect(String(call?.[0])).toContain("pX/nope");
      expect(call?.[1]).toBe("warning");
    } finally {
      resetModelServiceSlot();
    }
  });

  it("RPC + resume 失败（资格拒绝等）→ warning 文案含拒绝原因，不向上抛", async () => {
    const mockedResumeRun = vi.mocked(resumeRun);
    mockedResumeRun.mockRejectedValue(new Error("only interrupted runs can be resumed"));

    await runHandler("resume run-def");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Failed to resume workflow run-def: only interrupted runs can be resumed",
      "warning",
    );
  });

  it("RPC + resume 无 runId → Usage 提示含可选 [model]（与 TUI verb 分支同文案）", async () => {
    await runHandler("resume");

    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /workflows resume <runId> [model]", "warning");
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
      "View workflows in the composer task tray",
      "info",
    );
  });
});

// ============================================================
// registerWorkflowsCommand — runId 补全的降级可诊断性
// ============================================================

describe("registerWorkflowsCommand — runId 补全数据源不可用", () => {
  /** 注册命令并取出 command def（补全面直测，不经 handler）。 */
  function captureCommand(getRuns: () => Map<string, never>): CommandDef {
    let captured: CommandDef | undefined;
    const pi = {
      registerCommand: vi.fn((_name: string, def: CommandDef) => {
        captured = def;
      }),
    } as unknown as PiMock;
    registerWorkflowsCommand(pi as ExtensionAPI, getRuns as never, {} as never);
    expect(captured).toBeDefined();
    return captured as CommandDef;
  }

  it("getRuns 抛错 → 补全返回 null（返回语义不变）+ warn 留痕（原因可见）", () => {
    loggerFns.warn.mockClear();
    const def = captureCommand(() => {
      throw new Error("runs store unavailable");
    });

    const completions = def.getArgumentCompletions?.("abort r");

    expect(completions).toBeNull();
    expect(loggerFns.warn).toHaveBeenCalledTimes(1);
    expect(String(loggerFns.warn.mock.calls[0]?.[0])).toContain("runId completion unavailable");
    expect(loggerFns.warn.mock.calls[0]?.[1]).toEqual({ reason: "runs store unavailable" });
  });

  it("无 run（正常空态）→ 补全返回 null 且零 warn（与数据源不可用可区分）", () => {
    loggerFns.warn.mockClear();
    const def = captureCommand(() => new Map());

    expect(def.getArgumentCompletions?.("abort r")).toBeNull();
    expect(loggerFns.warn).not.toHaveBeenCalled();
  });
});
