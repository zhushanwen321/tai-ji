import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock typebox before importing tool
vi.mock("typebox", () => ({
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    String: (opts?: Record<string, unknown>) => ({ type: "string", ...opts }),
    Optional: (schema: unknown) => schema,
    Array: (item: unknown, opts?: Record<string, unknown>) => ({ type: "array", items: item, ...opts }),
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
    GOAL_FAILURE_RECOVERY,
  };
});

// Mock 执行方式检测（D10）：单测里不扫真实目录（~/.agents/skills 等本机路径），
// skill 选项用例显式注入 fixture；专用 exec-skills.test.ts 覆盖真实扫描。
// importActual 展开：只覆写 detectExecSkills，其余导出（含 enter.ts re-export 的
// resolveSkills 执行门禁）走真实现——mock 罩全模块会把它一并变 undefined
vi.mock("@zhushanwen/pi-exec-skills", async () => {
  const actual = await vi.importActual<typeof import("@zhushanwen/pi-exec-skills")>(
    "@zhushanwen/pi-exec-skills",
  );
  return { ...actual, detectExecSkills: vi.fn(() => []) };
});

// Mock widget (imported by abort)
vi.mock("../widget.js", () => ({
  updatePlanWidget: vi.fn(),
}));

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { UI_FORM_MARKER } from "@zhushanwen/extension-protocol";
import { detectExecSkills } from "@zhushanwen/pi-exec-skills";

import { handlePlanComplete } from "../compact.js";
import { createPlanCtx, DEFAULT_PLAN_STATE } from "../state.js";
import { loadTemplate } from "../templates.js";
import { PLAN_ACTIONS, registerPlanTool, validateAction } from "../tool.js";
import { updatePlanWidget } from "../widget.js";

/** Build a fake pi + ctx and capture the execute callback from registerTool. */
const ALL_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "plan", "write", "edit"];

function setup() {
  // 单 ctx 对象（D-B4-3）：sessions/controllers 别名 = planCtx 两表（同对象），用例断言不变
  const planCtx = createPlanCtx();
  let executeFn: (id: string, p: Record<string, unknown>, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<unknown>;
  const pi = {
    registerTool: vi.fn((tool) => { executeFn = tool.execute; }),
    appendEntry: vi.fn(),
    setActiveTools: vi.fn(),
    getAllTools: vi.fn(() => ALL_TOOL_NAMES.map((n) => ({ name: n }))),
  } as unknown as Parameters<typeof registerPlanTool>[0];
  registerPlanTool(pi, planCtx);

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

  // 默认前置：已批准态（approved --approve--> dispatching 重选执行方式，consumers.md §三B）——
  // complete 的审批闸口（D1 边表）要求先过 review 流程；用例可在返回后覆写 sessions
  planCtx.states.set("test-session", {
    ...DEFAULT_PLAN_STATE,
    isActive: true,
    planFilePath: "/tmp/test-project/.tmp/plans/auth/plan.md",
    requirement: "refactor auth",
    state: "approved",
    docs: [{ fileName: "design.md", absPath: "/tmp/test-project/.tmp/plans/auth/design.md", sourceSkill: "", version: 1 }],
  });

  const exec = (params: Record<string, unknown>, signal?: AbortSignal) =>
    executeFn!("tc0", params, signal, undefined, ctx);
  return { pi, planCtx, sessions: planCtx.states, controllers: planCtx.controllers, ctx, exec };
}

describe("registerPlanTool", () => {
  it("registers a tool named 'plan'", () => {
    const { pi } = setup();
    expect(pi.registerTool).toHaveBeenCalledOnce();
    expect((pi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0].name).toBe("plan");
  });

  it("declares executionMode 'sequential'（D-B1-4：action 就地突变共享 PlanState，串行声明消除同批并行交错）", () => {
    const { pi } = setup();
    const tool = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0] as { executionMode?: string };
    expect(tool.executionMode).toBe("sequential");
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
        planFilePath: "/tmp/test-project/.tmp/plans/retro/plan.md",
        requirement: "retro",
        templateName: "retro-template",
        templateProvided: true,
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
    it("rejects plan(action='list-template') as an unknown action with the 6-action list (D1)", async () => {
      const { exec } = setup();
      await expect(exec({ action: "list-template" })).rejects.toThrow(
        "Unknown plan action: list-template. Valid actions: enter, select-template, complete, abort, register-doc, submit-review",
      );
    });

    it("rejects plan(action='create-template') as an unknown action (D3 / V4)", async () => {
      const { exec } = setup();
      await expect(
        exec({ action: "create-template", templateName: "my-plan", templateContent: "# hello" }),
      ).rejects.toThrow(
        "Unknown plan action: create-template. Valid actions: enter, select-template, complete, abort, register-doc, submit-review",
      );
    });
  });

  // --- renderResult 兜底（MF-1-7 旧持久化 details 形态）---
  describe("renderResult fallback for legacy details forms", () => {
    /** mock theme：renderPlanResult 只消费 fg，直通便于断言纯文本 */
    const renderTheme = {
      fg: (_token: string, text: string) => text,
    } as unknown as Theme;

    /** 注册时捕获的 renderResult（真实签名 (result, options, theme)） */
    function renderFn(pi: { registerTool: unknown }): (
      result: { content: Array<{ type: string; text?: string }>; details?: unknown },
      options: unknown,
      theme: Theme,
    ) => { render: (width: number) => string[] } {
      const tool = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        renderResult: (
          result: { content: Array<{ type: string; text?: string }>; details?: unknown },
          options: unknown,
          theme: Theme,
        ) => { render: (width: number) => string[] };
      };
      return tool.renderResult;
    }

    it("旧 action=list-template details（已删 action 的历史 entry）渲染不抛、回落 content 文本", () => {
      const { pi } = setup();
      const render = renderFn(pi);
      // git 2ab33c46c 旧版形态：details.action="list-template" 不在现版 PlanDetails 联合内。
      // 修复前 switch 落空返回 undefined → pi TUI 渲染循环对 undefined 调 .render() TypeError
      const result = {
        content: [{ type: "text", text: "Available templates: feature-plan, bugfix" }],
        details: { action: "list-template", templates: ["feature-plan", "bugfix"] },
      };

      const component = render(result, { expanded: false }, renderTheme);

      expect(component).toBeInstanceOf(Text);
      expect(component.render(400).join("\n")).toContain("Available templates: feature-plan, bugfix");
    });

    it("任意未知 action 形态同样回落 content 文本（防御未来再删 action）", () => {
      const { pi } = setup();
      const render = renderFn(pi);
      const result = {
        content: [{ type: "text", text: "legacy entry" }],
        details: { action: "create-template" },
      };

      const component = render(result, { expanded: false }, renderTheme);

      expect(component).toBeInstanceOf(Text);
      expect(component.render(400).join("\n")).toContain("legacy entry");
    });
  });

  // --- complete ---
  describe("complete", () => {
    beforeEach(() => {
      // goal outcome 用例经 handlePlanComplete mock 构造结果（execute 档 tryGoalInit
      // 在 compact.ts 内部自理 goal-unavailable 降级，不在本文件消费面）
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

    it("schema carries no isolation field (D-B1-6: compact|direct 两档分发砍除，单一直接投递路径)", async () => {
      const { pi } = setup();
      const parameters = registeredTool(pi).parameters as {
        properties: Record<string, unknown>;
      };
      expect(parameters.properties.isolation).toBeUndefined();
    });

    it("does not advance when user picks Not now — later 边（dispatching→approved）+ later 文案，不进解散文案桶（A9 反向）", async () => {
      const { exec, ctx, pi } = setup();
      // 有 plan-exec 技能才挂表单（D7②：空集直通，暂不执行档只存在于表单内）
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "dev-flow", description: "d", skillEntryPath: "/tmp/skills/dev-flow/SKILL.md" },
      ]);
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Not now");
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete-later");
      expect(res.details.choice).toBe("Not now");
      // later 档文案（D3 连带段）：已批准、未派发、可再调 complete——**不得**是外部解散文案
      expect(res.content[0].text).toContain("NOT dispatched");
      expect(res.content[0].text).toContain("plan(action='complete')");
      expect(res.content[0].text).not.toContain("interrupted");
      expect(res.content[0].text).not.toContain("exited");
      // later 边落盘：approved（批准事实保留，留在 plan mode）
      const entries = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as { state?: string });
      expect(entries.at(-1)?.state).toBe("approved");
      expect(pi.setActiveTools).not.toHaveBeenCalled();
    });

    it("turn abort during the pending execution-method select dissolves the dialog → 归口②外部解散（review_aborted→approved，MF-1-8）", async () => {
      const { exec, ctx, pi } = setup();
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "dev-flow", description: "d", skillEntryPath: "/tmp/skills/dev-flow/SKILL.md" },
      ]);
      // select mock 对齐 pi 实装 createDialogPromise 语义（rpc-mode.js:48）：
      // signal 已 abort 首行短路 resolve undefined；挂起中 abort → resolve undefined
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(
        (_title: string, _labels: string[], opts: { signal?: AbortSignal }) =>
          new Promise<string | undefined>((resolve) => {
            if (opts.signal?.aborted) {
              resolve(undefined);
              return;
            }
            opts.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      );
      const turn = new AbortController();
      const pending = exec({ action: "complete" }, turn.signal);
      turn.abort();
      const res = await pending;
      // turn abort 级联（未经入口，不打标）→ 外部解散：dispatching --review_aborted--> approved
      expect(res.details.action).toBe("complete-cancelled");
      expect(res.details.reason).toBe("cancelled");
      expect(res.details.source).toBe("external");
      expect(res.content[0].text).toContain("interrupted");
      expect(res.content[0].text).toContain("APPROVED");
      expect(pi.setActiveTools).not.toHaveBeenCalled();
      const entries = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as { state?: string });
      expect(entries.at(-1)?.state).toBe("approved");
    });

    it("resets state and restores tools on execute — exec_chosen 边（dispatching→completed 终局）", async () => {
      const { exec, ctx, pi } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Execute");
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete");
      expect(res.details.execMode).toBe("execute");
      expect(pi.setActiveTools).toHaveBeenCalledWith(ALL_TOOL_NAMES);
      expect(handlePlanComplete).toHaveBeenCalled();
      // 内部路径显示为相对路径（A2 边界判断正向：projectDir 后紧随分隔符才切）
      expect(res.details.planFilePath).toBe(".tmp/plans/auth/plan.md");
      // 终局落盘：terminal='completed'（防 reset 覆写 completed，D3 连带段）
      const entries = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as { state?: string; isActive?: boolean });
      expect(entries.at(-1)).toMatchObject({ state: "completed", isActive: false });
    });

    it("A2 边界锚：兄弟前缀目录（/tmp/test-project-2）不被误切进 /tmp/test-project 的相对路径", async () => {
      const { exec, ctx, sessions } = setup();
      sessions.set("test-session", {
        ...DEFAULT_PLAN_STATE,
        isActive: true,
        planFilePath: "/tmp/test-project-2/.tmp/plans/auth/plan.md",
        requirement: "refactor auth",
        state: "approved",
        docs: [{ fileName: "design.md", absPath: "/tmp/test-project-2/.tmp/plans/auth/design.md", sourceSkill: "", version: 1 }],
      });
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Execute");
      const res = await exec({ action: "complete" });
      // 裸 startsWith 曾把 test-project-2 误吃进 test-project 前缀（错切为 2/.tmp/...）——
      // 边界判断（分隔符或全等）后兄弟前缀原样显示
      expect(res.details.planFilePath).toBe("/tmp/test-project-2/.tmp/plans/auth/plan.md");
    });

    it("dialog options = skills (max 2) + Execute + Not now, goal bridge availability irrelevant (选项集重排；D7② 有技能才弹表单)", async () => {
      const { exec, ctx } = setup();
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "dev-flow", description: "d1", skillEntryPath: "/tmp/a/SKILL.md" },
        { name: "pr-cr-fix", description: "d2", skillEntryPath: "/tmp/b/SKILL.md" },
        { name: "third", description: "d3", skillEntryPath: "/tmp/c/SKILL.md" },
      ]);
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Execute");
      await exec({ action: "complete" });
      const options = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
      expect(options).toEqual([
        "Execute via skill: dev-flow",
        "Execute via skill: pr-cr-fix",
        "Execute",
        "Not now",
      ]);
    });

    it("execute choice maps to execMode execute (goal + auto-parallel 整合档)", async () => {
      const { exec, ctx } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Execute");
      const res = await exec({ action: "complete" });
      expect(res.details.execMode).toBe("execute");
      expect(handlePlanComplete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "execute", undefined);
    });

    it("headless (!hasUI) defaults to execute without any select (D4 三路分流第 1 路)", async () => {
      const { exec, ctx, pi } = setup();
      ctx.hasUI = false;
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete");
      expect(res.details.execMode).toBe("execute");
      expect(ctx.ui.select).not.toHaveBeenCalled(); // 不进任何 select（noOp 软门修复）
      expect(detectExecSkills).not.toHaveBeenCalled(); // 选择已预定，跳过 skill 扫描
      expect(pi.setActiveTools).toHaveBeenCalledWith(ALL_TOOL_NAMES);
      expect(handlePlanComplete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "execute", undefined);
    });

    it("detected plan-exec skills lead the option set (first + second) and map to skill:<name> with skillEntryPath (D10 重排)", async () => {
      const { exec, ctx } = setup();
      const skillEntryPath = "/tmp/fixtures/skills/dev-flow/SKILL.md";
      const secondPath = "/tmp/fixtures/skills/pr-cr-fix/SKILL.md";
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "dev-flow", description: "Deliver a plan via dev-flow.", skillEntryPath },
        { name: "pr-cr-fix", description: "PR lifecycle.", skillEntryPath: secondPath },
        { name: "third", description: "Beyond the cap.", skillEntryPath: "/tmp/x" },
      ]);
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Execute via skill: dev-flow");
      const res = await exec({ action: "complete" });

      const options = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
      // skill 前置（用户裁决：第一/第二排位），第 3 个起截断；Execute/Not now 固定收尾
      expect(options).toEqual([
        "Execute via skill: dev-flow",
        "Execute via skill: pr-cr-fix",
        "Execute",
        "Not now",
      ]);
      expect(res.details.action).toBe("complete");
      expect(res.details.execMode).toBe("skill:dev-flow");
      // skillEntryPath 数据通路：CompleteChoiceOutcome → handlePlanComplete（steer 文案的路径来源）
      expect(handlePlanComplete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "skill:dev-flow", skillEntryPath);
    });

    it("D7② 空集直通（TUI）：无 plan-exec 技能不挂任何选择器，直接走执行派发链 + 文案明示", async () => {
      const { exec, ctx, pi } = setup();
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([]);
      const res = await exec({ action: "complete" });

      // 不挂执行方式选择（恒两项死表单构造性消除，S4 通过标准）
      expect(ctx.ui.select).not.toHaveBeenCalled();
      expect(res.details.action).toBe("complete");
      expect(res.details.execMode).toBe("execute");
      expect(res.details.execModeSource).toBe("no-exec-skills");
      // 工具结果文案明示「无 plan-exec 技能，直接执行」（不静默吞掉没弹表单的事实）
      expect(res.content[0].text).toContain("No plan-exec skill was detected");
      expect(res.content[0].text).toContain("executed directly");
      // 复用既有执行派发链（goal 桥/直执 steer）+ 终局 completed
      expect(handlePlanComplete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "execute", undefined);
      const entries = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as { state?: string });
      expect(entries.at(-1)?.state).toBe("completed");
    });

    it("execute tier carries the goal outcome into result content and details (整合档 D2)", async () => {
      const { exec, ctx } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Execute");
      (handlePlanComplete as ReturnType<typeof vi.fn>).mockReturnValue({ started: false, reason: "no-steps" });
      const res = await exec({ action: "complete" });
      expect(handlePlanComplete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "execute", undefined);
      expect(res.content[0].text).toContain("Goal tracking was not started (no-steps)");
      expect(res.content[0].text).toContain("Implementation Steps"); // 恢复动作
      expect(res.details.goalOutcome).toEqual({ started: false, reason: "no-steps" });
    });

    it("successful goal outcome appends the started line", async () => {
      const { exec, ctx } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Execute");
      (handlePlanComplete as ReturnType<typeof vi.fn>).mockReturnValue({ started: true });
      const res = await exec({ action: "complete" });
      expect(res.content[0].text).toContain("Goal tracking started via /goal");
      expect(res.details.goalOutcome).toEqual({ started: true });
    });

    it("compact tier outcome is deferred (undefined): result keeps the plain approved line", async () => {
      const { exec, ctx } = setup();
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Execute");
      (handlePlanComplete as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      const res = await exec({ action: "complete" });
      expect(res.content[0].text).toMatch(/^Plan approved\. File: /);
      expect(res.content[0].text).not.toContain("Goal tracking");
      expect(res.details.goalOutcome).toBeUndefined();
      expect(res.details.isolation).toBeUndefined(); // isolation 字段随 D-B1-6 两档分发砍除退役
    });
  });

  // --- complete · GUI 路径（taiji rpc 宿主 → uiFormInteract，D4 第 2 路）---
  describe("complete via taiji form channel", () => {
    beforeEach(() => {
      vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
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

    it("sends a single choice question via UI_FORM_MARKER and maps the execute answer (无 tab 条单视图；D7② 有技能才挂)", async () => {
      const { exec, ctx } = setupGui();
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "dev-flow", description: "d", skillEntryPath: "/tmp/skills/dev-flow/SKILL.md" },
      ]);
      (ctx.ui.select as ReturnType<typeof vi.fn>)
        .mockResolvedValue(JSON.stringify({ "Execution method": "Execute" }));
      const res = await exec({ action: "complete" });

      const title = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(title).toBe(UI_FORM_MARKER);
      const labels = formOptionLabels(ctx.ui.select as ReturnType<typeof vi.fn>).map((o) => o.label);
      expect(labels).toEqual([
        "Execute via skill: dev-flow",
        "Execute",
        "Not now",
      ]);
      expect(res.details.action).toBe("complete");
      expect(res.details.execMode).toBe("execute");
    });

    it("skill option carries its description into the form and maps to skill:<name>", async () => {
      const { exec, ctx } = setupGui();
      const skillEntryPath = "/tmp/fixtures/skills/dev-flow/SKILL.md";
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "dev-flow", description: "Deliver a plan via dev-flow.", skillEntryPath },
      ]);
      (ctx.ui.select as ReturnType<typeof vi.fn>)
        .mockResolvedValue(JSON.stringify({ "Execution method": "Execute via skill: dev-flow" }));
      const res = await exec({ action: "complete" });

      const options = formOptionLabels(ctx.ui.select as ReturnType<typeof vi.fn>);
      const skillOption = options.find((o) => o.label === "Execute via skill: dev-flow");
      expect(skillOption?.description).toBe("Deliver a plan via dev-flow.");
      expect(res.details.execMode).toBe("skill:dev-flow");
      expect(handlePlanComplete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "skill:dev-flow", skillEntryPath);
    });

    it("timeout via undefined resolve (signal not aborted) folds to 归口②外部解散（构造点④，review_aborted→approved）", async () => {
      // rpc 模式 GUI 用户取消 resolve undefined，与超时不可区分（signal 未 abort 折叠
      // timeout，库层 callMarkerRpc 判别），构造点③④同折 via 'dissolved' reason='cancelled'。
      // 未经入口解散（不打标）→ 外部解散：批准事实保留，文案不得声称已退出
      const { exec, ctx, pi } = setupGui();
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "dev-flow", description: "d", skillEntryPath: "/tmp/skills/dev-flow/SKILL.md" },
      ]);
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete-cancelled");
      expect(res.details.reason).toBe("cancelled");
      expect(res.details.source).toBe("external");
      expect(res.content[0].text).toContain("interrupted");
      expect(res.content[0].text).toContain("plan(action='complete')");
      expect(res.content[0].text).not.toContain("has been exited");
      expect(pi.setActiveTools).not.toHaveBeenCalled();
    });

    it("命令解散（handleAbort 全序列：markDissolved('self') + controller.abort() + reset 介入）→ 归口② no-op（dissolvedBy 判别，不落盘）", async () => {
      // 真实通道注入 = command.ts exitPlanMode 的因果链：markDissolved('self') 与
      // controller.abort() 后 resetPlanState 同步落盘（同步临界段，无让出点）——归口点
      // 在微任务里运行时来源已置位
      const { exec, ctx, controllers, pi } = setupGui();
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "dev-flow", description: "d", skillEntryPath: "/tmp/skills/dev-flow/SKILL.md" },
      ]);
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        // 模拟 exitPlanMode 入口动作（真实序列：markDissolved 先于 abort）
        const pending = controllers.get("test-session");
        pending?.markDissolved("self");
        pending?.controller.abort();
        return undefined;
      });
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete-cancelled");
      expect(res.details.reason).toBe("cancelled");
      expect(res.details.source).toBe("self");
      expect(res.content[0].text).toContain("has been exited");
      expect(res.content[0].text).toContain("full tool set is restored");
      // 归口 no-op：不追加任何落盘（reset 已由命令侧落终态）——最后一条仍是入函数时的 dispatching
      const entries = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as { state?: string });
      expect(entries.at(-1)?.state).toBe("dispatching");
      expect(pi.setActiveTools).not.toHaveBeenCalled();
    });

    it("channel-error (echo payload) folds to 归口②外部解散（构造点⑤）with channel note, no throw", async () => {
      const { exec, ctx, pi } = setupGui();
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "dev-flow", description: "d", skillEntryPath: "/tmp/skills/dev-flow/SKILL.md" },
      ]);
      // echo 检测：宿主不识别 UI_FORM_MARKER 时 band 单选项 = payload 自身，点选即回显
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async (_t: string, options: string[]) => options[0]);
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete-cancelled");
      expect(res.details.reason).toBe("channel-error");
      expect(res.details.source).toBe("external");
      expect(res.content[0].text).toContain("interrupted");
      expect(res.content[0].text).toContain("channel-error"); // 构造点原因透出
      expect(res.content[0].text).toContain("upgrade taiji"); // echo 升级指引透出
      expect(pi.setActiveTools).not.toHaveBeenCalled();
    });

    it("non-json response folds to 归口②外部解散（构造点⑤）with channel note, no throw", async () => {
      const { exec, ctx } = setupGui();
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "dev-flow", description: "d", skillEntryPath: "/tmp/skills/dev-flow/SKILL.md" },
      ]);
      (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("not-json");
      const res = await exec({ action: "complete" });
      expect(res.details.action).toBe("complete-cancelled");
      expect(res.details.reason).toBe("non-json");
      expect(res.details.source).toBe("external");
      expect(res.content[0].text).toContain("interrupted");
      expect(res.content[0].text).toContain("non-json");
    });
  });

  // --- D7② 无技能直通（S4 通过标准：无 plan-exec 技能不挂表单、approve 直通 execute）---
  describe("D7② 无 plan-exec 技能直通（不挂执行方式表单）", () => {
    it("rpc 空集直通：不挂 UI_FORM_MARKER 表单，直通 execute + 文案明示（双向之一）", async () => {
      vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
      const h = setup();
      (h.ctx as { mode?: string }).mode = "rpc";
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const res = await h.exec({ action: "complete" });

      expect(h.ctx.ui.select).not.toHaveBeenCalled();
      expect(res.details.execMode).toBe("execute");
      expect(res.details.execModeSource).toBe("no-exec-skills");
      expect(res.content[0].text).toContain("No plan-exec skill was detected");
      expect(detectExecSkills).toHaveBeenCalled(); // 仍现扫（直通判定依赖检测，不是跳过检测）
      expect(handlePlanComplete).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), "execute", undefined);
      vi.unstubAllEnvs();
    });

    it("非空照旧挂表单（双向之二）：技能档 + Execute + 暂不执行照常出现", async () => {
      vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
      const h = setup();
      (h.ctx as { mode?: string }).mode = "rpc";
      (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "dev-flow", description: "Deliver via dev-flow.", skillEntryPath: "/tmp/skills/dev-flow/SKILL.md" },
      ]);
      (h.ctx.ui.select as ReturnType<typeof vi.fn>)
        .mockResolvedValue(JSON.stringify({ "Execution method": "Execute via skill: dev-flow" }));

      const res = await h.exec({ action: "complete" });

      expect(h.ctx.ui.select).toHaveBeenCalledOnce();
      expect(res.details.execMode).toBe("skill:dev-flow");
      expect(res.details.execModeSource).toBe("dialog");
      expect(res.content[0].text).not.toContain("No plan-exec skill");
      vi.unstubAllEnvs();
    });
  });

  // --- abort ---
  describe("abort", () => {
    it("resets state and cleans up session — exit 边（活跃族非终态→exited）", async () => {
      const { exec, pi, sessions } = setup();
      // Pre-populate a session（工具层 abort 走 exitPlanMode 单入口——命令层 abort 联动的顺序断言在 command.test.ts）
      sessions.set("test-session", {
        ...DEFAULT_PLAN_STATE,
        isActive: true,
        planFilePath: "/tmp/plan.md",
        requirement: "test",
        templateName: "t",
        skills: ["tech-design"],
        docs: [{ fileName: "design.md", absPath: "/tmp/design.md", sourceSkill: "tech-design", version: 1 }],
        state: "reviewing",
      });
      const res = await exec({ action: "abort" });
      expect(res.details.action).toBe("abort");
      expect(pi.setActiveTools).toHaveBeenCalledWith(ALL_TOOL_NAMES);
      expect(sessions.has("test-session")).toBe(false);
      expect(updatePlanWidget).toHaveBeenCalled();
      // 终态矩阵：reset entry 落 isActive=false + state='exited' + skills/selfReview 清空 + docs 保留
      expect(pi.appendEntry).toHaveBeenCalledWith("plan-state", expect.objectContaining({ isActive: false, state: "exited" }));
      const entry = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(entry.docs).toHaveLength(1);
      expect(entry.skills).toEqual([]);
    });

    it("终态上 abort → 幂等退出：warn 纠偏 + 不覆写 completed、不落盘 + ④工具集幂等恢复（D-B1-1 守卫极性）", async () => {
      const { exec, pi, sessions } = setup();
      sessions.set("test-session", {
        ...DEFAULT_PLAN_STATE,
        isActive: false,
        state: "completed",
        docs: [{ fileName: "design.md", absPath: "/tmp/design.md", sourceSkill: "", version: 1 }],
      });
      const res = await exec({ action: "abort" });
      expect(res.details).toEqual({ action: "review-error", reason: "inactive" });
      expect(res.content[0].text).toContain("Plan mode is not active");
      // ok:false 不落盘（completed 终态不被覆写为 exited）
      expect(pi.appendEntry).not.toHaveBeenCalled();
      // ④ 工具集照常幂等恢复（D-B1-1：ok:false → ①③④⑤照常，已恢复则 no-op）
      expect(pi.setActiveTools).toHaveBeenCalledWith(ALL_TOOL_NAMES);
    });

    it("idle 常态格 abort → warn 纠偏文案、不落盘（D-B1-1 行为变更：噪音 exited entry 消灭，V1 ⑧ 锚）", async () => {
      const { exec, pi, sessions } = setup();
      // idle 常态格：从未进 plan（isActive=false + state='idle'——删 exit 边后 ok:false）
      sessions.set("test-session", { ...DEFAULT_PLAN_STATE });
      const res = await exec({ action: "abort" });
      expect(res.details).toEqual({ action: "review-error", reason: "inactive" });
      expect(res.content[0].text).toBe("No active plan mode.");
      // 行为变更核心断言：不落 exited 噪音 entry
      expect(pi.appendEntry).not.toHaveBeenCalled();
      // ④ 幂等恢复（idle 格工具集已全量，重设 = 可观察零变化）
      expect(pi.setActiveTools).toHaveBeenCalledWith(ALL_TOOL_NAMES);
      expect(sessions.has("test-session")).toBe(true); // 无 reset（缓存不动）
    });

    it("坏数据格·终态残留（isActive=true + state=completed）abort → 清洗 entry（终态值不变 + isActive=false，不覆写为 exited）", async () => {
      const { exec, pi, sessions } = setup();
      sessions.set("test-session", {
        ...DEFAULT_PLAN_STATE,
        isActive: true, // 坏格：伪 active 投影
        planFilePath: "/tmp/plans/auth/plan.md",
        state: "completed",
        docs: [{ fileName: "design.md", absPath: "/tmp/plans/auth/design.md", sourceSkill: "", version: 1 }],
      });
      const res = await exec({ action: "abort" });
      expect(res.details).toEqual({ action: "review-error", reason: "inactive" });
      // 清洗例外：唯一保留的落盘——isActive 投影复位 + state 取当前终态值（completed 不被 exited 覆写）
      expect(pi.appendEntry).toHaveBeenCalledWith(
        "plan-state",
        expect.objectContaining({ isActive: false, state: "completed" }),
      );
      expect(pi.setActiveTools).toHaveBeenCalledWith(ALL_TOOL_NAMES);
      expect(sessions.has("test-session")).toBe(false); // 清洗后缓存清理（重开经 entry 恢复正常态）
    });

    it("坏数据格·idle 残留（isActive=true + state=idle）abort → 清洗 entry（exited + isActive=false）", async () => {
      const { exec, pi, sessions } = setup();
      sessions.set("test-session", {
        ...DEFAULT_PLAN_STATE,
        isActive: true, // 坏格：'idle' 是值域白名单合法值 + isActive=true → 重开复活伪 active
        planFilePath: "/tmp/plans/auth/plan.md",
        state: "idle",
      });
      const res = await exec({ action: "abort" });
      expect(res.details).toEqual({ action: "review-error", reason: "inactive" });
      // 清洗例外 idle 残留形态：abort 是用户显式退出意图，exited 是本次动作的真实记录
      expect(pi.appendEntry).toHaveBeenCalledWith(
        "plan-state",
        expect.objectContaining({ isActive: false, state: "exited" }),
      );
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
  it("action list contains exactly the six actions (enter added for agent self-entry; list-template removed, D1)", () => {
    expect([...PLAN_ACTIONS].sort()).toEqual(
      ["abort", "complete", "enter", "register-doc", "select-template", "submit-review"],
    );
    expect(PLAN_ACTIONS).not.toContain("create-template");
    expect(PLAN_ACTIONS).not.toContain("list-template");
  });
});
