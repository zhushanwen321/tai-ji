/**
 * rfl 仪表 T2（tier-1 §7.1）：引擎注入稳定 _runId。
 *
 *   A3 runWorkflow 在 validateRunArgs 后向 spec.args 注入 _runId（值 = 返回的
 *      runId）——runAndWait 与 executeNestedWorkflow 两个 args 入口共用的单一
 *      choke point（lifecycle.ts runWorkflow）。
 *   A4 rebuildRuntime 复用 run.spec.args 同一对象，_runId 跨 worker rebuild 不
 *      漂移（修复「rebuild 回退 run-<Date.now()> 导致 run 碎裂」）。
 */
import { describe, expect, it, vi } from "vitest";

import { rebuildRuntime } from "../worker-message-pump.ts";
import { runWorkflow } from "../lifecycle.ts";
import type { RunSpec } from "../models/run-spec.ts";
import type { LifecycleDeps } from "../models/ports.ts";

function makeSpec(args: Record<string, unknown> = {}): RunSpec {
  return {
    scriptSource: "module.exports = { execute: async () => 'ok' };",
    args,
    scriptName: "test-wf",
    scriptPath: "/fake/test.js",
  };
}

/** LifecycleDeps mock：workerHost.start 可观察（记录每次调用收到的 args 引用）。 */
function makeRecordingDeps(): LifecycleDeps & {
  startCalls: Array<{ spec: RunSpec; args: Record<string, unknown> }>;
} {
  const startCalls: Array<{ spec: RunSpec; args: Record<string, unknown> }> = [];
  const deps = {
    store: { save: vi.fn(async () => {}), loadAll: vi.fn(async () => []) },
    workerHost: {
      start: vi.fn((spec: RunSpec, args: Record<string, unknown>) => {
        startCalls.push({ spec, args });
        return { postMessage: vi.fn(), terminate: vi.fn(async () => {}) };
      }),
    },
    runner: { run: vi.fn(async () => ({})) },
    runs: new Map(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
  } as unknown as LifecycleDeps;
  return Object.assign(deps, { startCalls });
}

describe("A3 runWorkflow 注入 _runId（tier-1 §7.1）", () => {
  it("A3 runWorkflow 后 spec.args._runId === 返回的 runId（字符串），且 workerHost.start 收到同一值", async () => {
    const deps = makeRecordingDeps();
    const spec = makeSpec({ targetType: "file", target: "/tmp/x" });
    const runId = await runWorkflow(spec, deps);
    expect(runId).toBeTruthy();
    expect(spec.args._runId).toBe(runId);
    expect(typeof spec.args._runId).toBe("string");
    expect(deps.startCalls.length).toBe(1);
    expect(deps.startCalls[0].args._runId).toBe(runId);
  });

  it("A3 引擎注入覆盖用户预传的 _runId（非公开参数，引擎值权威）", async () => {
    const deps = makeRecordingDeps();
    const spec = makeSpec({ _runId: "user-supplied" });
    const runId = await runWorkflow(spec, deps);
    expect(runId).not.toBe("user-supplied");
    expect(spec.args._runId).toBe(runId);
  });
});

describe("A4 rebuild 后 _runId 稳定（tier-1 §7.1）", () => {
  it("A4 rebuildRuntime 第二次 workerHost.start 收到的 args._runId 非 undefined 且与首启一致（同一 args 对象）", async () => {
    const deps = makeRecordingDeps();
    const spec = makeSpec({ targetType: "file" });
    const runId = await runWorkflow(spec, deps);
    expect(deps.startCalls.length).toBe(1);

    const run = deps.runs.get(runId)!;
    expect(run).toBeTruthy();
    expect(run.state.status).toBe("running");

    // 触发 rebuild（对齐 worker-message-pump handleWorkerError 的恢复路径）
    rebuildRuntime(run, deps, {
      onMessage: vi.fn(),
      onError: vi.fn(),
      onExit: vi.fn(),
    });

    expect(deps.startCalls.length).toBe(2);
    const first = deps.startCalls[0].args;
    const second = deps.startCalls[1].args;
    expect(second._runId).not.toBeUndefined();
    expect(second._runId).toBe(first._runId);
    expect(second._runId).toBe(runId);
    // 同一对象引用（复用而非拷贝）——这是跨 rebuild 稳定的结构保证
    expect(second).toBe(first);
  });
});
