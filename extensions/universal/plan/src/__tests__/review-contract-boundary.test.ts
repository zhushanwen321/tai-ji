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
  PLAN_REVIEW_MARKER,
  PLAN_SELF_REVIEW_MAX_BYTES,
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

// ── 契约纯函数（error envelope / boundary 帧 / truncateSelfReview）的 canonical 测试
// 在 packages/extension-protocol/src/extensions/plan/review-contract.test.ts（更强版本：
// 键剥除结构断言 / 4KB 字节界精确锚 / 刁钻样本超集）——本文件只保留经 tool 消费面的
// 接线契约，不重复测共享逻辑。──

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

});
