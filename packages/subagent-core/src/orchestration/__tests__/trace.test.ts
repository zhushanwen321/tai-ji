// trace.test.ts —— Trace 首个直接单测（W1TC1-W1TC12，.cw/swf-perf-impl/rt-w1-design.json）。
// 被测对象（Trace / executeAgentCall）全在 core——自 pi 壳迁移落位；W1TC11（jsonl
// save-load round-trip）的 JsonlRunStore 归属 pi 壳，留壳侧 session-file 件。
// - W1TC1-3/9：节点数组一致性与 no-op 防御语义
// - W1TC4-8：result.content 裁剪（append/update 入口、8000 边界、patch 缺省、fromArray 原样保留）
// - W1TC10：集成——executeAgentCall 真链路（call.result 全量、trace 节点持裁剪副本）
// - W1TC12：重复 stepIndex 违规语义锚定（数组序保留 + remove 后 desync 孤儿）

import { describe, expect, it, vi } from "vitest";

import { executeAgentCall } from "../execute-agent-call.ts";
import { AgentCall } from "../models/agent-call.ts";
import { Budget } from "../models/budget.ts";
import { AgentRunner } from "../models/ports.ts";
import { TRACE_RESULT_MAX_CHARS, Trace } from "../models/trace.ts";
import type { AgentResult, ExecutionTraceNode } from "../models/types.ts";

// ── 测试辅助 ─────────────────────────────────────────────────

/** 构造最小 ExecutionTraceNode（status 默认 pending，无 result）。 */
function makeTraceNode(stepIndex: number): ExecutionTraceNode {
  return {
    stepIndex,
    agent: "test-agent",
    task: "test task",
    model: "default",
    status: "pending",
  };
}

/** 按 stepIndex 查 trace 节点（Trace 公共查询面 = toArray 线性扫）。 */
function findByStep(trace: Trace, stepIndex: number): ExecutionTraceNode | undefined {
  return trace.toArray().find((n) => n.stepIndex === stepIndex);
}

/** 构造指定长度 content 的 AgentResult（sessionId 等可选字段透传）。 */
function makeResult(content: string, extras: Partial<AgentResult> = {}): AgentResult {
  return { content, ...extras };
}

// ── byIndex 索引一致性 ────────────────────────────────────────

describe("Trace byIndex 索引一致性", () => {
  it("W1TC1: append/update/remove 后 find 命中且引用共享", () => {
    const trace = new Trace();
    const node0 = makeTraceNode(0);
    const node1 = makeTraceNode(1);
    const node2 = makeTraceNode(2);
    trace.append(node0);
    trace.append(node1);
    trace.append(node2);

    trace.update(1, { status: "completed" });

    // byIndex 与 nodes 引用共享非拷贝
    expect(findByStep(trace, 0)).toBe(node0);
    expect(findByStep(trace, 1)).toBe(node1);
    expect(findByStep(trace, 2)).toBe(node2);
    // Map 值是节点引用，update 字段 mutate 可见
    expect(findByStep(trace, 1)!.status).toBe("completed");

    trace.removeByStepIndex(1);
    expect(findByStep(trace, 1)).toBeUndefined();
    expect(trace.length).toBe(2);
    // 其余节点不受影响
    expect(findByStep(trace, 0)).toBe(node0);
    expect(findByStep(trace, 2)).toBe(node2);
  });
});

// ── remove 后 re-append 同 stepIndex 覆盖 ─────────────────────

describe("Trace remove 后 re-append 同 stepIndex", () => {
  it("W1TC2: rebuild discard 清理后重跑重发同 callId——旧节点不再可达", () => {
    const trace = new Trace();
    const nodeA = makeTraceNode(0);
    trace.append(nodeA);
    trace.removeByStepIndex(0);

    const nodeB = makeTraceNode(0);
    trace.append(nodeB);

    expect(findByStep(trace, 0)).toBe(nodeB);
    expect(trace.toArray()).toHaveLength(1);
    expect(trace.toArray()[0]).toBe(nodeB);
  });
});

// ── 重复 stepIndex 违规语义锚定（W1TC12）──────────────────────

describe("Trace 重复 stepIndex 违规语义锚定（W1TC12）", () => {
  it("W1TC12: 重复 append 数组序保留；重复 append 后 remove 呈 desync 孤儿", () => {
    // ① 重复 append 同 stepIndex 且未 remove：nodes 数组按 append 序保留两节点
    //    （byIndex 键 last-wins 属内部索引实现，公共查询面只见数组序）
    const t1 = new Trace();
    const first = makeTraceNode(0);
    const second = makeTraceNode(0);
    t1.append(first);
    t1.append(second);
    expect(t1.length).toBe(2);
    expect(t1.toArray()[0]).toBe(first);
    expect(t1.toArray()[1]).toBe(second);

    // ② 重复 append 后 removeByStepIndex：findIndex 命中首个旧节点 splice、
    //    byIndex.delete 删掉整个键——第二个节点残留为孤儿（nodes.length=1）。
    //    desync 行为锚定：防未来改动时静默漂移
    const t2 = new Trace();
    const a = makeTraceNode(0);
    const b = makeTraceNode(0);
    t2.append(a);
    t2.append(b);
    t2.removeByStepIndex(0);
    expect(t2.length).toBe(1);
    expect(t2.toArray()[0]).toBe(b);
  });
});

// ── fromArray 重建 ───────────────────────────────────────────

describe("Trace.fromArray 重建", () => {
  it("W1TC3: 索引全命中 + 防御性拷贝语义保持", () => {
    const node0 = makeTraceNode(0);
    const node1 = makeTraceNode(1);
    const node2 = makeTraceNode(2);
    const src = [node0, node1, node2];

    const trace = Trace.fromArray(src);

    expect(trace.length).toBe(3);
    // fromArray push {...node} 副本——toArray()[i] 与源数组元素脱钩
    for (let i = 0; i < 3; i++) {
      expect(trace.toArray()[i]).not.toBe(src[i]);
    }

    // 传入数组后续 mutate 不影响 trace（浅拷贝语义保持）
    src.push(makeTraceNode(3));
    expect(trace.length).toBe(3);
    src[0]!.status = "failed";
    expect(findByStep(trace, 0)!.status).toBe("pending");
  });
});

// ── append 入口裁剪 ──────────────────────────────────────────

describe("Trace append 入口超长 result 裁剪", () => {
  it("W1TC4: 标记含原始长度，节点引用不变，其余字段浅拷贝保留", () => {
    const content = "x".repeat(10000);
    const node = {
      ...makeTraceNode(0),
      result: makeResult(content, { sessionId: "s1", parsedOutput: { a: 1 } }),
    };

    const trace = new Trace();
    trace.append(node);

    const stored = trace.toArray()[0]!;
    // 节点对象引用不变（mutate result 字段，不 push 副本——D-10 traceNode 引用共享）
    expect(stored).toBe(node);

    const marker = `\n…[trace result truncated, original 10000 chars]…\n`;
    expect(stored.result!.content).toBe(content.slice(0, 4000) + marker + content.slice(-4000));
    // 头尾与标记子串
    expect(stored.result!.content.startsWith(content.slice(0, 4000))).toBe(true);
    expect(stored.result!.content.endsWith(content.slice(-4000))).toBe(true);
    expect(stored.result!.content).toContain("[trace result truncated, original 10000 chars]");
    // result 其余字段浅拷贝保留
    expect(stored.result!.sessionId).toBe("s1");
    expect(stored.result!.parsedOutput).toEqual({ a: 1 });
  });
});

// ── update 入口裁剪 ──────────────────────────────────────────

describe("Trace update patch.result 超长裁剪", () => {
  it("W1TC5: 节点持裁剪副本，patch 原对象不被污染（call.result 保真）", () => {
    const trace = new Trace();
    trace.append(makeTraceNode(0));

    const full = makeResult("y".repeat(9000), { sessionId: "s1" });
    trace.update(0, { result: full });

    const stored = findByStep(trace, 0)!.result!;
    const marker = `\n…[trace result truncated, original 9000 chars]…\n`;
    expect(stored.content.length).toBe(4000 + marker.length + 4000);
    expect(stored.content).toContain("original 9000 chars");
    // 节点持裁剪副本新对象，与 patch.result 脱钩
    expect(stored).not.toBe(full);
    // 浅拷贝保留其他字段
    expect(stored.sessionId).toBe("s1");
    // AgentCall.result 保真——原对象不被污染（replay 数据源）
    expect(full.content).toHaveLength(9000);
  });
});

// ── 边界：恰好 8000 不裁 / 8001 裁 ────────────────────────────

describe("Trace 裁剪边界（严格大于 TRACE_RESULT_MAX_CHARS）", () => {
  it("W1TC6: 恰好 8000 引用透传零拷贝；8001 触发裁剪", () => {
    const trace = new Trace();
    trace.append(makeTraceNode(0));
    trace.append(makeTraceNode(1));

    // 恰好 8000：不裁
    const exact = makeResult("a".repeat(TRACE_RESULT_MAX_CHARS));
    trace.update(0, { result: exact });
    expect(findByStep(trace, 0)!.result).toBe(exact);
    expect(findByStep(trace, 0)!.result!.content).toHaveLength(8000);
    expect(findByStep(trace, 0)!.result!.content).not.toContain("truncated");

    // 8001：裁剪（head/tail 固定 4000 比例，重叠段属预期）
    const over = makeResult("b".repeat(TRACE_RESULT_MAX_CHARS + 1));
    trace.update(1, { result: over });
    expect(findByStep(trace, 1)!.result!.content).toContain("original 8001 chars");
    expect(findByStep(trace, 1)!.result!.content).not.toBe(over.content);
  });
});

// ── patch.result 未提供不触发裁剪 ────────────────────────────

describe("Trace update patch.result 缺省", () => {
  it("W1TC7: 只改 status/completedAt 等字段——已持 result 不被触碰", () => {
    const origResult = makeResult("keep");
    const node = { ...makeTraceNode(0), result: origResult };
    const trace = new Trace();
    trace.append(node);

    trace.update(0, { status: "completed", completedAt: "2026-08-15T00:00:00Z" });
    expect(findByStep(trace, 0)!.result!.content).toBe("keep");
    expect(findByStep(trace, 0)!.result).toBe(origResult);

    // 其他字段路径同样不影响 result
    trace.update(0, { sessionId: "s9" });
    expect(findByStep(trace, 0)!.result).toBe(origResult);
  });
});

// ── fromArray 原样保留（read 路径不二次裁剪）──────────────────

describe("Trace.fromArray 原样保留", () => {
  it("W1TC8: 超长 content 不被二次裁剪；已含标记的形态逐字节不变", () => {
    // 旧版本未裁剪的快照重水合：20000 字符全长保留
    const long = {
      ...makeTraceNode(0),
      result: makeResult("z".repeat(20000)),
    };
    const trace = Trace.fromArray([long]);
    expect(findByStep(trace, 0)!.result!.content).toHaveLength(20000);
    expect(findByStep(trace, 0)!.result!.content).not.toContain("truncated");

    // 新快照 round-trip：已裁剪含标记的 content 经 fromArray 后逐字节不变（无标记嵌套）
    const marker = `\n…[trace result truncated, original 10000 chars]…\n`;
    const trimmed = "x".repeat(4000) + marker + "x".repeat(4000);
    const trace2 = Trace.fromArray([{ ...makeTraceNode(0), result: makeResult(trimmed) }]);
    expect(findByStep(trace2, 0)!.result!.content).toBe(trimmed);
  });
});

// ── no-op 防御语义回归 ───────────────────────────────────────

describe("Trace no-op 防御语义", () => {
  it("W1TC9: update/remove 不存在的 stepIndex 不抛错、状态不变", () => {
    const trace = new Trace();
    trace.append(makeTraceNode(0));

    expect(() => trace.update(999, { status: "completed" })).not.toThrow();
    expect(() => trace.removeByStepIndex(999)).not.toThrow();
    expect(trace.length).toBe(1);
    expect(findByStep(trace, 999)).toBeUndefined();
  });
});

// ── 集成：executeAgentCall 真链路（W1TC10）────────────────────

describe("W1TC10: executeAgentCall 真链路——call.result 全量、trace 节点持裁剪副本", () => {
  it("W1TC10: runner.run 返回 12000 字符 → 两形态并存（AgentCall.result 不裁）", async () => {
    const content = "w".repeat(12000);
    const runner: AgentRunner = {
      run: vi.fn().mockResolvedValue(makeResult(content, { sessionId: "s1" })),
    };

    const trace = new Trace();
    const traceNode = makeTraceNode(0);
    trace.append(traceNode);
    const call = new AgentCall(0, { prompt: "test task", agent: "worker" }, traceNode);

    await executeAgentCall(call, runner, new Budget(), new AbortController().signal, trace);

    // AgentCall.result 全量（worker cached replay 数据源保真）
    expect(call.result!.content).toHaveLength(12000);
    // trace 节点持裁剪副本
    const stored = findByStep(trace, 0)!.result!;
    const marker = `\n…[trace result truncated, original 12000 chars]…\n`;
    expect(stored.content).toBe(content.slice(0, 4000) + marker + content.slice(-4000));
    expect(stored.content.length).toBe(4000 + marker.length + 4000);
    expect(stored.sessionId).toBe("s1");
    expect(findByStep(trace, 0)!.status).toBe("completed");
  });
});
