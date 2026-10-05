// src/orchestration/__tests__/execute-agent-call.test.ts
//
// U2: executeAgentCall 透传 stream 给 runner.run
// [ADR-0122] 失败显式上报：单次执行、失败直接终态化（原 3 次指数退避重试矩阵已删）。

import { describe, expect, it, vi } from "vitest";

import {
  classifyFailureKind,
  describeMissingParsedOutput,
  DETERMINISTIC_SCHEMA_FAILURE_PREFIX,
  isDeterministicSchemaFailureMsg,
  isStaleContextErrorMsg,
  STALE_CONTEXT_PATTERNS,
} from "@zhushanwen/pi-subagent-cli";
import { executeAgentCall } from "../execute-agent-call.ts";
import { AgentCall } from "../models/agent-call.ts";
import { Budget } from "../models/budget.ts";
import type { AgentRunner } from "../models/ports.ts";
import type { ToolCall } from "../../execution/assembly/types.ts";
import { Trace } from "../models/trace.ts";
import type { ExecutionTraceNode } from "../models/types.ts";
import type { AgentCallOpts, AgentResult } from "../models/types.ts";

// ── 测试辅助 ──

function makeMockResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    content: "OK",
    durationMs: 100,
    error: undefined,
    toolCalls: [],
    ...overrides,
  };
}

function makeBaseOpts(): AgentCallOpts {
  return {
    prompt: "test task",
    agent: "worker",
    cwd: "/some/path",
  } as AgentCallOpts;
}

/** 构造一个 traceNode（ExecutionTraceNode 最小子集） */
function makeTraceNode(stepIndex = 0): ExecutionTraceNode {
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

/** 构造 AgentCall + 关联的 Trace（call.id 与 trace 节点 stepIndex 对齐） */
function makeAgentCallAndTrace(): { call: AgentCall; trace: Trace } {
  const trace = new Trace();
  const traceNode = makeTraceNode(0);
  trace.append(traceNode);
  const call = new AgentCall(0, makeBaseOpts(), traceNode);
  return { call, trace };
}

/** 创建 mock AgentRunner（只实现 run） */
function createMockRunner(impl?: ReturnType<typeof vi.fn>): AgentRunner & { run: ReturnType<typeof vi.fn> } {
  const run = impl ?? vi.fn().mockResolvedValue(makeMockResult());
  return { run } as unknown as AgentRunner & { run: ReturnType<typeof vi.fn> };
}

/**
 * [D5-③] 构造带真实分诊的失败 result——failureKind 经产出侧 classifyFailureKind
 * 分类（复刻 collectResult → mapper 透传后的消费侧视角），避免手写字面量与
 * 产出侧词表脱钩。
 */
function makeFailedResult(error: string): AgentResult {
  return makeMockResult({ error, failureKind: classifyFailureKind(error) });
}

// ── U2: executeAgentCall 透传 stream 给 runner.run ──

describe("U2: executeAgentCall 透传 stream", () => {
  it("executeAgentCall 传 stream → runner.run 第 4 参收到同一 stream", async () => {
    let capturedStream: unknown;
    const runner = createMockRunner(
      vi.fn().mockImplementation((_opts, _sig, _onEvt, stream) => {
        capturedStream = stream;
        return Promise.resolve(makeMockResult());
      }),
    );

    const fakeStream = { onDelta: vi.fn(), dispose: vi.fn() };
    const { call, trace } = makeAgentCallAndTrace();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace, undefined, fakeStream as never);

    expect(capturedStream).toBe(fakeStream);
  });

  it("executeAgentCall 不传 stream → runner.run 第 4 参为 undefined", async () => {
    let capturedStream: unknown = "sentinel";
    const runner = createMockRunner(
      vi.fn().mockImplementation((_opts, _sig, _onEvt, stream) => {
        capturedStream = stream;
        return Promise.resolve(makeMockResult());
      }),
    );

    const { call, trace } = makeAgentCallAndTrace();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(capturedStream).toBeUndefined();
  });
});

// ── U1: finalizeCall 透传 sessionFile 到 trace 节点（方案 A）──

describe("U1: finalizeCall sessionFile → trace 节点", () => {
  it("runner.run 返回带 sessionFile 的 result → trace 节点携带 sessionFile", async () => {
    const sessionFilePath = "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl";
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(
        makeMockResult({ sessionId: "session-abc", sessionFile: sessionFilePath }),
      ),
    );
    const { call, trace } = makeAgentCallAndTrace();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    const node = findByStep(trace, 0);
    expect(node).toBeDefined();
    expect(node!.sessionFile).toBe(sessionFilePath);
    expect(node!.sessionId).toBe("session-abc");
  });

  it("runner.run 返回无 sessionFile 的 result → trace 节点 sessionFile undefined", async () => {
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({ sessionId: "session-foo" })),
    );
    const { call, trace } = makeAgentCallAndTrace();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    const node = findByStep(trace, 0);
    expect(node).toBeDefined();
    expect(node!.sessionFile).toBeUndefined();
  });
});

// ── [ADR-0122] 失败单次终态：无自动重试 ──

describe("ADR-0122: 失败单次终态（无自动重试）", () => {
  it("首次 runner.run 返回 error → 不重试（恰 1 次调用）+ 终态 failed", async () => {
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({ error: "transient error", failureKind: "unknown" })),
    );
    const { call, trace } = makeAgentCallAndTrace();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(call.attempts).toBe(1);
    expect(call.status).toBe("done");
    expect(call.result?.error).toBe("transient error");
    expect(findByStep(trace, 0)?.status).toBe("failed");
  });

  it("成功路径 → 单次调用 + 终态 completed", async () => {
    const runner = createMockRunner();
    const { call, trace } = makeAgentCallAndTrace();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(findByStep(trace, 0)?.status).toBe("completed");
  });
});

// ── isOrphaned 守卫（OB2：S7 残留瞬时污染根除） ──
//
// 谓词为 true 时 finalizeCall 跳过 trace.update，但 markDone 与
// sessionId/sessionFile 同步保留。U4 锁定不传谓词时的现状回归。

describe("isOrphaned 守卫", () => {
  it("U1: 谓词 () => true + 终态成功路径 → trace.update 0 次，markDone 保留（status done + result 已设置）", async () => {
    const { call, trace } = makeAgentCallAndTrace();
    const updateSpy = vi.spyOn(trace, "update");
    const runner = createMockRunner(); // 默认成功 result
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace, undefined, undefined, () => true);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(call.status).toBe("done");
    expect(call.result).toBeDefined();
    expect(call.result?.content).toBe("OK");
  });

  it("U2: 谓词 true + stale-context 失败路径 → trace.update 0 次，markDone 保留（覆盖失败 finalize 调用点）", async () => {
    const { call, trace } = makeAgentCallAndTrace();
    const updateSpy = vi.spyOn(trace, "update");
    // "context canceled" 经产出侧词表分类为 stale_context（D5-③ 后消费侧读字段）
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeFailedResult("context canceled")),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace, undefined, undefined, () => true);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(call.status).toBe("done");
    expect(call.result?.error).toBe("context canceled");
  });

  it("U3: 谓词 true + 信号 abort 路径 → trace.update 0 次，markDone 保留", async () => {
    const { call, trace } = makeAgentCallAndTrace();
    const updateSpy = vi.spyOn(trace, "update");
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({ error: "old generation failure" })),
    );
    const controller = new AbortController();
    controller.abort();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, controller.signal, trace, undefined, undefined, () => true);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(call.status).toBe("done");
    expect(call.result?.error).toBe("old generation failure");
  });

  it("U4: 谓词 undefined（不传）→ trace.update 恰被调用 1 次（现状回归锁定）", async () => {
    const { call, trace } = makeAgentCallAndTrace();
    const updateSpy = vi.spyOn(trace, "update");
    const runner = createMockRunner();
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(findByStep(trace, 0)?.status).toBe("completed");
    expect(call.status).toBe("done");
  });
});

// ── W4b: STALE_CONTEXT_PATTERNS 对齐 pi 真实文案（stale 分诊） ──
//
// pi 0.84.x 真实 stale 文案（extensions/runner.ts:531，dist runner.js:567）：
// "This extension ctx is stale after session replacement or reload. Do not use
//  a captured pi or command ctx after ctx.newSession(), ..."
// 旧 patterns（"stale context"/"stalecontext"）与该文案零匹配（词序相反）——
// W4b 词序修正 + 对齐 scheduler 已验证 marker 'stale after session replacement'
// （runtime.ts STALE_CTX_MARKER）。[ADR-0122] 后分诊结果只影响 failureKind 分类
// 展示，不再有重试语义差异。

/** pi 真实 stale 文案前半（含 marker 全文前缀，锚定真实串而非自造缩写）。 */
const PI_REAL_STALE_MESSAGE =
  "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

describe("W4b: stale 分诊对齐 pi 真实文案", () => {
  it("真实文案全文 → isStaleContextErrorMsg true（'ctx is stale' 词序 + scheduler marker 双命中）", () => {
    expect(isStaleContextErrorMsg(PI_REAL_STALE_MESSAGE)).toBe(true);
  });

  it("patterns 含 scheduler 已验证 marker 'stale after session replacement'", () => {
    expect(STALE_CONTEXT_PATTERNS).toContain("stale after session replacement");
    expect(STALE_CONTEXT_PATTERNS).toContain("ctx is stale");
  });

  it("真实文案 → 单次终态 failed（runner.run 恰 1 次）", async () => {
    // [D5-③] 全链路锁：产出侧 classifyFailureKind（真实文案 → stale_context）→
    // 消费侧读 failureKind 字段分类
    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeFailedResult(PI_REAL_STALE_MESSAGE)),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(call.status).toBe("done");
    expect(call.result?.error).toBe(PI_REAL_STALE_MESSAGE);
    expect(findByStep(trace, 0)?.status).toBe("failed");
  });

  it("普通 transient 错误 → 不命中 stale", () => {
    expect(isStaleContextErrorMsg("transient network error")).toBe(false);
    expect(isStaleContextErrorMsg(undefined)).toBe(false);
  });
});

// ── MF-1: 确定性 schema 失败单次终态 ──
//
// [HISTORICAL] 回归背景（第五轮实测）：gate 终止子进程后归因 error 曾循环重试至
// MAX_ATTEMPTS=3（实测 attempts=3、4 子进程、235s）。ADR-0122 后一切失败单次终态，
// 分诊结果（failureKind）仅随 result 透传供分类展示。
//
// 三态矩阵（完整锁定在 output-collector.test 的 MF-1 describe）：
//   态① 从未调用 SO；态② isError（gate 终止/不可满足 schema）；态③ 调用过但无 details。

/** 构造态②真实产物（isError SO 调用，schema 校验失败——gate 终止回归场景）。 */
function state2Attribution(): string {
  const soCalls: ToolCall[] = [
    {
      toolName: "structured-output",
      isError: true,
      result: { details: {}, content: [{ type: "text", text: "Schema validation failed: /target is required" }] },
    },
  ];
  const msg = describeMissingParsedOutput(soCalls);
  expect(msg).toBeDefined();
  return msg!;
}

describe("MF-1: 确定性 schema 失败单次终态", () => {
  it("态②真实产物（gate 终止/schema 校验失败归因）→ runner.run 恰 1 次 + 终态 failed", async () => {
    const attribution = state2Attribution();
    expect(isDeterministicSchemaFailureMsg(attribution)).toBe(true);

    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeFailedResult(attribution)),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(call.attempts).toBe(1);
    expect(call.status).toBe("done");
    expect(findByStep(trace, 0)?.status).toBe("failed");
  });

  it("态①真实产物（never called，缺 extension 环境确定性）→ 同样单次终态", async () => {
    const attribution = describeMissingParsedOutput([])!;
    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeFailedResult(attribution)),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(call.attempts).toBe(1);
    expect(findByStep(trace, 0)?.status).toBe("failed");
  });

  it("usage consume 恰一次、totalCallCount=1", async () => {
    const attribution = state2Attribution();
    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(
        makeMockResult({
          error: attribution,
          failureKind: "schema_deterministic",
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 0 },
        }),
      ),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    // 恰一次加权消耗（input×1 + output×2 = 100 + 100 = 200，权重见 budget.ts）
    expect(budget.usedTokens).toBe(200);
    expect(budget.usedCost).toBeCloseTo(0.01);
    expect(budget.totalCallCount).toBe(1);
  });

  it("终态 error 保持归因原文", async () => {
    const attribution = state2Attribution();
    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeFailedResult(attribution)),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(call.result?.error).toBe(attribution);
  });

  it("态③（no details，无标记）→ 同样单次终态（ADR-0122：失败显式上报）", async () => {
    // 态③真实文案（不带确定性标记）
    const msg = describeMissingParsedOutput([
      { toolName: "structured-output", result: { content: [] } },
    ])!;
    expect(isDeterministicSchemaFailureMsg(msg)).toBe(false);

    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeFailedResult(msg)),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(findByStep(trace, 0)?.status).toBe("failed");
  });

  it("分诊交叉锁定：标记词不命中任何 STALE_CONTEXT_PATTERNS（stale 分诊不误吞）", () => {
    const lower = DETERMINISTIC_SCHEMA_FAILURE_PREFIX.toLowerCase();
    for (const pattern of STALE_CONTEXT_PATTERNS) {
      expect(lower.includes(pattern)).toBe(false);
    }
    // 两个分诊只命中确定性分支，互不污染
    expect(isStaleContextErrorMsg(DETERMINISTIC_SCHEMA_FAILURE_PREFIX)).toBe(false);
    expect(isDeterministicSchemaFailureMsg(DETERMINISTIC_SCHEMA_FAILURE_PREFIX)).toBe(true);
  });
});

// ── D5-③: failureKind 结构化分诊（词表在产出侧 output-collector.classifyFailureKind）──
//
// [ADR-0122] 分诊不再绑定重试语义——任何 failureKind 均单次终态；分诊结果随
// result 透传进 trace 节点，供消费方分类展示。

describe("D5-③: failureKind 分诊字段透传", () => {
  it("stale_context → 单次终态 failed（V5③）", async () => {
    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({
        error: PI_REAL_STALE_MESSAGE,
        failureKind: "stale_context",
      })),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(call.attempts).toBe(1);
    expect(call.status).toBe("done");
    expect(call.result?.error).toBe(PI_REAL_STALE_MESSAGE);
    expect(findByStep(trace, 0)?.status).toBe("failed");
  });

  it("schema_deterministic → 单次终态 failed", async () => {
    const attribution = state2Attribution();
    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({
        error: attribution,
        failureKind: "schema_deterministic",
      })),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(findByStep(trace, 0)?.status).toBe("failed");
  });

  it("unknown → 单次终态 failed（provider 5xx 等瞬态错误显式上报，不自动重试）", async () => {
    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({
        error: "provider 503 service unavailable",
        failureKind: "unknown",
      })),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(call.status).toBe("done");
    expect(call.result?.error).toBe("provider 503 service unavailable");
    expect(findByStep(trace, 0)?.status).toBe("failed");
  });

  it("failureKind 缺省（旧链路/上游未写）→ 单次终态 failed", async () => {
    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeMockResult({ error: "spawn EAGAIN transient" })),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(findByStep(trace, 0)?.status).toBe("failed");
  });

  it("词表漂移失效模式：未知错误文案 → classifyFailureKind=unknown → 仍单次终态（分类降级不影响执行面）", async () => {
    // pi 升级改写 stale 文案后，旧词表对新文案零命中——分诊降级 unknown 只影响
    // 分类展示，执行面恒为单次终态（ADR-0122）
    const futurePiError = "extension runtime was superseded by a newer orchestration epoch";
    expect(classifyFailureKind(futurePiError)).toBe("unknown");

    const { call, trace } = makeAgentCallAndTrace();
    const runner = createMockRunner(
      vi.fn().mockResolvedValue(makeFailedResult(futurePiError)),
    );
    const budget = new Budget();

    await executeAgentCall(call, runner, budget, new AbortController().signal, trace);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(findByStep(trace, 0)?.status).toBe("failed");
  });
});
