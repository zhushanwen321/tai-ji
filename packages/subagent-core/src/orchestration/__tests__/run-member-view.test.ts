// run-member-view.test.ts —— run 成员视图纯函数测试（subagent-tool-interface-refactor
// 设计 §3.1.3 / §3.3.3 / §3.4；impl-plan u-foundation 验收条款①）。
//
// [round5-g 合并产物] 吸收同域姊妹件（成员结算派生视图两侧）：
// member-settlement-derive.test.ts（结算派生本体）。
//
// 覆盖：
// - state 映射四态（record 规则含存量回落 + trace 兜底行映射；cancelled 两源对齐——§3.3.8 trace 枚举补 cancelled）
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
import { AgentCall } from "../models/agent-call.ts";
import type { AgentCallOpts } from "../models/types.ts";
import { Trace } from "../models/trace.ts";
import type { ExecutionTraceNode } from "../models/types.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { WorkflowRunEvent } from "../run-events.ts";
import {
  ADOPTED_MEMBER_CAUSE,
  deriveRunOutcomeFromMembers,
  memberSettlementOf,
  settleMembersIntoFinalSettlement,
} from "../run-member-settlement.ts";
import { dispatchRunTrigger } from "../terminal-actions.ts";
import type { RunSettlementRecord } from "../terminal-actions.ts";
import { INITIAL_RUN_EVENT_FOLD } from "../run-events.ts";
import { IN_FLIGHT_CALL_CANCELLED_MSG } from "../worker-message-pump-constants.ts";
import type { AgentResult } from "../../shared/agent-call-types.js";

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

/** 构造带 calls / 自定义 budget 的 run（budget 四轴派生测试用——派生纯函数只读声明值）。 */
function makeRunWithState(
  calls: Map<number, AgentCall>,
  budgetOpts: ConstructorParameters<typeof Budget>[0] = {},
  recoveredCallOpts?: Map<number, AgentCallOpts>,
): WorkflowRun {
  return WorkflowRun.reconstruct(
    "wf-mv",
    { scriptSource: "async function execute() {}", args: {}, scriptName: "fan-out", scriptPath: "/fake/fan-out.js" },
    { budget: new Budget(budgetOpts), calls, trace: Trace.fromArray([]), errorLogs: [] },
    {
      startedAt: new Date(T0).toISOString(),
      ...(recoveredCallOpts !== undefined && recoveredCallOpts.size > 0 ? { recoveredCallOpts } : {}),
    },
  );
}

/** 预算声明轴的 call 形态（派生只读 opts——真实 AgentCall 的方法面与本测试无关）。 */
function callWithOpts(opts: { prompt: string; maxTurns?: number; timeoutMs?: number }): AgentCall {
  return { id: 0, opts, status: "done", attempts: 1 } as unknown as AgentCall;
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

  it("cancelled 两源对齐（§3.3.8 trace 状态枚举补 cancelled）：record 行与 trace 兜底行同判 cancelled", () => {
    const cancelled = runMemberViews(makeRun(), {
      records: [makeRecord({ stepIndex: 0, outcome: "cancelled", endedAt: T0 + 1_000 })],
      now: NOW,
    });
    expect(cancelled[0]!.state).toBe("cancelled");

    // 同一 abort 场景，record 查询不可用时：trace 节点 cancelled（closeOutInFlightCalls
    // 写点，§3.3.8）——兜底行与 record 行取消语义对齐，无降级形态差异。
    const fallback = runMemberViews(
      makeRun([makeNode({ stepIndex: 0, status: "cancelled", error: "aborted: user cancelled" })]),
      { now: NOW },
    );
    expect(fallback[0]!.state).toBe("cancelled");
    expect(fallback[0]!.lastError).toBe("aborted: user cancelled");

    // trace 节点 failed 仍判 failed（真实失败形态不因枚举扩展漂移）。
    const failedFallback = runMemberViews(
      makeRun([makeNode({ stepIndex: 0, status: "failed", error: "boom" })]),
      { now: NOW },
    );
    expect(failedFallback[0]!.state).toBe("failed");
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

// ── budget 四轴分轴显式（§3.3.6/§3.3.9）──────────────────────

describe("runMemberViews — budget 四轴分轴显式", () => {
  it("per-call 轴取同 stepIndex call opts（maxTurns/timeoutMs）；run 级轴取 state.budget 声明值", () => {
    const run = makeRunWithState(
      new Map([[0, callWithOpts({ prompt: "t", maxTurns: 5, timeoutMs: 60_000 })]]),
      { maxTokens: 1000, maxTimeMs: 120_000 },
    );
    const views = runMemberViews(run, { records: [makeRecord({ stepIndex: 0, status: "running", startedAt: T0 })], now: NOW });
    expect(views[0]!.budget).toEqual({
      maxTurns: 5,
      timeoutMs: 60_000,
      budgetTokens: 1000,
      budgetTimeMs: 120_000,
    });
  });

  it("未声明轴 = null（显式无界）：无 call 的 stepIndex 两轴 null；budget 未设轴 null", () => {
    const run = makeRunWithState(new Map(), { maxTokens: 1000 });
    const views = runMemberViews(run, { records: [makeRecord({ stepIndex: 3, status: "running", startedAt: T0 })], now: NOW });
    expect(views[0]!.budget).toEqual({
      maxTurns: null,
      timeoutMs: null,
      budgetTokens: 1000,
      budgetTimeMs: null,
    });
  });

  it("<=0 与未传同语义（执法点「不限」）→ null；trace 兜底行同样附加 budget", () => {
    const run = makeRunWithState(
      new Map([[0, callWithOpts({ prompt: "t", maxTurns: 0, timeoutMs: -1 })]]),
      { maxTokens: 0 },
    );
    const views = runMemberViews(run, { now: NOW }); // 无 records → trace 兜底行为空集
    expect(views).toEqual([]);

    // trace 兜底行（stepIndex 0）也附加 budget（声明事实不随行来源变化）
    const runWithNode = WorkflowRun.reconstruct(
      "wf-mv",
      { scriptSource: "async function execute() {}", args: {}, scriptName: "fan-out", scriptPath: "/fake/fan-out.js" },
      {
        budget: new Budget({ maxTokens: 0 }),
        calls: new Map([[0, callWithOpts({ prompt: "t", maxTurns: 0, timeoutMs: -1 })]]),
        trace: Trace.fromArray([makeNode({ stepIndex: 0, status: "completed" })]),
        errorLogs: [],
      },
      { startedAt: new Date(T0).toISOString() },
    );
    const fallbackViews = runMemberViews(runWithNode, { now: NOW });
    expect(fallbackViews[0]!.budget).toEqual({ maxTurns: null, timeoutMs: null, budgetTokens: null, budgetTimeMs: null });
  });

  it("重派集窗口（calls miss）：budget 回落 meta.recoveredCallOpts 的声明值——已声明上界不显示为显式无界；record 行与 trace 兜底行同域", () => {
    // 重建形态：重派集成员 calls 不建条目、声明入参经 agent-started input 载荷恢复进
    // meta（resume-run-rebuild）；行来源两形态（record 行 / trace 兜底行）走同一回落。
    const recovered = new Map<number, AgentCallOpts>([[2, { prompt: "t", maxTurns: 7, timeoutMs: 30_000 }]]);
    const run = WorkflowRun.reconstruct(
      "wf-mv",
      { scriptSource: "async function execute() {}", args: {}, scriptName: "fan-out", scriptPath: "/fake/fan-out.js" },
      {
        budget: new Budget({ maxTokens: 800 }),
        calls: new Map(),
        trace: Trace.fromArray([makeNode({ stepIndex: 2, status: "running" })]),
        errorLogs: [],
      },
      { startedAt: new Date(T0).toISOString(), recoveredCallOpts: recovered },
    );
    const expected = { maxTurns: 7, timeoutMs: 30_000, budgetTokens: 800, budgetTimeMs: null };

    const traceRow = runMemberViews(run, { now: NOW }); // 无 records → trace 兜底行
    expect(traceRow[0]!.budget).toEqual(expected);

    const recordRow = runMemberViews(run, {
      records: [makeRecord({ stepIndex: 2, status: "running", startedAt: T0 })],
      now: NOW,
    });
    expect(recordRow[0]!.budget).toEqual(expected);
  });

  it("worker 重派后 calls 条目优先于陈旧恢复表；恢复表未覆盖的 stepIndex 仍 = 未声明 null", () => {
    const run = makeRunWithState(
      new Map([[0, callWithOpts({ prompt: "t", maxTurns: 5 })]]),
      { maxTokens: 100 },
      new Map<number, AgentCallOpts>([
        [0, { prompt: "stale", maxTurns: 9 }], // 陈旧条目：calls 已重建，须被真值覆盖
        [3, { prompt: "t3", timeoutMs: 15_000 }], // calls miss 的回落条目
      ]),
    );
    const views = runMemberViews(run, {
      records: [
        makeRecord({ stepIndex: 0, status: "running", startedAt: T0 }),
        makeRecord({ stepIndex: 1, status: "running", startedAt: T0 }),
      ],
      now: NOW,
    });
    expect(views[0]!.budget).toEqual({ maxTurns: 5, timeoutMs: null, budgetTokens: 100, budgetTimeMs: null });
    // stepIndex 1：calls 与恢复表皆无 → 未声明 = null（显式无界）
    expect(views[1]!.budget).toEqual({ maxTurns: null, timeoutMs: null, budgetTokens: 100, budgetTimeMs: null });
  });
});

// ── 交付校验缺口与成员行渲染段（subagent-observability §3.3.6/§3.3.10 对齐）──

describe("runMemberViews — 交付校验缺口事实（scriptResult.partialMembers 对齐成员行）", () => {
  it("部分交付成员行携带 missingDeliverables（按 stepIndex 对齐）；畸形条目不入行", () => {
    const run = makeRun();
    run.state.scriptResult = {
      status: "partial",
      partialMembers: [
        { taskIndex: 1, missing: ["file:/abs/report.md (not readable (ENOENT))"] },
        { taskIndex: "2", missing: ["x"] }, // taskIndex 非数字 → 畸形丢弃
      ],
    };
    const views = runMemberViews(run, {
      records: [
        makeRecord({ stepIndex: 0, outcome: "completed", endedAt: T0 + 1_000 }),
        makeRecord({ stepIndex: 1, outcome: "completed", endedAt: T0 + 2_000 }),
      ],
      now: NOW,
    });
    expect(views[0]!.missingDeliverables).toBeUndefined(); // 全满足成员无缺口事实
    expect(views[1]!.missingDeliverables).toEqual(["file:/abs/report.md (not readable (ENOENT))"]);
  });

  it("scriptResult 无 partialMembers 载荷 → 全行无缺口字段（缺省不写词）", () => {
    const run = makeRun();
    run.state.scriptResult = { status: "ok", results: [] };
    const views = runMemberViews(run, {
      records: [makeRecord({ stepIndex: 0, outcome: "completed", endedAt: T0 + 1_000 })],
      now: NOW,
    });
    expect("missingDeliverables" in views[0]!).toBe(false);
  });
});

describe("memberViewLine — 失败分类 / budget 上界 / 交付缺口渲染段（§3.3.6 成员行对齐）", () => {
  it("failed 行缀 failure 点拼段 + error 尾缀；无失败事实行不产 failure 段", () => {
    const withFailure = memberViewLine({
      stepIndex: 1,
      state: "failed",
      agent: "explorer",
      model: "m",
      durationMs: 5_100,
      failure: "provider.rate_limited",
      lastError: "Request timed out.",
    });
    expect(withFailure).toContain("failure: provider.rate_limited");
    expect(withFailure.endsWith("error: Request timed out.")).toBe(true);

    const noFailure = memberViewLine({
      stepIndex: 2,
      state: "completed",
      agent: "writer",
      model: "m",
      durationMs: 1_000,
    });
    expect(noFailure).not.toContain("failure:");
  });

  it("budget 段只渲染声明了生效上界的轴；全无界行与缺 budget 字段行不产段", () => {
    const bounded = memberViewLine({
      stepIndex: 0,
      state: "running",
      agent: "writer",
      model: "m",
      budget: { maxTurns: 5, timeoutMs: null, budgetTokens: 1000, budgetTimeMs: null },
    });
    expect(bounded).toContain("budget: maxTurns=5 budgetTokens=1000");

    const unbounded = memberViewLine({
      stepIndex: 0,
      state: "running",
      agent: "writer",
      model: "m",
      budget: { maxTurns: null, timeoutMs: null, budgetTokens: null, budgetTimeMs: null },
    });
    expect(unbounded).not.toContain("budget:");

    const noBudgetField = memberViewLine({
      stepIndex: 0,
      state: "running",
      agent: "writer",
      model: "m",
    });
    expect(noBudgetField).not.toContain("budget:");
  });

  it("部分交付成员行缀 deliverables 缺口段", () => {
    const line = memberViewLine({
      stepIndex: 3,
      state: "completed",
      agent: "writer",
      model: "m",
      durationMs: 2_000,
      missingDeliverables: ["file:/abs/a.md", "structured_output"],
    });
    expect(line).toContain("deliverables: 2 missing");
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

// ══════ 来源: member-settlement-derive.test.ts ══════

// [subagent-observability §3.3.8] run 终局吸收成员交付的行为锁（u4 验收①③）：
// - 场景 2 断言：fan-out 半数失败 → partially_succeeded + failedMembers[].cause 点拼
//   （reason 不丢由 runtime WORKFLOW_DONE_REASON_SET 扩值承接——runtime 侧词表对账
//   在 packages/runtime/test/workflow-outcome-vocab-parity.test.ts，不在本包）；
// - UC-16 断言：run 主动取消不产生 partially_succeeded（cancelled 优先于成员集合派生，
//   被收尾成员判 cancelled 不判 failed）；
// - 脚本层失败（worker error / replay mismatch，run.state.error 有值）不被成员派生
//   覆盖（run 级终局优先序第二级——harness 系统层失败，成员无责）。
// 纯函数直测（无 IO / 无时钟——成员集合从 WorkflowRun.state.calls 构造）。


const BASE_OPTS: AgentCallOpts = { prompt: "task", agent: "member-agent" };

function makeTraceNode(id: number): ExecutionTraceNode {
  return {
    id,
    agent: "member-agent",
    status: "pending",
    children: [],
  } as unknown as ExecutionTraceNode;
}

/** 构造带 N 个已结算成员的 run 聚合（calls 直填——派生纯函数只读 calls 形态）。 */
function makeRunWithMembers(results: Array<AgentResult | undefined>): WorkflowRun {
  return new WorkflowRun(
    "wf-test",
    { scriptName: "fan-out", scriptSource: "", args: {} } as ConstructorParameters<typeof WorkflowRun>[1],
    {
      calls: new Map(
        results.map((result, i) => {
          const call = {
            id: i,
            opts: BASE_OPTS,
            status: result !== undefined ? "done" : "running",
            attempts: 1,
            ...(result !== undefined ? { result } : {}),
            traceNode: makeTraceNode(i),
          };
          return [i, call] as const;
        }),
      ),
      trace: { update: () => {} },
      budget: { usedTokens: 0, usedCost: 0 },
      scriptResult: undefined,
      error: undefined,
    } as unknown as ConstructorParameters<typeof WorkflowRun>[2],
    { startedAt: new Date(0).toISOString() },
  );
}

const OK: AgentResult = { content: "ok", sessionId: "s" };
const FAIL: AgentResult = {
  content: "",
  error: "provider rate_limited: too many requests",
  failure: { class: "provider", kind: "rate_limited", retryable: "conditional", retryAfterMs: 1200, raw: "provider rate_limited: too many requests" },
  sessionId: "s",
};
const FAIL_UNCLASSIFIED: AgentResult = {
  content: "",
  error: "something broke",
  sessionId: "s",
};
const CLOSEOUT_CANCELLED: AgentResult = {
  content: "",
  error: IN_FLIGHT_CALL_CANCELLED_MSG,
  sessionId: "s",
};
// [§3.3.1 P6] 被接管轮回执形态（output-collector collectOutcome ②-A 支）：回执层
// 成功、引擎未执行——无 error、无失败分类、无停因、promptDisposition=handled。
const ADOPTED: AgentResult = {
  content: "",
  sessionId: "s",
  promptDisposition: "handled",
};

const BASE_RECORD: RunSettlementRecord = { outcome: "done", settledAt: 0 };

describe("[§3.3.8 场景 2] run 终局吸收成员交付：partially_succeeded + failedMembers", () => {
  it("fan-out 半数失败（1 成功 1 失败）→ partially_succeeded + failedMembers[].cause 点拼", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([OK, FAIL]));
    expect(derived).toBeDefined();
    expect(derived!.outcome).toBe("partially_succeeded");
    expect(derived!.failedMembers).toEqual([{ taskIndex: 1, cause: "provider.rate_limited" }]);
  });

  it("全部成功交付 → done（无失败明细）", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([OK, OK]));
    expect(derived!.outcome).toBe("done");
    expect(derived!.failedMembers).toBeUndefined();
  });

  it("全部失败 → failed（明细如实逐成员携带）", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([FAIL, FAIL_UNCLASSIFIED]));
    expect(derived!.outcome).toBe("failed");
    expect(derived!.failedMembers).toEqual([
      { taskIndex: 0, cause: "provider.rate_limited" },
      { taskIndex: 1, cause: "unknown" },
    ]);
  });

  it("空成员集 → undefined（脚本层判定，回落 DoneReason 路径）", () => {
    expect(deriveRunOutcomeFromMembers(makeRunWithMembers([]))).toBeUndefined();
  });

  it("closeOut 收尾成员（IN_FLIGHT_CALL_CANCELLED_MSG）判 cancelled 不判 failed——无失败集不误升", () => {
    // 1 成功 + 1 被收尾取消：cancelled 不进失败集——存在交付且无失败 → done
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([OK, CLOSEOUT_CANCELLED]));
    expect(derived!.outcome).toBe("done");
    expect(derived!.failedMembers).toBeUndefined();
  });

  it("settleMembersIntoFinalSettlement：completed DoneReason 被成员派生升格 partially_succeeded（帧终局形态）", () => {
    const run = makeRunWithMembers([OK, FAIL]);
    const record = settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "done" });
    expect(record.outcome).toBe("partially_succeeded");
    expect(record.failedMembers).toEqual([{ taskIndex: 1, cause: "provider.rate_limited" }]);
  });

  it("error 前缀协议码回落点拼：failure 缺席时 cause = engine.<code>", () => {
    const run = makeRunWithMembers([
      OK,
      { content: "", error: "engine_crashed: worker died", sessionId: "s" },
    ]);
    const derived = deriveRunOutcomeFromMembers(run);
    expect(derived!.outcome).toBe("partially_succeeded");
    expect(derived!.failedMembers).toEqual([{ taskIndex: 1, cause: "engine.engine_crashed" }]);
  });
});

describe("[§3.3.8/§3.3.10 联动] 部分交付支：脚本层交付校验事实接入 run 结算", () => {
  it("无失败 + 脚本层部分交付事实 → done 升格 partially_succeeded + partialMembers 帧明细", () => {
    const run = makeRunWithMembers([OK, OK]);
    run.state.scriptResult = {
      status: "ok",
      results: [],
      partialMembers: [{ taskIndex: 1, missing: ['file:/abs/report.md (not readable (ENOENT))'] }],
    };
    const record = settleMembersIntoFinalSettlement(run, BASE_RECORD);
    expect(record.outcome).toBe("partially_succeeded");
    expect(record.partialMembers).toEqual([
      { taskIndex: 1, missing: ['file:/abs/report.md (not readable (ENOENT))'] },
    ]);
    expect(record.failedMembers).toBeUndefined();
  });

  it("部分失败 + 部分交付并存 → partially_succeeded 携带 failedMembers 与 partialMembers 双明细", () => {
    const run = makeRunWithMembers([OK, FAIL, OK]);
    run.state.scriptResult = {
      status: "partial",
      partialMembers: [{ taskIndex: 2, missing: ["structured_output (no valid structured output)"] }],
    };
    const record = settleMembersIntoFinalSettlement(run, BASE_RECORD);
    expect(record.outcome).toBe("partially_succeeded");
    expect(record.failedMembers).toEqual([{ taskIndex: 1, cause: "provider.rate_limited" }]);
    expect(record.partialMembers).toEqual([
      { taskIndex: 2, missing: ["structured_output (no valid structured output)"] },
    ]);
  });

  it("无部分交付事实（scriptResult 缺 partialMembers 载荷）→ done 不升格、帧无 partialMembers", () => {
    const run = makeRunWithMembers([OK, OK]);
    run.state.scriptResult = { status: "ok", results: [] };
    const record = settleMembersIntoFinalSettlement(run, BASE_RECORD);
    expect(record.outcome).toBe("done");
    expect(record.partialMembers).toBeUndefined();
  });

  it("畸形 partialMembers 条目（taskIndex 非整数 / missing 非字符串数组）fail-visible 丢弃——不进终局帧", () => {
    const run = makeRunWithMembers([OK, OK]);
    run.state.scriptResult = {
      status: "ok",
      partialMembers: [
        { taskIndex: "0", missing: ["x"] }, // taskIndex 非数字
        { taskIndex: 1, missing: "not-an-array" }, // missing 非数组
      ],
    };
    const record = settleMembersIntoFinalSettlement(run, BASE_RECORD);
    expect(record.outcome).toBe("done");
    expect(record.partialMembers).toBeUndefined();
  });

  it("脚本层失败（run.state.error）优先——不消费 partialMembers、不升格", () => {
    const run = makeRunWithMembers([OK, OK]);
    run.state.error = "fan-out: all tasks failed (2/2)";
    run.state.scriptResult = { partialMembers: [{ taskIndex: 0, missing: ["x"] }] };
    const record = settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "failed" });
    expect(record.outcome).toBe("failed");
    expect(record.partialMembers).toBeUndefined();
  });
});

describe("[§3.3.8/UC-16] run 级终局优先于成员集合派生", () => {
  it("UC-16：run 主动取消（cancelled）不被成员派生覆盖——不产生 partially_succeeded", () => {
    const run = makeRunWithMembers([OK, CLOSEOUT_CANCELLED]); // 1 成功 + 1 被取消收尾
    const record = settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "cancelled" });
    expect(record.outcome).toBe("cancelled");
    expect(record.failedMembers).toBeUndefined();
  });

  it("budget_limited / time_limited 终局同样不被成员集合覆盖（优先族）", () => {
    const run = makeRunWithMembers([OK, FAIL]);
    expect(settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "failed", errorCode: "budget_limited" }).outcome).toBe("failed");
    expect(settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "time_limited" }).outcome).toBe("time_limited");
  });

  it("脚本层失败（run.state.error 有值——worker error / replay mismatch）维持 failed 不被覆盖", () => {
    const run = makeRunWithMembers([OK, OK]);
    run.state.error = "replay input mismatch: prompt drifted";
    const record = settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "failed" });
    expect(record.outcome).toBe("failed");
    expect(record.failedMembers).toBeUndefined();
  });

  it("in-flight 成员（未 settled）判 cancelled——成功成员在场时 run 不升 partially_succeeded", () => {
    // run 正常收尾（completed）但有一个成员未落定（closeOut 前的形态）：
    // cancelled 成员不计失败 → 无失败 + 存在交付 = done（UC-16 同语义面）
    const run = makeRunWithMembers([OK, undefined]);
    const record = settleMembersIntoFinalSettlement(run, BASE_RECORD);
    expect(record.outcome).toBe("done");
    expect(record.failedMembers).toBeUndefined();
  });
});

describe("[§3.3.8 P6 定稿] 被接管成员的聚合与 resume 归属", () => {
  /** 构造 done 态真实 AgentCall（memberSettlementOf 直测的形态还原——markRunning/markDone 状态机链）。 */
  function doneCall(id: number, result: AgentResult): AgentCall {
    const call = new AgentCall(id, BASE_OPTS, makeTraceNode(id));
    call.markRunning();
    call.markDone(result);
    return call;
  }

  it("memberSettlementOf：被接管轮（promptDisposition=handled）判 cancelled 不判 delivered——回执层成功不冒充交付", () => {
    expect(memberSettlementOf(doneCall(0, ADOPTED))).toBe("cancelled");
    // 对照组：同形回执（无接管事实）判 delivered
    expect(memberSettlementOf(doneCall(1, { content: "", sessionId: "s" }))).toBe("delivered");
  });

  it("部分被接管（1 交付 + 1 被接管）：被接管按「未交付且非失败」计——不进失败明细、run done", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([OK, ADOPTED]));
    expect(derived!.outcome).toBe("done");
    expect(derived!.failedMembers).toBeUndefined();
  });

  it("全部成员被接管（零交付零失败）→ run failed + 逐成员被接管明细（harness.member_adopted，不借用 agent.no_deliverable）", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([ADOPTED, ADOPTED]));
    expect(derived!.outcome).toBe("failed");
    expect(derived!.failedMembers).toEqual([
      { taskIndex: 0, cause: ADOPTED_MEMBER_CAUSE },
      { taskIndex: 1, cause: ADOPTED_MEMBER_CAUSE },
    ]);
    // 终局帧形态：done 合成记录被派生升格 failed + 明细（脚本正常收尾、成员全被接管）
    const record = settleMembersIntoFinalSettlement(makeRunWithMembers([ADOPTED, ADOPTED]), BASE_RECORD);
    expect(record.outcome).toBe("failed");
    expect(record.failedMembers).toEqual([
      { taskIndex: 0, cause: ADOPTED_MEMBER_CAUSE },
      { taskIndex: 1, cause: ADOPTED_MEMBER_CAUSE },
    ]);
  });

  it("混合失败 + 被接管：失败成员进明细，被接管成员按未交付计不泄漏进失败明细", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([OK, FAIL, ADOPTED]));
    expect(derived!.outcome).toBe("partially_succeeded");
    expect(derived!.failedMembers).toEqual([{ taskIndex: 1, cause: "provider.rate_limited" }]);
  });

  it("被接管与 closeOut 取消可区分：全 closeOut 取消（非接管）不触发全接管 failed 档", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([CLOSEOUT_CANCELLED, undefined]));
    expect(derived!.outcome).toBe("done");
    expect(derived!.failedMembers).toBeUndefined();
  });
});

describe("[§3.3.8 cause 序列化 guard] 点拼无自由文本泄漏（F1-11/F1-56）", () => {
  it("error 契约形态但前缀非协议码（含 ': ' 的自由文本）→ engine.unknown（fail-visible）", () => {
    const run = makeRunWithMembers([
      OK,
      { content: "", error: "connect ECONNREFUSED 127.0.0.1:8080: connection refused", sessionId: "s" },
    ]);
    const derived = deriveRunOutcomeFromMembers(run);
    expect(derived!.failedMembers).toEqual([{ taskIndex: 1, cause: "engine.unknown" }]);
  });

  it("无 ': ' 契约形态的 error → unknown（未分类标记，无 class 断言）", () => {
    const derived = deriveRunOutcomeFromMembers(makeRunWithMembers([OK, FAIL_UNCLASSIFIED]));
    expect(derived!.failedMembers).toEqual([{ taskIndex: 1, cause: "unknown" }]);
  });

  it("error_ 透传面前缀同样落 engine.<code>（SDK 透传契约）", () => {
    const run = makeRunWithMembers([
      OK,
      { content: "", error: "engine_provider_timeout: upstream timed out", sessionId: "s" },
    ]);
    const derived = deriveRunOutcomeFromMembers(run);
    expect(derived!.failedMembers).toEqual([{ taskIndex: 1, cause: "engine.engine_provider_timeout" }]);
  });
});

describe("[§3.3.8 脚本层失败两形态分流] 成员明细的抑制边界（F1-60）", () => {
  it("全成员失败 + 脚本 throw（fan-out 全败终局上报）：终局帧带全量 failedMembers 明细", () => {
    const run = makeRunWithMembers([FAIL, FAIL_UNCLASSIFIED]);
    run.state.error = "fan-out: all tasks failed (2/2)";
    const record = settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "failed" });
    expect(record.outcome).toBe("failed"); // harness 层裁决不被改档
    expect(record.failedMembers).toEqual([
      { taskIndex: 0, cause: "provider.rate_limited" },
      { taskIndex: 1, cause: "unknown" },
    ]);
  });

  it("存在未终局成员的脚本层失败（worker crash 形态）：成员无责——明细维持抑制", () => {
    const run = makeRunWithMembers([FAIL, undefined]); // 第二成员在途（无 result）
    run.state.error = "worker exited without result";
    const record = settleMembersIntoFinalSettlement(run, { ...BASE_RECORD, outcome: "failed" });
    expect(record.outcome).toBe("failed");
    expect(record.failedMembers).toBeUndefined();
  });
});

describe("[§3.3.8] INITIAL_RUN_EVENT_FOLD 兼容（runSettled 骨架新字段缺省形态）", () => {
  it("fold 初值 runSettled = undefined（新字段不破坏既有 fold 契约）", () => {
    expect(INITIAL_RUN_EVENT_FOLD.runSettled).toBeUndefined();
  });
});
