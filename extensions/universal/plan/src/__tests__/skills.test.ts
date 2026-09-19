import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing（形态照 command.test.ts）
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

import { parsePlanArgs, registerPlanCommand, resolveSkills } from "../command.js";

const ALL_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "plan", "write", "edit"];

/**
 * fake skill 命令条目（SlashCommandInfo 形态：source === 'skill' + sourceInfo.path）。
 * name 带 pi 命名空间前缀（`skill:<name>`）——真实 pi.getCommands() 枚举 skill 类
 * 命令即此形态（A3② 真机实测），E1 归一化比对的靶子。
 */
const SKILL_COMMANDS = [
  { name: "skill:tech-design", source: "skill", sourceInfo: { path: "/skills/tech-design/SKILL.md" } },
  { name: "skill:dev-flow", source: "skill", sourceInfo: { path: "/skills/dev-flow/SKILL.md" } },
  { name: "skill:code review", source: "skill", sourceInfo: { path: "/skills/code review/SKILL.md" } },
  { name: "plan", source: "extension", sourceInfo: { path: "/extensions/universal/plan" } },
];

describe("parsePlanArgs（--skills 解析容错定则）", () => {
  it("no flag: requirement only, skills undefined", () => {
    const parsed = parsePlanArgs("重构 auth 模块");
    expect(parsed.requirement).toBe("重构 auth 模块");
    expect(parsed.skills).toBeUndefined();
  });

  it("basic comma split", () => {
    const parsed = parsePlanArgs("重构 auth --skills tech-design,dev-flow");
    expect(parsed.requirement).toBe("重构 auth");
    expect(parsed.skills).toEqual(["tech-design", "dev-flow"]);
  });

  it("chinese and space-containing skill names keep their characters (u0 定则)", () => {
    // 内部空格保留——「按逗号原样切分 + 去首尾空格」，中文名/带空格技能名不丢字符
    const parsed = parsePlanArgs("重构渲染层 --skills tech-design, code review, 中文 技能");
    expect(parsed.requirement).toBe("重构渲染层");
    expect(parsed.skills).toEqual(["tech-design", "code review", "中文 技能"]);
  });

  it("empty items from trailing/double commas are dropped", () => {
    const parsed = parsePlanArgs("req --skills a,,b,");
    expect(parsed.skills).toEqual(["a", "b"]);
  });

  it("flag with no value yields an empty list (caller fail-fasts)", () => {
    const parsed = parsePlanArgs("req --skills");
    expect(parsed.requirement).toBe("req");
    expect(parsed.skills).toEqual([]);
  });

  it("flag at the very start leaves empty requirement", () => {
    const parsed = parsePlanArgs("--skills a,b");
    expect(parsed.requirement).toBe("");
    expect(parsed.skills).toEqual(["a", "b"]);
  });

  it("'--skillsabc' is not treated as the flag (word boundary)", () => {
    const parsed = parsePlanArgs("--skillsabc is part of requirement");
    expect(parsed.skills).toBeUndefined();
    expect(parsed.requirement).toBe("--skillsabc is part of requirement");
  });
});

describe("resolveSkills（E1 技能枚举比对，双向剥 skill: 前缀归一）", () => {
  const pi = {
    getCommands: vi.fn(() => SKILL_COMMANDS),
  } as unknown as ExtensionAPI;

  it("resolves prefixed enum entries from bare-name input (short name in resolved)", () => {
    // 无前缀输入命中带前缀枚举（设计面：用户输入自然技能名，A3② 回归靶）
    const resolution = resolveSkills(pi, ["tech-design", "code review"]);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.resolved).toEqual([
        { name: "tech-design", skillPath: "/skills/tech-design/SKILL.md" },
        { name: "code review", skillPath: "/skills/code review/SKILL.md" },
      ]);
    }
  });

  it("resolves explicit 'skill:'-prefixed input too (both directions normalize)", () => {
    const resolution = resolveSkills(pi, ["skill:tech-design", "skill:dev-flow"]);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      // resolved 用归一后的短名（无前缀）
      expect(resolution.resolved).toEqual([
        { name: "tech-design", skillPath: "/skills/tech-design/SKILL.md" },
        { name: "dev-flow", skillPath: "/skills/dev-flow/SKILL.md" },
      ]);
    }
  });

  it("only compares entries with source === 'skill'", () => {
    const resolution = resolveSkills(pi, ["plan"]);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.missing).toEqual(["plan"]);
      // available 维持枚举原形态（带前缀，错误信息里可直接复制为 pi 命令）
      expect(resolution.available).toEqual(["skill:tech-design", "skill:dev-flow", "skill:code review"]);
    }
  });

  it("unknown skill reports missing together with the available list", () => {
    const resolution = resolveSkills(pi, ["tech-design", "tech-desig"]);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.missing).toEqual(["tech-desig"]);
    }
  });

  it("prefixed-but-unknown input reports the normalized short name as missing", () => {
    const resolution = resolveSkills(pi, ["skill:tech-desig"]);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.missing).toEqual(["tech-desig"]);
    }
  });
});

describe("E1 fail-fast via /plan handler", () => {
  let pi: ExtensionAPI;
  let ctx: ExtensionContext;
  let handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  let controllers: Map<string, AbortController>;

  beforeEach(() => {
    vi.clearAllMocks();
    let capturedHandler: (args: string, ctx: ExtensionContext) => Promise<void>;
    pi = {
      registerCommand: vi.fn((_name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
        capturedHandler = def.handler;
      }),
      appendEntry: vi.fn(),
      setActiveTools: vi.fn(),
      sendUserMessage: vi.fn(),
      getCommands: vi.fn(() => SKILL_COMMANDS),
      getAllTools: vi.fn(() => ALL_TOOL_NAMES.map((n) => ({ name: n }))),
    } as unknown as ExtensionAPI;
    ctx = {
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
    controllers = new Map();
    registerPlanCommand(pi, new Map(), controllers);
    handler = capturedHandler!;
  });

  it("unknown skill: fail-fast — no entry, no tool restriction, reply lists available skills", async () => {
    await handler("重构 auth --skills tech-desig", ctx);

    // 不进入计划模式：不落 plan-state entry、不限制工具（E1：横幅不出现）
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();

    // 回复列出可用技能清单与纠正命令（清单维持枚举原形态，可直接复制为 pi 命令）
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();
    const message = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(message).toContain("tech-desig");
    expect(message).toContain("tech-design");
    expect(message).toContain("dev-flow");
    expect(message).toContain("--skills");
    expect(message).toContain("skill:tech-design");
    expect(message).toContain("skill:dev-flow");
  });

  it("prefixed skill input ('--skills skill:x') enters plan mode with normalized short names", async () => {
    await handler("重构 auth --skills skill:tech-design", ctx);

    // 进入计划模式，state 落归一化短名
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ isActive: true, skills: ["tech-design"] }),
    );
    const prompt = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("/skills/tech-design/SKILL.md");
  });

  it("flag with no value also fail-fasts", async () => {
    await handler("重构 auth --skills", ctx);
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();
  });

  it("valid skills: enters plan mode, persists skills and injects skill paths in the prompt", async () => {
    await handler("重构 auth --skills tech-design,code review", ctx);

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls", "plan"]);
    // slug 只保留 [a-z0-9]：「重构 auth」→ "auth"
    expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp/test-project/.taiji-harness/auth", { recursive: true });
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({
        isActive: true,
        skills: ["tech-design", "code review"],
        docs: [],
      }),
    );
    const prompt = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // 技能指令段注入 SKILL.md 路径（AI 自行 read——D2①）
    expect(prompt).toContain("/skills/tech-design/SKILL.md");
    expect(prompt).toContain("/skills/code review/SKILL.md");
    // 产物纪律段注入（D2②）
    expect(prompt).toContain("register-doc");
    expect(prompt).toContain("submit-review");
  });

  it("without --skills: falls back to the template flow prompt (D2④) and persists empty skills", async () => {
    await handler("implement dark mode", ctx);

    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ isActive: true, skills: [] }),
    );
    const prompt = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // 无技能指令段，回落模板流程段（v2b 注入形态：mock fs 空发现 → no-plans 分支
    // 自构章节骨架，无任何模板查询 action 指引）
    expect(prompt).not.toContain("Skill Workflow");
    expect(prompt).toContain("Phase C: Writing");
    expect(prompt).toContain("No plan templates were discovered");
  });
});
