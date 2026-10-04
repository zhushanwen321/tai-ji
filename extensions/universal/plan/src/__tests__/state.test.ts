import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  capPlanRequirement,
  DEFAULT_PLAN_STATE,
  freshAbortController,
  getPlanState,
  MAX_PLAN_REQUIREMENT_LENGTH,
  persistPlanState,
  type PlanAbortControllers,
  type PlanSessionMap,
  type PlanState,
  reconstructPlanState,
  resetPlanState,
} from "../state.js";

describe("PlanState", () => {
  it("DEFAULT_PLAN_STATE has correct defaults", () => {
    expect(DEFAULT_PLAN_STATE.isActive).toBe(false);
    expect(DEFAULT_PLAN_STATE.planFilePath).toBe("");
    expect(DEFAULT_PLAN_STATE.requirement).toBe("");
    expect(DEFAULT_PLAN_STATE.templateName).toBe("");
    expect(DEFAULT_PLAN_STATE.skills).toEqual([]);
    expect(DEFAULT_PLAN_STATE.docs).toEqual([]);
    expect(DEFAULT_PLAN_STATE.reviewState).toBeUndefined();
    expect(DEFAULT_PLAN_STATE.reviewStateSource).toBeUndefined();
  });

  it("getPlanState returns cached state if exists", () => {
    const sessions: PlanSessionMap = new Map();
    const cached: PlanState = { ...DEFAULT_PLAN_STATE, isActive: true };
    sessions.set("session-1", cached);

    const mockCtx = {
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionContext;

    const result = getPlanState(sessions, "session-1", mockCtx);
    expect(result).toBe(cached);
  });

  it("getPlanState reconstructs from sessionManager if not cached", () => {
    const sessions: PlanSessionMap = new Map();
    const mockCtx = {
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "plan-state",
            data: { isActive: true, phase: "writing", planFilePath: ".tmp/plans/test/plan.md", requirement: "test", templateName: "feature-plan" },
          },
        ],
      },
    } as unknown as ExtensionContext;

    const result = getPlanState(sessions, "session-2", mockCtx);
    expect(result.isActive).toBe(true);
    expect(sessions.get("session-2")).toBe(result);
  });
});

describe("State persistence", () => {
  it("persistPlanState calls appendEntry with the full schema (no phase field — D6)", () => {
    const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const state: PlanState = {
      isActive: true,
      planFilePath: ".tmp/plans/test/plan.md",
      requirement: "test requirement",
      templateName: "feature-plan",
      skills: ["tech-design"],
      docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 2 }],
      reviewState: "awaiting",
    };

    persistPlanState(mockPi, state);

    // 精确匹配：新写的 plan-state entry 为全字段 schema（D1：四现状 + skills/docs/reviewState
    // + reviewStateSource + lastSubmitReviewDocsFingerprint）；无值 optional 字段为 undefined
    // （JSON 序列化自然消失——D4）
    expect(mockPi.appendEntry).toHaveBeenCalledWith("plan-state", {
      isActive: true,
      planFilePath: ".tmp/plans/test/plan.md",
      requirement: "test requirement",
      templateName: "feature-plan",
      skills: ["tech-design"],
      docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 2 }],
      reviewState: "awaiting",
      reviewStateSource: undefined,
      lastSubmitReviewDocsFingerprint: undefined,
    });
  });

  it("reconstructPlanState returns DEFAULT_PLAN_STATE when no entries", () => {
    const mockCtx = {
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(state).toEqual(DEFAULT_PLAN_STATE);
  });

  it("reconstructPlanState restores the full new-schema state from entries (D1)", () => {
    const mockCtx = {
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "plan-state",
            data: {
              isActive: true,
              planFilePath: ".tmp/plans/auth/plan.md",
              requirement: "auth",
              templateName: "",
              skills: ["tech-design", "dev-flow"],
              docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 1 }],
              reviewState: "awaiting",
            },
          },
        ],
      },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(state.isActive).toBe(true);
    expect(state.skills).toEqual(["tech-design", "dev-flow"]);
    expect(state.docs).toEqual([
      { fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 1 },
    ]);
    expect(state.reviewState).toBe("awaiting");
  });

  it("old four-field entries (no new fields) reconstruct with field-level fallback (D4 兼容读)", () => {
    const mockCtx = {
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "plan-state",
            data: {
              isActive: true,
              phase: "brainstorming",
              planFilePath: ".tmp/plans/legacy/plan.md",
              requirement: "legacy",
              templateName: "feature-plan",
            },
          },
        ],
      },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(state.isActive).toBe(true);
    expect(state.planFilePath).toBe(".tmp/plans/legacy/plan.md");
    // 新字段降级为空清单/无值（前端据此显示「（未指定）」+ 单文件形态）
    expect(state.skills).toEqual([]);
    expect(state.docs).toEqual([]);
    expect(state.reviewState).toBeUndefined();
  });

  it("malformed new-field values are dropped, not propagated (垃圾数据不进内存态)", () => {
    const mockCtx = {
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "plan-state",
            data: {
              isActive: true,
              planFilePath: "/p/plan.md",
              requirement: "",
              templateName: "",
              skills: ["ok", 42, null],
              docs: [{ fileName: "good.md", absPath: "/p/good.md", sourceSkill: "", version: 1 }, "junk", { bad: true }],
              reviewState: "corrupted",
            },
          },
        ],
      },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(state.skills).toEqual(["ok"]);
    expect(state.docs).toEqual([
      { fileName: "good.md", absPath: "/p/good.md", sourceSkill: "", version: 1 },
    ]);
    expect(state.reviewState).toBeUndefined();
  });

  it("reconstructPlanState ignores the legacy phase field in old entries (D6 兼容读 — V5②)", () => {
    // 旧版（含 phase）写的 entry：重开后 plan mode 重建正常，phase 被白名单式读取自然忽略
    const mockCtx = {
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "plan-state",
            data: {
              isActive: true,
              phase: "brainstorming",
              planFilePath: ".tmp/plans/legacy/plan.md",
              requirement: "legacy",
              templateName: "feature-plan",
            },
          },
        ],
      },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(Object.keys(state).sort()).toEqual(["docs", "isActive", "lastSubmitReviewDocsFingerprint", "planFilePath", "requirement", "reviewState", "reviewStateSource", "skills", "templateName", "templateProvidedPath"]);
    expect(state.isActive).toBe(true);
  });

  it("lastSubmitReviewDocsFingerprint persists and reconstructs (E3 重挂恢复)；非 string 值按无既往提交丢弃", () => {
    const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const state: PlanState = {
      isActive: true,
      planFilePath: ".tmp/plans/auth/plan.md",
      requirement: "auth",
      templateName: "",
      skills: [],
      docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "", version: 1 }],
      reviewState: "awaiting",
      lastSubmitReviewDocsFingerprint: "design.md:1",
    };

    persistPlanState(mockPi, state);

    // 用持久化 entry 走冷启动重建（E3：submit-review 崩溃 → 重开 session 后恢复快照，
    // 重提交无变化检测仍能比对到上次基线）
    const persisted = (mockPi.appendEntry as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const reopenCtx = {
      sessionManager: { getEntries: () => [{ type: "custom", customType: "plan-state", data: persisted }] },
    } as unknown as ExtensionContext;
    expect(reconstructPlanState(reopenCtx).lastSubmitReviewDocsFingerprint).toBe("design.md:1");

    // 垃圾数据不进内存态：非 string 指纹按无既往提交处理（不警告语义）
    const badCtx = {
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "plan-state",
            data: { ...persisted, lastSubmitReviewDocsFingerprint: 42 },
          },
        ],
      },
    } as unknown as ExtensionContext;
    expect(reconstructPlanState(badCtx).lastSubmitReviewDocsFingerprint).toBeUndefined();
  });

  it("reviewStateSource persists and reconstructs；旧 entry 无字段 / 非法值 / 旧 'explain' 存量值按无值处理（D4 兼容读）", () => {
    const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const state: PlanState = {
      isActive: true,
      planFilePath: ".tmp/plans/auth/plan.md",
      requirement: "auth",
      templateName: "",
      skills: [],
      docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "", version: 1 }],
      reviewState: "awaiting",
      reviewStateSource: "resubmit",
    };

    persistPlanState(mockPi, state);

    // 持久化 entry 走冷启动重建：resubmit 等待态跨重开可恢复（E3 重挂同款受益）
    const persisted = (mockPi.appendEntry as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const reopenCtx = {
      sessionManager: { getEntries: () => [{ type: "custom", customType: "plan-state", data: persisted }] },
    } as unknown as ExtensionContext;
    expect(reconstructPlanState(reopenCtx).reviewStateSource).toBe("resubmit");

    // 旧 entry（升级前落盘）无该字段：reviewState 有值但无来源 → 无值（renderer 渲染通用降级文案）
    const legacyCtx = {
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "plan-state",
            data: { isActive: true, planFilePath: "/p/plan.md", requirement: "r", templateName: "", reviewState: "awaiting" },
          },
        ],
      },
    } as unknown as ExtensionContext;
    expect(reconstructPlanState(legacyCtx).reviewStateSource).toBeUndefined();

    // 旧版 'explain' 存量值（explain 交互已删）与垃圾值一并按无值处理（值域守卫白名单只认 'resubmit'）
    const explainCtx = {
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "plan-state", data: { ...persisted, reviewStateSource: "explain" } },
        ],
      },
    } as unknown as ExtensionContext;
    expect(reconstructPlanState(explainCtx).reviewStateSource).toBeUndefined();

    // 值域守卫：'resubmit' 之外的垃圾值按无值处理（与 readReviewState 同风格）
    const badCtx = {
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "plan-state", data: { ...persisted, reviewStateSource: "bogus" } },
        ],
      },
    } as unknown as ExtensionContext;
    expect(reconstructPlanState(badCtx).reviewStateSource).toBeUndefined();
  });
});

describe("resetPlanState 终态矩阵（D5/E10）", () => {
  function setupActiveSession() {
    const sessions: PlanSessionMap = new Map();
    const mockCtx = {
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionContext;
    sessions.set("session-1", {
      isActive: true,
      planFilePath: ".tmp/plans/auth/plan.md",
      requirement: "refactor auth",
      templateName: "feature-plan",
      skills: ["tech-design", "dev-flow"],
      docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 2 }],
      reviewState: "awaiting",
    });
    const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    return { sessions, mockCtx, mockPi };
  }

  it("isActive=false + reviewState cleared + skills cleared + docs KEPT", () => {
    const { sessions, mockCtx, mockPi } = setupActiveSession();

    const state = resetPlanState(mockPi, sessions, "session-1", mockCtx);

    expect(state.isActive).toBe(false);
    expect(state.reviewState).toBeUndefined();
    expect(state.skills).toEqual([]);
    // docs 保留：产物 tab 与 isActive 解耦，执行期/退出后都可回看产物
    expect(state.docs).toEqual([
      { fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 2 },
    ]);
  });

  it("reset entry persists the terminal matrix and the session cache is cleaned up", () => {
    const { sessions, mockCtx, mockPi } = setupActiveSession();

    resetPlanState(mockPi, sessions, "session-1", mockCtx);

    expect(mockPi.appendEntry).toHaveBeenCalledWith("plan-state", {
      isActive: false,
      planFilePath: "",
      requirement: "",
      templateName: "",
      skills: [],
      docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 2 }],
      reviewState: undefined,
    });
    expect(sessions.has("session-1")).toBe(false);
  });

  it("reset entry persisted → reopen reconstructs docs from it (产物 tab 跨重开留存)", () => {
    const { sessions, mockCtx, mockPi } = setupActiveSession();
    resetPlanState(mockPi, sessions, "session-1", mockCtx);

    // 模拟重开：用 reset 落盘的 entry 数据走冷启动重建
    const persisted = (mockPi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    const reopenCtx = {
      sessionManager: { getEntries: () => [{ type: "custom", customType: "plan-state", data: persisted }] },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(reopenCtx);
    expect(state.isActive).toBe(false);
    expect(state.docs).toEqual([
      { fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 2 },
    ]);
    expect(state.skills).toEqual([]);
  });

  it("fingerprint snapshot is cleared on reset (新 plan 轮次从无既往提交重新计数)", () => {
    const { sessions, mockCtx, mockPi } = setupActiveSession();
    const active = sessions.get("session-1");
    if (!active) throw new Error("setupActiveSession must seed session-1");
    active.lastSubmitReviewDocsFingerprint = "design.md:2";

    const state = resetPlanState(mockPi, sessions, "session-1", mockCtx);

    // 指纹随退出失效（同 reviewState 同款 delete）；docs 保留不影响——
    // 保留的 docs 不作为下一轮检测基线，reset 后首次 submit-review 不警告
    expect(state.lastSubmitReviewDocsFingerprint).toBeUndefined();
    expect(state.docs).toHaveLength(1);
  });
  it("reviewStateSource is cleared on reset (跨 plan run 残留防护，C-U2 同型缺陷)", () => {
    const { sessions, mockCtx, mockPi } = setupActiveSession();
    const active = sessions.get("session-1");
    if (!active) throw new Error("setupActiveSession must seed session-1");
    active.reviewStateSource = "resubmit";

    const state = resetPlanState(mockPi, sessions, "session-1", mockCtx);

    // 来源标记与 reviewState 同生命周期随退出失效；reset entry 落盘同样无该键
    // （undefined JSON 序列化自然消失——D4）
    expect(state.reviewStateSource).toBeUndefined();
    const lastEntry = (mockPi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as PlanState;
    expect(lastEntry.reviewStateSource).toBeUndefined();
  });

  describe("空 slug 目录清理（P3-10）", () => {
    const tmpRoots: string[] = [];

    function makePlanRoot(withFile: boolean): string {
      const root = mkdtempSync(join(tmpdir(), "plan-state-test-"));
      tmpRoots.push(root);
      const slugDir = join(root, "my-slug");
      mkdirSync(slugDir);
      if (withFile) writeFileSync(join(slugDir, "notes.txt"), "leftover");
      return join(slugDir, "plan.md");
    }

    afterEach(() => {
      while (tmpRoots.length > 0) {
        const root = tmpRoots.pop();
        if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    });

    it("未产文档即退出：空 slug 目录随 reset 删除", () => {
      const planFilePath = makePlanRoot(false);
      const slugDir = join(planFilePath, "..");
      const sessions: PlanSessionMap = new Map();
      const mockCtx = { sessionManager: { getEntries: () => [] } } as unknown as ExtensionContext;
      sessions.set("s1", { ...DEFAULT_PLAN_STATE, isActive: true, planFilePath, requirement: "r", templateName: "", skills: [], docs: [] });
      const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;

      resetPlanState(mockPi, sessions, "s1", mockCtx);

      expect(existsSync(slugDir)).toBe(false);
    });

    it("目录有残留文件：保留不删（保守，不做递归删除）", () => {
      const planFilePath = makePlanRoot(true);
      const slugDir = join(planFilePath, "..");
      const sessions: PlanSessionMap = new Map();
      const mockCtx = { sessionManager: { getEntries: () => [] } } as unknown as ExtensionContext;
      sessions.set("s1", { ...DEFAULT_PLAN_STATE, isActive: true, planFilePath, requirement: "r", templateName: "", skills: [], docs: [] });
      const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;

      resetPlanState(mockPi, sessions, "s1", mockCtx);

      expect(existsSync(slugDir)).toBe(true);
    });
  });
});

describe("freshAbortController（E10 生命周期）", () => {
  it("registers the controller per session and creates a fresh one on each call", () => {
    const controllers: PlanAbortControllers = new Map();

    const first = freshAbortController(controllers, "s1");
    expect(controllers.get("s1")).toBe(first);

    // 禁复用：第二次调用必须新建（复用已 abort 的 controller 会让 select 瞬时静默取消）
    const second = freshAbortController(controllers, "s1");
    expect(second).not.toBe(first);
    expect(controllers.get("s1")).toBe(second);
  });
});

describe("requirement 长度封顶（MF-1-3：session.planState 帧不登记 LARGE_FIELD_REGISTRY 的有界前提代码化）", () => {
  it("capPlanRequirement: ≤64KB 原样返回；超长截断 + 省略标记（含被省略字符数）", () => {
    const short = "重构 auth 模块";
    expect(capPlanRequirement(short)).toBe(short);

    // 恰好等于上限：不截断（边界含端）
    const exact = "x".repeat(MAX_PLAN_REQUIREMENT_LENGTH);
    expect(capPlanRequirement(exact)).toBe(exact);

    const long = "y".repeat(MAX_PLAN_REQUIREMENT_LENGTH + 5000);
    const capped = capPlanRequirement(long);
    expect(capped).not.toBe(long);
    expect(capped.length).toBeLessThan(long.length);
    expect(capped.startsWith("y".repeat(MAX_PLAN_REQUIREMENT_LENGTH))).toBe(true);
    expect(capped).toContain("5000 characters omitted");
  });

  it("重建读侧同样封顶：封顶前旧版 entry 的超长 requirement 不整段进内存态（派生帧恒有界）", () => {
    const oversized = "z".repeat(MAX_PLAN_REQUIREMENT_LENGTH * 2);
    const mockCtx = {
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "plan-state", data: { isActive: true, requirement: oversized } },
        ],
      },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(state.requirement.length).toBeLessThan(oversized.length);
    expect(state.requirement).toContain("characters omitted");
  });

  it("非 string requirement（含缺失）仍归空串（白名单读取语义不变）", () => {
    const mockCtx = {
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "plan-state", data: { isActive: false, requirement: 123 } },
        ],
      },
    } as unknown as ExtensionContext;
    expect(reconstructPlanState(mockCtx).requirement).toBe("");
  });
});
