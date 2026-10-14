// review.test.ts —— 审查编排单元（review.ts）：派发端口解析 / 轮次推进 / 条目校验
// 与写回 / 失败显式上报。编排链的 marker 往返（review-request / read / append 的
// 载荷形状）由 tool-execute.test.ts 通道层覆盖，此处聚焦编排纯逻辑。

import { afterEach, describe, expect, it } from "vitest";

import type { CanvasState } from "@zhushanwen/extension-protocol";

import {
  REVIEWER_REPORT_SCHEMA,
  buildReviewerTask,
  collectValidEntries,
  isCanvasStateReply,
  nextReviewRound,
  renderResolutionTable,
  resolveReviewerDispatcher,
  runReviewRound,
  type ReviewerDispatchPort,
} from "../review.js";
import { withExtLogEnv } from "./helpers/canvas-harness.js";

const SLOT_KEY = Symbol.for("@zhushanwen/subagent-core.service");

function makeState(overrides: Partial<CanvasState> = {}): CanvasState {
  return {
    canvasId: "c1",
    name: "多引擎支持",
    root: { nodeId: "root", statement: "多引擎支持怎么落地", criterias: ["c"], scopeExclusions: [] },
    direction: null,
    nodes: [],
    edges: [],
    comments: [],
    dirtyPaths: [],
    review: null,
    converged: false,
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
    ...overrides,
  };
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SLOT_KEY];
});

describe("resolveReviewerDispatcher（service 槽）", () => {
  it("槽缺位 → 结构化错误（review_dispatch_unavailable + 恢复动作）", () =>
    withExtLogEnv(undefined, () => {
      expect(() => resolveReviewerDispatcher()).toThrow(/review_dispatch_unavailable/);
      expect(() => resolveReviewerDispatcher()).toThrow(/恢复动作/);
    }));

  it("槽在但形态漂移（executeAndAwait 非函数）→ 同款结构化错误", () => {
    (globalThis as Record<symbol, unknown>)[SLOT_KEY] = { nope: true };
    expect(() => resolveReviewerDispatcher()).toThrow(/review_dispatch_unavailable/);
  });

  it("槽在且形态合法 → 返回端口", () => {
    const port: ReviewerDispatchPort = { executeAndAwait: async () => ({}) };
    (globalThis as Record<symbol, unknown>)[SLOT_KEY] = port;
    expect(resolveReviewerDispatcher()).toBe(port);
  });
});

describe("轮次与收窄输入", () => {
  it("nextReviewRound：从未审查 = R1；已有报告轮次 +1", () => {
    expect(nextReviewRound(makeState())).toBe(1);
    expect(
      nextReviewRound(
        makeState({
          review: { status: "in-progress", round: 2, maxRounds: 5, entries: [] },
        }),
      ),
    ).toBe(3);
  });

  it("renderResolutionTable：条目 × 处置状态逐条渲染；未处置显式标注", () => {
    const table = renderResolutionTable(
      makeState({
        review: {
          status: "in-progress",
          round: 1,
          maxRounds: 5,
          entries: [
            {
              id: "rv-1",
              round: 1,
              dimension: "support",
              severity: "must-fix",
              targetId: "n1",
              note: "悬空断言",
              resolution: { disposition: "accepted", by: "agent", note: "补了论据" },
            },
            { id: "rv-2", round: 1, dimension: "conflict", severity: "suggestion", targetId: "n2", note: "候选矛盾" },
          ],
        },
      }),
    );
    expect(table).toContain("[rv-1]");
    expect(table).toContain("accepted（by agent）：补了论据");
    expect(table).toContain("[rv-2]");
    expect(table).toContain("未处置");
  });

  it("buildReviewerTask：R1 含六维度词表与画布 JSON；R2+ 注入 scope 与处置表", () => {
    const state = makeState();
    const r1 = buildReviewerTask(state, 1);
    expect(r1).toContain("completeness");
    expect(r1).toContain("depth");
    expect(r1).toContain('"canvasId":"c1"');
    expect(r1).not.toContain("本轮审查范围");
    const r2 = buildReviewerTask(state, 2, "上轮处置表 + 攻击点");
    expect(r2).toContain("R2 复审");
    expect(r2).toContain("上轮处置表 + 攻击点");
  });

  it("reviewer schema：entries 必填、六维度 enum、severity 两值", () => {
    const entries = REVIEWER_REPORT_SCHEMA.properties as { entries: { items: { properties: Record<string, { enum?: string[] }> }; type: string } };
    expect(entries.entries.type).toBe("array");
    expect(entries.entries.items.properties.dimension.enum).toEqual([
      "completeness",
      "necessity",
      "support",
      "authenticity",
      "conflict",
      "depth",
    ]);
    expect(entries.entries.items.properties.severity.enum).toEqual(["must-fix", "suggestion"]);
  });
});

describe("collectValidEntries（reviewer 产出不信任校验）", () => {
  it("合法条目收集（借契约守卫逐条校验），畸形条目丢弃并计数", () => {
    const valid = { id: "rv-1", dimension: "support", severity: "must-fix", targetId: "n1", note: "x" };
    const badWord = { id: "rv-2", dimension: "style", severity: "must-fix", targetId: "n1", note: "x" };
    const badShape = { id: "rv-3", dimension: "support", severity: "must-fix", note: "缺 targetId" };
    const { entries, dropped } = collectValidEntries("c1", 1, { entries: [valid, badWord, badShape] });
    expect(entries).toEqual([{ ...valid, round: 1 }]);
    expect(dropped).toBe(2);
  });

  it("entries 非数组（LLM 畸形输出）→ 全丢弃、dropped=1", () => {
    const { entries, dropped } = collectValidEntries("c1", 1, { entries: "nope" });
    expect(entries).toEqual([]);
    expect(dropped).toBe(1);
  });
});

describe("isCanvasStateReply（read 回包收窄）", () => {
  it("CanvasState 形状放行；缺 nodes / 非对象拒绝", () => {
    expect(isCanvasStateReply(makeState())).toBe(true);
    expect(isCanvasStateReply({ canvasId: "c1", name: "n", root: {} })).toBe(false);
    expect(isCanvasStateReply("text")).toBe(false);
  });
});

describe("runReviewRound（编排主体）", () => {
  // 每用例独立写回收集器（不做跨用例共享状态）
  const makeAppend = () => {
    const calls: unknown[] = [];
    return {
      calls,
      append: async (params: unknown): Promise<void> => {
        calls.push(params);
      },
    };
  };

  it("写回链：reviewer 合法条目经 appendWriteBack 落 round 与 canvasId，结果汇总条数", async () => {
    const append = makeAppend();
    const calls: unknown[] = [];
    const dispatch: ReviewerDispatchPort = {
      executeAndAwait: async (opts) => {
        calls.push(opts);
        return {
          parsedOutput: {
            entries: [{ id: "rv-1", dimension: "support", severity: "must-fix", targetId: "n1", note: "悬空" }],
            summary: "2 处支撑缺口",
          },
        };
      },
    };
    const outcome = await runReviewRound({
      state: makeState(),
      dispatch,
      appendWriteBack: append.append,
    });
    expect(outcome.round).toBe(1);
    expect(outcome.appended).toBe(1);
    expect(outcome.dropped).toBe(0);
    expect(outcome.summary).toBe("2 处支撑缺口");
    expect(append.calls).toEqual([
      {
        canvasId: "c1",
        round: 1,
        entries: [{ id: "rv-1", dimension: "support", severity: "must-fix", targetId: "n1", note: "悬空", round: 1 }],
      },
    ]);
    // 派发参数：task 内联画布 JSON + reviewer schema；slug 固定
    expect(calls).toHaveLength(1);
    const opts = calls[0] as { slug: string; task: string; schema: unknown; signal?: undefined };
    expect(opts.slug).toBe("canvas-review");
    expect(opts.task).toContain('"canvasId":"c1"');
    expect(opts.schema).toBe(REVIEWER_REPORT_SCHEMA);
  });

  it("R2+：轮次推进 + scope 收窄进 task", async () => {
    const append = makeAppend();
    let capturedTask = "";
    const dispatch: ReviewerDispatchPort = {
      executeAndAwait: async (opts) => {
        capturedTask = opts.task;
        return { parsedOutput: { entries: [] } };
      },
    };
    const outcome = await runReviewRound({
      state: makeState({
        review: { status: "in-progress", round: 1, maxRounds: 5, entries: [] },
      }),
      scope: "只审处置表",
      dispatch,
      appendWriteBack: append.append,
    });
    expect(outcome.round).toBe(2);
    expect(capturedTask).toContain("只审处置表");
    // 全 clean 轮：零条目不写回（append 不被调用）
    expect(append.calls).toHaveLength(0);
  });

  it("reviewer 执行失败（error 信封）→ 显式 throw（review_dispatch_failed + 恢复动作）", async () => {
    const append = makeAppend();
    const dispatch: ReviewerDispatchPort = {
      executeAndAwait: async () => ({ error: "engine spawn failed" }),
    };
    await expect(
      runReviewRound({ state: makeState(), dispatch, appendWriteBack: append.append }),
    ).rejects.toThrow(/review_dispatch_failed/);
    await expect(
      runReviewRound({ state: makeState(), dispatch, appendWriteBack: append.append }),
    ).rejects.toThrow(/恢复动作/);
    expect(append.calls).toHaveLength(0);
  });
});
