import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PLAN_STATE,
  freshAbortController,
  getPlanState,
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
            data: { isActive: true, phase: "writing", planFilePath: ".taiji-harness/test/plan.md", requirement: "test", templateName: "feature-plan" },
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
  it("persistPlanState calls appendEntry with all eight fields (no phase field — D6)", () => {
    const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const state: PlanState = {
      isActive: true,
      planFilePath: ".taiji-harness/test/plan.md",
      requirement: "test requirement",
      templateName: "feature-plan",
      skills: ["tech-design"],
      docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 2 }],
      reviewState: "awaiting",
    };

    persistPlanState(mockPi, state);

    // 精确匹配：新写的 plan-state entry 为八字段 schema（D1：四现状 + skills/docs/reviewState
    // + lastSubmitReviewDocsFingerprint）；无既往提交时指纹字段为 undefined（JSON 序列化自然消失）
    expect(mockPi.appendEntry).toHaveBeenCalledWith("plan-state", {
      isActive: true,
      planFilePath: ".taiji-harness/test/plan.md",
      requirement: "test requirement",
      templateName: "feature-plan",
      skills: ["tech-design"],
      docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 2 }],
      reviewState: "awaiting",
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
              planFilePath: ".taiji-harness/auth/plan.md",
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
              planFilePath: ".taiji-harness/legacy/plan.md",
              requirement: "legacy",
              templateName: "feature-plan",
            },
          },
        ],
      },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(state.isActive).toBe(true);
    expect(state.planFilePath).toBe(".taiji-harness/legacy/plan.md");
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
              planFilePath: ".taiji-harness/legacy/plan.md",
              requirement: "legacy",
              templateName: "feature-plan",
            },
          },
        ],
      },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(Object.keys(state).sort()).toEqual(["docs", "isActive", "lastSubmitReviewDocsFingerprint", "planFilePath", "requirement", "reviewState", "skills", "templateName", "templateProvidedPath"]);
    expect(state.isActive).toBe(true);
  });

  it("lastSubmitReviewDocsFingerprint persists and reconstructs (E3 重挂恢复)；非 string 值按无既往提交丢弃", () => {
    const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const state: PlanState = {
      isActive: true,
      planFilePath: ".taiji-harness/auth/plan.md",
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
});

describe("resetPlanState 终态矩阵（D5/E10）", () => {
  function setupActiveSession() {
    const sessions: PlanSessionMap = new Map();
    const mockCtx = {
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionContext;
    sessions.set("session-1", {
      isActive: true,
      planFilePath: ".taiji-harness/auth/plan.md",
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
