/**
 * [H2 W3] store record live 进度投影单测（设计 D2 进度源切换）。
 *
 * 三组面：
 *   1. 双路径对齐（S1 等价表依据）：同一 ExecutionRecord（同构造事件序列累积出的
 *      turns 形态）→ 旧投影 projectLiveProgress(record) + getAllToolCalls(record).length
 *      vs 新投影 projectRecordProgress(SubagentRecord 投影面)。逐字段断言相等
 *      ——「数据源换 store、字段口径不变」的可证伪锁定。
 *   2. 派生恒等：toolCallCount（eventLog tool_start 计数）=== getAllToolCalls 长度
 *      （getEventLog 对每个 toolCall 恰产一条 tool_start）；lastError（eventLog 末条
 *      error label）=== record.lastError（getEventLog 仅 lastError 非空时追加末条）。
 *   3. collectNodeLiveProgress 配对：task 标签匹配 + startedAt 最近邻 + 贪心唯一；
 *      终态 node 不配；无匹配 record（重试间隙）返回空。
 *
 * ExecutionRecord 经 duck-typed 构造（对齐 WorkflowsView-signature.test.ts 先例）；
 * 新路径输入 SubagentRecord 的 eventLog/currentActivity/turns/totalTokens 取自
 * recordToSubagent 的同源投影（getEventLog/getCurrentActivity/turnCount/totalTokens
 * ——其投影恒等由 core 侧 record-store 测试锁定，此处消费投影面）。
 */
import { describe, it, expect } from "vitest";

import { computeElapsedSeconds, getAllToolCalls, projectLiveProgress } from "@zhushanwen/subagent-core";
import type { ExecutionRecord, SubagentRecord, WorkflowRun } from "@zhushanwen/subagent-core";
import { collectNodeLiveProgress } from "../WorkflowsView.ts";
import { projectRecordProgress } from "../detail-content.ts";

// ── Fixtures ──────────────────────────────────────────────────

const T0 = 1_700_000_000_000;

/** duck-typed ExecutionRecord（turns 形态对齐 updateFromEvent 累积产物）。 */
function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "sa-x",
    agent: "worker",
    model: "default",
    thinkingLevel: undefined,
    mode: "background",
    task: "调研 A",
    slug: "research-a",
    startedAt: T0,
    rootSessionId: undefined,
    parentRecordId: undefined,
    depth: 0,
    status: "running",
    turns: [],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    ...overrides,
  } as unknown as ExecutionRecord;
}

/** recordToSubagent 同源投影：SubagentRecord 的实时字段面（eventLog/currentActivity
 *  在真实链经 getEventLog/getCurrentActivity 派生，此处消费旧投影输出（同一函数产物）。 */
function toSubagentFace(record: ExecutionRecord, oldView: ReturnType<typeof projectLiveProgress>): SubagentRecord {
  return {
    id: record.id,
    agent: record.agent,
    task: record.task,
    slug: record.slug,
    status: record.status,
    mode: record.mode,
    startedAt: record.startedAt,
    rootSessionId: undefined,
    parentRecordId: undefined,
    depth: 0,
    endedAt: record.endedAt,
    turns: oldView.turns,
    totalTokens: oldView.totalTokens,
    model: record.model,
    thinkingLevel: undefined,
    eventLog: oldView.eventLog,
    displayItems: [],
    currentActivity: oldView.currentActivity,
    result: undefined,
    error: undefined,
  } as SubagentRecord;
}

/** 双 turn + running tool + lastError 的复合形态（覆盖七字段全维度）。 */
function compositeRecord(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return makeRecord({
    turnCount: 2,
    totalTokens: 12345,
    lastError: "EPIPE: broken pipe",
    turns: [
      {
        text: "turn one done",
        thinking: "",
        closed: true,
        closedTs: T0 + 1000,
        toolCalls: [
          { toolName: "read", args: { path: "/a/b.ts" }, result: "ok", isError: false, _status: "completed", startedTs: T0 + 100 },
          { toolName: "bash", args: { command: "ls" }, result: "out", isError: false, _status: "completed", startedTs: T0 + 300 },
        ],
        usageDelta: undefined,
      },
      {
        text: "",
        thinking: "planning next",
        closed: false,
        toolCalls: [
          { toolName: "write", args: { path: "/c.ts" }, result: "", isError: false, _status: "running", startedTs: T0 + 2000 },
        ],
        usageDelta: undefined,
      },
    ],
    ...over,
  });
}

// ── 1. 双路径对齐 ─────────────────────────────────────────────

describe("projectRecordProgress × projectLiveProgress 双路径对齐", () => {
  it("复合形态（双 turn + running tool + lastError）七字段逐项相等", () => {
    const record = compositeRecord();
    const oldView = projectLiveProgress(record);
    const newView = projectRecordProgress(toSubagentFace(record, oldView));

    expect(newView.totalTokens).toBe(oldView.totalTokens);
    expect(newView.toolCallCount).toBe(getAllToolCalls(record).length); // 工具计数恒等（旧路径口径）
    expect(newView.elapsedSeconds).toBe(oldView.elapsedSeconds);
    expect(newView.turns).toBe(oldView.turns);
    expect(newView.eventLog).toEqual(oldView.eventLog);
    expect(newView.currentActivity).toEqual(oldView.currentActivity);
    expect(newView.lastError).toBe(oldView.lastError);
  });

  it("空形态（零 turn 零 token）两边同退化为零值", () => {
    const record = makeRecord();
    const oldView = projectLiveProgress(record);
    const newView = projectRecordProgress(toSubagentFace(record, oldView));
    expect(newView.totalTokens).toBe(0);
    expect(newView.toolCallCount).toBe(0);
    expect(newView.turns).toBe(0);
    expect(newView.eventLog).toEqual([]);
    expect(newView.currentActivity).toBeUndefined();
    expect(newView.lastError).toBeUndefined();
  });

  it("elapsedSeconds 同源：endedAt 固定时两边都由 computeElapsedSeconds 现算", () => {
    const record = compositeRecord({ endedAt: T0 + 9000 });
    const oldView = projectLiveProgress(record);
    const newView = projectRecordProgress(toSubagentFace(record, oldView));
    const direct = computeElapsedSeconds({ startedAt: T0, endedAt: T0 + 9000 });
    expect(newView.elapsedSeconds).toBe(direct);
    expect(oldView.elapsedSeconds).toBe(direct);
  });
});

// ── 2. 派生恒等（构造性论证的行为锁定） ────────────────────────

describe("projectRecordProgress 派生恒等", () => {
  it("toolCallCount = eventLog tool_start 计数 = getAllToolCalls 长度", () => {
    const record = compositeRecord();
    const oldView = projectLiveProgress(record);
    const starts = oldView.eventLog.filter((e) => e.type === "tool_start").length;
    expect(starts).toBe(3); // read + bash + write
    expect(projectRecordProgress(toSubagentFace(record, oldView)).toolCallCount).toBe(getAllToolCalls(record).length);
  });

  it("lastError 从 eventLog 末条 error 派生；无 error 条目 → undefined", () => {
    const withErr = compositeRecord();
    const oldErr = projectLiveProgress(withErr);
    expect(oldErr.eventLog.at(-1)?.type).toBe("error"); // 前置：getEventLog 把 lastError 追加为末条
    expect(projectRecordProgress(toSubagentFace(withErr, oldErr)).lastError).toBe("EPIPE: broken pipe");

    const noErr = compositeRecord({ lastError: undefined });
    const oldNo = projectLiveProgress(noErr);
    expect(oldNo.eventLog.some((e) => e.type === "error")).toBe(false);
    expect(projectRecordProgress(toSubagentFace(noErr, oldNo)).lastError).toBeUndefined();
  });
});

// ── 3. collectNodeLiveProgress 配对（record ↔ trace node） ─────

function makeRunShape(nodes: { stepIndex: number; task: string; status: string; startedAt: string }[]): WorkflowRun {
  return {
    state: { trace: { toArray: () => nodes } },
  } as unknown as WorkflowRun;
}

function makeSub(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-match",
    task: "调研 A",
    status: "running",
    startedAt: T0,
    turns: 0,
    totalTokens: 0,
    eventLog: [],
    ...over,
  } as SubagentRecord;
}

describe("collectNodeLiveProgress 配对", () => {
  it("task 全等匹配：running node ↔ running record，投影挂到 stepIndex", () => {
    const run = makeRunShape([{ stepIndex: 0, task: "调研 A", status: "running", startedAt: new Date(T0).toISOString() }]);
    const live = collectNodeLiveProgress(run, [makeSub({ totalTokens: 42 })]);
    expect(live.get(0)?.totalTokens).toBe(42);
  });

  it("多候选（parallel 同 prompt）取 startedAt 最近邻，贪心一一不重复消费", () => {
    const run = makeRunShape([
      { stepIndex: 0, task: "调研 A", status: "running", startedAt: new Date(T0).toISOString() },
      { stepIndex: 1, task: "调研 A", status: "running", startedAt: new Date(T0 + 5000).toISOString() },
    ]);
    const near0 = makeSub({ id: "sa-near0", startedAt: T0 + 10, totalTokens: 100 });
    const near1 = makeSub({ id: "sa-near1", startedAt: T0 + 5010, totalTokens: 200 });
    const live = collectNodeLiveProgress(run, [near1, near0]);
    expect(live.get(0)?.totalTokens).toBe(100); // node0(startedAt=T0) 最近 = near0
    expect(live.get(1)?.totalTokens).toBe(200); // node1(T0+5s) 最近 = near1
  });

  it("终态 node 不配对；task 不匹配（不同 prompt）不配对", () => {
    const run = makeRunShape([
      { stepIndex: 0, task: "调研 A", status: "completed", startedAt: new Date(T0).toISOString() },
      { stepIndex: 1, task: "写总结", status: "running", startedAt: new Date(T0).toISOString() },
    ]);
    const live = collectNodeLiveProgress(run, [makeSub({ task: "调研 A", totalTokens: 99 })]);
    expect(live.size).toBe(0); // node0 终态跳过；node1 task 不匹配
  });

  it("重试间隙（无 running record）→ 空 map（views 走终态 fallback 渲染）", () => {
    const run = makeRunShape([{ stepIndex: 0, task: "调研 A", status: "running", startedAt: new Date(T0).toISOString() }]);
    const live = collectNodeLiveProgress(run, [makeSub({ status: "closed" })]);
    expect(live.size).toBe(0);
  });
});
