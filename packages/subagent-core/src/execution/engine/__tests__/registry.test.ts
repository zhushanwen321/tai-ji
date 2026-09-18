// src/execution/engine/__tests__/registry.test.ts
//
// registry 专属测试（P1 验收 4）：注册/获取/listEngines/hasEngine/
// 未注册 id 报 engine_not_found（错误文案含已注册清单——错误规格表第 1 行契约）。
// [R1 D6] 追加：重注册先 dispose 旧单例（D6②）+ disposeEngines 收割遍历（D6③）。
// [W3] 追加：EngineDescriptor 双模（inproc 快捷 / cli portFactory 代理透明——
// cli 形态 EnginePort 实例 = W2 RemoteEngine）+ D4 displayName 稳定序 +
// 全不可用 engine_not_found 文案（「未发现任何引擎包」+ 安装指引）。

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi, beforeEach } from "vitest";

import { EngineClient } from "../client/engine-client.ts";
import { RemoteEngine } from "../client/remote-engine.ts";
import type { EnginePort, RunContext } from "../port.ts";
import {
  clearEngines,
  DEFAULT_ENGINE_ID,
  disposeEngines,
  EngineNotFoundError,
  firstAvailableEngineId,
  getEngine,
  hasEngine,
  listEngines,
  listEnginesByDisplayName,
  registerEngine,
  registerEngineDescriptor,
  type EngineManifestSnapshot,
} from "../registry.ts";
import type { SessionView } from "../types.ts";
import type { AgentCallOpts } from "../../../orchestration/models/types.ts";

/** 最小可运行假引擎（完整实现 EnginePort 五面——不 cast，防接口漂移失检）。 */
function makeFakeEngine(id: string): EnginePort {
  return {
    id,
    capabilities: () => ({
      schemaEnforcement: "native",
      steer: "unsupported",
      conversation: "unsupported",
      personaInjection: "prompt",
      eventGranularity: "coarse",
      sandbox: "none",
      sessionRead: "outcome-only",
      resume: "unsupported",
      interrupt: "kill-only",
      permissionMode: "fixed",
      maxTurns: false,
    }),
    probe: () =>
      Promise.resolve({ ok: true, engineVersion: "0.0.0-test", checks: [{ name: "stub", ok: true }] }),
    run: (_task: AgentCallOpts, _ctx: RunContext) =>
      Promise.reject(new Error("fake engine: run not implemented")),
    read: (_handle: Parameters<EnginePort["read"]>[0]): Promise<SessionView> =>
      Promise.resolve({ engineId: id, turns: [], source: "outcome-only" }),
  };
}

describe("engine registry", () => {
  beforeEach(() => {
    // 测试隔离：registry 是进程级全局状态，防用例间工厂/单例泄漏串扰
    clearEngines();
  });

  it("registerEngine + getEngine：按 id 取回引擎实例", () => {
    registerEngine("fake", () => makeFakeEngine("fake"));
    const engine = getEngine("fake");
    expect(engine.id).toBe("fake");
  });

  it("getEngine 惰性单例：同一 id 重复获取返回同一实例（§3.3.1 registry 持 per-engine 单例）", () => {
    let created = 0;
    registerEngine("fake", () => {
      created++;
      return makeFakeEngine("fake");
    });
    const a = getEngine("fake");
    const b = getEngine("fake");
    expect(a).toBe(b);
    expect(created).toBe(1);
  });

  it("registerEngine 覆盖同 id：丢弃旧单例，下次 getEngine 用新工厂重建（幂等重注册）", () => {
    registerEngine("fake", () => makeFakeEngine("fake"));
    const first = getEngine("fake");
    registerEngine("fake", () => makeFakeEngine("fake-v2"));
    const second = getEngine("fake");
    expect(second).not.toBe(first);
    expect(second.id).toBe("fake-v2");
  });

  it("listEngines 返回注册序清单，hasEngine 判注册态（不触发工厂副作用）", () => {
    let created = 0;
    registerEngine("alpha", () => {
      created++;
      return makeFakeEngine("alpha");
    });
    registerEngine("beta", () => makeFakeEngine("beta"));
    expect(listEngines()).toEqual(["alpha", "beta"]);
    expect(hasEngine("alpha")).toBe(true);
    expect(hasEngine("gamma")).toBe(false);
    // hasEngine 不取实例——工厂未执行
    expect(created).toBe(0);
  });

  it("未注册 id → EngineNotFoundError（code=engine_not_found，文案含已注册清单）", () => {
    registerEngine("pi", () => makeFakeEngine("pi"));
    let caught: unknown;
    try {
      getEngine("zcode");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineNotFoundError);
    if (!(caught instanceof EngineNotFoundError)) throw new Error("unreachable");
    expect(caught.code).toBe("engine_not_found");
    expect(caught.engineId).toBe("zcode");
    // 错误规格表第 1 行契约：指向注册表清单 + 配置文件路径
    expect(caught.message).toContain("engine_not_found");
    expect(caught.message).toContain("'zcode'");
    expect(caught.message).toContain("pi");
    expect(caught.message).toContain("frontmatter");
  });

  it("空注册表时未注册 id 错误不崩（清单为 none）", () => {
    expect(() => getEngine("anything")).toThrow(EngineNotFoundError);
    expect(() => getEngine("anything")).toThrow(/\(none\)/);
  });

  it("DEFAULT_ENGINE_ID 缺省为 'pi'（D9：回填期零风险默认）", () => {
    expect(DEFAULT_ENGINE_ID).toBe("pi");
  });

  // ── [R1 D6②] 重注册同名：先 dispose 已实例化的旧单例（防常驻资源泄漏）──

  it("重注册同名：已实例化的旧单例 dispose 被调用一次，新工厂实例生效", () => {
    const dispose = vi.fn(() => Promise.resolve());
    registerEngine("fake", () => ({ ...makeFakeEngine("fake"), dispose }));
    getEngine("fake"); // 实例化旧引擎（未实例化 = 无常驻资源可回收）
    registerEngine("fake", () => makeFakeEngine("fake-v2"));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getEngine("fake").id).toBe("fake-v2");
  });

  it("重注册同名：旧实例 dispose 同步 throw 不阻断替换（best-effort）", () => {
    const dispose = vi.fn(() => {
      throw new Error("dispose boom");
    });
    registerEngine("fake", () => ({ ...makeFakeEngine("fake"), dispose }));
    getEngine("fake");
    expect(() => registerEngine("fake", () => makeFakeEngine("fake-v2"))).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getEngine("fake").id).toBe("fake-v2");
  });

  it("重注册同名：旧实例 dispose 异步 reject 不阻断替换、不产生 unhandledRejection", async () => {
    const dispose = vi.fn(() => Promise.reject(new Error("dispose async boom")));
    registerEngine("fake", () => ({ ...makeFakeEngine("fake"), dispose }));
    getEngine("fake");
    expect(() => registerEngine("fake", () => makeFakeEngine("fake-v2"))).not.toThrow();
    expect(getEngine("fake").id).toBe("fake-v2");
    // flush macrotask：reject 必须已被 registry 侧 catch 吞掉——否则 vitest 以
    // unhandledRejection 判本文件失败，用例即失效
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("重注册同名：旧引擎仅注册工厂未实例化时不触发 dispose（惰性单例无资源）", () => {
    const dispose = vi.fn(() => Promise.resolve());
    registerEngine("fake", () => ({ ...makeFakeEngine("fake"), dispose }));
    // 不 getEngine——singletons 无记录
    registerEngine("fake", () => makeFakeEngine("fake-v2"));
    expect(dispose).not.toHaveBeenCalled();
  });

  it("重注册同名：旧实例未实现 dispose（可选成员）时直接替换不抛", () => {
    registerEngine("fake", () => makeFakeEngine("fake"));
    getEngine("fake");
    expect(() => registerEngine("fake", () => makeFakeEngine("fake-v2"))).not.toThrow();
  });

  // ── [R1 D6③] disposeEngines：宿主收割（killAllSpawnedChildren）前的触发遍历 ──

  describe("disposeEngines（D6③）", () => {
    it("只对已实例化的引擎触发 dispose（绝不实例化未用引擎）", () => {
      const instantiated = vi.fn(() => Promise.resolve());
      const neverInstantiated = vi.fn(() => Promise.resolve());
      registerEngine("used", () => ({ ...makeFakeEngine("used"), dispose: instantiated }));
      registerEngine("unused", () => ({ ...makeFakeEngine("unused"), dispose: neverInstantiated }));
      getEngine("used");
      disposeEngines();
      expect(instantiated).toHaveBeenCalledTimes(1);
      expect(neverInstantiated).not.toHaveBeenCalled();
    });

    it("未实现 dispose 的引擎（可选面）跳过不抛", () => {
      registerEngine("plain", () => makeFakeEngine("plain"));
      getEngine("plain");
      expect(() => disposeEngines()).not.toThrow();
    });

    it("dispose 幂等（实现承诺）：disposeEngines 重复调用不抛、逐次触发", async () => {
      const dispose = vi.fn(() => Promise.resolve());
      registerEngine("fake", () => ({ ...makeFakeEngine("fake"), dispose }));
      getEngine("fake");
      expect(() => disposeEngines()).not.toThrow();
      expect(() => disposeEngines()).not.toThrow();
      // 幂等语义由引擎实现承诺（不变量 4），本断言只验证 registry 重复触发不抛
      expect(dispose).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    it("dispose 后单例保留（run 自动重建归引擎承诺，registry 不删——不变量 4 边界）", () => {
      const dispose = vi.fn(() => Promise.resolve());
      registerEngine("fake", () => ({ ...makeFakeEngine("fake"), dispose }));
      const engine = getEngine("fake");
      disposeEngines();
      expect(getEngine("fake")).toBe(engine);
    });
  });
});

// ============================================================
// [W3] EngineDescriptor 双模 + manifest 快照 + D4（impl-plan §2.3）
// ============================================================

/** cli 形态 manifest 快照样本（与 RemoteEngineManifestSnapshot 结构闭包的运行时互证载体）。 */
function makeManifestSnapshot(displayName?: string): EngineManifestSnapshot {
  return {
    capabilities: {
      schemaEnforcement: "emulated",
      steer: "unsupported",
      conversation: "unsupported",
      personaInjection: "prompt",
      eventGranularity: "stream",
      sandbox: "emulated",
      sessionRead: "full",
      resume: "cold",
      interrupt: "kill-only",
      permissionMode: "fixed",
      maxTurns: false,
    },
    modelCatalog: { dynamic: true, models: [{ id: "glm-4.6", canonicalRef: "zai/glm-4.6" }] },
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

/** W2 真实 cli 形态 port 装配（构造同步、不 spawn——ensureConnected 才 spawn）。 */
function makeRemoteEngine(id: string, manifest: EngineManifestSnapshot): RemoteEngine {
  const client = new EngineClient({
    engineId: id,
    command: process.execPath,
    args: ["-e", ""],
    hostKind: "test",
    dataDir: join(tmpdir(), `registry-w3-${id}`),
    manifestDiagnostics: { capabilities: manifest.capabilities, models: manifest.modelCatalog?.models ?? null },
  });
  return new RemoteEngine({
    engineId: id,
    client,
    manifest: { capabilities: manifest.capabilities, modelCatalog: manifest.modelCatalog },
    dataDir: join(tmpdir(), `registry-w3-${id}`),
    hostKind: "test",
  });
}

describe("EngineDescriptor 双模（W3 D1）", () => {
  beforeEach(() => {
    clearEngines();
  });

  it("registerEngine = inproc 快捷：descriptor kind=inproc，getEngine 透明（既有工厂语义不变）", () => {
    registerEngine("fake", () => makeFakeEngine("fake"));
    const engine = getEngine("fake");
    expect(engine.id).toBe("fake");
    expect(hasEngine("fake")).toBe(true);
    expect(listEngines()).toEqual(["fake"]);
  });

  it("cli descriptor：getEngine 返回 portFactory 产物，两形态透明（cli 形态实例 = W2 RemoteEngine）", () => {
    const manifest = makeManifestSnapshot();
    const port = makeRemoteEngine("zcode-cli", manifest);
    const portFactory = vi.fn(() => port as EnginePort);
    registerEngineDescriptor("zcode-cli", {
      kind: "cli",
      command: process.execPath,
      args: ["-e", ""],
      capabilities: manifest.capabilities,
      portFactory,
      manifest: { modelCatalog: manifest.modelCatalog, displayName: manifest.displayName },
    });
    const engine = getEngine("zcode-cli");
    // 两形态透明：上层拿到的是同一个 EnginePort 面；cli 实例 = W2 RemoteEngine
    expect(portFactory).toHaveBeenCalledTimes(1);
    expect(engine).toBe(port);
    expect(engine).toBeInstanceOf(RemoteEngine);
    expect(engine.id).toBe("zcode-cli");
    // 同步成员直读 manifest 快照（W2 形态映射经 registry descriptor 快照成立）
    expect(engine.capabilities()).toBe(manifest.capabilities);
  });

  it("cli descriptor 惰性单例：portFactory 首次取用才执行，重复 getEngine 同实例", () => {
    const manifest = makeManifestSnapshot();
    const portFactory = vi.fn(() => makeRemoteEngine("lazy", manifest) as EnginePort);
    registerEngineDescriptor("lazy", {
      kind: "cli",
      command: process.execPath,
      args: [],
      capabilities: manifest.capabilities,
      portFactory,
    });
    // 注册本身不触发 portFactory（descriptor 首次使用才解析——§3.5.3 代理形态）
    expect(portFactory).not.toHaveBeenCalled();
    expect(hasEngine("lazy")).toBe(true);
    const a = getEngine("lazy");
    const b = getEngine("lazy");
    expect(a).toBe(b);
    expect(portFactory).toHaveBeenCalledTimes(1);
  });

  it("cli descriptor 覆盖同 id（标识变化）：旧单例 dispose 触发 + 新 portFactory 重建", () => {
    const manifest = makeManifestSnapshot();
    const dispose = vi.fn(() => Promise.resolve());
    const oldPort = makeRemoteEngine("overwrite", manifest);
    (oldPort as unknown as { dispose: typeof dispose }).dispose = dispose;
    registerEngineDescriptor("overwrite", {
      kind: "cli",
      command: process.execPath,
      args: [],
      capabilities: manifest.capabilities,
      portFactory: () => oldPort as EnginePort,
    });
    getEngine("overwrite");
    const newPort = makeRemoteEngine("overwrite", manifest);
    // capabilities 变化 = 稳定标识不等价（引擎包升级改能力面的最小形态）——D2b 下
    // 只有标识变化才走 dispose 分支，等价重注册见 D2b 专属 describe。
    registerEngineDescriptor("overwrite", {
      kind: "cli",
      command: process.execPath,
      args: [],
      capabilities: { ...manifest.capabilities, maxTurns: true },
      portFactory: () => newPort as EnginePort,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getEngine("overwrite")).toBe(newPort);
  });
});

// ============================================================
// D2b：同稳定标识重注册幂等（不 dispose 已实例化单例）
// ============================================================

describe("D2b：同稳定标识重注册幂等（cli 单例跨 reload 存活）", () => {
  beforeEach(() => {
    clearEngines();
  });

  /** 同稳定标识的第二次注册（portFactory 是新闭包——模拟 discovery 重扫/jiti 重载后 factory 重跑）。 */
  function reregisterEquivalent(
    id: string,
    manifest: EngineManifestSnapshot,
    portFactory: () => EnginePort,
  ): void {
    registerEngineDescriptor(id, {
      kind: "cli",
      command: process.execPath,
      args: [],
      capabilities: manifest.capabilities,
      portFactory,
      ...(manifest.modelCatalog !== undefined || manifest.displayName !== undefined
        ? { manifest: { modelCatalog: manifest.modelCatalog, displayName: manifest.displayName } }
        : {}),
    });
  }

  it("同标识重注册：singleton 引用不变、无 dispose 帧、新 portFactory 不被调用", () => {
    const manifest = makeManifestSnapshot("Stable");
    const dispose = vi.fn(() => Promise.resolve());
    const oldPort = makeRemoteEngine("stable", manifest);
    (oldPort as unknown as { dispose: typeof dispose }).dispose = dispose;
    const firstFactory = vi.fn(() => oldPort as EnginePort);
    reregisterEquivalent("stable", manifest, firstFactory);
    const singleton = getEngine("stable");
    expect(firstFactory).toHaveBeenCalledTimes(1);

    // 重注册：portFactory 是全新闭包（discovery 重扫的常态），稳定标识字段全同
    const secondFactory = vi.fn(() => makeRemoteEngine("stable", manifest) as EnginePort);
    reregisterEquivalent("stable", manifest, secondFactory);

    expect(getEngine("stable")).toBe(singleton); // 单例保留——reload 存活即此语义
    expect(dispose).not.toHaveBeenCalled(); // 无 dispose 帧（杀令 B 已拆）
    expect(secondFactory).not.toHaveBeenCalled(); // 单例在场，新 portFactory 不生效
  });

  it("同标识重注册但 capabilities 变化：触发 dispose（真换引擎，防泄漏语义保留）", () => {
    const manifest = makeManifestSnapshot();
    const dispose = vi.fn(() => Promise.resolve());
    const oldPort = makeRemoteEngine("caps-change", manifest);
    (oldPort as unknown as { dispose: typeof dispose }).dispose = dispose;
    reregisterEquivalent("caps-change", manifest, () => oldPort as EnginePort);
    getEngine("caps-change");

    reregisterEquivalent(
      "caps-change",
      { ...manifest, capabilities: { ...manifest.capabilities, interrupt: "native" } },
      () => makeRemoteEngine("caps-change", manifest) as EnginePort,
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getEngine("caps-change")).not.toBe(oldPort);
  });

  it("同标识重注册但 command 变化：触发 dispose", () => {
    const manifest = makeManifestSnapshot();
    const dispose = vi.fn(() => Promise.resolve());
    const oldPort = makeRemoteEngine("cmd-change", manifest);
    (oldPort as unknown as { dispose: typeof dispose }).dispose = dispose;
    reregisterEquivalent("cmd-change", manifest, () => oldPort as EnginePort);
    getEngine("cmd-change");

    registerEngineDescriptor("cmd-change", {
      kind: "cli",
      command: "/usr/bin/definitely-another-bin",
      args: [],
      capabilities: manifest.capabilities,
      portFactory: () => makeRemoteEngine("cmd-change", manifest) as EnginePort,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getEngine("cmd-change")).not.toBe(oldPort);
  });

  it("同标识重注册但 args 变化：触发 dispose", () => {
    const manifest = makeManifestSnapshot();
    const dispose = vi.fn(() => Promise.resolve());
    const oldPort = makeRemoteEngine("args-change", manifest);
    (oldPort as unknown as { dispose: typeof dispose }).dispose = dispose;
    reregisterEquivalent("args-change", manifest, () => oldPort as EnginePort);
    getEngine("args-change");

    registerEngineDescriptor("args-change", {
      kind: "cli",
      command: process.execPath,
      args: ["--changed"],
      capabilities: manifest.capabilities,
      portFactory: () => makeRemoteEngine("args-change", manifest) as EnginePort,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getEngine("args-change")).not.toBe(oldPort);
  });

  it("同标识重注册但 manifest 版本面变化（modelCatalog）：触发 dispose", () => {
    const manifest = makeManifestSnapshot("Versioned");
    const dispose = vi.fn(() => Promise.resolve());
    const oldPort = makeRemoteEngine("catalog-change", manifest);
    (oldPort as unknown as { dispose: typeof dispose }).dispose = dispose;
    reregisterEquivalent("catalog-change", manifest, () => oldPort as EnginePort);
    getEngine("catalog-change");

    const upgraded: EngineManifestSnapshot = {
      ...manifest,
      modelCatalog: {
        dynamic: true,
        models: [
          { id: "glm-4.6", canonicalRef: "zai/glm-4.6" },
          { id: "glm-5", canonicalRef: "zai/glm-5" }, // 引擎包升级后的新枚举面
        ],
      },
    };
    reregisterEquivalent("catalog-change", upgraded, () => makeRemoteEngine("catalog-change", upgraded) as EnginePort);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getEngine("catalog-change")).not.toBe(oldPort);
  });

  it("同标识重注册但 manifest 版本面变化（displayName）：触发 dispose", () => {
    const manifest = makeManifestSnapshot("Renamed");
    const dispose = vi.fn(() => Promise.resolve());
    const oldPort = makeRemoteEngine("displayname-change", manifest);
    (oldPort as unknown as { dispose: typeof dispose }).dispose = dispose;
    reregisterEquivalent("displayname-change", manifest, () => oldPort as EnginePort);
    getEngine("displayname-change");

    // 仅 displayName 单字段变化，其余字段全同——与 modelCatalog 同一比较式
    // （stableDescriptorKey(manifest)），独立断言防未来比较式拆分时漏防 displayName
    const renamed: EngineManifestSnapshot = {
      ...manifest,
      displayName: "Renamed-v2",
    };
    reregisterEquivalent("displayname-change", renamed, () => makeRemoteEngine("displayname-change", renamed) as EnginePort);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getEngine("displayname-change")).not.toBe(oldPort);
  });

  it("同标识重注册但 kind 变化（inproc → cli）：触发 dispose", () => {
    const manifest = makeManifestSnapshot();
    const dispose = vi.fn(() => Promise.resolve());
    registerEngine("kind-change", () => ({ ...makeFakeEngine("kind-change"), dispose }));
    const inprocSingleton = getEngine("kind-change");

    registerEngineDescriptor("kind-change", {
      kind: "cli",
      command: process.execPath,
      args: [],
      capabilities: manifest.capabilities,
      portFactory: () => makeRemoteEngine("kind-change", manifest) as EnginePort,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getEngine("kind-change")).not.toBe(inprocSingleton);
  });

  // ── O2 版本面（packageVersion 比较字段）──────────────────────────────

  it("同 packageVersion 重注册（其余标识字段全同）：幂等——singleton 保留、无 dispose", () => {
    const manifest = makeManifestSnapshot("Versioned");
    const dispose = vi.fn(() => Promise.resolve());
    const oldPort = makeRemoteEngine("ver-same", manifest);
    (oldPort as unknown as { dispose: typeof dispose }).dispose = dispose;
    registerEngineDescriptor("ver-same", {
      kind: "cli",
      command: process.execPath,
      args: [],
      capabilities: manifest.capabilities,
      packageVersion: "1.2.3",
      portFactory: () => oldPort as EnginePort,
    });
    const singleton = getEngine("ver-same");

    const secondFactory = vi.fn(() => makeRemoteEngine("ver-same", manifest) as EnginePort);
    registerEngineDescriptor("ver-same", {
      kind: "cli",
      command: process.execPath,
      args: [],
      capabilities: manifest.capabilities,
      packageVersion: "1.2.3",
      portFactory: secondFactory,
    });
    expect(getEngine("ver-same")).toBe(singleton);
    expect(dispose).not.toHaveBeenCalled();
    expect(secondFactory).not.toHaveBeenCalled();
  });

  it("packageVersion 变化（bin/capabilities/manifest 碰巧全同）：触发 dispose 换新实例", () => {
    const manifest = makeManifestSnapshot("Versioned");
    const dispose = vi.fn(() => Promise.resolve());
    const oldPort = makeRemoteEngine("ver-change", manifest);
    (oldPort as unknown as { dispose: typeof dispose }).dispose = dispose;
    registerEngineDescriptor("ver-change", {
      kind: "cli",
      command: process.execPath,
      args: [],
      capabilities: manifest.capabilities,
      packageVersion: "1.2.3",
      portFactory: () => oldPort as EnginePort,
    });
    getEngine("ver-change");

    // 引擎包升级形态：bin 未变、能力面碰巧未变，只有版本号前进——旧实现
    //（版本不在比较面）会误判等价保留旧单例，同进程内持续跑旧代码直到重启
    const newPort = makeRemoteEngine("ver-change", manifest);
    registerEngineDescriptor("ver-change", {
      kind: "cli",
      command: process.execPath,
      args: [],
      capabilities: manifest.capabilities,
      packageVersion: "1.3.0",
      portFactory: () => newPort as EnginePort,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getEngine("ver-change")).toBe(newPort);
  });

  it("packageVersion 两侧均缺省（L3 显式配置形态）：视为等价（undefined === undefined）", () => {
    const manifest = makeManifestSnapshot("Explicit");
    const dispose = vi.fn(() => Promise.resolve());
    const oldPort = makeRemoteEngine("ver-absent", manifest);
    (oldPort as unknown as { dispose: typeof dispose }).dispose = dispose;
    reregisterEquivalent("ver-absent", manifest, () => oldPort as EnginePort);
    const singleton = getEngine("ver-absent");

    reregisterEquivalent("ver-absent", manifest, () => makeRemoteEngine("ver-absent", manifest) as EnginePort);
    expect(getEngine("ver-absent")).toBe(singleton);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("inproc → inproc 重注册：恒判不等价（工厂闭包捕获宿主模块图状态，不可跨 reload 存活）", () => {
    const dispose = vi.fn(() => Promise.resolve());
    registerEngine("inproc-again", () => ({ ...makeFakeEngine("inproc-again"), dispose }));
    getEngine("inproc-again");
    registerEngine("inproc-again", () => makeFakeEngine("inproc-again-v2"));
    expect(dispose).toHaveBeenCalledTimes(1); // 现状语义保留
    expect(getEngine("inproc-again").id).toBe("inproc-again-v2");
  });

  it("等价重注册后宿主收割仍可达：disposeEngines 照常 dispose 存活单例", () => {
    const manifest = makeManifestSnapshot("Harvest");
    const dispose = vi.fn(() => Promise.resolve());
    const port = makeRemoteEngine("harvest", manifest);
    (port as unknown as { dispose: typeof dispose }).dispose = dispose;
    reregisterEquivalent("harvest", manifest, () => port as EnginePort);
    getEngine("harvest");
    reregisterEquivalent("harvest", manifest, () => port as EnginePort); // 等价重注册
    disposeEngines(); // 宿主停机收割不受 D2b 影响（D6③ 语义不变）
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("D4：displayName 稳定序与首个可用引擎（W3）", () => {
  beforeEach(() => {
    clearEngines();
  });

  it("listEnginesByDisplayName：displayName 排序（码点序），缺省 = id，displayName 相同按 id 决胜", () => {
    // 注册序故意与 displayName 序不同——排序键是 manifest displayName 而非注册序
    registerEngineDescriptor("beta", {
      kind: "cli",
      command: process.execPath,
      args: [],
      capabilities: makeManifestSnapshot("Zulu").capabilities,
      portFactory: () => makeFakeEngine("beta"),
      manifest: { displayName: "Zulu" },
    });
    registerEngine("alpha", () => makeFakeEngine("alpha")); // inproc 无 manifest → displayName = id
    registerEngineDescriptor("gamma", {
      kind: "cli",
      command: process.execPath,
      args: [],
      capabilities: makeManifestSnapshot().capabilities,
      portFactory: () => makeFakeEngine("gamma"),
      // 无 displayName → 缺省 = id
    });
    registerEngineDescriptor("delta", {
      kind: "cli",
      command: process.execPath,
      args: [],
      capabilities: makeManifestSnapshot("Zulu").capabilities,
      portFactory: () => makeFakeEngine("delta"),
      manifest: { displayName: "Zulu" },
    });
    // 码点序：'Z'(0x5A) < 'a'(0x61) —— displayName "Zulu" 组（beta/delta，组内按 id
    // 决胜 beta < delta）排在 "alpha"/"gamma" 之前
    expect(listEnginesByDisplayName()).toEqual(["beta", "delta", "alpha", "gamma"]);
  });

  it("firstAvailableEngineId：清单第一项；空注册表 undefined（调用方转 engine_not_found）", () => {
    expect(firstAvailableEngineId()).toBeUndefined();
    registerEngineDescriptor("zcode", {
      kind: "cli",
      command: process.execPath,
      args: [],
      capabilities: makeManifestSnapshot("ZCode").capabilities,
      portFactory: () => makeFakeEngine("zcode"),
      manifest: { displayName: "ZCode" },
    });
    registerEngine("pi", () => makeFakeEngine("pi"));
    // 码点序："ZCode"(Z=0x5A) < "pi"(p=0x70)——displayName 序与 id 序不同向正是本用例点
    expect(firstAvailableEngineId()).toBe("zcode");
  });
});

describe("engine_not_found 空清单文案（W3 D4：未发现任何引擎包）", () => {
  it("registered 为空：文案含「No engine packages were discovered」+ 安装指引", () => {
    const err = new EngineNotFoundError("pi", []);
    expect(err.code).toBe("engine_not_found");
    expect(err.message).toContain("No engine packages were discovered");
    expect(err.message).toContain("TAIJI_AGENT_ENGINE_ROOTS");
    expect(err.message).toContain("(none)");
  });

  it("registered 非空：维持既有恢复指引（frontmatter / 默认引擎设置修 typo）", () => {
    const err = new EngineNotFoundError("ghost", ["pi", "zcode"]);
    expect(err.message).toContain("frontmatter");
    expect(err.message).not.toContain("No engine packages were discovered");
  });
});
