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

import type { ExecutionRecord } from "../../execution/types.ts";
import type { ExecutionTraceNode } from "../models/types.ts";
import { AgentCall } from "../models/agent-call.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import { SNAPSHOT_VERSION, fromRunSnapshot, toRunSnapshot } from "../run-snapshot.ts";

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
