// src/execution/__tests__/helpers/model-registry-mock.ts
//
// 测试脚手架（测试 mock 收敛批）：空 model registry 与 ctx model 常量。
//
// 背景：`{ getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true }`
// 字面量在 12 文件 13 处逐字重复（多数包在本地 `function makeEmptyRegistry()` 里），
// ctx model `{ id: "m", name: "M", provider: "p", reasoning: false }` 在 9 文件逐字
// 重复——收敛到本 module 单源：桩形（ModelRegistryLike / ModelInfo 增成员）变更只改
// 此处，消费方同步生效。
//
// 有意不收敛的变体：`hasConfiguredAuth: () => false`（batch-finalized.test.ts /
// model-config-service.test.ts 的非空鉴权专用桩）语义不同，各文件保留内联。
//
// 消费方式（与 pi-mock.ts / subagent-service-mocks.ts 同款）：直接 import 调用，
// 无 vi.mock 注册。

import type { ModelInfo, ModelRegistryLike } from "../../assembly/model-resolver.ts";

/** 空 model registry：无可用模型 / 查找恒 undefined / 鉴权恒就绪（测试缺省桩）。 */
export function emptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

/** 测试用 ctx model（固定 id/name/provider，reasoning 关闭）——与主 agent 同模型的恒等桩。 */
export const CTX_MODEL: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };
