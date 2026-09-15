/**
 * WorkerHostImpl — workerData 映射测试。
 *
 * Option B（run-level model/thinkingLevel）的映射点在 WorkerHostImpl.start：
 * RunSpec.model/thinkingLevel → workerData.model/thinkingLevel → worker 内
 * $MODEL/$THINKING_LEVEL globals（worker-script-builder 注入）→ agent() fallback。
 *
 * 本测试 mock node:worker_threads.Worker，捕获构造 options.workerData，
 * 直接断言映射（lifecycle.test.ts 的 workerHost.start 是 mock，看不到 workerData）。
 */
import { describe, expect, it, vi } from "vitest";

const { workerMock } = vi.hoisted(() => ({
  workerMock: vi.fn(),
}));

vi.mock("node:worker_threads", () => ({
  Worker: workerMock,
}));

import { WorkerHostImpl } from "../worker-host.ts";
import type { RunSpec } from "../models/run-spec.ts";
import type { WorkerHandlers } from "../models/ports.ts";

interface WorkerOptions {
  eval?: boolean;
  workerData?: Record<string, unknown>;
}

/** mock Worker 实例（WorkerHandle 依赖 on/postMessage/terminate）。 */
function fakeWorkerInstance() {
  return { on: vi.fn(), postMessage: vi.fn(), terminate: vi.fn() };
}

function makeSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    scriptSource: "execute() {}",
    args: { autoCommit: true },
    scriptName: "test-wf",
    scriptPath: "/fake/test.js",
    description: "test desc",
    ...overrides,
  };
}

function makeHandlers(): WorkerHandlers {
  return {
    onMessage: vi.fn(),
    onError: vi.fn(),
    onExit: vi.fn(),
  };
}

describe("WorkerHostImpl.start — workerData 映射", () => {
  it("Option B: RunSpec.model/thinkingLevel 映射进 workerData（其余字段不破坏）", () => {
    const spec = makeSpec({
      model: "anthropic/claude-3.5-sonnet",
      thinkingLevel: "high",
      budgetTokens: 5000,
    });
    let captured: WorkerOptions | undefined;
    workerMock.mockImplementation(function (
      this: unknown,
      _code: string,
      options: WorkerOptions,
    ) {
      captured = options;
      return fakeWorkerInstance();
    });

    new WorkerHostImpl().start(spec, spec.args, makeHandlers());

    expect(workerMock).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    const wd = captured!.workerData;
    expect(wd).toBeDefined();
    // Option B 核心：run-level override 经 workerData 进入 worker globals
    expect(wd!.model).toBe("anthropic/claude-3.5-sonnet");
    expect(wd!.thinkingLevel).toBe("high");
    // workerData 契约其余字段（防未来重构破坏 worker 启动链路）
    expect(wd!.scriptPath).toBe("/fake/test.js");
    expect(wd!.args).toEqual({ autoCommit: true });
    expect(wd!.meta).toEqual({ name: "test-wf", description: "test desc" });
    expect(wd!.budget).toEqual({ maxTokens: 5000, usedTokens: 0, usedCost: 0 });
    expect(captured!.eval).toBe(true);
  });

  it("model/thinkingLevel 未设：workerData 字段为 undefined（继承主 agent 语义，不污染）", () => {
    let captured: WorkerOptions | undefined;
    workerMock.mockImplementation(function (
      this: unknown,
      _code: string,
      options: WorkerOptions,
    ) {
      captured = options;
      return fakeWorkerInstance();
    });

    new WorkerHostImpl().start(makeSpec(), {}, makeHandlers());

    expect(captured!.workerData!.model).toBeUndefined();
    expect(captured!.workerData!.thinkingLevel).toBeUndefined();
  });

  it("handlers 绑定：message/error/exit 三类事件注册到 worker", () => {
    const instance = fakeWorkerInstance();
    workerMock.mockImplementation(function (this: unknown) {
      return instance;
    });

    const handle = new WorkerHostImpl().start(makeSpec(), {}, makeHandlers());

    expect(instance.on).toHaveBeenCalledTimes(3);
    expect(instance.on).toHaveBeenCalledWith("message", expect.any(Function));
    expect(instance.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(instance.on).toHaveBeenCalledWith("exit", expect.any(Function));
    // handle 持底层 worker（RunRuntime 直接访问 ref/href）
    expect(handle.raw).toBe(instance);
  });
});
