import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock typebox before importing tool（形态照 tool.test.ts）
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

vi.mock("../compact.js", async () => {
  const { GOAL_FAILURE_RECOVERY } = await vi.importActual<typeof import("../compact.js")>("../compact.js");
  return {
    handlePlanComplete: vi.fn(),
    detectGoalCapability: vi.fn(() => false),
    GOAL_FAILURE_RECOVERY,
  };
});

vi.mock("../widget.js", () => ({
  updatePlanWidget: vi.fn(),
}));

// Mock exec-skills（D10 检测）：审批用例不扫真实目录，skill 选项恒空
vi.mock("../exec-skills.js", () => ({
  detectExecSkills: vi.fn(() => []),
}));

import { handlePlanComplete } from "../compact.js";
import { PLAN_REVIEW_MARKER } from "@zhushanwen/extension-protocol";
import type { PlanDocMeta } from "@zhushanwen/extension-protocol";
import type { PlanState } from "../state.js";
import { DEFAULT_PLAN_STATE, PLAN_CONTEXT_CUSTOM_TYPE } from "../state.js";
import { PLAN_ACTIONS, registerPlanTool } from "../tool.js";

const ALL_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "plan", "write", "edit"];

/** 已激活且带一份已登记文档的状态（submit-review 的合法前置） */
function activeStateWithDocs(): PlanState {
  const doc: PlanDocMeta = {
    fileName: "design.md",
    absPath: "/tmp/test-project/.tmp/plans/auth/design.md",
    sourceSkill: "tech-design",
    version: 1,
  };
  return {
    ...DEFAULT_PLAN_STATE,
    isActive: true,
    planFilePath: "/tmp/test-project/.tmp/plans/auth/plan.md",
    requirement: "refactor auth",
    skills: ["tech-design"],
    docs: [doc],
  };
}

function setup(state?: PlanState) {
  const sessions = new Map<string, PlanState>();
  const controllers = new Map<string, AbortController>();
  let executeFn: (id: string, p: Record<string, unknown>, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<unknown>;
  const pi = {
    registerTool: vi.fn((tool) => { executeFn = tool.execute; }),
    appendEntry: vi.fn(),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
    getAllTools: vi.fn(() => ALL_TOOL_NAMES.map((n) => ({ name: n }))),
  } as unknown as Parameters<typeof registerPlanTool>[0];
  registerPlanTool(pi, sessions, controllers);

  const ctx = {
    sessionId: "test-session",
    cwd: "/tmp/test-project",
    // D4 三路分流 ctx 形态字段：审批 approve → complete 在 taiji 形态走 uiFormInteract（rpc）
    hasUI: true,
    mode: "rpc" as const,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "test-session", getEntries: () => [] },
    ui: { select: vi.fn(), notify: vi.fn() },
  };

  if (state) sessions.set("test-session", state);

  const exec = (params: Record<string, unknown>, signal?: AbortSignal) =>
    executeFn!("tc0", params, signal, undefined, ctx);
  return { pi, sessions, ctx, controllers, exec };
}

/** 构造 docs 非空的激活态并放入 sessions（多数用例的前置） */
function setupActive() {
  const harness = setup(activeStateWithDocs());
  return harness;
}

beforeEach(() => {
  // 默认按独立 pi 形态跑（无宿主信号）；taiji 分支用例内 stubEnv 覆盖
  vi.stubEnv("TAIJI_AGENT_EXT_LOG", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("register-doc（D10）", () => {
  it("registers a document with derived absPath and persists it", async () => {
    const { exec, pi } = setup(activeStateWithDocs());
    const res = await exec({ action: "register-doc", fileName: "impl-plan.md", sourceSkill: "dev-flow" });
    expect(res.details).toEqual({ action: "register-doc", fileName: "impl-plan.md", version: 1 });
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({
        docs: [
          expect.objectContaining({ fileName: "design.md", version: 1 }),
          expect.objectContaining({ fileName: "impl-plan.md", absPath: "/tmp/test-project/.tmp/plans/auth/impl-plan.md", version: 1 }),
        ],
      }),
    );
  });

  it("re-registering the same fileName bumps version in place (version+1 覆盖)", async () => {
    const { exec } = setup(activeStateWithDocs());
    await exec({ action: "register-doc", fileName: "design.md" });
    const res = await exec({ action: "register-doc", fileName: "design.md" });
    expect(res.details).toEqual({ action: "register-doc", fileName: "design.md", version: 3 });
  });

  it("throws when fileName is missing (programming error)", async () => {
    const { exec } = setup(activeStateWithDocs());
    await expect(exec({ action: "register-doc" })).rejects.toThrow("fileName is required");
  });

  it("rejects path traversal in fileName — absPath 不得逃出 plan 目录", async () => {
    const { exec, pi } = setup(activeStateWithDocs());
    for (const bad of ["../secret.md", "sub/dir.md", "back\\slash.md", "..", "."]) {
      await expect(exec({ action: "register-doc", fileName: bad })).rejects.toThrow(
        "fileName must be a plain file name inside the plan directory",
      );
    }
    // 全部拒绝：零状态写入（throw 先于 persistPlanState）
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("returns an error result when plan mode is not active (前置条件用 result 错误)", async () => {
    const { exec } = setup();
    const res = await exec({ action: "register-doc", fileName: "design.md" });
    expect(res.details).toEqual({ action: "review-error", reason: "inactive" });
  });
});

describe("submit-review E6 双守卫", () => {
  it("guard 1: inactive plan mode → error result, no select is hung", async () => {
    const { exec, ctx } = setup();
    const res = await exec({ action: "submit-review" });
    expect(res.details).toEqual({ action: "review-error", reason: "inactive" });
    // A9 收紧语义：未激活 ≠ 批准——禁止实施、等用户指示（禁「wrap up」类歧义表述）
    expect(res.content[0].text).toContain("not active");
    expect(res.content[0].text).toContain("No plan has been approved");
    expect(res.content[0].text).toContain("do not implement any changes");
    expect(res.content[0].text).toContain("wait for further user instructions");
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("guard 2: no registered docs → error result telling the agent to register first", async () => {
    const { exec, ctx } = setup({
      ...DEFAULT_PLAN_STATE,
      isActive: true,
      planFilePath: "/tmp/test-project/.tmp/plans/auth/plan.md",
    });
    const res = await exec({ action: "submit-review" });
    expect(res.details).toEqual({ action: "review-error", reason: "no-docs" });
    expect(res.content[0].text).toContain("register-doc");
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
});

describe("submit-review 宿主分流（TAIJI_AGENT_EXT_LOG）", () => {
  it("standalone pi (no signal): no select, text soft-gate result (E8), reviewState=awaiting persisted", async () => {
    const { exec, ctx, pi } = setupActive();
    const res = await exec({ action: "submit-review" });

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(res.details).toEqual({ action: "submit-review", channel: "text", docsCount: 1 });
    expect(res.content[0].text).toContain("directly in the conversation");
    // E8 软门修订闭环：text result 就近携带与 formatReviewComments revise 对齐的指令
    expect(res.content[0].text).toContain("rewrite the file");
    expect(res.content[0].text).toContain("register-doc");
    expect(res.content[0].text).toContain("plan(action='submit-review') again");
    // 挂起前落 awaiting（E3 崩溃恢复依赖此持久态）
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ reviewState: "awaiting" }),
    );
  });

  it("taiji host (signal=1): hangs PLAN_REVIEW_MARKER select with PlanReviewRequest payload and a fresh signal", async () => {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    const { exec, ctx, controllers } = setupActive();
    // 在挂起窗口内（select 尚未 resolve）断言注册表登记——abort 联动必须能找到 controller
    let hungSignal: AbortSignal | undefined;
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(
      async (_title: string, _options: string[], opts: { signal?: AbortSignal }) => {
        hungSignal = opts.signal;
        expect(controllers.get("test-session")?.signal).toBe(opts.signal);
        return undefined;
      },
    );

    await exec({ action: "submit-review" });

    expect(ctx.ui.select).toHaveBeenCalledOnce();
    const [title, options, opts] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], { signal?: AbortSignal }];
    expect(title).toBe(PLAN_REVIEW_MARKER);
    expect(options).toHaveLength(1);
    expect(JSON.parse(options[0])).toEqual({
      docs: [expect.objectContaining({ fileName: "design.md", version: 1 })],
    });
    // E10：挂起 select 必须携带 AbortSignal
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(hungSignal).toBe(opts.signal);
    // select settled 后 controller 即弃（注册表不留已 settled 的条目）
    expect(controllers.has("test-session")).toBe(false);
  });
});

describe("turn abort 级联（execute signal → 挂起 select 解散，MF-1-8）", () => {
  /** select mock 对齐 pi 实装 createDialogPromise 语义（rpc-mode.js:48）：signal 已 abort 首行短路 resolve undefined；挂起中 abort → resolve undefined */
  function selectHonoringSignal(ctx: { ui: { select: unknown } }): void {
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(
      (_title: string, _options: string[], opts: { signal?: AbortSignal }) =>
        new Promise<string | undefined>((resolve) => {
          if (opts.signal?.aborted) {
            resolve(undefined);
            return;
          }
          opts.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
    );
  }

  it("submit-review 挂起窗口内 turn abort → PLAN_REVIEW_MARKER select 解散 → cancelled result（非批准）", async () => {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    const { exec, ctx } = setupActive();
    selectHonoringSignal(ctx);

    const turn = new AbortController();
    const pending = exec({ action: "submit-review" }, turn.signal);
    turn.abort();
    const res = await pending;

    expect(res.details).toEqual({ action: "review-error", reason: "cancelled" });
    // A9 语义：取消 ≠ 批准，result 文本显式禁止实施
    expect(res.content[0].text).toContain("NOT an approval");
  });

  it("execute 进入时 turn signal 已 abort → controller 即刻置 abort 态，select 首行短路解散", async () => {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    const { exec, ctx } = setupActive();
    selectHonoringSignal(ctx);

    const turn = new AbortController();
    turn.abort();
    const res = await exec({ action: "submit-review" }, turn.signal);

    expect(res.details).toEqual({ action: "review-error", reason: "cancelled" });
    expect(ctx.ui.select).toHaveBeenCalledOnce();
  });
});

describe("重提交无变化检测（docs 快照指纹，E8 机制级兜底）", () => {
  it("首次 submit-review：无警告行、details 无 changed 字段", async () => {
    const { exec } = setupActive();
    const res = await exec({ action: "submit-review" });

    expect(res.content[0].text).not.toContain("no documents changed");
    expect(res.details).toEqual({ action: "submit-review", channel: "text", docsCount: 1 });
  });

  it("register-doc 后重提交：无警告且快照指纹随 version 更新落盘", async () => {
    const { exec, pi } = setupActive();
    await exec({ action: "submit-review" });
    // 修订闭环：rewrite 后重登记，version 1 → 2
    await exec({ action: "register-doc", fileName: "design.md" });
    const res = await exec({ action: "submit-review" });

    expect(res.content[0].text).not.toContain("no documents changed");
    expect(res.details).toEqual({ action: "submit-review", channel: "text", docsCount: 1 });
    const lastEntry = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as PlanState;
    expect(lastEntry.lastSubmitReviewDocsFingerprint).toBe("design.md:2");
  });

  it("未 register-doc 重提交：result 末行追加警告 + details.changed=false", async () => {
    const { exec, pi } = setupActive();
    await exec({ action: "submit-review" });
    const res = await exec({ action: "submit-review" });

    expect(res.content[0].text).toContain(
      "Note: no documents changed since the last submit-review. " +
      "If the user requested changes, you MUST rewrite the file(s) and re-register each via plan(action='register-doc') BEFORE calling submit-review again.",
    );
    // 追加为末行（追加一行契约）
    expect(res.content[0].text.split("\n").at(-1)).toMatch(/^Note: no documents changed/);
    expect(res.details).toEqual({ action: "submit-review", channel: "text", docsCount: 1, changed: false });
    // 重提交不改写快照基线：指纹仍是上次值（docs 确实没变）
    const lastEntry = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as PlanState;
    expect(lastEntry.lastSubmitReviewDocsFingerprint).toBe("design.md:1");
  });

  it("gui 分支（revise 后未改文档重提交）同样追加警告 + changed=false", async () => {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    const { exec, ctx } = setupActive();
    const comments = [{ quote: "第二节", comment: "补失败分支" }];
    (ctx.ui.select as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify({ decision: "revise", comments }))
      .mockResolvedValueOnce(JSON.stringify({ decision: "revise", comments }));

    const first = await exec({ action: "submit-review" });
    expect(first.content[0].text).not.toContain("no documents changed");
    expect(first.details).toEqual({ action: "submit-review", channel: "gui", docsCount: 1 });

    // 未 register-doc 直接重调 submit-review → 警告
    const second = await exec({ action: "submit-review" });
    expect(second.content[0].text).toContain(
      "Note: no documents changed since the last submit-review",
    );
    expect(second.details).toEqual({ action: "submit-review", channel: "gui", docsCount: 1, changed: false });
  });
});

describe("decision 消费（taiji 形态）", () => {
  function setupTaiji() {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    return setupActive();
  }

  it("approve → clears reviewState before exec-choice, walks the complete flow, resets state keeping docs", async () => {
    const { exec, ctx, pi } = setupTaiji();
    (ctx.ui.select as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify({ decision: "approve" }))
      .mockResolvedValueOnce(JSON.stringify({ "Execution method": "Execute" }));

    const res = await exec({ action: "submit-review" });

    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
    expect(res.details.action).toBe("complete");
    expect(res.details.execMode).toBe("execute");
    expect(handlePlanComplete).toHaveBeenCalled();
    // P2-3：approve 消费审批后、exec-choice 挂起前先清 reviewState 落盘——
    // 「awaiting 无挂起」窗口不得误导渲染降级态
    const stateEntries = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[1] as PlanState)
      .filter((e) => e.isActive === true);
    expect(stateEntries.at(-1)?.reviewState).toBeUndefined();
    // reset 终态矩阵经 resetPlanState 落盘：isActive=false + docs 保留
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ isActive: false, docs: expect.any(Array) }),
    );
    const lastEntry = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as PlanState;
    expect(lastEntry.docs).toHaveLength(1);
    expect(lastEntry.reviewState).toBeUndefined();
  });

  it("revise → comments injected with explicit deliverAs:'steer' + reviewState=revising persisted", async () => {
    const { exec, ctx, pi } = setupTaiji();
    const comments = [{ quote: "第二节流程图", comment: "这里应该补一个失败分支" }];
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      JSON.stringify({ decision: "revise", comments }),
    );

    const res = await exec({ action: "submit-review" });

    // custom message 三要素 + streaming steer options 断言（A6）：deliverAs:'steer' 排队至
    // 下一次 LLM 调用，triggerTurn:true 覆盖非 streaming 窗口的开轮语义
    expect(pi.sendMessage).toHaveBeenCalledWith(
      { customType: PLAN_CONTEXT_CUSTOM_TYPE, content: expect.stringContaining("第二节流程图"), display: false },
      { deliverAs: "steer", triggerTurn: true },
    );
    expect(res.details.action).toBe("submit-review");
    // reviewState=revising 落 entry
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ reviewState: "revising", isActive: true }),
    );
  });

  it("E5: unparseable select response → warn + re-hang prompt, nothing injected into the conversation", async () => {
    const { exec, ctx, pi } = setupTaiji();
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("this is not json");

    const res = await exec({ action: "submit-review" });

    expect(res.details).toEqual({ action: "review-error", reason: "bad-response" });
    expect(res.content[0].text).toContain("submit-review");
    // 垃圾数据不进流：没有任何 decision 注入
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("E5: shape-invalid response (unknown decision) is treated as parse failure too", async () => {
    const { exec, ctx, pi } = setupTaiji();
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      JSON.stringify({ decision: "nonsense" }),
    );

    const res = await exec({ action: "submit-review" });

    expect(res.details).toEqual({ action: "review-error", reason: "bad-response" });
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("echo 回显（旧 taiji 宿主不识别 PLAN_REVIEW_MARKER）→ 升级指引错误，不引导重挂（MF-1-9）", async () => {
    const { exec, ctx, pi } = setupTaiji();
    // 宿主把 marker select 降级普通单选项：用户点选回显 payload 自身（合法 JSON，
    // parse 会成功但形状守卫必败——echo 判定必须先于 parse，否则重挂 → 再回显循环）
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(
      async (_title: string, options: string[]) => options[0],
    );

    const res = await exec({ action: "submit-review" });

    expect(res.details).toEqual({ action: "review-error", reason: "bad-response" });
    expect(res.content[0].text).toContain("upgrade taiji");
    // 不引导重挂：重挂会同样回显，形成重复弹错循环
    expect(res.content[0].text).not.toContain("re-hang");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("dismissed select (undefined) → cancelled result: not an approval, stop the review loop", async () => {
    const { exec, ctx, pi } = setupTaiji();
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const res = await exec({ action: "submit-review" });

    expect(res.details).toEqual({ action: "review-error", reason: "cancelled" });
    // A9 收紧语义：取消 ≠ 批准——禁止实施、停止审批循环（旧文曾指示 re-hang，
    // 被 LLM 误读为批准后开始实施）
    expect(res.content[0].text).toContain("cancelled");
    expect(res.content[0].text).toContain("NOT an approval");
    expect(res.content[0].text).toContain("Do not implement any changes");
    expect(res.content[0].text).toContain("Stop the review loop");
    expect(res.content[0].text).toContain("wait for further user instructions");
    // 未消费 decision、未重置状态
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });
});

describe("reviewStateSource 重挂起点重置（§3.4 第 3 轮裁决）", () => {
  it("submit-review re-hang clears stale source before awaiting is persisted (不变量：source 只描述当前降级等待的原因)", async () => {
    // 上一轮 E3 重挂残留 source='resubmit'；本用例重提交（重挂起新 pending）
    const { exec, pi } = setup({ ...activeStateWithDocs(), reviewStateSource: "resubmit" });

    await exec({ action: "submit-review" });

    // 挂起点落盘的 awaiting entry 不携带上一轮来源——残留会让崩溃恢复（E3）后的
    // 降级态渲染上一轮「已收到你的问题」文案，而本轮无人提问（C-U2 同型残留）
    const hangEntry = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[1] as PlanState)
      .find((e) => e.reviewState === "awaiting");
    expect(hangEntry).toBeDefined();
    expect(hangEntry!.reviewStateSource).toBeUndefined();
  });
});

describe("submit-review 的 PLAN_ACTIONS 面", () => {
  it("action list contains exactly the six actions (enter added; list-template removed, D1)", () => {
    expect([...PLAN_ACTIONS].sort()).toEqual(
      ["abort", "complete", "enter", "register-doc", "select-template", "submit-review"],
    );
  });
});
