import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --template 直传注入的全文 fixture（vi.hoisted：vi.mock 工厂引用需先于模块体初始化）
const TEMPLATE_FILE_FIXTURE = vi.hoisted(() => "# retro skeleton\n\n## Implementation Steps\n- step one\n");

// Mock dependencies before importing
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
  existsSync: vi.fn(() => false),
  // --template 直传的全文内嵌读取（v2b：prompts 分支消费）
  readFileSync: vi.fn(() => TEMPLATE_FILE_FIXTURE),
}));

vi.mock("../widget.js", () => ({
  updatePlanWidget: vi.fn(),
}));

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { parsePlanArgs, registerPlanCommand, resolveTemplateFile } from "../command.js";

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

  // --- --template 直传（D5：校验 + 解析 + 最小进入）---

  /** 取第一条 sendUserMessage 的文本（fail-fast 回复 / 进入提示词共用通道） */
  function sentMessage(): string {
    return (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
  }

  describe("--template via /plan handler", () => {
    afterEach(() => {
      // 还原默认 existsSync=false，避免路径实现泄漏到后续用例
      vi.mocked(fs.existsSync).mockImplementation(() => false);
    });

    it("mutual exclusion with --skills: fail-fast — no entry, no tool restriction, both usage forms in reply", async () => {
      await handler("复盘 --template tpl.md --skills a", ctx);

      // 不进入计划模式（§3.1：不写 entry / 不限制工具 / 不注入计划提示词）
      expect(pi.appendEntry).not.toHaveBeenCalled();
      expect(pi.setActiveTools).not.toHaveBeenCalled();
      expect(pi.sendUserMessage).toHaveBeenCalledOnce();
      const message = sentMessage();
      expect(message).toContain("--template and --skills are mutually exclusive");
      expect(message).toContain("/plan <requirement> --skills a,b");
      expect(message).toContain("/plan <requirement> --template <path>");
    });

    it("missing file: fail-fast reports resolved absolute path + usage sample", async () => {
      // existsSync 默认 false（模块 mock 出厂实现）
      await handler("复盘 --template tpl.md", ctx);
      expect(pi.appendEntry).not.toHaveBeenCalled();
      expect(pi.setActiveTools).not.toHaveBeenCalled();
      const message = sentMessage();
      expect(message).toContain("Template file not found: /tmp/test-project/tpl.md");
      expect(message).toContain("e.g. /plan <requirement> --template /path/to/template.md");
    });

    it("existing non-markdown file: fail-fast reports 'Not a markdown file' (文案分家)", async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => p === "/tmp/test-project/notes.txt");
      await handler("复盘 --template notes.txt", ctx);
      expect(pi.appendEntry).not.toHaveBeenCalled();
      const message = sentMessage();
      expect(message).toContain("Not a markdown file: /tmp/test-project/notes.txt");
      expect(message).not.toContain("not found");
    });

    it("flag with no value: fail-fast (与 --skills 空值同款显式错误)", async () => {
      await handler("复盘 --template", ctx);
      expect(pi.appendEntry).not.toHaveBeenCalled();
      const message = sentMessage();
      expect(message).toContain("--template was given but no path followed it");
    });

    it("valid template: enters plan mode — basename + 直传分支（全文内嵌 + 清单段抑制，v2b 终态）", async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => p === "/tmp/test-project/docs/retro-template.md");
      await handler("retro meeting --template docs/retro-template.md", ctx);

      expect(pi.appendEntry).toHaveBeenCalledWith(
        "plan-state",
        expect.objectContaining({
          isActive: true,
          requirement: "retro meeting",
          templateName: "retro-template",
          templateProvidedPath: "/tmp/test-project/docs/retro-template.md",
          skills: [],
        }),
      );
      expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls", "plan"]);
      const prompt = sentMessage();
      // 直传声明 + 全文内嵌（文件内容直达模型，不赌自发 read——D5）
      expect(prompt).toContain("template was provided via --template");
      expect(prompt).toContain("/tmp/test-project/docs/retro-template.md");
      expect(prompt).toContain(TEMPLATE_FILE_FIXTURE);
      expect(prompt).toContain("Do NOT call plan(action='select-template')");
      // 清单段抑制：guide 行与「模板已指定」并存会诱导画蛇添足调 select-template
      expect(prompt).not.toContain("<available-plans>");
    });

    it("spaced path with ~ prefix: whole-segment value + homedir expansion reach validation and entry", async () => {
      const spacedAbs = path.join(os.homedir(), "my plans", "retro template.md");
      vi.mocked(fs.existsSync).mockImplementation((p) => p === spacedAbs);
      await handler("retro --template ~/my plans/retro template.md", ctx);

      expect(pi.appendEntry).toHaveBeenCalledWith(
        "plan-state",
        expect.objectContaining({ isActive: true, templateName: "retro template", templateProvidedPath: spacedAbs }),
      );
      const prompt = sentMessage();
      expect(prompt).toContain(spacedAbs);
      expect(prompt).toContain(TEMPLATE_FILE_FIXTURE);
    });
  });
});

describe("parsePlanArgs (--template 整段取值语义, D5)", () => {
  it("no flag: templatePath undefined", () => {
    const parsed = parsePlanArgs("重构 auth 模块");
    expect(parsed.templatePath).toBeUndefined();
    expect(parsed.skills).toBeUndefined();
  });

  it("value = whole text after the flag — spaces preserved without quoting (整段取值)", () => {
    const parsed = parsePlanArgs("复盘事故 --template ~/docs/my retro template.md");
    expect(parsed.requirement).toBe("复盘事故");
    expect(parsed.templatePath).toBe("~/docs/my retro template.md");
  });

  it("flag at the very start leaves empty requirement", () => {
    const parsed = parsePlanArgs("--template tpl.md");
    expect(parsed.requirement).toBe("");
    expect(parsed.templatePath).toBe("tpl.md");
  });

  it("'--templatex' is not treated as the flag (word boundary)", () => {
    const parsed = parsePlanArgs("req --templatex is part of requirement");
    expect(parsed.templatePath).toBeUndefined();
    expect(parsed.requirement).toBe("req --templatex is part of requirement");
  });

  it("both flags present (either order): both parsed — caller fail-fasts mutual exclusion", () => {
    const templateFirst = parsePlanArgs("req --template a.md --skills b");
    expect(templateFirst.templatePath).toBeDefined();
    expect(templateFirst.skills).toBeDefined();

    const skillsFirst = parsePlanArgs("req --skills b --template a.md");
    expect(skillsFirst.templatePath).toBeDefined();
    expect(skillsFirst.skills).toBeDefined();
  });
});

describe("resolveTemplateFile (D5 校验与文案分家)", () => {
  afterEach(() => {
    vi.mocked(fs.existsSync).mockImplementation(() => false);
  });

  it("empty value is an explicit error (flag given, nothing followed)", () => {
    const res = resolveTemplateFile("   ", "/tmp/test-project");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problem).toContain("--template was given but no path followed it");
  });

  it("~ prefix expands against os.homedir and missing file reports absolute path", () => {
    const res = resolveTemplateFile("~/docs/retro.md", "/tmp/test-project");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.problem).toContain(`Template file not found: ${path.join(os.homedir(), "docs/retro.md")}`);
    }
  });

  it("relative path resolves against projectDir; not-found message carries usage sample", () => {
    const res = resolveTemplateFile("tpl.md", "/tmp/test-project");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.problem).toContain("Template file not found: /tmp/test-project/tpl.md");
      expect(res.problem).toContain("e.g. /plan <requirement> --template /path/to/template.md");
    }
  });

  it("existing non-markdown file reports 'Not a markdown file' (文案分家)", () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/tmp/test-project/notes.txt");
    const res = resolveTemplateFile("notes.txt", "/tmp/test-project");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.problem).toContain("Not a markdown file: /tmp/test-project/notes.txt");
      expect(res.problem).not.toContain("not found");
    }
  });

  it("existing markdown file resolves ok with absolute path", () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/tmp/test-project/docs/retro.md");
    const res = resolveTemplateFile("docs/retro.md", "/tmp/test-project");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.absPath).toBe("/tmp/test-project/docs/retro.md");
  });
});
