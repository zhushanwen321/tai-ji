// src/shared/zcode-model-ref.ts
//
// zcode 模型引用切分原语（U1 契约面批件）——[W11/H2] 随 engines/zcode 内建目录删除
// 从 engines/zcode/{preparer,constants}.ts 迁出的宿主侧原语。引擎侧等价物在
// @zhushanwen/zcode-subagent-cli（两处单源各自演进，协议面不共享常量——宿主只做
// 引用切分，不做凭据校验）。
//
// 2026-09-29 account 体系迁移同步：原 DEFAULT_PROVIDER_ID / ZCODE_FALLBACK_
// DEFAULT_MODEL 两个 plan 家族常量删除——app 3.14.x 起 plan 家族（builtin:/account:
// 前缀）经账号 entitlement 门控，外部 spawn 的引擎注册表不装载，宿主侧无任何
// 消费场景（引擎侧模型源已切换 provider_config.json，见 zcode-subagent-cli
// preparer.ts）；本文件只剩引用切分原语。

/** [R4] 规范化全名 provider/model → create 参数的 per-session model 拆分。 */
export function splitZcodeModelRef(
  modelRef: string,
): { providerId: string; modelId: string } {
  const slash = modelRef.lastIndexOf("/");
  return { providerId: modelRef.slice(0, slash), modelId: modelRef.slice(slash + 1) };
}
