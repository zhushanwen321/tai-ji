// src/execution/engine/model-ref-translation.ts
//
// [engine-ref-translation D2] 派发层模型 ref 翻译编排（2026-10-14 用户裁决）。
//
// 四层解析产物（显式/偏好）经引擎翻译面（EnginePort.translateModelRef，可选成员）
// 改写为引擎原生 ref（zcode 实装：zai-coding-cn/* → account:bigmodel-individual-*，
// 其余 provider 两世界 1:1 原样、不在表内透传）。record/上报面呈现实际发给引擎的
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

/**
 * 四层解析的显式/偏好两层 → 翻译后 engineModel（undefined = 引擎缺省）。
 * `explicit` 与 `preference` 由调用方按既有 ?? 链惰性求值纪律取好（前两层任一在场
 * 时不触盘读偏好）；warn 通道由调用方注入（chat/workflow 域各自的日志前缀）。
 */
export function resolveEngineModelWithTranslation(
  route: EngineRouteResult,
  explicit: string | undefined,
  preference: string | undefined,
  warn: (message: string) => void,
  logPrefix: string,
): string | undefined {
  const translate = (ref: string): string =>
    route.engine.translateModelRef !== undefined ? route.engine.translateModelRef(ref) : ref;
  if (explicit !== undefined) return translate(explicit);
  if (preference === undefined) return undefined;
  const translated = translate(preference);
  // 清单成员校验仅对「有枚举面」的引擎生效：undefined/null = port 契约的「无自有
  // 枚举面」形态（放行——引擎侧 validateModel 仍兑底；回归守卫：不可把无面引擎
  // 当空清单处理，否则偏好层被误跳过）；空数组 = 枚举面在册但当前无可用模型 → 跳过。
  const list = route.engine.listModels?.();
  const known = list === undefined || list === null || list.some((m) => m.id === translated);
  if (known) return translated;
  warn(
    `[${logPrefix}] engineDefaults.${route.engineId}="${preference}" 翻译后（${translated}）` +
      `不在引擎模型清单，本派发跳过偏好层走引擎缺省（settings 页可重选）`,
  );
  return undefined;
}
