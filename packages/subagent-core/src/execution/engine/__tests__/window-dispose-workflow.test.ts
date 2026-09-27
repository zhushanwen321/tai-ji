// src/execution/engine/__tests__/window-dispose-workflow.test.ts
//
// [U2 pi-workflow-run-resource-model] workflow 域窗口实例收尾接线 + probe 通道改道
// 单测（impl-plan u2 验收四条；fake client，不拉真实进程）：
//   1. run 收尾后窗口实例全部 dispose（finalizeRun 五步序列末尾追加）；
//   2. abort 路径时序：dispose 在 closeOutInFlightCalls 之后（断言调用序 + 在途
//      call 已收尾）；
//   3. probe 调用不再触达 registry getEngine（窗口表取用复用 + routeEngineForHost
//      注入位同源）；
//   4. shared-service 引擎走收尾不被 dispose（registry 透传保形）。
// 权威源：技术设计 §3.1 机制 2/3、§3.3 决策 1、§5 U2 + ADR-0079。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentCall } from "../../../orchestration/models/agent-call.ts";
import { Budget } from "../../../orchestration/models/budget.ts";
import { RunRuntime } from "../../../orchestration/models/run-runtime.ts";
import { Trace } from "../../../orchestration/models/trace.ts";
import type {
  AgentResult,
  ExecutionTraceNode,
} from "../../../orchestration/models/types.ts";
import { WorkflowRun } from "../../../orchestration/models/workflow-run.ts";
import type { LifecycleDeps } from "../../../orchestration/models/ports.ts";
import type { WorkerHandle } from "../../../orchestration/worker-handle.ts";
import { finalizeRun } from "../../../orchestration/worker-message-pump.ts";
import {
  resetWorkflowWindowEngineStatesForTest,
  resolveWorkflowWindowEnginePort,
  routeEngineForHost,
  setWorkflowWindowEngineGateway,
  workflowWindowEngineState,
  type EngineRouteResult,
} from "../routing.ts";
import * as registryModule from "../registry.ts";
import { clearEngines, registerEngine } from "../registry.ts";
import type {
  EngineCapabilities,
  ProbeReport,
  SessionView,
} from "../types.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../port.ts";

// ── 替身 ─────────────────────────────────────────────────────

/** 引擎能力位全集（对齐 FakePiEnginePort 口径——gate 同步消费的形状锁定）。 */
function fakeCapabilities(): EngineCapabilities {
  return {
    schemaEnforcement: "native",
    steer: "unsupported",
    conversation: "native",
    personaInjection: "flag",
    eventGranularity: "stream",
    sandbox: "emulated",
    sessionRead: "full",
    resume: "native",
    interrupt: "kill-only",
    permissionMode: "native",
    maxTurns: true,
  };
}

/** 窗口实例替身：dispose 计数 + 可注入的 dispose 观察点（时序断言用）。 */
class FakeWindowEnginePort implements EnginePort {
  readonly id: string;
  disposed = 0;
  onDispose?: () => void;

  constructor(id: string) {
    this.id = id;
  }

  capabilities(): EngineCapabilities {
    return fakeCapabilities();
  }

  async probe(): Promise<ProbeReport> {
    return { ok: true, engineVersion: "fake-1", checks: [{ name: "invocation", ok: true }] };
  }

  run(_task: Parameters<EnginePort["run"]>[0], _ctx: RunContext): Promise<EngineRunResult> {
    return new Promise<EngineRunResult>(() => {});
  }

  async read(_handle: Parameters<EnginePort["read"]>[0]): Promise<SessionView> {
    return { engineId: this.id, turns: [], source: "outcome-only" };
  }

  async dispose(): Promise<void> {
    this.disposed += 1;
    this.onDispose?.();
  }
}

/** 构造真实 WorkflowRun（真实状态机 transition）+ 初始 runtime（finalize-run 测试同款）。 */
function makeRealRun(runId: string): WorkflowRun {
  const run = new WorkflowRun(
    runId,
    {
      scriptName: "test-wf",
      scriptSource: "agent('hi')",
      args: {},
      scriptPath: "/tmp/test-wf.js",
    },
    {
      status: "running",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(async () => {}),
  } as unknown as WorkerHandle;
  run.assignRuntime(new RunRuntime(worker, new AbortController()));
  return run;
}

/** deps mock：副作用打点进单一顺序数组（dispose 时序断言与 closeOut/save 共用同一序列）。 */
function makeTracingDeps(): LifecycleDeps & {
  order: string[];
} {
  const order: string[] = [];
  return {
    order,
    store: {
      save: vi.fn(async () => {
        order.push("save");
      }),
    },
    workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
    runner: { run: vi.fn(async () => ({}) as AgentResult) },
    runs: new Map(),
    appendEntry: vi.fn((customType: string) => {
      order.push(`append:${customType}`);
    }),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(() => {
      order.push("onRunDone");
    }),
    log: vi.fn(),
  } as unknown as LifecycleDeps & { order: string[] };
}

/** 注册 per-window 网关：全部引擎按窗口实例创建（测试自持端口映射）。 */
function usePerWindowGateway(ports: Record<string, FakeWindowEnginePort>): void {
  setWorkflowWindowEngineGateway({
    processModelOf: () => "per-window",
    createPort: (engineId) => {
      const port = ports[engineId];
      if (!port) throw new Error(`fixture gap: no fake port for '${engineId}'`);
      return port;
    },
  });
}

// ── 用例 ─────────────────────────────────────────────────────

describe("workflow 窗口实例收尾接线（U2）", () => {
  beforeEach(() => {
    resetWorkflowWindowEngineStatesForTest();
  });

  afterEach(() => {
    resetWorkflowWindowEngineStatesForTest();
    clearEngines();
    vi.restoreAllMocks();
  });

  it("验收①：run 收尾后窗口实例全部 dispose（多引擎，经窗口解析创建登记）", async () => {
    const runId = "wf-win-dispose-all";
    const portA = new FakeWindowEnginePort("fake-a");
    const portB = new FakeWindowEnginePort("fake-b");
    usePerWindowGateway({ "fake-a": portA, "fake-b": portB });

    // 窗口内两次引擎解析（创建 + 登记）
    resolveWorkflowWindowEnginePort(runId, "fake-a");
    resolveWorkflowWindowEnginePort(runId, "fake-b");

    const ok = await finalizeRun(makeRealRun(runId), makeTracingDeps(), "completed", {
      context: "test",
    });

    expect(ok).toBe(true);
    expect(portA.disposed).toBe(1);
    expect(portB.disposed).toBe(1);
  });

  it("验收②：abort 路径时序——dispose 在 closeOutInFlightCalls 之后（调用序断言）", async () => {
    const runId = "wf-win-dispose-abort";
    const run = makeRealRun(runId);
    const deps = makeTracingDeps();

    // 在途 call（dispatch 后未完成）：closeOutInFlightCalls 的收口对象
    const node: ExecutionTraceNode = {
      stepIndex: 1,
      agent: "reviewer",
      task: "t",
      model: "m",
      status: "running",
    };
    const call = new AgentCall(1, { prompt: "p" }, node);
    call.markRunning();
    run.state.calls.set(1, call);
    run.state.trace.append(node);

    const port = new FakeWindowEnginePort("fake-win");
    usePerWindowGateway({ "fake-win": port });
    resolveWorkflowWindowEnginePort(runId, "fake-win");
    // dispose 执行时点断言：在途 call 已被 closeOut 收口（done + trace failed）。
    // closeOut 是 finalizeRun 的模块内部调用，其「先于 dispose」只能靠被收口对象的
    // 状态在 dispose 时点已翻转来证明——dispose 早于 closeOut 时本断言为 false。
    let closeOutObservedAtDispose = false;
    port.onDispose = () => {
      deps.order.push("dispose");
      closeOutObservedAtDispose = call.status === "done" && node.status === "failed";
    };

    const ok = await finalizeRun(run, deps, "aborted", { context: "abort" });

    expect(ok).toBe(true);
    expect(port.disposed).toBe(1);
    expect(closeOutObservedAtDispose).toBe(true);
    expect(call.result?.error).toContain("Cancelled");
    // dispose 是五步序列末尾（onRunDone 围栏之后的最后一步）
    expect(deps.order).toEqual([
      "append:workflow-record",
      "save",
      "append:pending:unregister",
      "onRunDone",
      "dispose",
    ]);
  });

  it("验收③：probe 调用不再触达 registry getEngine（窗口表创建复用 + 路由注入位同源）", async () => {
    const registrySpy = vi.spyOn(registryModule, "getEngine");
    const runId = "wf-win-probe";
    const port = new FakeWindowEnginePort("fake-perwin");
    let created = 0;
    setWorkflowWindowEngineGateway({
      processModelOf: () => "per-window",
      createPort: () => {
        created += 1;
        return port;
      },
    });

    // 窗口内首触创建、后续复用（恰一次创建）
    const first = resolveWorkflowWindowEnginePort(runId, "fake-perwin");
    const second = resolveWorkflowWindowEnginePort(runId, "fake-perwin");
    expect(first).toBe(port);
    expect(second).toBe(port);
    expect(created).toBe(1);
    expect(registrySpy).not.toHaveBeenCalled();
    expect(registryModule.hasEngine("fake-perwin")).toBe(false);

    // workflow-dispatch 注入位契约：routeEngineForHost 的 probe 与 getEngineFn 注入
    // 同一解析来源——probe 通过后的取用（directRoute）拿同一窗口实例
    const routed = await routeEngineForHost({
      routing: { callEngine: "fake-perwin" },
      strict: false,
      probe: (engineId) => resolveWorkflowWindowEnginePort(runId, engineId).probe(),
      getEngineFn: (engineId) => resolveWorkflowWindowEnginePort(runId, engineId),
      piEngine: new FakeWindowEnginePort("pi"),
      hasEngineFn: () => true,
      listEnginesFn: () => ["fake-perwin"],
      listAvailableEnginesFn: () => ["fake-perwin"],
    });
    expect((routed as EngineRouteResult).engineId).toBe("fake-perwin");
    expect((routed as EngineRouteResult).engine).toBe(port);
    expect(registrySpy).not.toHaveBeenCalled();

    // probe 创建的实例归窗口表所有：run 收尾即 dispose（G1 回落判定的机制面）
    await finalizeRun(makeRealRun(runId), makeTracingDeps(), "completed", { context: "test" });
    expect(port.disposed).toBe(1);
  });

  it("验收⑤：pi 同步短路位 piEngine 注入携带窗口键——pi 请求取窗口实例（probe/run 同实例，收尾 dispose）", async () => {
    // 2026-09-27 batch-s4 真机首跑实锤的机制面：pi 请求经 routeEngineForHost 同步
    // 短路返回注入的 piEngine（routing.ts 短路位），它是成员任务 engine.run 的实际
    // 执行体——注入值必须来自窗口解析单点（workflow-dispatch 装配形态：
    // resolveChatEnginePort(parentRunId) = resolveWorkflowWindowEnginePort(parentRunId,
    // "pi")），否则 per-window 引擎首 run 即 WindowScopeEngineError 拒答。
    const runId = "wf-win-pi-shortcircuit";
    const piPort = new FakeWindowEnginePort("pi");
    usePerWindowGateway({ pi: piPort });

    const routed = routeEngineForHost({
      routing: {}, // 缺省 = pi 请求 → 同步短路位
      strict: false,
      probe: (engineId) => resolveWorkflowWindowEnginePort(runId, engineId).probe(),
      piEngine: resolveWorkflowWindowEnginePort(runId, "pi"),
    });
    const r = routed as EngineRouteResult;
    expect(r.engineId).toBe("pi");
    expect(r.engine).toBe(piPort);

    // probe 注入与 piEngine 注入同窗口键 → 同实例（probe 探的与 run 用的同一窗口
    // 实例）→ run 收尾 dispose 覆盖（G1 回落判定的机制面）
    const ok = await finalizeRun(makeRealRun(runId), makeTracingDeps(), "completed", { context: "test" });
    expect(ok).toBe(true);
    expect(piPort.disposed).toBe(1);
  });

  it("验收④：shared-service 引擎透传 registry 单例，走收尾不被 dispose（保形）", async () => {
    const sharedPort = new FakeWindowEnginePort("zcode-like");
    registerEngine("zcode-like", () => sharedPort);
    const registrySpy = vi.spyOn(registryModule, "getEngine");
    const runId = "wf-win-shared";
    const run = makeRealRun(runId);
    const deps = makeTracingDeps();

    // 缺省网关（保守 shared-service 透传）下的解析 = registry 单例路径
    const first = resolveWorkflowWindowEnginePort(runId, "zcode-like");
    const again = resolveWorkflowWindowEnginePort(runId, "zcode-like");
    expect(first).toBe(sharedPort);
    expect(again).toBe(sharedPort);
    expect(registrySpy).toHaveBeenCalled();
    // shared-service 不进窗口表（U1 register no-op 语义的接线侧印证）
    expect(workflowWindowEngineState(runId).instances.get("zcode-like")).toBeUndefined();

    await finalizeRun(run, deps, "completed", { context: "test" });

    // 透传引擎的停机面不经窗口收尾触发（dispose 通道归 registry/停机链，现状保形）
    expect(sharedPort.disposed).toBe(0);
  });
});
