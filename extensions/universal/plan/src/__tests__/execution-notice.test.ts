import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanState } from "../state.js";
import { PLAN_CONTEXT_CUSTOM_TYPE } from "../state.js";

// Mock fs before importing execution-notice.ts (ESM namespace is not configurable)
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

// Import after mock setup
import { handlePlanComplete } from "../execution-notice.js";

const fsMock = vi.mocked(await import("node:fs"));

// --- Shared mock factories ---

function makePi() {
  return {
    on: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
}

type CtxMock = ReturnType<typeof makeCtx>;
function makeCtx() {
  return {
    sessionManager: { getSessionId: () => "test-session", getEntries: () => [] as unknown[] },
    ui: { notify: vi.fn() },
  };
}

function makeActiveState(): PlanState {
  return {
    isActive: true,
    // 生产真实形态（enter.ts：<project>/.tmp/plans/<slug>/plan.md）——合成单层路径会让
    // slug 派生类消费面（buildPlanSlug 取 basename）在测试数据上失真
    planFilePath: "/tmp/test-project/.tmp/plans/login-page/plan.md",
    requirement: "Add login page",
    templateName: "default",
  };
}

function setupFsMock(content: string) {
  fsMock.readFileSync.mockReturnValue(content);
}

/**
 * goal 桥 slot key——与 compact.ts / goal 侧 index.ts 的字符串一致（本地声明，
 * 不 import 对方包：pi-goal 是 optional peer，两侧靠同一字符串共享 slot）。
 */
const GOAL_INIT_SLOT_KEY = Symbol.for("@zhushanwen/pi-goal.goalInit");

/** 在 globalThis slot 上挂 goal 桥——mock 形态与真实通道同构（goal-bridge-cross-extension.md §3.4：goal 侧 Reflect.set 挂 slot，本测试同款挂载）。 */
function attachGoalInit(impl: () => boolean) {
  const fn = vi.fn(impl);
  Reflect.set(globalThis, GOAL_INIT_SLOT_KEY, fn);
  return fn;
}

/** 清 slot 防跨用例 globalThis 泄漏（设计 §3.4：teardown 两侧通用）。 */
afterEach(() => {
  Reflect.set(globalThis, GOAL_INIT_SLOT_KEY, undefined);
});

/** 最近一次 sendMessage 的正文（P8 custom message 的 content 字段）。 */
function lastSteer(pi: ReturnType<typeof makePi>): string {
  const calls = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
  const last = calls[calls.length - 1]?.[0] as { content?: string } | undefined;
  return String(last?.content ?? "");
}

/** P8 执行通知断言形态：custom message 三要素 + streaming steer options（A6）。 */
function executionNotice(content: unknown) {
  return [
    { customType: PLAN_CONTEXT_CUSTOM_TYPE, content, display: false },
    { deliverAs: "steer", triggerTurn: true },
  ];
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

  describe("direct delivery", () => {
    it("execute mode success: returns outcome synchronously, goal steer, no notify", () => {
      attachGoalInit(() => true);

      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "execute");

      expect(outcome).toEqual({ started: true });
      expect(pi.sendMessage).toHaveBeenCalledWith(...executionNotice(expect.stringContaining("Goal tracking is active via /goal")));
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    });

    it("skill mode: returns undefined, steer with skill entry path (steer 文案含 skillEntryPath，D10)", () => {
      attachGoalInit(() => true);
      const skillEntryPath = "/tmp/fixtures/skills/dev-flow/SKILL.md";

      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "skill:dev-flow", skillEntryPath);

      expect(outcome).toBeUndefined();
      const steer = lastSteer(pi);
      expect(steer).toContain("Execution mode: skill:dev-flow");
      expect(steer).toContain("/tmp/fixtures/skills/dev-flow/SKILL.md");
      expect(steer).toContain("follow its workflow");
    });

    it("skill mode (散 .md 形态): steer carries the file path itself, not a dangling joined SKILL.md", () => {
      attachGoalInit(() => true);
      const looseEntryPath = "/tmp/fixtures/skills/loose-tool.md";

      handlePlanComplete(pi as never, ctx as never, makeActiveState(), "skill:loose-tool", looseEntryPath);

      const steer = lastSteer(pi);
      expect(steer).toContain("/tmp/fixtures/skills/loose-tool.md"); // 文件路径本身
      expect(steer).not.toContain("loose-tool.md/SKILL.md"); // 不再拼接 SKILL.md（悬空指引根修）
      expect(steer).not.toContain("/tmp/fixtures/skills/SKILL.md"); // 旧缺陷形态：散 .md 的 dirname + SKILL.md
    });

    it("skill mode without skillEntryPath falls back to name-only guidance (防御形态)", () => {
      attachGoalInit(() => true);

      handlePlanComplete(pi as never, ctx as never, makeActiveState(), "skill:dev-flow");

      const steer = lastSteer(pi);
      expect(steer).toContain("load the dev-flow skill");
      expect(steer).not.toContain("SKILL.md");
    });
  });

  // goal 桥五个失败出口 → GoalBridgeOutcome 五值（D2）
  describe("tryGoalInit failure exits (execute mode)", () => {
    it("goal-unavailable: bridge not mounted → degraded steer + warning notify", () => {
      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "execute");

      expect(outcome).toEqual({ started: false, reason: "goal-unavailable" });
      const steer = lastSteer(pi);
      expect(steer).toContain("Goal tracking was not started (goal-unavailable)");
      expect(steer).not.toContain("Goal tracking is active via /goal");
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("goal-unavailable"), "warning");
    });

    it("plan-unreadable: plan file read fails → recovery points at the plan file", () => {
      attachGoalInit(() => true);
      fsMock.readFileSync.mockImplementation(() => { throw new Error("ENOENT: plan.md"); });

      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "execute");

      expect(outcome).toEqual({ started: false, reason: "plan-unreadable" });
      expect(lastSteer(pi)).toContain("Check that the plan file exists");
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("plan-unreadable"), "warning");
    });

    it("no-steps: plan content has no extractable steps", () => {
      attachGoalInit(() => true);
      setupFsMock("# Plan\n\nProse without any numbered list.");

      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "execute");

      expect(outcome).toEqual({ started: false, reason: "no-steps" });
      expect(lastSteer(pi)).toContain("Implementation Steps");
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no-steps"), "warning");
    });

    it("init-refused: goalInit returns false (active goal exists)", () => {
      attachGoalInit(() => false);

      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "execute");

      expect(outcome).toEqual({ started: false, reason: "init-refused" });
      expect(lastSteer(pi)).toContain("/goal clear");
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("init-refused"), "warning");
    });

    it("internal-error: goalInit throws → outcome carries detail, notify includes it, does not propagate", () => {
      attachGoalInit(() => { throw new Error("goalInit exploded"); });

      const outcome = handlePlanComplete(pi as never, ctx as never, makeActiveState(), "execute");

      expect(outcome).toEqual({ started: false, reason: "internal-error", detail: "goalInit exploded" });
      expect(lastSteer(pi)).toContain("Goal tracking was not started (internal-error)");
      expect(lastSteer(pi)).not.toContain("Goal tracking is active via /goal");
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("goalInit exploded"), "warning");
    });
  });
});
