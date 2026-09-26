import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock typebox / pi-ai before importing tool（形态照 review.test.ts）
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

vi.mock("../execution-notice.js", async () => {
  const { GOAL_FAILURE_RECOVERY } = await vi.importActual<typeof import("../execution-notice.js")>("../execution-notice.js");
  return {
    handlePlanComplete: vi.fn(),
    GOAL_FAILURE_RECOVERY,
  };
});

vi.mock("../widget.js", () => ({ updatePlanWidget: vi.fn() }));
// importActual 展开：只覆写 detectExecSkills（不扫真实目录），其余导出（含 enter.ts
// re-export 的 resolveSkills 执行门禁）走真实现——mock 罩全模块会把它一并变 undefined
vi.mock("@zhushanwen/pi-exec-skills", async () => {
  const actual = await vi.importActual<typeof import("@zhushanwen/pi-exec-skills")>(
    "@zhushanwen/pi-exec-skills",
  );
  return { ...actual, detectExecSkills: vi.fn(() => []) };
});

import {
  isPlanReviewRequest,
  isPlanReviewResponse,
  parsePlanReviewResponse,
  PLAN_REVIEW_MARKER,
  PLAN_SELF_REVIEW_MAX_BYTES,
  truncateSelfReview,
} from "@zhushanwen/extension-protocol";

import type { PlanState } from "../state.js";
import { createPlanCtx, DEFAULT_PLAN_STATE } from "../state.js";
import { registerPlanTool } from "../tool.js";

const ALL_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "plan", "ask_user", "write", "edit"];

function planningState(): PlanState {
  return {
    ...DEFAULT_PLAN_STATE,
    isActive: true,
    planFilePath: "/tmp/test-project/.tmp/plans/auth/plan.md",
    requirement: "refactor auth",
    docs: [{ fileName: "design.md", absPath: "/tmp/test-project/.tmp/plans/auth/design.md", sourceSkill: "", version: 1 }],
    state: "planning",
  };
}

function setup() {
  const planCtx = createPlanCtx();
  let executeFn: (id: string, p: Record<string, unknown>, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<unknown>;
  const pi = {
    registerTool: vi.fn((tool) => { executeFn = tool.execute; }),
    appendEntry: vi.fn(),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
    getCommands: vi.fn(() => []),
    getAllTools: vi.fn(() => ALL_TOOL_NAMES.map((n) => ({ name: n }))),
  } as unknown as Parameters<typeof registerPlanTool>[0];
  registerPlanTool(pi, planCtx);

  const ctx = {
    sessionId: "test-session",
    cwd: "/tmp/test-project",
    hasUI: true,
    mode: "rpc" as const,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "test-session", getEntries: () => [] },
    ui: { select: vi.fn(), notify: vi.fn() },
  };
  planCtx.states.set("test-session", planningState());

  const exec = (params: Record<string, unknown>) => executeFn!("tc0", params, undefined, undefined, ctx);
  return { pi, ctx, exec };
}

/** 取 marker payload（submit-review select options[0] 解析结果） */
function markerPayload(ctx: { ui: { select: unknown } }): unknown {
  const calls = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls;
  const markerCall = calls.find((c) => c[0] === PLAN_REVIEW_MARKER);
  return JSON.parse((markerCall![1] as string[])[0]);
}

beforeEach(() => {
  vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── 契约纯函数：error envelope + boundary 帧（canonical = review-contract.ts，consumers.md ⑤）──

describe("error envelope（parsePlanReviewResponse 双分源）", () => {
  it("ok 归一化：approve/dismiss 剥多余键（结构上不可混带评论），revise 逐项归一", () => {
    expect(parsePlanReviewResponse({ decision: "approve", comments: [{ quote: "x", comment: "y" }] })).toEqual({
      ok: true,
      response: { decision: "approve" },
    });
    expect(parsePlanReviewResponse({ decision: "dismiss", comments: [] })).toEqual({
      ok: true,
      response: { decision: "dismiss" },
    });
    expect(parsePlanReviewResponse({ decision: "revise", comments: [{ quote: "q", comment: "c" }] })).toEqual({
      ok: true,
      response: { decision: "revise", comments: [{ quote: "q", comment: "c" }] },
    });
  });

  it("unknown-decision：合法形状、值域外（4 代表值）→ 版本错配枚举而非垃圾", () => {
    for (const decision of ["explain", "EXPIRE", "", "dismiss-all"]) {
      expect(parsePlanReviewResponse({ decision })).toEqual({ ok: false, code: "unknown-decision", decision });
      expect(isPlanReviewResponse({ decision })).toBe(false);
    }
  });

  it("空载荷（9 形态）→ malformed", () => {
    for (const bad of [undefined, null, 0, "", "x", [], {}, { decision: 42 }, { decision: null }]) {
      expect(parsePlanReviewResponse(bad)).toEqual({ ok: false, code: "malformed" });
    }
  });

  it("非法形态（revise 评论项坏形状）→ malformed", () => {
    for (const bad of [
      { decision: "revise" },
      { decision: "revise", comments: "x" },
      { decision: "revise", comments: [{}] },
      { decision: "revise", comments: [{ quote: 1, comment: "c" }] },
      { decision: "revise", comments: [{ quote: "q", comment: null }] },
      { decision: "revise", comments: [null] },
    ]) {
      expect(parsePlanReviewResponse(bad)).toEqual({ ok: false, code: "malformed" });
    }
  });
});

describe("boundary 帧（PlanReviewRequest 入站守卫 + selfReview 有界截断）", () => {
  it("空载荷/非法形态 request 全拒（不 throw）", () => {
    for (const bad of [undefined, null, 42, "x", [], {}, { docs: "x" }, { docs: [{}] }, { docs: [{ fileName: "a" }] }, { docs: [], selfReview: 42 }]) {
      expect(isPlanReviewRequest(bad)).toBe(false);
    }
  });

  it("合法 request（含 selfReview 缺省 = 旧扩展兼容契约）全过", () => {
    const doc = { fileName: "a.md", absPath: "/p/a.md", sourceSkill: "", version: 1 };
    expect(isPlanReviewRequest({ docs: [doc] })).toBe(true);
    expect(isPlanReviewRequest({ docs: [doc], selfReview: "" })).toBe(true);
  });

  it("truncateSelfReview 超限截断：UTF-8 字节界安全（多字节字符不截半），4KB 上限唯一权威", () => {
    expect(truncateSelfReview("short")).toBe("short");
    // 恰好预算内的全 ASCII：不截
    expect(truncateSelfReview("x".repeat(PLAN_SELF_REVIEW_MAX_BYTES))).toHaveLength(PLAN_SELF_REVIEW_MAX_BYTES);
    // 超长全多字节（每个 3 字节）：按字节预算截到完整码点边界，无替换字符
    const multi = "好".repeat(PLAN_SELF_REVIEW_MAX_BYTES); // 3B × N
    const capped = truncateSelfReview(multi);
    expect(capped.length).toBeLessThan(multi.length);
    expect(capped).not.toContain("\uFFFD");
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(PLAN_SELF_REVIEW_MAX_BYTES);
    expect(PLAN_SELF_REVIEW_MAX_BYTES - Buffer.byteLength(capped, "utf8")).toBeLessThan(3);
  });
});

// ── 经 tool 消费面的契约落地（consumers.md ①③：payload 构造单点 + 双分源降级）──

describe("契约经 executeSubmitReview 消费面落地", () => {
  it("超限 selfReview：payload 构造单点截断（写侧 4KB），且产出 payload 过入站守卫（boundary 帧合法）", async () => {
    const { ctx, exec } = setup();
    const oversized = "自审".repeat(PLAN_SELF_REVIEW_MAX_BYTES); // 远超 4KB
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ decision: "dismiss" }));

    await exec({ action: "submit-review", selfReview: oversized });

    const payload = markerPayload(ctx) as { selfReview: string };
    expect(Buffer.byteLength(payload.selfReview, "utf8")).toBeLessThanOrEqual(PLAN_SELF_REVIEW_MAX_BYTES);
    // 截断后仍是合法 boundary 帧（消费侧守卫必过）
    expect(isPlanReviewRequest(payload)).toBe(true);
  });

  it("条目 7 降级：unknown decision 与 malformed 同款出口 → 'bad-response' 引导重挂；非 JSON → 同款（值域外分源仅 warn 留痕差异）", async () => {
    const a = setup();
    (a.ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ decision: "explain" }));
    const unknownRes = await a.exec({ action: "submit-review", selfReview: "fresh." });
    expect(unknownRes.details).toEqual({ action: "review-error", reason: "bad-response" });
    expect(unknownRes.content[0].text).toContain("re-hang");

    const b = setup();
    (b.ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ decision: "revise", comments: "bad" }));
    const malformedRes = await b.exec({ action: "submit-review", selfReview: "fresh." });
    expect(malformedRes.details).toEqual({ action: "review-error", reason: "bad-response" });
    expect(malformedRes.content[0].text).toContain("re-hang");

    const c = setup();
    (c.ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("not json at all");
    const nonJsonRes = await c.exec({ action: "submit-review", selfReview: "fresh." });
    expect(nonJsonRes.details).toEqual({ action: "review-error", reason: "bad-response" });
    expect(nonJsonRes.content[0].text).toContain("re-hang");
  });
});
