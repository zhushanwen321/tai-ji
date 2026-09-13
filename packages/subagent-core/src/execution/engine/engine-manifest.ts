// src/execution/engine/engine-manifest.ts
//
// [W4] 引擎包 manifest 字段级解析（package.json `xyz-agent.subagentEngine` 段）。
// 设计权威源：docs/architecture/subagent-engine-protocolization.md §3.4 + impl-plan §2.4。
//
// 自 engine-discovery-scan.ts 拆出（max-lines 纪律）：manifest 解析是纯「unknown →
// 强类型」的字段级校验域，与发现主链（搜索路径/装载）无状态耦合；warn 经 core log
// facade 落宿主日志。字段级契约速览：
//   id / bin / protocol 必需；capabilities 必需（缺键保守值 + warn；未知键忽略 + warn）；
//   envPrefixes 可选（非法条目丢弃该前缀 + warn，包仍可用）；modelCatalog 可选
//   （缺省 = 不注入，三态语义见 parseModelCatalog）；displayName/description 可选。

import * as path from "node:path";

import type { ModelCatalogEntry } from "@zhushanwen/subagent-engine-sdk";

import { getLogger } from "../../core/logger.ts";
import type { EngineCapabilities } from "./types.ts";

const logger = getLogger("subagents");

/** 引擎 env 放行前缀的保留字（§2.4/§2.12 L2：引擎 manifest 不得声明宿主命名空间）。 */
const RESERVED_ENV_PREFIXES = ["XYZ_", "XYZ_AGENT_", "XYZ_SUBAGENT_"];

/** env 前缀合法形态（§2.4：^[A-Za-z0-9_]+$；保留前缀比对大小写不敏感）。 */
const ENV_PREFIX_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * capabilities 全保守值（manifest capabilities 缺失/缺键时的回退——「声明即能力」
 * 模型下，未声明 = 最弱能力：gate 同步拦生成，运行期不会踩引擎不支持的路径）。
 */
export const CONSERVATIVE_CAPABILITIES: EngineCapabilities = {
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
};

/** 枚举能力位词表（与 types.ts EngineCapabilities 逐键对应；maxTurns 单独 boolean）。 */
const CAPABILITY_ENUMS: Record<string, readonly string[]> = {
  schemaEnforcement: ["native", "emulated"],
  steer: ["native", "emulated", "unsupported"],
  // [U6 / §3.2.6 要点 4] "cold" = 冷恢复会话（resume 读 + 新 session 注入）——
  // 与 SDK EngineCapabilities.conversation 值域同批扩展，manifest 侧同步收词。
  conversation: ["native", "cold", "unsupported"],
  personaInjection: ["file", "flag", "prompt"],
  eventGranularity: ["stream", "coarse"],
  sandbox: ["native", "emulated", "none"],
  sessionRead: ["full", "partial", "outcome-only"],
  resume: ["native", "cold", "unsupported"],
  interrupt: ["native", "kill-only"],
  permissionMode: ["native", "fixed", "ignored"],
};

/**
 * 解析 manifest bin → 入口文件绝对路径。package.json `bin` 为字符串（单入口形态）
 * 直接用；为 map 时按 manifest bin key 查。查不到返回 undefined（= bin 缺失面）。
 */
export function resolveManifestBin(
  pkgDir: string,
  pkg: Record<string, unknown>,
  manifestBin: string,
): string | undefined {
  const npmBin = pkg["bin"];
  if (typeof npmBin === "string") return path.resolve(pkgDir, npmBin);
  if (typeof npmBin === "object" && npmBin !== null) {
    const rel = (npmBin as Record<string, unknown>)[manifestBin];
    if (typeof rel === "string" && rel.trim() !== "") return path.resolve(pkgDir, rel);
  }
  return undefined;
}

/** capabilities 字段级解析：段缺失 = 全保守 + warn；缺键/坏值 = 该键保守 + warn；未知键忽略 + warn。 */
export function parseCapabilities(id: string, raw: unknown): EngineCapabilities {
  if (raw === undefined || raw === null) {
    logger.warn(
      `[engine-discovery] engine '${id}': manifest capabilities is required — falling back to most conservative values`,
    );
    return { ...CONSERVATIVE_CAPABILITIES };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    logger.warn(
      `[engine-discovery] engine '${id}': manifest capabilities must be an object — falling back to most conservative values`,
    );
    return { ...CONSERVATIVE_CAPABILITIES };
  }
  const v = raw as Record<string, unknown>;
  const out = {} as Record<string, unknown>;
  for (const [key, allowed] of Object.entries(CAPABILITY_ENUMS)) {
    const value = v[key];
    if (value === undefined) {
      out[key] = CONSERVATIVE_CAPABILITIES[key as keyof EngineCapabilities];
      logger.warn(
        `[engine-discovery] engine '${id}': capabilities.${key} missing — conservative default '${String(out[key])}'`,
      );
      continue;
    }
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
      out[key] = value;
      continue;
    }
    out[key] = CONSERVATIVE_CAPABILITIES[key as keyof EngineCapabilities];
    logger.warn(
      `[engine-discovery] engine '${id}': capabilities.${key}=${describeValue(value)} invalid ` +
        `(expected one of ${allowed.join("|")}) — conservative default '${String(out[key])}'`,
    );
  }
  const maxTurns = v["maxTurns"];
  if (maxTurns === undefined) {
    out["maxTurns"] = false;
    logger.warn(`[engine-discovery] engine '${id}': capabilities.maxTurns missing — conservative default 'false'`);
  } else if (typeof maxTurns !== "boolean") {
    out["maxTurns"] = false;
    logger.warn(
      `[engine-discovery] engine '${id}': capabilities.maxTurns=${describeValue(maxTurns)} invalid (expected boolean) — conservative default 'false'`,
    );
  } else {
    out["maxTurns"] = maxTurns;
  }
  // 未知键：忽略 + warn（一次汇总，防逐键刷屏）
  const knownKeys = new Set([...Object.keys(CAPABILITY_ENUMS), "maxTurns"]);
  const unknownKeys = Object.keys(v).filter((k) => !knownKeys.has(k));
  if (unknownKeys.length > 0) {
    logger.warn(
      `[engine-discovery] engine '${id}': unknown capabilities key(s) ignored: ${unknownKeys.join(", ")}`,
    );
  }
  return out as unknown as EngineCapabilities;
}

/** envPrefixes 字段级解析：非法/保留前缀条目丢弃该前缀 + warn，包仍可用（A12②）。 */
export function parseEnvPrefixes(id: string, raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    logger.warn(
      `[engine-discovery] engine '${id}': envPrefixes must be an array — ignoring (engine remains usable)`,
    );
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || item === "" || item.includes("*") || !ENV_PREFIX_PATTERN.test(item)) {
      logger.warn(
        `[engine-discovery] engine '${id}': envPrefixes entry ${describeValue(item)} rejected ` +
          `(must match ^[A-Za-z0-9_]+$, non-empty, no '*') — dropping the prefix, engine remains usable`,
      );
      continue;
    }
    const upper = item.toUpperCase();
    if (RESERVED_ENV_PREFIXES.some((reserved) => upper.startsWith(reserved))) {
      logger.warn(
        `[engine-discovery] engine '${id}': envPrefixes entry '${item}' rejected (reserved host prefix) — dropping the prefix, engine remains usable`,
      );
      continue;
    }
    if (seen.has(upper)) continue; // 大小写不敏感去重（env 名在 POSIX 侧语义即不区分大小写冲突面）
    seen.add(upper);
    out.push(item);
  }
  return out;
}

/**
 * modelCatalog 字段级解析（三态必写死，§2.4）：
 *   缺省 → undefined（不注入——「无枚举面」必须可达）；
 *   null → null（合法等价省略）；
 *   对象 → { dynamic: 缺省 true, models: 条目数组 }；models 缺失/非数组 → null + warn
 *   （显式声明了 catalog 却无有效 models = 无有效枚举面，取 null 而非 []——[] 是
 *   「有枚举面但空」的作者显式声明，不得代填）。
 */
export function parseModelCatalog(
  id: string,
  raw: unknown,
): { dynamic: boolean; models: ModelCatalogEntry[] } | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    logger.warn(`[engine-discovery] engine '${id}': modelCatalog must be an object — ignoring (no model catalog)`);
    return undefined;
  }
  const v = raw as Record<string, unknown>;
  const dynamic = parseCatalogDynamic(id, v);
  if (!Array.isArray(v["models"])) {
    logger.warn(
      `[engine-discovery] engine '${id}': modelCatalog.models must be an array — treating catalog as absent (null)`,
    );
    return null;
  }
  const models: ModelCatalogEntry[] = [];
  for (const item of v["models"]) {
    const entry = parseModelCatalogEntry(id, item);
    if (entry === undefined) continue;
    models.push(entry);
  }
  return { dynamic, models };
}

/** modelCatalog.dynamic 解析：缺省 true；非 boolean warn 后仍取缺省。 */
function parseCatalogDynamic(id: string, v: Record<string, unknown>): boolean {
  const rawDynamic = v["dynamic"];
  if (rawDynamic === undefined) return true;
  if (typeof rawDynamic === "boolean") return rawDynamic;
  logger.warn(
    `[engine-discovery] engine '${id}': modelCatalog.dynamic=${describeValue(rawDynamic)} invalid (expected boolean) — defaulting to true`,
  );
  return true;
}

/** 单条目解析：形态坏/缺 id → undefined（丢弃该条目）；非法 aliases 丢弃 aliases 但条目保留。 */
function parseModelCatalogEntry(id: string, item: unknown): ModelCatalogEntry | undefined {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    logger.warn(`[engine-discovery] engine '${id}': modelCatalog entry ${describeValue(item)} is not an object — dropping entry`);
    return undefined;
  }
  const entryId = (item as Record<string, unknown>)["id"];
  if (typeof entryId !== "string" || entryId.trim() === "") {
    logger.warn(`[engine-discovery] engine '${id}': modelCatalog entry missing string id — dropping entry`);
    return undefined;
  }
  const aliases = (item as Record<string, unknown>)["aliases"];
  if (aliases !== undefined && !Array.isArray(aliases)) {
    logger.warn(`[engine-discovery] engine '${id}': modelCatalog entry '${entryId}' aliases must be an array — dropping aliases`);
  }
  return {
    id: entryId,
    ...(Array.isArray(aliases) ? { aliases: aliases.filter((a): a is string => typeof a === "string") } : {}),
    ...((item as Record<string, unknown>)["canonicalRef"] !== undefined
      ? { canonicalRef: (item as Record<string, unknown>)["canonicalRef"] as string }
      : {}),
  };
}

/** unknown 值的短描述（warn 文案；JSON.stringify 对 Symbol/BigInt 返回 undefined 不可靠）。 */
export function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object" && value !== null) return Array.isArray(value) ? "array" : "object";
  return String(value);
}
