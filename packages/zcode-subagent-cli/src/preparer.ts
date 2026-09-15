// src/execution/engine/engines/zcode/preparer.ts
//
// ZcodeEngine prepare 期模型解析件（P3 起源，2026-09 收缩）：隔离 HOME 池化与
// 池内 config 引导随 CLI spawn 链删除（共享宿主 HOME——app-server 的凭据经
// appserver-launcher fs 拦截注入 v2 provider，本文件只剩 v2 单源的模型引用
// 解析/校验/清单：
//   - **凭据源 = v2 config 单源（2026-08-25 用户拍板）**：只读 `~/.zcode/v2/config.json`
//     （ZCode 桌面登录态落点，GUI 管理面）。曾泛化过「v2 + cli config 双源合并」，
//     但 `~/.zcode/cli/config.json` 不在 GUI 管理面、可能残留历史验证配置
//     （8/24 zsub 开发残留把默认模型劫持到失效 router 端点的 401 事故），撤掉依赖；
//   - 凭据缺失/模型不可解析抛结构化 ZcodePrepareError（错误码对齐设计 §3.3.3：
//     engine_credential_missing / model_not_available），一律先于进程创建。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ZCODE_FALLBACK_DEFAULT_MODEL, ZCODE_V2_CONFIG_PATH_SUFFIX } from "./constants.ts";

// ============================================================
// 结构化错误（prepare 期——进程创建前 reject 的载体）
// ============================================================

export type ZcodePrepareErrorCode =
  | "engine_credential_missing"
  | "model_not_available"
  | "engine_capability_unsupported";

/** prepare 期错误：code 对齐设计 §3.3.3 错误规格表，message 自带恢复指引。 */
export class ZcodePrepareError extends Error {
  readonly code: ZcodePrepareErrorCode;

  constructor(code: ZcodePrepareErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ZcodePrepareError";
    this.code = code;
  }
}

// ============================================================
// 源 config 读取（运行时 guard，禁 any）
// ============================================================

/** provider 注册表条目的最小消费面（凭据 + 模型清单校验）。 */
export interface ZcodeProviderEntry {
  options?: { apiKey?: unknown };
  models?: Record<string, unknown>;
  [k: string]: unknown;
}

interface SourceConfig {
  /** provider 注册表（来自 v2 config，逐条运行时 guard）。 */
  providers: Map<string, ZcodeProviderEntry>;
}

/** unknown 的 Record 窄化 guard（替代 as 全可选断言——taste/no-unsafe-cast）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** provider 条目一律按 ZcodeProviderEntry 消费（索引签名形态，无需逐键校验）。 */
function isProviderEntry(v: unknown): v is ZcodeProviderEntry {
  return isRecord(v);
}

function readSourceConfig(absPath: string): SourceConfig {
  const empty: SourceConfig = { providers: new Map() };
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) return empty;
  const conf: SourceConfig = { providers: new Map() };
  const provider = parsed["provider"];
  if (isRecord(provider)) {
    for (const [id, entry] of Object.entries(provider)) {
      if (isProviderEntry(entry)) conf.providers.set(id, entry);
    }
  }
  return conf;
}

// ============================================================
// 模型解析（v2 单源，zsub resolve 同构）
// ============================================================

function modelShort(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

function providerOf(ref: string): string {
  return ref.slice(0, ref.lastIndexOf("/"));
}

/** [R4] 规范化全名 provider/model → create 参数的 per-session model 拆分（A.2 ① strict 对象）。 */
export function splitZcodeModelRef(modelRef: string): { providerId: string; modelId: string } {
  return { providerId: providerOf(modelRef), modelId: modelShort(modelRef) };
}

export function hasApiKey(entry: ZcodeProviderEntry): boolean {
  const key = entry.options?.apiKey;
  return typeof key === "string" && key !== "";
}

export interface ZcodeSourcePaths {
  /** 桌面登录态 config（唯一凭据源）。缺省 ~/.zcode/v2/config.json。 */
  v2ConfigPath?: string;
}

export function defaultV2ConfigPath(): string {
  return path.join(os.homedir(), ...ZCODE_V2_CONFIG_PATH_SUFFIX);
}

/**
 * 短名（无 provider 前缀）解析的默认 provider（zsub DEFAULT_PROVIDER_ID 同构）。
 * 导出（sink 设计 U1 模型切分四件之一）：barrel re-export 供第三宿主模型路由消费，
 * 实现体内聚本文件不挪。
 */
export const DEFAULT_PROVIDER_ID = "builtin:bigmodel-coding-plan";

/**
 * 短名模型（如 "GLM-5.3"）的默认 provider 决策。让位条件（对齐点⑦）：显式默认引擎
 * 模型配置引入时（config.json 出现 per-engine model 映射 / engineRouting 级模型缺省），
 * 本函数的「内置常量优先」须让位为「配置值优先」——引擎路由层（engine/routing.ts 的
 * taskModel 判定处）是引入该配置时应同步调整的决策点，避免出现「路由按配置模型选了
 * 引擎、prepare 却按内置常量落池」的分裂。首期无该配置，常量即权威。
 */
function defaultProviderForShortName(
  merged: Map<string, ZcodeProviderEntry>,
  withKey: Array<[string, ZcodeProviderEntry]>,
): string {
  if (merged.has(DEFAULT_PROVIDER_ID)) return DEFAULT_PROVIDER_ID;
  return withKey[0]![0];
}

/**
 * 解析并校验模型引用 → 规范化全名 `provider/model`。
 *
 * 解析链（requested > 默认链）：
 *   1. 显式 requested（task.model）；
 *   2. ZCODE_FALLBACK_DEFAULT_MODEL（zsub 同构兜底）。
 *
 * 校验对「带 apiKey 的 provider 注册表」做（没配凭据的 provider 写进池也跑不起来，
 * resolve 期报错比运行时挂掉可诊断——zsub 经验）。provider 存在但无 apiKey →
 * engine_credential_missing；provider/模型不存在 → model_not_available（列可用清单）。
 */
export function resolveZcodeModelRef(requested: string | undefined, sources?: ZcodeSourcePaths): string {
  const v2 = readSourceConfig(sources?.v2ConfigPath ?? defaultV2ConfigPath());
  const merged = v2.providers;
  const withKey = [...merged.entries()].filter(([, e]) => hasApiKey(e));
  const wanted = requested?.trim() || undefined;
  const target = wanted ?? ZCODE_FALLBACK_DEFAULT_MODEL;

  if (withKey.length === 0) {
    const hint = wanted
      ? `model="${wanted}" 不能校验`
      : `默认模型 "${target}" 不能校验`;
    throw new ZcodePrepareError(
      "engine_credential_missing",
      `zcode 引擎找不到任何带 apiKey 的 provider（${hint}）。已读源：${sources?.v2ConfigPath ?? defaultV2ConfigPath()}。` +
        `恢复指引：先在 ZCode 桌面端登录并配置 provider（v2 config 内存在含 apiKey 的条目）后重试；` +
        `凭据配置说明见 docs/research/agent-engine-zcode.md。`,
    );
  }

  const provider = target.includes("/")
    ? providerOf(target)
    : defaultProviderForShortName(merged, withKey);
  const short = modelShort(target);
  const entry = merged.get(provider);
  if (!entry) {
    const known = withKey.map(([id]) => id).join(", ");
    throw new ZcodePrepareError(
      "model_not_available",
      `未知 provider "${provider}"（带凭据的 provider: ${known}）。` +
        `恢复指引：改用上述 provider 之一（全名 provider/model），或先在 ZCode 桌面端配置该 provider 后重试。`,
    );
  }
  if (!hasApiKey(entry)) {
    throw new ZcodePrepareError(
      "engine_credential_missing",
      `provider "${provider}" 存在但未配置 apiKey。` +
        `恢复指引：在 ZCode 桌面端为该 provider 登录配置凭据，或改用已配凭据的 provider（${withKey.map(([id]) => id).join(", ")}）后重试。`,
    );
  }
  const models = Object.keys(entry.models ?? {});
  if (models.length > 0 && !models.includes(short)) {
    throw new ZcodePrepareError(
      "model_not_available",
      `未知模型 "${short}"（provider ${provider} 下可用: ${models.join(", ")}）。` +
        `恢复指引：改用该 provider 下的模型，或先在 ZCode 桌面端启用目标模型后重试。`,
    );
  }
  return `${provider}/${short}`;
}

// ============================================================
// 模型清单（U7 可发现性——v2 单源聚合，与 resolveZcodeModelRef 的凭据校验同判据）
// ============================================================

/**
 * 列出当前环境 zcode 引擎实际可用的模型（v2 config 内带 apiKey 的 provider × 其
 * models 清单）。消费方：EnginePort.listModels（system prompt 引擎段 / GUI）。
 * 失败安全：v2 config 不可读 → 空清单（可发现性降级不阻塞主流程）。
 */
export function listZcodeModels(sources?: ZcodeSourcePaths): Array<{ id: string; name?: string }> {
  const v2 = readSourceConfig(sources?.v2ConfigPath ?? defaultV2ConfigPath());
  const out: Array<{ id: string; name?: string }> = [];
  for (const [pid, entry] of v2.providers) {
    if (!hasApiKey(entry)) continue;
    const providerName =
      typeof entry["name"] === "string" && entry["name"].trim() !== "" ? entry["name"].trim() : undefined;
    const models = Object.keys(entry.models ?? {});
    for (const model of models) {
      out.push({
        id: `${pid}/${model}`,
        ...(providerName !== undefined ? { name: `${providerName} · ${model}` } : {}),
      });
    }
  }
  return out;
}

// ============================================================
// 池 key 与目录（2026-09 删除：HOME 池化随 CLI spawn 链一并退役——共享宿主 HOME
// 后无隔离池、无 config 引导，本文件只剩 v2 单源的模型解析/清单校验件）
// ============================================================
