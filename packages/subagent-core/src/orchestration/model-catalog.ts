/**
 * ModelCatalog —— pi 引擎模型目录（workflow-architecture-redesign D8）。
 *
 * 目录 = 宿主 Provider Registry 投影（pi 引擎可用模型空间）：pi SDK 在 session_start
 * 把 `ctx.modelRegistry` 注入 ModelConfigService（宿主注入通道，H2/P5 同款先例——
 * extension 不 import runtime 模块），本模块是这套注册表之上的**分类化裁决投影**。
 *
 * 两层挂点（D8 挂点分层）：
 *   ① 创建期（工具同步期）：工具参数 model（agent 资产 frontmatter model 无静态
 *      可得面——WorkflowMeta 无 model 字段，脚本 JS 动态求值不可静态解析）——
 *      resolve 失败 = run 创建失败，零 spawn 零 token。
 *   ② 派发期（identity 解析阶段）：脚本内 agent({model}) 字面量 / agent ref 的
 *      frontmatter model——挂 workflow-dispatch 的 isPiRoute 分流点（与非 pi 引擎
 *      validateModelForEngine 对称），失败 = 该 ask 派发前报错。
 *
 * 与 shared/model-ref 的关系（单一权威，不复制裁决逻辑）：命中判定复用
 * assertCanonicalModelRef 的同一全等谓词（provider 精确 + id 全等含大小写 +
 * `:thinking` 后缀 strip）；本模块只补 **漂移分类**（查无 vs provider 配置漂移）——
 * 大小写孪生守卫不在此复制（防双实现漂移），由派发期 identity 解析的
 * assertCanonicalModelRef 全量裁决兜住（孪生输入创建期放行 → 首 ask 派发前仍被拒，
 * 拒单时机语义不变）。
 *
 * 范围限定（用户裁决 2026-09-21）：仅 pi 引擎 run；zcode 引擎的模型空间（builtin:*
 * 套餐族）是 zcode 派发域概念，本期跳过校验不误拒。
 */

import { stripThinkingSuffix } from "../shared/model-ref.ts";

/** 报错信息中列出的可用模型上限（防超长错误信息；与 shared/model-ref 同量级口径）。 */
const MODEL_LIST_LIMIT = 20;

/** 目录条目（ModelRegistryLike.getAvailable() 元素的结构子集，duck-typed 可 mock）。 */
export interface ModelCatalogEntry {
  provider: string;
  id: string;
}

/** 模型清单源的最小 duck 接口（ModelRegistryLike 结构兼容——getAvailable 只含已配鉴权模型）。 */
export interface ModelCatalogSource {
  getAvailable(): ReadonlyArray<ModelCatalogEntry>;
}

/** 未命中分类（D8 分类修复指引）：查无（输入侧可修）vs provider 配置漂移（配置侧可修）。 */
export type ModelCatalogMissClassification = "not_found" | "provider_drift";

/** 命中：与目录条目全等的 (provider, id)。 */
export interface ModelCatalogHit {
  ok: true;
  provider: string;
  id: string;
}

/** 未命中：分类 + 分类化错误全文（调用方直接用作 Error message）。 */
export interface ModelCatalogMiss {
  ok: false;
  classification: ModelCatalogMissClassification;
  input: string;
  message: string;
}

export type ModelCatalogResolution = ModelCatalogHit | ModelCatalogMiss;

/** 来源标签（进错误首行辅助定位，与 shared/model-ref 的 opts.source 同口径）。 */
export interface ModelCatalogOptions {
  source?: string;
}

/**
 * 模型串 → 目录裁决（不抛错，纯投影）。命中判定与 shared/model-ref 的
 * assertCanonicalModelRef 同一谓词（provider 精确 + id 全等 + thinking 后缀 strip；
 * 一致性由 model-catalog 单测的「无孪生 registry 下两裁决逐输入等价」用例机器锁定）。
 */
export function resolveModelInCatalog(
  input: string,
  source: ModelCatalogSource,
  opts: ModelCatalogOptions = {},
): ModelCatalogResolution {
  const available = source.getAvailable();
  const clean = stripThinkingSuffix(input.trim());
  const slashIdx = clean.indexOf("/");
  const provider = slashIdx > 0 ? clean.slice(0, slashIdx) : "";
  const id = slashIdx > 0 ? clean.slice(slashIdx + 1) : "";

  if (provider.length > 0 && id.length > 0) {
    const exact = available.find((m) => m.provider === provider && m.id === id);
    if (exact !== undefined) {
      return { ok: true, provider: exact.provider, id: exact.id };
    }
  }
  return classifyMiss(input, provider, id, available, opts.source);
}

/**
 * 未命中分类（D8 分类修复指引）：
 * - provider_drift：目录空（无任何 provider 有已鉴权模型）或输入的 provider 不在
 *   目录——provider 退役/改名/auth 配置缺失，修复在配置侧（pi agent dir 的
 *   models.json），列可用清单辅助改选。
 * - not_found：provider 在目录但 id 查无，或输入非 "provider/modelId" 规范形——
 *   修复在输入侧，列全部可用 id。
 */
function classifyMiss(
  input: string,
  provider: string,
  id: string,
  available: ReadonlyArray<ModelCatalogEntry>,
  source: string | undefined,
): ModelCatalogMiss {
  const prefix = source ? ` (${source})` : "";
  const providers = new Set(available.map((m) => m.provider));
  let classification: ModelCatalogMissClassification;
  let firstLine: string;
  if (provider.length === 0 || id.length === 0) {
    classification = "not_found";
    firstLine =
      `Model "${input}"${prefix} is not a canonical model ref — expected ` +
      `"provider/modelId" format (case-sensitive, must equal a catalog entry exactly).`;
  } else if (providers.size === 0) {
    classification = "provider_drift";
    firstLine =
      `Model "${input}"${prefix} cannot be resolved: the pi engine model catalog is empty ` +
      `(no provider has configured/authenticated models — provider configuration drift).`;
  } else if (!providers.has(provider)) {
    classification = "provider_drift";
    firstLine =
      `Model "${input}"${prefix} cannot be resolved: provider "${provider}" has no models in ` +
      `the pi engine model catalog (provider retired, renamed, or its config/auth is missing — ` +
      `provider configuration drift).`;
  } else {
    classification = "not_found";
    firstLine =
      `Model "${input}"${prefix} is not in the pi engine model catalog: provider ` +
      `"${provider}" is configured but has no model "${id}".`;
  }

  const lines = [firstLine];
  if (available.length === 0) {
    lines.push(`Available models: (none)`);
  } else {
    lines.push(`Available models:`);
    for (const full of available
      .slice(0, MODEL_LIST_LIMIT)
      .map((m) => `${m.provider}/${m.id}`)) {
      lines.push(`  ${full}`);
    }
    if (available.length > MODEL_LIST_LIMIT) {
      lines.push(`  … and ${available.length - MODEL_LIST_LIMIT} more`);
    }
  }
  lines.push(
    classification === "provider_drift"
      ? `Recovery: restore the provider configuration (models.json under the pi agent dir), ` +
        `or retry with an exact entry from the list, or omit the model param to inherit the main agent model.`
      : `Recovery: retry with an exact entry from the list (case-sensitive), ` +
        `or omit the model param to inherit the main agent model.`,
  );
  return { ok: false, classification, input, message: lines.join("\n") };
}

/**
 * 创建期/派发期共享的拒单入口：命中放行，未命中同步抛分类化错误（零 spawn 零 token
 * ——两挂点都在引擎 run 启动之前）。系统绝不代改输入：不自动纠正、不放行变体。
 */
export function assertModelInCatalog(
  input: string,
  source: ModelCatalogSource,
  opts: ModelCatalogOptions = {},
): ModelCatalogHit {
  const resolution = resolveModelInCatalog(input, source, opts);
  if (resolution.ok) return resolution;
  throw new Error(resolution.message);
}
