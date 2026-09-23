import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// index.ts 只做装配：mock 掉子模块注册函数，只捕获 pi.on 的 hook 与 controllers 注册表
vi.mock("../tool.js", () => ({
  registerPlanTool: vi.fn(
    (_pi: unknown, _sessions: unknown, controllers: Map<string, AbortController>) => {
      captured.controllers = controllers;
    },
  ),
  PLAN_MODE_TOOLS: ["read", "bash", "grep", "find", "ls", "plan"],
}));
vi.mock("../command.js", () => ({ registerPlanCommand: vi.fn() }));
vi.mock("../compact.js", () => ({ registerPlanEventHandlers: vi.fn() }));
vi.mock("../widget.js", () => ({ updatePlanWidget: vi.fn() }));

// MF-1-8：注入失败日志必须走 extension-logger（stderr 仅 logger 自身抛错的内层兜底）——
// 捕获 warn spy 断言落盘通道
const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => ({ warn: loggerWarn, error: vi.fn() }),
}));

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import planExtension from "../index.js";
import { PLAN_CONTEXT_CUSTOM_TYPE } from "../state.js";

const captured: { controllers?: Map<string, AbortController> } = {};

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function setup() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
    sendMessage: vi.fn(),
    setActiveTools: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;

  planExtension(pi);
  return { handlers, pi };
}

function makeCtx(entries: unknown[]): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => "test-session",
      getEntries: () => entries,
    },
    ui: { setWidget: vi.fn(), setStatus: vi.fn(), theme: { fg: (_t: string, text: string) => text } },
  } as unknown as ExtensionContext;
}

function planStateEntry(data: Record<string, unknown>) {
  return { type: "custom", customType: "plan-state", data };
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.controllers = undefined;
  vi.stubEnv("TAIJI_AGENT_EXT_LOG", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session_start hook（E3：awaiting 重挂提醒）", () => {
  it("awaiting + no live select → steers the agent to re-call submit-review (pi 懒重生之后跑)", async () => {
    const { handlers, pi } = setup();
    const ctx = makeCtx([
      planStateEntry({
        isActive: true,
        planFilePath: "/p/plan.md",
        requirement: "r",
        templateName: "",
        skills: ["tech-design"],
        docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 1 }],
        reviewState: "awaiting",
      }),
    ]);

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls", "plan"]);
    // custom message 三要素 + streaming steer options 断言（A6）
    expect(pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: PLAN_CONTEXT_CUSTOM_TYPE,
        content: expect.stringContaining("submit-review"),
        display: false,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    // E3 重挂即落盘（§3.4 降级两源：该处曾只发 steer 不落盘——不落盘则 renderer 冷启动
    // 扫描的 View 恒无 source、恒渲染通用文案）
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ isActive: true, reviewState: "awaiting", reviewStateSource: "resubmit" }),
    );
  });

  it("revising + no live select → steers the agent to continue the revision (P1-1：revising 崩溃恢复缺口)", async () => {
    const { handlers, pi } = setup();
    const ctx = makeCtx([
      planStateEntry({
        isActive: true,
        planFilePath: "/p/plan.md",
        requirement: "r",
        templateName: "",
        skills: ["tech-design"],
        docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 1 }],
        reviewState: "revising",
      }),
    ]);

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls", "plan"]);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: PLAN_CONTEXT_CUSTOM_TYPE,
        content: expect.stringContaining("revision"),
        display: false,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    // revising 恢复不落 source 标记（'resubmit' 只描述 awaiting 降级等待；revising 由
    // steer triggerTurn 立即开轮接续，恢复期间显示的 revising 是真实进行中）
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("stale controllers are cleared on session rebuild (禁复用已 abort 的 controller)", async () => {
    const { handlers } = setup();
    const ctx = makeCtx([]);
    // 同进程 reload 场景：注册表里残留旧 controller——hook 重建 session 时必须清掉
    // （残留的已 abort controller 禁止复用：发起新挂起 select 会 fresh 新建，此处是防御清理）
    captured.controllers!.set("test-session", new AbortController());

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    expect(captured.controllers!.has("test-session")).toBe(false);
  });

  it("active without awaiting (in progress) → no reminder", async () => {
    const { handlers, pi } = setup();
    const ctx = makeCtx([
      planStateEntry({
        isActive: true,
        planFilePath: "/p/plan.md",
        requirement: "r",
        templateName: "",
        skills: [],
        docs: [],
      }),
    ]);

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    expect(pi.setActiveTools).toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    // 非 awaiting 不落盘：E3 source 标记只在 awaiting 重挂分支写
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("inactive plan → no reminder, no tool restriction", async () => {
    const { handlers, pi } = setup();
    const ctx = makeCtx([]);

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("before_agent_start hook（D9：taiji 形态引导注入）", () => {
  const basePrompt = "You are a helpful coding agent.";

  it("no host signal (standalone pi) → undefined, prompt untouched", () => {
    const { handlers } = setup();
    const result = handlers.get("before_agent_start")!(
      { type: "before_agent_start", prompt: "hi", systemPrompt: basePrompt },
      makeCtx([]),
    );
    expect(result).toBeUndefined();
  });

  it("TAIJI_AGENT_EXT_LOG=1 → appends the plan-mode suggestion (not TAIJI_RUNTIME_TOKEN — 出站 deny list 剥除)", () => {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    const { handlers } = setup();
    const result = handlers.get("before_agent_start")!(
      { type: "before_agent_start", prompt: "hi", systemPrompt: basePrompt },
      makeCtx([]),
    ) as { systemPrompt?: string } | undefined;

    expect(result?.systemPrompt).toContain(basePrompt);
    // agent 自助进入引导在场（enter action + 无需确认）
    expect(result?.systemPrompt).toContain("plan(action='enter'");
    expect(result?.systemPrompt).toContain("Do not ask for permission to enter");
    // 旧的「建议 + 需确认」措辞已移除（enter 是 tool action，无需确认闸门）
    expect(result?.systemPrompt).not.toContain("Do NOT enter plan mode without the user's confirmation");
  });

  it("注入失败（systemPrompt 读取抛错）→ logger.warn 落盘 + 返回 undefined，不阻塞 agent loop（MF-1-8）", () => {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    const { handlers } = setup();
    const evilEvent = {
      type: "before_agent_start",
      get systemPrompt(): string {
        throw new Error("boom");
      },
    };

    const result = handlers.get("before_agent_start")!(evilEvent, makeCtx([]));

    // Never block the agent loop：吞错返回 undefined
    expect(result).toBeUndefined();
    // 日志走 extension-logger 文件通道（~/.pi/agent/logs/），不再 stderr 直写
    expect(loggerWarn).toHaveBeenCalledWith(
      "plan: before_agent_start injection failed",
      expect.objectContaining({ error: expect.stringContaining("boom") }),
    );
  });
});
