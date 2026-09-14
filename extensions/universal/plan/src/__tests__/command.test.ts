import { beforeEach,describe, expect, it, vi } from "vitest";

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

  const pi = {
    registerCommand: vi.fn((_name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      capturedHandler = def.handler;
    }),
    appendEntry: vi.fn(),
    setActiveTools: vi.fn(),
    sendUserMessage: vi.fn(),
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
    getHandler: () => capturedHandler!,
  };
}

describe("registerPlanCommand", () => {
  let pi: ExtensionAPI;
  let ctx: ExtensionContext;
  let handler: (args: string, ctx: ExtensionContext) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mocks = createMocks();
    pi = mocks.pi;
    ctx = mocks.ctx;
    const sessions = new Map();
    registerPlanCommand(pi, sessions);
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
      "/tmp/test-project/.xyz-harness/implement-user-auth",
      { recursive: true },
    );
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls", "plan"]);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("[PLAN MODE]"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Implement User Auth"));
    expect(pi.appendEntry).toHaveBeenCalledWith("plan-state", {
      isActive: true,
      planFilePath: "/tmp/test-project/.xyz-harness/implement-user-auth/plan.md",
      requirement: "Implement User Auth",
      templateName: "",
    });
  });

  it("handles special characters in requirement for slug", async () => {
    await handler("Fix bug #123: 中文标题!", ctx);

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("/.xyz-harness/fix-bug-123"),
      { recursive: true },
    );
  });

  it("uses 'untitled' slug when no args", async () => {
    // No existing plans (readdirSync returns [])
    await handler("", ctx);

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/tmp/test-project/.xyz-harness/untitled",
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
