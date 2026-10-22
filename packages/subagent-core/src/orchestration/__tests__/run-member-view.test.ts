// run-member-view.test.ts —— run 成员视图纯函数测试（subagent-tool-interface-refactor
// 设计 §3.1.3 / §3.3.3 / §3.4；impl-plan u-foundation 验收条款①）。
//
// 覆盖：
// - state 映射四态（record 规则含存量回落 + trace 兜底行映射；cancelled 与兜底 failed 的粒度差异）
// - stepIndex 去重（running 优先 / startedAt 最新 / trace 兜底 last-wins / 合并后每 stepIndex 至多一行）
// - trace 兜底折行（records undefined 不抛错；字段回落链）
// - 8K 截断省略行（failed/cancelled 行优先保留；未超预算全保留）
// - lastError 回落链（终局 record.error ?? trace.result.error ?? trace.error；运行中 eventLog 最后一条）
// - now 参数耗时（运行中行 = now - startedAt；显式时钟测试可控）
// - model 语义（用户显式指定值；缺省回落 "default" 标记——不是生效模型）
// - turns 回落（record.turns ?? trace.result.usage?.turns）
import { describe, expect, it } from "vitest";

import {
  lastErrorOf,
  memberViewLine,
  MEMBER_VIEWS_MAX_CHARS,
  runMemberViews,
  truncateRunMemberViews,
  type RunMemberRecordView,
  type RunMemberView,
} from "../run-member-view.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import type { ExecutionTraceNode } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";

const T0 = 1_770_000_000_000; // 墙钟毫秒基点
const NOW = T0 + 60_000;

// ── fixtures ─────────────────────────────────────────────────

function makeRun(traceNodes: ExecutionTraceNode[] = []): WorkflowRun {
  return WorkflowRun.reconstruct(
    "wf-mv",
    { scriptSource: "async function execute() {}", args: {}, scriptName: "fan-out", scriptPath: "/fake/fan-out.js" },
    { budget: new Budget({ maxTokens: 1000 }), calls: new Map(), trace: Trace.fromArray(traceNodes), errorLogs: [] },
    { startedAt: new Date(T0).toISOString() },
  );
}

function makeRecord(overrides: Partial<RunMemberRecordView> & { stepIndex: number }): RunMemberRecordView {
  return { status: "idle", startedAt: T0, agent: "writer", ...overrides };
}

function makeNode(overrides: Partial<ExecutionTraceNode> & { stepIndex: number }): ExecutionTraceNode {
  return { agent: "fan-out-0", task: "t", model: "default", status: "running", ...overrides };
}

// ── state 映射 ───────────────────────────────────────────────

describe("runMemberViews — state 映射四态", () => {
  it("record.status=running → running；outcome 存在按 outcome 映射 completed/failed/cancelled", () => {
    const records: RunMemberRecordView[] = [
      makeRecord({ stepIndex: 0, status: "running" }),
      makeRecord({ stepIndex: 1, outcome: "completed", endedAt: T0 + 5_000 }),
      makeRecord({ stepIndex: 2, outcome: "failed", error: "boom", endedAt: T0 + 6_000 }),
      makeRecord({ stepIndex: 3, outcome: "cancelled", error: "aborted by user", endedAt: T0 + 7_000 }),
    ];

    const views = runMemberViews(makeRun(), { records, now: NOW });
    expect(views.map((v) => v.state)).toEqual(["running", "completed", "failed", "cancelled"]);
  });

  it("cancelled 与兜底 failed 的粒度差异（设计 §3.1.3 诚实注记）：record 行可 cancelled；trace 兜底行只能是 failed", () => {
    const cancelled = runMemberViews(makeRun(), {
      records: [makeRecord({ stepIndex: 0, outcome: "cancelled", endedAt: T0 + 1_000 })],
      now: NOW,
    });
    expect(cancelled[0]!.state).toBe("cancelled");

    // 同一 abort 场景，record 查询不可用时：trace 节点无 cancelled 状态（取消语义由
    // 错误文案承载），兜底行折 failed——降级形态，粒度差异可接受。
    const fallback = runMemberViews(
      makeRun([makeNode({ stepIndex: 0, status: "failed", error: "aborted: user cancelled" })]),
      { now: NOW },
    );
    expect(fallback[0]!.state).toBe("failed");
    expect(fallback[0]!.lastError).toBe("aborted: user cancelled");
  });

  it("存量 record（idle 且无 outcome）：设计表未定义形态——回落 trace 节点映射，再回落 record 事实，缺省 running", () => {
    const withNode = runMemberViews(
      makeRun([makeNode({ stepIndex: 0, status: "completed" })]),
      { records: [makeRecord({ stepIndex: 0 })], now: NOW },
    );
    expect(withNode[0]!.state).toBe("completed");

    const withError = runMemberViews(makeRun(), {
      records: [makeRecord({ stepIndex: 0, error: "legacy failure" })],
      now: NOW,
    });
    expect(withError[0]!.state).toBe("failed");

    const noFacts = runMemberViews(makeRun(), { records: [makeRecord({ stepIndex: 0 })], now: NOW });
    expect(noFacts[0]!.state).toBe("running");
  });
});

// ── stepIndex 去重 ───────────────────────────────────────────

describe("runMemberViews — 同 stepIndex 去重（resume 重派形态）", () => {
  it("running 优先：旧尝试终局 + 新尝试 running → 取 running（当前尝试）", () => {
    const records: RunMemberRecordView[] = [
      makeRecord({ stepIndex: 0, outcome: "failed", error: "old attempt", startedAt: T0, endedAt: T0 + 1_000 }),
      makeRecord({ stepIndex: 0, status: "running", startedAt: T0 + 2_000 }),
    ];

    const views = runMemberViews(makeRun(), { records, now: NOW });
    expect(views).toHaveLength(1);
    expect(views[0]!.state).toBe("running");
    expect(views[0]!.durationMs).toBe(NOW - (T0 + 2_000));
  });

  it("无 running 时取 startedAt 最新（终局比较以该条的结束时间为准）", () => {
    const records: RunMemberRecordView[] = [
      makeRecord({ stepIndex: 0, outcome: "failed", error: "old", startedAt: T0, endedAt: T0 + 1_000 }),
      makeRecord({ stepIndex: 0, outcome: "failed", error: "newest", startedAt: T0 + 5_000, endedAt: T0 + 6_000 }),
    ];

    const views = runMemberViews(makeRun(), { records, now: NOW });
    expect(views).toHaveLength(1);
    expect(views[0]!.lastError).toBe("newest");
    expect(views[0]!.durationMs).toBe(1_000);
  });

  it("trace 兜底内部按 stepIndex 取最后写入（与 Trace.byIndex last-wins 语义一致）", () => {
    // resume 重派后 trace 出现同 stepIndex 重复节点（设计 §2.6 已知形态）：先 pending 后 completed。
    const run = makeRun([
      makeNode({ stepIndex: 0, status: "pending", startedAt: new Date(T0).toISOString() }),
      makeNode({ stepIndex: 0, status: "completed", startedAt: new Date(T0).toISOString(), completedAt: new Date(T0 + 9_000).toISOString() }),
    ]);

    const views = runMemberViews(run, { now: NOW });
    expect(views).toHaveLength(1);
    expect(views[0]!.state).toBe("completed");
    expect(views[0]!.durationMs).toBe(9_000);
  });

  it("合并后每 stepIndex 至多一行：record 行覆盖同 stepIndex 兜底行；输出按 stepIndex 升序", () => {
    const run = makeRun([
      makeNode({ stepIndex: 1, status: "running" }),
      makeNode({ stepIndex: 2, status: "failed", error: "from trace" }),
    ]);
    const records: RunMemberRecordView[] = [
      makeRecord({ stepIndex: 2, outcome: "completed", endedAt: T0 + 2_000, agent: "record-wins" }),
      makeRecord({ stepIndex: 0, status: "running" }),
    ];

    const views = runMemberViews(run, { records, now: NOW });
    expect(views.map((v) => v.stepIndex)).toEqual([0, 1, 2]);
    expect(views[2]!.state).toBe("completed"); // record 行优先，非兜底 failed
    expect(views[2]!.agent).toBe("record-wins");
    expect(views[1]!.state).toBe("running"); // 无 record 的 stepIndex 走兜底
  });

  it("无 stepIndex 的 record 不成行（SubagentRecord 读侧语义）；空 records 数组 = 空 run 亦为空行", () => {
    const views = runMemberViews(makeRun(), { records: [makeRecord({ stepIndex: undefined as unknown as number, status: "running" })], now: NOW });
    expect(views).toEqual([]);
    expect(runMemberViews(makeRun(), { records: [], now: NOW })).toEqual([]);
  });
});

// ── trace 兜底折行 ───────────────────────────────────────────

describe("runMemberViews — trace 兜底（records undefined 不抛错）", () => {
  it("records undefined：全部成员行从 trace 节点折出；pending/running → running、completed → completed、failed → failed", () => {
    const run = makeRun([
      makeNode({ stepIndex: 0, status: "completed", startedAt: new Date(T0).toISOString(), completedAt: new Date(T0 + 71_000).toISOString() }),
      makeNode({ stepIndex: 1, status: "failed", startedAt: new Date(T0).toISOString(), completedAt: new Date(T0 + 5_100).toISOString(), error: "node-level error" }),
      makeNode({ stepIndex: 2, status: "pending" }),
      makeNode({ stepIndex: 3, status: "running", startedAt: new Date(T0 + 10_000).toISOString() }),
    ]);

    const views = runMemberViews(run, { now: NOW });
    expect(views.map((v) => v.state)).toEqual(["completed", "failed", "running", "running"]);
    expect(views[0]!.durationMs).toBe(71_000);
    expect(views[1]!.durationMs).toBe(5_100);
    expect(views[3]!.durationMs).toBe(NOW - (T0 + 10_000)); // 运行中兜底行 = now - startedAt
  });

  it("兜底行字段回落链：lastError 取 result.error（node.error 仅少数路径有值）、turns 取 result.usage?.turns、model 空串回落 default 标记", () => {
    const run = makeRun([
      makeNode({
        stepIndex: 0,
        status: "failed",
        agent: "fan-out-1",
        model: "", // resume 重建节点的 model 落空串（draftsToTraceNodes 现状）
        startedAt: new Date(T0).toISOString(),
        completedAt: new Date(T0 + 5_000).toISOString(),
        result: { content: "", error: "Request timed out.", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 7 } },
        error: "abort-path node error",
      }),
    ]);

    const views = runMemberViews(run, { now: NOW });
    expect(views[0]!.lastError).toBe("Request timed out."); // result.error 优先于 node.error
    expect(views[0]!.turns).toBe(7);
    expect(views[0]!.model).toBe("default"); // 空串不冒充显式指定值
    expect(views[0]!.agent).toBe("fan-out-1");
  });

  it("运行中兜底行无 record 数据源：lastError/currentActivity/turns 缺省（缺省不写 0）", () => {
    const run = makeRun([makeNode({ stepIndex: 0, status: "running", startedAt: new Date(T0).toISOString() })]);

    const views = runMemberViews(run, { now: NOW });
    expect(views[0]!.state).toBe("running");
    expect(views[0]!.lastError).toBeUndefined();
    expect(views[0]!.currentActivity).toBeUndefined();
    expect(views[0]!.turns).toBeUndefined();
  });
});

// ── record 行字段链 ──────────────────────────────────────────

describe("runMemberViews — record 行字段回落链与 now 耗时", () => {
  it("终局行 lastError = record.error ?? trace.result.error ?? trace.error；durationMs = record.endedAt - startedAt", () => {
    const run = makeRun([
      makeNode({
        stepIndex: 0,
        status: "failed",
        startedAt: new Date(T0).toISOString(),
        completedAt: new Date(T0 + 99_000).toISOString(),
        result: { content: "", error: "result error" },
        error: "node error",
      }),
    ]);
    // record.error 缺失：逐级回落 trace。
    const views = runMemberViews(run, { records: [makeRecord({ stepIndex: 0, outcome: "failed", startedAt: T0 + 1_000, endedAt: T0 + 6_000 })], now: NOW });
    expect(views[0]!.lastError).toBe("result error");
    expect(views[0]!.durationMs).toBe(5_000); // record 时间字段优先（非 trace 的 99s）

    // record.error 存在：不再回落。
    const own = runMemberViews(run, { records: [makeRecord({ stepIndex: 0, outcome: "failed", error: "record error", startedAt: T0, endedAt: T0 + 1_000 })], now: NOW });
    expect(own[0]!.lastError).toBe("record error");

    // record 与 trace 均无 error：缺省 undefined（不写空串/0）。
    const none = runMemberViews(makeRun(), { records: [makeRecord({ stepIndex: 0, outcome: "failed", endedAt: T0 + 1_000 })], now: NOW });
    expect(none[0]!.lastError).toBeUndefined();
  });

  it("终局行 record.endedAt 缺失时兜底 trace completedAt；两侧皆缺 → durationMs 缺省", () => {
    const run = makeRun([makeNode({ stepIndex: 0, status: "completed", startedAt: new Date(T0).toISOString(), completedAt: new Date(T0 + 8_000).toISOString() })]);
    const fromTrace = runMemberViews(run, { records: [makeRecord({ stepIndex: 0, outcome: "completed", startedAt: T0 + 2_000 })], now: NOW });
    expect(fromTrace[0]!.durationMs).toBe(6_000); // trace.completedAt - record.startedAt

    const noTimes = runMemberViews(makeRun(), { records: [makeRecord({ stepIndex: 0, outcome: "completed" })], now: NOW });
    expect(noTimes[0]!.durationMs).toBeUndefined();
  });

  it("运行中行：durationMs = now - startedAt（now 显式参数）；currentActivity 仅运行中且 tool 型带前缀", () => {
    const views = runMemberViews(makeRun(), {
      records: [
        makeRecord({ stepIndex: 0, status: "running", startedAt: T0 + 1_000, currentActivity: { type: "tool", label: "bash" } }),
        makeRecord({ stepIndex: 1, status: "running", startedAt: T0 + 2_000, currentActivity: { type: "thinking", label: "planning" } }),
      ],
      now: NOW,
    });
    expect(views[0]!.durationMs).toBe(NOW - (T0 + 1_000));
    expect(views[0]!.currentActivity).toBe("tool: bash");
    expect(views[1]!.currentActivity).toBe("planning");

    // 终局行不携带 currentActivity（仅运行中）。
    const terminal = runMemberViews(makeRun(), {
      records: [makeRecord({ stepIndex: 0, outcome: "completed", endedAt: T0 + 1_000, currentActivity: { type: "tool", label: "bash" } })],
      now: NOW,
    });
    expect(terminal[0]!.currentActivity).toBeUndefined();
  });

  it("运行中行 lastError = eventLog 最后一条 type:\"error\" 的 label（lastErrorOf 单行派生）", () => {
    const views = runMemberViews(makeRun(), {
      records: [
        makeRecord({
          stepIndex: 0,
          status: "running",
          startedAt: T0,
          eventLog: [
            { type: "tool_start", label: "bash" },
            { type: "error", label: "provider 429" },
            { type: "error", label: "provider timeout" },
          ],
        }),
      ],
      now: NOW,
    });
    expect(views[0]!.lastError).toBe("provider timeout");

    expect(lastErrorOf(undefined)).toBeUndefined();
    expect(lastErrorOf([{ type: "tool_end", label: "bash" }])).toBeUndefined();
    expect(lastErrorOf([{ type: "error", label: "only one" }])).toBe("only one");
  });

  it("turns = record.turns ?? trace.result.usage?.turns；均缺省省略字段（不写 0）", () => {
    const run = makeRun([
      makeNode({
        stepIndex: 0,
        status: "completed",
        result: { content: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 4 } },
      }),
    ]);
    const fromRecord = runMemberViews(run, { records: [makeRecord({ stepIndex: 0, outcome: "completed", turns: 9, endedAt: T0 })], now: NOW });
    expect(fromRecord[0]!.turns).toBe(9); // record 优先

    const fromTrace = runMemberViews(run, { records: [makeRecord({ stepIndex: 0, outcome: "completed", endedAt: T0 })], now: NOW });
    expect(fromTrace[0]!.turns).toBe(4); // record 缺省回落 trace usage.turns

    const neither = runMemberViews(makeRun(), { records: [makeRecord({ stepIndex: 0, outcome: "completed", endedAt: T0 })], now: NOW });
    expect("turns" in neither[0]!).toBe(false); // 未知缺省，不写 0
  });

  it("model 语义 = 用户显式指定值（record.model 优先）；缺省回落请求缺省标记 default——不是生效模型", () => {
    const run = makeRun([makeNode({ stepIndex: 0, status: "running", model: "default" })]);
    const views = runMemberViews(run, { records: [makeRecord({ stepIndex: 0, status: "running", model: "opencode-go/gpt-5.6" })], now: NOW });
    expect(views[0]!.model).toBe("opencode-go/gpt-5.6");

    const unspecified = runMemberViews(run, { records: [makeRecord({ stepIndex: 0, status: "running" })], now: NOW });
    expect(unspecified[0]!.model).toBe("default");

    // agent 缺省回落 trace 标签（fan-out-<i>）。
    const runWithLabel = makeRun([makeNode({ stepIndex: 0, status: "running", agent: "fan-out-2" })]);
    const agentFallback = runMemberViews(runWithLabel, { records: [makeRecord({ stepIndex: 0, status: "running", agent: "" })], now: NOW });
    expect(agentFallback[0]!.agent).toBe("fan-out-2");
  });
});

// ── 渲染预算（8K 截断）───────────────────────────────────────

describe("truncateRunMemberViews — 总字符预算截断", () => {
  /** 构造一行约 N 字符的 completed 行（model 字段撑长度，与真实行形不冲突）。 */
  function wideCompletedRow(stepIndex: number): RunMemberView {
    return {
      stepIndex,
      state: "completed",
      agent: "writer",
      model: `m/${"x".repeat(120)}`,
    };
  }

  it("总字符未超预算：全保留、truncated=false、omitted=0", () => {
    const members = [0, 1, 2].map(wideCompletedRow);
    const budget = truncateRunMemberViews(members);
    expect(budget.truncated).toBe(false);
    expect(budget.members).toHaveLength(3);
    expect(budget.total).toBe(3);
    expect(budget.omitted).toBe(0);
  });

  it("超预算触发截断：failed/cancelled 行优先保留；其余按 stepIndex 填充至预算用尽；输出保持 stepIndex 序", () => {
    const total = 200; // 200 行 × ~180 字符 ≈ 36K > 8000
    const members = Array.from({ length: total }, (_, i) => {
      const row = wideCompletedRow(i);
      return i === 150 ? { ...row, state: "failed" as const, lastError: "Request timed out." } : row;
    });
    members.push({ stepIndex: total, state: "cancelled", agent: "writer", model: "m/abort", lastError: "user cancelled" });

    const budget = truncateRunMemberViews(members, MEMBER_VIEWS_MAX_CHARS);
    expect(budget.truncated).toBe(true);
    expect(budget.total).toBe(total + 1);
    expect(budget.omitted).toBeGreaterThan(0);
    expect(budget.members.length + budget.omitted).toBe(total + 1);

    const keptStates = new Map(budget.members.map((m) => [m.stepIndex, m.state]));
    // 失败与取消行无条件保留（优先保留语义）。
    expect(keptStates.get(150)).toBe("failed");
    expect(keptStates.get(total)).toBe("cancelled");
    // 输出保持 stepIndex 升序（截断只做行选择，不改变渲染序）。
    const keptIndexes = budget.members.map((m) => m.stepIndex);
    expect([...keptIndexes].sort((a, b) => a - b)).toEqual(keptIndexes);
    // 保留行总字符不超预算（+1 换行口径；省略行文案由消费方追加，不计入本预算）。
    const keptChars = budget.members.reduce((sum, m) => sum + memberViewLine(m).length + 1, 0);
    expect(keptChars).toBeLessThanOrEqual(MEMBER_VIEWS_MAX_CHARS);
  });

  it("memberViewLine：单行渲染含状态/耗时/turns/活动与 error 尾缀（渲染与预算同一度量单位）", () => {
    const running = memberViewLine({
      stepIndex: 0,
      state: "running",
      agent: "writer",
      model: "opencode-go/gpt-5.6",
      durationMs: 6_000,
      turns: 4,
      currentActivity: "tool: bash",
    });
    expect(running.startsWith("[0] running")).toBe(true);
    expect(running).toContain("writer");
    expect(running).toContain("6.0s");
    expect(running.endsWith("turns: 4 · tool: bash")).toBe(true);

    const failed = memberViewLine({
      stepIndex: 1,
      state: "failed",
      agent: "explorer",
      model: "OpenDesign/deepseek-v4.1-flash",
      durationMs: 5_100,
      lastError: "Request timed out.",
    });
    expect(failed.startsWith("[1] failed")).toBe(true);
    expect(failed.endsWith("error: Request timed out.")).toBe(true);
  });

  it("空表与极值：空数组原样返回；首个优先行超预算时保留空集但如实上报 truncated/omitted", () => {
    expect(truncateRunMemberViews([])).toEqual({ members: [], truncated: false, total: 0, omitted: 0 });

    const huge = [{ stepIndex: 0, state: "failed" as const, agent: "a".repeat(9000), model: "m", lastError: "e" }];
    const budget = truncateRunMemberViews(huge, MEMBER_VIEWS_MAX_CHARS);
    expect(budget.truncated).toBe(true);
    expect(budget.members).toHaveLength(0);
    expect(budget.omitted).toBe(1);
  });
});
