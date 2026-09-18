import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock("../widget.js", () => ({
  updatePlanWidget: vi.fn(),
}));

import * as fs from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerPlanCommand } from "../command.js";

const ALL_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "plan", "write", "edit"];

function createMocks() {
  let capturedHandler: (args: string, ctx: ExtensionContext) => Promise<void>;
  const controllers = new Map<string, AbortController>();

  const pi = {
    registerCommand: vi.fn((_name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      capturedHandler = def.handler;
    }),
    appendEntry: vi.fn(),
    setActiveTools: vi.fn(),
    sendUserMessage: vi.fn(),
    getCommands: vi.fn(() => []),
    getAllTools: vi.fn(() => ALL_TOOL_NAMES.map((n) => ({ name: n }))),
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: "/tmp/test-project",
    sessionManager: {
      getSessionId: () => "test-session",
      getEntries: () => [] as unknown[],
    },
    ui: {
      notify: vi.fn(),
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_t: string, text: string) => text },
    },
  } as unknown as ExtensionContext;

  return {
    pi,
    ctx,
    controllers,
    getHandler: () => capturedHandler!,
  };
}

describe("registerPlanCommand", () => {
  let pi: ExtensionAPI;
  let ctx: ExtensionContext;
  let handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  let controllers: Map<string, AbortController>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mocks = createMocks();
    pi = mocks.pi;
    ctx = mocks.ctx;
    controllers = mocks.controllers;
    const sessions = new Map();
    registerPlanCommand(pi, sessions, controllers);
    handler = mocks.getHandler();
  });

  it("registers 'plan' command", () => {
    expect(pi.registerCommand).toHaveBeenCalledWith("plan", expect.objectContaining({ handler: expect.any(Function) }));
  });

  // --- abort subcommand ---

  it("abort: notifies 'No active plan mode' when idle", async () => {
    await handler("abort", ctx);
    expect((ctx as ReturnType<typeof createMocks>["ctx"]).ui.notify).toHaveBeenCalledWith("No active plan mode.", "info");
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("abort: resets state and restores tools when active", async () => {
    // Enter plan mode first — handler uses the sessions map from registerPlanCommand closure
    await handler("implement user auth", ctx);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls", "plan"]);
    vi.clearAllMocks();

    // Now abort — state is active in the sessions map
    await handler("abort", ctx);

    expect(pi.setActiveTools).toHaveBeenCalledWith(ALL_TOOL_NAMES);
    expect((ctx as ReturnType<typeof createMocks>["ctx"]).ui.notify).toHaveBeenCalledWith("Plan mode aborted.", "info");
  });

  it("abort 联动（E10）：controller.abort() 先于 resetPlanState 的 entry 落盘", async () => {
    await handler("implement user auth", ctx);
    vi.clearAllMocks();

    // 模拟一个挂起 select 的 controller（submit-review / complete 执行方式两处共用注册表）
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, "abort");
    controllers.set("test-session", controller);

    await handler("abort", ctx);

    // 挂起 select 被 abort（→ resolve undefined → tool execute 已取消分支 → turn 结束 → settled → busy defer 恢复）
    expect(controller.signal.aborted).toBe(true);
    // 顺序断言：abort 必须先于 reset entry 落盘（反序 = 挂起 select 无人 resolve → session 卡死）
    const resetCallIndex = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.findIndex(
      (c) => (c[1] as { isActive?: boolean }).isActive === false,
    );
    expect(resetCallIndex).toBeGreaterThanOrEqual(0);
    expect(abortSpy.mock.invocationCallOrder[0]).toBeLessThan(
      (pi.appendEntry as ReturnType<typeof vi.fn>).mock.invocationCallOrder[resetCallIndex],
    );
    // 注册表条目已清理
    expect(controllers.has("test-session")).toBe(false);
  });

  // --- status subcommand ---

  it("status: notifies 'No active plan mode' when idle", async () => {
    await handler("status", ctx);
    expect((ctx as ReturnType<typeof createMocks>["ctx"]).ui.notify).toHaveBeenCalledWith("No active plan mode.", "info");
  });

  // --- already active + new args ---

  it("warns when already active and args provided", async () => {
    // First enter plan mode
    await handler("my feature", ctx);
    vi.clearAllMocks();

    // Try to enter again with different args
    await handler("another feature", ctx);
    expect((ctx as ReturnType<typeof createMocks>["ctx"]).ui.notify).toHaveBeenCalledWith(
      "Plan mode is already active. Use /plan abort to cancel first.",
      "warning",
    );
  });

  // --- enter plan mode ---

  it("enters plan mode with slugified path", async () => {
    await handler("Implement User Auth", ctx);

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/tmp/test-project/.taiji-harness/implement-user-auth",
      { recursive: true },
    );
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls", "plan"]);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("[PLAN MODE]"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Implement User Auth"));
    expect(pi.appendEntry).toHaveBeenCalledWith("plan-state", {
      isActive: true,
      planFilePath: "/tmp/test-project/.taiji-harness/implement-user-auth/plan.md",
      requirement: "Implement User Auth",
      templateName: "",
      skills: [],
      docs: [],
      reviewState: undefined,
    });
  });

  it("handles special characters in requirement for slug", async () => {
    await handler("Fix bug #123: 中文标题!", ctx);

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("/.taiji-harness/fix-bug-123"),
      { recursive: true },
    );
  });

  it("uses 'untitled' slug when no args", async () => {
    // No existing plans (readdirSync returns [])
    await handler("", ctx);

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/tmp/test-project/.taiji-harness/untitled",
      { recursive: true },
    );
  });

  it("shows status when active with no args", async () => {
    await handler("my feature", ctx);
    vi.clearAllMocks();

    await handler("", ctx);
    // D6：phase 删除后 status 显示 plan 文件与模板，无档位行
    expect((ctx as ReturnType<typeof createMocks>["ctx"]).ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("my-feature/plan.md"),
      "info",
    );
    expect((ctx as ReturnType<typeof createMocks>["ctx"]).ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Template: (not selected)"),
      "info",
    );
  });
});
