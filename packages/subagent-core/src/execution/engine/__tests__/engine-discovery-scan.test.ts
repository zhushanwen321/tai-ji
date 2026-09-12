// engine-discovery-scan.test.ts —— [W4] 引擎发现器（impl-plan §2.4 / A4/A12）：
// manifest schema 字段级正反例、三级搜索路径、L1 分隔符与非法条目、engines.json 投影
// 合流与幂等零写、同 id 覆盖留痕、bin 不可执行标记、ensureEngineDiscovered 补扫。
//
// 纪律：fixture 一律 mkdtempSync(tmpdir()) 自建自删（禁真实数据目录）；L2 根在用例内
// 显式传 nodeModuleRoots（屏蔽宿主 node_modules 的真实引擎包污染）；env 用注入对象
// （不动 process.env——vitest.setup 净化面之外零残留）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SubagentEnginesFile } from "@xyz-agent/extension-protocol";

import { configureCore, resetCoreForTests } from "../../../core/host-services.ts";
import type { DiscoveryRoot } from "../../../core/host-services.ts";
import { clearEngines, getEngine, hasEngine, listEngines, registerEngine } from "../registry.ts";
import type { EnginePort } from "../port.ts";
import { getEnginesFilePath, syncEnginesFile } from "../engine-discovery.ts";
import {
  ENGINE_ROOTS_ENV,
  deriveNodeModuleRoots,
  discoverAndRegisterEngines,
  ensureEngineDiscovered,
  parseEngineRootsEnv,
  scanEngines,
} from "../engine-discovery-scan.ts";

// ── fixture helpers ─────────────────────────────────────────────

/** 可执行 bin 脚本内容（POSIX shebang；发现器只做 accessSync(X_OK)，不执行）。 */
const BIN_CONTENT = "#!/bin/sh\nexit 0\n";

interface PkgOptions {
  /** bin 文件权限；缺省 0o755（可执行）。0o644 用于「不可执行」反例。 */
  binMode?: number;
  /** bin 文件不落盘（bin 缺失反例）。 */
  omitBin?: boolean;
}

/** 在 rootDir 下造一个带 manifest 的引擎包，返回包目录。 */
function makeEnginePkg(
  rootDir: string,
  pkgDirName: string,
  manifest: Record<string, unknown>,
  opts: PkgOptions = {},
): string {
  const pkgDir = path.join(rootDir, pkgDirName);
  fs.mkdirSync(pkgDir, { recursive: true });
  const binRel = "./bin/cli.mjs";
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: `test-${pkgDirName}`,
      bin: { "test-engine-cli": binRel },
      "xyz-agent": { subagentEngine: { id: pkgDirName, bin: "test-engine-cli", protocol: 1, ...manifest } },
    }),
  );
  if (!opts.omitBin) {
    const binPath = path.join(pkgDir, binRel);
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, BIN_CONTENT);
    fs.chmodSync(binPath, opts.binMode ?? 0o755);
  }
  return pkgDir;
}

/** 收集宿主日志的 HostServices 注入（warn/debug 留痕断言用）。 */
function makeLogCollector(): { logs: Array<{ level: string; message: string }>; host: Parameters<typeof configureCore>[0] } {
  const logs: Array<{ level: string; message: string }> = [];
  const host = {
    dataRoot: () => "/test-data-root",
    log: (level: string, _component: string, message: string) => {
      logs.push({ level, message });
    },
  };
  return { logs, host: host as unknown as Parameters<typeof configureCore>[0] };
}

/** 扫描选项基线：屏蔽 L2（宿主 node_modules 污染）、env 注入（roots 走 L1 env 根）、
 *  数据根走 env。 */
function scanOpts(overrides: {
  env?: Record<string, string | undefined>;
  /** L1 发现根（经 ENGINE_ROOTS_ENV 注入；与 overrides.env 拼接）。 */
  roots?: string[];
  nodeModuleRoots?: string[];
  extraRoots?: DiscoveryRoot[];
  agentDir?: string;
}) {
  const env: Record<string, string | undefined> = {
    XYZ_AGENT_DATA_DIR: "/test-data-dir",
    ...overrides.env,
  };
  if (overrides.roots !== undefined) {
    env[ENGINE_ROOTS_ENV] = overrides.roots.join(path.delimiter);
  }
  return {
    hostKind: "test",
    env,
    nodeModuleRoots: overrides.nodeModuleRoots ?? [],
    ...(overrides.extraRoots !== undefined ? { extraRoots: overrides.extraRoots } : {}),
    ...(overrides.agentDir !== undefined ? { agentDir: overrides.agentDir } : {}),
  };
}

function stubEngine(id: string): EnginePort {
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
      resume: "unsupported",
      interrupt: "kill-only",
      permissionMode: "ignored",
      maxTurns: false,
    }),
    probe: async () => ({ ok: true, engineVersion: "test", checks: [] }),
    run: async () => {
      throw new Error("unused");
    },
    read: async () => ({ engineId: id, turns: [], source: "outcome-only" }),
  };
}

const FULL_CAPABILITIES = {
  schemaEnforcement: "native",
  steer: "native",
  conversation: "native",
  personaInjection: "file",
  eventGranularity: "stream",
  sandbox: "native",
  sessionRead: "full",
  resume: "native",
  interrupt: "native",
  permissionMode: "native",
  maxTurns: true,
};

let tmpRoot: string;
let collectedLogs: Array<{ level: string; message: string }>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "engine-scan-"));
  const collector = makeLogCollector();
  collectedLogs = collector.logs;
  configureCore(collector.host);
});

afterEach(() => {
  resetCoreForTests();
  clearEngines();
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// ── manifest schema 字段级（§2.4）────────────────────────────────

describe("manifest schema 字段级解析", () => {
  it("正例：完整 manifest → discovered，capabilities/modelCatalog/displayName 原样入快照", () => {
    makeEnginePkg(tmpRoot, "foo", {
      displayName: "Foo Engine",
      description: "test engine",
      envPrefixes: ["FOO_"],
      modelCatalog: { dynamic: false, models: [{ id: "m1", aliases: ["one"], canonicalRef: "prov/m1" }] },
      capabilities: FULL_CAPABILITIES,
    });
    const result = scanEngines(scanOpts({ roots: [tmpRoot] }));
    expect(result.discovered).toHaveLength(1);
    const entry = result.discovered[0];
    expect(entry.id).toBe("foo");
    expect(entry.descriptor.kind).toBe("cli");
    expect(entry.descriptor.capabilities).toEqual(FULL_CAPABILITIES);
    expect(entry.descriptor.manifest).toEqual({
      displayName: "Foo Engine",
      modelCatalog: { dynamic: false, models: [{ id: "m1", aliases: ["one"], canonicalRef: "prov/m1" }] },
    });
  });

  it("bin 解析：manifest bin = package.json bin map 的 key → 入口绝对路径", () => {
    makeEnginePkg(tmpRoot, "binmap", { capabilities: FULL_CAPABILITIES });
    const result = scanEngines(scanOpts({ roots: [tmpRoot] }));
    expect(result.discovered[0].descriptor.command).toBe(
      path.join(tmpRoot, "binmap", "bin/cli.mjs"),
    );
  });

  it("必需字段缺失 → skip：id / bin / protocol 各自缺失均不装载", () => {
    for (const key of ["id", "bin", "protocol"]) {
      const manifest: Record<string, unknown> = { capabilities: FULL_CAPABILITIES };
      if (key === "protocol") manifest["protocol"] = undefined;
      else if (key === "bin") manifest["bin"] = undefined;
      else manifest["id"] = undefined;
      makeEnginePkg(tmpRoot, `missing-${key}`, manifest);
    }
    const result = scanEngines(scanOpts({ roots: [tmpRoot] }));
    expect(result.discovered).toHaveLength(0);
    expect(result.skipped).toHaveLength(3);
    for (const key of ["id", "bin", "protocol"]) {
      expect(result.skipped.some((s) => s.reason.includes(key))).toBe(true);
    }
    expect(collectedLogs.filter((l) => l.level === "warn").length).toBeGreaterThanOrEqual(3);
  });

  it("protocol 不兼容（2 越界）→ unusable 不装载；protocol 1 兼容", () => {
    makeEnginePkg(tmpRoot, "future", { protocol: 2, capabilities: FULL_CAPABILITIES });
    const result = scanEngines(scanOpts({ roots: [tmpRoot] }));
    expect(result.discovered).toHaveLength(0);
    expect(result.unusable).toHaveLength(1);
    expect(result.unusable[0].id).toBe("future");
    expect(result.unusable[0].reason).toContain("protocol");
  });

  it("capabilities 缺键取最保守值 + warn；未知键忽略 + warn", () => {
    makeEnginePkg(tmpRoot, "partial-caps", {
      capabilities: { schemaEnforcement: "native", unknownKey: "x" },
    });
    const result = scanEngines(scanOpts({ roots: [tmpRoot] }));
    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].descriptor.capabilities).toEqual({
      schemaEnforcement: "native",
      steer: "unsupported",
      conversation: "unsupported",
      personaInjection: "prompt",
      eventGranularity: "coarse",
      sandbox: "none",
      sessionRead: "outcome-only",
      resume: "unsupported",
      interrupt: "kill-only",
      permissionMode: "ignored",
      maxTurns: false,
    });
    const warns = collectedLogs.filter((l) => l.level === "warn").map((l) => l.message);
    expect(warns.some((m) => m.includes("capabilities.steer missing"))).toBe(true);
    expect(warns.some((m) => m.includes("unknown capabilities key(s) ignored: unknownKey"))).toBe(true);
    // 未知键不进 capabilities（词表封闭）
    expect(Object.keys(result.discovered[0].descriptor.capabilities)).toHaveLength(11);
  });

  it("capabilities 整段缺失 → 全保守 + warn（包仍装载）", () => {
    makeEnginePkg(tmpRoot, "no-caps", {});
    const result = scanEngines(scanOpts({ roots: [tmpRoot] }));
    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].descriptor.capabilities.maxTurns).toBe(false);
    expect(result.discovered[0].descriptor.capabilities.steer).toBe("unsupported");
    expect(collectedLogs.some((l) => l.message.includes("most conservative values"))).toBe(true);
  });

  it("envPrefixes 缺省 []；空串/含 */非法形态/保留前缀 → 丢弃该前缀 + warn，包仍可用", () => {
    makeEnginePkg(tmpRoot, "bad-prefixes", {
      envPrefixes: ["", "HAS*STAR", "BAD-DASH", "XYZ_HOST", "xyz_agent_", "GOOD_", "good_"],
      capabilities: FULL_CAPABILITIES,
    });
    const result = scanEngines(scanOpts({ roots: [tmpRoot] }));
    // 包仍可用（A12②）：装载成功
    expect(result.discovered).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    const warns = collectedLogs.filter((l) => l.level === "warn").map((l) => l.message);
    // 非法形态逐条拒绝（空串 / 含 * / 非法字符）
    expect(warns.filter((m) => m.includes("dropping the prefix")).length).toBeGreaterThanOrEqual(5);
    // 保留前缀大小写不敏感（XYZ_HOST / xyz_agent_ 均拒）
    expect(warns.some((m) => m.includes("reserved host prefix"))).toBe(true);
  });

  it("modelCatalog 三态：缺省不注入（undefined）；null 等价省略；显式数组原样；dynamic 缺省 true", () => {
    makeEnginePkg(tmpRoot, "mc-omitted", { capabilities: FULL_CAPABILITIES });
    makeEnginePkg(tmpRoot, "mc-null", { modelCatalog: null, capabilities: FULL_CAPABILITIES });
    makeEnginePkg(tmpRoot, "mc-explicit", {
      modelCatalog: { models: [{ id: "m1" }] },
      capabilities: FULL_CAPABILITIES,
    });
    makeEnginePkg(tmpRoot, "mc-no-models", { modelCatalog: { dynamic: false }, capabilities: FULL_CAPABILITIES });
    const result = scanEngines(scanOpts({ roots: [tmpRoot] }));
    const manifestOf = (id: string) => result.discovered.find((d) => d.id === id)!.descriptor.manifest!;
    // 缺省 = 不注入（解析器不得把省略填成 models: []——「无枚举面」语义必须可达）
    expect("modelCatalog" in manifestOf("mc-omitted")).toBe(false);
    expect(manifestOf("mc-null").modelCatalog).toBeNull();
    expect(manifestOf("mc-explicit").modelCatalog).toEqual({ dynamic: true, models: [{ id: "m1" }] });
    // models 缺失 = 无有效枚举面 → null（不是 []——[] 是作者显式「有面但空」声明）
    expect(manifestOf("mc-no-models").modelCatalog).toBeNull();
  });

  it("displayName 可选（缺省不入快照，消费面回落 id）；description 仅形态校验", () => {
    makeEnginePkg(tmpRoot, "plain", { capabilities: FULL_CAPABILITIES });
    const result = scanEngines(scanOpts({ roots: [tmpRoot] }));
    expect("displayName" in result.discovered[0].descriptor.manifest!).toBe(false);
  });
});

// ── 三级搜索路径 ─────────────────────────────────────────────────

describe("三级搜索路径", () => {
  it("L1 env 根：多根 + org 分组二层布局都命中", () => {
    makeEnginePkg(path.join(tmpRoot, "r1"), "from-env-root", { capabilities: FULL_CAPABILITIES });
    // org 分组：<root>/@scope/<pkg>/package.json
    makeEnginePkg(path.join(tmpRoot, "r2", "@scope"), "scoped-engine", { capabilities: FULL_CAPABILITIES });
    const result = scanEngines(
      scanOpts({ env: { [ENGINE_ROOTS_ENV]: `${path.join(tmpRoot, "r1")}${path.delimiter}${path.join(tmpRoot, "r2")}` } }),
    );
    expect(result.discovered.map((d) => d.id).sort()).toEqual(["from-env-root", "scoped-engine"]);
  });

  it("L1 宿主根第二通道：HostServices.discoveryRoots().engines 合并扫描", () => {
    makeEnginePkg(path.join(tmpRoot, "hostroot"), "from-host-root", { capabilities: FULL_CAPABILITIES });
    resetCoreForTests();
    const collector = makeLogCollector();
    collectedLogs = collector.logs;
    configureCore({
      ...collector.host,
      discoveryRoots: () => ({ engines: [{ dir: path.join(tmpRoot, "hostroot"), source: "host-npm" }] }),
    } as Parameters<typeof configureCore>[0]);
    const result = scanEngines(scanOpts({}));
    expect(result.discovered.map((d) => d.id)).toEqual(["from-host-root"]);
    expect(result.discovered[0].source).toBe("host-npm");
  });

  it("L2 node 解析根：nodeModuleRoots 注入命中；deriveNodeModuleRoots 沿上溯链收 node_modules", () => {
    makeEnginePkg(path.join(tmpRoot, "nm"), "from-node-modules", { capabilities: FULL_CAPABILITIES });
    const result = scanEngines(scanOpts({ nodeModuleRoots: [path.join(tmpRoot, "nm")] }));
    expect(result.discovered.map((d) => d.id)).toEqual(["from-node-modules"]);

    // deriveNodeModuleRoots：entry 位于 <tmp>/a/b/entry.js，<tmp>/node_modules 存在 → 命中
    fs.mkdirSync(path.join(tmpRoot, "a", "b"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, "node_modules"));
    fs.writeFileSync(path.join(tmpRoot, "a", "b", "entry.js"), "// entry");
    const derived = deriveNodeModuleRoots(path.join(tmpRoot, "a", "b", "entry.js"));
    expect(derived).toContain(path.join(tmpRoot, "node_modules"));
    // 由内向外：更深的 node_modules 在前
    expect(derived.indexOf(path.join(tmpRoot, "node_modules"))).toBeGreaterThan(
      derived.indexOf(path.join(tmpRoot, "a", "node_modules")),
    );
  });

  it("L3 显式配置：enabled:false 不装载（A12⑤）；command 缺失跳过；config 透传 + cwd 透传", () => {
    makeEnginePkg(tmpRoot, "l3-disabled", { capabilities: FULL_CAPABILITIES });
    const agentDir = path.join(tmpRoot, "agent");
    fs.mkdirSync(path.join(agentDir, "subagents"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "subagents", "config.json"),
      JSON.stringify({
        engines: {
          "l3-disabled": { enabled: false, command: "whatever" },
          "l3-broken": { args: [] },
          "l3-ok": {
            command: path.join(tmpRoot, "l3-disabled", "bin/cli.mjs"),
            args: ["--flag"],
            config: { apiKeyHint: "no-secrets-here" },
            cwd: tmpRoot,
          },
        },
      }),
    );
    const result = scanEngines(scanOpts({ agentDir }));
    expect(result.discovered.map((d) => d.id)).toEqual(["l3-ok"]);
    expect(result.discovered[0].engineConfig).toEqual({ apiKeyHint: "no-secrets-here" });
    // enabled:false 不进清单也不进 unusable（显式禁用非错误）
    expect(result.discovered.some((d) => d.id === "l3-disabled")).toBe(false);
    expect(result.unusable.some((u) => u.id === "l3-disabled")).toBe(false);
    // command 缺失条目：warn 跳过（readExplicitEngines 丢弃，不影响其他条目）
    expect(
      collectedLogs.some((l) => l.message.includes("engines.l3-broken.command is required")),
    ).toBe(true);
  });

  it("L3 裸命令名经 PATH 解析；解析失败 → unusable 不进清单（投影 = 已发现且可执行）", () => {
    const binDir = path.join(tmpRoot, "pathbin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "l3-on-path"), BIN_CONTENT);
    fs.chmodSync(path.join(binDir, "l3-on-path"), 0o755);
    const agentDir = path.join(tmpRoot, "agent");
    fs.mkdirSync(path.join(agentDir, "subagents"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "subagents", "config.json"),
      JSON.stringify({
        engines: {
          "l3-path": { command: "l3-on-path" },
          "l3-ghost": { command: "definitely-not-on-path-xyz" },
        },
      }),
    );
    const result = scanEngines(
      scanOpts({ agentDir, env: { PATH: binDir } }),
    );
    expect(result.discovered.map((d) => d.id)).toEqual(["l3-path"]);
    expect(result.discovered[0].descriptor.command).toBe(path.join(binDir, "l3-on-path"));
    expect(result.unusable).toHaveLength(1);
    expect(result.unusable[0].id).toBe("l3-ghost");
  });
});

// ── L1 env 解析（分隔符 / 非法条目 / 去重）───────────────────────

describe("XYZ_AGENT_ENGINE_ROOTS env 解析", () => {
  it("path.delimiter 分隔；空段跳过；非绝对路径丢弃 + warn；去重（大小写敏感）", () => {
    const abs1 = path.join(tmpRoot, "a");
    const abs2 = path.join(tmpRoot, "b");
    const env = {
      [ENGINE_ROOTS_ENV]: [abs1, "relative/path", "", abs1, abs2].join(path.delimiter),
    };
    const roots = parseEngineRootsEnv(env);
    expect(roots).toEqual([abs1, abs2]);
    expect(collectedLogs.some((l) => l.message.includes("not an absolute path"))).toBe(true);
  });

  it("env 未设 / 空白 → 空清单（无 warn）", () => {
    expect(parseEngineRootsEnv({})).toEqual([]);
    expect(parseEngineRootsEnv({ [ENGINE_ROOTS_ENV]: "   " })).toEqual([]);
    expect(collectedLogs).toHaveLength(0);
  });
});

// ── 冲突与失败（A12）─────────────────────────────────────────────

describe("冲突与失败", () => {
  it("bin 不存在 → unusable；存在但不可执行（0o644）→ unusable，均不进清单", () => {
    if (process.platform === "win32") {
      // Windows 无 X_OK 语义（accessSync 仅查存在性），不可执行反例只在 POSIX 跑
      makeEnginePkg(tmpRoot, "missing-bin", { capabilities: FULL_CAPABILITIES }, { omitBin: true });
      const result = scanEngines(scanOpts({ roots: [tmpRoot] }));
      expect(result.discovered).toHaveLength(0);
      expect(result.unusable).toHaveLength(1);
      return;
    }
    makeEnginePkg(tmpRoot, "missing-bin", { capabilities: FULL_CAPABILITIES }, { omitBin: true });
    makeEnginePkg(tmpRoot, "not-executable", { capabilities: FULL_CAPABILITIES }, { binMode: 0o644 });
    const result = scanEngines(scanOpts({ roots: [tmpRoot] }));
    expect(result.discovered).toHaveLength(0);
    expect(result.unusable).toHaveLength(2);
    expect(result.unusable.map((u) => u.id).sort()).toEqual(["missing-bin", "not-executable"]);
  });

  it("同 id 覆盖：后发现者胜 + debug 留痕（same-id override）", () => {
    makeEnginePkg(path.join(tmpRoot, "first"), "dup", {
      displayName: "First",
      capabilities: FULL_CAPABILITIES,
    });
    makeEnginePkg(path.join(tmpRoot, "second"), "dup", {
      displayName: "Second",
      capabilities: FULL_CAPABILITIES,
    });
    const result = scanEngines(
      scanOpts({
        env: {
          [ENGINE_ROOTS_ENV]: `${path.join(tmpRoot, "first")}${path.delimiter}${path.join(tmpRoot, "second")}`,
        },
      }),
    );
    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0].descriptor.manifest?.displayName).toBe("Second");
    expect(collectedLogs.some((l) => l.message.includes("same-id override"))).toBe(true);
  });

  it("坏包不阻断其他引擎（A12②）：坏 manifest 与好包共存扫描，好包正常装载", () => {
    // 缺 id 的坏 manifest（makeEnginePkg 的 spread 默认补齐 id，故直写 JSON）
    const brokenDir = path.join(tmpRoot, "broken-id");
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(
      path.join(brokenDir, "package.json"),
      JSON.stringify({ name: "broken", "xyz-agent": { subagentEngine: { bin: "x", protocol: 1 } } }),
    );
    fs.mkdirSync(path.join(tmpRoot, "torn-json"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "torn-json", "package.json"), "{ torn");
    makeEnginePkg(tmpRoot, "healthy", { capabilities: FULL_CAPABILITIES });
    const result = scanEngines(scanOpts({ roots: [tmpRoot] }));
    expect(result.discovered.map((d) => d.id)).toEqual(["healthy"]);
    expect(result.skipped.length).toBeGreaterThanOrEqual(2);
  });
});

// ── 装载与投影 ───────────────────────────────────────────────────

describe("装载与注册表", () => {
  it("discoverAndRegisterEngines 装载 cli descriptor：hasEngine true、getEngine 返回 id 命中的 port（构造同步不 spawn）", () => {
    makeEnginePkg(tmpRoot, "loaded", { displayName: "Loaded", capabilities: FULL_CAPABILITIES });
    makeEnginePkg(tmpRoot, "loaded-catalog", {
      capabilities: FULL_CAPABILITIES,
      modelCatalog: { models: [{ id: "m1" }] },
    });
    discoverAndRegisterEngines(scanOpts({ roots: [tmpRoot] }));
    expect(hasEngine("loaded")).toBe(true);
    const port = getEngine("loaded");
    expect(port.id).toBe("loaded");
    // 同步成员直读 manifest 快照（W2 RemoteEngine 形态）：无 modelCatalog →
    // listModels 返回 null（无枚举面）、validateModel 成员不实现（构造器摘除）
    expect(port.listModels?.()).toBeNull();
    expect(typeof port.validateModel).toBe("undefined");
    // 显式 modelCatalog → listModels 返回数组（有枚举面）
    const portWithCatalog = getEngine("loaded-catalog");
    expect(portWithCatalog.listModels?.()).toEqual([{ id: "m1" }]);
  });

  it("ensureEngineDiscovered：快照命中零扫描；未命中补扫一次后装载", () => {
    makeEnginePkg(tmpRoot, "rescan", { capabilities: FULL_CAPABILITIES });
    const opts = scanOpts({ roots: [tmpRoot] });
    // 未装载：miss → 补扫 → true
    expect(ensureEngineDiscovered("rescan", opts)).toBe(true);
    expect(hasEngine("rescan")).toBe(true);
    // 快照命中：直接 true（再次调用安全）
    expect(ensureEngineDiscovered("rescan", opts)).toBe(true);
    // 确实不存在的 id：补扫后仍 false
    expect(ensureEngineDiscovered("ghost", opts)).toBe(false);
  });

  it("engines.json 投影合流：发现 cli ∪ inproc 注册；幂等零写；契约 {v:1, engines} 不变", () => {
    makeEnginePkg(tmpRoot, "projected", { capabilities: FULL_CAPABILITIES });
    registerEngine("pi", () => stubEngine("pi"));
    // syncEnginesFile 读 process.env（生产语义）——L1 根经真实 env 注入，afterEach 恢复
    const prevRoots = process.env[ENGINE_ROOTS_ENV];
    process.env[ENGINE_ROOTS_ENV] = tmpRoot;
    try {
      const agentDir = path.join(tmpRoot, "agent");
      syncEnginesFile(agentDir);
      const filePath = getEnginesFilePath(agentDir);
      const file = JSON.parse(fs.readFileSync(filePath, "utf8")) as SubagentEnginesFile;
      expect(file.v).toBe(1);
      expect(file.engines.sort()).toEqual(["pi", "projected"]);
      expect(typeof file.updatedAt).toBe("number");

      // 幂等零写（内容不变 mtime 不动）
      const statAfterFirst = fs.statSync(filePath);
      syncEnginesFile(agentDir);
      expect(fs.statSync(filePath).mtimeMs).toBe(statAfterFirst.mtimeMs);

      // 发现面变化（新增引擎包）触发重写
      makeEnginePkg(tmpRoot, "second-projected", { capabilities: FULL_CAPABILITIES });
      syncEnginesFile(agentDir);
      const updated = JSON.parse(fs.readFileSync(filePath, "utf8")) as SubagentEnginesFile;
      expect(updated.engines.sort()).toEqual(["pi", "projected", "second-projected"]);
    } finally {
      if (prevRoots === undefined) delete process.env[ENGINE_ROOTS_ENV];
      else process.env[ENGINE_ROOTS_ENV] = prevRoots;
    }
  });

  it("syncEnginesFile fail-safe：发现异常不阻塞投影（发现根全部不存在时仍写 inproc 清单）", () => {
    registerEngine("pi", () => stubEngine("pi"));
    const agentDir = path.join(tmpRoot, "agent");
    syncEnginesFile(agentDir);
    const file = JSON.parse(fs.readFileSync(getEnginesFilePath(agentDir), "utf8")) as SubagentEnginesFile;
    expect(file.engines).toEqual(["pi"]);
  });

  it("零发现零注册时投影空清单（W11 删 inproc 后的终态语义预演）", () => {
    const agentDir = path.join(tmpRoot, "agent");
    syncEnginesFile(agentDir);
    const file = JSON.parse(fs.readFileSync(getEnginesFilePath(agentDir), "utf8")) as SubagentEnginesFile;
    expect(file.engines).toEqual([]);
    expect(listEngines()).toEqual([]);
  });
});
