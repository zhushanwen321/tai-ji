// src/execution/engine/config.ts
//
// [W4] subagents/config.json 的 engines{} 段（三级发现的 L3 显式配置，设计 §3.4）。
//
// 契约（impl-plan §2.4）：
//   `engines: {"<id>": {command, args, config, cwd, enabled}}`
//   - 无 `env` 键（v6 已删 extras 层——引擎 env 放行面归 manifest envPrefixes，L3 不重开）；
//   - `config` 经 initialize.engineConfig 透传（引擎不实现消费即死键，不校验内容）；
//   - `enabled: false` → 该引擎不装载（A12⑤：不进清单 + 派发报错含恢复指引）。
//
// 与 execution/config.ts 的关系：那边是全局配置的 sanitize 权威（maxConcurrent /
// defaultEngine / engineRouting / collectSync），其 SubagentsGlobalConfig 类型不含
// engines 键（sanitize 未知键忽略）。本模块只取 engines 段并逐条目校验——独立解析
// 避免 execution/config.ts 类型面为发现器扩键（发现器消费 raw 形态，字段级容错在本
// 模块内做，坏条目 warn 跳过、不影响其他条目）。

import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "../../core/logger.ts";

const logger = getLogger("subagents");

/** L3 显式引擎配置条目（config.json engines.<id>，字段级校验后形态）。 */
export interface ExplicitEngineEntry {
  /** 引擎 CLI 命令（相对 PATH 的命令名或绝对/相对路径；装载期解析为可执行路径）。 */
  command: string;
  /** 引擎 CLI 参数（不含 command 本身；缺省 []）。 */
  args: string[];
  /** initialize.engineConfig 透传（Record<string,string>，缺省无）。 */
  config?: Record<string, string>;
  /** 引擎进程 cwd（缺省继承宿主进程）。 */
  cwd?: string;
}

/**
 * 读 config.json 的 engines 段（已启用条目，键 = 引擎 id）。
 *
 * 容错契约（与 config.json 用户手编文件定位一致，execution/config.ts 同判）：
 * 文件缺失 / 坏 JSON / engines 段非对象 → 静默空表（L3 缺席是常态，不 warn——绝大多数
 * 安装无显式配置）；单条目形态坏 → warn 跳过该条目（不影响其他条目，A12②「其他引擎
 * 正常」的 L3 版）。
 */
export function readExplicitEngines(agentDir: string): Record<string, ExplicitEngineEntry> {
  const configPath = path.join(agentDir, "subagents", "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const engines = (parsed as Record<string, unknown>)["engines"];
  if (typeof engines !== "object" || engines === null || Array.isArray(engines)) {
    if (engines !== undefined) {
      logger.warn(
        `[engine-discovery] config.json engines section must be an object keyed by engine id, got ${jsonKindOf(engines)} — ignoring L3 explicit engines`,
      );
    }
    return {};
  }
  const out: Record<string, ExplicitEngineEntry> = {};
  for (const [id, raw] of Object.entries(engines as Record<string, unknown>)) {
    const entry = sanitizeExplicitEntry(id, raw);
    if (entry !== undefined) out[id] = entry;
  }
  return out;
}

/** 单条目字段级校验：command 必需非空字符串；args/config/cwd 形态坏 → 丢弃该字段 + warn。 */
function sanitizeExplicitEntry(id: string, raw: unknown): ExplicitEngineEntry | undefined {
  const v = requireEntryObject(id, raw);
  if (v === undefined) return undefined;
  if (v["enabled"] === false) return undefined; // A12⑤：显式禁用 = 不装载不进清单（非错误，不 warn）
  const command = requireCommand(id, v["command"]);
  if (command === undefined) return undefined;
  return {
    command,
    ...normalizeArgs(id, v["args"]),
    ...normalizeConfig(id, v["config"]),
    ...normalizeCwd(id, v["cwd"]),
  };
}

/** 条目形态守卫：非对象（含数组/null）→ warn 跳过整条。 */
function requireEntryObject(id: string, raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    logger.warn(
      `[engine-discovery] config.json engines.${id} must be an object, got ${jsonKindOf(raw)} — skipping entry`,
    );
    return undefined;
  }
  return raw as Record<string, unknown>;
}

/** command 校验：必需非空字符串，形态坏 → warn 跳过整条。 */
function requireCommand(id: string, command: unknown): string | undefined {
  if (typeof command !== "string" || command.trim() === "") {
    logger.warn(
      `[engine-discovery] config.json engines.${id}.command is required (non-empty string) — skipping entry`,
    );
    return undefined;
  }
  return command;
}

/** args 字段：形态坏 warn 丢弃该字段；合法（或缺省）→ 条件 spread 形态。 */
function normalizeArgs(id: string, args: unknown): { args: string[] } {
  if (args !== undefined && !isStringArray(args)) {
    logger.warn(
      `[engine-discovery] config.json engines.${id}.args must be a string array — ignoring args`,
    );
  }
  return { args: isStringArray(args) ? args : [] };
}

/** config 字段：形态坏 warn 丢弃该字段；合法 → 条件 spread 形态。 */
function normalizeConfig(id: string, config: unknown): { config?: Record<string, string> } {
  if (config !== undefined && !isStringRecord(config)) {
    logger.warn(
      `[engine-discovery] config.json engines.${id}.config must be a Record<string, string> — ignoring config`,
    );
  }
  return isStringRecord(config) ? { config } : {};
}

/** cwd 字段：形态坏 warn 丢弃该字段；合法 → 条件 spread 形态。 */
function normalizeCwd(id: string, cwd: unknown): { cwd?: string } {
  if (cwd !== undefined && typeof cwd !== "string") {
    logger.warn(
      `[engine-discovery] config.json engines.${id}.cwd must be a string — ignoring cwd`,
    );
  }
  return typeof cwd === "string" ? { cwd } : {};
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

/** unknown 值的 JSON 类型名（warn 文案用；不用 JSON.stringify——循环引用会炸）。 */
function jsonKindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
