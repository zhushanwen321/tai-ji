/**
 * pi 运行时契约测试共用夹具（pi-semantics-catalog-injection 与 sdk-contract 的同款
 * runtime 装配、注册入参与可见集合断言）。不 mock pi 本体——契约测试的价值即
 * 「实装版 pi 的真实组合行为」，夹具只收敛重复形态，断言对象仍由各用例持有。
 */
import { expect } from 'vitest'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'

/** pi-ai 内置基线模型（getBuiltinModels 的元素类型）。 */
export type BuiltinModel = ReturnType<typeof getBuiltinModels>[number]

/** 每用例独立 runtime：内存 ModelsStore + 不发起网络刷新 + tmp 凭据路径（同款隔离）。 */
async function newRuntime(authDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    authPath: join(authDir, 'auth.json'),
  })
}

/** 全量内置基线的注册入参（逐模型拷贝，注册侧不持共享引用）。 */
export function fullBaselineConfig(provider: string): { models: BuiltinModel[] } {
  return { models: getBuiltinModels(provider).map((m) => ({ ...m })) }
}

/** 单模型注册入参（「整体替换 / 可见集合收缩」类用例）。 */
function singleModelConfig(model: BuiltinModel): { models: BuiltinModel[] } {
  return { models: [{ ...model }] }
}

/**
 * 新 runtime、注册全量内置基线并**自证可见集合 = 基线**（契约用例共同开场；断言单源
 * 在此执行，防开场即坏），返回 baseline 供后续断言引用。
 */
export async function runtimeWithFullBaseline(
  provider: string,
  authDir: string,
): Promise<{ rt: ModelRuntime; baseline: BuiltinModel[] }> {
  const baseline = getBuiltinModels(provider)
  const rt = await newRuntime(authDir)
  rt.registerProvider(provider, fullBaselineConfig(provider))
  expectVisibleIds(rt, provider, baseline.map((m) => m.id))
  return { rt, baseline }
}

/** 换注单模型并断言可见集合收缩为该模型（pi 重注册整体替换 / sdk 映射替换共用断言）。 */
export function swapToSingleExpectShrink(rt: ModelRuntime, provider: string, model: BuiltinModel): void {
  rt.registerProvider(provider, singleModelConfig(model))
  expectVisibleIds(rt, provider, [model.id])
}

/** 该 provider 可见模型 id 顺序断言（getModels 即最终可见集合）。 */
export function expectVisibleIds(rt: ModelRuntime, provider: string, ids: string[]): void {
  expect(rt.getModels(provider).map((m) => m.id)).toEqual(ids)
}
