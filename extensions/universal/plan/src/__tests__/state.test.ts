import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PLAN_STATE,
  getPlanState,
  persistPlanState,
  type PlanSessionMap,
  type PlanState,
  reconstructPlanState,
} from "../state.js";

describe("PlanState", () => {
  it("DEFAULT_PLAN_STATE has correct defaults", () => {
    expect(DEFAULT_PLAN_STATE.isActive).toBe(false);
    expect(DEFAULT_PLAN_STATE.planFilePath).toBe("");
    expect(DEFAULT_PLAN_STATE.requirement).toBe("");
    expect(DEFAULT_PLAN_STATE.templateName).toBe("");
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
            data: { isActive: true, phase: "writing", planFilePath: ".xyz-harness/test/plan.md", requirement: "test", templateName: "feature-plan" },
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
  it("persistPlanState calls appendEntry with correct data (no phase field — D6)", () => {
    const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const state: PlanState = {
      isActive: true,
      planFilePath: ".xyz-harness/test/plan.md",
      requirement: "test requirement",
      templateName: "feature-plan",
    };

    persistPlanState(mockPi, state);

    // 精确匹配：新写的 plan-state entry 无 phase 字段（V5② 守卫）
    expect(mockPi.appendEntry).toHaveBeenCalledWith("plan-state", {
      isActive: true,
      planFilePath: ".xyz-harness/test/plan.md",
      requirement: "test requirement",
      templateName: "feature-plan",
    });
  });

  it("reconstructPlanState returns DEFAULT_PLAN_STATE when no entries", () => {
    const mockCtx = {
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(state).toEqual(DEFAULT_PLAN_STATE);
  });

  it("reconstructPlanState restores state from entries", () => {
    const mockCtx = {
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "plan-state",
            data: {
              isActive: true,
              phase: "writing",
              planFilePath: ".xyz-harness/test/plan.md",
              requirement: "test",
              templateName: "feature-plan",
            },
          },
        ],
      },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(state.isActive).toBe(true);
    expect(state.planFilePath).toBe(".xyz-harness/test/plan.md");
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
              planFilePath: ".xyz-harness/legacy/plan.md",
              requirement: "legacy",
              templateName: "feature-plan",
            },
          },
        ],
      },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(Object.keys(state).sort()).toEqual(["isActive", "planFilePath", "requirement", "templateName"]);
    expect(state.isActive).toBe(true);
    expect(state.planFilePath).toBe(".xyz-harness/legacy/plan.md");
    expect(state.requirement).toBe("legacy");
    expect(state.templateName).toBe("feature-plan");
  });
});
