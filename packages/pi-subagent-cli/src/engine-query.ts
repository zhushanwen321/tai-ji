// src/engine-query.ts
//
// pi 引擎查询面（pi-workflow-run-resource-model §3.3 决策 11，方案 B）：listModels /
// validateModel 的引擎侧实装——读 pi 数据目录（agentDir）下的四个 json（models.json /
// models-store.json / settings.json / auth.json），纯文件读取、零新依赖、不 spawn pi
// 进程、不 import pi 包本体。
//
// 定性 = 可选诊断面：pi 被显式排除在引擎级模型校验外（core validateModelForEngine
// 对 pi 原样放行，走派发期对称路径），宿主对 cli 形态引擎的同步成员读 manifest 快照、
// 不经本协议通道——本查询面服务诊断用途（协议 listModels/validateModel 应答的真实
// 数据面），失败按辅助功能降级纪律处置（读面 warn 降级不抛断链；裁决面返回结构化
// 错误 EngineSdkError）。
//
// 数据面边界（设计内知情取舍，决策 11）：清单 = pi 数据目录配置面可见的模型
// （models.json 静态声明 ∪ models-store.json 远程 catalog 缓存），不含 pi 内置
// provider 的编译期模型定义（那需要 import pi 包本体，被方案 B 明文排除）。
//
// 文件格式对齐 pi 0.84.x 实装版（node_modules dist 核实）：
//   models.json        = { providers: { <providerId>: { name?, apiKey?, models?: [{id, name?}] } } }
//   models-store.json  = { <providerId>: { models: [{id, ...}], checkedAt, lastModified, etag } }
//   settings.json      = { defaultProvider?, defaultModel?, ... }
//   auth.json          = { <providerId>: Credential }（凭据文件——只取键集判定
//                        「provider 已配置凭据」，不读凭据值本身）

import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EngineSdkError, getLogger } from "@zhushanwen/subagent-engine-sdk";

const logger = getLogger("pi-engine-query");

/** pi agent 目录 env 名（pi 上游 ENV_AGENT_DIR 实装值）。 */
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** 清单条目形态（协议 ListModelsResult.models 元素的结构等价面）。 */
export interface PiModelEntry { // oe-exempt:20260927:framework:pi 数据目录查询面的清单条目契约——ports 接口先立、单实现常态（决策 11 查询面交付形态）
  /** 模型全 ref（`<providerId>/<modelId>`——pi 模型 ref 通行形态）。 */
  id: string;
  /** 显示名（数据文件声明时携带）。 */
  name?: string;
}

/**
 * 解析 pi agent 目录（对齐 pi 上游 getAgentDir 惯例）：env `PI_CODING_AGENT_DIR`
 * 优先（taiji 托管形态下宿主注入的托管目录——薄壳 env 经 manifest envPrefixes
 * PI_ 白名单继承，孙进程 pi 同源消费，判定输入恒一致），缺省 = 系统独立 pi 的
 * `~/.pi/agent`（os.homedir() 动态推导，禁硬编码绝对路径）。
 */
export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[PI_AGENT_DIR_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return path.join(os.homedir(), ".pi", "agent");
}

/** 读 + JSON 解析（文件不存在 = undefined 空源；存在但坏 = null 标记 + warn）。 */
function readJsonSource(source: string, filePath: string): Record<string, unknown> | undefined | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    logger.warn(`[engine-query] pi ${source} unreadable (ignoring this source): ${String((err as Error)?.message ?? err)}`);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logger.warn(`[engine-query] pi ${source} is not a JSON object (ignoring this source)`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    logger.warn(`[engine-query] pi ${source} is not valid JSON (ignoring this source): ${String((err as Error)?.message ?? err)}`);
    return null;
  }
}

/** unknown 键集收窄：对象的 string 键集（其余形态 = 空）。 */
function stringKeysOf(value: unknown): Set<string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return new Set();
  return new Set(Object.keys(value as Record<string, unknown>));
}

/**
 * 凭据 provider 集合：auth.json 键集（登录写入）∪ models.json 内联 apiKey 声明的
 * provider。env key 凭据通道不查（出了「纯文件读取」的声明边界，诊断面不猜 env 状态）。
 */
function credentialedProviderIds(auth: Record<string, unknown> | undefined | null, configured: Set<string>): Set<string> {
  return new Set([...stringKeysOf(auth), ...configured]);
}

/** 单条模型条目解析：id 非非空 string 丢弃（warn）；name 非串丢弃 name。 */
function parseModelEntry(source: string, providerId: string, raw: unknown): PiModelEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    logger.warn(`[engine-query] pi ${source}: provider '${providerId}' has a non-object model entry — dropping entry`);
    return undefined;
  }
  const v = raw as Record<string, unknown>;
  const id = v["id"];
  if (typeof id !== "string" || id.trim() === "") {
    logger.warn(`[engine-query] pi ${source}: provider '${providerId}' model entry missing string id — dropping entry`);
    return undefined;
  }
  const name = v["name"];
  return { id: `${providerId}/${id}`, ...(typeof name === "string" && name.trim() !== "" ? { name } : {}) };
}

/** 单 provider 的 models 数组解析（models 缺失/非数组 = 空）。 */
function parseProviderModels(source: string, providerId: string, provider: unknown): PiModelEntry[] {
  if (typeof provider !== "object" || provider === null) return [];
  const models = (provider as Record<string, unknown>)["models"];
  if (!Array.isArray(models)) return [];
  const entries: PiModelEntry[] = [];
  for (const item of models) {
    const entry = parseModelEntry(source, providerId, item);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/**
 * pi 数据目录的模型清单（诊断面）。
 *
 * 数据源与合并：models.json providers 为静态基线，models-store.json（远程 catalog
 * 缓存，键 = providerId）为动态面——同 id 动态条目覆盖基线（对齐 pi mergeModels
 * 语义）；输出按 provider 键序 + 声明序稳定排列。
 *
 * 凭据过滤：只保留「已配置凭据」provider 的模型（对齐 core 侧清单文案
 * 「models with configured credentials」与 zcode listModels 语义）。
 *
 * 返回三态（消费方 model-prompt 的 null/[] 语义分野）：
 *   null = 无枚举面（models.json 与 models-store.json 都不存在）；
 *   []   = 有配置面但无凭据模型（buildEmptyModelsHint 的「无凭据模型」语义）；
 *   非空  = 清单。文件损坏/形态坏按源降级（warn 留痕，辅助功能不抛断链）。
 */
export function listPiModels(agentDir: string): PiModelEntry[] | null {
  const modelsFile = readJsonSource("models.json", path.join(agentDir, "models.json"));
  const storeFile = readJsonSource("models-store.json", path.join(agentDir, "models-store.json"));
  if (modelsFile === undefined && storeFile === undefined) return null;

  const providersRaw = modelsFile?.["providers"];
  const providers: Record<string, unknown> =
    typeof providersRaw === "object" && providersRaw !== null && !Array.isArray(providersRaw)
      ? (providersRaw as Record<string, unknown>)
      : {};

  // 内联 apiKey（models.json provider 配置字段）也是凭据形态之一。
  const inlineKeyProviders = new Set(
    Object.entries(providers)
      .filter(([, p]) => {
        const apiKey = typeof p === "object" && p !== null ? (p as Record<string, unknown>)["apiKey"] : undefined;
        return typeof apiKey === "string" && apiKey.trim() !== "";
      })
      .map(([id]) => id),
  );
  const authFile = readJsonSource("auth.json", path.join(agentDir, "auth.json"));
  const credentialed = credentialedProviderIds(authFile, inlineKeyProviders);

  // 基线（声明序）与动态面（覆盖同 id）分池合并，再按凭据集过滤。
  const byProvider = new Map<string, PiModelEntry[]>();
  for (const [providerId, provider] of Object.entries(providers)) {
    byProvider.set(providerId, parseProviderModels("models.json", providerId, provider));
  }
  for (const [providerId, entry] of Object.entries(storeFile ?? {})) {
    const dynamic = parseProviderModels("models-store.json", providerId, entry);
    const baseline = byProvider.get(providerId) ?? [];
    const merged = new Map(baseline.map((m) => [m.id, m]));
    for (const m of dynamic) merged.set(m.id, m); // 动态覆盖同 id（pi mergeModels 语义）
    byProvider.set(providerId, [...merged.values()]);
  }

  const out: PiModelEntry[] = [];
  for (const [providerId, entries] of byProvider) {
    if (!credentialed.has(providerId)) continue;
    out.push(...entries);
  }
  return out;
}

/**
 * pi 模型 ref 校验（诊断面裁决）。
 *
 * - modelRef 缺席/空 = 查引擎缺省模型：settings.json 的 defaultProvider +
 *   defaultModel 拼全 ref（pi /model 选择持久化的宿主级缺省）；均未配置 =
 *   engine_model_unknown（pi 无编译期缺省模型语义——运行期「继承主 agent」，无
 *   静态 canonical 形态可答）。
 * - 有值 ref = 清单 id 全等匹配（命中 → canonicalRef = 全 ref）；清单无枚举面或
 *   未命中 → engine_model_unknown（诊断面如实裁决，不做模糊匹配——对齐 RemoteEngine
 *   matchCatalogEntry 的零宽容口径）。
 */
export function validatePiModel(modelRef: string | undefined, agentDir: string): { canonicalRef: string } {
  const ref = modelRef?.trim();
  if (ref === undefined || ref === "") {
    const settings = readJsonSource("settings.json", path.join(agentDir, "settings.json"));
    const defaultProvider = settings?.["defaultProvider"];
    const defaultModel = settings?.["defaultModel"];
    const provider = typeof defaultProvider === "string" && defaultProvider.trim() !== "" ? defaultProvider.trim() : undefined;
    const model = typeof defaultModel === "string" && defaultModel.trim() !== "" ? defaultModel.trim() : undefined;
    if (provider !== undefined && model !== undefined) return { canonicalRef: `${provider}/${model}` };
    if (model !== undefined) return { canonicalRef: model };
    throw new EngineSdkError(
      "engine_model_unknown",
      "pi has no engine-default model: settings.json declares neither defaultProvider nor defaultModel",
      `Run \`pi /model\` to pick a default (persists to settings.json), or dispatch with an explicit model ref from \`listModels\`.`,
    );
  }

  const models = listPiModels(agentDir);
  const entry = models?.find((m) => m.id === ref);
  if (entry !== undefined) return { canonicalRef: entry.id };
  throw new EngineSdkError(
    "engine_model_unknown",
    `model '${ref}' is not in the pi model list (data-dir sources: models.json + models-store.json; ` +
      `built-in provider models are not enumerated by this query surface)`,
    "Retry with an exact `<provider>/<model>` id from `listModels`, or run `pi /model` to configure the provider.",
  );
}
