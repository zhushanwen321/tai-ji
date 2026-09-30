// routing.test.ts —— 配置路由三层 + 探针编排的单测面（fake probe/getEngine 注入，
// 不依赖真机引擎与真实探针）。核心口径：三层任一指定了引擎就按它执行，不可用即
// 结构化错误失败——不换引擎。

import { describe, expect, it } from "vitest";

import type { EnginePort, RunContext } from "../port.ts";
import { DEFAULT_ENGINE_ID, EngineNotFoundError } from "../registry.ts";
import { EngineError } from "../common/errors.ts";
import type { ProbeReport, SessionView } from "../types.ts";
import type { AgentCallOpts } from "../../../orchestration/models/types.ts";
import { resolveEngineRouting, routeEngine, routeEngineForHost, type EngineRouteOptions, type HostRouteOptions } from "../routing.ts";
import type { EngineRouteResult } from "../routing.ts";

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
