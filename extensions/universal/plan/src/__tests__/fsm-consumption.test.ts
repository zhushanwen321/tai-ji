import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs 破坏性写（形态照 command.test.ts 的思路，读透传真实实现）：enter/abort 会碰
// mkdir/rmdir/readdir——vitest fs-guard 红线，测试不得写非白名单目录；模板发现等读路径保留真实
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    mkdirSync: vi.fn(),
    rmdirSync: vi.fn(),
  };
});

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

vi.mock("../compact.js", async () => {
  const { GOAL_FAILURE_RECOVERY } = await vi.importActual<typeof import("../compact.js")>("../compact.js");
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

import { PLAN_REVIEW_MARKER } from "@zhushanwen/extension-protocol";
import { detectExecSkills } from "@zhushanwen/pi-exec-skills";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerPlanCommand } from "../command.js";
import type { PlanState } from "../state.js";
import { createPlanCtx, DEFAULT_PLAN_STATE } from "../state.js";
import { registerPlanTool } from "../tool.js";

const ALL_TOOL_NAMES = ["read", "bash", "grep", "find", "ls", "plan", "ask_user", "write", "edit"];
const SR = "3 requirements covered; 2 assumptions verified.";

/** 规划中 + 一份文档（submit-review 合法前置） */
function planningState(): PlanState {
  return {
    ...DEFAULT_PLAN_STATE,
    isActive: true,
    planFilePath: "/tmp/test-project/.tmp/plans/auth/plan.md",
    requirement: "refactor auth",
    docs: [{ fileName: "design.md", absPath: "/tmp/test-project/.tmp/plans/auth/design.md", sourceSkill: "", version: 1 }],
    state: "planning",
    selfReview: SR,
    lastSubmitReviewDocsFingerprint: "design.md:1",
  };
}

/**
 * 组合 harness：tool + command 共享单 ctx 对象两注册表
 * （跨入口解散判别需要真实共享——exitPlanMode 与等待归口经同一 controllers 表传递
 * dissolvedBy 直传来源，D-B1-2；sessions/controllers 别名 = planCtx 两表，D-B4-3）。
 */
function setup(initialState?: PlanState) {
  const planCtx = createPlanCtx();
  let executeFn: (id: string, p: Record<string, unknown>, sig?: AbortSignal, upd?: unknown, ctx?: unknown) => Promise<unknown>;
  let commandHandler: (args: string, ctx: ExtensionContext) => Promise<void>;

  const pi = {
    registerTool: vi.fn((tool) => { executeFn = tool.execute; }),
    registerCommand: vi.fn((_name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      commandHandler = def.handler;
    }),
    appendEntry: vi.fn(),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
    notify: vi.fn(),
    getCommands: vi.fn(() => []),
    getAllTools: vi.fn(() => ALL_TOOL_NAMES.map((n) => ({ name: n }))),
  } as unknown as Parameters<typeof registerPlanTool>[0];
  registerPlanTool(pi, planCtx);
  registerPlanCommand(pi as unknown as Parameters<typeof registerPlanCommand>[0], planCtx);

  const ctx = {
    sessionId: "test-session",
    cwd: "/tmp/test-project",
    hasUI: true,
    mode: "tui" as const,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "test-session", getEntries: () => [] },
    ui: { select: vi.fn(), notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn() },
  };

  if (initialState) planCtx.states.set("test-session", initialState);

  const exec = (params: Record<string, unknown>, signal?: AbortSignal) =>
    executeFn!("tc0", params, signal, undefined, ctx);
  return {
    pi, planCtx, sessions: planCtx.states, controllers: planCtx.controllers, ctx, exec,
    handleCommand: (args: string) => commandHandler(args, ctx as unknown as ExtensionContext),
  };
}

/** select mock 对齐 pi 实装 createDialogPromise 语义（rpc-mode.js:48）：signal 生效即 resolve undefined */
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

function entries(pi: { appendEntry: unknown }): PlanState[] {
  return (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as PlanState);
}

beforeEach(() => {
  vi.stubEnv("TAIJI_AGENT_EXT_LOG", "1"); // taiji 形态（marker select 链路）
});

afterEach(() => {
  vi.unstubAllEnvs();
  // exec-skills 模块 mock 归位空集（D7②：空集直通是缺省形态，用例内显式注入技能的覆写不跨用例泄漏）
  (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([]);
});

// ── dissolvedBy 直传断言组（D-B1-2，单测锚定，零 token）──

describe("dissolvedBy① 入口解散同步临界段（markDissolved 先于 abort、无让出点——归口点必读到 'self'）", () => {
  it("挂起审批中 /plan abort：归口①判命令解散 no-op（不落 review_aborted），reset 终态是唯一新落盘", async () => {
    const h = setup(planningState());
    h.ctx.mode = "rpc";
    selectHonoringSignal(h.ctx);

    // exec() 同步推进到 ctx.ui.select 挂起（首个 await 即 select）
    const pending = h.exec({ action: "submit-review", selfReview: SR });
    // exitPlanMode 体内无 await：整段（markDissolved('self') → controller.abort() →
    // resetPlanState）同步执行完毕，abort 触发的 promise 解析是微任务——归口点必在其后
    // 运行、dissolvedBy 已置位（同步临界段不变量）
    void h.handleCommand("abort");
    const res = await pending;

    // 归口①：dissolvedBy === 'self'（入口直传）→ 命令解散 no-op
    expect(res.details).toEqual({ action: "review-error", reason: "cancelled" });
    expect((res as { content: Array<{ text: string }> }).content[0].text).toContain("has been exited");
    // 归口 no-op：无 review_aborted 落盘（不出现把 exited 打回 planning 的 entry）
    const all = entries(h.pi);
    expect(all.map((e) => e.state)).toEqual(["reviewing", "exited"]);
  });

  it("直接断言：exitPlanMode 打标后 PendingSelect.dissolvedBy === 'self'（来源随挂起闭包直达等待处）", async () => {
    const h = setup(planningState());
    h.ctx.mode = "rpc";
    selectHonoringSignal(h.ctx);

    const pending = h.exec({ action: "submit-review", selfReview: SR });
    // 挂起已登记（PendingSelect 在表内且未打标——外部解散前的缺省形态）
    const hang = h.controllers.get("test-session");
    expect(hang?.dissolvedBy).toBeUndefined();
    void h.handleCommand("abort");
    expect(hang?.dissolvedBy).toBe("self");
    await pending;
  });

  it("反向对照：同形态若仅 controller.abort()（不打标）则判外部解散（断言有效性的负向探针对照）", async () => {
    const h = setup(planningState());
    h.ctx.mode = "rpc";
    selectHonoringSignal(h.ctx);

    const pending = h.exec({ action: "submit-review", selfReview: SR });
    // 只 abort controller 不经 exitPlanMode（turn abort 级联形态）——不打标，缺省即外部
    h.controllers.get("test-session")?.controller.abort();
    const res = await pending;

    expect(res.details).toEqual({ action: "review-error", reason: "review-interrupted" });
    const all = entries(h.pi);
    expect(all.at(-1)?.state).toBe("planning"); // review_aborted 边落盘
  });
});

describe("S15② 新鲜度门拒收后重试仍触发（gate 判定先于一切写入、拒收不更新任何快照）", () => {
  it("文档已变 + selfReview 照抄 → 连续两次拒收 stale-self-review，零状态写入", async () => {
    // 前置：上次提交后又登记了新版本（指纹 design.md:1 → design.md:2），自审对象已变——
    // incoming selfReview 与 state.selfReview 逐字节相同 → 防照抄门命中
    const h = setup({
      ...planningState(),
      docs: [{ fileName: "design.md", absPath: "/tmp/test-project/.tmp/plans/auth/design.md", sourceSkill: "", version: 2 }],
      lastSubmitReviewDocsFingerprint: "design.md:1",
      selfReview: SR,
    });
    const first = await h.exec({ action: "submit-review", selfReview: SR });
    expect(first.details).toEqual({ action: "review-error", reason: "stale-self-review" });
    expect((first as { content: Array<{ text: string }> }).content[0].text).toContain("redo the self-review");
    expect(h.pi.appendEntry).not.toHaveBeenCalled();

    // 重试（agent 未改自审直接重调）→ 仍触发（拒收不更新任何快照：指纹/selfReview 均未被写）
    const second = await h.exec({ action: "submit-review", selfReview: SR });
    expect(second.details).toEqual({ action: "review-error", reason: "stale-self-review" });
    expect(h.pi.appendEntry).not.toHaveBeenCalled();

    // 换新 selfReview → 过门（对照）
    const third = await h.exec({ action: "submit-review", selfReview: "v2 self-review redone." });
    expect(third.details).toMatchObject({ action: "submit-review" });
    expect(h.pi.appendEntry).toHaveBeenCalled();
  });
});

describe("dissolvedBy② 跨轮无挂起退出 → 新一轮外部解散正常转移（闭包身份天然隔离，无残留回归）", () => {
  it("上一轮 abort（无挂起 select）不污染本轮归口：新一轮外部解散仍走 review_aborted", async () => {
    const h = setup(planningState());
    // 第一轮：无挂起 select 的退出（规划期退出——旧世代标记机制会在此形态下残留的病根）
    await h.exec({ action: "abort" });

    // 第二轮：同 turn enter → 登记文档 → 挂新 select → 外部解散（新 PendingSelect，
    // 闭包来源变量独立于上一轮）
    await h.exec({ action: "enter", requirement: "round two" });
    await h.exec({ action: "register-doc", fileName: "design.md" });
    h.ctx.mode = "rpc";
    selectHonoringSignal(h.ctx);
    const turn = new AbortController();
    const pending = h.exec({ action: "submit-review", selfReview: SR }, turn.signal);
    // execute 的 turn signal 级联解散（外部解散源，cascadeTurnAbort——只 abort 不打标）
    turn.abort();
    const res = await pending;

    // 新挂起的来源变量未被污染（undefined）→ 外部解散正常转移，不被误判为命令解散
    expect(res.details).toEqual({ action: "review-error", reason: "review-interrupted" });
    const all = entries(h.pi);
    expect(all.at(-1)).toMatchObject({ state: "planning", isActive: true });
  });
});

describe("dissolvedBy③ 同 turn enter→挂新 select→外部解散 / 命令解散→归口 no-op（双向）", () => {
  it("同 turn enter → 挂新 select → 外部解散：review_aborted 正常转移", async () => {
    const h = setup(); // 干净 session
    await h.exec({ action: "enter", requirement: "same turn" });
    await h.exec({ action: "register-doc", fileName: "design.md" });
    h.ctx.mode = "rpc";
    selectHonoringSignal(h.ctx);
    const pending = h.exec({ action: "submit-review", selfReview: SR });
    h.controllers.get("test-session")?.controller.abort(); // 外部解散（不打标，缺省即外部）
    const res = await pending;

    expect(res.details).toEqual({ action: "review-error", reason: "review-interrupted" });
    const all = entries(h.pi);
    expect(all.at(-1)).toMatchObject({ state: "planning", isActive: true });
  });

  it("同 turn enter → 挂新 select → 命令解散（/plan abort 全序列）：归口 no-op", async () => {
    const h = setup();
    await h.exec({ action: "enter", requirement: "same turn" });
    await h.exec({ action: "register-doc", fileName: "design.md" });
    h.ctx.mode = "rpc";
    selectHonoringSignal(h.ctx);
    const pending = h.exec({ action: "submit-review", selfReview: SR });
    void h.handleCommand("abort"); // 命令解散（markDissolved('self') → abort → reset 同步临界段）
    const res = await pending;

    expect(res.details).toEqual({ action: "review-error", reason: "cancelled" });
    const all = entries(h.pi);
    // 双向之另一半：归口 no-op——reset 的 exited 是最末条，无 planning 覆写在其后
    expect(all.map((e) => e.state).at(-1)).toBe("exited");
    expect(all.findIndex((e) => e.state === "exited")).toBe(all.length - 1);
  });
});

describe("resumeHint 三时点清除断言（不变量：只描述当前降级等待的原因，不跨轮残留）", () => {
  it("① reset 清除 / ② enter 进入重置组清除 / ③ submit-review 转移落盘清除", async () => {
    // ① reset
    const a = setup({ ...planningState(), state: "reviewing", resumeHint: "resubmit" });
    await a.exec({ action: "abort" });
    expect(entries(a.pi).at(-1)?.resumeHint).toBeUndefined();

    // ② enter 新轮次重置组
    const b = setup({ ...DEFAULT_PLAN_STATE, isActive: false, state: "exited", resumeHint: "resubmit", selfReview: "stale" });
    await b.exec({ action: "enter", requirement: "fresh" });
    expect(entries(b.pi).at(-1)?.resumeHint).toBeUndefined();
    expect(entries(b.pi).at(-1)?.selfReview).toBeUndefined();

    // ③ submit-review 转移落盘（重挂起点）——含 reviewing 自环重挂（E3/D8 路径）
    const c = setup({ ...planningState(), state: "reviewing", resumeHint: "resubmit" });
    (c.ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ decision: "dismiss" }));
    await c.exec({ action: "submit-review", selfReview: SR });
    const hangEntry = entries(c.pi).find((e) => e.state === "reviewing");
    expect(hangEntry?.resumeHint).toBeUndefined();
  });
});

// ── 状态写全走 transition()（consumers.md 三A/三B 接线断言）──

describe("六 action 状态写走 transition()（D1 边表接线）", () => {
  it("enter：idle|completed|exited --enter--> planning 三源全落 planning", async () => {
    for (const from of ["idle", "completed", "exited"] as const) {
      const h = setup({ ...DEFAULT_PLAN_STATE, isActive: false, state: from });
      await h.exec({ action: "enter", requirement: `from ${from}` });
      expect(entries(h.pi).at(-1)?.state).toBe("planning");
    }
  });

  it("submit-review：planning|revising --submit--> reviewing 两源；approve 决策 --approve--> dispatching", async () => {
    for (const from of ["planning", "revising"] as const) {
      const h = setup({ ...planningState(), state: from });
      h.ctx.mode = "rpc";
      (h.ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ decision: "dismiss" }));
      await h.exec({ action: "submit-review", selfReview: "fresh review." });
      const states = entries(h.pi).map((e) => e.state);
      expect(states).toContain("reviewing"); // submit 边
      expect(states.at(-1)).toBe("planning"); // dismiss 边
    }

    const g = setup(planningState());
    g.ctx.mode = "rpc";
    (g.ctx.ui.select as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify({ decision: "approve" }))
      .mockResolvedValueOnce(JSON.stringify({ "Execution method": "Execute" }));
    await g.exec({ action: "submit-review", selfReview: "fresh review." });
    const states = entries(g.pi).map((e) => e.state);
    expect(states).toContain("dispatching"); // approve 边（reviewing → dispatching）
    expect(states.at(-1)).toBe("completed"); // exec_chosen 边 + terminal='completed'
  });

  it("complete：reviewing --approve--> dispatching（文本流转直调 complete 同边，§三B）→ later --> approved", async () => {
    const h = setup(planningState());
    // 有技能才挂表单（D7②）——later 边只存在于表单的「暂不执行」档
    (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
      { name: "dev-flow", description: "d", skillEntryPath: "/tmp/skills/dev-flow/SKILL.md" },
    ]);
    // 文本流：submit-review 软门后用户口头确认 → agent 直调 complete
    await h.exec({ action: "submit-review", selfReview: SR });
    (h.ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue("Not now");
    const res = await h.exec({ action: "complete" });
    expect(res.details).toMatchObject({ action: "complete-later" });
    const states = entries(h.pi).map((e) => e.state);
    expect(states).toContain("dispatching");
    expect(states.at(-1)).toBe("approved"); // later 边
  });

  it("complete 未经审批闸口（planning 直调）→ out-of-order 纠偏，不落盘（执行前用户审批结构性保证）", async () => {
    const h = setup(planningState());
    const res = await h.exec({ action: "complete" });
    expect(res.details).toEqual({ action: "review-error", reason: "out-of-order" });
    expect((res as { content: Array<{ text: string }> }).content[0].text).toContain("submit-review");
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("abort：活跃族非终态 --exit--> exited；select-template/register-doc 无生命周期事件（persist 携带现值）", async () => {
    const h = setup(planningState());
    await h.exec({ action: "select-template", templateName: "feature-plan" });
    await h.exec({ action: "register-doc", fileName: "design.md" });
    // 两 action 均无转移写：state 现值原样落盘
    for (const e of entries(h.pi)) expect(e.state).toBe("planning");

    await h.exec({ action: "abort" });
    expect(entries(h.pi).at(-1)?.state).toBe("exited");
  });

  it("reviewing 重挂自环（D-B1-8：reviewing --submit--> reviewing）：重提交照常落盘回 reviewing，前后等价，接续 approve 正常", async () => {
    const h = setup({ ...planningState(), state: "reviewing" });
    h.ctx.mode = "rpc";
    // reviewing 态重提交（E3 恢复 steer / D8 重新提交按钮的 agent 侧形态）
    (h.ctx.ui.select as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify({ decision: "approve" }))
      .mockResolvedValueOnce(JSON.stringify({ "Execution method": "Execute" }));
    const res = await h.exec({ action: "submit-review", selfReview: SR });
    // 自环锚：旧特判形态（ok:false 且现值 reviewing 放行）与自环形态落盘产物等价——
    // state 值不变、重挂回 reviewing（单一记录点照常落盘）
    const states = entries(h.pi).map((e) => e.state);
    expect(states[0]).toBe("reviewing"); // 重挂落盘（自环 ok:true）
    expect(states).toContain("dispatching"); // 接续 approve 边正常
    expect(states.at(-1)).toBe("completed"); // exec_chosen 终局
    expect(res.details.action).toBe("complete");
  });
});

// ── CompleteChoiceOutcome 显式 via 五构造点补齐（①later/⑤channel 已在 tool.test 锚定）──

describe("CompleteChoiceOutcome via 构造点（D3 连带段：显式枚举，归口直读）", () => {
  it("构造点②（TUI choice 空）→ via 'dissolved' 外部解散归口（approved 保留）", async () => {
    const h = setup({ ...planningState(), state: "approved" });
    (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
      { name: "dev-flow", description: "d", skillEntryPath: "/tmp/skills/dev-flow/SKILL.md" },
    ]);
    (h.ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const res = await h.exec({ action: "complete" });
    expect(res.details).toMatchObject({ action: "complete-cancelled", source: "external" });
    expect(entries(h.pi).at(-1)?.state).toBe("approved"); // review_aborted：dispatching → approved
  });

  it("构造点③（rpc cancel：select 解散 + signal aborted）→ via 'dissolved'；与④timeout 同折 reason 'cancelled'", async () => {
    const h = setup({ ...planningState(), state: "approved" });
    h.ctx.mode = "rpc";
    (detectExecSkills as ReturnType<typeof vi.fn>).mockReturnValue([
      { name: "dev-flow", description: "d", skillEntryPath: "/tmp/skills/dev-flow/SKILL.md" },
    ]);
    // 挂起窗口内 controller 被 abort（handleAbort 的 controller.abort() 半边 / turn 级联），
    // 无 reset 介入 → uiFormInteract 判 reason='cancelled'
    (h.ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      h.controllers.get("test-session")?.controller.abort();
      return undefined;
    });
    const res = await h.exec({ action: "complete" });
    expect(res.details).toMatchObject({ action: "complete-cancelled", reason: "cancelled", source: "external" });
    expect(entries(h.pi).at(-1)?.state).toBe("approved");
  });
});
