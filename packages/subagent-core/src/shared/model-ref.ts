// src/shared/model-ref.ts
//
// [U1 ModelRef 全等裁决] 模型身份的唯一裁决入口（设计 docs/architecture/pi-boundary-reliability.md 附录 D D1/D2）。
//
// 零宽容原则：除「缺省继承主 agent 模型」外，只有与 registry 条目**全等精确匹配（含大小写）**
// 的模型串可放行；模糊匹配（case variant / 包含关系 / provider 相似度）只用于生成报错里的
// 纠错候选，永不参与采纳。系统绝不代改输入——恢复动作始终是「重发修正后的参数」。
//
// 裁决发生在 start 工具调用的同步期（spawn 之前）：放行返回 {provider, id} 供
// `${provider}/${id}` 拼接，未命中/孪生歧义同步抛错。
//
// 背景（D1 证据）：pi CLI 的 tryMatchModel 是 pattern 模糊引擎（id 匹配用 toLowerCase()），
// registry 存在大小写孪生时 canonical 串亦被判歧义作废、落入模糊分支 localeCompare 取最大——
// 因此「扩展侧全等放行」不能独立保证「子进程按此名执行」，孪生守卫必须内建（规则④）。

// ============================================================
// 类型
// ============================================================

/** 裁决产物：registry 全等条目的 (provider, id)，供 `${provider}/${id}` 拼接。 */
export interface ModelRef {
  provider: string;
  id: string;
}

/**
 * 模型清单源的最小 duck 接口（只读 getAvailable）。
 * execution/model-resolver.ts 的 ModelRegistryLike 结构兼容（getAvailable 返回 ModelInfo 超集）。
 */
export interface ModelRefSource {
  getAvailable(): ReadonlyArray<{ provider: string; id: string }>;
}

// ============================================================
// thinking level 白名单（SSOT：原 execution/model-resolver.ts 常量迁入，
// model-resolver re-export 保持既有 import 路径不变）
// ============================================================

/** thinking level 支持顺序（低→高）。spawn 侧 `:level` 后缀仅接受本白名单值。 */
export const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 合法 thinking level 字面量联合（类型层面收窄，裸字符串不可达 spawn 拼接）。 */
export type ThinkingLevel = (typeof THINKING_ORDER)[number];

/** 报错信息中列出的候选/全集模型上限（防超长错误信息）。 */
const MODEL_LIST_LIMIT = 20;

/**
 * 校验 thinkingLevel 属于 THINKING_ORDER 白名单，返回窄化类型。
 *
 * buildSpawnArgs 的 thinkingLevel 参数类型为 ThinkingLevel（白名单联合）——TS 调用方
 * 传非法值编译期即报错；本断言是运行时防线（防 JS 调用方/动态数据绕过类型）。
 * undefined 透传（无显式 level 语义）。
 */
export function assertThinkingLevel(level: string | undefined): ThinkingLevel | undefined {
  if (level === undefined) return undefined;
  const hit = THINKING_ORDER.find((l) => l === level);
  if (hit === undefined) {
    throw new Error(
      `Invalid thinkingLevel "${level}". Allowed values: ${THINKING_ORDER.join(", ")}. ` +
        `Retry with one of the allowed values, or omit the param.`,
    );
  }
  return hit;
}

// ============================================================
// 规则①：strip 合法 thinking 后缀
// ============================================================

/**
 * 剥离模型字符串尾部 ":thinkingLevel" 后缀（如 "ds-pro:xhigh" → "ds-pro"）。
 * 仅匹配合法 thinking level（THINKING_ORDER 白名单），避免误剥 "foo:bar" 这类无关冒号。
 */
export function stripThinkingSuffix(modelStr: string): string {
  // 按长度降序拼正则避免短串误匹配（如 "off" 先于 "o"——白名单无单字符，防御性保留）
  const alt = THINKING_ORDER.slice().sort((a, b) => b.length - a.length).join("|");
  return modelStr.replace(new RegExp(`:(${alt})$`), "");
}

// ============================================================
// 规则④：孪生守卫（两条路径共用）
// ============================================================

/**
 * 收集 registry 中与 (provider, id) case-insensitive 相等但非全等的其他条目
 * （大小写孪生）。判定粒度对齐 pi findExactModelReferenceMatch：provider 精确相等 +
 * id toLowerCase 相等。返回孪生条目的 "provider/id" 全串列表。
 */
function collectCaseVariants(
  provider: string,
  id: string,
  source: ModelRefSource,
): string[] {
  const lowerId = id.toLowerCase();
  return source
    .getAvailable()
    .filter((m) => m.provider === provider && m.id !== id && m.id.toLowerCase() === lowerId)
    .map((m) => `${m.provider}/${m.id}`);
}

/**
 * 规则④孪生守卫错误（D1 文案）。命中全等但 registry 自身含大小写歧义 → 拒绝放行，
 * 恢复动作 = 清理重复条目后重试（输入侧不可控维度，系统不代改 registry）。
 */
function ambiguousVariantError(ref: string, variants: string[]): Error {
  return new Error(
    `Model "${ref}" matches a registry entry exactly, but registry contains ambiguous case variants ` +
      `for ${ref}: [${variants.join(", ")}].\n` +
      `Recovery: remove the duplicate case variant from models.json (or the models-store cache) ` +
      `so exactly one case form remains, then retry with the exact registry string.`,
  );
}

// ============================================================
// 继承路径（D2 豁免口径）：已验证 ModelInfo → ModelRef 包装
// ============================================================

/**
 * ctxModel 继承路径的 ModelRef 包装（D2 豁免口径）。
 *
 * ctxModel 是运行时已验证的 ModelInfo 对象（主 agent 在用），豁免 registry 存在性复查
 * 与 auth 校验——「缺省继承」是输入缺省而非变体放行；但继承产出的 canonical 串与显式
 * 入参走同一个 pi pattern 引擎，**孪生守卫同等适用**（registry 含大小写孪生时拒绝放行）。
 *
 * @throws 孪生歧义时同步抛错（ambiguousVariantError 文案）
 */
export function modelRefFromVerified(
  info: { provider: string; id: string },
  source: ModelRefSource,
): ModelRef {
  const twins = collectCaseVariants(info.provider, info.id, source);
  if (twins.length > 0) {
    throw ambiguousVariantError(`${info.provider}/${info.id}`, [`${info.provider}/${info.id}`, ...twins]);
  }
  return { provider: info.provider, id: info.id };
}

// ============================================================
// 规则⑤：未命中错误（模糊匹配只做建议，绝不采纳）
// ============================================================

/**
 * case variant 候选：provider 精确相等 + id case-insensitive 相等（含跨 registry 的
 * 显式大小写差异）。这是最高置信建议，排首位并标注。
 */
function findCaseVariantSuggestions(
  provider: string,
  id: string,
  source: ModelRefSource,
): string[] {
  const lowerId = id.toLowerCase();
  return source
    .getAvailable()
    .filter((m) => m.provider === provider && m.id.toLowerCase() === lowerId)
    .map((m) => `${m.provider}/${m.id}`);
}

/**
 * 一般模糊候选：id 双向包含 或 provider case-insensitive 双向包含（provider 相似度）。
 * 排除已列入 case variant 的条目。
 */
function findSimilarSuggestions(
  provider: string,
  id: string,
  source: ModelRefSource,
  exclude: ReadonlySet<string>,
): string[] {
  const lowerId = id.toLowerCase();
  const lowerProvider = provider.toLowerCase();
  return source
    .getAvailable()
    .map((m) => `${m.provider}/${m.id}`)
    .filter((full) => {
      if (exclude.has(full)) return false;
      const slashIdx = full.indexOf("/");
      const mProvider = full.slice(0, slashIdx);
      const mId = full.slice(slashIdx + 1);
      const lowerMId = mId.toLowerCase();
      const lowerMProvider = mProvider.toLowerCase();
      return (
        lowerMId.includes(lowerId) ||
        lowerId.includes(lowerMId) ||
        lowerMProvider.includes(lowerProvider) ||
        lowerProvider.includes(lowerMProvider)
      );
    })
    .slice(0, MODEL_LIST_LIMIT);
}

/**
 * [u-h2 D2-4] notFoundError 的结构化标记：编排层（pi 未命中跨引擎反查）据此区分
 * 「pi registry 未命中」与孪生歧义/auth 等其他裁决失败——只有未命中形态做反查。
 */
interface NotFoundMarker {
  refNotFound: true;
  /** 裁决的原始输入串（strip thinking 后缀前的原样值），跨引擎反查的匹配源。 */
  refInput: string;
}

/** 规则⑤未命中错误：问句候选 + 合法串全集（无候选时）+ 继承指引。 */
function notFoundError(
  input: string,
  prefix: string,
  provider: string,
  id: string,
  source: ModelRefSource,
): Error & NotFoundMarker {
  const lines = [
    `Model "${input}"${prefix} is not a registry entry. ` +
      `Registry match is case-sensitive — the string must equal a registry entry exactly, including letter case.`,
  ];

  const caseVariants = id.length > 0 ? findCaseVariantSuggestions(provider, id, source) : [];
  if (caseVariants.length > 0) {
    lines.push(`Did you mean one of these?`);
    for (const full of caseVariants) {
      lines.push(`  ${full}   ← case variant of "${id}"`);
    }
    const similar = findSimilarSuggestions(provider, id, source, new Set(caseVariants));
    if (similar.length > 0) {
      lines.push(`Other models you may have meant (similar id/provider):`);
      for (const full of similar) lines.push(`  ${full}`);
    }
  } else {
    const available = source.getAvailable().map((m) => `${m.provider}/${m.id}`);
    if (available.length === 0) {
      lines.push(`Registry has no available models.`);
    } else {
      const similar = findSimilarSuggestions(provider, id, source, new Set());
      if (similar.length > 0) {
        lines.push(`Other models you may have meant (similar id/provider):`);
        for (const full of similar) lines.push(`  ${full}`);
      } else {
        lines.push(`No similar models found.`);
        lines.push(`Available models:`);
        for (const full of available.slice(0, MODEL_LIST_LIMIT)) lines.push(`  ${full}`);
      }
    }
  }

  lines.push(`Or omit the \`model\` param to inherit the main agent model.`);
  const err = new Error(lines.join("\n")) as Error & NotFoundMarker;
  err.refNotFound = true;
  err.refInput = input;
  return err;
}

// ============================================================
// 单一裁决入口（规则①→⑤）
// ============================================================

/**
 * 模型串 → ModelRef 的唯一裁决入口（D1）。
 *
 * ① strip 合法 thinking 后缀（THINKING_ORDER 白名单）；
 * ② provider 精确匹配（区分大小写）；
 * ③ modelId 与 registry 条目全等精确匹配（含大小写）；
 * ④ 孪生守卫——全等命中后 case-insensitive 复扫 registry，存在孪生条目即拒绝放行；
 * ⑤ 未命中 → 同步抛错，错误含 "Did you mean" 问句候选（case variant 排首位并标注）+
 *    合法串全集（无候选时）+ 「省略 model 继承主 agent」指引。
 *
 * 系统绝不代改输入：不自动纠正、不放行变体、不重试。
 *
 * @param input  调用方原始模型串（"provider/modelId[:thinkingLevel]"）
 * @param source 模型清单源（registry 快照）
 * @param opts.source 可选来源标签（"paramOverride" / "agentConfig"），进错误首行辅助定位
 * @returns 全等 ModelRef（放行即与 registry 条目全等，`${provider}/${id}` 可直接拼接）
 * @throws 未命中 / 孪生歧义时同步抛错（start 工具调用同步期完成裁决）
 */
export function assertCanonicalModelRef(
  input: string,
  source: ModelRefSource,
  opts: { source?: string } = {},
): ModelRef {
  const prefix = opts.source ? ` (${opts.source})` : "";
  const clean = stripThinkingSuffix(input);
  const slashIdx = clean.indexOf("/");
  const provider = slashIdx > 0 ? clean.slice(0, slashIdx) : "";
  const id = slashIdx > 0 ? clean.slice(slashIdx + 1) : "";

  if (provider.length > 0 && id.length > 0) {
    const exact = source
      .getAvailable()
      .find((m) => m.provider === provider && m.id === id);
    if (exact) {
      const twins = collectCaseVariants(exact.provider, exact.id, source);
      if (twins.length > 0) {
        throw ambiguousVariantError(`${exact.provider}/${exact.id}`, [
          `${exact.provider}/${exact.id}`,
          ...twins,
        ]);
      }
      return { provider: exact.provider, id: exact.id };
    }
  }

  throw notFoundError(input, prefix, provider, id, source);
}
