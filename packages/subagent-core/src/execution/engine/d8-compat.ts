// src/execution/engine/d8-compat.ts
//
// [W8] D8 兼容公共面薄壳（设计 §3.6 D8 表 + impl-plan §2.8）：宿主零改动的机械保证。
// 三个符号的兼容形态：
//   - registerZcodeEngine(engineDataDir) 薄壳：确保 id 'zcode' 的 cli descriptor 已
//     注册，engineDataDir 经合成 env（XYZ_AGENT_DATA_DIR）记入 descriptor portFactory；
//   - createZcodeEngine(deps) → RemoteEngine('zcode')：deps → 协议客户端映射
//     （engineDataDir → dataDir / cliPath → command / processEnv → baseEnv /
//     sources 不跨进程——不变量 5「引擎不落盘宿主数据、自行解析凭据」）；
//   - killAllSpawnedChildren 收敛在 engine/host/spawned-children 公共面（[W3][F-7
//     注释纠偏] 仅镜像记账——core 侧 spawnedChildren 镜像整体置死，不发进程信号；
//     引擎进程回收 = stdin-EOF 自灭链（正常路径）+ disposeEngines() 显式触发
//     cli 引擎 dispose（宿主 shutdown 链预留 API，现无生产接线），非「进程组收割」）。
//
// vendored 定位（设计 §3.6 二选一通道①）：core 相对自身定位
// `<coreDir>/../<engine>-subagent-cli`（与 zsw core-ref.js:15 同款相对解析，零配置）；
// 通道②（宿主注入 XYZ_AGENT_ENGINE_ROOTS）由发现器承载，薄壳在注册表已有 descriptor
// 时直接保留（发现器快照权威）。定位失败（打包态 staging 前 / 引擎包未安装）：
// registerZcodeEngine 回退 inproc 注册（过渡期可用性优先，W11 删 inproc 后该分支
// 一并删除）；createZcodeEngine 返回 command = 期望路径的 RemoteEngine——首次协议
// 调用 engine_crashed 显式报错（不变量 6「失败不静默」，构造同步不 throw，§3.5.3）。
//
// hostKind：registerZcodeEngine 缺省 'pi'（现调用方 = xyz-agent 扩展宿主组合根）；
// createZcodeEngine 恒 'zsw'（消费方 = zsw CLI vendored 形态）——pidfile 实例维度
// 命名段（engine.<hostKind>.<hostPid>.pid），不同宿主进程 pid 不同不互误杀。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { EngineClient } from "./client/engine-client.ts";
import { RemoteEngine, type RemoteEngineManifestSnapshot } from "./client/remote-engine.ts";
import {
  readRelayForwardEnv,
} from "@zhushanwen/subagent-engine-sdk";
import { getEngineDataDir } from "./common/data-dir.ts";
import {
  CONSERVATIVE_CAPABILITIES,
  parseCapabilities,
  parseEnvPrefixes,
  parseModelCatalog,
  resolveManifestBin,
} from "./engine-manifest.ts";
import { inspectEnginePackage } from "./engine-discovery-scan.ts";
import { hasEngine, registerEngineDescriptor, type CliEngineDescriptor } from "./registry.ts";
import type { EngineCapabilities } from "./types.ts";
import type { EnginePort } from "./port.ts";
import type { ModelCatalogEntry } from "@zhushanwen/subagent-engine-sdk";
import { getLogger } from "../../core/logger.ts";

const logger = getLogger("subagents");

/** D8 薄壳服务的引擎 id（设计 §3.6 D8 表硬编码面；不用 engines/zcode/constants 的
 *  ZCODE_ENGINEID——薄壳生命周期跨 W11（inproc 目录删除后薄壳仍在），不绑内部模块）。 */
const D8_ZCODE_ENGINE_ID = "zcode";

/** createZcodeEngine 消费宿主（zsw CLI vendored 形态）——pidfile hostKind 命名段。 */
const D8_ZSW_HOST_KIND = "zsw";

/** registerZcodeEngine 缺省宿主（xyz-agent 扩展宿主组合根是现调用方）。 */
const D8_PI_HOST_KIND = "pi";

/** deps.sources 忽略的 warn-once（跨进程不可达面，重复注册不刷屏）。 */
let warnedSourcesIgnored = false;

/**
 * D8 兼容 deps 形状（zsw runner-core.js:163 实测调用面 {engineDataDir, cliPath?}）。
 * 与 engines/zcode ZcodeEngineDeps 结构兼容：zsw 传入对象可直接赋值；sources /
 * probeVersion 为兼容残留字段——协议形态下不跨进程（忽略 + warn）。
 */
export interface D8CompatZcodeEngineDeps {
  /** 引擎数据根（→ 引擎子进程 env XYZ_AGENT_DATA_DIR，见设计 §3.6 注入矩阵）。 */
  engineDataDir: () => string;
  /** 引擎 CLI 入口覆盖（L3 等价；缺省 = vendored 相对定位）。 */
  cliPath?: string;
  /** 兼容残留：模型来源/凭据路径——不跨进程（不变量 5），忽略。 */
  sources?: unknown;
  /** 兼容残留：版本探测执行器——协议 probe 由引擎实现承担，忽略。 */
  probeVersion?: unknown;
  /** env 基底合并（buildEngineChildEnv baseEnv；缺省 {...process.env}）。 */
  processEnv?: NodeJS.ProcessEnv;
}

/**
 * [W11 收口] 旧 ZcodeEngineDeps 的兼容别名：barrel 原类型导出（zsw 调用面的 deps
 * 形状契约）与 D8CompatZcodeEngineDeps 合并——结构同源（engineDataDir/cliPath/
 * sources/probeVersion/processEnv），别名保留免 zsw 侧机械改名。
 */
export type ZcodeEngineDeps = D8CompatZcodeEngineDeps;

/** vendored 引擎包定位结果。 */
interface LocatedEnginePkg {
  pkgDir: string;
  /** manifest bin 解析后的引擎 CLI 入口绝对路径（已过可执行校验）。 */
  binPath: string;
}

/** 引擎包 manifest 的薄壳消费面（capabilities/envPrefixes/modelCatalog 快照）。 */
interface ManifestInfo {
  capabilities: EngineCapabilities;
  envPrefixes: string[];
  modelCatalog?: { dynamic: boolean; models: ModelCatalogEntry[] } | null;
}

// ============================================================
// vendored 定位（通道①）
// ============================================================

/**
 * core 包根目录：本模块文件目录上 3 级（src 与 dist 同构——
 * <pkg>/src/execution/engine/d8-compat.ts 与 <pkg>/dist/execution/engine/d8-compat.js
 * 的 dirname 上 3 级都是包根）。不可得（bundle 进宿主无文件位置语义）→ undefined，
 * 调用方走通道②（宿主注入发现根）或显式 cliPath。
 */
function corePackageDir(): string | undefined {
  let moduleDir: string | undefined;
  try {
    moduleDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    moduleDir = undefined;
  }
  if (moduleDir === undefined && typeof __dirname !== "undefined") {
    moduleDir = __dirname;
  }
  if (moduleDir === undefined) return undefined;
  return path.resolve(moduleDir, "..", "..", "..");
}

/** 引擎包 npm 名（D8 vendored 布局约定 <engineId>-subagent-cli）。 */
function enginePkgName(engineId: string): string {
  return `@zhushanwen/${engineId}-subagent-cli`;
}

/** 期望的 vendored bin 路径（定位失败时 createZcodeEngine 的 command 占位——spawn 时
 *  engine_crashed 显式报错附恢复指引，不留静默）。 */
function expectedVendoredBinPath(engineId: string): string {
  const pkgDir = attemptVendoredPkgDir(engineId);
  return path.join(pkgDir, "bin", `${engineId}-subagent-cli.mjs`);
}

function attemptVendoredPkgDir(engineId: string): string {
  const coreDir = corePackageDir();
  const packagesDir = coreDir !== undefined ? path.dirname(coreDir) : path.resolve("packages");
  return path.join(packagesDir, `${engineId}-subagent-cli`);
}

/**
 * vendored package.json 的 manifest 段原始解析（单一来源，locateVendoredEnginePkg 与
 * readEngineManifest 共用）：读取 pkgDir/package.json 并 duck-typed 三段下降
 * pkg["xyz-agent"]["subagentEngine"]。读文件/JSON 解析失败或 manifest 段缺失/非对象
 * （含 null 与数组）→ undefined。数组拒绝上收到共用守卫对两个调用点均结局等价：
 * JSON.parse 产物为数组时不可能携带字符串键（JSON 语法限制），bin 提取路径对数组取
 * ["bin"] 恒 undefined——与拒绝分支同收敛为定位失败。pkg 一并返回供调用方做 name
 * 精确匹配与 bin 相对路径解析（单次解析，不重复读盘）。
 */
function readSubagentEngineManifestRaw(
  pkgDir: string,
): { pkg: Record<string, unknown>; manifest: Record<string, unknown> } | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
    const agentNs = pkg["xyz-agent"];
    const raw =
      typeof agentNs === "object" && agentNs !== null
        ? (agentNs as Record<string, unknown>)["subagentEngine"]
        : undefined;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    return { pkg, manifest: raw as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/**
 * vendored 相对定位：`<coreDir>/../<engineId>-subagent-cli`。三重校验防同名目录冒充：
 * package.json 可读 + name 精确匹配 + manifest bin 可执行。任一不成立 → undefined
 * （调用方按通道②/显式 cliPath/期望路径降级）。
 */
function locateVendoredEnginePkg(engineId: string): LocatedEnginePkg | undefined {
  const pkgDir = attemptVendoredPkgDir(engineId);
  const parsed = readSubagentEngineManifestRaw(pkgDir);
  if (parsed === undefined) return undefined;
  const { pkg, manifest } = parsed;
  if (pkg["name"] !== enginePkgName(engineId)) return undefined;
  const manifestBin = manifest["bin"];
  if (typeof manifestBin !== "string" || manifestBin.trim() === "") return undefined;
  const binPath = resolveManifestBin(pkgDir, pkg, manifestBin);
  if (binPath === undefined || !canExecute(binPath)) return undefined;
  return { pkgDir, binPath };
}

/** manifest 薄壳消费面解析（复用 W4 engine-manifest 字段级解析器——单源，不复制规则）。 */
function readEngineManifest(pkgDir: string): ManifestInfo | undefined {
  const parsed = readSubagentEngineManifestRaw(pkgDir);
  if (parsed === undefined) return undefined;
  const manifest = parsed.manifest;
  const id = typeof manifest["id"] === "string" ? manifest["id"] : D8_ZCODE_ENGINE_ID;
  const modelCatalog = parseModelCatalog(id, manifest["modelCatalog"]);
  return {
    capabilities: parseCapabilities(id, manifest["capabilities"]),
    envPrefixes: parseEnvPrefixes(id, manifest["envPrefixes"]),
    ...(modelCatalog !== undefined ? { modelCatalog } : {}),
  };
}

function canExecute(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// registerZcodeEngine 薄壳
// ============================================================

/**
 * D8 薄壳：确保 id 'zcode' 的引擎 descriptor 已注册，engineDataDir 记入 descriptor。
 *
 * 注册表已有 descriptor（W4 发现器先装载 / 重复调用）→ 直接保留——发现器 cli
 * descriptor 携带完整 manifest 快照，权威高于薄壳构造。未注册 → vendored 定位构造
 * cli descriptor（经 W4 inspectEnginePackage 全量 manifest 解析；engineDataDir 经
 * 合成 env XYZ_AGENT_DATA_DIR 被 portFactory 捕获——「以显式值为准」）。[W11/DoD#5]
 * 定位/解析失败保持未注册（inproc 回退已删，不变量 6「失败不静默」——派发期
 * engine_not_found 显式报错 + 恢复指引；XYZ_ZCODE_CLI 覆盖通道由 createZcodeEngine
 * 的 deps.cliPath 等价承载）。
 */
export function registerZcodeEngine(engineDataDir: () => string = getEngineDataDir): void {
  const id = D8_ZCODE_ENGINE_ID;
  if (hasEngine(id)) return;
  // [W11/DoD#5] inproc 回退分支已删（不变量 6「失败不静默」）：定位/解析失败保持
  // 未注册——派发期 engine_not_found 显式报错（含「安装/发现引擎包」恢复指引），
  // XYZ_ZCODE_CLI 覆盖通道由 createZcodeEngine 的 deps.cliPath 等价承载。
  const located = locateVendoredEnginePkg(id);
  if (located === undefined) {
    logger.warn(
      `[d8-compat] engine '${id}' vendored package not located (enginePkg ${enginePkgName(id)}); ` +
        "left unregistered — dispatch will fail with engine_not_found + recovery guidance",
    );
    return;
  }
  // 合成 env：显式 engineDataDir 写进 XYZ_AGENT_DATA_DIR，portFactory 闭包经
  // getEngineDataDir(env) 解析即取显式值（W4 inspectEnginePackage 原样复用，零改动）。
  const syntheticEnv: NodeJS.ProcessEnv = { ...process.env, XYZ_AGENT_DATA_DIR: engineDataDir() };
  const inspection = inspectEnginePackage(located.pkgDir, "d8-compat", D8_PI_HOST_KIND, syntheticEnv);
  if (inspection.status !== "ok") {
    logger.warn(
      `[d8-compat] engine '${id}' vendored package inspection failed (${inspection.reason}); ` +
        "left unregistered — dispatch will fail with engine_not_found + recovery guidance",
    );
    return;
  }
  registerEngineDescriptor(id, inspection.entry.descriptor as CliEngineDescriptor);
}

// ============================================================
// createZcodeEngine 薄壳
// ============================================================

/** deps.sources 忽略的 warn-once（跨进程不可达面，重复注册不刷屏）。 */
function warnSourcesIgnoredOnce(deps: D8CompatZcodeEngineDeps): void {
  if (deps.sources === undefined || warnedSourcesIgnored) return;
  warnedSourcesIgnored = true;
  logger.warn(
    "[d8-compat] createZcodeEngine deps.sources is ignored (model/credential sources do not " +
      "cross the process boundary — the engine resolves its own credentials, protocol invariant 5)",
  );
}

/**
 * manifest 薄壳消费面解析 + 回退合成：vendored 包未定位/manifest 不可读 → capabilities
 * 全保守 + envPrefixes 空（gate 同步拦生成，失败显式发生在首次协议调用）。
 */
function resolveManifestInfo(located: LocatedEnginePkg | undefined): ManifestInfo {
  const info = located !== undefined ? readEngineManifest(located.pkgDir) : undefined;
  return {
    capabilities: info?.capabilities ?? { ...CONSERVATIVE_CAPABILITIES },
    envPrefixes: info?.envPrefixes ?? [],
    ...(info?.modelCatalog !== undefined && info.modelCatalog !== null ? { modelCatalog: info.modelCatalog } : {}),
  };
}

/** RemoteEngine manifest 快照：capabilities 恒有；modelCatalog 三态语义（无枚举面不注入）。 */
function buildManifestSnapshot(manifestInfo: ManifestInfo): RemoteEngineManifestSnapshot {
  return {
    capabilities: manifestInfo.capabilities,
    ...(manifestInfo.modelCatalog !== undefined && manifestInfo.modelCatalog !== null
      ? { modelCatalog: manifestInfo.modelCatalog }
      : {}),
  };
}

/** 协议客户端装配（H12 relay 透传 + manifestDiagnostics 诊断快照）。 */
function buildZcodeEngineClient(
  id: string,
  command: string,
  dataDir: string,
  baseEnv: NodeJS.ProcessEnv,
  manifestInfo: ManifestInfo,
): EngineClient {
  return new EngineClient({
    engineId: id,
    command,
    args: [],
    hostKind: D8_ZSW_HOST_KIND,
    dataDir,
    baseEnv,
    envPrefixes: manifestInfo.envPrefixes,
    // H12 relay 透传（zsw 宿主链路）：宿主 env 的 relay 连接三键原样提取走 L0 注入；
    // 身份键 SESSION_ID/RECORD_ID 由 buildEngineChildEnv L1 deny 剥除（引擎按
    // run.params.ctx 重写，不靠 env 继承）。relay 未激活 → undefined → 不注入。
    ...(readRelayForwardEnv(baseEnv) !== undefined ? { relay: readRelayForwardEnv(baseEnv) } : {}),
    manifestDiagnostics: {
      capabilities: manifestInfo.capabilities,
      models:
        manifestInfo.modelCatalog === undefined || manifestInfo.modelCatalog === null
          ? null
          : manifestInfo.modelCatalog.models,
    },
  });
}

/**
 * D8 薄壳：deps → 协议客户端映射，返回 RemoteEngine('zcode')（implements EnginePort，
 * 对 zsw 透传结构兼容）。构造同步、不 throw（§3.5.3 代理形态）——引擎包缺失时
 * command = 期望路径，失败显式发生在首次协议调用（engine_crashed + 恢复指引）。
 */
export function createZcodeEngine(deps: D8CompatZcodeEngineDeps): EnginePort {
  const id = D8_ZCODE_ENGINE_ID;
  warnSourcesIgnoredOnce(deps);
  const dataDir = deps.engineDataDir();
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, ...(deps.processEnv ?? {}) };
  const located = deps.cliPath !== undefined ? undefined : locateVendoredEnginePkg(id);
  const command = deps.cliPath ?? located?.binPath ?? expectedVendoredBinPath(id);
  const manifestInfo = resolveManifestInfo(located);
  const manifestSnapshot = buildManifestSnapshot(manifestInfo);
  const client = buildZcodeEngineClient(id, command, dataDir, baseEnv, manifestInfo);
  return new RemoteEngine({
    engineId: id,
    client,
    manifest: manifestSnapshot,
    dataDir,
    hostKind: D8_ZSW_HOST_KIND,
  });
}
