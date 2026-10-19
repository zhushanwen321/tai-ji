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
  formatAvailablePlans: vi.fn(() => ""),
}));

vi.mock("../execution-notice.js", () => ({
  handlePlanComplete: vi.fn(),
  GOAL_FAILURE_RECOVERY: {},
}));

// Mock 执行方式检测（D10）：单测不扫真实目录。importActual 展开：只覆写
// detectExecSkills，其余导出（含 enter.ts re-export 的 resolveSkills 执行门禁）走
// 真实现——mock 罩全模块会把它一并变 undefined
vi.mock("@zhushanwen/pi-exec-skills", async () => {
  const actual = await vi.importActual<typeof import("@zhushanwen/pi-exec-skills")>(
    "@zhushanwen/pi-exec-skills",
  );
  return { ...actual, detectExecSkills: vi.fn(() => []) };
});

vi.mock("../widget.js", () => ({
  updatePlanWidget: vi.fn(),
}));

import * as fs from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerPlanTool } from "../tool.js";
import { type PlanState, createPlanCtx, DEFAULT_PLAN_STATE, PLAN_MODE_TOOLS } from "../state.js";

const ALL_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "plan", "write", "edit"];

function setup(skillCommands: Array<{ name: string; path: string }> = []) {
  const planCtx = createPlanCtx();
  let executeFn: (id: string, p: Record<string, unknown>, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: { action: string; requirement?: string; skills?: string[] };
  }>;
  const pi = {
    registerTool: vi.fn((tool) => { executeFn = tool.execute; }),
    appendEntry: vi.fn(),
    setActiveTools: vi.fn(),
    // 快照式恢复（dmg-r1-2）：enter 收拢前记录进入前激活集（getActiveTools）
    getActiveTools: vi.fn(() => ALL_TOOL_NAMES.filter((n) => n !== "plan")),
    sendMessage: vi.fn(),
    getCommands: vi.fn(() => skillCommands.map((c) => ({ name: c.name, source: "skill", sourceInfo: { path: c.path } }))),
    getAllTools: vi.fn(() => ALL_TOOL_NAMES.map((n) => ({ name: n }))),
  } as unknown as ExtensionAPI;
  registerPlanTool(pi, planCtx);

  const ctx = {
    sessionId: "test-session",
    cwd: "/tmp/test-project",
    hasUI: true,
    mode: "tui" as const,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "test-session", getLeafId: () => null, getEntries: () => [] },
    ui: { select: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;

  const exec = (params: Record<string, unknown>, signal?: AbortSignal) =>
    executeFn!("tc0", params, signal, undefined, ctx);
  return { pi, planCtx, sessions: planCtx.states, ctx, exec };
}

describe("plan(action='enter') — agent 自助进入（plan-mode-agent-enter U1）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks 不清 mockImplementation——mkdirSync 的 EEXIST/EACCES 抛错实现
    // 会跨用例泄漏，显式 reset 回无实现桩
    vi.mocked(fs.mkdirSync).mockReset();
  });

  it("idle 进入：收工具到白名单 + 持久化 isActive=true + tool result 携带只读纪律提示词", async () => {
    const { exec, pi, planCtx, sessions } = setup();
    const res = await exec({ action: "enter", requirement: "重构 auth 模块" });

    // 工具收拢到 plan 白名单
    expect(pi.setActiveTools).toHaveBeenCalledWith(PLAN_MODE_TOOLS);
    // 快照式恢复记录侧（dmg-r1-2）：收拢前记录进入前激活集（getActiveTools 原样），
    // 退出按它还原——不按 exposure 档位重建（tool_search 实装 model-only +
    // defaultActive:false，重建会点名激活它）
    expect(planCtx.toolSnapshots.get("test-session")).toEqual(ALL_TOOL_NAMES.filter((n) => n !== "plan"));
    // 状态持久化 isActive=true（派生视图链驱动 GUI 显形的锚点）
    expect(pi.appendEntry).toHaveBeenCalledWith("plan-state", expect.objectContaining({ isActive: true }));
    // 目录落盘（原子唯一性）：plansRoot 父目录 recursive 建立 + 候选目录非 recursive
    // mkdir 独占创建（已被占用抛 EEXIST 重探）
    expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp/test-project/.tmp/plans", { recursive: true });
    expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp/test-project/.tmp/plans/auth");
    // 提示词经 tool result 直返（不经对话流消息注入——对本次调用的直接响应）
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(res.details.action).toBe("enter");
    expect(res.content[0].text).toContain("[PLAN MODE] Entered plan mode");
    expect(res.content[0].text).toContain("READ-ONLY");
    // 状态对象已是激活态
    const state = sessions.get("test-session") as { isActive?: boolean; requirement?: string };
    expect(state.isActive).toBe(true);
    // 状态写走 transition()：idle --enter--> planning 落盘（新会话缺省态进入；原独立
    // 用例的转移断言并入——同通道同断言字段，仅转移源字面量与下方坏格用例不同）
    const lastEntry = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as PlanState;
    expect(lastEntry.state).toBe("planning");
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

  it("新轮次进入：上轮残留的 selfReview/resumeHint/指纹随进入失效（clearRoundFields 单函数出口的 enter 调用点，D9①防跨轮误触新鲜度门）", async () => {
    const { exec, pi, sessions } = setup();
    // 模拟上轮残留：崩溃/bad-response 等绕过 resetPlanState 的路径留下的降级标记与基线
    sessions.set("test-session", {
      ...DEFAULT_PLAN_STATE,
      isActive: false,
      state: "exited",
      selfReview: "stale self-review",
      resumeHint: "resubmit",
      lastSubmitReviewDocsFingerprint: "old.md:3",
    });

    const res = await exec({ action: "enter", requirement: "new round" });

    expect(res.details.action).toBe("enter");
    // activatePlanMode 经 clearRoundFields 清三字段（D4 单函数出口，与 resetPlanState 同源）
    const state = sessions.get("test-session") as PlanState;
    expect(state.selfReview).toBeUndefined();
    expect(state.resumeHint).toBeUndefined();
    expect(state.lastSubmitReviewDocsFingerprint).toBeUndefined();
    // enter 边落盘（exited --enter--> planning 新一轮）；entry 无残留字段
    const lastEntry = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as PlanState;
    expect(lastEntry.state).toBe("planning");
    expect(lastEntry.resumeHint).toBeUndefined();
  });

  it("坏数据格（isActive=false 且 state 落活跃族）：enter 按转移 ok:false 落穿，不归一不重试（坏格自愈分支已删，C1 行为变更组——仅坏格可达，行为差锚）", async () => {
    const { exec, pi, sessions } = setup();
    // 手改 session 文件可达的坏格：isActive=false 却残留活跃族 state（reviewing）
    sessions.set("test-session", {
      ...DEFAULT_PLAN_STATE,
      isActive: false,
      state: "reviewing",
    });

    await exec({ action: "enter", requirement: "on a corrupt cell" });

    // 落穿：不归一 idle 再进——state 保持坏值（reviewing --enter--> 非 ok），进入副作用
    // 照常（isActive=true 已置、persist 携带现值）
    const state = sessions.get("test-session") as PlanState;
    expect(state.isActive).toBe(true);
    expect(state.state).toBe("reviewing");
    const lastEntry = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as PlanState;
    expect(lastEntry.state).toBe("reviewing");
    expect(lastEntry.isActive).toBe(true);
  });

  it("纯中文需求两轮进入不互覆：slug 折叠空串回落 untitled，第二轮候选位被占（mkdir 抛 EEXIST）重探落 untitled-2", async () => {
    const { exec, sessions } = setup();
    // 原子 mkdir 语义模拟：untitled 目录已被占用 → mkdirSync 抛 EEXIST（existsSync
    // 预探已退役，冲突信号由 mkdir 自身承载——TOCTOU 竞态修复的机制锚）
    let untitledTaken = false;
    vi.mocked(fs.mkdirSync).mockImplementation(((p: fs.PathLike) => {
      if (untitledTaken && String(p).endsWith("/.tmp/plans/untitled")) {
        throw Object.assign(new Error("EEXIST: file already exists, mkdir"), { code: "EEXIST" });
      }
      return undefined;
    }) as typeof fs.mkdirSync);

    // 第一轮：目录不存在 → 落 untitled
    await exec({ action: "enter", requirement: "重构认证模块" });
    expect((sessions.get("test-session") as PlanState).planFilePath).toBe(
      "/tmp/test-project/.tmp/plans/untitled/plan.md",
    );

    // 终局本轮（exited --enter--> 新一轮），untitled 目录已在盘上 = 第一轮已落盘
    const state = sessions.get("test-session") as PlanState;
    state.isActive = false;
    state.state = "exited";
    untitledTaken = true;

    await exec({ action: "enter", requirement: "重构登录模块" });

    // 第二轮经 EEXIST 重探落 untitled-2：两轮 plan.md 路径不同，不互覆
    expect((sessions.get("test-session") as PlanState).planFilePath).toBe(
      "/tmp/test-project/.tmp/plans/untitled-2/plan.md",
    );
  });

  it("英文 slug 冲突递增（EEXIST 驱动）：base 与 -2 均被占用 → 落 -3", async () => {
    const { exec } = setup();
    vi.mocked(fs.mkdirSync).mockImplementation(((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes("implement-user-auth") && !s.endsWith("implement-user-auth-3")) {
        throw Object.assign(new Error("EEXIST: file already exists, mkdir"), { code: "EEXIST" });
      }
      return undefined;
    }) as typeof fs.mkdirSync);

    await exec({ action: "enter", requirement: "Implement User Auth" });

    const mkdirCalls = (fs.mkdirSync as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    expect(mkdirCalls.at(-1)?.[0]).toBe("/tmp/test-project/.tmp/plans/implement-user-auth-3");
  });

  it("非 EEXIST 的 mkdir 失败照常上抛（fail-fast，不吞真实故障）", async () => {
    const { exec } = setup();
    vi.mocked(fs.mkdirSync).mockImplementation((() => {
      throw Object.assign(new Error("EACCES: permission denied, mkdir"), { code: "EACCES" });
    }) as typeof fs.mkdirSync);

    await expect(exec({ action: "enter", requirement: "r" })).rejects.toThrow(/EACCES/);
  });

  it("空需求（requirement 省略）走 untitled 目录", async () => {
    const { exec, sessions } = setup();

    const res = await exec({ action: "enter" });

    expect(res.details.action).toBe("enter");
    expect((sessions.get("test-session") as PlanState).planFilePath).toBe(
      "/tmp/test-project/.tmp/plans/untitled/plan.md",
    );
  });
});
