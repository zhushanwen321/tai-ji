// src/execution/engine/engines/zcode/preparer.ts
//
// ZcodeEngine prepare 期模型解析件：app-server 注册表对齐源（2026-09-29 account
// 体系迁移同步后的形态）：
//   - **模型源 = ~/.zcode/v2/provider_config.json 单源（个人 provider）**——app
//     3.14.x 起 plan 家族 provider（builtin:/account: 前缀）经账号 entitlement 门控，
//     外部 spawn 的 app-server 注册表只装载个人 provider（实测：显式引用 plan 家族
//     任何 id 一律 Provider Registry 拒绝；个人 provider 的 provider/model 组合可用）。
//     旧源 v2 config.json 的 provider 条目（builtin: plan 家族 + 过期 UUID 清单）与
//     注册表实况不符，不再作为校验源；
//   - **缺席模型（task.model 空）= 返回空串**：create 帧省略 model 键，交给 CLI
//     自身缺省解析（实测落到 providerOrder 首位的可用模型并自动补齐 reasoning
//     档位）——不再伪造 plan 家族兜底 id（该 id 在注册表侧已不可用）；
//   - 凭据缺失/模型不可解析抛结构化 ZcodePrepareError（错误码对齐设计 §3.3.3：
//     engine_credential_missing / model_not_available），一律先于进程创建。
//   - 显式模型的 reasoningLevel：部分模型注册表要求 options.reasoningLevel（值域
//     per-model，见内建目录 modelConfigRules）——create 帧当前不携带，引擎侧留待
//     后续按需接线（登记：docs/todo/zcode-bare-cli-provider-registry.md）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ZCODE_PERSONAL_PROVIDER_CONFIG_PATH_SUFFIX, ZCODE_V2_CONFIG_PATH_SUFFIX } from "./constants.ts";

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

/** 个人 provider 条目的引擎侧消费面（provider_config.json providerRules 项的提取形态）。 */
export interface ZcodeProviderEntry {
  providerName?: string;
  /** provider_config 的 config.access.apiKey（个人 provider 凭据就在本文件内）。 */
  apiKey?: string;
  /** 模型清单（personalModelIds 非空取之，否则 modelOrder）。 */
  models?: string[];
  [k: string]: unknown;
}

interface SourceConfig {
  /** 个人 provider 注册表（来自 provider_config.json，逐条运行时 guard）。 */
  providers: Map<string, ZcodeProviderEntry>;
  /** GUI 侧 provider 排序（短名解析的默认 provider 取首位——与 CLI 缺省解析同源）。 */
  order: string[];
}

/** unknown 的 Record 窄化 guard（替代 as 全可选断言——taste/no-unsafe-cast）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((m): m is string => typeof m === "string" && m.trim() !== "") : [];
}

/**
 * 读个人 provider 源（~/.zcode/v2/provider_config.json——GUI 管理面写入、app-server
 * 注册表实际装载的 provider 清单）。文件缺失/损坏 → 空源（凭据检查会给出
 * engine_credential_missing 的 fail-fast，不在此处吞成静默空表）。
 */
function readSourceConfig(absPath: string): SourceConfig {
  const empty: SourceConfig = { providers: new Map(), order: [] };
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
  const rules = (parsed["config"] as Record<string, unknown> | undefined)?.["providerConfigRules"];
  const providerRules = !isRecord(rules)
    ? undefined
    : rules["providerRules"];
  const orderSrc = (parsed["config"] as Record<string, unknown> | undefined)?.["providerOrder"];
  const conf: SourceConfig = { providers: new Map(), order: strArray(orderSrc) };
  if (!Array.isArray(providerRules)) return conf;
  for (const rule of providerRules) {
    if (!isRecord(rule)) continue;
    const id = rule["providerId"];
    if (typeof id !== "string" || id.trim() === "") continue;
    const cfg = isRecord(rule["config"]) ? rule["config"] : {};
    const access = isRecord(cfg["access"]) ? cfg["access"] : {};
    const apiKey = access["apiKey"];
    const personal = strArray(cfg["personalModelIds"]);
    conf.providers.set(id, {
      providerName: typeof rule["providerName"] === "string" ? rule["providerName"] : undefined,
      apiKey: typeof apiKey === "string" && apiKey !== "" ? apiKey : undefined,
      models: personal.length > 0 ? personal : strArray(cfg["modelOrder"]),
    });
  }
  return conf;
}

// ============================================================
// 模型解析（provider_config 单源——注册表实况对齐）
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
  return typeof entry.apiKey === "string" && entry.apiKey !== "";
}

export interface ZcodeSourcePaths {
  /** 个人 provider 注册表源（app-server 注册表对齐）。缺省 ~/.zcode/v2/provider_config.json。 */
  personalProviderConfigPath?: string;
  /** launcher 凭据注入的 v2 config 源（ZCODE_ENG_V2_CONFIG 消费——凭据供数面，与模型校验源无关）。缺省 ~/.zcode/v2/config.json。 */
  v2ConfigPath?: string;
}

export function defaultPersonalProviderConfigPath(): string {
  return path.join(os.homedir(), ...ZCODE_PERSONAL_PROVIDER_CONFIG_PATH_SUFFIX);
}

/** launcher 凭据注入的 v2 config 缺省路径（ZCODE_ENG_V2_CONFIG 消费，与模型校验源无关）。 */
export function defaultV2ConfigPath(): string {
  return path.join(os.homedir(), ...ZCODE_V2_CONFIG_PATH_SUFFIX);
}

/**
 * 短名模型（如 "mimo-v2.6-pro"）的默认 provider 决策：providerOrder 首个带凭据的
 * provider（GUI 首选 = CLI 缺省解析的落点，同源对齐）；序内无可用则任意带凭据者。
 * 让位条件（对齐点⑦）不变：显式默认引擎模型配置引入时配置值优先。
 */
function defaultProviderForShortName(
  conf: SourceConfig,
  withKey: Array<[string, ZcodeProviderEntry]>,
): string {
  const ordered = conf.order.find((id) => {
    const entry = conf.providers.get(id);
    return entry !== undefined && hasApiKey(entry);
  });
  if (ordered !== undefined) return ordered;
  return withKey[0]![0];
}

/**
 * 解析并校验模型引用 → 规范化全名 `provider/model`；**缺席输入返回空串**（调用方
 * 在 create 帧省略 model 键——CLI 缺省解析，缺席语义显式化，禁伪造兜底 id）。
 *
 * 解析链：显式 requested（trim 非空）> 空串（= 缺席，CLI 缺省解析）。
 *
 * [R4/G3] 消费面（条件携带后）：① run 显式路径（task.model trim 非空才调用——缺席
 * 时 runViaAppServer 不进本函数、create 不携带 model 键）；② validateModel 诊断面
 * （缺席 = 空串 → record.model 留空投影「用户未指定」）。
 *
 * 校验对「带 apiKey 的个人 provider 注册表」做（没配凭据的 provider 写进注册表也
 * 跑不起来，resolve 期报错比运行时挂掉可诊断）。provider 存在但无 apiKey →
 * engine_credential_missing；provider/模型不存在 → model_not_available（列可用清单）。
 */
export function resolveZcodeModelRef(requested: string | undefined, sources?: ZcodeSourcePaths): string {
  const srcPath = sources?.personalProviderConfigPath ?? defaultPersonalProviderConfigPath();
  const conf = readSourceConfig(srcPath);
  const withKey = [...conf.providers.entries()].filter(([, e]) => hasApiKey(e));
  const wanted = requested?.trim() || undefined;

  if (withKey.length === 0) {
    const hint = wanted ? `model="${wanted}" 不能校验` : "缺省模型解析不能校验";
    throw new ZcodePrepareError(
      "engine_credential_missing",
      `zcode 引擎找不到任何带 apiKey 的个人 provider（${hint}）。已读源：${srcPath}。` +
        `恢复指引：在 ZCode 桌面端配置至少一个个人 provider（provider_config.json 内存在` +
        ` config.access.apiKey 非空条目）后重试；plan 套餐族（builtin:/account: 前缀）经账号` +
        ` entitlement 门控，外部 spawn 的引擎注册表不装载，不可作为引擎模型。`,
    );
  }

  if (wanted === undefined) return "";

  const provider = wanted.includes("/")
    ? providerOf(wanted)
    : defaultProviderForShortName(conf, withKey);
  const short = modelShort(wanted);
  const entry = conf.providers.get(provider);
  if (!entry) {
    const known = withKey.map(([id]) => id).join(", ");
    throw new ZcodePrepareError(
      "model_not_available",
      `未知 provider "${provider}"（带凭据的个人 provider: ${known}）。` +
        `恢复指引：改用上述 provider 之一（全名 provider/model），或在 ZCode 桌面端配置该` +
        ` provider 后重试；省略 model 参数则走引擎缺省解析（CLI 自身选取可用模型）。`,
    );
  }
  if (!hasApiKey(entry)) {
    throw new ZcodePrepareError(
      "engine_credential_missing",
      `provider "${provider}" 存在但未配置 apiKey。` +
        `恢复指引：在 ZCode 桌面端为该 provider 配置凭据，或改用已配凭据的 provider` +
        `（${withKey.map(([id]) => id).join(", ")}）后重试。`,
    );
  }
  const models = entry.models ?? [];
  if (models.length > 0 && !models.includes(short)) {
    throw new ZcodePrepareError(
      "model_not_available",
      `未知模型 "${short}"（provider ${provider} 下可用: ${models.join(", ")}）。` +
        `恢复指引：改用该 provider 下的模型，或在 ZCode 桌面端启用目标模型后重试。`,
    );
  }
  return `${provider}/${short}`;
}

// ============================================================
// 模型清单（U7 可发现性——provider_config 单源聚合，与 resolveZcodeModelRef 的凭据校验同判据）
// ============================================================

/**
 * 列出当前环境 zcode 引擎实际可用的模型（provider_config.json 内带 apiKey 的个人
 * provider × 其模型清单——与 app-server 注册表的装载实况一致）。消费方：
 * EnginePort.listModels（system prompt 引擎段 / GUI）。失败安全：源不可读 → 空清单
 * （可发现性降级不阻塞主流程）。
 */
export function listZcodeModels(sources?: ZcodeSourcePaths): Array<{ id: string; name?: string }> {
  const conf = readSourceConfig(sources?.personalProviderConfigPath ?? defaultPersonalProviderConfigPath());
  const out: Array<{ id: string; name?: string }> = [];
  for (const [pid, entry] of conf.providers) {
    if (!hasApiKey(entry)) continue;
    const providerName = entry.providerName !== undefined && entry.providerName.trim() !== "" ? entry.providerName.trim() : undefined;
    for (const model of entry.models ?? []) {
      out.push({
        id: `${pid}/${model}`,
        ...(providerName !== undefined ? { name: `${providerName} · ${model}` } : {}),
      });
    }
  }
  return out;
}
