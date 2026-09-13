// src/core/model-resolver.ts
//
// 模型解析（三层）：
//   1. 用户显式 override（tool 参数 model，平铺在 subagent params 顶层）→ registry lookup + auth
//   2. agent .md frontmatter model（agent 作者指定）→ registry lookup + auth
//   3. 主 agent 当前模型（ctx.model）→ 直接透传，无需 lookup
//
// 设计：默认与主 agent 同模型（零配置）。只有「有人显式指定 model」时才查
// registry 做解析 + 鉴权校验。thinkingLevel 同链路，无指定时 undefined。

// [U1 ModelRef 全等裁决] THINKING_ORDER / ThinkingLevel / strip / 裁决入口收拢到
// shared/model-ref.ts（单一权威），此处 re-export 保持既有 import 路径不变
//（subagent-tool / tool-workflow 的 schema 枚举从本模块派生）。
import {
  THINKING_ORDER,
  assertCanonicalModelRef,
  modelRefFromVerified,
} from "../../shared/model-ref";

export { THINKING_ORDER };
export type { ThinkingLevel } from "../../shared/model-ref";

/** 解析失败时错误信息列出的可用模型上限（防超长错误信息）。 */
const MODEL_LIST_LIMIT = 20;

/**
 * ModelRegistry 的最小接口（duck-typed，测试可 mock）。
 * 字段结构与 Pi SDK 的 ctx.modelRegistry 对齐。
 */
export interface ModelRegistryLike {
  /** 返回所有已配置鉴权的可用模型。 */
  getAvailable(): ModelInfo[];
  /** 按 (provider, modelId) 查找。 */
  find(provider: string, modelId: string): ModelInfo | undefined;
  /** 校验模型鉴权是否就绪。 */
  hasConfiguredAuth(model: unknown): boolean;
}

/**
 * 模型信息（registry 返回元素 / ctx.model 鸭子类型兼容）。
 * ctx.model（SDK Model<Api>）是此类型的超集，运行时直接当 ModelInfo 用。
 */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, unknown>;
  contextWindow?: number;
}

/** agent .md frontmatter 解析结果。 */
export interface AgentConfig {
  /** agent 名（文件名 basename）。 */
  name: string;
  /** system prompt（markdown 正文）。 */
  systemPrompt: string;
  /** tool allowlist（三层过滤之一）。 */
  tools?: string[];
  /** 默认模型 override（"provider/modelId"）。agent 作者显式指定。 */
  model?: string;
  /** 默认 thinkingLevel override。 */
  thinkingLevel?: string;
  /** 默认 background 模式（true 时无显式 wait 走 background）。 */
  defaultBackground?: boolean;
  /**
   * 执行引擎 id（agent .md frontmatter engine 字段，D9 per-agent 主通道）。
   * 解析期已对注册表校验（未注册 id 在 agent-registry 抛 EngineNotFoundError）；
   * 执行侧（P4 路由层）按 调用参数 > 本字段 > 全局默认 三层取值。
   */
  engine?: string;
}

/** 解析结果（model 实例 + 生效的 thinkingLevel）。 */
export interface ResolvedModel {
  model: ModelInfo;
  thinkingLevel: string | undefined;
}

// ============================================================
// 常量
// ============================================================

// MODEL_LIST_LIMIT 与 THINKING_ORDER 随 suggestSimilarModels/lookupModel 一并迁入
// shared/model-ref.ts（U1 裁决单一入口）。

// ============================================================
// 解析
// ============================================================

/**
 * 三层模型解析：
 *
 *   ╔═══════════════════════════════════════════════════════════════╗
//   ║  优先级（高→低）:                                              ║
//   ║    1. paramOverride.model      （调用方显式指定，tool 参数）     ║
//   ║    2. agentConfig.model        （agent .md frontmatter）        ║
//   ║    3. ctxModel                 （主 agent 当前模型，直接透传）   ║
//   ║                                                                ║
//   ║  1/2 级查 registry + auth 校验；3 级无需 lookup（主 agent 在用  ║
//   ║  说明 auth OK）。thinkingLevel 无显式指定时兜底「模型最高可用档」║
//   ║  （maxThinkingForModel，含 "max" 时用 max）——不落回 pi 默认      ║
//   ║  medium，subagent 任务需要最大推理深度。                          ║
//   ║                                                                ║
//   ║  显式指定但 lookup/auth 失败 → 抛错（不静默降级到主 agent，     ║
//   ║  因为用户明确要求了某个 model，降级会造成「以为用了 X 实际用 Y」║
//   ╚════════════════════════════════════════════════════════════════╝
 *
 * @param agentConfig     agent .md 解析结果（查 model override + thinkingLevel）
 * @param modelRegistry   registry（仅 override 路径用）
 * @param paramOverride   调用方显式 override（最高优先级）
 * @param ctxModel        主 agent 当前模型（兜底，直接透传）
 */
export function resolveModel(
  agentConfig: AgentConfig | undefined,
  modelRegistry: ModelRegistryLike,
  paramOverride?: { model?: string; thinkingLevel?: string },
  ctxModel?: ModelInfo,
): ResolvedModel {
  // 1. paramOverride（最高优先级）。显式指定但 lookup/auth 失败 → 直接抛错，
  // 不降级到下层（避免「以为用了 X 实际用 Y」的静默错误）。
  if (paramOverride?.model) {
    return lookupAndResolve(
      paramOverride.model,
      paramOverride.thinkingLevel ?? agentConfig?.thinkingLevel,
      modelRegistry,
      "paramOverride",
    );
  }

  // 2. agentConfig.model（agent 作者指定）。同样显式 → 失败即抛错。
  if (agentConfig?.model) {
    return lookupAndResolve(
      agentConfig.model,
      agentConfig.thinkingLevel,
      modelRegistry,
      "agentConfig",
    );
  }

  // 3. 主 agent model（直接透传）。无显式 thinking → 兜底最高可用档。
  // [U1 D2 豁免口径] ctxModel 是运行时已验证的 ModelInfo 对象，豁免 registry 存在性
  // 复查与 auth 校验；但孪生守卫同等适用（registry 含大小写孪生时拒绝放行，modelRefFromVerified）。
  if (ctxModel) {
    modelRefFromVerified(ctxModel, modelRegistry);
    return {
      model: ctxModel,
      thinkingLevel: paramOverride?.thinkingLevel ?? agentConfig?.thinkingLevel
        ?? maxThinkingForModel(ctxModel),
    };
  }

  // 全部不可用 → 列出可用模型辅助调试
  const available = modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
  throw new Error(
    `No available model. Main agent has no active model, and no override was resolved.` +
      (available.length > 0
        ? `\nAvailable models:\n  ${available.slice(0, MODEL_LIST_LIMIT).join("\n  ")}`
        : ""),
  );
}

/**
 * lookup + auth 校验 + thinkingLevel clamp。显式指定但失败 → 抛错（不降级）。
 *
 * [U1 D1] 模型串裁决经 assertCanonicalModelRef 单一入口（strip 后缀 → provider 精确 →
 * 全等匹配 → 孪生守卫；未命中同步抛错并附问句式纠错候选）。放行即与 registry 条目全等。
 *
 * 错误信息区分两种失败（避免误导排查方向）：
 *   - model 非全等（不存在/大小写不符/孪生歧义）→ assertCanonicalModelRef 的问句式报错
 *   - model 全等命中但 auth 未配置 → 提示在 models.json 配置鉴权
 */
function lookupAndResolve(
  modelStr: string,
  requestedThinking: string | undefined,
  registry: ModelRegistryLike,
  source: "paramOverride" | "agentConfig",
): ResolvedModel {
  const ref = assertCanonicalModelRef(modelStr, registry, { source });
  const model = registry.find(ref.provider, ref.id);
  if (!model) {
    // 裁决已按 getAvailable 全等命中；find 独立实现（duck-typed mock 可能不同源）时的
    // 类型收窄兜底，非预期路径。
    throw new Error(
      `Model "${modelStr}" (${source}) passed the canonical ref check but registry.find missed it ` +
        `(registry snapshot inconsistent). Retry with an exact entry from the available models list.`,
    );
  }
  if (!registry.hasConfiguredAuth(model)) {
    throw new Error(
      `Model "${modelStr}" (${source}) exists but auth is not configured. ` +
        `Configure auth in models.json or switch to an authorized model.`,
    );
  }
  return {
    model,
    // 无显式请求时兜底「模型最高可用档」（不落 pi 默认 medium）。
    thinkingLevel: resolveThinkingLevel(model, requestedThinking ?? maxThinkingForModel(model)),
  };
}

/**
 * subagent 默认 thinking：模型最高可用档。
 *
 *   - thinkingLevelMap 配置了级别 → map 中最高档（模型显式配置 "max" 时即 max）
 *   - reasoning 但无 map → "xhigh"（pi 合法最高档；"max" 非 pi 合法值——
 *     spawn 侧 model:"max" 后缀会被 pi 判为非法 thinking 后缀导致 model 解析失败，
 *     故无 map 时不能直接用 "max"）
 *   - 非 reasoning 模型 → undefined（不支持 thinking）
 */
function maxThinkingForModel(
  model: { reasoning: boolean; thinkingLevelMap?: Record<string, unknown> },
): string | undefined {
  const levels = availableThinkingLevels(model);
  if (levels.length > 0) return levels[levels.length - 1];
  return model.reasoning ? "xhigh" : undefined;
}

/**
 * 从 model.thinkingLevelMap 提取可用级别，clamp 到最高可用。
 * model.reasoning === false → undefined（不支持 thinking）
 */
function resolveThinkingLevel(
  model: { reasoning: boolean; thinkingLevelMap?: Record<string, unknown> },
  requested?: string,
): string | undefined {
  const levels = availableThinkingLevels(model);
  if (levels.length === 0) return model.reasoning ? requested : undefined;
  if (requested && levels.includes(requested)) return requested;
  // requested 不可用 → 降级到最高可用
  return levels[levels.length - 1];
}

/**
 * 列出 model 实际支持的 thinking level（升序）。
 *
 *   - model.reasoning === false → [] （不支持 thinking）
 *   - 无 thinkingLevelMap → [] （无级别信息，调用方按需透传）
 *   - 有 map → THINKING_ORDER 中 map[lvl] != null 的子集（保留升序）
 */
export function availableThinkingLevels(
  model: { reasoning: boolean; thinkingLevelMap?: Record<string, unknown> },
): readonly string[] {
  if (!model.reasoning) return [];
  const map = model.thinkingLevelMap;
  if (!map) return [];
  return THINKING_ORDER.filter((lvl) => map[lvl] != null);
}
