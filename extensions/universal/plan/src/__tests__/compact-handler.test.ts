import { beforeEach,describe, expect, it, vi } from "vitest";

import type { PlanState } from "../state.js";

// Mock fs before importing compact.ts (ESM namespace is not configurable)
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

// Import after mock setup
import { handlePlanComplete, registerPlanEventHandlers } from "../compact.js";

const fsMock = vi.mocked(await import("node:fs"));

// --- Shared mock factories ---

function makePi() {
  return {
    on: vi.fn(),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
  };
}

type CtxMock = ReturnType<typeof makeCtx>;
function makeCtx() {
  const onCompleteFns: Array<() => void> = [];
  const onErrorFns: Array<(e: Error) => void> = [];

  return {
    sessionManager: { getSessionId: () => "test-session", getEntries: () => [] as unknown[] },
    ui: { notify: vi.fn() },
    compact: vi.fn((opts: { onComplete?: () => void; onError?: (e: Error) => void }) => {
      if (opts.onComplete) onCompleteFns.push(opts.onComplete);
      if (opts.onError) onErrorFns.push(opts.onError);
    }),
    _onCompleteFns: onCompleteFns,
    _onErrorFns: onErrorFns,
  };
}

function makeActiveState(): PlanState {
  return {
    isActive: true,
    planFilePath: "/tmp/plan.md",
    requirement: "Add login page",
    templateName: "default",
  };
}

function setupFsMock(content: string) {
  fsMock.readFileSync.mockReturnValue(content);
}

/** 在 mock pi 上挂 goal 桥（单测层 mock 桥可达——真实链路桥断裂由独立缺陷跟踪）。 */
function attachGoalInit(pi: unknown, impl: () => boolean) {
  const fn = vi.fn(impl);
  (pi as Record<string, unknown>).__goalInit = fn;
  return fn;
}

/** 最近一次 steer 消息正文。 */
function lastSteer(pi: ReturnType<typeof makePi>): string {
  const calls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls;
  return String(calls[calls.length - 1]?.[0]);
}

// --- handlePlanComplete tests ---

describe("handlePlanComplete", () => {
  let pi: ReturnType<typeof makePi>;
  let ctx: CtxMock;

  beforeEach(() => {
    vi.clearAllMocks();
    pi = makePi();
    ctx = makeCtx();
    setupFsMock("## 实现步骤\n1. Step one\n2. Step two");
  });

  describe("compact isolation", () => {
    it("goal mode: goalInit deferred to onComplete, then goal steer on success (D2 时序——goal entry 在压缩后世界创建)", () => {
      const goalInit = attachGoalInit(pi, () => true);

      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "compact", "goal");

      expect(outcome).toBeUndefined(); // compact 档 outcome 在回调内产生，不进同步返回值
      expect(ctx.compact).toHaveBeenCalledOnce();
      expect(goalInit).not.toHaveBeenCalled(); // 压缩完成前不创建 goal entry

      ctx._onCompleteFns[0]();

      expect(goalInit).toHaveBeenCalledWith(
        "Execute plan: /tmp/plan.md",
        undefined,
        ctx,
        "plan",
        [
          "All 2 steps of plan executed and verified",
          "1. Step one",
          "2. Step two",
        ],
      );
      expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Execute via /goal"), { deliverAs: "steer" });
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it("non-goal mode: onComplete sends mode steer without calling goalInit", () => {
      const goalInit = attachGoalInit(pi, () => true);

      handlePlanComplete(pi as never, ctx as never, makeActiveState(), "compact", "subagent");
      ctx._onCompleteFns[0]();

      expect(goalInit).not.toHaveBeenCalled();
      expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("subagent-driven"), { deliverAs: "steer" });
    });

    it("onError (goal mode, init-refused): compact-failure notify + degraded steer + warning notify, no /goal promise", () => {
      attachGoalInit(pi, () => false); // goalInit 返回 false：已有 active goal

      handlePlanComplete(pi as never, ctx as never, makeActiveState(), "compact", "goal");
      ctx._onErrorFns[0](new Error("compact failed"));

      const notifyTexts = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(notifyTexts.some((t) => t.includes("Compact failed"))).toBe(true);
      expect(notifyTexts.some((t) => t.includes("init-refused"))).toBe(true);

      const steer = lastSteer(pi);
      expect(steer).toContain("Goal execution was not started (init-refused)");
      expect(steer).toContain("/goal clear"); // 恢复动作
      expect(steer).not.toContain("Execute via /goal"); // 承诺不再无凭据发出
    });
  });

  describe("direct isolation", () => {
    it("goal mode success: returns outcome synchronously, goal steer, no notify", () => {
      attachGoalInit(pi, () => true);

      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct", "goal");

      expect(outcome).toEqual({ started: true });
      expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Execute via /goal"), { deliverAs: "steer" });
      expect(ctx.compact).not.toHaveBeenCalled();
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it("non-goal mode: returns undefined, mode steer, no goalInit call", () => {
      const goalInit = attachGoalInit(pi, () => true);

      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct", "single-agent");

      expect(outcome).toBeUndefined();
      expect(goalInit).not.toHaveBeenCalled();
      expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("step by step"), { deliverAs: "steer" });
      expect(ctx.compact).not.toHaveBeenCalled();
    });

    it("unknown isolation value falls through to direct delivery instead of silently dropping the choice (D1 防御形态)", () => {
      attachGoalInit(pi, () => true);

      handlePlanComplete(pi as never, ctx as never, makeActiveState(), "tree", "goal");

      expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Execute via /goal"), { deliverAs: "steer" });
      expect(ctx.compact).not.toHaveBeenCalled();
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("/tree"), "info");
    });
  });

  // goal 桥五个失败出口 → GoalBridgeOutcome 五值（D2）
  describe("tryGoalInit failure exits (goal mode, direct isolation)", () => {
    it("goal-unavailable: bridge not mounted → degraded steer + warning notify", () => {
      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct", "goal");

      expect(outcome).toEqual({ started: false, reason: "goal-unavailable" });
      const steer = lastSteer(pi);
      expect(steer).toContain("Goal execution was not started (goal-unavailable)");
      expect(steer).not.toContain("Execute via /goal");
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("goal-unavailable"), "warning");
    });

    it("plan-unreadable: plan file read fails → recovery points at the plan file", () => {
      attachGoalInit(pi, () => true);
      fsMock.readFileSync.mockImplementation(() => { throw new Error("ENOENT: plan.md"); });

      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct", "goal");

      expect(outcome).toEqual({ started: false, reason: "plan-unreadable" });
      expect(lastSteer(pi)).toContain("Check that the plan file exists");
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("plan-unreadable"), "warning");
    });

    it("no-steps: plan content has no extractable steps", () => {
      attachGoalInit(pi, () => true);
      setupFsMock("# Plan\n\nProse without any numbered list.");

      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct", "goal");

      expect(outcome).toEqual({ started: false, reason: "no-steps" });
      expect(lastSteer(pi)).toContain("Implementation Steps");
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no-steps"), "warning");
    });

    it("init-refused: goalInit returns false (active goal exists)", () => {
      attachGoalInit(pi, () => false);

      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct", "goal");

      expect(outcome).toEqual({ started: false, reason: "init-refused" });
      expect(lastSteer(pi)).toContain("/goal clear");
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("init-refused"), "warning");
    });

    it("internal-error: goalInit throws → outcome carries detail, notify includes it, does not propagate", () => {
      attachGoalInit(pi, () => { throw new Error("goalInit exploded"); });

      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct", "goal");

      expect(outcome).toEqual({ started: false, reason: "internal-error", detail: "goalInit exploded" });
      expect(lastSteer(pi)).toContain("Goal execution was not started (internal-error)");
      expect(lastSteer(pi)).not.toContain("Execute via /goal");
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("goalInit exploded"), "warning");
    });
  });
});

// --- registerPlanEventHandlers tests ---

describe("registerPlanEventHandlers", () => {
  let pi: ReturnType<typeof makePi>;

  beforeEach(() => {
    vi.clearAllMocks();
    pi = makePi();
    setupFsMock("Plan content here");
  });

  function captureHandlers(): Record<string, (...args: unknown[]) => Promise<unknown>> {
    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const call of pi.on.mock.calls) {
      handlers[call[0] as string] = call[1];
    }
    return handlers;
  }

  it("session_before_compact (active): returns compaction summary with plan content", async () => {
    const sessions = new Map();
    sessions.set("test-session", makeActiveState());

    registerPlanEventHandlers(pi as never, sessions);
    const handlers = captureHandlers();

    const result = await handlers["session_before_compact"]({}, makeCtx() as never);
    const r = result as { compaction: { summary: string } };

    expect(r.compaction.summary).toContain("Plan content here");
    expect(r.compaction.summary).toContain("Add login page");
  });

  it("session_before_compact (inactive): returns empty object {}", async () => {
    registerPlanEventHandlers(pi as never, new Map());
    const handlers = captureHandlers();

    const result = await handlers["session_before_compact"]({}, makeCtx() as never);
    expect(result).toEqual({});
  });

  it("session_before_tree (active): returns summary with plan content", async () => {
    const sessions = new Map();
    sessions.set("test-session", makeActiveState());

    registerPlanEventHandlers(pi as never, sessions);
    const handlers = captureHandlers();

    const result = await handlers["session_before_tree"]({}, makeCtx() as never);
    const r = result as { summary: { summary: string } };

    expect(r.summary.summary).toContain("Plan content here");
    expect(r.summary.summary).toContain("/tmp/plan.md");
  });

  it("session_before_tree (inactive): returns empty object {}", async () => {
    registerPlanEventHandlers(pi as never, new Map());
    const handlers = captureHandlers();

    const result = await handlers["session_before_tree"]({}, makeCtx() as never);
    expect(result).toEqual({});
  });
});
