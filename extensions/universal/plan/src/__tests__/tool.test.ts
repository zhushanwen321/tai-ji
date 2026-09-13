import { beforeEach,describe, expect, it, vi } from "vitest";

// Mock typebox before importing tool
vi.mock("typebox", () => ({
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    String: (opts?: Record<string, unknown>) => ({ type: "string", ...opts }),
    Optional: (schema: unknown) => schema,
  },
  Static: class {},
}));

vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: (values: readonly string[]) => ({ type: "string", enum: [...values] }),
}));

// Mock compact.js (statically imported since 06-u1)
vi.mock("../compact.js", async () => {
  // GOAL_FAILURE_RECOVERY 与真实实现同文案——completeResultText 在 failure 断言里消费它
  const { GOAL_FAILURE_RECOVERY } = await vi.importActual<typeof import("../compact.js")>("../compact.js");
  return {
    handlePlanComplete: vi.fn(),
    detectGoalCapability: vi.fn(() => false),
    GOAL_FAILURE_RECOVERY,
  };
});

// Mock widget (imported by abort)
vi.mock("../widget.js", () => ({
  updatePlanWidget: vi.fn(),
}));

import { detectGoalCapability, handlePlanComplete } from "../compact.js";
import { PLAN_ACTIONS, registerPlanTool, validateAction } from "../tool.js";
import { updatePlanWidget } from "../widget.js";

/** Build a fake pi + ctx and capture the execute callback from registerTool. */
const ALL_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "plan", "write", "edit"];

function setup() {
  const sessions = new Map();
  let executeFn: (id: string, p: Record<string, unknown>, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<unknown>;
  const pi = {
    registerTool: vi.fn((tool) => { executeFn = tool.execute; }),
    appendEntry: vi.fn(),
    setActiveTools: vi.fn(),
    getAllTools: vi.fn(() => ALL_TOOL_NAMES.map((n) => ({ name: n }))),
  } as unknown as Parameters<typeof registerPlanTool>[0];
  registerPlanTool(pi, sessions);

  const ctx = {
    sessionId: "test-session",
    cwd: "/tmp/test-project",
    sessionManager: { getSessionId: () => "test-session", getEntries: () => [] },
    ui: { select: vi.fn(), notify: vi.fn() },
  };

  const exec = (params: Record<string, unknown>) => executeFn!("tc0", params, undefined, undefined, ctx);
  return { pi, sessions, ctx, exec };
}

describe("registerPlanTool", () => {
  it("registers a tool named 'plan'", () => {
    const { pi } = setup();
    expect(pi.registerTool).toHaveBeenCalledOnce();
    expect((pi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0].name).toBe("plan");
  });

  // --- list-template ---
  describe("list-template", () => {
    it("returns template list", async () => {
      const { exec } = setup();
      const res = await exec({ action: "list-template" });
      expect(res.content[0].type).toBe("text");
      expect(res.details.action).toBe("list-template");
      expect(Array.isArray(res.details.templates)).toBe(true);
    });

    it("returns exactly the 5 builtin templates with no source field (D3 / V4)", async () => {
      const { exec } = setup();
      const res = await exec({ action: "list-template" });
      const templates = res.details.templates as Array<{ name: string; source?: string; path: string }>;
      expect(templates.map((t) => t.name).sort()).toEqual(
        ["feature-plan", "bugfix-plan", "refactor-plan", "research-plan", "implementation-plan"].sort(),
      );
      for (const t of templates) {
        expect(t.source).toBeUndefined();
        expect(t).toEqual({ name: t.name, path: t.path });
      }
    });
  });

  // --- select-template ---
  describe("select-template", () => {
    it("throws when templateName is missing", async () => {
      const { exec } = setup();
      await expect(exec({ action: "select-template" })).rejects.toThrow("templateName is required");
    });

    it("throws when template does not exist", async () => {
      const { exec } = setup();
      await expect(exec({ action: "select-template", templateName: "nonexistent" })).rejects.toThrow("Template not found");
    });

    it("sets templateName and persists (D6：无 phase 写入)", async () => {
      const { exec, pi, sessions } = setup();
      // Use a builtin template name — find one first
      const listRes = await exec({ action: "list-template" });
      const templates = listRes.details.templates as { name: string }[];
      if (templates.length === 0) return; // no builtin templates available

      const name = templates[0].name;
      const res = await exec({ action: "select-template", templateName: name });
      expect(res.details.templateName).toBe(name);
      expect(res.details.action).toBe("select-template");
      expect(pi.appendEntry).toHaveBeenCalledWith("plan-state", expect.objectContaining({ templateName: name }));
      const state = sessions.get("test-session") as { templateName?: string; isActive?: boolean };
      expect(state?.templateName).toBe(name);
    });
  });

  // --- removed action (D3) ---
  describe("create-template removal", () => {
    it("rejects plan(action='create-template') as an unknown action (D3 / V4)", async () => {
      const { exec } = setup();
      await expect(
        exec({ action: "create-template", templateName: "my-plan", templateContent: "# hello" }),
      ).rejects.toThrow(
        "Unknown plan action: create-template. Valid actions: list-template, select-template, complete, abort",
      );
    });
  });

  // --- complete ---
  describe("complete", () => {
    beforeEach(() => {
      // 默认桥不可达（与真实 pi 0.84.4 现状一致）；goal 档用例显式 mock 桥可达
      (detectGoalCapability as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (handlePlanComplete as ReturnType<typeof vi.fn>).mockReset();
    });

    /** 注册时捕获的工具定义（schema 检查用）。 */
    function registeredTool(pi: { registerTool: unknown }): Record<string, unknown> {
      return ((pi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0]) as Record<string, unknown>;
    }

    it("rejects isolation='tree' at the schema level: enum is exactly compact|direct (D1 / V3①)", async () => {
      const { pi } = setup();
      const parameters = registeredTool(pi).parameters as {
        properties: { isolation: { enum: string[] } };
      };
      expect(parameters.properties.isolation.enum).toEqual(["compact", "direct"]);
      expect(parameters.properties.isolation.enum).not.toContain("tree");
    });

    it("does not advance when user cancels", async () => {
      const { exec, ctx, pi } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Modify the plan first");
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete-cancelled");
      expect(pi.setActiveTools).not.toHaveBeenCalled();
    });

    it("resets state and restores tools on execute", async () => {
      const { exec, ctx, pi } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Subagent-driven execution");
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete");
      expect(res.details.execMode).toBe("subagent");
      expect(pi.setActiveTools).toHaveBeenCalledWith(ALL_TOOL_NAMES);
      expect(handlePlanComplete).toHaveBeenCalled();
      expect(res.details.planFilePath).toBeDefined();
    });

    it("dialog options exclude the goal tier when the bridge is unavailable", async () => {
      const { exec, ctx } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Single-agent (current session)");
      await exec({ action: "complete" });
      const options = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
      expect(options).not.toContain("Goal-driven execution (/goal)");
      expect(options).toEqual([
        "Subagent-driven execution",
        "Single-agent (current session)",
        "Modify the plan first",
        "Save for later",
      ]);
    });

    it("dialog options include the goal tier when the bridge is reachable (mocked pi.__goalInit world)", async () => {
      const { exec, ctx } = setup();
      (detectGoalCapability as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Goal-driven execution (/goal)");
      const res = await exec({ action: "complete" });
      const options = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
      expect(options).toEqual([
        "Subagent-driven execution",
        "Goal-driven execution (/goal)",
        "Single-agent (current session)",
        "Modify the plan first",
        "Save for later",
      ]);
      expect(res.details.execMode).toBe("goal"); // EXEC_MODE_OPTIONS 查表映射（发现 8）
    });

    it("maps 'Single-agent (current session)' choice to execMode single-agent", async () => {
      const { exec, ctx } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Single-agent (current session)");
      const res = await exec({ action: "complete" });
      expect(res.details.execMode).toBe("single-agent");
    });

    it("direct tier carries the goal outcome into result content and details (D2)", async () => {
      const { exec, ctx } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Goal-driven execution (/goal)");
      (handlePlanComplete as ReturnType<typeof vi.fn>).mockReturnValue({ started: false, reason: "no-steps" });
      const res = await exec({ action: "complete", isolation: "direct" });
      expect(handlePlanComplete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "direct", "goal");
      expect(res.content[0].text).toContain("Goal execution was not started (no-steps)");
      expect(res.content[0].text).toContain("Implementation Steps"); // 恢复动作
      expect(res.details.goalOutcome).toEqual({ started: false, reason: "no-steps" });
    });

    it("successful goal outcome appends the started line", async () => {
      const { exec, ctx } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Goal-driven execution (/goal)");
      (handlePlanComplete as ReturnType<typeof vi.fn>).mockReturnValue({ started: true });
      const res = await exec({ action: "complete", isolation: "direct" });
      expect(res.content[0].text).toContain("Goal execution started via /goal");
      expect(res.details.goalOutcome).toEqual({ started: true });
    });

    it("compact tier outcome is deferred (undefined): result keeps the plain approved line", async () => {
      const { exec, ctx } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Subagent-driven execution");
      (handlePlanComplete as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      const res = await exec({ action: "complete", isolation: "compact" });
      expect(res.content[0].text).toMatch(/^Plan approved\. File: /);
      expect(res.content[0].text).not.toContain("Goal execution");
      expect(res.details.goalOutcome).toBeUndefined();
      expect(res.details.isolation).toBe("compact");
    });
  });

  // --- abort ---
  describe("abort", () => {
    it("resets state and cleans up session", async () => {
      const { exec, pi, sessions } = setup();
      // Pre-populate a session
      sessions.set("test-session", { isActive: true, planFilePath: "/tmp/plan.md", requirement: "test", templateName: "t" });
      const res = await exec({ action: "abort" });
      expect(res.details.action).toBe("abort");
      expect(pi.setActiveTools).toHaveBeenCalledWith(ALL_TOOL_NAMES);
      expect(sessions.has("test-session")).toBe(false);
      expect(updatePlanWidget).toHaveBeenCalled();
    });
  });
});

describe("validateAction", () => {
  it("accepts valid actions", () => {
    for (const a of PLAN_ACTIONS) expect(validateAction(a)).toBe(true);
  });
  it("rejects invalid", () => {
    expect(validateAction("bogus")).toBe(false);
  });
  it("action list no longer contains create-template (D3)", () => {
    expect(PLAN_ACTIONS).not.toContain("create-template");
  });
});
