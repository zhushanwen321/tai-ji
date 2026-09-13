/**
 * plan/compact.ts — buildPlanSuccessCriteria 数组形态测试
 *
 * 形态契约（U25）：1 条总述 `All N steps of <basename> executed and verified`
 * + 前 3 条 step preview（编号前缀、单条截断 ≤80 chars），合计 ≤4 条
 * （goal schema maxItems:8），每条单行不含 \r\n（goal handler 拒含换行条目）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { buildPlanSuccessCriteria, handlePlanComplete } from "../compact.js";

const fsMock = vi.mocked(await import("node:fs"));

function makePi() {
  return {
    on: vi.fn(),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
  };
}

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

function makeActiveState() {
  return {
    isActive: true,
    phase: "complete" as const,
    planFilePath: "/tmp/plan.md",
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
  it("5 步 plan → 4 条：总述 + 前 3 条 preview", () => {
    const steps = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
    const items = expectSingleLineArray(buildPlanSuccessCriteria("/tmp/plan.md", steps));

    expect(items).toHaveLength(4);
    expect(items[0]).toBe("All 5 steps of plan executed and verified");
    expect(items.slice(1)).toEqual(["1. Alpha", "2. Bravo", "3. Charlie"]);
  });

  it("1 步 plan → 2 条", () => {
    const items = expectSingleLineArray(buildPlanSuccessCriteria("/tmp/plan.md", ["Only step"]));

    expect(items).toHaveLength(2);
    expect(items[0]).toBe("All 1 steps of plan executed and verified");
    expect(items[1]).toBe("1. Only step");
  });

  it("0 步 → 仅总述 1 条", () => {
    const items = expectSingleLineArray(buildPlanSuccessCriteria("/tmp/plan.md", []));

    expect(items).toEqual(["All 0 steps of plan executed and verified"]);
  });

  it("12 步 → 仍 4 条，总述含实际总数", () => {
    const steps = Array.from({ length: 12 }, (_, i) => `S${i + 1}`);
    const items = expectSingleLineArray(buildPlanSuccessCriteria("/tmp/plan.md", steps));

    expect(items).toHaveLength(4);
    expect(items[0]).toBe("All 12 steps of plan executed and verified");
    expect(items.slice(1)).toEqual(["1. S1", "2. S2", "3. S3"]);
  });

  it("basename 为 plan 文件名去扩展名（含大写 .MD）", () => {
    const items = buildPlanSuccessCriteria("/work/feat-login-plan.MD", ["S1"]);
    expect(items[0]).toBe("All 1 steps of feat-login-plan executed and verified");
  });

  it("超长 step → 截断至 ≤80 chars 且以 ... 结尾，保留编号前缀", () => {
    const long = "x".repeat(120);
    const items = expectSingleLineArray(buildPlanSuccessCriteria("/tmp/plan.md", [long]));

    expect(items[1]).toHaveLength(80);
    expect(items[1].endsWith("...")).toBe(true);
    expect(items[1].startsWith("1. xxx")).toBe(true);
  });

  it("恰好 80 chars 的条目 → 不截断、不加省略号", () => {
    const exact = "y".repeat(77); // "1. " 前缀 + 77 = 80
    const items = buildPlanSuccessCriteria("/tmp/plan.md", [exact]);

    expect(items[1]).toBe(`1. ${exact}`);
    expect(items[1]).toHaveLength(80);
    expect(items[1].endsWith("...")).toBe(false);
  });

  it("step 文本含换行符 → 折叠为单行空格分隔（goal handler 拒 \r\n）", () => {
    const items = expectSingleLineArray(buildPlanSuccessCriteria("/tmp/plan.md", ["line1\nline2\r\nline3"]));

    expect(items[1]).toBe("1. line1 line2 line3");
  });
});

// --- handlePlanComplete → tryGoalInit 端到端 ---

describe("handlePlanComplete — __goalInit 第 5 参数为新形态 string[]", () => {
  let pi: ReturnType<typeof makePi>;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    vi.clearAllMocks();
    pi = makePi();
    ctx = makeCtx();
    (pi as unknown as Record<string, unknown>).__goalInit = vi.fn().mockReturnValue(true);
  });

  function getCriteriaArg(): string[] {
    const goalInitMock = (pi as unknown as Record<string, unknown>).__goalInit as ReturnType<typeof vi.fn>;
    expect(goalInitMock).toHaveBeenCalled();
    return expectSingleLineArray(goalInitMock.mock.calls[0][4]);
  }

  it("direct isolation: 3 步 plan → 总述 + 3 条 preview", () => {
    fsMock.readFileSync.mockReturnValue(makePlanContent(["Step A", "Step B", "Step C"]));

    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct", "goal");

    expect(getCriteriaArg()).toEqual([
      "All 3 steps of plan executed and verified",
      "1. Step A",
      "2. Step B",
      "3. Step C",
    ]);
  });

  it("compact isolation: onComplete 后 __goalInit 收到同形态数组", () => {
    fsMock.readFileSync.mockReturnValue(makePlanContent(["Step one", "Step two"]));

    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "compact", "goal");
    ctx._onCompleteFns[0]();

    expect(getCriteriaArg()).toEqual([
      "All 2 steps of plan executed and verified",
      "1. Step one",
      "2. Step two",
    ]);
  });

  it("12 步 plan → 数组长度固定 4（1 总述 + 3 preview），不再按 8 条上限截断", () => {
    const steps = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}`);
    fsMock.readFileSync.mockReturnValue(makePlanContent(steps));

    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct", "goal");

    const items = getCriteriaArg();
    expect(items).toHaveLength(4);
    expect(items[0]).toContain("12 steps");
    expect(items[0]).toContain("plan");
  });

  it("CRLF plan 文件 → 每条 criteria 仍单行不含 \\r \\n", () => {
    fsMock.readFileSync.mockReturnValue("## 实现步骤\r\n1. Step one\r\n2. Step two\r\n3. Step three");

    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct", "goal");

    expect(getCriteriaArg()).toEqual([
      "All 3 steps of plan executed and verified",
      "1. Step one",
      "2. Step two",
      "3. Step three",
    ]);
  });

  it("0 步 plan → tryGoalInit 提前退出，__goalInit 不被调用", () => {
    (fsMock.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("## Overview\nNo numbered steps here.");

    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct", "goal");

    const goalInitMock = (pi as unknown as Record<string, unknown>).__goalInit as ReturnType<typeof vi.fn>;
    expect(goalInitMock).not.toHaveBeenCalled();
    // steer 仍发出（执行流程不因 goal 缺席中断）
    expect(pi.sendUserMessage).toHaveBeenCalled();
  });
});
