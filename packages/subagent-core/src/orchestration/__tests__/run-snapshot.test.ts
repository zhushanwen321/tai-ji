// run-snapshot.test.ts —— WorkflowRun 快照 codec 单源（下沉收口 D4/U8）。
//
// 四视角：
// ①使用者——toRunSnapshot/fromRunSnapshot 往返等值（含 pi 壳 jsonl-run-store
//   serializeRun 现网形态样本：键序/v 字段/无 live 的快照行，⛔5 往返逐字节一致）；
// ②隔离者——[H2 W3] ExecutionTraceNode.live 字段退役后节点无运行期附属对象，
//   序列化直出无 live 键（strip 分支随字段删除退役，防御回归锁定）；
// ③幸存者——版本 guard（D4 裁决③：v 不匹配即拒，字符串无大小序）+ 形状校验
//   全分支不抛（返回 undefined）；
// ④接线者——「缺 v 宽容」不内聚进 codec（D4 裁决②归属：store 层预处理职责，
//   codec 层缺 v 即拒，保 pi 侧 v1 存量静默跳过语义）+ spec.budgetRef 剔除。
//
// 纯内存测试：无 configureCore 依赖（codec 不触 host-services）。

import { describe, expect, it } from "vitest";

import type { ExecutionRecord } from "../../execution/assembly/types.ts";
import type { ExecutionTraceNode } from "../models/types.ts";
import { AgentCall } from "../models/agent-call.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { WorkflowRunEvent } from "../run-events.ts";
import { SNAPSHOT_VERSION, fromRunSnapshot, projectRunEvents, toRunSnapshot } from "../run-snapshot.ts";

/** 构造可持久化的 WorkflowRun（对齐 file-run-store.test.ts makeRun 模式）。 */
function makeRun(runId: string, opts: { status?: "running" | "done" } = {}): WorkflowRun {
  const status = opts.status ?? "running";
  return WorkflowRun.reconstruct(
    runId,
    {
      scriptSource: "export function execute() { return 'ok'; }",
      args: { topic: "demo", count: 2 },
      scriptName: "test-script",
      scriptPath: "/fake/test.js",
      parameters: { type: "object" },
      budgetTokens: 1000,
    },
    {
      status,
      ...(status === "done" ? { reason: "completed" as const } : {}),
      budget: new Budget({ maxTokens: 1000, usedTokens: 42, usedCost: 0.5, totalCallCount: 3 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
      scriptResult: status === "done" ? { summary: "done-value" } : undefined,
    },
    { startedAt: "2026-08-30T00:00:00.000Z" },
  );
}

/** 最小多余键载体（[H2 W3] live 字段退役后的防御样本——模拟旧版本运行期对象
 *  残留的多余键，重水合链路的丢弃行为回归用）。 */
function makeStaleExtraKey(): Record<string, unknown> {
  return { stale: "legacy-key" };
}

/**
 * pi 壳 jsonl-run-store.ts serializeRun 现网形态样本（顶层 done 前的 running
 * run，字段集/键序按其对象字面量排列）。pi 存量行恒无 live（其 serializeRun
 * strip）、恒带 v="wf-run-v2"（D4 裁决①：版本值沿用）。
 */
const PI_FORM_SNAPSHOT = {
  v: "wf-run-v2",
  runId: "wf-pi-form-1",
  spec: {
    scriptSource: "export function execute() { return 'pi-form'; }",
    args: { topic: "demo" },
    scriptName: "test-script",
    scriptPath: "/fake/test.js",
    budgetTokens: 1000,
  },
  state: {
    status: "running",
    budget: { maxTokens: 1000, usedTokens: 42, usedCost: 0.5, totalCallCount: 3 },
    calls: [
      {
        id: 0,
        opts: { prompt: "do work" },
        status: "done",
        attempts: 1,
        result: { content: "ok" },
        sessionId: "sess-1",
        sessionFile: "/tmp/sess-1.jsonl",
        traceNode: {
          stepIndex: 0,
          agent: "coder",
          task: "do work",
          model: "test-model",
          status: "completed",
          startedAt: "2026-08-30T00:00:01.000Z",
          completedAt: "2026-08-30T00:00:02.000Z",
          sessionId: "sess-1",
          sessionFile: "/tmp/sess-1.jsonl",
        },
      },
    ],
    trace: [
      {
        stepIndex: 0,
        agent: "coder",
        task: "do work",
        model: "test-model",
        status: "completed",
        startedAt: "2026-08-30T00:00:01.000Z",
        completedAt: "2026-08-30T00:00:02.000Z",
        sessionId: "sess-1",
        sessionFile: "/tmp/sess-1.jsonl",
      },
    ],
    errorLogs: [{ level: "warn", message: "retrying" }],
  },
  meta: { startedAt: "2026-08-30T00:00:00.000Z" },
};

describe("run-snapshot — toRunSnapshot/fromRunSnapshot 往返等值", () => {
  it("⛔5 pi 现网形态样本：重水合 → 再序列化与原行逐字节一致（v 字段保持 wf-run-v2）", () => {
    const line = JSON.stringify(PI_FORM_SNAPSHOT);

    const run = fromRunSnapshot(JSON.parse(line));
    expect(run).toBeDefined();
    expect(run!.runId).toBe("wf-pi-form-1");

    // 逐字节一致：pi 切换本 codec 后存量行往返不变（u-sw-store ⛔5 前提）
    expect(JSON.stringify(toRunSnapshot(run!))).toBe(line);
  });

  it("running 快照往返：runId/spec/budget/trace/meta 字段保真", () => {
    const run = makeRun("wf-snap-1");
    const back = fromRunSnapshot(JSON.parse(JSON.stringify(toRunSnapshot(run))));

    expect(back).toBeDefined();
    expect(back!.runId).toBe("wf-snap-1");
    expect(back!.state.status).toBe("running");
    expect(back!.spec.scriptName).toBe("test-script");
    expect(back!.spec.args).toEqual({ topic: "demo", count: 2 });
    expect(back!.state.budget).toBeInstanceOf(Budget);
    expect(back!.state.budget.usedTokens).toBe(42);
    expect(back!.state.budget.totalCallCount).toBe(3);
    expect(back!.state.trace).toBeInstanceOf(Trace);
    expect(back!.runtime).toBeUndefined();
    expect(back!.meta.startedAt).toBe("2026-08-30T00:00:00.000Z");
  });

  it("done 快照往返：reason/scriptResult/errorLogs/completedAt 保真", () => {
    const run = makeRun("wf-snap-2", { status: "done" });
    run.state.errorLogs.push({ level: "warn", message: "transient" });
    run.meta.workerErrorCount = 1;

    const back = fromRunSnapshot(JSON.parse(JSON.stringify(toRunSnapshot(run))));

    expect(back!.state.status).toBe("done");
    expect(back!.state.reason).toBe("completed");
    expect(back!.state.scriptResult).toEqual({ summary: "done-value" });
    expect(back!.state.errorLogs).toEqual([{ level: "warn", message: "transient" }]);
    expect(back!.meta.completedAt).toBe(run.meta.completedAt);
    expect(back!.meta.workerErrorCount).toBe(1);
  });

  it("含 calls 的往返：calls Map 逐项保真 + traceNode 回链 Trace 副本（D-10 尽力恢复）", () => {
    const run = makeRun("wf-snap-3");
    const node = {
      stepIndex: 0,
      agent: "coder",
      task: "do work",
      model: "test-model",
      status: "completed" as const,
    };
    run.state.trace.append(node);
    const call = new AgentCall(0, { prompt: "do work" }, node);
    call.status = "done";
    call.attempts = 1;
    run.state.calls.set(0, call);

    const back = fromRunSnapshot(JSON.parse(JSON.stringify(toRunSnapshot(run))))!;

    expect(back.state.calls.size).toBe(1);
    const restored = back.state.calls.get(0)!;
    expect(restored.opts.prompt).toBe("do work");
    expect(restored.status).toBe("done");
    expect(restored.attempts).toBe(1);
    expect(restored.traceNode).toBe(back.state.trace.toArray()[0]);
  });
});

describe("run-snapshot — [H2 W3] live 字段退役后的序列化行为", () => {
  it("running 节点（类型已无 live 字段）全量直出：序列化无 live 键且往返保真", () => {
    const run = makeRun("wf-nolive-1");
    const node: ExecutionTraceNode = {
      stepIndex: 0,
      agent: "coder",
      task: "do work",
      model: "test-model",
      status: "running",
    };
    run.state.trace.append(node);
    const call = new AgentCall(0, { prompt: "do work" }, node);
    run.state.calls.set(0, call);

    const snap = toRunSnapshot(run);
    const serialized = JSON.stringify(snap);

    // strip 分支随 ExecutionTraceNode.live 字段删除退役——节点不再携带运行期对象，
    // 序列化直出即无 live 键（类型层面收敛的行为回归锁定）
    expect(serialized.includes('"live"')).toBe(false);
    expect(snap.state.trace[0]).not.toHaveProperty("live");
    expect(snap.state.calls[0].traceNode).not.toHaveProperty("live");

    const back = fromRunSnapshot(JSON.parse(serialized))!;
    expect(back.state.trace.toArray()[0]?.status).toBe("running");
    expect(back.state.trace.toArray()[0]?.task).toBe("do work");
  });

  it("运行期多余键残留不进重水合快照的往返链（防御回归）", () => {
    const run = makeRun("wf-stale-1");
    const node: ExecutionTraceNode = {
      stepIndex: 0,
      agent: "coder",
      task: "do work",
      model: "test-model",
      status: "running",
    };
    // 模拟旧版本运行期对象残留的多余键（类型外 attach）
    const withStale = Object.assign(node, makeStaleExtraKey()) as ExecutionTraceNode;
    run.state.trace.append(withStale);

    const snap = toRunSnapshot(run);
    // trace 直出拷贝会带多余键（codec 不再承担键清洗——多余键是调用方脏数据，
    // 正常路径类型层面已无写点）；但 JSON 往返后重水合按 Trace.fromArray 拷贝，
    // 快照行保持可解析、状态保真
    expect(JSON.parse(JSON.stringify(snap)).state.trace[0].status).toBe("running");

    const back = fromRunSnapshot(JSON.parse(JSON.stringify(snap)))!;
    expect(back.state.trace.toArray()[0]?.status).toBe("running");
  });
});

describe("run-snapshot — spec.budgetRef 剔除", () => {
  it("spec.budgetRef（进程内共享引用）不落盘，spec 其余字段保真", () => {
    const run = makeRun("wf-ref-1");
    const specWithRef = { ...run.spec, budgetRef: new Budget({ maxTokens: 500 }) };
    // reconstruct 直造带 budgetRef 的聚合（嵌套 workflow 的 run 形态）
    const nested = WorkflowRun.reconstruct("wf-ref-1", specWithRef, run.state, run.meta);

    const snap = toRunSnapshot(nested);

    expect(nested.spec.budgetRef).toBeDefined(); // 内存对象不受影响
    expect(snap.spec).not.toHaveProperty("budgetRef");
    expect(snap.spec.scriptName).toBe("test-script");

    const back = fromRunSnapshot(JSON.parse(JSON.stringify(snap)))!;
    expect(back.spec).not.toHaveProperty("budgetRef");
    expect(back.spec.budgetTokens).toBe(1000);
  });
});

describe("run-snapshot — 版本 guard（D4 裁决③）", () => {
  it(`v = 当前版本（${SNAPSHOT_VERSION}）通过`, () => {
    const run = fromRunSnapshot(JSON.parse(JSON.stringify(toRunSnapshot(makeRun("wf-v-ok")))));
    expect(run).toBeDefined();
  });

  it("未知更高版本（wf-run-v3）拒绝——字符串版本无大小序，不引入比较逻辑", () => {
    const snap = { ...JSON.parse(JSON.stringify(toRunSnapshot(makeRun("wf-v-3")))), v: "wf-run-v3" };
    expect(fromRunSnapshot(snap)).toBeUndefined();
  });

  it("旧版本 wf-run-v1 拒绝（pi 存量静默跳过语义的数据防线）", () => {
    const snap = { ...JSON.parse(JSON.stringify(toRunSnapshot(makeRun("wf-v-1")))), v: "wf-run-v1" };
    expect(fromRunSnapshot(snap)).toBeUndefined();
  });

  it("缺 v 字段拒绝——「缺 v 宽容」是 store 层预处理职责，不内聚进 codec（D4 裁决②）", () => {
    const { v: _v, ...legacy } = JSON.parse(JSON.stringify(toRunSnapshot(makeRun("wf-v-none"))));
    expect(fromRunSnapshot(legacy)).toBeUndefined();
  });

  it("v 为非字符串脏值（数字/null）拒绝", () => {
    const base = JSON.parse(JSON.stringify(toRunSnapshot(makeRun("wf-v-dirty"))));
    expect(fromRunSnapshot({ ...base, v: 2 })).toBeUndefined();
    expect(fromRunSnapshot({ ...base, v: null })).toBeUndefined();
  });
});

describe("run-snapshot — 形状校验（损坏行不抛，返回 undefined）", () => {
  it("null / 非对象 / 缺 runId / 空 runId 拒绝", () => {
    expect(fromRunSnapshot(null)).toBeUndefined();
    expect(fromRunSnapshot("not an object")).toBeUndefined();
    expect(fromRunSnapshot({ v: SNAPSHOT_VERSION, spec: {}, state: {}, meta: {} })).toBeUndefined();
    expect(fromRunSnapshot({ v: SNAPSHOT_VERSION, runId: "", spec: {}, state: {}, meta: {} })).toBeUndefined();
  });

  it("缺 spec / 缺 state / 非法 status / 缺 budget / 缺 calls / 缺 trace / 缺 meta 拒绝", () => {
    const ok = () => JSON.parse(JSON.stringify(toRunSnapshot(makeRun("wf-shape-base"))));
    const without = (keys: string[]) => {
      const snap = ok();
      for (const k of keys) delete snap[k];
      return snap;
    };

    expect(fromRunSnapshot(without(["spec"]))).toBeUndefined();
    expect(fromRunSnapshot(without(["state"]))).toBeUndefined();
    expect(fromRunSnapshot(without(["meta"]))).toBeUndefined();

    const badStatus = ok();
    badStatus.state.status = "paused"; // v1 三态残留在 v2 快照 = 形状损坏
    expect(fromRunSnapshot(badStatus)).toBeUndefined();

    const noBudget = ok();
    delete noBudget.state.budget;
    expect(fromRunSnapshot(noBudget)).toBeUndefined();

    const noCalls = ok();
    delete noCalls.state.calls;
    expect(fromRunSnapshot(noCalls)).toBeUndefined();

    const noTrace = ok();
    delete noTrace.state.trace;
    expect(fromRunSnapshot(noTrace)).toBeUndefined();
  });

  it("calls 内残缺条目跳过不炸整个 run（traceNode 缺失条目被丢弃）", () => {
    const run = makeRun("wf-shape-call");
    const node = {
      stepIndex: 0,
      agent: "coder",
      task: "do work",
      model: "test-model",
      status: "completed" as const,
    };
    run.state.trace.append(node);
    run.state.calls.set(0, new AgentCall(0, { prompt: "do work" }, node));

    const snap = JSON.parse(JSON.stringify(toRunSnapshot(run)));
    snap.state.calls.push({ notACall: true });

    const back = fromRunSnapshot(snap)!;
    expect(back).toBeDefined();
    expect(back.state.calls.size).toBe(1);
  });
});

// ── [P3/D6] additive 字段策略 + 事件 journal fold 投影 ────────────


/** 构造带两个 call 条目的基线快照（taskIndex 0=running、1=done；对齐验收形态）。 */
function makeSnapshotWithCalls(): ReturnType<typeof toRunSnapshot> {
  const run = makeRun("wf-fold-1");
  const mkNode = (stepIndex: number, status: "running" | "completed") => ({
    stepIndex,
    agent: `agent-${stepIndex}`,
    task: `task ${stepIndex}`,
    model: "test-model",
    status,
  });
  const node0 = mkNode(0, "running");
  const node1 = mkNode(1, "completed");
  run.state.trace.append(node0);
  run.state.trace.append(node1);
  const call0 = new AgentCall(0, { prompt: "task 0" }, node0);
  call0.status = "running";
  call0.attempts = 1;
  const call1 = new AgentCall(1, { prompt: "task 1" }, node1);
  call1.status = "done";
  call1.attempts = 2;
  run.state.calls.set(0, call0);
  run.state.calls.set(1, call1);
  return toRunSnapshot(run);
}

/** 事件构造速记（ts 显式——fold 断言的时间锚）。 */
function ev(partial: Record<string, unknown> & { type: string; ts: number }): WorkflowRunEvent {
  return partial as unknown as WorkflowRunEvent;
}

describe("run-snapshot — [P3/D6] SNAPSHOT_VERSION additive 策略", () => {
  it("SNAPSHOT_VERSION 保持 wf-run-v2（不 bump——bump 会让 extractor 守卫清空历史 run）", () => {
    expect(SNAPSHOT_VERSION).toBe("wf-run-v2");
  });

  it("旧快照（无新字段）读取不炸：重水合正常，新字段在聚合侧无位（缺省渲染前提）", () => {
    // 旧 v2 行 = 无 startedAt/lastProgressAt/health/outcome/errorCode
    const legacy = JSON.parse(JSON.stringify(PI_FORM_SNAPSHOT));
    expect(legacy.state.calls[0]!.startedAt).toBeUndefined();
    expect(legacy.state.health).toBeUndefined();
    expect(legacy.state.outcome).toBeUndefined();

    const run = fromRunSnapshot(legacy);
    expect(run).toBeDefined();
    expect(run!.runId).toBe("wf-pi-form-1");
    expect(run!.state.status).toBe("running");
  });

  it("新写侧快照（含新字段）读取不炸：未知/新增字段被旧读面容忍，不进聚合", () => {
    const base = makeSnapshotWithCalls();
    const enriched = projectRunEvents(base, [
      ev({ type: "ask-dispatched", taskIndex: 0, agentName: "agent-0", attempt: 1, ts: 1000 }),
      ev({ type: "run-settled", outcome: "completed", artifactsDir: "/tmp/wf", ts: 5000 }),
    ]);
    // 序列化 → 重水合（模拟旧读面走 codec）——additive 字段不阻碍重建
    const round = fromRunSnapshot(JSON.parse(JSON.stringify(enriched)));
    expect(round).toBeDefined();
    expect(round!.state.status).toBe("running");
  });
});

describe("run-snapshot — [P3/D6] projectRunEvents fold（单一推导点）", () => {
  it("ask 全链 dispatched→executing→retrying→settled：startedAt 取首边沿、lastProgressAt 逐边沿推进", () => {
    const snap = projectRunEvents(makeSnapshotWithCalls(), [
      ev({ type: "ask-dispatched", taskIndex: 0, agentName: "agent-0", attempt: 1, ts: 1000 }),
      ev({ type: "ask-executing", taskIndex: 0, agentName: "agent-0", attempt: 1, ts: 1200 }),
      ev({ type: "ask-retrying", taskIndex: 0, attempt: 1, backoffMs: 1000, reason: "boom", ts: 2000 }),
      ev({ type: "ask-settled", taskIndex: 0, attempt: 2, outcome: "completed", durationMs: 900, ts: 3000 }),
    ]);
    const call0 = snap.state.calls.find((c) => c.id === 0)!;
    expect(call0.startedAt).toBe(1000);
    expect(call0.lastProgressAt).toBe(3000);
    // 未涉及 ask（id=1）字段保持缺省——fold 不越权
    const call1 = snap.state.calls.find((c) => c.id === 1)!;
    expect(call1.startedAt).toBeUndefined();
    expect(call1.lastProgressAt).toBeUndefined();
    // run 级 health 随 ask 边沿推进
    expect(snap.state.health?.lastProgressAt).toBe(3000);
  });

  it("executing 兜底：journal 缺 dispatched 帧时 startedAt 从 executing 首帧取", () => {
    const snap = projectRunEvents(makeSnapshotWithCalls(), [
      ev({ type: "ask-executing", taskIndex: 0, agentName: "agent-0", attempt: 1, ts: 700 }),
    ]);
    const call0 = snap.state.calls.find((c) => c.id === 0)!;
    expect(call0.startedAt).toBe(700);
  });

  it("run-settled：health 推进 + 终局 outcome/errorCode 落快照（failed 形态）", () => {
    const snap = projectRunEvents(makeSnapshotWithCalls(), [
      ev({ type: "run-settled", outcome: "failed", errorCode: "engine_crashed", reason: "boom", artifactsDir: "/tmp/wf", ts: 9000 }),
    ]);
    expect(snap.state.outcome).toBe("failed");
    expect(snap.state.errorCode).toBe("engine_crashed");
    expect(snap.state.health?.lastProgressAt).toBe(9000);
    // 三态直读不受 fold 影响（不做词表转换）
    expect(snap.state.status).toBe("running");
    expect(snap.state.calls.find((c) => c.id === 0)!.status).toBe("running");
  });

  it("cancel 合成 run-settled（completed/cancelled 缺省 errorCode）不落 errorCode 键", () => {
    const snap = projectRunEvents(makeSnapshotWithCalls(), [
      ev({ type: "run-settled", outcome: "cancelled", artifactsDir: "/tmp/wf", ts: 4000 }),
    ]);
    expect(snap.state.outcome).toBe("cancelled");
    expect(snap.state.errorCode).toBeUndefined();
  });

  it("taskIndex 无关联条目：per-call 跳过、health 照常推进（代际错位不炸）", () => {
    const snap = projectRunEvents(makeSnapshotWithCalls(), [
      ev({ type: "ask-dispatched", taskIndex: 42, agentName: "ghost", attempt: 1, ts: 1500 }),
    ]);
    expect(snap.state.health?.lastProgressAt).toBe(1500);
    expect(snap.state.calls.find((c) => c.id === 0)!.startedAt).toBeUndefined();
  });

  it("run-created / armed：仅推进 run 级 health（无 per-call 语义）", () => {
    const snap = projectRunEvents(makeSnapshotWithCalls(), [
      ev({ type: "run-created", runId: "wf-fold-1", workflowName: "t", argsSummary: "{}", ts: 100 }),
      ev({ type: "armed", frame: {}, ts: 200 }),
    ]);
    expect(snap.state.health?.lastProgressAt).toBe(200);
    expect(snap.state.calls.every((c) => c.startedAt === undefined)).toBe(true);
  });

  it("ts 回拨防御：lastProgressAt 取 max（乱序帧不回拨进度时钟）", () => {
    const snap = projectRunEvents(makeSnapshotWithCalls(), [
      ev({ type: "ask-dispatched", taskIndex: 0, agentName: "agent-0", attempt: 1, ts: 3000 }),
      ev({ type: "ask-executing", taskIndex: 0, agentName: "agent-0", attempt: 1, ts: 1000 }),
    ]);
    const call0 = snap.state.calls.find((c) => c.id === 0)!;
    expect(call0.lastProgressAt).toBe(3000);
    expect(snap.state.health?.lastProgressAt).toBe(3000);
  });

  it("空事件流：输出与输入等值（health/outcome 不凭空造）", () => {
    const base = makeSnapshotWithCalls();
    const snap = projectRunEvents(base, []);
    expect(snap.state.health).toBeUndefined();
    expect(snap.state.outcome).toBeUndefined();
    expect(snap.state.calls).toEqual(base.state.calls);
  });

  it("纯函数：输入快照不被修改（flush 侧可安全复用基线）", () => {
    const base = makeSnapshotWithCalls();
    const frozen = JSON.parse(JSON.stringify(base));
    projectRunEvents(base, [
      ev({ type: "ask-dispatched", taskIndex: 0, agentName: "agent-0", attempt: 1, ts: 1000 }),
    ]);
    expect(JSON.parse(JSON.stringify(base))).toEqual(frozen);
  });
});
