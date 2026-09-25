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
import { detectExecSkills } from "../exec-skills.js";
import { PLAN_REVIEW_MARKER } from "@zhushanwen/extension-protocol";
import type { PlanDocMeta } from "@zhushanwen/extension-protocol";
import type { PlanState } from "../state.js";
import { DEFAULT_PLAN_STATE, PLAN_CONTEXT_CUSTOM_TYPE } from "../state.js";
import { PLAN_ACTIONS, registerPlanTool } from "../tool.js";

const ALL_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "plan", "write", "edit"];

/** 已激活、规划中且带一份已登记文档的状态（submit-review 的合法前置：planning --submit--> reviewing） */
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
    state: "planning",
  };
}

function setup(state?: PlanState) {
  const sessions = new Map<string, PlanState>();
  const controllers = new Map<string, AbortController>();
  const epochs = new Map<string, number>();
  let executeFn: (id: string, p: Record<string, unknown>, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<unknown>;
  const pi = {
    registerTool: vi.fn((tool) => { executeFn = tool.execute; }),
    appendEntry: vi.fn(),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
    getAllTools: vi.fn(() => ALL_TOOL_NAMES.map((n) => ({ name: n }))),
  } as unknown as Parameters<typeof registerPlanTool>[0];
  registerPlanTool(pi, sessions, controllers, epochs);

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
  return { pi, sessions, ctx, controllers, epochs, exec };
}

/** 构造 docs 非空的激活态并放入 sessions（多数用例的前置） */
function setupActive() {
  const harness = setup(activeStateWithDocs());
  return harness;
}

/** submit-review 的自审参数（D9① 硬门：每次必带） */
const SELF_REVIEW = "3 requirements covered; 2 assumptions verified; chapters complete.";

/** 落盘 entry 序列辅助：全部 plan-state entry 的 data */
function persistedEntries(pi: { appendEntry: unknown }): PlanState[] {
  return (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as PlanState);
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
    // 无生命周期事件（9 事件表无 register-doc 员）：persist 携带 state 现值，无转移写
    expect(pi.appendEntry).toHaveBeenCalledWith("plan-state", expect.objectContaining({ state: "planning" }));
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

describe("submit-review E6 双守卫 + D9① 自审硬门", () => {
  it("guard 1: inactive plan mode → error result, no select is hung", async () => {
    const { exec, ctx } = setup();
    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });
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
      state: "planning",
    });
    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });
    expect(res.details).toEqual({ action: "review-error", reason: "no-docs" });
    expect(res.content[0].text).toContain("register-doc");
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("guard 3（D9① 硬门，无豁免）: selfReview 缺失/空 → tool result 纠偏，不挂 select、零状态写入", async () => {
    for (const bad of [undefined, "", "   "]) {
      const { exec, ctx, pi } = setupActive();
      const res = await exec({ action: "submit-review", ...(bad === undefined ? {} : { selfReview: bad }) });

      expect(res.details).toEqual({ action: "review-error", reason: "no-self-review" });
      // 纠偏指令即自审清单（对照需求核覆盖 / 假设审计 / 章节完整性 / 验收可执行）+ 重调形态
      expect(res.content[0].text).toContain("self-review");
      expect(res.content[0].text).toContain("selfReview");
      expect(res.content[0].text).toContain("requirement");
      expect(res.content[0].text).toContain("[UNVERIFIED]");
      expect(ctx.ui.select).not.toHaveBeenCalled();
      // gate 判定先于一切写入：拒收不更新任何快照
      expect(pi.appendEntry).not.toHaveBeenCalled();
    }
  });
});

describe("submit-review 宿主分流（TAIJI_AGENT_EXT_LOG）", () => {
  it("standalone pi (no signal): no select, text soft-gate result (E8), state=reviewing + selfReview persisted", async () => {
    const { exec, ctx, pi } = setupActive();
    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(res.details).toEqual({ action: "submit-review", channel: "text", docsCount: 1 });
    expect(res.content[0].text).toContain("directly in the conversation");
    // E8 软门修订闭环：text result 就近携带与 formatReviewComments revise 对齐的指令
    expect(res.content[0].text).toContain("rewrite the file");
    expect(res.content[0].text).toContain("register-doc");
    expect(res.content[0].text).toContain("plan(action='submit-review') again");
    // 挂起前落 reviewing（transition 'submit'，E3 崩溃恢复按 state 查表依赖此持久态）+ selfReview
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ state: "reviewing", selfReview: SELF_REVIEW }),
    );
  });

  it("taiji host (signal=1): hangs PLAN_REVIEW_MARKER select with PlanReviewRequest payload (docs+selfReview) and a fresh signal", async () => {
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

    await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    expect(ctx.ui.select).toHaveBeenCalledOnce();
    const [title, options, opts] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], { signal?: AbortSignal }];
    expect(title).toBe(PLAN_REVIEW_MARKER);
    expect(options).toHaveLength(1);
    // D9③：payload 携带 selfReview（写侧截断单点）
    expect(JSON.parse(options[0])).toEqual({
      docs: [expect.objectContaining({ fileName: "design.md", version: 1 })],
      selfReview: SELF_REVIEW,
    });
    // E10：挂起 select 必须携带 AbortSignal
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(hungSignal).toBe(opts.signal);
    // select settled 后 controller 即弃（注册表不留已 settled 的条目）
    expect(controllers.has("test-session")).toBe(false);
  });

  it("env 泄漏的非 rpc 形态（signal=1 但 mode='tui'）：回落文本软门，不挂 marker select（与 resolveCompleteChoice 分流对齐）", async () => {
    // 独立 pi TUI 继承了 TAIJI_AGENT_EXT_LOG=1（env 泄漏）时，宿主没有 marker 路由——
    // 只判 env 会挂 \x00 marker select，pi TUI 渲染成乱码对话；分流条件必须同查 ctx.mode
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    const { exec, ctx } = setupActive();
    (ctx as { mode?: string }).mode = "tui";

    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(res.details).toEqual({ action: "submit-review", channel: "text", docsCount: 1 });
    expect(res.content[0].text).toContain("directly in the conversation");
  });
});

describe("E3 降级态用户输入重提（放行语义，F-W3-1 另一半）", () => {
  it("state=reviewing + resumeHint='resubmit'（E3 降级残留）时重调 submit-review → 照常重挂 select + resumeHint 清除（reviewing 自环降级，恢复触发权在用户的路径必须放行）", async () => {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    const { exec, ctx, pi } = setup({
      ...activeStateWithDocs(),
      state: "reviewing",
      resumeHint: "resubmit",
      selfReview: SELF_REVIEW,
      lastSubmitReviewDocsFingerprint: "design.md:1",
    });
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ decision: "dismiss" }));

    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    // 放行：不因降级态残留而拒绝重挂（用户点「重新提交审批」按钮 = 显式重提意图）
    expect(ctx.ui.select).toHaveBeenCalledOnce();
    // select 应答被正常消费（链路完整走通到 decision 消费段）
    expect(res.details).toMatchObject({ action: "review-dismissed" });
    // 重挂落盘（倒数第二条；最后一条是 dismiss 应答的转移落盘）：reviewing 自环
    //（状态值不变）+ resumeHint 清除（降级等待解除，清除点三处之三；persistPlanState
    // 显式携带键，undefined 经 JSON 序列化自然消失——按值语义断言）
    const entries = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(entries.at(-2)).toMatchObject({ state: "reviewing" });
    expect(entries.at(-2)?.resumeHint).toBeUndefined();
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

  it("submit-review 挂起窗口内 turn abort → select 解散 → 归口①外部解散（review_aborted → planning 落盘，非批准）", async () => {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    const { exec, ctx, pi } = setupActive();
    selectHonoringSignal(ctx);

    const turn = new AbortController();
    const pending = exec({ action: "submit-review", selfReview: SELF_REVIEW }, turn.signal);
    turn.abort();
    const res = await pending;

    // 归口① epoch 未变（turn abort 无 reset 介入）→ 外部解散：reviewing --review_aborted--> planning
    expect(res.details).toEqual({ action: "review-error", reason: "review-interrupted" });
    // A9 语义：中断 ≠ 批准，result 文本显式禁止实施
    expect(res.content[0].text).toContain("NOT an approval");
    expect(res.content[0].text).toContain("planning");
    // review_aborted 边落盘（D3 连带段）：审批条随之收敛、不复活
    const entries = persistedEntries(pi);
    expect(entries.at(-1)).toMatchObject({ isActive: true, state: "planning" });
  });

  it("execute 进入时 turn signal 已 abort → controller 即刻置 abort 态，select 首行短路解散", async () => {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    const { exec, ctx } = setupActive();
    selectHonoringSignal(ctx);

    const turn = new AbortController();
    turn.abort();
    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW }, turn.signal);

    expect(res.details).toEqual({ action: "review-error", reason: "review-interrupted" });
    expect(ctx.ui.select).toHaveBeenCalledOnce();
  });
});

describe("重提交无变化检测（docs 快照指纹，E8 机制级兜底）", () => {
  it("首次 submit-review：无警告行、details 无 changed 字段", async () => {
    const { exec } = setupActive();
    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    expect(res.content[0].text).not.toContain("no documents changed");
    expect(res.details).toEqual({ action: "submit-review", channel: "text", docsCount: 1 });
  });

  it("register-doc 后重提交：无警告且快照指纹随 version 更新落盘", async () => {
    const { exec, pi } = setupActive();
    await exec({ action: "submit-review", selfReview: SELF_REVIEW });
    // 修订闭环：rewrite 后重登记，version 1 → 2；自审对象是新版本（D9① 无豁免）→ 换新 selfReview
    await exec({ action: "register-doc", fileName: "design.md" });
    const res = await exec({ action: "submit-review", selfReview: "v2 self-review: all covered." });

    expect(res.content[0].text).not.toContain("no documents changed");
    expect(res.details).toEqual({ action: "submit-review", channel: "text", docsCount: 1 });
    const lastEntry = persistedEntries(pi).at(-1)!;
    expect(lastEntry.lastSubmitReviewDocsFingerprint).toBe("design.md:2");
  });

  it("未 register-doc 重提交：result 末行追加警告 + details.changed=false", async () => {
    const { exec, pi } = setupActive();
    await exec({ action: "submit-review", selfReview: SELF_REVIEW });
    // 未改文档的重提交（E3 同值回传形态）不触防照抄门（指纹未变）
    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    expect(res.content[0].text).toContain(
      "Note: no documents changed since the last submit-review. " +
      "If the user requested changes, you MUST rewrite the file(s) and re-register each via plan(action='register-doc') BEFORE calling submit-review again.",
    );
    // 追加为末行（追加一行契约）
    expect(res.content[0].text.split("\n").at(-1)).toMatch(/^Note: no documents changed/);
    expect(res.details).toEqual({ action: "submit-review", channel: "text", docsCount: 1, changed: false });
    // 重提交不改写快照基线：指纹仍是上次值（docs 确实没变）
    const lastEntry = persistedEntries(pi).at(-1)!;
    expect(lastEntry.lastSubmitReviewDocsFingerprint).toBe("design.md:1");
  });

  it("gui 分支（revise 后未改文档重提交）同样追加警告 + changed=false", async () => {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    const { exec, ctx } = setupActive();
    const comments = [{ quote: "第二节", comment: "补失败分支" }];
    (ctx.ui.select as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify({ decision: "revise", comments }))
      .mockResolvedValueOnce(JSON.stringify({ decision: "revise", comments }));

    const first = await exec({ action: "submit-review", selfReview: SELF_REVIEW });
    expect(first.content[0].text).not.toContain("no documents changed");
    expect(first.details).toEqual({ action: "submit-review", channel: "gui", docsCount: 1 });

    // 未 register-doc 直接重调 submit-review → 警告
    const second = await exec({ action: "submit-review", selfReview: SELF_REVIEW });
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

  it("approve → transition reviewing→dispatching 落盘后再挂 exec-choice，终局 completed（D5 阶段不倒退）", async () => {
    const { exec, ctx, pi } = setupTaiji();
    // 有 plan-exec 技能 → 挂执行方式表单（D7②：空集直通无表单窗，本用例锁 form 挂起窗的 D5 时序）
    (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
      { name: "dev-flow", description: "d", skillEntryPath: "/tmp/skills/dev-flow/SKILL.md" },
    ]);
    (ctx.ui.select as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify({ decision: "approve" }))
      .mockResolvedValueOnce(JSON.stringify({ "Execution method": "Execute" }));

    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
    expect(res.details.action).toBe("complete");
    expect(res.details.execMode).toBe("execute");
    expect(handlePlanComplete).toHaveBeenCalled();
    // D5：approve 消费后、exec-choice 挂起前落盘 dispatching（取代「先清 reviewState」）——
    // 挂起期间 derivePhase(dispatching)='approved'，阶段③不倒退（F5 不复活）
    const activeEntries = persistedEntries(pi).filter((e) => e.isActive === true);
    expect(activeEntries.at(-1)?.state).toBe("dispatching");
    // 终局 reset：terminal='completed'（不被 reset 覆写为 'exited'）+ docs 保留
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ isActive: false, state: "completed", docs: expect.any(Array) }),
    );
    const lastEntry = persistedEntries(pi).at(-1)!;
    expect(lastEntry.docs).toHaveLength(1);
  });

  it("dismiss → reviewing --dismiss--> planning 落盘 + 搁置文案（不实施、询问下一步）", async () => {
    const { exec, ctx, pi } = setupTaiji();
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(JSON.stringify({ decision: "dismiss" }));

    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    // D3 消费面②③：dismiss 分支显式结果 + tool result 语义（搁置 ≠ 批准 ≠ 取消）
    expect(res.details).toEqual({ action: "review-dismissed", docsCount: 1 });
    expect(res.content[0].text).toContain("set this review aside");
    expect(res.content[0].text).toContain("Do not implement any changes");
    // dismiss 边落盘：planning（被搁置的审批不复活——F1/F2/F3 构造性消除）
    const entries = persistedEntries(pi);
    expect(entries.at(-1)).toMatchObject({ isActive: true, state: "planning" });
    // 非破坏：不杀 turn（无 setActiveTools / 无解散文案）
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(res.content[0].text).not.toContain("interrupted");
  });

  it("revise → comments injected with explicit deliverAs:'steer' + state=revising persisted", async () => {
    const { exec, ctx, pi } = setupTaiji();
    const comments = [{ quote: "第二节流程图", comment: "这里应该补一个失败分支" }];
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      JSON.stringify({ decision: "revise", comments }),
    );

    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    // custom message 三要素 + streaming steer options 断言（A6）：deliverAs:'steer' 排队至
    // 下一次 LLM 调用，triggerTurn:true 覆盖非 streaming 窗口的开轮语义
    expect(pi.sendMessage).toHaveBeenCalledWith(
      { customType: PLAN_CONTEXT_CUSTOM_TYPE, content: expect.stringContaining("第二节流程图"), display: false },
      { deliverAs: "steer", triggerTurn: true },
    );
    expect(res.details.action).toBe("submit-review");
    // revise 边落盘（reviewing --revise--> revising）
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "plan-state",
      expect.objectContaining({ state: "revising", isActive: true }),
    );
  });

  it("E5: unparseable select response → warn + re-hang prompt, nothing injected into the conversation", async () => {
    const { exec, ctx, pi } = setupTaiji();
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("this is not json");

    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    expect(res.details).toEqual({ action: "review-error", reason: "bad-response" });
    expect(res.content[0].text).toContain("submit-review");
    // 垃圾数据不进流：没有任何 decision 注入
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("D3① unknown decision（合法 JSON、值域外）→ version-mismatch 降级：版本不匹配指引，不引导重挂（防再入循环）", async () => {
    const { exec, ctx, pi } = setupTaiji();
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      JSON.stringify({ decision: "nonsense" }),
    );

    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    expect(res.details).toEqual({ action: "review-error", reason: "version-mismatch" });
    expect(res.content[0].text).toContain("version-mismatched");
    // 双分源语义相反：不引导重挂（重挂会同样错配循环）
    expect(res.content[0].text).not.toContain("re-hang");
    expect(res.content[0].text).toContain("Do NOT call submit-review again");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("E5: malformed shape (decision ok but comments broken) → bad-response with re-hang guidance", async () => {
    const { exec, ctx, pi } = setupTaiji();
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      JSON.stringify({ decision: "revise", comments: [{ quote: 1, comment: null }] }),
    );

    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    expect(res.details).toEqual({ action: "review-error", reason: "bad-response" });
    expect(res.content[0].text).toContain("re-hang");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("echo 回显（旧 taiji 宿主不识别 PLAN_REVIEW_MARKER）→ 升级指引错误，不引导重挂（MF-1-9，判定先于 parse）", async () => {
    const { exec, ctx, pi } = setupTaiji();
    // 宿主把 marker select 降级普通单选项：用户点选回显 payload 自身（合法 JSON，
    // parse 会成功但形状守卫必败——echo 判定必须先于 parse，否则重挂 → 再回显循环）
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(
      async (_title: string, options: string[]) => options[0],
    );

    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    expect(res.details).toEqual({ action: "review-error", reason: "bad-response" });
    expect(res.content[0].text).toContain("upgrade taiji");
    // 不引导重挂：重挂会同样回显，形成重复弹错循环
    expect(res.content[0].text).not.toContain("re-hang");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("dismissed select (undefined, 无 reset 介入) → 归口①外部解散：中断≠批准，停止审批循环等指示", async () => {
    const { exec, ctx, pi } = setupTaiji();
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    // epoch 未变（本进程无 reset 介入）→ 外部解散，review_aborted → planning 已落盘
    expect(res.details).toEqual({ action: "review-error", reason: "review-interrupted" });
    // A9 收紧语义：中断 ≠ 批准——禁止实施、等用户指示（不再引导自动重挂）
    expect(res.content[0].text).toContain("interrupted");
    expect(res.content[0].text).toContain("NOT an approval");
    expect(res.content[0].text).toContain("Do not implement any changes");
    expect(res.content[0].text).toContain("Wait for the user's instructions");
    // 未消费 decision、未恢复工具集
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });
});

describe("submit-review 转移落盘（D2 清除点三处之三）", () => {
  it("重挂起点清 resumeHint（不变量：resumeHint 只描述当前降级等待的原因，不跨轮残留）", async () => {
    // 上一轮 E3 重挂残留 resumeHint='resubmit'；本用例重提交（重挂起新 pending）
    const { exec, pi } = setup({ ...activeStateWithDocs(), state: "reviewing", resumeHint: "resubmit" });

    await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    // 挂起点落盘的 entry 不携带上一轮 hint——残留会让降级态渲染「会话已重启」文案，
    // 而本轮已重新挂起（C-U2 同型残留）
    const hangEntry = persistedEntries(pi).find((e) => e.state === "reviewing");
    expect(hangEntry).toBeDefined();
    expect(hangEntry!.resumeHint).toBeUndefined();
    expect(hangEntry!.selfReview).toBe(SELF_REVIEW);
  });

  it("reviewing 自环重挂（E3 恢复 / D8 重新提交按钮路径）：transition ok:false 降级为不改状态值、照常落盘重挂", async () => {
    vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1");
    // state='reviewing' 且无挂起（E3 恢复后的降级格）——submit 自环不在 19 边表，
    // 调用方降级处理（D9④ 该路径必须可用）
    const { exec, ctx, pi } = setup({ ...activeStateWithDocs(), state: "reviewing", resumeHint: "resubmit" });
    (ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(JSON.stringify({ decision: "dismiss" }));

    const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

    // 重挂成功（select 挂起并被消费），状态值保持 reviewing（自环不改值）
    expect(res.details.action).toBe("review-dismissed");
    const hangEntry = persistedEntries(pi).find((e) => e.state === "reviewing");
    expect(hangEntry).toBeDefined();
    expect(hangEntry!.resumeHint).toBeUndefined();
    expect(hangEntry!.lastSubmitReviewDocsFingerprint).toBe("design.md:1");
  });

  it("submit from approved/dispatching → out-of-order 纠偏（FSM 合法性兜底，不落盘）", async () => {
    for (const st of ["approved", "dispatching"] as const) {
      const { exec, pi, ctx } = setup({ ...activeStateWithDocs(), state: st });
      const res = await exec({ action: "submit-review", selfReview: SELF_REVIEW });

      expect(res.details).toEqual({ action: "review-error", reason: "out-of-order" });
      expect(res.content[0].text).toContain("plan(action='complete')");
      expect(pi.appendEntry).not.toHaveBeenCalled();
      expect(ctx.ui.select).not.toHaveBeenCalled();
    }
  });
});

describe("submit-review 的 PLAN_ACTIONS 面", () => {
  it("action list contains exactly the six actions (enter added; list-template removed, D1)", () => {
    expect([...PLAN_ACTIONS].sort()).toEqual(
      ["abort", "complete", "enter", "register-doc", "select-template", "submit-review"],
    );
  });
});
