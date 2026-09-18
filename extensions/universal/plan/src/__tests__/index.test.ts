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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import planExtension from "../index.js";

const captured: { controllers?: Map<string, AbortController> } = {};

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function setup() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
    sendUserMessage: vi.fn(),
    setActiveTools: vi.fn(),
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
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("submit-review"), { deliverAs: "steer" });
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
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("inactive plan → no reminder, no tool restriction", async () => {
    const { handlers, pi } = setup();
    const ctx = makeCtx([]);

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
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
    expect(result?.systemPrompt).toContain("/plan");
    expect(result?.systemPrompt).toContain("--skills");
    // 未经确认不自行进入的约束在场
    expect(result?.systemPrompt).toContain("Do NOT enter plan mode without the user's confirmation");
  });
});
