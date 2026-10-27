// src/execution/engine/__tests__/registry-window-model.test.ts
//
// [U5 pi-workflow-run-resource-model] registry D6 改造 + routing 网关真实化单测
//（impl-plan u5 验收 3/4；fake port，不拉真实进程）：
//   1. per-window 引擎不进 singletons：getEngine 返回同步只读代理（capabilities /
//      listModels / validateModel 直读 manifest 注册期快照——同步只读 3 处调用点零改动
//      兼容）；连接级成员（probe/run/read/dispose）fail-fast 抛 WindowScopeEngineError
//      并指路窗口实例解析；
//   2. validateModel 的「catalog 省略 = 成员摘除」形态经代理保形；
//   3. registry 覆盖重注册（引擎包升级换新代码）→ 活窗口旧实例 dispose + 窗口后续
//      解析用新 descriptor 重建实例（D6 末句待实施要求）；等价重注册不触发；
//   4. 网关真实化：processModelOf 读 descriptor manifest 声明（缺省 per-window /
//      inproc 与未注册 → shared-service）；per-window 解析经生产网关创建登记窗口
//      实例、窗口内复用、收尾释放后 respawn。
// 权威源：技术设计 §3.3 决策 6（D6）+ §5 U5 + ADR-0079。
// 整合来源（round 5-g 测试提速）：routing.test.ts（路由三层 + 探针编排单测，
// 纯注入件不触全局 registry，与本体零 mock 冲突）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearEngines,
  DEFAULT_ENGINE_ID,
  engineProcessModelOfDescriptor,
  EngineNotFoundError,
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
  resolveEngineRouting,
  resolveWorkflowWindowEnginePort,
  resetWorkflowWindowEngineStatesForTest,
  routeEngine,
  routeEngineForHost,
  workflowWindowEngineState,
  type EngineRouteOptions,
  type EngineRouteResult,
  type HostRouteOptions,
} from "../routing.ts";
import { EngineError } from "../common/errors.ts";
import type {
  EngineCapabilities,
  ProbeReport,
  SessionView,
} from "../types.ts";
import type { EnginePort, EngineRunResult, RunContext } from "../port.ts";
import type { AgentOutcome } from "@zhushanwen/subagent-engine-sdk";
import type { AgentCallOpts } from "../../../shared/agent-call-types.ts";

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

// ── D6：getEngine 二分 ──────────────────────────────────────

describe("registry D6：per-window 引擎不进 singletons，getEngine 返回同步只读代理", () => {

  beforeEach(() => {
    resetWorkflowWindowEngineStatesForTest();
    clearEngines();
  });

  afterEach(() => {
    resetWorkflowWindowEngineStatesForTest();
    clearEngines();
    vi.restoreAllMocks();
  });
  it("验收④a：per-window 引擎 getEngine → 代理同步只读直答（capabilities/listModels/validateModel 转发底层快照侧），不抛不连", () => {
    registerEngineDescriptor("pw", makeCliDescriptor("pw", {
      modelCatalog: { dynamic: false, models: [{ id: "only-model" }] },
    }));
    const engine = getEngine("pw");
    expect(engine.capabilities().conversation).toBe("native");
    // 「直读 manifest 快照」的成员实现语义由 remote-engine.test.ts 同步成员形态映射
    // describe 承载；本用例锁定代理对同步只读成员的转发透明性（调用点零改动兼容）。
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
    expect(a).toBe(b); // 代理实现缓存（纯快照读侧）

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

  beforeEach(() => {
    resetWorkflowWindowEngineStatesForTest();
    clearEngines();
  });

  afterEach(() => {
    resetWorkflowWindowEngineStatesForTest();
    clearEngines();
    vi.restoreAllMocks();
  });
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
    await vi.waitFor(() => expect(portsV1[0]!.disposed).toBe(1), { interval: 1 });

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

  beforeEach(() => {
    resetWorkflowWindowEngineStatesForTest();
    clearEngines();
  });

  afterEach(() => {
    resetWorkflowWindowEngineStatesForTest();
    clearEngines();
    vi.restoreAllMocks();
  });
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
// routing.test.ts —— 配置路由三层 + 探针编排的单测（fake probe/getEngine 注入，
// 不依赖真机引擎与真实探针）。核心口径：三层任一指定了引擎就按它执行，不可用即
// 结构化错误失败——不换引擎。

/** 最小可运行假引擎（probe 结果可注入）。 */
function makeFakeEngine(id: string, probeOk: boolean): EnginePort {
  return {
    id,
    capabilities: () => ({
      schemaEnforcement: "emulated",
      steer: "unsupported",
      conversation: "unsupported",
      personaInjection: "prompt",
      eventGranularity: "coarse",
      sandbox: "none",
      sessionRead: "outcome-only",
      resume: "cold",
      interrupt: "kill-only",
      permissionMode: "native",
      maxTurns: false,
    }),
    probe: () =>
      Promise.resolve(
        probeOk
          ? { ok: true, engineVersion: "1.0.0", checks: [{ name: "stub", ok: true }] }
          : {
              ok: false,
              engineVersion: "",
              checks: [{ name: "binary", ok: false, detail: "missing" }],
              error: { code: "engine_probe_failed", recovery: "reinstall the engine binary and retry the probe" },
            } satisfies ProbeReport,
      ),
    run: (_t: AgentCallOpts, _c: RunContext) => Promise.reject(new Error("fake: run not implemented")),
    read: (_h: Parameters<EnginePort["read"]>[0]): Promise<SessionView> =>
      Promise.resolve({ engineId: id, turns: [], source: "outcome-only" }),
  };
}

/** routeEngine 的装配器：注册 {pi:ok, zcode:probeOk} 两引擎。 */
function makeRoute(overrides?: {
  zcodeProbeOk?: boolean;
  routing?: Partial<EngineRouteOptions["routing"]>;
}) {
  const engines = new Map<string, EnginePort>();
  engines.set(DEFAULT_ENGINE_ID, makeFakeEngine("pi", true));
  engines.set("zcode", makeFakeEngine("zcode", overrides?.zcodeProbeOk ?? true));
  const probeCalls: string[] = [];
  const opts: EngineRouteOptions = {
    routing: overrides?.routing ?? {},
    probe: (id) => {
      probeCalls.push(id);
      return engines.get(id)!.probe();
    },
    getEngineFn: (id) => {
      const e = engines.get(id);
      if (e === undefined) throw new EngineNotFoundError(id, [...engines.keys()]);
      return e;
    },
    hasEngineFn: (id) => engines.has(id),
    listEnginesFn: () => [...engines.keys()],
  };
  return { opts, probeCalls, engines };
}

// ── 三层优先级（验收 1）──

describe("resolveEngineRouting：三层优先级", () => {
  it("无任何指定 → 全局缺省 'pi'", () => {
    expect(resolveEngineRouting({})).toEqual({ engineId: "pi", source: "default" });
  });

  it("全局默认引擎指定（config defaultEngine=zcode）→ zcode", () => {
    expect(resolveEngineRouting({ globalDefaultEngine: "zcode" })).toEqual({ engineId: "zcode", source: "default" });
  });

  it("frontmatter 指定 > 全局默认", () => {
    expect(resolveEngineRouting({ agentEngine: "zcode", globalDefaultEngine: "pi" })).toEqual({
      engineId: "zcode",
      source: "frontmatter",
    });
  });

  it("调用参数 > frontmatter > 全局默认（三层全设时调用参数胜）", () => {
    expect(
      resolveEngineRouting({ callEngine: "pi", agentEngine: "zcode", globalDefaultEngine: "zcode" }),
    ).toEqual({ engineId: "pi", source: "call" });
  });

  it("空串视为未指定（AgentCallOpts.engine='' 落下一层）", () => {
    expect(resolveEngineRouting({ callEngine: "", agentEngine: "zcode" })).toEqual({
      engineId: "zcode",
      source: "frontmatter",
    });
  });
});

describe("routeEngine：路由 + 探针编排（不可用即失败，不换引擎）", () => {
  it("缺省 pi：免探（零行为变化口径）直接返回引擎", async () => {
    const { opts, probeCalls, engines } = makeRoute();
    const result = await routeEngine(opts);
    expect(result.engine).toBe(engines.get("pi"));
    expect(result.engineId).toBe("pi");
    expect(probeCalls).toEqual([]); // pi 缺省路径不探（D7 轻量口径）
  });

  it("frontmatter 指定 zcode + probe ok：返回 zcode 引擎（探针恰好一次）", async () => {
    const { opts, probeCalls, engines } = makeRoute({ routing: { agentEngine: "zcode" } });
    const result = await routeEngine(opts);
    expect(result.engine).toBe(engines.get("zcode"));
    expect(result.engineId).toBe("zcode");
    expect(result.source).toBe("frontmatter");
    expect(probeCalls).toEqual(["zcode"]);
  });

  it("调用参数指定 zcode：覆盖 frontmatter 的 pi（透传链 A7）", async () => {
    const { opts } = makeRoute({ routing: { callEngine: "zcode", agentEngine: "pi" } });
    const result = await routeEngine(opts);
    expect(result.engineId).toBe("zcode");
    expect(result.source).toBe("call");
  });

  it("未注册 id（调用参数层）：engine_not_found，文案含注册清单（前置暴露）", async () => {
    const { opts } = makeRoute({ routing: { callEngine: "nonexistent" } });
    await expect(routeEngine(opts)).rejects.toThrowError(EngineNotFoundError);
    await expect(routeEngine(opts)).rejects.toThrowError(/Registered engines: pi, zcode/);
  });

  it("未注册 id（frontmatter 层）：同前置暴露，带上 agent frontmatter 来源定位", async () => {
    const { opts } = makeRoute({ routing: { agentEngine: "gone" } });
    const err = await routeEngine(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineNotFoundError);
    expect((err as Error).message).toContain("frontmatter");
  });

  // ── 探针失败：一律结构化失败（无换引擎分支）──

  it("frontmatter 指定 zcode + probe 失败 → engine_probe_failed（不换引擎、不探第二个引擎）", async () => {
    const { opts, probeCalls } = makeRoute({ zcodeProbeOk: false, routing: { agentEngine: "zcode" } });
    const err = await routeEngine(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("engine_probe_failed");
    expect((err as EngineError).message).toContain("engine 'zcode'");
    expect(probeCalls).toEqual(["zcode"]); // 不试其他引擎
  });

  it("调用参数显式指定 + probe 失败 → engine_probe_failed（显式意图不被改写）", async () => {
    const { opts } = makeRoute({ zcodeProbeOk: false, routing: { callEngine: "zcode" } });
    const err = await routeEngine(opts).catch((e: unknown) => e);
    expect((err as EngineError).code).toBe("engine_probe_failed");
  });

  it("全局默认引擎 probe 失败（defaultEngine=zcode）→ engine_probe_failed（不回落内置 pi）", async () => {
    const { opts } = makeRoute({ zcodeProbeOk: false, routing: { globalDefaultEngine: "zcode" } });
    const err = await routeEngine(opts).catch((e: unknown) => e);
    expect((err as EngineError).code).toBe("engine_probe_failed");
    expect((err as EngineError).message).toContain("engine 'zcode'");
  });

  it("未注册的缺省引擎（已卸载）→ engine_not_found（不回落首个可用引擎）", async () => {
    const { opts } = makeRoute({ routing: { globalDefaultEngine: "gone" } });
    const err = await routeEngine(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineNotFoundError);
    expect((err as Error).message).toContain("gone");
  });

  it("失败文案带逐项检查摘要，恢复指引含「显式换引擎」的出口", async () => {
    const { opts } = makeRoute({ zcodeProbeOk: false, routing: { callEngine: "zcode" } });
    const err = (await routeEngine(opts).catch((e: unknown) => e)) as EngineError;
    expect(err.message).toContain("checks: [binary:FAIL]");
    expect(err.message).toContain("未自动切换引擎");
    expect(err.recovery).toContain("retry the probe");
    expect(err.recovery).toContain("engine:'<id>'");
  });

  it("显式 model 不再改变判定：probe 失败仍是 engine_probe_failed", async () => {
    const { opts } = makeRoute({ zcodeProbeOk: false, routing: { callEngine: "zcode" } });
    const err = await routeEngine(opts).catch((e: unknown) => e);
    expect((err as EngineError).code).toBe("engine_probe_failed");
  });
});

describe("routeEngineForHost：宿主统一路由", () => {
  /** 本地 pi 引擎实例替身（chat 域 = chatPiEngine / workflow 域 = SAR per-session DI）。 */
  function makeLocalPi(): EnginePort {
    return makeFakeEngine("local-pi", true);
  }

  /** 装配 host 路由参数（registry 面复用 makeRoute 的注入件）。 */
  function makeHostRoute(overrides?: Parameters<typeof makeRoute>[0]): {
    hostOpts: HostRouteOptions;
    probeCalls: string[];
    engines: Map<string, EnginePort>;
    piEngine: EnginePort;
  } {
    const { opts, probeCalls, engines } = makeRoute(overrides);
    const piEngine = makeLocalPi();
    const { routing, ...rest } = opts;
    return { hostOpts: { ...rest, routing: routing ?? {}, piEngine }, probeCalls, engines, piEngine };
  }

  it("pi 请求（缺省）：同步短路——返回值不是 Promise（零微任务）且免探", () => {
    const { hostOpts, piEngine, probeCalls } = makeHostRoute();
    const routed = routeEngineForHost(hostOpts);
    expect(routed).not.toBeInstanceOf(Promise);
    const route = routed as EngineRouteResult;
    expect(route.engine).toBe(piEngine); // 本地 pi 实例接管，不经 registry
    expect(route.engineId).toBe("pi");
    expect(route.source).toBe("default");
    expect(probeCalls).toEqual([]);
  });

  it("显式 engine='pi'：同步短路同形（call source 留痕）", () => {
    const { hostOpts, piEngine } = makeHostRoute({ routing: { callEngine: "pi" } });
    const routed = routeEngineForHost(hostOpts);
    expect(routed).not.toBeInstanceOf(Promise);
    const route = routed as EngineRouteResult;
    expect(route.engine).toBe(piEngine);
    expect(route.source).toBe("call");
  });

  it("非 pi 请求（frontmatter zcode + probe ok）：返回 Promise，resolve 经注入获取引擎", async () => {
    const { hostOpts, engines } = makeHostRoute({ routing: { agentEngine: "zcode" } });
    const routed = routeEngineForHost(hostOpts);
    expect(routed).toBeInstanceOf(Promise);
    const route = await routed;
    expect(route.engine).toBe(engines.get("zcode"));
    expect(route.engineId).toBe("zcode");
  });

  it("非 pi 请求 + probe 失败：reject engine_probe_failed（本地 pi 不接管）", async () => {
    const { hostOpts } = makeHostRoute({ zcodeProbeOk: false, routing: { agentEngine: "zcode" } });
    const err = await (routeEngineForHost(hostOpts) as Promise<EngineRouteResult>).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("engine_probe_failed");
  });
});
