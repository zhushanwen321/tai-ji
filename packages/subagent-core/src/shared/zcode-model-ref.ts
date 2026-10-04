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
//
// [⑦ 模型引用三元组化] 切分实现收敛到 parseModelSelector 单源（shared/model-ref.ts，
// 语法单点：`/` 取第一个、id 可含 `/`、合法 thinking 档位后缀剥离）——本函数不再
// 自持 split 逻辑。与旧本地实现的既知词形差异（多斜杠串：旧 lastIndexOf 把余段归
// provider，单源把余段归 id）随收敛登记：zcode 域 provider id 与 model id 均不含
// 斜杠，多斜杠形态非现实输入。保留独立导出的原因：barrel 公共 API 形态稳定
// （zcode 命名域返回 providerId/modelId 键名）+ 引擎侧副本独立演进不受宿主侧语义
// 跟随。输入域 = 未裁决原始串（字符串边界入口，宿主侧无 registry 裁决面）；结构体
// 裁决产物见 ModelRef。

import { parseModelSelector } from "./model-ref.ts";

/** [R4] 规范化全名 provider/model → create 参数的 per-session model 拆分。 */
export function splitZcodeModelRef(
  modelRef: string,
): { providerId: string; modelId: string } {
  const { ref, provider, id } = parseModelSelector(modelRef);
  // 无斜杠串保形：parseModelSelector 对无斜杠给出 provider=""/id=""（id 定义为斜杠
  // 后段），zcode 词形里整串即 model id（旧实现 lastIndexOf 的 -1 分支语义）——
  // 回落剥掉档位后缀后的整串，禁静默变空。
  return { providerId: provider, modelId: provider === "" ? ref : id };
}
