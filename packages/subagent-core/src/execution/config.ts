// src/execution/config.ts
//
// 全局配置（~/.pi/agent/subagents/config.json）。
// 仅保留 maxConcurrent（pool 大小）。模型解析已退化为「主 agent model 优先」，
// 不再有 category/fallback/session 级覆盖——相关字段读取时忽略。

import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "../core/logger.ts";

import type { CollectSyncConfig, SubagentsGlobalConfig } from "./types.ts";

// 同步收集配置节类型 re-export（类型权威定义在 types.ts，避免 config → types 反向依赖成环；
// 消费方从本模块 import 与从 types.ts import 等价，U1 foundation 契约）。
export type { CollectSyncConfig };

// 包内 execution 模块统一具名 logger（getLogger 缓存单例，见 notify-ledger.ts 同款）。
const logger = getLogger("subagents");

// ============================================================
// 常量
// ============================================================

/**
 * 开箱默认配置（单一真相源，内联在代码里）。
 *
 * 历史教训 [HISTORICAL]：曾用包内 config.json（与 src/ 同级）作为默认值源，
 * 但 config.json 被 .gitignore 排除且不应随 npm 包分发用户私有配置——导致
 * npm pack 后读不到文件，catch 兜底用空字段，pi install 后首次执行抛错。
 * 修复：默认值内联在代码里，不依赖任何包内文件。
 *
 * export 供守护测试断言 package.json startupConfig 声明与此深相等（防漂移）。
 */
export const DEFAULT_CONFIG: SubagentsGlobalConfig = {
  version: 1,
  maxConcurrent: 6,
};

// 注意：DEFAULT_CONFIG 刻意不含 collectSync 键（与 defaultEngine/engineRouting 同风格）——
// SW 包 package.json 的 pi.startupConfig 声明守护（startup-config-declaration.test.ts）
// 断言与 DEFAULT_CONFIG 深相等，声明面只含既有键。collectSync 缺省语义由
// DEFAULT_COLLECT_SYNC 承载，消费方以 `config.collectSync ?? DEFAULT_COLLECT_SYNC` 兜底
// （loadGlobalConfig 文件缺失/坏 JSON 路径返回 {...DEFAULT_CONFIG} 同样无键）。

/** 默认 maxConcurrent（DEFAULT_CONFIG 的镜像，sanitize 用）。 */
const DEFAULT_MAX_CONCURRENT = 6;

/**
 * 同步收集配置节权威默认值（subagent-sync-collect 设计 §3.1.3，U1 foundation）。
 * 消费方：startHandler 缺省模式解析 / U3+U4 批通知预算（flush 时热读）。
 * 供守护测试断言（E5 各坏值回默认）。展开拷贝防调用方 mutate。
 */
export const DEFAULT_COLLECT_SYNC: CollectSyncConfig = {
  default: "async",
  perItemChars: 4000,
  totalChars: 24000,
};
// ============================================================
// 路径
// ============================================================

/**
 * 配置文件路径（<agentDir>/subagents/config.json）。
 * agentDir 由 Pi 核心 getAgentDir() 决定（读 PI_CODING_AGENT_DIR，默认 ~/.pi/agent），
 * 与 Pi 主进程的目录约定完全一致——支持宿主经环境变量整体重定向。
 */
export function getGlobalConfigPath(agentDir: string): string {
  return path.join(agentDir, "subagents", "config.json");
}

// ============================================================
// 全局配置加载
// ============================================================

/**
 * 加载全局配置。文件不存在 / JSON 解析失败 / 字段缺失时返回默认配置。
 * 旧 config.json 中的 categories/fallback/yoloByDefault 等字段读取时忽略
 * （模型解析已退化为「主 agent model 优先」）。
 *
 * 注意：本函数是「静默回落」形态（ENOENT 与坏 JSON 同归默认值，历史行为保持
 * 不动）。需要区分三态的调用方（引擎感知检测器，设计 D5）用 readGlobalConfig。
 */
export function loadGlobalConfig(agentDir: string): SubagentsGlobalConfig {
  try {
    const raw = fs.readFileSync(getGlobalConfigPath(agentDir), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SubagentsGlobalConfig>;
    return sanitizeParsedConfig(parsed);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ============================================================
// 三态读取（设计 D5：明确值 / 明确缺省 / 读失败）
// ============================================================

/** 三态读取结果（判别联合，调用方按 status 分派）。 */
export type GlobalConfigReadResult =
  /** 读到明确值：JSON 可解析，字段已经 sanitize。 */
  | { status: "ok"; config: SubagentsGlobalConfig }
  /** 明确缺省：文件不存在（ENOENT）。这是用户意图（删配置切回缺省 pi），不是故障。 */
  | { status: "absent"; config: SubagentsGlobalConfig }
  /** 读失败：坏 JSON / 权限等。携带原始错误消息供诊断；调用方保持 lastEngine 不动。 */
  | { status: "failed"; reason: string };

/**
 * 三态读取全局配置（设计 D5）。
 *
 * 为什么不用 loadGlobalConfig：后者 ENOENT 与坏 JSON 同归 DEFAULT_CONFIG（静默
 * 回落），检测器若消费该形态会把「用户删配置切回缺省」（合法变更，须生效）误判成
 * 「读失败」（须保持 lastEngine），也会把坏 JSON（torn write）误判成合法缺省——
 * 两个方向都会产生错误的引擎切换信号。
 */
export function readGlobalConfig(agentDir: string): GlobalConfigReadResult {
  const configPath = getGlobalConfigPath(agentDir);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    // ENOENT 单独成态：subagents/ 目录不存在同样意味着没有配置文件，语义等同
    if (errnoCodeOf(err) === "ENOENT") {
      return { status: "absent", config: { ...DEFAULT_CONFIG } };
    }
    return readFailure(configPath, err);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SubagentsGlobalConfig>;
    return { status: "ok", config: sanitizeParsedConfig(parsed) };
  } catch (err) {
    return readFailure(configPath, err);
  }
}

/** 读失败统一出口：落 warn 日志（现状 loadGlobalConfig catch 静默无日志的补漏）+ 携带原因。 */
function readFailure(configPath: string, err: unknown): GlobalConfigReadResult {
  const reason = err instanceof Error ? err.message : String(err);
  logger.warn(`[subagents] global config read failed (read-failure) at ${configPath}: ${reason}`);
  return { status: "failed", reason };
}

/** 从 unknown 错误提取 Node errno code（运行时 guard，不用类型断言）。 */
function errnoCodeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = Reflect.get(err, "code");
  return typeof code === "string" ? code : undefined;
}

/**
 * 已解析 JSON 的 sanitize（loadGlobalConfig 与 readGlobalConfig 共用，防两处漂移）。
 * P4 引擎路由（D9）：非法值静默回缺省（'pi' / false）——config.json 是用户手编
 * 文件，坏值不炸启动（与 maxConcurrent 同判）。
 */
function sanitizeParsedConfig(parsed: Partial<SubagentsGlobalConfig>): SubagentsGlobalConfig {
  const defaultEngine = sanitizeDefaultEngine(parsed.defaultEngine);
  const engineRouting = sanitizeEngineRouting(parsed.engineRouting);
  const collectSync = sanitizeCollectSync(parsed.collectSync);
  return {
    version: parsed.version ?? DEFAULT_CONFIG.version,
    maxConcurrent: sanitizeMaxConcurrent(parsed.maxConcurrent),
    ...(defaultEngine !== undefined ? { defaultEngine } : {}),
    ...(engineRouting !== undefined ? { engineRouting } : {}),
    ...(collectSync !== undefined ? { collectSync } : {}),
  };
}

/** maxConcurrent 校验：正整数，否则默认（S5：委托 sanitizePositiveInt，正整数规则单点化）。 */
function sanitizeMaxConcurrent(value: unknown): number {
  return sanitizePositiveInt(value, DEFAULT_MAX_CONCURRENT);
}

/**
 * collectSync 节校验（E5：负数/非枚举/坏类型回默认，不炸启动；与 maxConcurrent 同判。
 * subagent-sync-collect 设计 §3.1.5 E5 + §3.1.3）。逐字段 sanitize：坏字段回该字段
 * 默认，好字段透传（部分覆盖合法）。整节缺失返回 undefined（不落键，与 engineRouting
 * 同风格——缺省语义由消费方读 DEFAULT_COLLECT_SYNC）。
 *
 * [D6 #8] 字段级坏值回默认时 warn 一条（缺省字段不 warn——部分覆盖合法）：config.json
 * 是用户手编文件，静默回落使「改了配置不生效」无从排查（sanitize 行为不变，只补可观测）。
 *
 * 消费时机：startHandler 缺省 collect 解析（config.default，新 session 生效）与
 * U3/U4 批通知预算（perItemChars/totalChars，flush 时热读）。
 */
export function sanitizeCollectSync(value: unknown): CollectSyncConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const fallback = DEFAULT_COLLECT_SYNC;
  // [D6 #8] 坏值字段清单（仅「显式给了坏值」计——缺省是合法部分覆盖，不 warn）。
  // 值格式化不用 JSON.stringify：Symbol/BigInt 等 stringify 返回 undefined，String() 全类型安全。
  const fmt = (val: unknown): string => (typeof val === "string" ? JSON.stringify(val) : String(val));
  const bad: string[] = [];
  if (v.default !== undefined && v.default !== "sync" && v.default !== "async") {
    bad.push(`default=${fmt(v.default)}`);
  }
  if (v.perItemChars !== undefined && !isPositiveInt(v.perItemChars)) {
    bad.push(`perItemChars=${fmt(v.perItemChars)}`);
  }
  if (v.totalChars !== undefined && !isPositiveInt(v.totalChars)) {
    bad.push(`totalChars=${fmt(v.totalChars)}`);
  }
  if (bad.length > 0) {
    logger.warn(
      `[subagents] config collectSync invalid field(s) reverted to defaults: ${bad.join(", ")}`,
    );
  }
  return {
    default: v.default === "sync" ? "sync" : v.default === "async" ? "async" : fallback.default,
    perItemChars: sanitizePositiveInt(v.perItemChars, fallback.perItemChars),
    totalChars: sanitizePositiveInt(v.totalChars, fallback.totalChars),
  };
}

/** 正整数校验（collectSync 预算字段用；与 sanitizeMaxConcurrent 同判）。 */
function sanitizePositiveInt(value: unknown, fallback: number): number {
  return isPositiveInt(value) ? (value as number) : fallback;
}

/** 正整数判定（sanitizePositiveInt 的探测面，坏值 warn 清单复用）。 */
function isPositiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * defaultEngine 校验：非空字符串透传，其余 undefined（缺省引擎由路由层落 'pi'）。
 * 为什么不在加载期对注册表校验 hasEngine：加载早于组合根注册（agentDir 解析在
 * session_start），注册表此刻可能为空——校验归路由层（getEngine 抛 EngineNotFoundError）。
 */
function sanitizeDefaultEngine(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** engineRouting 校验：仅认 strict 布尔，其余键忽略（向前兼容追加）。 */
function sanitizeEngineRouting(value: unknown): { strict: boolean } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const strict = (value as Record<string, unknown>).strict;
  return typeof strict === "boolean" ? { strict } : undefined;
}
