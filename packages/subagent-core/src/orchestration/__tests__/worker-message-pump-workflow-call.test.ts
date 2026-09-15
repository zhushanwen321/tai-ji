/**
 * dispatchWorkflowCall — workflow-call 消息路由测试。
 *
 * 通过 handleWorkerMessage 触发 workflow-call case，验证：
 * - onWorkflowCall 回调被正确调用（name + args + parentRun）
 * - 成功时 postMessage(workflow-result, result)
 * - onWorkflowCall reject 时 postMessage 含 error
 * - onWorkflowCall 未注入时 postMessage 含 error（向后兼容）
 * - stale 完成守卫（resolve 前 run 已终态 → 不 postMessage）
 */
import { describe, expect, it, vi } from "vitest";

import { handleWorkerMessage } from "../worker-message-pump.ts";
import type { LifecycleDeps, WorkerHandlers } from "../models/ports.ts";
import type { WorkflowRun } from "../models/workflow-run.ts";

// ── helpers ──────────────────────────────────────────────────

/** flush microtask 队列，让 void .then().catch() 链路跑完。 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 构造一个 status="running" 的 mock WorkflowRun，postMessage 可观测。 */
function makeRunningRun(postMessage: ReturnType<typeof vi.fn>): WorkflowRun {
  return {
    state: { status: "running" },
    runtime: { worker: { postMessage } },
  } as unknown as WorkflowRun;
}

/** LifecycleDeps 只需 onWorkflowCall（dispatchWorkflowCall 唯一消费的 dep）。 */
function makeDeps(onWorkflowCall?: LifecycleDeps["onWorkflowCall"]): LifecycleDeps {
  return { onWorkflowCall } as unknown as LifecycleDeps;
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
  result: { content: string; error?: string };
}

/** 从 postMessage mock 取第 0 次调用的第 0 参，类型安全窄化。 */
function firstPosted(postMessage: ReturnType<typeof vi.fn>): PostedMsg {
  return postMessage.mock.calls[0]![0] as PostedMsg;
}

// ── tests ────────────────────────────────────────────────────

describe("dispatchWorkflowCall (workflow-call routing)", () => {
  it("calls onWorkflowCall with name and args", async () => {
    const postMessage = vi.fn();
    const onWorkflowCall = vi.fn(async () => ({ content: "ok" }));
    const run = makeRunningRun(postMessage);
    const deps = makeDeps(onWorkflowCall);

    await handleWorkerMessage(
      run,
      { type: "workflow-call", callId: 1, name: "sub", args: { k: 1 } },
      deps,
      makeHandlers(),
    );
    await flushMicrotasks();

    expect(onWorkflowCall).toHaveBeenCalledTimes(1);
    expect(onWorkflowCall).toHaveBeenCalledWith("sub", { k: 1 }, run);
  });

  it("posts workflow-result on success", async () => {
    const postMessage = vi.fn();
    const onWorkflowCall = vi.fn(async () => ({ content: "result-data" }));
    const run = makeRunningRun(postMessage);
    const deps = makeDeps(onWorkflowCall);

    await handleWorkerMessage(
      run,
      { type: "workflow-call", callId: 2, name: "sub", args: {} },
      deps,
      makeHandlers(),
    );
    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledWith({
      type: "workflow-result",
      callId: 2,
      result: { content: "result-data" },
    });
  });

  it("posts error result when onWorkflowCall rejects", async () => {
    const postMessage = vi.fn();
    const onWorkflowCall = vi.fn(async () => {
      throw new Error("boom");
    });
    const run = makeRunningRun(postMessage);
    const deps = makeDeps(onWorkflowCall);

    await handleWorkerMessage(
      run,
      { type: "workflow-call", callId: 3, name: "sub", args: {} },
      deps,
      makeHandlers(),
    );
    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const sent = firstPosted(postMessage);
    expect(sent.type).toBe("workflow-result");
    expect(sent.callId).toBe(3);
    expect(sent.result.error).toBe("boom");
  });

  it("posts error result when onWorkflowCall not injected", async () => {
    const postMessage = vi.fn();
    const run = makeRunningRun(postMessage);
    const deps = makeDeps(undefined);

    await handleWorkerMessage(
      run,
      { type: "workflow-call", callId: 4, name: "sub", args: {} },
      deps,
      makeHandlers(),
    );
    await flushMicrotasks();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const sent = firstPosted(postMessage);
    expect(sent.type).toBe("workflow-result");
    expect(sent.result.error).toContain("onWorkflowCall not injected");
  });

  it("does not post when run reaches terminal state before result arrives", async () => {
    const postMessage = vi.fn();
    let resolveWorkflow: (value: unknown) => void = () => {};
    const workflowPromise = new Promise<unknown>((r) => {
      resolveWorkflow = r;
    });
    const onWorkflowCall = vi.fn(() => workflowPromise);
    const run = makeRunningRun(postMessage);
    const deps = makeDeps(onWorkflowCall);

    await handleWorkerMessage(
      run,
      { type: "workflow-call", callId: 5, name: "sub", args: {} },
      deps,
      makeHandlers(),
    );

    // dispatchWorkflowCall 已触发，onWorkflowCall pending。
    // 在 resolve 前终止 run（转终态 done）—— stale 完成守卫应阻止 postMessage。
    run.state.status = "done";
    resolveWorkflow({ content: "late" });
    await flushMicrotasks();

    expect(postMessage).not.toHaveBeenCalled();
  });
});
