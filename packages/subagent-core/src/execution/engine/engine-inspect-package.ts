// src/execution/engine/engine-inspect-package.ts
//
// [W4] 单引擎包检查管线（engine-discovery-scan.ts 拆出——max-lines 纪律 + 职责域
// 独立）：读 package.json → manifest 字段级解析 → bin 可执行验证 → cli descriptor
// 装配。纯「候选包目录 → 三态检查产物」，无搜索路径/装载状态（留在 discovery-scan）。
// 设计权威源：docs/architecture/subagent-engine-protocolization.md §3.4 + impl-plan §2.4。

import * as fs from "node:fs";
import * as path from "node:path";

import { isProtocolVersionCompatible, type ModelCatalogEntry } from "@zhushanwen/subagent-engine-sdk";

import {
  describeValue,
  parseCapabilities,
  parseEnvPrefixes,
  parseModelCatalog,
  resolveManifestBin,
} from "./engine-manifest.ts";

import { getLogger } from "../../core/logger.ts";
import { getEngineDataDir } from "./common/data-dir.ts";
import { EngineClient } from "./client/engine-client.ts";
import { RemoteEngine, type RemoteEngineManifestSnapshot } from "./client/remote-engine.ts";
import type { CliEngineDescriptor } from "./registry.ts";
import { getHostUiRequestEndpoint } from "./host/host-ui-endpoint.ts";
import type { EngineCapabilities } from "./types.ts";

const logger = getLogger("subagents");

/** 单个引擎包的检查产物。 */
export type PackageInspection =
  | { status: "ok"; entry: DiscoveredEngine }
  | { status: "skip"; reason: string }
  | { status: "unusable"; id: string | undefined; reason: string };

/** 发现成功的引擎条目（装载序；同 id 后者覆盖前者）。 */
export interface DiscoveredEngine {
  id: string;
  /** 发现源标签（env 名 / 宿主根 source / node-modules / config.json）。 */
  source: string;
  /** L3 显式 config（initialize.engineConfig 透传；L1/L2 manifest 发现无此项）。 */
  engineConfig?: Record<string, string>;
  descriptor: CliEngineDescriptor;
}

/** 检查管线中间步的失败产物（skip/unusable；ok 只由主管线终点产出）。 */
type ManifestInspectionFailure = Extract<PackageInspection, { status: "skip" | "unusable" }>;

/** 读 + JSON 解析 package.json（不可读/坏 JSON/非对象 → skip）。 */
function readEnginePackageJson(pkgDir: string): { pkg: Record<string, unknown> } | ManifestInspectionFailure {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(pkgDir, "package.json"), "utf8");
  } catch (err) {
    return { status: "skip", reason: `package.json unreadable: ${errorMessage(err)}` };
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    return { status: "skip", reason: `package.json is not valid JSON: ${errorMessage(err)}` };
  }
  if (typeof pkg !== "object" || pkg === null) {
    return { status: "skip", reason: "package.json is not an object" };
  }
  return { pkg: pkg as Record<string, unknown> };
}

/** xyz-agent.subagentEngine manifest 段提取（无段/形态坏 → 各自的 skip reason）。 */
function extractEngineManifest(pkg: Record<string, unknown>): { manifest: Record<string, unknown> } | { skipReason: string } {
  // 无 manifest 段 = 不是引擎包：扫描常态（node_modules 大量无关包），静默跳过不 warn。
  const agentNs = pkg["xyz-agent"];
  if (typeof agentNs !== "object" || agentNs === null) {
    return { skipReason: "no xyz-agent.subagentEngine manifest (not an engine package)" };
  }
  const manifest = (agentNs as Record<string, unknown>)["subagentEngine"];
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return { skipReason: "xyz-agent.subagentEngine is not an object" };
  }
  return { manifest: manifest as Record<string, unknown> };
}

// ── 必需字段：id / bin / protocol（缺失或形态坏 → warn 跳过该包）──
function validateRequiredManifestFields(
  m: Record<string, unknown>,
): { id: string; manifestBin: string; protocol: number } | ManifestInspectionFailure {
  const id = m["id"];
  if (typeof id !== "string" || id.trim() === "") {
    return { status: "skip", reason: "manifest id is required (non-empty string)" };
  }
  const manifestBin = m["bin"];
  if (typeof manifestBin !== "string" || manifestBin.trim() === "") {
    return { status: "skip", reason: `engine '${id}': manifest bin is required (non-empty string)` };
  }
  const protocol = m["protocol"];
  if (typeof protocol !== "number" || !Number.isInteger(protocol)) {
    return {
      status: "skip",
      reason: `engine '${id}': manifest protocol is required (integer; got ${describeValue(protocol)})`,
    };
  }
  if (!isProtocolVersionCompatible(protocol)) {
    return {
      status: "unusable",
      id,
      reason:
        `engine '${id}': manifest protocol ${protocol} is not compatible ` +
        `(core supports >=1 <2) — upgrade the engine package or the host core`,
    };
  }
  return { id, manifestBin, protocol };
}

/**
 * bin 解析 + 可执行验证：manifest bin = package.json npm bin 的 key（设计 §3.4 示例
 * 形态）；package.json bin 为字符串时直接作相对路径。解析不出真实入口 = bin 缺失面。
 */
function resolveVerifiedEngineBin(
  pkgDir: string,
  pkg: Record<string, unknown>,
  manifestBin: string,
  id: string,
): { binPath: string } | ManifestInspectionFailure {
  const binPath = resolveManifestBin(pkgDir, pkg, manifestBin);
  if (binPath === undefined) {
    return {
      status: "skip",
      reason: `engine '${id}': manifest bin '${manifestBin}' does not resolve via package.json bin`,
    };
  }
  if (!canExecute(binPath)) {
    return {
      status: "unusable",
      id,
      reason: `engine '${id}': bin not found or not executable: ${binPath}`,
    };
  }
  return { binPath };
}

/**
 * displayName / description（可选；displayName 缺省 = id 由消费面兜底
 * （listEnginesByDisplayName 的 `?? id`），快照只存显式值防「缺省填充」被误读；
 * description 当前无消费面，仅做形态校验）。
 */
function parseOptionalDisplayFields(m: Record<string, unknown>, id: string): string | undefined {
  let displayName: string | undefined;
  const rawDisplayName = m["displayName"];
  if (rawDisplayName !== undefined) {
    if (typeof rawDisplayName === "string" && rawDisplayName.trim() !== "") {
      displayName = rawDisplayName;
    } else {
      logger.warn(`[engine-discovery] engine '${id}': displayName must be a non-empty string — ignoring`);
    }
  }
  const rawDescription = m["description"];
  if (rawDescription !== undefined && typeof rawDescription !== "string") {
    logger.warn(`[engine-discovery] engine '${id}': description must be a string — ignoring`);
  }
  return displayName;
}

/** cli descriptor 装配（portFactory 惰性求值：EngineClient + RemoteEngine）。 */
function buildManifestCliDescriptor(params: {
  id: string;
  binPath: string;
  hostKind: string;
  env: NodeJS.ProcessEnv;
  caps: EngineCapabilities;
  envPrefixes: string[];
  modelCatalog: { dynamic: boolean; models: ModelCatalogEntry[] } | null | undefined;
  displayName: string | undefined;
  manifestSnapshot: RemoteEngineManifestSnapshot;
}): CliEngineDescriptor {
  const { id, binPath, hostKind, env, caps, envPrefixes, modelCatalog, displayName, manifestSnapshot } = params;
  return {
    kind: "cli",
    command: binPath,
    args: [],
    capabilities: caps,
    portFactory: () => {
      // 惰性求值：portFactory 在 getEngine 首次取用时才执行（registry 惰性单例），
      // 那时宿主已 configureCore（或宿主进程 env 已带数据根）——扫描期可能早于
      // configureCore，直接调 getEngineDataDir 会触 core_host_not_configured。
      const dataDir = getEngineDataDir(env);
      const client = new EngineClient({
        engineId: id,
        command: binPath,
        args: [],
        hostKind,
        dataDir,
        envPrefixes,
        // [W6 R3 MF-A] host/askUser 应答端：壳侧登记处在 portFactory 惰性执行期取值
        //（晚于 session_start 注册，未注册 → undefined → 引擎收 {unsupported:true}）。
        uiRequestHandler: getHostUiRequestEndpoint(),
        manifestDiagnostics: {
          capabilities: caps,
          models: modelCatalog === undefined || modelCatalog === null ? null : modelCatalog.models,
        },
      });
      return new RemoteEngine({
        engineId: id,
        client,
        manifest: manifestSnapshot,
        dataDir,
        hostKind,
      });
    },
    manifest: {
      ...(modelCatalog !== undefined ? { modelCatalog } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    },
  };
}

/**
 * 检查单个候选包目录（读 package.json → manifest 字段级解析 → bin 可执行验证）。
 * 三态：ok（装载）/ skip（必需字段缺失/不可解析——warn 跳过该包）/ unusable
 * （protocol 不兼容、bin 不可执行——标记不可用，不进清单）。
 */
export function inspectEnginePackage(
  pkgDir: string,
  source: string,
  hostKind: string,
  env: NodeJS.ProcessEnv,
): PackageInspection {
  const pkgStep = readEnginePackageJson(pkgDir);
  if (!("pkg" in pkgStep)) return pkgStep;
  const manifestStep = extractEngineManifest(pkgStep.pkg);
  if (!("manifest" in manifestStep)) return { status: "skip", reason: manifestStep.skipReason };
  const m = manifestStep.manifest;
  const fields = validateRequiredManifestFields(m);
  if ("reason" in fields) return fields;
  const { id, manifestBin } = fields;
  const binStep = resolveVerifiedEngineBin(pkgDir, pkgStep.pkg, manifestBin, id);
  if (!("binPath" in binStep)) return binStep;

  // ── capabilities（必需；缺键取最保守值 + warn；未知键忽略 + warn）──
  const caps = parseCapabilities(id, m["capabilities"]);

  // ── envPrefixes（可选，缺省 []；非法条目丢弃该前缀 + warn，包仍可用——A12②）──
  const envPrefixes = parseEnvPrefixes(id, m["envPrefixes"]);

  // ── modelCatalog（可选；缺省 = 不注入保持 undefined——解析器不得把省略填成
  //    models: []，否则「无枚举面」语义不可达，RemoteEngine.listModels 会说谎）──
  const modelCatalog = parseModelCatalog(id, m["modelCatalog"]);

  const displayName = parseOptionalDisplayFields(m, id);

  const manifestSnapshot: RemoteEngineManifestSnapshot = {
    capabilities: caps,
    ...(modelCatalog !== undefined ? { modelCatalog } : {}),
  };

  const descriptor = buildManifestCliDescriptor({
    id,
    binPath: binStep.binPath,
    hostKind,
    env,
    caps,
    envPrefixes,
    modelCatalog,
    displayName,
    manifestSnapshot,
  });
  return { status: "ok", entry: { id, source, descriptor } };
}

/** 可执行探测（X_OK；ENOENT/EACCES/平台不支持 → false）。 */
export function canExecute(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
