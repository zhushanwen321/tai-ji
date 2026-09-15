/**
 * workflow() 嵌套调用 — E2E 集成测试。
 *
 * 从 handleWorkerMessage 入口（发 workflow-call 消息）出发，走完完整链路：
 * handleWorkerMessage → dispatchWorkflowCall → deps.onWorkflowCall(executeNestedWorkflow)
 * → runWorkflow(mock) → pollRunToResult → postMessage(workflow-result)。
 *
 * 验证 Wave 1（协议层 dispatchWorkflowCall）与 Wave 2（实现 executeNestedWorkflow）
 * 的端到端对接正确。
 *
 * Mock 策略：
 * - vi.mock("../lifecycle.ts") 控制 runWorkflow：返回固定 runId + 把预构造的 child run
 *   注入 deps.runs（使 pollRunToResult 首轮命中 done）
 * - deps.registry.get 返回预定义 WorkflowScript
 * - parent runtime.worker.postMessage 捕获 workflow-result 消息
 * - deps.onWorkflowCall 用真实的 executeNestedWorkflow 注入（模拟 Interface 层 makeDeps）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 必须在 import 之前（hoisting 保证拿到 mock 版本）
vi.mock("../lifecycle.ts", () => ({
  runWorkflow: vi.fn(),
  abortRun: vi.fn(async () => {}),
  scheduleTimeBudget: vi.fn(() => undefined),
}));

import { handleWorkerMessage } from "../worker-message-pump.ts";
import { executeNestedWorkflow, type LauncherDeps } from "../launcher.ts";
import { runWorkflow } from "../lifecycle.ts";
import { Budget } from "../models/budget.ts";
import type { RunSpec } from "../models/run-spec.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";
import type { WorkflowScript } from "../models/workflow-script.ts";
import type { LintResult } from "../script-lint.ts";

const MOCK_RUN_ID = "wf-e2e-child";

// ── helpers ──────────────────────────────────────────────────

/** flush microtask 队列，让 void .then().catch() 异步链路跑完。 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 构造 mock WorkflowScript（validate / toExecutable 可控）。 */
function makeScript(opts: { valid?: boolean; lintErrorMsg?: string } = {}): WorkflowScript {
  const valid = opts.valid ?? true;
  return {
    name: "child-wf",
    path: "/fake/child-wf.js",
    meta: { name: "child-wf", description: "child workflow", phases: [] },
    toExecutable: () => "const meta = {}; execute() {}",
    validate: (): LintResult => ({
      valid,
      findings: valid
        ? []
        : [
            {
              severity: "error",
              line: 3,
              message: opts.lintErrorMsg ?? "lint boom",
              suggestion: "fix it",
            },
          ],
    }),
  } as unknown as WorkflowScript;
}

/**
 * 构造 mock parent WorkflowRun（status="running"，有 postMessage + controller）。
 *
 * 同时满足 handleWorkerMessage（需 status + runtime.worker）和 executeNestedWorkflow
 * （需 spec.scriptName/chain + runtime.controller.signal + state.budget）的要求。
 */
function makeParentRun(opts: {
  scriptName?: string;
  parentWorkflowChain?: readonly string[];
  budget?: Budget;
  postMessage?: ReturnType<typeof vi.fn>;
} = {}): WorkflowRun {
  const controller = new AbortController();
  const postMessage = opts.postMessage ?? vi.fn();
  return {
    spec: {
      scriptName: opts.scriptName ?? "parent-wf",
      parentWorkflowChain: opts.parentWorkflowChain,
    },
    state: {
      status: "running",
      budget: opts.budget ?? new Budget({ maxTokens: 10000 }),
    },
    runtime: { controller, worker: { postMessage } },
  } as unknown as WorkflowRun;
}

/** 构造 mock child WorkflowRun（done 终态，pollRunToResult 首轮命中）。 */
function makeDoneChildRun(opts: {
  reason?: "completed" | "failed" | "aborted";
  scriptResult?: unknown;
  error?: string;
  usedTokens?: number;
  usedCost?: number;
}): WorkflowRun {
  const reason = opts.reason ?? "completed";
  return {
    runId: MOCK_RUN_ID,
    spec: { scriptName: "child-wf" },
    state: {
      status: "done",
      reason,
      scriptResult: opts.scriptResult,
      error: opts.error,
      budget: { usedTokens: opts.usedTokens ?? 0, usedCost: opts.usedCost ?? 0 },
    },
  } as unknown as WorkflowRun;
}

/** 构造 LauncherDeps mock：registry + runs（Map）+ 占位 port。 */
function makeDeps(opts: {
  script?: WorkflowScript;
  childRun?: WorkflowRun;
  registry?: { getPath: ReturnType<typeof vi.fn> };
} = {}): LauncherDeps {
  const runs = new Map<string, WorkflowRun>();
  if (opts.childRun) runs.set(MOCK_RUN_ID, opts.childRun);
  const registry = opts.registry ?? {
    getPath: vi.fn(async () => opts.script),
  };
  return {
    registry,
    runs,
    store: { save: vi.fn(async () => {}), loadAll: vi.fn(async () => []) },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({})) },
    log: vi.fn(),
    eventBus: { emit: vi.fn() },
  } as unknown as LauncherDeps;
}

/** 配置 runWorkflow mock：把 childRun 注入 deps.runs 并返回 MOCK_RUN_ID。 */
function setupRunWorkflow(childRun: WorkflowRun): void {
  vi.mocked(runWorkflow).mockImplementation(async (_spec, deps) => {
    deps.runs.set(MOCK_RUN_ID, childRun);
    return MOCK_RUN_ID;
  });
}

/** WorkerHandlers 占位（workflow-call 路径不触发 handler 回调）。 */
function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onExit: vi.fn(async () => {}),
  } as unknown as WorkerHandlers;
}

interface PostedMsg {
  type: string;
  callId: number;
  result: { content: string; parsedOutput?: unknown; error?: string };
}

/** 从 postMessage mock 取第 0 次调用的第 0 参，类型安全窄化。 */
function firstPosted(postMessage: ReturnType<typeof vi.fn>): PostedMsg {
  return postMessage.mock.calls[0]![0] as PostedMsg;
}

/**
 * 把 executeNestedWorkflow 绑定为 deps.onWorkflowCall（模拟 Interface 层 makeDeps）。
 *
 * 闭包引用 deps——与 index.ts makeDeps 的模式一致。
 */
function wireOnWorkflowCall(deps: LauncherDeps): void {
  (deps as LifecycleDeps).onWorkflowCall = (name, args, parentRun) =>
    executeNestedWorkflow(name, args, parentRun, deps);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── tests ────────────────────────────────────────────────────

describe("workflow() nesting end-to-end", () => {
  it("end-to-end: workflow-call → executeNestedWorkflow → workflow-result posted back", async () => {
    const postMessage = vi.fn();
    const parent = makeParentRun({ postMessage });
    const childRun = makeDoneChildRun({
      reason: "completed",
      scriptResult: { data: "test" },
    });
    const deps = makeDeps({ script: makeScript(), childRun });
    setupRunWorkflow(childRun);
    wireOnWorkflowCall(deps);

    await handleWorkerMessage(
      parent,
      { type: "workflow-call", callId: 1, name: "child", args: {} },
      deps,
      makeHandlers(),
    );
    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const sent = firstPosted(postMessage);
    expect(sent.type).toBe("workflow-result");
    expect(sent.callId).toBe(1);
    expect(sent.result.content).toBe(JSON.stringify({ data: "test" }));
    expect(sent.result.parsedOutput).toEqual({ data: "test" });
    expect(sent.result.error).toBeUndefined();
  });

  it("end-to-end: circular call returns error result", async () => {
    const postMessage = vi.fn();
    // parent chain ["a"], scriptName "b" → target "a" 触发 a→b→a 循环
    const parent = makeParentRun({
      scriptName: "b",
      parentWorkflowChain: ["a"],
      postMessage,
    });
    const deps = makeDeps({ script: makeScript() });
    wireOnWorkflowCall(deps);

    await handleWorkerMessage(
      parent,
      { type: "workflow-call", callId: 2, name: "a", args: {} },
      deps,
      makeHandlers(),
    );
    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const sent = firstPosted(postMessage);
    expect(sent.result.error).toContain("Circular workflow call detected");
    expect(sent.result.content).toBe("");
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it("end-to-end: workflow not found returns error result", async () => {
    const postMessage = vi.fn();
    const parent = makeParentRun({ postMessage });
    const deps = makeDeps({ script: undefined });
    wireOnWorkflowCall(deps);

    await handleWorkerMessage(
      parent,
      { type: "workflow-call", callId: 3, name: "missing", args: {} },
      deps,
      makeHandlers(),
    );
    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const sent = firstPosted(postMessage);
    expect(sent.result.error).toContain("not found");
    expect(sent.result.content).toBe("");
  });

  it("end-to-end: child workflow failure propagates error", async () => {
    const postMessage = vi.fn();
    const parent = makeParentRun({ postMessage });
    const childRun = makeDoneChildRun({
      reason: "failed",
      error: "agent crashed",
    });
    const deps = makeDeps({ script: makeScript(), childRun });
    setupRunWorkflow(childRun);
    wireOnWorkflowCall(deps);

    await handleWorkerMessage(
      parent,
      { type: "workflow-call", callId: 4, name: "child", args: {} },
      deps,
      makeHandlers(),
    );
    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const sent = firstPosted(postMessage);
    expect(sent.result.error).toBe("agent crashed");
    expect(sent.result.content).toBe("");
  });

  it("end-to-end: child shares parent budget reference (no sync-back)", async () => {
    const postMessage = vi.fn();
    const parentBudget = new Budget({ maxTokens: 10000 });
    parentBudget.usedTokens = 100;
    const parent = makeParentRun({ budget: parentBudget, postMessage });
    const childRun = makeDoneChildRun({
      reason: "completed",
      scriptResult: "ok",
    });
    const deps = makeDeps({ script: makeScript(), childRun });

    // 捕获传给 runWorkflow 的 spec——验证 budgetRef 共享父 Budget 引用
    let capturedSpec: RunSpec | undefined;
    vi.mocked(runWorkflow).mockImplementation(async (spec, d) => {
      capturedSpec = spec;
      d.runs.set(MOCK_RUN_ID, childRun);
      return MOCK_RUN_ID;
    });
    wireOnWorkflowCall(deps);

    await handleWorkerMessage(
      parent,
      { type: "workflow-call", callId: 5, name: "child", args: {} },
      deps,
      makeHandlers(),
    );
    await flushMicrotasks();

    // 子 run 直接复用父 Budget 引用（budgetRef），无需 sync-back
    expect(capturedSpec?.budgetRef).toBe(parentBudget);
    expect(parent.state.budget.usedTokens).toBe(100);
  });
});
