/**
 * plan/execution-notice.ts — buildPlanSuccessCriteria 数组形态测试
 *
 * 形态契约（U25）：1 条总述 `All N steps of <basename> executed and verified`
 * + 前 3 条 step preview（编号前缀、单条截断 ≤80 chars），合计 ≤4 条
 * （goal schema maxItems:8），每条单行不含 \r\n（goal handler 拒含换行条目）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { buildPlanSuccessCriteria, handlePlanComplete } from "../execution-notice.js";
import { PLAN_CONTEXT_CUSTOM_TYPE } from "../state.js";

const fsMock = vi.mocked(await import("node:fs"));

function makePi() {
  return {
    on: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
}

function makeCtx() {
  return {
    sessionManager: { getSessionId: () => "test-session", getEntries: () => [] as unknown[] },
    ui: { notify: vi.fn() },
  };
}

function makeActiveState() {
  return {
    isActive: true,
    // 生产真实形态（enter.ts：<project>/.tmp/plans/<slug>/plan.md）——buildPlanSlug 取
    // 目录名（requirement slug 段），合成单层路径会让 slug 派生在测试数据上失真
    planFilePath: "/tmp/test-project/.tmp/plans/login-page/plan.md",
    requirement: "Add login page",
    templateName: "default",
  };
}

function makePlanContent(steps: string[]): string {
  return `## 实现步骤\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
}

/** 验收共性断言：string[] 且每条单行不含 \r\n */
function expectSingleLineArray(value: unknown): string[] {
  expect(Array.isArray(value)).toBe(true);
  const items = value as string[];
  for (const item of items) {
    expect(item).not.toMatch(/[\r\n]/);
  }
  return items;
}

// --- buildPlanSuccessCriteria 单元 ---

describe("buildPlanSuccessCriteria — 1 总述 + 前 3 条 preview", () => {
  // 生产真实形态（enter.ts：<project>/.tmp/plans/<slug>/plan.md）——总述身份取目录名
  const PLAN_PATH = "/tmp/test-project/.tmp/plans/login-page/plan.md";

  it("5 步 plan → 4 条：总述 + 前 3 条 preview", () => {
    const steps = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
    const items = expectSingleLineArray(buildPlanSuccessCriteria(PLAN_PATH, steps));

    expect(items).toHaveLength(4);
    expect(items[0]).toBe("All 5 steps of login-page executed and verified");
    expect(items.slice(1)).toEqual(["1. Alpha", "2. Bravo", "3. Charlie"]);
  });

  it("0 步 → 仅总述 1 条", () => {
    const items = expectSingleLineArray(buildPlanSuccessCriteria(PLAN_PATH, []));

    expect(items).toEqual(["All 0 steps of login-page executed and verified"]);
  });

  it("目录名混合大小写 → kebab 链小写折叠（非生产形态防御）", () => {
    const items = buildPlanSuccessCriteria("/work/FeatLogin/plan.md", ["S1"]);
    expect(items[0]).toBe("All 1 steps of featlogin executed and verified");
  });

  it("非生产形态裸文件路径 → 提取为空回兜底名", () => {
    const items = buildPlanSuccessCriteria("/plan-x.md", ["S1"]);
    expect(items[0]).toBe("All 1 steps of plan-execution executed and verified");
  });

  it("超长 step → 截断至 ≤80 chars 且以 ... 结尾，保留编号前缀", () => {
    const long = "x".repeat(120);
    const items = expectSingleLineArray(buildPlanSuccessCriteria(PLAN_PATH, [long]));

    expect(items[1]).toHaveLength(80);
    expect(items[1].endsWith("...")).toBe(true);
    expect(items[1].startsWith("1. xxx")).toBe(true);
  });

  it("恰好 80 chars 的条目 → 不截断、不加省略号", () => {
    const exact = "y".repeat(77); // "1. " 前缀 + 77 = 80
    const items = buildPlanSuccessCriteria(PLAN_PATH, [exact]);

    expect(items[1]).toBe(`1. ${exact}`);
    expect(items[1]).toHaveLength(80);
    expect(items[1].endsWith("...")).toBe(false);
  });

  it("step 文本含换行符 → 折叠为单行空格分隔（goal handler 拒 \r\n）", () => {
    const items = expectSingleLineArray(buildPlanSuccessCriteria(PLAN_PATH, ["line1\nline2\r\nline3"]));

    expect(items[1]).toBe("1. line1 line2 line3");
  });
});

// --- handlePlanComplete → tryGoalInit 端到端 ---

/**
 * goal 桥 slot key——与 execution-notice.ts / goal 侧 index.ts 的字符串一致（本地声明，
 * 不 import 对方包：pi-goal 是 optional peer）。mock 挂 slot 与真实通道同构。
 */
const GOAL_INIT_SLOT_KEY = Symbol.for("@zhushanwen/pi-goal.goalInit");

describe("handlePlanComplete — goalInit slot 第 5 参数为新形态 string[]", () => {
  let pi: ReturnType<typeof makePi>;
  let ctx: ReturnType<typeof makeCtx>;
  let goalInitMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    pi = makePi();
    ctx = makeCtx();
    goalInitMock = vi.fn().mockReturnValue(true);
    Reflect.set(globalThis, GOAL_INIT_SLOT_KEY, goalInitMock);
  });

  afterEach(() => {
    Reflect.set(globalThis, GOAL_INIT_SLOT_KEY, undefined);
  });

  function getCriteriaArg(): string[] {
    expect(goalInitMock).toHaveBeenCalled();
    return expectSingleLineArray(goalInitMock.mock.calls[0][4]);
  }

  it("直接投递：3 步 plan → 总述 + 3 条 preview", () => {
    fsMock.readFileSync.mockReturnValue(makePlanContent(["Step A", "Step B", "Step C"]));

    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "execute");

    expect(getCriteriaArg()).toEqual([
      "All 3 steps of login-page executed and verified",
      "1. Step A",
      "2. Step B",
      "3. Step C",
    ]);
  });

  it("CRLF plan 文件 → 每条 criteria 仍单行不含 \\r \\n", () => {
    fsMock.readFileSync.mockReturnValue("## 实现步骤\r\n1. Step one\r\n2. Step two\r\n3. Step three");

    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "execute");

    expect(getCriteriaArg()).toEqual([
      "All 3 steps of login-page executed and verified",
      "1. Step one",
      "2. Step two",
      "3. Step three",
    ]);
  });

  it("0 步 plan → tryGoalInit 提前退出，goalInit 不被调用", () => {
    (fsMock.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("## Overview\nNo numbered steps here.");

    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "execute");

    expect(goalInitMock).not.toHaveBeenCalled();
    // steer 仍发出（执行流程不因 goal 缺席中断）——custom message 三要素 + steer options（A6）
    expect(pi.sendMessage).toHaveBeenCalledWith(
      { customType: PLAN_CONTEXT_CUSTOM_TYPE, content: expect.any(String), display: false },
      { deliverAs: "steer", triggerTurn: true },
    );
  });
});
