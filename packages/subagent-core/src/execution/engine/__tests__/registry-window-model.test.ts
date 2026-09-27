// src/execution/engine/__tests__/registry-window-model.test.ts
//
// [U5 pi-workflow-run-resource-model] registry D6 改造 + routing 网关真实化单测
//（impl-plan u5 验收 3/4；fake port，不拉真实进程）：
//   1. per-window 引擎不进 singletons：getEngine 返回同步只读代理（capabilities /
//      listModels / validateModel 直读 manifest 注册期快照——同步只读 3 处调用面零改动
//      兼容）；连接级成员（probe/run/read/dispose）fail-fast 抛 WindowScopeEngineError
//      并指路窗口实例解析；
//   2. validateModel 的「catalog 省略 = 成员摘除」形态经代理保形；
//   3. registry 覆盖重注册（引擎包升级换新代码）→ 活窗口旧实例 dispose + 窗口后续
//      解析用新 descriptor 重建实例（D6 末句待实施要求）；等价重注册不触发；
//   4. 网关真实化：processModelOf 读 descriptor manifest 声明（缺省 per-window /
//      inproc 与未注册 → shared-service）；per-window 解析经生产网关创建登记窗口
//      实例、窗口内复用、收尾释放后 respawn。
// 权威源：技术设计 §3.3 决策 6（D6）+ §5 U5 + ADR-0079。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearEngines,
  engineProcessModelOfDescriptor,
  getEngine,
  getEngineDescriptor,
  hasEngine,
  registerEngine,
  registerEngineDescriptor,
  WindowScopeEngineError,
  type CliEngineDescriptor,
} from "../registry.ts";
import {
  disposeWorkflowWindowEngineState,
  resolveWorkflowWindowEnginePort,
  resetWorkflowWindowEngineStatesForTest,
  workflowWindowEngineState,
} from "../routing.ts";
import type {
  EngineCapabilities,
  ProbeReport,
  SessionView,
} from "../types.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../port.ts";
import type { AgentOutcome } from "@zhushanwen/subagent-engine-sdk";

// ── 替身 ─────────────────────────────────────────────────────

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

/** 带 dispose 计数的窗口实例替身（网关 createPort / portFactory 产物）。 */
class FakeWindowEnginePort implements EnginePort {
  readonly id: string;
  disposed = 0;
  /** listModels 返回值（注入——同步只读成员转发断言的数据源）。 */
  models: Array<{ id: string }> | null = null;
  constructor(
    id: string,
    opts: { omitValidateModel?: boolean } = {},
  ) {
    this.id = id;
    if (opts.omitValidateModel === true) {
      // 对齐 RemoteEngine 构造器「catalog 省略 → own undefined 遮蔽」的摘除形态
      (this as unknown as { validateModel?: unknown }).validateModel = undefined;
    }
  }
  capabilities(): EngineCapabilities {
    return fakeCapabilities();
  }
  async probe(): Promise<ProbeReport> {
    return { ok: true, engineVersion: "fake-1", checks: [{ name: "invocation", ok: true }] };
  }
  run(_task: Parameters<EnginePort["run"]>[0], _ctx: RunContext): Promise<EngineRunResult> {
    const outcome: AgentOutcome = { content: "", engineId: this.id };
    return Promise.resolve({
      handle: { data: { v: 1, engineId: this.id, sessionRef: {}, adapterVersion: "fake" } },
      outcome,
    });
  }
  async read(_handle: Parameters<EnginePort["read"]>[0]): Promise<SessionView> {
    return { engineId: this.id, turns: [], source: "outcome-only" };
  }
  async dispose(): Promise<void> {
    this.disposed += 1;
  }
  // 可选同步只读成员（对齐 RemoteEngine 面——代理转发条件判定依赖成员存在性）
  listModels(): Array<{ id: string }> | null {
    return this.models;
  }
  validateModel(modelRef: string | undefined): { canonicalRef: string } {
    return { canonicalRef: modelRef ?? "" };
  }
}

/** cli descriptor 构造（portFactory 产出可计数替身；command 变化造「不同引擎」覆盖）。 */
function makeCliDescriptor(
  id: string,
  opts: {
    command?: string;
    packageVersion?: string;
    processModel?: "per-window" | "shared-service";
    modelCatalog?: { dynamic: boolean; models: Array<{ id: string }> } | null;
    ports?: FakeWindowEnginePort[];
    omitValidateModel?: boolean;
  } = {},
): CliEngineDescriptor {
  return {
    kind: "cli",
    command: opts.command ?? `/bin/fake-${id}`,
    args: [],
    capabilities: fakeCapabilities(),
    portFactory: () => {
      const port = new FakeWindowEnginePort(id, { omitValidateModel: opts.omitValidateModel });
      port.models = opts.modelCatalog?.models ?? null;
      opts.ports?.push(port);
      return port;
    },
    manifest: {
      ...(opts.processModel !== undefined ? { processModel: opts.processModel } : {}),
      ...(opts.modelCatalog !== undefined ? { modelCatalog: opts.modelCatalog } : {}),
    },
    packageVersion: opts.packageVersion ?? "1.0.0",
  };
}

beforeEach(() => {
  resetWorkflowWindowEngineStatesForTest();
  clearEngines();
});

afterEach(() => {
  resetWorkflowWindowEngineStatesForTest();
  clearEngines();
  vi.restoreAllMocks();
});

// ── D6：getEngine 二分 ──────────────────────────────────────

describe("registry D6：per-window 引擎不进 singletons，getEngine 返回同步只读代理", () => {
  it("验收④a：per-window 引擎 getEngine → 代理同步只读直答（capabilities/listModels/validateModel 转发底层快照面），不抛不连", () => {
    registerEngineDescriptor("pw", makeCliDescriptor("pw", {
      modelCatalog: { dynamic: false, models: [{ id: "only-model" }] },
    }));
    const engine = getEngine("pw");
    expect(engine.capabilities().conversation).toBe("native");
    // 「直读 manifest 快照」的成员实现语义由 remote-engine.test.ts 同步成员形态映射
    // describe 承载；本用例锁定代理对同步只读成员的转发透明性（调用面零改动兼容）。
    expect(engine.listModels!()).toEqual([{ id: "only-model" }]);
    expect(engine.validateModel!("only-model")).toEqual({ canonicalRef: "only-model" });
  });

  it("验收④b：连接级成员 fail-fast → WindowScopeEngineError（错误消息指路窗口实例解析）", () => {
    registerEngineDescriptor("pw", makeCliDescriptor("pw"));
    const engine = getEngine("pw");
    expect(() => engine.probe()).toThrowError(WindowScopeEngineError);
    expect(() => engine.run({ prompt: "p" }, { taskId: "t" })).toThrowError(WindowScopeEngineError);
    expect(() => engine.read({ data: { v: 1, engineId: "pw", sessionRef: {}, adapterVersion: "x" } }))
      .toThrowError(WindowScopeEngineError);
    expect(() => engine.dispose?.()).toThrowError(WindowScopeEngineError);
    try {
      engine.run({ prompt: "p" }, { taskId: "t" });
    } catch (err) {
      const e = err as WindowScopeEngineError;
      expect(e.code).toBe("engine_window_scoped");
      expect(e.engineId).toBe("pw");
      expect(e.member).toBe("run");
      expect(e.message).toContain("per-window");
      expect(e.message).toContain("window-instance");
    }
  });

  it("验收④c：validateModel 摘除形态经代理保形（底层成员缺席 → 代理缺席该成员）", () => {
    registerEngineDescriptor("pw-omitted", makeCliDescriptor("pw-omitted", {
      modelCatalog: undefined,
      omitValidateModel: true,
    }));
    const engine = getEngine("pw-omitted");
    expect(typeof (engine as unknown as { validateModel?: unknown }).validateModel).toBe("undefined");
    // 消费方判定形态（model-validation.ts）：typeof !== "function" → 跳过校验恒放行
    expect(typeof engine.validateModel).not.toBe("function");
  });

  it("验收④d：per-window 代理不进 singletons（重复 getEngine 返回同一缓存代理）；shared-service 声明引擎走单例路径", () => {
    registerEngineDescriptor("pw", makeCliDescriptor("pw"));
    const a = getEngine("pw");
    const b = getEngine("pw");
    expect(a).toBe(b); // 代理实现缓存（纯快照读面）

    const sharedPort = new FakeWindowEnginePort("shared");
    registerEngineDescriptor("zcode-like", makeCliDescriptor("zcode-like", { processModel: "shared-service" }));
    // 覆写 portFactory 换替身单例（descriptor 已注册——重建 descriptor 保持声明）
    registerEngineDescriptor("zcode-like", {
      kind: "cli",
      command: "/bin/fake-zcode-like",
      args: [],
      capabilities: fakeCapabilities(),
      portFactory: () => sharedPort,
      manifest: { processModel: "shared-service" },
      packageVersion: "1.0.0",
    });
    const s1 = getEngine("zcode-like");
    const s2 = getEngine("zcode-like");
    expect(s1).toBe(sharedPort);
    expect(s2).toBe(sharedPort); // shared-service：进程级单例路径（现状保形）
  });

  it("inproc 形态（过渡期宿主内建工厂）判 shared-service：getEngine 单例路径现状保形", () => {
    const port = new FakeWindowEnginePort("inproc-engine");
    registerEngine("inproc-engine", () => port);
    expect(getEngine("inproc-engine")).toBe(port);
    expect(getEngine("inproc-engine")).toBe(port);
  });
});

// ── D6：覆盖重注册触发活窗口 dispose ─────────────────────────

describe("registry D6：覆盖重注册 → 活窗口旧实例 dispose + 后续任务用新代码实例", () => {
  it("验收③：覆盖重注册（同 id 不同 command）→ 活窗口实例被 dispose；窗口重新解析 respawn 新实例（新 portFactory 产物）", async () => {
    const portsV1: FakeWindowEnginePort[] = [];
    const portsV2: FakeWindowEnginePort[] = [];
    registerEngineDescriptor("pw", makeCliDescriptor("pw", { command: "/bin/fake-pw-v1", ports: portsV1 }));

    // 窗口创建：per-window 解析（生产网关真实化链路）产出实例并登记
    const runId = "wf-rereg-1";
    const active = resolveWorkflowWindowEnginePort(runId, "pw");
    expect(portsV1).toHaveLength(1);
    expect(workflowWindowEngineState(runId).instances.get("pw")).toBeDefined();

    // 引擎包升级换新代码（command 变化 = 稳定标识不等价 → 覆盖重注册）
    registerEngineDescriptor("pw", makeCliDescriptor("pw", { command: "/bin/fake-pw-v2", ports: portsV2 }));

    // 活窗口旧实例被 dispose（触发不等待——waitFor 收敛）
    await vi.waitFor(() => expect(portsV1[0]!.disposed).toBe(1));

    // 窗口状态已被清（触发侧先摘后放）：后续解析 = 新 descriptor 重建（respawn 用新代码）
    const revived = resolveWorkflowWindowEnginePort(runId, "pw");
    expect(revived).not.toBe(active);
    expect(portsV2).toHaveLength(1);
    expect(revived).toBe(portsV2[0]);
  });

  it("等价重注册（同 command/args/version/manifest——发现器重扫常态）不触发活窗口 dispose", async () => {
    const ports: FakeWindowEnginePort[] = [];
    registerEngineDescriptor("pw", makeCliDescriptor("pw", { command: "/bin/fake-pw", ports }));
    const runId = "wf-rereg-equiv";
    resolveWorkflowWindowEnginePort(runId, "pw");
    expect(ports).toHaveLength(1);

    // 同磁盘 manifest 重扫 = 全等 descriptor（新函数实例、同标识字段）
    registerEngineDescriptor("pw", makeCliDescriptor("pw", { command: "/bin/fake-pw", ports: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ports[0]!.disposed).toBe(0); // 幂等重注册零破坏（杀令 B）
  });
});

// ── 网关真实化：processModelOf 读 manifest 注册期快照 ─────────

describe("routing 网关真实化：processModel 读 manifest 注册期快照", () => {
  it("归一规则：cli 声明值优先；cli 未声明缺省 per-window；inproc / 未注册 → shared-service", () => {
    expect(engineProcessModelOfDescriptor(makeCliDescriptor("a", { processModel: "shared-service" })))
      .toBe("shared-service");
    expect(engineProcessModelOfDescriptor(makeCliDescriptor("b", { processModel: "per-window" })))
      .toBe("per-window");
    expect(engineProcessModelOfDescriptor(makeCliDescriptor("c"))).toBe("per-window"); // 缺省
    expect(engineProcessModelOfDescriptor(undefined)).toBe("shared-service"); // 未注册
  });

  it("真实网关下 per-window 引擎解析走窗口实例（创建登记 + 窗口内复用），收尾释放后 respawn", () => {
    const ports: FakeWindowEnginePort[] = [];
    registerEngineDescriptor("pw", makeCliDescriptor("pw", { ports }));
    const runId = "wf-gateway-real";
    // processModelOf（生产网关）读 descriptor 快照 → per-window → createPort 创建登记
    const first = resolveWorkflowWindowEnginePort(runId, "pw");
    const second = resolveWorkflowWindowEnginePort(runId, "pw");
    expect(first).toBe(second);
    expect(ports).toHaveLength(1); // 窗口内恰一次创建（复用，零 registry singletons 触达）
    expect(workflowWindowEngineState(runId).ports.get("pw")).toBe(first);

    // 窗口收尾 dispose 后再解析 = respawn（新实例，新代码通道同构）
    return disposeWorkflowWindowEngineState(runId, "test", "gateway-real").then(async () => {
      expect(ports[0]!.disposed).toBe(1);
      const respawned = resolveWorkflowWindowEnginePort(runId, "pw");
      expect(respawned).not.toBe(first);
      expect(ports).toHaveLength(2);
    });
  });

  it("真实网关下 shared-service 声明引擎透传 registry 单例（zcode 保形）；未注册 id → EngineNotFoundError", () => {
    const sharedPort = new FakeWindowEnginePort("zcode-like");
    registerEngineDescriptor("zcode-like", {
      kind: "cli",
      command: "/bin/fake-zcode-like",
      args: [],
      capabilities: fakeCapabilities(),
      portFactory: () => sharedPort,
      manifest: { processModel: "shared-service" },
      packageVersion: "1.0.0",
    });
    const runId = "wf-gateway-shared";
    expect(resolveWorkflowWindowEnginePort(runId, "zcode-like")).toBe(sharedPort);
    expect(resolveWorkflowWindowEnginePort(runId, "zcode-like")).toBe(sharedPort);
    // shared-service 不进窗口表（登记 no-op）
    expect(workflowWindowEngineState(runId).instances.get("zcode-like")).toBeUndefined();

    expect(hasEngine("ghost")).toBe(false);
    expect(getEngineDescriptor("ghost")).toBeUndefined();
    expect(() => resolveWorkflowWindowEnginePort(runId, "ghost")).toThrowError(/engine_not_found/);
  });
});
