// src/execution/engine/engines/zcode/preparer.ts
//
// ZcodeEngine prepare 期模型解析件：app-server 注册表对齐源（2026-09-29 account
// 体系迁移同步后的形态）：
//   - **模型源 = 个人 provider 解析链**（engine-provider-unification D3 扩链）：
//     taiji 同步副本 `<engineDataDir>/engines/zcode/pi-synced-provider-config.json`
//     存在 → 读 merge(真实 `~/.zcode/v2/provider_config.json` 实时内容, 副本) 视图
//     （D3 换轨版：真实条目优先、副本独有追加——与 appserver-launcher 拦截分支的
//     内嵌 mergeProviderConfig 同规则，对账单测锁步；两消费方〔本文件校验链 / CLI
//     Provider Registry〕看到同一视图，消除「校验放行 × CLI 拒载」分叉）；副本
//     缺失 → 回落真实文件直读。副本是 runtime 启动段把 pi 侧 provider 映射落盘的
//     纯 pi 侧产物（不透传真实内容），本文件不写副本只消费——解析链单点 =
//     resolvePersonalProviderConfigPath（zcode-engine 的 ZCODE_ENG_PROVIDER_CONFIG
//     env 赋值同函数，两消费方同锚）。
//     app 3.14.x 起 plan 家族 provider（builtin:/account: 前缀）经账号 entitlement
//     门控，外部 spawn 的 app-server 注册表只装载个人 provider（实测：显式引用
//     plan 家族任何 id 一律 Provider Registry 拒绝；个人 provider 的 provider/model
//     组合可用）。旧源 v2 config.json 的 provider 条目（builtin: plan 家族 + 过期
//     UUID 清单）与注册表实况不符，不作为校验源；
//   - **缺席模型（task.model 空）= 返回空串**：create 帧省略 model 键，交给 CLI
//     自身缺省解析（实测落到 providerOrder 首位的可用模型并自动补齐 reasoning
//     档位）——不再伪造 plan 家族兜底 id（该 id 在注册表侧已不可用）；
//   - 凭据缺失/模型不可解析抛结构化 ZcodePrepareError（错误码对齐设计 §3.3.3：
//     engine_credential_missing / model_not_available），一律先于进程创建。
//   - 显式模型的 reasoningLevel：注册表模型普遍要求 options.reasoningLevel（值域
//     per-model，见内建目录 modelConfigRules）——本文件提供
//     locateZcodeBuiltinCatalog（目录定位：显式 sources > env > runtime/provider
//     扫描）与 resolveZcodeMinimalReasoningLevel（modelRules 匹配 modelId 值域取
//     最小档）；引擎 run 期调用并经 buildAppServerCreateParams 附 create 帧。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveEngineDataDir } from "@zhushanwen/subagent-engine-sdk";

import {
  ZCODE_PERSONAL_PROVIDER_CONFIG_PATH_SUFFIX,
  ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS,
  ZCODE_V2_CONFIG_PATH_SUFFIX,
} from "./constants.ts";

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

/**
 * 副本语境恢复指引（全部 throw 文案的公共尾句——engine-provider-unification §5
 * 单元 3 文案修复）：既有指引一律指向 ZCode 桌面端，对读 taiji 同步副本的场景
 * （条目来自 pi 侧映射/让位）与失效默认模型偏好（settings 偏好事后失效被显式
 * 报错，无自动清理）两个场景都错位——本句把这两个场景的恢复动作指向 taiji 侧。
 */
const TAIJI_SYNC_GUIDANCE =
  "若使用 taiji 同步副本/默认模型，到 taiji settings 核对或重选，重启 taiji 生效。";

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
 * 读个人 provider 源 JSON（~/.zcode/v2/provider_config.json——GUI 管理面写入、
 * app-server 注册表实际装载的 provider 清单）。文件缺失/损坏/非对象 → undefined
 * （消费方语义：直读形态 = 空源，凭据检查给出 engine_credential_missing 的
 * fail-fast；merge 形态 = 该侧缺席，由 merge 规则裁决）。
 */
function readSourceJsonOrUndefined(absPath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * 解析后的 provider_config JSON → SourceConfig（providerRules 逐条归并 + order
 * 提取；非对象/损坏 → 空源——不在此处吞成静默空表，凭据检查会 fail-fast）。
 */
function extractSourceConfig(parsed: unknown): SourceConfig {
  const conf: SourceConfig = { providers: new Map(), order: [] };
  if (!isRecord(parsed)) return conf;
  const config = parsed["config"];
  if (!isRecord(config)) return conf;
  conf.order = strArray(config["providerOrder"]);
  const rules = config["providerConfigRules"];
  const providerRules = isRecord(rules) ? rules["providerRules"] : undefined;
  if (Array.isArray(providerRules)) collectProviderRules(providerRules, conf);
  return conf;
}

/** 单文件直读形态（显式源 / 回落真实文件——无 merge）。 */
function readSourceConfig(absPath: string): SourceConfig {
  return extractSourceConfig(readSourceJsonOrUndefined(absPath));
}

// ============================================================
// merge 视图（D3 换轨：真实文件实时内容 + taiji 同步副本——两消费方同一视图）
// ============================================================

/**
 * merge(真实, 副本)——provider_config.json 的 D3 换轨合并视图，与 appserver-launcher
 * 内嵌 mergeProviderConfig 同规则对账锁步（改任一侧须同步另一侧并跑对账单测）：
 *   - 副本非对象 → 原样返回 real（副本缺席回落语义——wrapper 侧更早短路回原文件
 *     字节，本分支是 TS 读链的等价回落）；
 *   - 真实非对象（ENOENT/损坏）→ 原样返回 copy（副本独有条目为全集：providerRules
 *     仅副本条目 + order 仅副本序，顶层字段随副本保持形态完整）；
 *   - providerRules：真实条目整条保留在前，副本独有 id 追加（真实优先 = 同名让位
 *     的运行时第二道防线）；无有效 providerId 的副本条目丢弃，真实条目原样保留；
 *   - providerOrder：真实现值序 + 副本独有 id 追加（去重保序）；
 *   - 其余字段（含 config 内其他键）取真实现值。
 * 纯函数无 IO——调用方每次读取现读现算（事实驱动，禁缓存/时间窗）。
 */
export function mergePersonalProviderConfig(realObj: unknown, copyObj: unknown): unknown {
  if (!isRecord(copyObj)) return realObj;
  if (!isRecord(realObj)) return copyObj;
  const cfgOf = (obj: Record<string, unknown>): Record<string, unknown> =>
    isRecord(obj["config"]) ? obj["config"] : {};
  const rulesOf = (obj: Record<string, unknown>): unknown[] => {
    const pcr = cfgOf(obj)["providerConfigRules"];
    const rules = isRecord(pcr) ? pcr["providerRules"] : undefined;
    return Array.isArray(rules) ? rules : [];
  };
  const mergedRules: unknown[] = [];
  const seen = new Set<string>();
  for (const rule of rulesOf(realObj)) {
    mergedRules.push(rule);
    if (isRecord(rule)) {
      const id = rule["providerId"];
      if (typeof id === "string" && id !== "") seen.add(id);
    }
  }
  for (const rule of rulesOf(copyObj)) {
    if (!isRecord(rule)) continue;
    const id = rule["providerId"];
    if (typeof id !== "string" || id === "") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    mergedRules.push(rule);
  }
  const mergedOrder: string[] = [];
  for (const id of [...strArray(cfgOf(realObj)["providerOrder"]), ...strArray(cfgOf(copyObj)["providerOrder"])]) {
    if (!mergedOrder.includes(id)) mergedOrder.push(id);
  }
  const realCfg = cfgOf(realObj);
  const realPcr = isRecord(realCfg["providerConfigRules"]) ? realCfg["providerConfigRules"] : {};
  return {
    ...realObj,
    config: {
      ...realCfg,
      providerOrder: mergedOrder,
      providerConfigRules: { ...realPcr, providerRules: mergedRules },
    },
  };
}

/** [readSourceConfig 拆分] providerRules 逐条归并（id 键守卫 + access/personalModelIds
 * 形态窄化，非法条跳过）。 */
function collectProviderRules(providerRules: readonly unknown[], conf: SourceConfig): void {
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
  /**
   * 个人 provider 注册表源（app-server 注册表对齐）——显式定型，直读指定路径
   * （绕过副本 merge 视图与回落）。缺省走 readPersonalProviderView 的默认读链
   * （副本存在 → merge 视图；缺失 → 回落真实文件）。
   */
  personalProviderConfigPath?: string;
  /** launcher 凭据注入的 v2 config 源（ZCODE_ENG_V2_CONFIG 消费——凭据供数面，与模型校验源无关）。缺省 ~/.zcode/v2/config.json。 */
  v2ConfigPath?: string;
  /** 内建 provider 目录源（reasoningLevel 值域解析）。缺省按 runtime/provider 目录扫描（与 launcher 同型）。 */
  builtinCatalogPath?: string;
}

export function defaultPersonalProviderConfigPath(): string {
  return path.join(os.homedir(), ...ZCODE_PERSONAL_PROVIDER_CONFIG_PATH_SUFFIX);
}

/** launcher 凭据注入的 v2 config 缺省路径（ZCODE_ENG_V2_CONFIG 消费，与模型校验源无关）。 */
export function defaultV2ConfigPath(): string {
  return path.join(os.homedir(), ...ZCODE_V2_CONFIG_PATH_SUFFIX);
}

/** taiji 同步副本绝对路径（<engineDataDir>/engines/zcode/pi-synced-provider-config.json）。 */
export function piSyncedProviderConfigPath(engineDataDir: string): string {
  return path.join(engineDataDir, ...ZCODE_PI_SYNCED_PROVIDER_CONFIG_SEGMENTS);
}

/**
 * env 推导的引擎数据目录（与 registration.ts defaultEngineDataDir 同源——
 * resolveEngineDataDir(process.env)）。缺 env 且无 fallback 时该函数抛错（standalone
 * 裸跑形态）——此时副本无定位点，捕获为 undefined 走真实文件回落：宿主内运行 env
 * 恒注入（生产不可达分支），裸跑形态本就没有 taiji 同步副本可言。
 */
function envEngineDataDirOrUndefined(): string | undefined {
  try {
    return resolveEngineDataDir(process.env);
  } catch {
    return undefined;
  }
}

/**
 * 三态链的结构化解析结果（读取语义分形态——路径函数与 merge 视图读链共用同一条链，
 * 回落判定点单点）：
 *   - explicit：显式定型，直读指定路径（绕过 merge——生产 deps.sources 恒 undefined
 *     不走此分支）；
 *   - copy：taiji 同步副本存在——读取语义 = merge(真实实时内容, 副本) 视图（realPath
 *     为 merge 第二源）；
 *   - real：副本缺失回落真实文件直读。
 */
type PersonalProviderResolution =
  | { kind: "explicit"; path: string }
  | { kind: "copy"; path: string; realPath: string }
  | { kind: "real"; path: string };

function resolvePersonalProviderSource(sources?: ZcodeSourcePaths, engineDataDir?: string): PersonalProviderResolution {
  const explicit = sources?.personalProviderConfigPath;
  if (explicit !== undefined) return { kind: "explicit", path: explicit };
  const dataDir = engineDataDir ?? envEngineDataDirOrUndefined();
  if (dataDir !== undefined && fs.existsSync(piSyncedProviderConfigPath(dataDir))) {
    return { kind: "copy", path: piSyncedProviderConfigPath(dataDir), realPath: defaultPersonalProviderConfigPath() };
  }
  return { kind: "real", path: defaultPersonalProviderConfigPath() };
}

/**
 * 个人 provider 校验源路径解析（engine-provider-unification D3 锚点扩链；两消费方
 * 同锚——zcode-engine 的 ZCODE_ENG_PROVIDER_CONFIG env 赋值走本函数〔D3 换轨后
 * 语义收窄 = taiji 同步副本路径；副本缺失回落真实路径〕，校验链读取走
 * readPersonalProviderView 的 merge 视图，禁止各自拼路径）。每次调用现读存在性
 * （无缓存）——副本落盘/删除对下一次解析即时生效。
 *
 * @param engineDataDir 引擎数据目录（zcode-engine 侧传 deps.engineDataDir() 的
 *   DI 值；缺席时按 env 推导——生产两通道同值）
 */
export function resolvePersonalProviderConfigPath(sources?: ZcodeSourcePaths, engineDataDir?: string): string {
  return resolvePersonalProviderSource(sources, engineDataDir).path;
}

/** 校验链读取结果：SourceConfig + 诊断面已读源描述（merge 视图 = 双路径）。 */
interface PersonalProviderView {
  conf: SourceConfig;
  sourceDesc: string;
}

/**
 * 校验链读取入口（resolveZcodeModelRef/listZcodeModels 的单一读源）：三态链
 * copy 分支读 merge(真实, 副本) 视图，其余形态单文件直读。副本与 wrapper 拦截
 * 分支同一 merge 规则（mergePersonalProviderConfig）——两消费方（校验链/CLI
 * Provider Registry）看到同一视图。每次调用现读现合并（无缓存）。
 */
function readPersonalProviderView(sources?: ZcodeSourcePaths): PersonalProviderView {
  const resolution = resolvePersonalProviderSource(sources);
  if (resolution.kind !== "copy") {
    return { conf: readSourceConfig(resolution.path), sourceDesc: resolution.path };
  }
  const copyJson = readSourceJsonOrUndefined(resolution.path);
  const realJson = readSourceJsonOrUndefined(resolution.realPath);
  return {
    conf: extractSourceConfig(mergePersonalProviderConfig(realJson, copyJson)),
    sourceDesc: `merge(真实 ${resolution.realPath} + 副本 ${resolution.path})`,
  };
}

// ============================================================
// reasoningLevel 值域（内建目录 modelRules——create 帧 options 的供数面）
// ============================================================

/** semver 数值比较覆盖的版本段数（major.minor.patch）。 */
const SEMVER_SEGMENTS = 3;

/**
 * 定位内建 provider 目录文件（zcode-builtin.json）。优先级：显式 sources >
 * ZCODE_BUILTIN_PROVIDER_CONFIG_FILE env（launcher/宿主注入）> runtime/provider
 * 目录扫描（平台目录 × semver 最大 × endpoint-*，与 appserver-launcher 的派生
 * 同型——CLI 侧路径推导在 app 布局下不可用，外部 spawn 必须供数）。找不到返回
 * undefined（reasoningLevel 解析降级为不携带，create 遇必需模型由对端报错）。
 */
export function locateZcodeBuiltinCatalog(sources?: ZcodeSourcePaths): string | undefined {
  if (sources?.builtinCatalogPath !== undefined) return sources.builtinCatalogPath;
  const fromEnv = process.env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const providerRoot = path.join(os.homedir(), ".zcode", "v2", "runtime", "provider");
    const prefix = `${process.platform}-`;
    const platDirs = fs
      .readdirSync(providerRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
      .map((d) => d.name);
    const byVerDesc = (a: string, b: string): number => {
      const pa = a.split(".");
      const pb = b.split(".");
      for (let i = 0; i < SEMVER_SEGMENTS; i++) {
        const na = Number.parseInt(pa[i] ?? "", 10) || 0;
        const nb = Number.parseInt(pb[i] ?? "", 10) || 0;
        if (na !== nb) return nb - na;
      }
      return 0;
    };
    for (const plat of platDirs) {
      const rtRoot = path.join(providerRoot, plat);
      let versions: string[] = [];
      try {
        versions = fs.readdirSync(rtRoot).filter((v) => /^\d+\.\d+/.test(v)).sort(byVerDesc);
      } catch {
        continue;
      }
      for (const ver of versions) {
        const verDir = path.join(rtRoot, ver);
        let endpoints: string[] = [];
        try {
          endpoints = fs.readdirSync(verDir).filter((e) => e.startsWith("endpoint-")).sort();
        } catch {
          continue;
        }
        for (const ep of endpoints) {
          const candidate = path.join(verDir, ep, "zcode-builtin.json");
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
  } catch {
    /* 目录缺失（~/.zcode 未初始化等）→ 走缺省 undefined */
    return undefined;
  }
  return undefined;
}

/**
 * 解析模型的最小 reasoning 档（create 帧 model.options.reasoningLevel 供数）。
 * 目录 modelConfigRules.modelRules 的 modelMatch 逐条正则匹配 modelId，取**最末**
 * 带值域的匹配规则（特异规则在后覆盖通配 `.*`，与目录条目序的覆盖直觉一致），
 * 返回其 values[0]（各家族首值均为最小档：disabled/low/none——显式模型不携带
 * options 时对端对必需模型直接拒收，值域供数使显式模型可用且默认轻推理）。
 * 目录缺失/无匹配/无值域 → undefined（不携带，行为与未实现等价）。
 */
export function resolveZcodeMinimalReasoningLevel(modelRef: string, sources?: ZcodeSourcePaths): string | undefined {
  const catalogPath = locateZcodeBuiltinCatalog(sources);
  if (catalogPath === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  } catch {
    return undefined;
  }
  const modelId = modelShort(modelRef);
  const rules = (parsed as Record<string, unknown>)["config"];
  const modelRules =
    isRecord(rules) && isRecord(rules["modelConfigRules"])
      ? rules["modelConfigRules"]["modelRules"]
      : undefined;
  if (!Array.isArray(modelRules)) return undefined;
  return lastMatchingReasoningValues(modelRules, modelId)?.[0];
}

/** [resolveZcodeMinimalReasoningLevel 拆分] 末个匹配 modelMatch 的
 * reasoningLevel.values（regex 编译失败/无值域的条目跳过，后写覆盖前写）。 */
function lastMatchingReasoningValues(modelRules: readonly unknown[], modelId: string): string[] | undefined {
  let values: string[] | undefined;
  for (const rule of modelRules) {
    if (!isRecord(rule)) continue;
    const match = rule["modelMatch"];
    if (typeof match !== "string") continue;
    let re: RegExp;
    try {
      re = new RegExp(match);
    } catch {
      continue;
    }
    if (!re.test(modelId)) continue;
    const spec = (rule["config"] as Record<string, unknown> | undefined)?.["optionSpecs"];
    const level = isRecord(spec) ? spec["reasoningLevel"] : undefined;
    const vals = isRecord(level) ? strArray(level["values"]) : [];
    if (vals.length > 0) values = vals;
  }
  return values;
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
  const { conf, sourceDesc } = readPersonalProviderView(sources);
  const withKey = [...conf.providers.entries()].filter(([, e]) => hasApiKey(e));
  const wanted = requested?.trim() || undefined;

  if (withKey.length === 0) {
    const hint = wanted ? `model="${wanted}" 不能校验` : "缺省模型解析不能校验";
    throw new ZcodePrepareError(
      "engine_credential_missing",
      `zcode 引擎找不到任何带 apiKey 的个人 provider（${hint}）。已读源：${sourceDesc}。` +
        `恢复指引：在 ZCode 桌面端配置至少一个个人 provider（provider_config.json 内存在` +
        ` config.access.apiKey 非空条目）后重试；plan 套餐族（builtin:/account: 前缀）经账号` +
        ` entitlement 门控，外部 spawn 的引擎注册表不装载，不可作为引擎模型。` +
        TAIJI_SYNC_GUIDANCE,
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
        ` provider 后重试；省略 model 参数则走引擎缺省解析（CLI 自身选取可用模型）。` +
        TAIJI_SYNC_GUIDANCE,
    );
  }
  if (!hasApiKey(entry)) {
    throw new ZcodePrepareError(
      "engine_credential_missing",
      `provider "${provider}" 存在但未配置 apiKey。` +
        `恢复指引：在 ZCode 桌面端为该 provider 配置凭据，或改用已配凭据的 provider` +
        `（${withKey.map(([id]) => id).join(", ")}）后重试。` +
        TAIJI_SYNC_GUIDANCE,
    );
  }
  const models = entry.models ?? [];
  if (models.length > 0 && !models.includes(short)) {
    throw new ZcodePrepareError(
      "model_not_available",
      `未知模型 "${short}"（provider ${provider} 下可用: ${models.join(", ")}）。` +
        `恢复指引：改用该 provider 下的模型，或在 ZCode 桌面端启用目标模型后重试。` +
        TAIJI_SYNC_GUIDANCE,
    );
  }
  return `${provider}/${short}`;
}

// ============================================================
// 模型清单（U7 可发现性——provider_config 单源聚合，与 resolveZcodeModelRef 的凭据校验同判据）
// ============================================================

/**
 * 列出当前环境 zcode 引擎实际可用的模型（readPersonalProviderView 解析的校验源内
 * 带 apiKey 的个人 provider × 其模型清单——副本存在时即 merge 视图聚合，与
 * app-server 注册表的装载实况一致）。消费方：EnginePort.listModels（system prompt
 * 引擎段 / GUI）。失败安全：源不可读 → 空清单（可发现性降级不阻塞主流程）。
 */
export function listZcodeModels(sources?: ZcodeSourcePaths): Array<{ id: string; name?: string }> {
  const { conf } = readPersonalProviderView(sources);
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
