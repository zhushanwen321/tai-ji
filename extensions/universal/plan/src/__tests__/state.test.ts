import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PLAN_SELF_REVIEW_MAX_BYTES } from "@zhushanwen/extension-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  capPlanRequirement,
  DEFAULT_PLAN_STATE,
  freshAbortController,
  getPlanState,
  MAX_PLAN_REQUIREMENT_LENGTH,
  persistPlanState,
  type PlanAbortControllers,
  type PlanResetEpochs,
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
    // D1/D2：缺省态 = 生命周期 'idle'（无 plan）；selfReview/resumeHint 无值
    expect(DEFAULT_PLAN_STATE.state).toBe("idle");
    expect(DEFAULT_PLAN_STATE.selfReview).toBeUndefined();
    expect(DEFAULT_PLAN_STATE.resumeHint).toBeUndefined();
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
  it("persistPlanState calls appendEntry with the full schema (state/selfReview/resumeHint 取代式 — D2；无 phase — D6)", () => {
    const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const state: PlanState = {
      isActive: true,
      planFilePath: ".tmp/plans/test/plan.md",
      requirement: "test requirement",
      templateName: "feature-plan",
      skills: ["tech-design"],
      docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 2 }],
      state: "reviewing",
      selfReview: "covered all 3 requirements",
      resumeHint: "resubmit",
    };

    persistPlanState(mockPi, state);

    // 精确匹配：新写 entry 全字段 schema（D2 取代式——只落 state/resumeHint/selfReview，
    // reviewState/reviewStateSource 停写）；无值 optional 字段为 undefined
    // （JSON 序列化自然消失——D4）
    expect(mockPi.appendEntry).toHaveBeenCalledWith("plan-state", {
      isActive: true,
      planFilePath: ".tmp/plans/test/plan.md",
      requirement: "test requirement",
      templateName: "feature-plan",
      templateProvidedPath: undefined,
      skills: ["tech-design"],
      docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 2 }],
      state: "reviewing",
      selfReview: "covered all 3 requirements",
      resumeHint: "resubmit",
      lastSubmitReviewDocsFingerprint: undefined,
    });
    // 停写断言（取代式演进，D2）：旧键不得回写
    const entry = (mockPi.appendEntry as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect("reviewState" in entry).toBe(false);
    expect("reviewStateSource" in entry).toBe(false);
  });

  it("reconstructPlanState returns DEFAULT_PLAN_STATE when no entries", () => {
    const mockCtx = {
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionContext;

    const state = reconstructPlanState(mockCtx);
    expect(state).toEqual(DEFAULT_PLAN_STATE);
  });

  it("reconstructPlanState restores state/selfReview/resumeHint from new-schema entries (D1/D2)", () => {
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
              state: "dispatching",
              selfReview: "all covered",
              resumeHint: "resubmit",
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
    expect(state.state).toBe("dispatching");
    expect(state.selfReview).toBe("all covered");
    expect(state.resumeHint).toBe("resubmit");
  });

  it("旧 entry 无 state：reviewState 映射（awaiting→reviewing / revising→revising）+ reviewStateSource→resumeHint 同义映射（D2 读方①）", () => {
    const entryFor = (data: Record<string, unknown>) => ({
      sessionManager: {
        getEntries: () => [{ type: "custom", customType: "plan-state", data }],
      },
    }) as unknown as ExtensionContext;

    expect(
      reconstructPlanState(entryFor({ isActive: true, planFilePath: "/p/plan.md", requirement: "r", templateName: "", reviewState: "awaiting" })).state,
    ).toBe("reviewing");
    expect(
      reconstructPlanState(entryFor({ isActive: true, planFilePath: "/p/plan.md", requirement: "r", templateName: "", reviewState: "revising" })).state,
    ).toBe("revising");
    // reviewStateSource:'resubmit' → resumeHint:'resubmit'（同义映射，consumers.md 二①）
    expect(
      reconstructPlanState(entryFor({ isActive: true, planFilePath: "/p/plan.md", requirement: "r", templateName: "", reviewState: "awaiting", reviewStateSource: "resubmit" })).resumeHint,
    ).toBe("resubmit");
    // 新字段优先于旧字段映射（混装过渡格：同 entry 双写形态也取新值）
    expect(
      reconstructPlanState(entryFor({ isActive: true, planFilePath: "/p/plan.md", requirement: "r", templateName: "", state: "approved", reviewState: "awaiting" })).state,
    ).toBe("approved");
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
    // D2 读方①：无 state 无 reviewState → 按 isActive 推断（isActive=true → planning）
    expect(state.state).toBe("planning");
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
              state: "bogus-state",
              selfReview: 42,
              resumeHint: "explain",
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
    // state 值域外垃圾按缺失处理 → 落旧字段映射（reviewState 也坏）→ 按 isActive 推断
    expect(state.state).toBe("planning");
    expect(state.selfReview).toBeUndefined();
    // resumeHint 值域守卫：'resubmit' 之外（含旧 'explain' 存量值）按无值处理
    expect(state.resumeHint).toBeUndefined();
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
    // D2/D9：重建产物键集 = 四现状 + state/selfReview/resumeHint + skills/docs + 指纹
    //（reviewState/reviewStateSource 不再是内存态字段，仅映射读）
    expect(Object.keys(state).sort()).toEqual(["docs", "isActive", "lastSubmitReviewDocsFingerprint", "planFilePath", "requirement", "resumeHint", "selfReview", "skills", "state", "templateName", "templateProvidedPath"]);
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
      state: "reviewing",
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

  it("resumeHint persists and reconstructs（D2）；旧 reviewStateSource 同义映射 / 垃圾值按无值处理", () => {
    const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const state: PlanState = {
      isActive: true,
      planFilePath: ".tmp/plans/auth/plan.md",
      requirement: "auth",
      templateName: "",
      skills: [],
      docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "", version: 1 }],
      state: "reviewing",
      resumeHint: "resubmit",
    };

    persistPlanState(mockPi, state);

    // 持久化 entry 走冷启动重建：resubmit 等待态跨重开可恢复（E3 重挂同款受益）
    const persisted = (mockPi.appendEntry as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const reopenCtx = {
      sessionManager: { getEntries: () => [{ type: "custom", customType: "plan-state", data: persisted }] },
    } as unknown as ExtensionContext;
    expect(reconstructPlanState(reopenCtx).resumeHint).toBe("resubmit");

    // 旧 entry（升级前落盘）无该字段且无旧 reviewStateSource → 无值（renderer 渲染通用降级文案）
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
    expect(reconstructPlanState(legacyCtx).resumeHint).toBeUndefined();

    // 旧版 'explain' 存量值（explain 交互已删）与垃圾值一并按无值处理（值域守卫白名单只认 'resubmit'）
    const explainCtx = {
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "plan-state", data: { ...persisted, resumeHint: "explain" } },
        ],
      },
    } as unknown as ExtensionContext;
    expect(reconstructPlanState(explainCtx).resumeHint).toBeUndefined();

    // 值域守卫：'resubmit' 之外的垃圾值按无值处理（与 readResumeHint 同风格）
    const badCtx = {
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "plan-state", data: { ...persisted, resumeHint: "bogus" } },
        ],
      },
    } as unknown as ExtensionContext;
    expect(reconstructPlanState(badCtx).resumeHint).toBeUndefined();
  });

  it("selfReview 重建读侧 4KB 截断防御（D9③/R3：超长旧 entry 不整段进内存态，E3 回传恒有界）", () => {
    const oversized = "s".repeat(PLAN_SELF_REVIEW_MAX_BYTES + 100);
    const mockCtx = {
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "plan-state", data: { isActive: true, state: "reviewing", selfReview: oversized } },
        ],
      },
    } as unknown as ExtensionContext;
    const restored = reconstructPlanState(mockCtx).selfReview;
    expect(restored).toBeDefined();
    expect(restored!.length).toBeLessThan(oversized.length);
    expect(PLAN_SELF_REVIEW_MAX_BYTES - restored!.length).toBeLessThan(4);
  });
});

describe("resetPlanState 终态矩阵（D5/E10）", () => {
  function setupActiveSession() {
    const sessions: PlanSessionMap = new Map();
    const epochs: PlanResetEpochs = new Map();
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
      state: "reviewing",
      selfReview: "prev self-review",
      resumeHint: "resubmit",
      lastSubmitReviewDocsFingerprint: "design.md:2",
    });
    const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    return { sessions, mockCtx, mockPi, epochs };
  }

  it("isActive=false + state=terminal(exited) + selfReview/resumeHint/指纹 cleared + skills cleared + docs KEPT", () => {
    const { sessions, mockCtx, mockPi, epochs } = setupActiveSession();

    const state = resetPlanState(mockPi, sessions, epochs, "session-1", mockCtx);

    expect(state.isActive).toBe(false);
    // 终态矩阵（D3 连带段）：默认 terminal='exited'
    expect(state.state).toBe("exited");
    // selfReview/resumeHint 随退出失效（resumeHint 清除点三处之一，S15 断言）
    expect(state.selfReview).toBeUndefined();
    expect(state.resumeHint).toBeUndefined();
    expect(state.skills).toEqual([]);
    // docs 保留：产物 tab 与 isActive 解耦，执行期/退出后都可回看产物
    expect(state.docs).toEqual([
      { fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 2 },
    ]);
  });

  it("reset entry persists the terminal matrix and the session cache is cleaned up", () => {
    const { sessions, mockCtx, mockPi, epochs } = setupActiveSession();

    resetPlanState(mockPi, sessions, epochs, "session-1", mockCtx);

    expect(mockPi.appendEntry).toHaveBeenCalledWith("plan-state", {
      isActive: false,
      planFilePath: "",
      requirement: "",
      templateName: "",
      templateProvidedPath: undefined,
      skills: [],
      docs: [{ fileName: "design.md", absPath: "/p/design.md", sourceSkill: "tech-design", version: 2 }],
      state: "exited",
      selfReview: undefined,
      resumeHint: undefined,
      lastSubmitReviewDocsFingerprint: undefined,
    });
    expect(sessions.has("session-1")).toBe(false);
  });

  it("reset entry persisted → reopen reconstructs docs from it (产物 tab 跨重开留存)", () => {
    const { sessions, mockCtx, mockPi, epochs } = setupActiveSession();
    resetPlanState(mockPi, sessions, epochs, "session-1", mockCtx);

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
    const { sessions, mockCtx, mockPi, epochs } = setupActiveSession();
    const active = sessions.get("session-1");
    if (!active) throw new Error("setupActiveSession must seed session-1");
    active.lastSubmitReviewDocsFingerprint = "design.md:2";

    const state = resetPlanState(mockPi, sessions, epochs, "session-1", mockCtx);

    // 指纹随退出失效（同 reviewState 同款 delete）；docs 保留不影响——
    // 保留的 docs 不作为下一轮检测基线，reset 后首次 submit-review 不警告
    expect(state.lastSubmitReviewDocsFingerprint).toBeUndefined();
    expect(state.docs).toHaveLength(1);
  });
  it("terminal 参数（D3 连带段）：complete 终局传 'completed' 不被 reset 覆写为 'exited'", () => {
    const { sessions, mockCtx, mockPi, epochs } = setupActiveSession();

    const state = resetPlanState(mockPi, sessions, epochs, "session-1", mockCtx, "completed");

    expect(state.state).toBe("completed");
    const lastEntry = (mockPi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as PlanState;
    expect(lastEntry.state).toBe("completed");
  });

  it("reset 即递增 epoch（D3：任何调用路径单调递增——归口点世代判别的唯一写侧出口；缺失按 0）", () => {
    const { sessions, mockCtx, mockPi, epochs } = setupActiveSession();
    expect(epochs.get("session-1")).toBeUndefined(); // 缺失按「未变」（纪律②）

    resetPlanState(mockPi, sessions, epochs, "session-1", mockCtx);
    expect(epochs.get("session-1")).toBe(1);

    // 第二次 reset（重建后）继续单调递增（只增不减，无「置位未消费」形态）
    sessions.set("session-1", { ...DEFAULT_PLAN_STATE, isActive: true, state: "planning" });
    resetPlanState(mockPi, sessions, epochs, "session-1", mockCtx);
    expect(epochs.get("session-1")).toBe(2);
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
      const epochs: PlanResetEpochs = new Map();
      const mockCtx = { sessionManager: { getEntries: () => [] } } as unknown as ExtensionContext;
      sessions.set("s1", { ...DEFAULT_PLAN_STATE, isActive: true, planFilePath, requirement: "r", templateName: "", skills: [], docs: [] });
      const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;

      resetPlanState(mockPi, sessions, epochs, "s1", mockCtx);

      expect(existsSync(slugDir)).toBe(false);
    });

    it("目录有残留文件：保留不删（保守，不做递归删除）", () => {
      const planFilePath = makePlanRoot(true);
      const slugDir = join(planFilePath, "..");
      const sessions: PlanSessionMap = new Map();
      const epochs: PlanResetEpochs = new Map();
      const mockCtx = { sessionManager: { getEntries: () => [] } } as unknown as ExtensionContext;
      sessions.set("s1", { ...DEFAULT_PLAN_STATE, isActive: true, planFilePath, requirement: "r", templateName: "", skills: [], docs: [] });
      const mockPi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;

      resetPlanState(mockPi, sessions, epochs, "s1", mockCtx);

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
