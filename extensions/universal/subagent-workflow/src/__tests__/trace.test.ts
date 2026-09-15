// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/trace.test.ts
//
// Trace 首个直接单测（W1TC1-W1TC12，.cw/swf-perf-impl/rt-w1-design.json）：
// - W1TC1-3/9：byIndex 倒排索引一致性与 no-op 防御语义
// - W1TC4-8：result.content 裁剪（append/update 入口、8000 边界、patch 缺省、fromArray 原样保留）
// - W1TC10-11：集成——executeAgentCall 真链路 / jsonl save-load round-trip
// - W1TC12：重复 stepIndex 违规语义锚定（last-wins + remove 后 desync 孤儿）

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TRACE_RESULT_MAX_CHARS, Trace } from "@zhushanwen/subagent-core/orchestration/models/trace.ts";
import { AgentCall } from "@zhushanwen/subagent-core";
import { Budget } from "@zhushanwen/subagent-core";
import { WorkflowRun } from "@zhushanwen/subagent-core";
import type { ExecutionTraceNode, AgentResult, RunSpec } from "@zhushanwen/subagent-core";
import type { AgentRunner } from "@zhushanwen/subagent-core/orchestration/models/ports.ts";
import { executeAgentCall } from "@zhushanwen/subagent-core/orchestration/execute-agent-call.ts";
import { JsonlRunStore } from "../jsonl-run-store.ts";

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
    expect(trace.find(0)).toBe(node0);
    expect(trace.find(1)).toBe(node1);
    expect(trace.find(2)).toBe(node2);
    // Map 值是节点引用，update 字段 mutate 可见
    expect(trace.find(1)!.status).toBe("completed");

    trace.removeByStepIndex(1);
    expect(trace.find(1)).toBeUndefined();
    expect(trace.length).toBe(2);
    // 其余节点不受影响
    expect(trace.find(0)).toBe(node0);
    expect(trace.find(2)).toBe(node2);
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

    expect(trace.find(0)).toBe(nodeB);
    expect(trace.toArray()).toHaveLength(1);
    expect(trace.toArray()[0]).toBe(nodeB);
  });
});

// ── 重复 stepIndex 违规语义锚定（W1TC12）──────────────────────

describe("Trace 重复 stepIndex 违规语义锚定（W1TC12）", () => {
  it("W1TC12: 重复 append find last-wins；重复 append 后 remove 呈 desync 孤儿", () => {
    // ① 重复 append 同 stepIndex 且未 remove：find 返回第二个节点（Map
    //    last-wins；旧线性扫 first-match 会返回第一个）
    const t1 = new Trace();
    const first = makeTraceNode(0);
    const second = makeTraceNode(0);
    t1.append(first);
    t1.append(second);
    expect(t1.find(0)).toBe(second);
    expect(t1.length).toBe(2);

    // ② 重复 append 后 removeByStepIndex：findIndex 命中首个旧节点 splice、
    //    byIndex.delete 删掉整个键——第二个节点残留为孤儿（find 不可达但
    //    nodes.length=1）。desync 行为锚定：防未来改回线性扫时静默漂移
    //    （线性扫实现下 find(0) 会命中残留节点 second，本断言即失败）
    const t2 = new Trace();
    const a = makeTraceNode(0);
    const b = makeTraceNode(0);
    t2.append(a);
    t2.append(b);
    t2.removeByStepIndex(0);
    expect(t2.find(0)).toBeUndefined();
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
    // fromArray push {...node} 副本——find(i) 与 toArray()[i] 同引用（byIndex 命中副本）
    for (let i = 0; i < 3; i++) {
      expect(trace.find(i)).toBe(trace.toArray()[i]);
    }

    // 传入数组后续 mutate 不影响 trace（浅拷贝语义保持）
    src.push(makeTraceNode(3));
    expect(trace.length).toBe(3);
    src[0]!.status = "failed";
    expect(trace.find(0)!.status).toBe("pending");
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

    const stored = trace.find(0)!.result!;
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
    expect(trace.find(0)!.result).toBe(exact);
    expect(trace.find(0)!.result!.content).toHaveLength(8000);
    expect(trace.find(0)!.result!.content).not.toContain("truncated");

    // 8001：裁剪（head/tail 固定 4000 比例，重叠段属预期）
    const over = makeResult("b".repeat(TRACE_RESULT_MAX_CHARS + 1));
    trace.update(1, { result: over });
    expect(trace.find(1)!.result!.content).toContain("original 8001 chars");
    expect(trace.find(1)!.result!.content).not.toBe(over.content);
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
    expect(trace.find(0)!.result!.content).toBe("keep");
    expect(trace.find(0)!.result).toBe(origResult);

    // 其他字段路径同样不影响 result
    trace.update(0, { sessionId: "s9" });
    expect(trace.find(0)!.result).toBe(origResult);
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
    expect(trace.find(0)!.result!.content).toHaveLength(20000);
    expect(trace.find(0)!.result!.content).not.toContain("truncated");

    // 新快照 round-trip：已裁剪含标记的 content 经 fromArray 后逐字节不变（无标记嵌套）
    const marker = `\n…[trace result truncated, original 10000 chars]…\n`;
    const trimmed = "x".repeat(4000) + marker + "x".repeat(4000);
    const trace2 = Trace.fromArray([{ ...makeTraceNode(0), result: makeResult(trimmed) }]);
    expect(trace2.find(0)!.result!.content).toBe(trimmed);
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
    expect(trace.find(999)).toBeUndefined();
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
    const stored = trace.find(0)!.result!;
    const marker = `\n…[trace result truncated, original 12000 chars]…\n`;
    expect(stored.content).toBe(content.slice(0, 4000) + marker + content.slice(-4000));
    expect(stored.content.length).toBe(4000 + marker.length + 4000);
    expect(stored.sessionId).toBe("s1");
    expect(trace.find(0)!.status).toBe("completed");
  });
});

// ── 集成：jsonl save/load round-trip（W1TC11）─────────────────

describe("W1TC11: jsonl save/load round-trip——落盘裁剪形态 + 重水合不二次裁", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-trace-trim-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeSpec(): RunSpec {
    return {
      scriptSource: "module.exports = async () => {};",
      args: {},
      scriptName: "test-script",
      scriptPath: "/tmp/test.js",
      description: "test",
    };
  }

  /** 构造含 10000 字符 result 已完成 call 的 WorkflowRun（模式对齐 jsonl-run-store-session-file.test.ts）。 */
  function makeRunWithDoneCall(): WorkflowRun {
    const trace = new Trace();
    const node = makeTraceNode(0);
    trace.append(node);
    const call = new AgentCall(0, { prompt: "task", agent: "worker" }, node);
    call.markRunning();
    // markDone 存全量 result（AgentCall.result 不裁）
    call.markDone(makeResult("q".repeat(10000), { sessionId: "session-abc" }));
    call.setSessionId("session-abc");
    // trace.update 经入口裁剪——节点持裁剪副本
    trace.update(0, {
      status: "completed",
      result: call.result,
      completedAt: new Date().toISOString(),
      sessionId: "session-abc",
    });

    return new WorkflowRun(
      "run-trim-001",
      makeSpec(),
      {
        status: "done",
        reason: "completed",
        budget: new Budget(),
        calls: new Map([[0, call]]),
        trace,
        errorLogs: [],
      },
      { startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
    );
  }

  it("W1TC11: save 落盘 trace 裁剪 + calls[].result 全量；loadAll 回读逐字节一致", async () => {
    const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
    const mockPi = {
      appendEntry: vi.fn((type: string, data: unknown) => {
        entries.push({ type: "custom", customType: type, data });
      }),
    };
    const mockCtx = {
      sessionManager: { getEntries: () => entries },
    };
    const store = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mockPi as never,
      ctx: mockCtx as never,
    });

    const run = makeRunWithDoneCall();
    await store.save(run);

    // 读磁盘快照验证落盘形态
    const raw = fs.readFileSync(
      path.join(tmpDir, "workflow-state", "run-trim-001.jsonl"),
      "utf8",
    );
    const snapshot = JSON.parse(raw.trim()) as {
      state: {
        trace: Array<{ result?: { content: string } }>;
        calls: Array<{ result?: { content: string }; traceNode: { result?: { content: string } } }>;
      };
    };

    // trace 投影瘦身生效：trace[0] 含标记
    expect(snapshot.state.trace[0]!.result!.content).toContain(
      "[trace result truncated, original 10000 chars]",
    );
    // calls[].traceNode 是同一裁剪后节点引用（剥 live 后的 rest），亦含标记
    expect(snapshot.state.calls[0]!.traceNode.result!.content).toContain(
      "[trace result truncated, original 10000 chars]",
    );
    // 顶层 calls[].result 字段不裁——全量 10000
    expect(snapshot.state.calls[0]!.result!.content).toHaveLength(10000);

    // loadAll 回读：fromArray 不再裁，与落盘形态逐字节一致（无标记嵌套）
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    const restoredContent = loaded[0]!.state.trace.toArray()[0]!.result!.content;
    expect(restoredContent).toBe(snapshot.state.trace[0]!.result!.content);
    expect(restoredContent.match(/truncated/g)).toHaveLength(1);
  });
});
