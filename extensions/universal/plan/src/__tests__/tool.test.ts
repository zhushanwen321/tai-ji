import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Mock exec-skills（D10 检测）：单测里不扫真实目录（~/.agents/skills 等本机路径），
// skill 选项用例显式注入 fixture；专用 exec-skills.test.ts 覆盖真实扫描
vi.mock("../exec-skills.js", () => ({
  detectExecSkills: vi.fn(() => []),
}));

// Mock widget (imported by abort)
vi.mock("../widget.js", () => ({
  updatePlanWidget: vi.fn(),
}));

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UI_FORM_MARKER } from "@zhushanwen/extension-protocol";

import { detectGoalCapability, handlePlanComplete } from "../compact.js";
import { detectExecSkills } from "../exec-skills.js";
import { DEFAULT_PLAN_STATE } from "../state.js";
import { loadTemplate } from "../templates.js";
import { PLAN_ACTIONS, registerPlanTool, validateAction } from "../tool.js";
import { updatePlanWidget } from "../widget.js";

/** Build a fake pi + ctx and capture the execute callback from registerTool. */
const ALL_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "plan", "write", "edit"];

function setup() {
  const sessions = new Map();
  const controllers = new Map<string, AbortController>();
  let executeFn: (id: string, p: Record<string, unknown>, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<unknown>;
  const pi = {
    registerTool: vi.fn((tool) => { executeFn = tool.execute; }),
    appendEntry: vi.fn(),
    setActiveTools: vi.fn(),
    getAllTools: vi.fn(() => ALL_TOOL_NAMES.map((n) => ({ name: n }))),
  } as unknown as Parameters<typeof registerPlanTool>[0];
  registerPlanTool(pi, sessions, controllers);

  const ctx = {
    sessionId: "test-session",
    cwd: "/tmp/test-project",
    // D4 三路分流的 ctx 形态字段：默认 TUI（原生 select 路径），GUI 用例覆写 mode
    hasUI: true,
    mode: "tui" as const,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "test-session", getEntries: () => [] },
    ui: { select: vi.fn(), notify: vi.fn() },
  };

  const exec = (params: Record<string, unknown>) => executeFn!("tc0", params, undefined, undefined, ctx);
  return { pi, sessions, controllers, ctx, exec };
}

describe("registerPlanTool", () => {
  it("registers a tool named 'plan'", () => {
    const { pi } = setup();
    expect(pi.registerTool).toHaveBeenCalledOnce();
    expect((pi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0].name).toBe("plan");
  });

  it("tool description and promptSnippet no longer mention list-template (D1 删链不留兼容通道)", () => {
    const { pi } = setup();
    const tool = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      description: string;
      promptSnippet: string;
    };
    expect(tool.description).not.toContain("list-template");
    expect(tool.promptSnippet).not.toContain("list-template");
  });

  // --- select-template ---
  describe("select-template", () => {
    it("throws when templateName is missing", async () => {
      const { exec } = setup();
      await expect(exec({ action: "select-template" })).rejects.toThrow("templateName is required");
    });

    it("throws when template does not exist — error carries the available name list (D7 自愈闭环)", async () => {
      const { exec } = setup();
      // 内置 5 名恒在清单（外部源只增名不删内置名），断言清单形态而非全集
      await expect(exec({ action: "select-template", templateName: "nonexistent" })).rejects.toThrow(
        /Template not found: nonexistent\. Available: .*feature-plan/,
      );
    });

    it("sets templateName and persists (D6：无 phase 写入)", async () => {
      const { exec, pi, sessions } = setup();
      // 内置模板名直接断言（templates.test.ts 覆盖清单内容，这里只测选中与持久化）
      const name = "feature-plan";
      const res = await exec({ action: "select-template", templateName: name });
      expect(res.details.templateName).toBe(name);
      expect(res.details.action).toBe("select-template");
      expect(pi.appendEntry).toHaveBeenCalledWith("plan-state", expect.objectContaining({ templateName: name }));
      const state = sessions.get("test-session") as { templateName?: string; isActive?: boolean };
      expect(state?.templateName).toBe(name);
    });

    it("content carries the winner file's full text and details has no content field (D7 全文通道唯一化)", async () => {
      const { exec } = setup();
      const res = await exec({ action: "select-template", templateName: "feature-plan" });
      const text = res.content[0].text;
      // 全文到达模型可见通道（对照 loadTemplate 的胜者内容，运行机用户级遮蔽时同样成立）
      const winnerContent = loadTemplate("feature-plan");
      expect(winnerContent).not.toBeNull();
      expect(text).toContain(`<template>\n${winnerContent}\n</template>`);
      // details 收窄：仅 action + templateName，全文不再双份持久化
      expect(res.details).toEqual({ action: "select-template", templateName: "feature-plan" });
    });

    it("resolves from the merged view: project-level .agents/plans template is selectable (D7 合并视图)", async () => {
      // tmp 自建项目根 + 项目级模板（fs-guard 红线：写删目标 mkdtempSync 自建自删）
      const projectRoot = fs.mkdtempSync(join(tmpdir(), "plan-tool-v2b-"));
      const projectTemplateDir = join(projectRoot, ".agents", "plans");
      fs.mkdirSync(projectTemplateDir, { recursive: true });
      fs.writeFileSync(join(projectTemplateDir, "v2b-project-only.md"), "# project-owned skeleton\n");
      try {
        const { exec, ctx } = setup();
        ctx.cwd = projectRoot;
        const res = await exec({ action: "select-template", templateName: "v2b-project-only" });
        expect(res.content[0].text).toContain("# project-owned skeleton");
        expect(res.details).toEqual({ action: "select-template", templateName: "v2b-project-only" });
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    });

    it("--template 直传防御：报错指向已注入全文，不带三源清单 (D7)", async () => {
      const { exec, pi, sessions } = setup();
      sessions.set("test-session", {
        ...DEFAULT_PLAN_STATE,
        isActive: true,
        planFilePath: "/tmp/test-project/.taiji-harness/retro/plan.md",
        requirement: "retro",
        templateName: "retro-template",
        templateProvidedPath: "/tmp/test-project/docs/retro-template.md",
      });
      const error = await exec({ action: "select-template", templateName: "retro-template" }).then(
        () => new Error("expected rejection"),
        (e: Error) => e,
      );
      expect(error.message).toContain("template was provided via --template");
      // 不带三源清单：直传文件不在清单里，清单会误导模型改选内置模板
      expect(error.message).not.toContain("Available:");
      // 防御分支不产生任何状态写入（throw 先于 persistPlanState）
      expect(pi.appendEntry).not.toHaveBeenCalled();
    });
  });

  // --- removed actions (D1 / D3) ---
  describe("removed action rejections", () => {
    it("rejects plan(action='list-template') as an unknown action with the 5-action list (D1)", async () => {
      const { exec } = setup();
      await expect(exec({ action: "list-template" })).rejects.toThrow(
        "Unknown plan action: list-template. Valid actions: select-template, complete, abort, register-doc, submit-review",
      );
    });

    it("rejects plan(action='create-template') as an unknown action (D3 / V4)", async () => {
      const { exec } = setup();
      await expect(
        exec({ action: "create-template", templateName: "my-plan", templateContent: "# hello" }),
      ).rejects.toThrow(
        "Unknown plan action: create-template. Valid actions: select-template, complete, abort, register-doc, submit-review",
      );
    });
  });

  // --- complete ---
  describe("complete", () => {
    beforeEach(() => {
      // 默认桥不可达（与真实 pi 0.84.4 现状一致）；goal 档用例显式 mock 桥可达
      (detectGoalCapability as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (handlePlanComplete as ReturnType<typeof vi.fn>).mockReset();
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReset();
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([]);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
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
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Develop (auto-parallel)");
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete");
      expect(res.details.execMode).toBe("develop");
      expect(pi.setActiveTools).toHaveBeenCalledWith(ALL_TOOL_NAMES);
      expect(handlePlanComplete).toHaveBeenCalled();
      expect(res.details.planFilePath).toBeDefined();
    });

    it("dialog options exclude the goal tier when the bridge is unavailable", async () => {
      const { exec, ctx } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Develop (auto-parallel)");
      await exec({ action: "complete" });
      const options = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
      expect(options).not.toContain("Goal-driven execution (/goal)");
      expect(options).toEqual([
        "Develop (auto-parallel)",
        "Modify the plan first",
        "Save for later",
      ]);
    });

    it("dialog options include the goal tier when the bridge is reachable (mocked goalInit slot world)", async () => {
      const { exec, ctx } = setup();
      (detectGoalCapability as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Goal-driven execution (/goal)");
      const res = await exec({ action: "complete" });
      const options = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
      expect(options).toEqual([
        "Develop (auto-parallel)",
        "Goal-driven execution (/goal)",
        "Modify the plan first",
        "Save for later",
      ]);
      expect(res.details.execMode).toBe("goal"); // 选项集构造携带的 label→mode 映射（D10）
    });

    it("maps the Develop choice to execMode develop (subagent/single-agent 收口，D10)", async () => {
      const { exec, ctx } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Develop (auto-parallel)");
      const res = await exec({ action: "complete" });
      expect(res.details.execMode).toBe("develop");
      expect(handlePlanComplete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "direct", "develop", undefined);
    });

    it("headless (!hasUI) defaults to develop without any select (D4 三路分流第 1 路)", async () => {
      const { exec, ctx, pi } = setup();
      ctx.hasUI = false;
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete");
      expect(res.details.execMode).toBe("develop");
      expect(ctx.ui.select).not.toHaveBeenCalled(); // 不进任何 select（noOp 软门修复）
      expect(detectExecSkills).not.toHaveBeenCalled(); // 选择已预定，跳过 skill 扫描
      expect(pi.setActiveTools).toHaveBeenCalledWith(ALL_TOOL_NAMES);
      expect(handlePlanComplete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "direct", "develop", undefined);
    });

    it("detected plan-exec skill appears as an option and its choice maps to skill:<name> with skillDir (D10)", async () => {
      const { exec, ctx } = setup();
      const skillEntryPath = "/tmp/fixtures/skills/dev-flow/SKILL.md";
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "dev-flow", description: "Deliver a plan via dev-flow.", skillDir: skillEntryPath, skillPath: skillEntryPath },
      ]);
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Execute via skill: dev-flow");
      const res = await exec({ action: "complete" });

      const options = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
      expect(options).toEqual([
        "Develop (auto-parallel)",
        "Execute via skill: dev-flow",
        "Modify the plan first",
        "Save for later",
      ]);
      expect(res.details.action).toBe("complete");
      expect(res.details.execMode).toBe("skill:dev-flow");
      // skillDir 数据通路：CompleteChoiceOutcome → handlePlanComplete（steer 文案的路径来源）
      expect(handlePlanComplete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "direct", "skill:dev-flow", skillEntryPath);
    });

    it("empty detection set leaves no skill options (空集不误伤选项集)", async () => {
      const { exec, ctx } = setup();
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Develop (auto-parallel)");
      await exec({ action: "complete" });
      const options = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
      expect(options.some((label) => label.startsWith("Execute via skill:"))).toBe(false);
    });

    it("direct tier carries the goal outcome into result content and details (D2)", async () => {
      const { exec, ctx } = setup();
      (detectGoalCapability as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Goal-driven execution (/goal)");
      (handlePlanComplete as ReturnType<typeof vi.fn>).mockReturnValue({ started: false, reason: "no-steps" });
      const res = await exec({ action: "complete", isolation: "direct" });
      expect(handlePlanComplete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "direct", "goal", undefined);
      expect(res.content[0].text).toContain("Goal execution was not started (no-steps)");
      expect(res.content[0].text).toContain("Implementation Steps"); // 恢复动作
      expect(res.details.goalOutcome).toEqual({ started: false, reason: "no-steps" });
    });

    it("successful goal outcome appends the started line", async () => {
      const { exec, ctx } = setup();
      (detectGoalCapability as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Goal-driven execution (/goal)");
      (handlePlanComplete as ReturnType<typeof vi.fn>).mockReturnValue({ started: true });
      const res = await exec({ action: "complete", isolation: "direct" });
      expect(res.content[0].text).toContain("Goal execution started via /goal");
      expect(res.details.goalOutcome).toEqual({ started: true });
    });

    it("compact tier outcome is deferred (undefined): result keeps the plain approved line", async () => {
      const { exec, ctx } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Develop (auto-parallel)");
      (handlePlanComplete as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      const res = await exec({ action: "complete", isolation: "compact" });
      expect(res.content[0].text).toMatch(/^Plan approved\. File: /);
      expect(res.content[0].text).not.toContain("Goal execution");
      expect(res.details.goalOutcome).toBeUndefined();
      expect(res.details.isolation).toBe("compact");
    });
  });

  // --- complete · GUI 路径（taiji rpc 宿主 → uiFormInteract，D4 第 2 路）---
  describe("complete via taiji form channel", () => {
    beforeEach(() => {
      vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
      (detectGoalCapability as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (handlePlanComplete as ReturnType<typeof vi.fn>).mockReset();
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReset();
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([]);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    function setupGui() {
      const harness = setup();
      (harness.ctx as { mode?: string }).mode = "rpc";
      return harness;
    }

    /** form 帧断言辅助：单 choice 问题的 options label 清单 */
    function formOptionLabels(selectMock: ReturnType<typeof vi.fn>): Array<{ label: string; description?: string }> {
      const payload = JSON.parse(selectMock.mock.calls[0][1][0] as string) as {
        formQuestions: Array<{ options: Array<{ label: string; description?: string }> }>;
      };
      return payload.formQuestions[0].options;
    }

    it("sends a single choice question via UI_FORM_MARKER and maps the develop answer (无 tab 条单视图)", async () => {
      const { exec, ctx } = setupGui();
      (ctx.ui.select as ReturnType<typeof vi.fn>)
        .mockResolvedValue(JSON.stringify({ "Execution method": "Develop (auto-parallel)" }));
      const res = await exec({ action: "complete" });

      const title = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(title).toBe(UI_FORM_MARKER);
      const labels = formOptionLabels(ctx.ui.select as ReturnType<typeof vi.fn>).map((o) => o.label);
      expect(labels).toEqual([
        "Develop (auto-parallel)",
        "Modify the plan first",
        "Save for later",
      ]);
      expect(res.details.action).toBe("complete");
      expect(res.details.execMode).toBe("develop");
    });

    it("skill option carries its description into the form and maps to skill:<name>", async () => {
      const { exec, ctx } = setupGui();
      const skillEntryPath = "/tmp/fixtures/skills/dev-flow/SKILL.md";
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "dev-flow", description: "Deliver a plan via dev-flow.", skillDir: skillEntryPath, skillPath: skillEntryPath },
      ]);
      (ctx.ui.select as ReturnType<typeof vi.fn>)
        .mockResolvedValue(JSON.stringify({ "Execution method": "Execute via skill: dev-flow" }));
      const res = await exec({ action: "complete" });

      const options = formOptionLabels(ctx.ui.select as ReturnType<typeof vi.fn>);
      const skillOption = options.find((o) => o.label === "Execute via skill: dev-flow");
      expect(skillOption?.description).toBe("Deliver a plan via dev-flow.");
      expect(res.details.execMode).toBe("skill:dev-flow");
      expect(handlePlanComplete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "direct", "skill:dev-flow", skillEntryPath);
    });

    it("timeout via undefined resolve (signal not aborted) folds to complete-cancelled staying in plan mode (D4 四态折叠)", async () => {
      // rpc 模式 GUI 用户取消 resolve undefined，与超时不可区分（signal 未 abort 折叠
      // timeout，库层 callMarkerRpc 判别），消费层 cancelled‖timeout 同折后 reason='cancelled'
      const { exec, ctx, pi } = setupGui();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete-cancelled");
      expect(res.details.reason).toBe("cancelled");
      expect(res.content[0].text).toContain("Staying in plan mode");
      expect(pi.setActiveTools).not.toHaveBeenCalled();
    });

    it("cancelled (abort via controllers registry during pending select) folds to complete-cancelled (D4 四态折叠)", async () => {
      // 真实通道注入（command.ts handleAbort 同款 `controllers.get(sessionId)?.abort()`）：
      // 挂起窗口内 session abort → pi 实装 resolve undefined → 库层以 signal.aborted 判
      // reason='cancelled'（区别于上一例的 timeout 折叠源）
      const { exec, ctx, controllers, pi } = setupGui();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        controllers.get("test-session")?.abort();
        return undefined;
      });
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete-cancelled");
      expect(res.details.reason).toBe("cancelled");
      expect(res.content[0].text).toContain("Staying in plan mode");
      expect(pi.setActiveTools).not.toHaveBeenCalled();
    });

    it("channel-error (echo payload) folds to complete-cancelled with channel note, no throw (D4 四态折叠)", async () => {
      const { exec, ctx, pi } = setupGui();
      // echo 检测：宿主不识别 UI_FORM_MARKER 时 band 单选项 = payload 自身，点选即回显
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async (_t: string, options: string[]) => options[0]);
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete-cancelled");
      expect(res.details.reason).toBe("channel-error");
      expect(res.content[0].text).toContain("Interaction channel failed");
      expect(res.content[0].text).toContain("upgrade taiji"); // echo 升级指引透出
      expect(pi.setActiveTools).not.toHaveBeenCalled();
    });

    it("non-json response folds to complete-cancelled with channel note, no throw (D4 四态折叠)", async () => {
      const { exec, ctx } = setupGui();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("not-json");
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete-cancelled");
      expect(res.details.reason).toBe("non-json");
      expect(res.content[0].text).toContain("Interaction channel failed");
    });
  });

  // --- abort ---
  describe("abort", () => {
    it("resets state and cleans up session", async () => {
      const { exec, pi, sessions } = setup();
      // Pre-populate a session（工具层 abort 走 resetPlanState——命令层 abort 联动的顺序断言在 command.test.ts）
      sessions.set("test-session", {
        ...DEFAULT_PLAN_STATE,
        isActive: true,
        planFilePath: "/tmp/plan.md",
        requirement: "test",
        templateName: "t",
        skills: ["tech-design"],
        docs: [{ fileName: "design.md", absPath: "/tmp/design.md", sourceSkill: "tech-design", version: 1 }],
        reviewState: "awaiting",
      });
      const res = await exec({ action: "abort" });
      expect(res.details.action).toBe("abort");
      expect(pi.setActiveTools).toHaveBeenCalledWith(ALL_TOOL_NAMES);
      expect(sessions.has("test-session")).toBe(false);
      expect(updatePlanWidget).toHaveBeenCalled();
      // 终态矩阵：reset entry 落 isActive=false + skills/reviewState 清空 + docs 保留
      expect(pi.appendEntry).toHaveBeenCalledWith("plan-state", expect.objectContaining({ isActive: false }));
      const entry = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(entry.docs).toHaveLength(1);
      expect(entry.skills).toEqual([]);
      expect(entry.reviewState).toBeUndefined();
    });
  });
});

describe("validateAction", () => {
  it("accepts valid actions", () => {
    for (const a of PLAN_ACTIONS) expect(validateAction(a)).toBe(true);
  });
  it("rejects invalid", () => {
    expect(validateAction("bogus")).toBe(false);
    expect(validateAction("list-template")).toBe(false);
  });
  it("action list contains exactly the five actions (list-template removed, D1)", () => {
    expect([...PLAN_ACTIONS].sort()).toEqual(
      ["abort", "complete", "register-doc", "select-template", "submit-review"],
    );
    expect(PLAN_ACTIONS).not.toContain("create-template");
    expect(PLAN_ACTIONS).not.toContain("list-template");
  });
});
