// src/execution/engine/model-ref-translation.ts
//
// [engine-ref-translation D2] 派发层模型 ref 翻译编排（2026-10-14 用户裁决）。
//
// 四层解析产物（显式/偏好）经引擎翻译侧（EnginePort.translateModelRef，可选成员）
// 改写为引擎原生 ref（zcode 实装：zai-coding-cn/* → account:bigmodel-individual-*，
// 其余 provider 两世界 1:1 原样、不在表内透传）。record/上报侧呈现实际发给引擎的
// ref（UI 跟随事实）。两层失败语义分立：
//   - 显式层（task / frontmatter——作者/用户显式意图）：翻译失败 = 显式抛错
//     （首败即停——引擎确实供不了该模型，错误自带恢复指引；由编排层既有错误包装
//     承接，与 validateModel 同窗口、record 创建前）；
//   - 偏好层（engineDefaults——全局偏好非本任务意图）：翻译后不在引擎清单 → 跳过
//     偏好层走引擎缺省 + warn（清单漂移〔如引擎侧条目退役、历史遗留值
//     zai-coding-plan/*〕不炸派发，settings 页可重选）。
//
// 消费点（两个解析点同一语义，禁止双实现漂移）：
//   - run-orchestration.resolveIdentityForRoute（chat 域）
//   - workflow-dispatch.resolveWorkflowIdentity（workflow 域）
//
// 幂等：翻译产物再入恒等（引擎内 validateModel/run prepare 的同名翻译分支零冲突）；
// 无翻译面的引擎原样透传（pi 不实现本成员）。

import type { EngineRouteResult } from "./routing.ts";

/** 生效回执去重（per-engineId 进程级）：翻译面缺席的 warn 只报一次，不逐派发刷屏。 */
const translationFaceAbsentWarned = new Set<string>();

/** 派发期模型来源（与 shared/core 同名词域——本层只消费不定义类型，避免三处漂移）。 */
export type ResolvedEngineModelSource = "explicit" | "frontmatter" | "preference" | "default";

/** 四层解析 + 翻译产物（engineModel 与来源标注成对返回——record 盖章双字段同源）。 */
export interface ResolvedEngineModelResult {
  engineModel: string | undefined;
  source: ResolvedEngineModelSource;
}

/**
 * 四层解析的显式/偏好两层 → 翻译后 engineModel + 来源标注（undefined = 引擎缺省）。
 * `taskModel` / `frontmatterModel` 由调用方直传；`readPreference` 为 thunk（惰性求值
 * ——前两层任一在场时不触盘，保持既有 ?? 链纪律）；来源与解析同点判定（显式层命中即
 * 'explicit'，frontmatter 次之，偏好层 'preference'，全缺席 'default'）——避免
 * 「解析一处、来源另判」的双处漂移。warn 通道由调用方注入（chat/workflow 域各自
 * 的日志前缀）。
 */
export function resolveEngineModelWithTranslation(
  route: EngineRouteResult,
  taskModel: string | undefined,
  frontmatterModel: string | undefined,
  readPreference: () => string | undefined,
  warn: (message: string) => void,
  logPrefix: string,
): ResolvedEngineModelResult {
  const translate = (ref: string): string =>
    route.engine.translateModelRef !== undefined ? route.engine.translateModelRef(ref) : ref;
  // [engine-ref-translation D5 生效回执] 翻译面缺席时一次告警（per-engine 进程级去
  // 重）——2026-10-16 修复的直接教训：staged 引擎 cli 形态下 RemoteEngine 未实装
  // 本成员且无任何信号，修复语义在部署形态整体静默失效。缺席语义不变（恒等透传，
  // 跨引擎 ref 是否可解析由引擎侧裁决），但必须可观测。
  if (route.engine.translateModelRef === undefined && !translationFaceAbsentWarned.has(route.engineId)) {
    translationFaceAbsentWarned.add(route.engineId);
    warn(
      `[${logPrefix}] engine '${route.engineId}' has no model translation face ` +
        `(translateModelRef not implemented; manifest modelTranslation undeclared) — ` +
        `cross-engine model refs pass through untranslated and may be rejected by the engine`,
    );
  }
  if (taskModel !== undefined) return { engineModel: translate(taskModel), source: "explicit" };
  if (frontmatterModel !== undefined) return { engineModel: translate(frontmatterModel), source: "frontmatter" };
  const preference = readPreference();
  if (preference === undefined) return { engineModel: undefined, source: "default" };
  return resolvePreferenceLayer(route, preference, translate, warn, logPrefix);
}

/**
 * 偏好层的翻译 + 降级语义（自主函数拆出的模块内私有辅助——metrics-gate 复杂度治理：
 * 主函数只留四层路由判定，翻译失败降级与清单校验降级的分支链留本函数）。
 *
 * 偏好层失败语义补口（MF-2）：引擎翻译侧对历史遗留/清单漂移的偏好值可能抛
 * model_not_available（zcode 实装 translatePiModelRefToZcode 三处同步 throw）。
 * 显式层首败即停不变；偏好层按本文件头声明的语义降级——跳过偏好层走引擎缺省
 * + warn，不炸派发（settings 页可重选）。code 用结构化探测，不 import 具体
 * 引擎包（core 不依赖引擎实装）。
 */
function resolvePreferenceLayer(
  route: EngineRouteResult,
  preference: string,
  translate: (ref: string) => string,
  warn: (message: string) => void,
  logPrefix: string,
): ResolvedEngineModelResult {
  let translated: string;
  try {
    translated = translate(preference);
  } catch (err: unknown) {
    const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (code !== "model_not_available") throw err;
    warn(
      `[${logPrefix}] engineDefaults.${route.engineId}="${preference}" 翻译失败` +
        `（${err instanceof Error ? err.message : String(err)}），本派发跳过偏好层走引擎缺省` +
        `（settings 页可重选）`,
    );
    return { engineModel: undefined, source: "default" };
  }
  // 清单成员校验仅对「有枚举侧」的引擎生效：undefined/null = port 契约的「无自有
  // 枚举侧」形态（放行——引擎侧 validateModel 仍兜底；回归检查：不可把无面引擎
  // 当空清单处理，否则偏好层被误跳过）；空数组 = 枚举侧在册但当前无可用模型 → 跳过。
  const list = route.engine.listModels?.();
  const known = list === undefined || list === null || list.some((m) => m.id === translated);
  if (known) return { engineModel: translated, source: "preference" };
  warn(
    `[${logPrefix}] engineDefaults.${route.engineId}="${preference}" 翻译后（${translated}）` +
      `不在引擎模型清单，本派发跳过偏好层走引擎缺省（settings 页可重选）`,
  );
  return { engineModel: undefined, source: "default" };
}
