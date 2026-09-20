import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock typebox before importing tool（形态照 tool.test.ts；Type.Array 需在列——enter 的 skills 参数）
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

// Mock node:fs（plan 目录 mkdirSync 不触真实盘——fs-guard 只白名单 tmpdir；command.test.ts 同形态）
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

// Mock templates（enter 的 buildPlanModePrompt 走 listTemplates；单测不扫真实模板目录）
vi.mock("../templates.js", () => ({
  listTemplates: vi.fn(() => []),
  loadTemplate: vi.fn(() => null),
  formatAvailablePlans: vi.fn(() => ""),
}));

vi.mock("../compact.js", () => ({
  handlePlanComplete: vi.fn(),
  detectGoalCapability: vi.fn(() => false),
  GOAL_FAILURE_RECOVERY: {},
}));

vi.mock("../exec-skills.js", () => ({
  detectExecSkills: vi.fn(() => []),
}));

vi.mock("../widget.js", () => ({
  updatePlanWidget: vi.fn(),
}));

import * as fs from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerPlanTool } from "../tool.js";
import { PLAN_MODE_TOOLS } from "../state.js";

const ALL_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "plan", "write", "edit"];

function setup(skillCommands: Array<{ name: string; path: string }> = []) {
  const sessions = new Map();
  const controllers = new Map<string, AbortController>();
  let executeFn: (id: string, p: Record<string, unknown>, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: { action: string; requirement?: string; skills?: string[] };
  }>;
  const pi = {
    registerTool: vi.fn((tool) => { executeFn = tool.execute; }),
    appendEntry: vi.fn(),
    setActiveTools: vi.fn(),
    sendUserMessage: vi.fn(),
    getCommands: vi.fn(() => skillCommands.map((c) => ({ name: c.name, source: "skill", sourceInfo: { path: c.path } }))),
    getAllTools: vi.fn(() => ALL_TOOL_NAMES.map((n) => ({ name: n }))),
  } as unknown as ExtensionAPI;
  registerPlanTool(pi, sessions, controllers);

  const ctx = {
    sessionId: "test-session",
    cwd: "/tmp/test-project",
    hasUI: true,
    mode: "tui" as const,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "test-session", getEntries: () => [] },
    ui: { select: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;

  const exec = (params: Record<string, unknown>, signal?: AbortSignal) =>
    executeFn!("tc0", params, signal, undefined, ctx);
  return { pi, sessions, ctx, exec };
}

describe("plan(action='enter') — agent 自助进入（plan-mode-agent-enter U1）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("idle 进入：收工具到白名单 + 持久化 isActive=true + tool result 携带只读纪律提示词", async () => {
    const { exec, pi, sessions } = setup();
    const res = await exec({ action: "enter", requirement: "重构 auth 模块" });

    // 工具收拢到 plan 白名单
    expect(pi.setActiveTools).toHaveBeenCalledWith(PLAN_MODE_TOOLS);
    // 状态持久化 isActive=true（投影链驱动 GUI 显形的锚点）
    expect(pi.appendEntry).toHaveBeenCalledWith("plan-state", expect.objectContaining({ isActive: true }));
    // plan 目录创建（.taiji-harness/<slug>，slug 由 requirement 派生）
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.taiji-harness/),
      expect.objectContaining({ recursive: true }),
    );
    // 提示词经 tool result 直返（不经 sendUserMessage 对话流注入——对本次调用的直接响应）
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(res.details.action).toBe("enter");
    expect(res.content[0].text).toContain("[PLAN MODE] Entered plan mode");
    expect(res.content[0].text).toContain("READ-ONLY");
    // 状态对象已是激活态
    const state = sessions.get("test-session") as { isActive?: boolean; requirement?: string };
    expect(state.isActive).toBe(true);
  });

  it("已在 plan 模式：幂等返回，不重复收工具 / 不重复注入", async () => {
    const { exec, pi, sessions } = setup();
    await exec({ action: "enter", requirement: "first" });
    vi.clearAllMocks();
    // state 缓存已在（sessions map 同一对象 isActive=true）
    expect((sessions.get("test-session") as { isActive?: boolean }).isActive).toBe(true);

    const res = await exec({ action: "enter", requirement: "second" });
    expect(res.content[0].text).toContain("Already in plan mode");
    // 幂等：不再 setActiveTools / 不再 appendEntry
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("携带有效 skills：解析挂载，state.skills 记录技能名", async () => {
    const { exec, sessions } = setup([{ name: "skill:tech-design", path: "/skills/tech-design/SKILL.md" }]);
    const res = await exec({ action: "enter", requirement: "r", skills: ["tech-design"] });
    expect(res.details.action).toBe("enter");
    expect(res.details.skills).toEqual(["tech-design"]);
    const state = sessions.get("test-session") as { skills?: string[] };
    expect(state.skills).toEqual(["tech-design"]);
  });

  it("未知技能名：throw 带可用清单自愈（同 select-template 错名先例）", async () => {
    const { exec, pi } = setup([{ name: "skill:tech-design", path: "/x/SKILL.md" }]);
    await expect(exec({ action: "enter", requirement: "r", skills: ["nope"] })).rejects.toThrow(
      /Unknown skill\(s\): nope\. Available skills: .*tech-design/,
    );
    // 校验失败不进入：未收工具、未持久化
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("省略 requirement：提示词回落 (from conversation context)，不阻断进入", async () => {
    const { exec } = setup();
    const res = await exec({ action: "enter" });
    expect(res.details.action).toBe("enter");
    expect(res.content[0].text).toContain("(from conversation context)");
  });
});
