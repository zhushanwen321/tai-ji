import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// index.ts 只做装配：mock 掉子模块注册函数，只捕获 pi.on 的 hook 与 planCtx 注册表
vi.mock("../tool.js", () => ({
  registerPlanTool: vi.fn(
    (_pi: unknown, planCtx: { controllers: Map<string, AbortController> }) => {
      captured.planCtx = planCtx;
    },
  ),
  PLAN_MODE_TOOLS: ["read", "bash", "grep", "find", "ls", "plan", "ask_user"],
  // E3 宿主分流（F-W3-1）依赖：与 tool.ts 实装同源的一行 env 读（受 vi.stubEnv 控制）
  isTaijiHost: () => process.env.TAIJI_AGENT_EXT_LOG === "1",
}));
vi.mock("../command.js", () => ({ registerPlanCommand: vi.fn() }));
vi.mock("../compact.js", () => ({ registerPlanEventHandlers: vi.fn() }));
vi.mock("../widget.js", () => ({ updatePlanWidget: vi.fn() }));

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import planExtension from "../index.js";
import { PLAN_CONTEXT_CUSTOM_TYPE } from "../state.js";

const captured: { planCtx?: { controllers: Map<string, AbortController> } } = {};

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

function makeCtx(entries: unknown[], mode?: string): ExtensionContext {
  return {
    mode,
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
  captured.planCtx = undefined;
  vi.stubEnv("TAIJI_AGENT_EXT_LOG", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session_start hook（E3：按 state 查表恢复）", () => {
  it("reviewing + no live select → steers the agent to re-call submit-review with 上轮 selfReview 全文（D9④）", async () => {
    const { handlers, pi } = setup();
    const ctx = makeCtx([
      planStateEntry({
        isActive: true,
        planFilePath: "/p/plan.md",
        requirement: "r",
        templateName: "",
        skills: ["tech-design"],
        docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 1 }],
        state: "reviewing",
        selfReview: "3 requirements covered; 2 assumptions verified.",
      }),
    ]);

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls", "plan", "ask_user"]);
    // custom message 三要素 + streaming steer options 断言（A6）
    expect(pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: PLAN_CONTEXT_CUSTOM_TYPE,
        content: expect.stringContaining("submit-review"),
        display: false,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    // D9④：steer 携带上轮 selfReview 全文 + 原样回传指令（豁免只在「自审内容」，过门义务不豁免）
    const steerContent = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].content as string;
    expect(steerContent).toContain("3 requirements covered; 2 assumptions verified.");
    expect(steerContent).toContain("VERBATIM");
    expect(steerContent).toContain("selfReview");
    // E3 重挂即落盘（§3.4 降级两源）：resumeHint='resubmit'（旧 reviewStateSource 语义取代）
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ isActive: true, state: "reviewing", resumeHint: "resubmit" }),
    );
  });

  it("旧 entry（reviewState='awaiting' 无 state 字段）经映射同样落 reviewing 重挂分支（D2 读方①）", async () => {
    const { handlers, pi } = setup();
    const ctx = makeCtx([
      planStateEntry({
        isActive: true,
        planFilePath: "/p/plan.md",
        requirement: "r",
        templateName: "",
        skills: [],
        docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "", version: 1 }],
        reviewState: "awaiting",
      }),
    ]);

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("submit-review") }),
      expect.anything(),
    );
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ state: "reviewing", resumeHint: "resubmit" }),
    );
  });

  it("taiji GUI 宿主（signal=1 + mode=rpc）reviewing → 不自动 steer 重挂（F-W3-1 审批条复活拦截），只落 resumeHint 交 degraded 按钮恢复", async () => {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    const { handlers, pi } = setup();
    const ctx = makeCtx(
      [
        planStateEntry({
          isActive: true,
          planFilePath: "/p/plan.md",
          requirement: "r",
          templateName: "",
          skills: [],
          docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "", version: 1 }],
          state: "reviewing",
          selfReview: "carried conclusions",
        }),
      ],
      "rpc",
    );

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    // 审批条不自动复活：E3 不得无人值守重提审批（steer triggerTurn = 自动重提通道）
    expect(pi.sendMessage).not.toHaveBeenCalled();
    // 工具集收拢照常（E3 的非交互恢复职责保留）
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls", "plan", "ask_user"]);
    // resumeHint 落盘：renderer degraded 分支（reviewing ∧ 无挂起）据此呈现
    // 「审批提问已随会话重启失效 + 重新提交审批」按钮——恢复触发权归用户
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ isActive: true, state: "reviewing", resumeHint: "resubmit" }),
    );
  });

  it("taiji 宿主 env 泄漏到非 rpc 形态（signal=1 + mode=tui）→ steer 照旧（与 executeSubmitReview 的 E8 分流对齐）", async () => {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    const { handlers, pi } = setup();
    const ctx = makeCtx(
      [
        planStateEntry({
          isActive: true,
          planFilePath: "/p/plan.md",
          requirement: "r",
          templateName: "",
          skills: [],
          docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "", version: 1 }],
          state: "reviewing",
        }),
      ],
      "tui",
    );

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("submit-review") }),
      { deliverAs: "steer", triggerTurn: true },
    );
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ state: "reviewing", resumeHint: "resubmit" }),
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
        state: "revising",
      }),
    ]);

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls", "plan", "ask_user"]);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: PLAN_CONTEXT_CUSTOM_TYPE,
        content: expect.stringContaining("revision"),
        display: false,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    // revising 恢复不落 resumeHint（'resubmit' 只描述 reviewing 降级等待；revising 由
    // steer triggerTurn 立即开轮接续，恢复期间显示的 revising 是真实进行中）
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("dispatching + no live select → review_aborted 边落 approved + steer 重调 complete（D5 E3 新支）", async () => {
    const { handlers, pi } = setup();
    const ctx = makeCtx([
      planStateEntry({
        isActive: true,
        planFilePath: "/p/plan.md",
        requirement: "r",
        templateName: "",
        skills: [],
        docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "", version: 1 }],
        state: "dispatching",
      }),
    ]);

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    // 崩溃消散的表单 = 无选择解散极端形态：dispatching --review_aborted--> approved 落盘
    //（批准事实保留，且使重调 complete 的 approve 边合法）
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ state: "approved", isActive: true }),
    );
    expect(pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: PLAN_CONTEXT_CUSTOM_TYPE,
        content: expect.stringContaining("plan(action='complete')"),
        display: false,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  it("stale controllers are cleared on session rebuild (禁复用已 abort 的 controller)", async () => {
    const { handlers } = setup();
    const ctx = makeCtx([]);
    // 同进程 reload 场景：注册表里残留旧 controller——hook 重建 session 时必须清掉
    // （残留的已 abort controller 禁止复用：发起新挂起 select 会 fresh 新建，此处是防御清理）
    captured.planCtx!.controllers.set("test-session", new AbortController());

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    expect(captured.planCtx!.controllers.has("test-session")).toBe(false);
  });

  it("active without pending review (in progress) → no reminder", async () => {
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
    // 非 reviewing/dispatching 不落盘：E3 resumeHint 只在 reviewing 重挂分支写
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("approved（later 后重开）不打扰：无 E3 重挂（S16「重开 session 无 E3 重挂打扰」）", async () => {
    const { handlers, pi } = setup();
    const ctx = makeCtx([
      planStateEntry({
        isActive: true,
        planFilePath: "/p/plan.md",
        requirement: "r",
        templateName: "",
        skills: [],
        docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "", version: 1 }],
        state: "approved",
      }),
    ]);

    await handlers.get("session_start")!({ type: "session_start" }, ctx);

    expect(pi.setActiveTools).toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
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

describe("进入引导单源（systemPrompt 注入面已收敛到 tool promptSnippet）", () => {
  it("before_agent_start 钩子不注册：taiji 宿主注入面与 tool 描述面不再同时含进入引导（C1 行为变更组锚）", () => {
    const { handlers } = setup();
    expect(handlers.has("before_agent_start")).toBe(false);
  });
});
