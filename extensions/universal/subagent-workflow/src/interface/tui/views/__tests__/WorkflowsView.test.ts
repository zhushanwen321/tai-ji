/**
 * WorkflowsView 纯函数三块合一（同被测文件 views/WorkflowsView.ts 及其 companion
 * detail-content.ts）：渲染签名 / live 配对 / detail session 路径行，fixture 同族共享。
 *
 * ── computeRenderSignature（IF11/TC7/DM6）— 渲染签名单测（now 参数化） ──
 *
 * 契约：tick 条件失效的判据——签名字段集覆盖 header（renderHeader）/节点行
 * （renderLevel1 agent list）/L2 detail（buildDetailContent）当前消费的全部动态
 * 字段。本测试证明「已入字段变化 → 签名变」+「静态 run 不变」（完备性无法靠
 * 测试证明，字段核对表见 WorkflowsView.ts computeRenderSignature doc）。
 *
 * [H2 W3] live 数据源切换：签名第 2 参从 node.live 直读改为 store record 投影
 * （Map<stepIndex, LiveProgressView>，经 collectNodeLiveProgress 配对注入）——
 * 字段口径不变（totalTokens/toolCallCount/elapsedSeconds/turns/eventLog.length/
 * currentActivity/lastError），本文件用 makeLiveView 直接构造投影驱动「已入字段
 * 变 → 签名变」。
 *
 * 确定性说明：签名非完全纯——live 投影的 elapsedSeconds 由 projectRecordProgress
 * 内 computeElapsedSeconds 现算（record.endedAt ?? Date.now()）。fake timers 控制
 * Date.now() 与 now 参数同源推进，保证确定性。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { LiveProgressView } from "../detail-content.ts";
import { buildDetailContent } from "../detail-content.ts";
import type { ThemeLike } from "../../../format/format.ts";
import { collectNodeLiveProgress, computeRenderSignature } from "../WorkflowsView.ts";
import { noteRebuiltSettlement } from "@zhushanwen/subagent-core";
import type { AgentEventLogEntry } from "@zhushanwen/subagent-core";
import type { ExecutionTraceNode, WorkerLogEntry } from "@zhushanwen/subagent-core";
import type { SubagentRecord } from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";

// ── Fixtures（duck typing）──

const T0 = 1_700_000_000_000; // 固定 epoch ms

function makeLiveView(overrides: Partial<LiveProgressView> = {}): LiveProgressView {
  return {
    totalTokens: 0,
    toolCallCount: 0,
    elapsedSeconds: 5,
    turns: 0,
    eventLog: [],
    currentActivity: undefined,
    lastError: undefined,
    ...overrides,
  };
}

function makeEventLog(entries: Partial<AgentEventLogEntry>[] = []): AgentEventLogEntry[] {
  return entries.map((e, i) => ({ type: "tool_start", label: `t-${i}`, ts: T0, ...e })) as AgentEventLogEntry[];
}

function makeNode(overrides: Partial<ExecutionTraceNode> = {}): ExecutionTraceNode {
  return {
    stepIndex: 0,
    agent: "worker",
    task: "do",
    model: "default",
    status: "running",
    ...overrides,
  };
}

type RunShape = {
  status?: string;
  budget?: { usedTokens: number; maxTokens?: number; usedCost: number };
  nodes?: ExecutionTraceNode[];
  errorLogs?: WorkerLogEntry[];
}

function makeRun(shape: RunShape = {}): WorkflowRun {
  return makeRunWithId(`wf-sig-${signatureRunSeq++}`, shape);
}

/** [W2/V1] runId 唯一化 + spec 最小面（displayStatusOf → core runSummary 投影
 *  读 runId/spec.scriptName——签名测试的 mock 需携带该最小字段集）。
 *  [D6(a) 第 1 步] 终局判定源 = 终局记录注册表：done 形态 fixture 必须携带注册表
 *  条目（生产 = 壳重建点 noteRebuiltSettlement 注入 run-settled 帧事实）。 */
let signatureRunSeq = 0;
function makeRunWithId(runId: string, shape: RunShape): WorkflowRun {
  const status = shape.status ?? "running";
  if (status === "done") {
    noteRebuiltSettlement(runId, { outcome: "done", settledAt: Date.parse("2026-09-27T00:00:00.000Z") });
  }
  return {
    runId,
    spec: { scriptName: "sig-wf" },
    meta: { startedAt: "2026-09-27T00:00:00.000Z" },
    state: {
      status,
      budget: shape.budget ?? { usedTokens: 0, maxTokens: 200_000, usedCost: 0 },
      trace: { toArray: () => shape.nodes ?? [] },
      errorLogs: shape.errorLogs ?? [],
    },
  } as unknown as WorkflowRun;
}

/** 单节点 run + 该节点的 live 投影（最常见断言形态的便捷封装）。 */
function runWithLive(nodeOverrides: Partial<ExecutionTraceNode>, live: LiveProgressView) {
  const node = makeNode(nodeOverrides);
  return {
    run: makeRun({ nodes: [node] }),
    live: new Map<number, LiveProgressView>([[node.stepIndex, live]]),
  };
}

/** plain theme: 着色方法直接返回原文，无 ANSI 色码——测试断言纯文本。
 *  bg/underline 为宽 ThemeLike 接口的 no-op 实现（workflow 渲染面只用 fg/bold）。 */
const plainTheme: ThemeLike = {
  bg: (_color: string, text: string) => text,
  fg: (_tag: string, text: string) => text,
  bold: (text: string) => text,
  underline: (text: string) => text,
};

/** collectNodeLiveProgress 配对用 run：只含 trace 节点面（task/status/startedAt）。 */
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("computeRenderSignature — 基础确定性", () => {
  it("同输入同签名（含 live 投影，elapsedSeconds 固定值确定）", () => {
    const { run, live } = runWithLive({}, makeLiveView());
    expect(computeRenderSignature(run, live, T0)).toBe(computeRenderSignature(run, live, T0));
  });

  it("静态 run（无 live、同秒桶）200ms 内签名不变", () => {
    const run = makeRun({ nodes: [makeNode({ status: "completed" })] });
    expect(computeRenderSignature(run, new Map(), T0)).toBe(computeRenderSignature(run, new Map(), T0 + 200));
  });

  it("秒桶跨秒（now 相差 1s 桶）→ 签名变", () => {
    const run = makeRun();
    expect(computeRenderSignature(run, new Map(), T0)).not.toBe(computeRenderSignature(run, new Map(), T0 + 1000));
  });
});

describe("computeRenderSignature — run 级字段", () => {
  it("run.state.status 变化 → 签名变", () => {
    const a = makeRun({ status: "running" });
    const b = makeRun({ status: "done" });
    expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
  });

  it("completed/total 变化（节点 status 推导）→ 签名变", () => {
    const a = makeRun({ nodes: [makeNode({ status: "running" })] });
    const b = makeRun({ nodes: [makeNode({ status: "completed" })] });
    expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
  });

  it("budget tokens 量化值变化 → 签名变", () => {
    const a = makeRun({ budget: { usedTokens: 1500, maxTokens: 200_000, usedCost: 0.01 } });
    const b = makeRun({ budget: { usedTokens: 2500, maxTokens: 200_000, usedCost: 0.01 } });
    expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
  });

  it("budget cost 第 4 位小数变化（toFixed(4) 可见精度）→ 签名变", () => {
    // 0.0100 vs 0.0101：量化展示相同到第 3 位，第 4 位是渲染可见精度
    const a = makeRun({ budget: { usedTokens: 0, maxTokens: 200_000, usedCost: 0.0100 } });
    const b = makeRun({ budget: { usedTokens: 0, maxTokens: 200_000, usedCost: 0.0101 } });
    expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
  });

  it("run.state.errorLogs 追加 → 签名变（末条内容入指纹）", () => {
    const a = makeRun({ errorLogs: [{ level: "error", message: "E-0" }] });
    const b = makeRun({ errorLogs: [{ level: "error", message: "E-0" }, { level: "warn", message: "W-1" }] });
    expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
  });

  it("errorLogs 封顶后 length 不变内容移（push+slice(-MAX_ERROR_LOGS)）→ 签名仍变（指纹非 length）", () => {
    // 模拟 error-recovery 的变异路径：push 后 slice(-500) 截断。两次 state 均 500 条
    // （length 相同），仅末条/窗口内容不同——指纹含末条内容才不漏失效。
    const MAX_ERROR_LOGS = 500;
    const mk = (n: number): WorkerLogEntry => ({ level: "error", message: `E-${n}` });
    const before: WorkerLogEntry[] = Array.from({ length: MAX_ERROR_LOGS }, (_, i) => mk(i));
    const after = [...before, mk(MAX_ERROR_LOGS)].slice(-MAX_ERROR_LOGS); // E-1..E-500
    expect(after).toHaveLength(MAX_ERROR_LOGS); // 前置校验：封顶后 length 不变
    const a = makeRun({ errorLogs: before });
    const b = makeRun({ errorLogs: after });
    expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
  });
});

describe("computeRenderSignature — 节点级字段（store record 投影）", () => {
  it("节点 status 变化 → 签名变", () => {
    const a = makeRun({ nodes: [makeNode({ status: "running" })] });
    const b = makeRun({ nodes: [makeNode({ status: "failed" })] });
    expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
  });

  it("live.totalTokens 变化 → 签名变", () => {
    const a = runWithLive({}, makeLiveView({ totalTokens: 1000 }));
    const b = runWithLive({}, makeLiveView({ totalTokens: 2000 }));
    expect(computeRenderSignature(a.run, a.live, T0)).not.toBe(computeRenderSignature(b.run, b.live, T0));
  });

  it("live.toolCallCount 变化（store 投影：eventLog tool_start 计数）→ 签名变", () => {
    const a = runWithLive({}, makeLiveView({ toolCallCount: 1 }));
    const b = runWithLive({}, makeLiveView({ toolCallCount: 2 }));
    expect(computeRenderSignature(a.run, a.live, T0)).not.toBe(computeRenderSignature(b.run, b.live, T0));
  });

  it("live.elapsedSeconds 变化 → 签名变（跨秒推进）", () => {
    const run = makeRun({ nodes: [makeNode()] });
    const before = computeRenderSignature(run, new Map([[0, makeLiveView({ elapsedSeconds: 5 })]]), T0);
    const after = computeRenderSignature(run, new Map([[0, makeLiveView({ elapsedSeconds: 6 })]]), T0);
    expect(after).not.toBe(before);
  });

  it("live.turns 计数变化 → 签名变", () => {
    const a = runWithLive({}, makeLiveView({ turns: 1 }));
    const b = runWithLive({}, makeLiveView({ turns: 2 }));
    expect(computeRenderSignature(a.run, a.live, T0)).not.toBe(computeRenderSignature(b.run, b.live, T0));
  });

  it("live.eventLog 追加（length 变化）→ 签名变", () => {
    const a = runWithLive({}, makeLiveView({ eventLog: makeEventLog([{ type: "tool_start", label: "read" }]) }));
    const b = runWithLive({}, makeLiveView({ eventLog: makeEventLog([{ type: "tool_start", label: "read" }, { type: "tool_end", label: "read" }]) }));
    expect(computeRenderSignature(a.run, a.live, T0)).not.toBe(computeRenderSignature(b.run, b.live, T0));
  });

  it("live.currentActivity 出现 / 变化（type+label）→ 签名变", () => {
    const noActivity = runWithLive({}, makeLiveView({ currentActivity: undefined }));
    const withTool = runWithLive({}, makeLiveView({ currentActivity: { type: "tool", label: "write" } }));
    const otherLabel = runWithLive({}, makeLiveView({ currentActivity: { type: "tool", label: "bash" } }));

    const s0 = computeRenderSignature(noActivity.run, noActivity.live, T0);
    const s1 = computeRenderSignature(withTool.run, withTool.live, T0);
    const s2 = computeRenderSignature(otherLabel.run, otherLabel.live, T0);
    expect(s1).not.toBe(s0); // 出现
    expect(s2).not.toBe(s1); // label 变
  });

  it("live.lastError 出现（内容入签名）→ 签名变", () => {
    const a = runWithLive({}, makeLiveView({ lastError: undefined }));
    const b = runWithLive({}, makeLiveView({ lastError: "EPIPE: broken pipe" }));
    expect(computeRenderSignature(a.run, a.live, T0)).not.toBe(computeRenderSignature(b.run, b.live, T0));
  });

  it("node.sessionFile 出现 → 签名变", () => {
    const a = makeRun({ nodes: [makeNode({})] });
    const b = makeRun({ nodes: [makeNode({ sessionFile: "/tmp/sessions/run-0.jsonl" })] });
    expect(computeRenderSignature(a, new Map(), T0)).not.toBe(computeRenderSignature(b, new Map(), T0));
  });
});

describe("computeRenderSignature — 多节点与无 live 终态", () => {
  it("多节点：live 投影按 stepIndex 配对生效（live 值出现 / 消失 / 挂到另一节点 → 签名变）", () => {
    // 对比式断言：同一 run 换 live 投影驱动签名变化——词法格式串是内部表示非契约，
    // 不作为主证明（结构快照见下一条）。
    const run = makeRun({
      nodes: [
        makeNode({ stepIndex: 0, status: "completed" }),
        makeNode({ stepIndex: 1, status: "running" }),
      ],
    });
    const noLive = new Map<number, LiveProgressView>();
    const liveOnNode1 = new Map<number, LiveProgressView>([[1, makeLiveView({ totalTokens: 500 })]]);
    const liveOnNode0 = new Map<number, LiveProgressView>([[0, makeLiveView({ totalTokens: 500 })]]);

    const base = computeRenderSignature(run, noLive, T0);
    // live 值出现（挂到节点 1）→ 签名变
    expect(computeRenderSignature(run, liveOnNode1, T0)).not.toBe(base);
    // 同值 live 挂到另一节点 → 签名也变（配对按 stepIndex 生效，非全局均摊）
    expect(computeRenderSignature(run, liveOnNode0, T0)).not.toBe(computeRenderSignature(run, liveOnNode1, T0));
    // live 值消失 → 签名回落基线
    expect(computeRenderSignature(run, noLive, T0)).toBe(base);
  });

  // 结构快照（不承担主证明）：签名段集 = run 级五段 + 每节点一段；
  // 段内词法编码是内部表示，不锁定。
  it("多节点结构快照：两节点 run 签名共 7 段（run 级 5 + 节点 2）", () => {
    const run = makeRun({
      nodes: [makeNode({ stepIndex: 0 }), makeNode({ stepIndex: 1 })],
    });
    expect(computeRenderSignature(run, new Map(), T0).split("|")).toHaveLength(7);
  });

  it("节点重排（trace 数组序对调，stepIndex 维度）→ 签名变", () => {
    // 同一节点集、字段值均不变，仅 trace 数组顺序对调——nodeParts 按 trace 序拼接，
    // 首字段 stepIndex 随之换位，签名必变（不漏失效）。
    const first = makeNode({ stepIndex: 0, status: "completed" });
    const second = makeNode({ stepIndex: 1, status: "running" });
    const live = new Map([[1, makeLiveView()]]);
    const a = makeRun({ nodes: [first, second] });
    const b = makeRun({ nodes: [second, first] });
    expect(computeRenderSignature(a, live, T0)).not.toBe(computeRenderSignature(b, live, T0));
  });

  it("无节点 run 签名仅含 run 级五段（status/秒桶/completed-total/budget/errorLogs）", () => {
    const sig = computeRenderSignature(makeRun({ nodes: [] }), new Map(), T0);
    expect(sig.split("|")).toHaveLength(5);
  });
});

// ── collectNodeLiveProgress 配对（[H2 W3] store record live 进度配对） ──
//
// 配对规则：task 标签匹配 + startedAt 最近邻 + 贪心唯一；终态 node 不配；
// 无匹配 record（重试间隙）返回空。
// SubagentRecord 投影面（eventLog/turns/totalTokens 等）的投影恒等由 core 侧
// record-store 测试锁定，此处消费投影面。

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

// ── buildDetailContent session 路径行渲染 ──
//
// TUI 渲染测试：buildDetailContent 在 agent 终态时渲染 session: 路径行。
//
// 防的 bug：node.sessionFile 有值但 TUI detail 不显示——用户在交互面板里
// 看不到 agent 的 session jsonl 路径，无法定位文件做后续查看。

describe("buildDetailContent session 路径行渲染", () => {
  it("node.sessionFile 有值 → 详情末尾渲染 session: <路径>", () => {
    const sessionPath = "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl";
    const node = makeNode({
      status: "completed",
      sessionFile: sessionPath,
      result: { content: "done" },
    });
    const lines = buildDetailContent(node, { promptExpanded: false }, makeRun(), plainTheme, 120, Date.now());
    const sessionLine = lines.find((l) => l.includes("session:"));
    expect(sessionLine).toBeDefined();
    expect(sessionLine).toContain(sessionPath);
  });

  it("node.sessionFile undefined（窗口期）→ 不渲染 session: 行", () => {
    const node = makeNode({ status: "completed", sessionFile: undefined, result: { content: "done" } });
    const lines = buildDetailContent(node, { promptExpanded: false }, makeRun(), plainTheme, 120, Date.now());
    const sessionLine = lines.find((l) => l.includes("session:"));
    expect(sessionLine).toBeUndefined();
  });

  it("长路径截断到 mainWidth（防溢出）", () => {
    const longPath = "/very/long/path/" + "x".repeat(200) + "/session.jsonl";
    const node = makeNode({ status: "completed", sessionFile: longPath, result: { content: "done" } });
    const narrowWidth = 60;
    const lines = buildDetailContent(node, { promptExpanded: false }, makeRun(), plainTheme, narrowWidth, Date.now());
    const sessionLine = lines.find((l) => l.includes("session:"));
    expect(sessionLine).toBeDefined();
    // 截断后行宽不超过 mainWidth + 边框余量
    expect(sessionLine!.length).toBeLessThanOrEqual(narrowWidth);
  });
});
