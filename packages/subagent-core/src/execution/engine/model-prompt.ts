// src/execution/engine/model-prompt.ts
//
// [U7] 引擎模型段 system prompt 注入（模型可发现性）。
// [engine-awareness U2] 引擎恒在状态段 <current_subagent_engine>（设计权威源：
// docs/design/subagent-engine-awareness-injection.md（已删除，git 可追溯）§3.1 终态逐字基准 / §3.3 D6、D7）。
//
// 背景：pi 核心在 system prompt 生成 <available_provider_models> 段并教育 agent
// 「subagent/workflow 的 model 参数用这些 id」——该教育对 engine: zcode 等自带
// provider 体系的引擎是误导（pi 的 id 在引擎侧是未知 provider）。本模块按
// 「defaultEngine 开关」（用户拍板 2026-08-25）补齐非默认引擎的模型可发现性：
// defaultEngine 指向非 pi 引擎且该引擎实现 EnginePort.listModels 时，追加
// <available_<engine>_models> 段，与 pi 段形成「一段一引擎」的分界标注。
//
// 恒在状态段（D6）：现状 AI 对「当前默认引擎」无权威信息源，只能从「zcode 段缺失
// 与否」反推（pi 时完全无声明）。<current_subagent_engine> 恒在段显式声明当前引擎
// 并裁决「AGENTS.md 路由表的 pi-registry id 在非 pi 引擎下不适用」的指令冲突。
//
// engine-neutral：遍历注册表驱动，未来引擎实现 listModels 即自动注入，宿主零改动。

import { DEFAULT_ENGINE_ID, getEngine, hasEngine, normalizeEngineId } from "./registry.ts";

/** pi 段之外的引擎才需要清单段（pi 与主 agent 模型体系一致，核心已有段）。 */
const CORE_ENGINE_ID = DEFAULT_ENGINE_ID;

/** 单引擎段格式：XML 包裹 + 分界语义（与 pi 核心段的 <model><id> 形态对齐）。 */
function buildEngineSection(engineId: string, models: Array<{ id: string; name?: string }>): string {
  const lines = models.map((m) =>
    m.name !== undefined ? `<model><id>${m.id}</id><name>${m.name}</name></model>` : `<model><id>${m.id}</id></model>`,
  );
  return [
    `<available_${engineId}_models>`,
    `The following models are available for subagents dispatched with engine '${engineId}' ONLY (their provider registry differs from the main agent's; ids above in <available_provider_models> do NOT apply to engine '${engineId}' dispatches). Omit model to use the engine default.`,
    ...lines,
    `</available_${engineId}_models>`,
  ].join("\n");
}

/**
 * 恒在状态段 <current_subagent_engine>（设计 D6：pi 引擎也声明——AI 不需要
 * 「从段缺失反推」当前引擎）。三种形态（§3.1 终态逐字基准 + 失败路径表）：
 *   - 缺省 / pi：声明 pi + 指向上方核心段 <available_provider_models>（无冲突 bullet）；
 *   - 非 pi 且已注册：指向下方该引擎清单段 + 「pi registry id 不适用」+ AGENTS.md
 *     冲突裁决 bullet + 省略 model 用引擎默认；
 *   - 未注册引擎（如配置手误 "ghost"）：如实显示配置值 + 警告行（派发将报
 *     engine_not_found，指引修 subagents/config.json）——G4 诚实降级：不静默、不伪造。
 *
 * 字节稳定（D7）：纯字符串确定性拼装（无 localeCompare / 无随机序 / 无时间态）；
 * 引擎注册与否经 hasEngine 只读判断（不取实例、不触发工厂副作用），同输入恒同输出。
 */
export function buildSubagentEngineSection(defaultEngine: string | undefined): string {
  // 归一走 registry.normalizeEngineId 单一权威源：本函数与 buildEngineModelsPromptAppend
  // （及引擎感知检测 diff）必须对同一读取结果给出同一引擎 id，否则两处会说谎
  const engineId = normalizeEngineId(defaultEngine);
  const lines = [
    "<current_subagent_engine>",
    "Default engine for subagent dispatches when neither the call's `engine` param",
    `nor an agent .md \`engine\` frontmatter overrides: ${engineId}`,
  ];
  if (engineId === CORE_ENGINE_ID) {
    // pi：清单在上方核心段，无需引擎侧清单段，也无 AGENTS.md 冲突（路由表 id 本就是 pi 的）
    lines.push(
      "- Model ids for pi dispatches are the ids in <available_provider_models> above.",
      "- Omit `model` to use the engine default.",
    );
  } else if (hasEngine(engineId)) {
    lines.push(
      `- Model ids for ${engineId} dispatches are listed in <available_${engineId}_models> below.`,
      `  Ids in <available_provider_models> do NOT apply to ${engineId} dispatches.`,
      "- Omit `model` to use the engine default.",
      // AGENTS.md 冲突裁决 bullet（§3.1 逐字基准）：全局路由表给的绝对 pi id 是 2026-08-28
      // 事故根因——更强的指令源必须被段内显式裁决约束
      "- If AGENTS.md or other standing guidance names model ids from the pi registry",
      "  (e.g. zai-coding-cn/*), those ids apply to pi-engine dispatches ONLY — when",
      "  the current engine is not pi, use only ids from the engine section below.",
    );
  } else {
    // 失败路径表「未注册引擎」行：文案逐字为恢复指引（与 dispatch 期 engine_not_found 对齐）
    lines.push(
      `- engine '${engineId}' is not registered — dispatches will fail at routing; fix subagents/config.json`,
    );
  }
  lines.push("</current_subagent_engine>");
  return lines.join("\n");
}

/**
 * 清单段「无凭据模型」提示行形态（§3.1 失败路径表：状态段正常、清单段显示提示行）。
 * 为什么不返回空串：状态段（恒在）声明「ids listed in <available_<engine>_models>
 * below」，段缺失会让该声明说谎；提示行保持段存在且如实声明当前无任何可派发的
 * 显式模型（G4 诚实降级）。文案逐字取自设计失败路径表恢复指引列。
 *
 * 仅服务「引擎实现了 listModels 但当前空清单 / 抛异常」两种形态——引擎侧 provider
 * 体系存在、只是暂时没有可用模型，恢复动作是去宿主配置凭据。
 */
function buildEmptyModelsHint(engineId: string): string {
  return [
    `<available_${engineId}_models>`,
    `engine '${engineId}' has no credentialed models right now — configure the provider in ZCode desktop first`,
    `</available_${engineId}_models>`,
  ].join("\n");
}

/**
 * 清单段「与主 agent 模型体系一致」声明行形态（U2 一致性审查修订：未实现 ≠ 无模型）。
 * port 契约（port.ts listModels JSDoc）：引擎省略 listModels 或返回 null = 引擎没有
 * 自己的 provider 枚举面，模型 id 沿用主 agent 的 <available_provider_models>——
 * 与「引擎有 provider 体系但无凭据模型」（buildEmptyModelsHint）是两种不同事实，
 * 文案必须区分：此处若复用「no credentialed models + ZCode desktop 指引」会让 AI
 * 误以为引擎不可派发、且 ZCode desktop 指引无处落地。
 * 段仍保留 <available_<engine>_models> 包裹：状态段恒在声明「listed in ... below」，
 * 段缺失会让该声明说谎（与 buildEmptyModelsHint 同理）。
 */
function buildCoreAlignedHint(engineId: string): string {
  return [
    `<available_${engineId}_models>`,
    `engine '${engineId}' uses the same model registry as the main agent — use ids from <available_provider_models> above`,
    `</available_${engineId}_models>`,
  ].join("\n");
}

/**
 * 依据全局 defaultEngine 生成追加段（不含前导换行）。
 *
 * 规则（设计 §3.1 失败路径表 + G4 + U2 一致性审查修订）：
 *   - defaultEngine 为 pi / 缺省 → 不注入（pi 段已由核心提供）；
 *   - 引擎未注册 → 不注入（状态段 <current_subagent_engine> 已有警告行，避免双份）；
 *   - 已注册且 listModels 有清单 → 注入该引擎段（渲染不变）；
 *   - 已注册但 listModels 未实现 / 返回 null → 「与主 agent 模型体系一致」声明段
 *     （port 契约语义：引擎无自有 provider 枚举面，id 见上方核心段，见
 *     buildCoreAlignedHint）；
 *   - 已注册但空清单 / listModels 抛异常 → 「无凭据模型」提示行段（引擎 provider
 *     体系存在但当前无可用模型，见 buildEmptyModelsHint；从「静默不注入」改为如实
 *     声明——空清单返回空串会让 AI 误以为没有任何引擎清单可看）。
 * fail-safe：listModels 异常同样落提示行段、不向外抛（注入失败不阻塞 agent loop——
 * 与 system-prompt extension 的 before_agent_start 处置一致）。
 */
export function buildEngineModelsPromptAppend(defaultEngine: string | undefined): string {
  // 归一走 registry.normalizeEngineId 单一权威源（与状态段渲染同一 normalize，见上文）
  const engineId = normalizeEngineId(defaultEngine);
  if (engineId === CORE_ENGINE_ID) return "";
  // hasEngine 只读判断（不触发工厂）；未注册时状态段负责警告，这里保持空串
  if (!hasEngine(engineId)) return "";
  try {
    const engine = getEngine(engineId);
    if (engine.listModels === undefined) return buildCoreAlignedHint(engineId);
    const models = engine.listModels();
    if (models === null) return buildCoreAlignedHint(engineId);
    if (models.length === 0) return buildEmptyModelsHint(engineId);
    return buildEngineSection(engineId, models);
  } catch {
    // listModels 抛异常（如 v2 config 损坏）＝引擎枚举面存在但读取失败，与空清单
    // 同属「暂无可派发的显式模型」：降级为无凭据提示行而非静默
    return buildEmptyModelsHint(engineId);
  }
}

/** 测试口：段格式导出（避免测试依赖注册表组装全链）。 */
export const _testHooks = { buildEngineSection, CORE_ENGINE_ID };
