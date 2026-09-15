// src/shared/zcode-model-ref.ts
//
// zcode 模型引用切分原语（U1 契约面批件）——[W11/H2] 随 engines/zcode 内建目录删除
// 从 engines/zcode/{preparer,constants}.ts 迁出的宿主侧原语（barrel 原四件导出面
// 不变：splitZcodeModelRef / hasApiKey / DEFAULT_PROVIDER_ID / ZCODE_FALLBACK_
// DEFAULT_MODEL）。引擎侧等价物在 @zhushanwen/zcode-subagent-cli（两处单源各自
// 演进，协议面不共享该常量——宿主只做引用切分，不做凭据校验）。

/** provider 条目（v2 config.provider.<id>）的最小消费面（索引签名形态）。 */
export interface ZcodeProviderEntryLike {
  options?: { apiKey?: unknown };
}

/** 短名（无 provider 前缀）解析的默认 provider（zsub DEFAULT_PROVIDER_ID 同构）。 */
export const DEFAULT_PROVIDER_ID = "builtin:bigmodel-coding-plan";

/** zsub 同构的兜底缺省模型（v2 config 无 model.main 且 task 未指定时）。 */
export const ZCODE_FALLBACK_DEFAULT_MODEL = "builtin:bigmodel-coding-plan/GLM-5.3";

/** [R4] 规范化全名 provider/model → create 参数的 per-session model 拆分。 */
export function splitZcodeModelRef(
  modelRef: string,
): { providerId: string; modelId: string } {
  const slash = modelRef.lastIndexOf("/");
  return { providerId: modelRef.slice(0, slash), modelId: modelRef.slice(slash + 1) };
}

export function hasApiKey(entry: ZcodeProviderEntryLike): boolean {
  const key = entry.options?.apiKey;
  return typeof key === "string" && key !== "";
}
